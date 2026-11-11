// MAJIC server: takes a video + a photo, asks kie.ai (Wan 2.2 Animate) to do the magic,
// and hands the finished video back to the web page.
const express = require('express');
const multer = require('multer');
const path = require('path');

const PORT = process.env.PORT || 3000;
const KIE_API_KEY = process.env.KIE_API_KEY || '';
const KIE_BASE = process.env.KIE_BASE || 'https://api.kie.ai';
const KIE_UPLOAD_BASE = process.env.KIE_UPLOAD_BASE || 'https://kieai.redpandaai.co';
// Optional: comma-separated list of access codes. Leave empty to keep the app open.
const ACCESS_CODES = (process.env.ACCESS_CODES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_FILE_BYTES = 10 * 1024 * 1024; // kie.ai limit: 10 MB per file
const MAX_SECONDS = 30;

// Two modes, both powered by Wan 2.2 Animate on kie.ai
const MODES = {
  motion: {
    label: 'Motion Transfer',
    model: 'wan/2-2-animate-move',
    help: 'Your photo comes alive and performs the moves from the video.',
  },
  swap: {
    label: 'Character Swap',
    model: 'wan/2-2-animate-replace',
    help: 'The person in the video is replaced by the person in your photo. The scene stays the same.',
  },
};
// kie.ai credits per video-second (1 credit is about $0.005)
const RESOLUTIONS = {
  '480p': { creditsPerSec: 6, usdPerSec: 0.03 },
  '580p': { creditsPerSec: 9.5, usdPerSec: 0.0475 },
  '720p': { creditsPerSec: 12.5, usdPerSec: 0.0625 },
};

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 2 },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function kieHeaders(extra = {}) {
  return { Authorization: `Bearer ${KIE_API_KEY}`, ...extra };
}

function checkCode(req, res, next) {
  if (ACCESS_CODES.length === 0) return next();
  const code = (req.get('x-access-code') || req.body?.code || req.query?.code || '').trim();
  if (!ACCESS_CODES.includes(code)) {
    return res.status(401).json({ error: 'That access code is not valid.' });
  }
  next();
}

async function uploadToKie(file, folder) {
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  form.append('uploadPath', folder);
  form.append('fileName', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.originalname}`.replace(/[^\w.\-]/g, '_'));
  const r = await fetch(`${KIE_UPLOAD_BASE}/api/file-stream-upload`, {
    method: 'POST',
    headers: kieHeaders(),
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  const url = j?.data?.downloadUrl;
  if (!r.ok || !url) {
    throw new Error(j?.msg || `Upload to kie.ai failed (${r.status})`);
  }
  return url;
}

app.get('/api/config', (req, res) => {
  res.json({
    needsCode: ACCESS_CODES.length > 0,
    maxSeconds: MAX_SECONDS,
    maxMB: MAX_FILE_BYTES / 1024 / 1024,
    modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { label: v.label, help: v.help }])),
    resolutions: RESOLUTIONS,
    ready: Boolean(KIE_API_KEY),
  });
});

app.post(
  '/api/generate',
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  checkCode,
  async (req, res) => {
    try {
      if (!KIE_API_KEY) return res.status(500).json({ error: 'The app is not connected to kie.ai yet (missing API key).' });
      const mode = MODES[req.body.mode];
      const resolution = RESOLUTIONS[req.body.resolution] ? req.body.resolution : '480p';
      const video = req.files?.video?.[0];
      const image = req.files?.image?.[0];
      if (!mode) return res.status(400).json({ error: 'Please choose a mode.' });
      if (!video || !image) return res.status(400).json({ error: 'Please add both a video and a photo.' });
      if (!/^video\/(mp4|quicktime|x-matroska)$/.test(video.mimetype)) {
        return res.status(400).json({ error: 'The video must be MP4, MOV or MKV.' });
      }
      if (!/^image\/(jpeg|png|webp)$/.test(image.mimetype)) {
        return res.status(400).json({ error: 'The photo must be JPG, PNG or WEBP.' });
      }

      const [videoUrl, imageUrl] = await Promise.all([
        uploadToKie(video, 'majic/videos'),
        uploadToKie(image, 'majic/images'),
      ]);

      const r = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
        method: 'POST',
        headers: kieHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model: mode.model,
          input: { video_url: videoUrl, image_url: imageUrl, resolution, nsfw_checker: false },
        }),
      });
      const j = await r.json().catch(() => ({}));
      const taskId = j?.data?.taskId;
      if (!r.ok || j.code !== 200 || !taskId) {
        return res.status(502).json({ error: j?.msg || `kie.ai refused the job (${r.status}).` });
      }
      res.json({ taskId });
    } catch (e) {
      console.error('generate error:', e.message);
      res.status(500).json({ error: e.message || 'Something went wrong.' });
    }
  }
);

app.get('/api/status/:taskId', checkCode, async (req, res) => {
  try {
    const r = await fetch(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(req.params.taskId)}`,
      { headers: kieHeaders({ Accept: 'application/json' }) }
    );
    const j = await r.json().catch(() => ({}));
    const d = j?.data;
    if (!r.ok || !d) return res.status(502).json({ error: j?.msg || 'Could not check the job.' });

    if (d.state === 'success') {
      let url = '';
      try { url = JSON.parse(d.resultJson || '{}').resultUrls?.[0] || ''; } catch (_) { /* ignore */ }
      return res.json({ state: 'success', url });
    }
    if (d.state === 'fail') {
      return res.json({ state: 'fail', error: d.failMsg || 'The AI could not finish this one. Try a different video or photo.' });
    }
    res.json({ state: d.state || 'waiting' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lets the browser save the finished video under a friendly name
app.get('/api/download', checkCode, async (req, res) => {
  try {
    const url = String(req.query.url || '');
    const host = new URL(url).hostname;
    // only allow kie.ai file hosts, never arbitrary sites
    if (!/(^|\.)(kie\.ai|aiquickdraw\.com|redpandaai\.co)$/.test(host) && host !== 'localhost') {
      return res.status(400).send('Not allowed.');
    }
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send('Could not fetch the video.');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="majic-video.mp4"');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(400).send('Bad link.');
  }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `Each file must be under ${MAX_FILE_BYTES / 1024 / 1024} MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`MAJIC is running on port ${PORT}`));
