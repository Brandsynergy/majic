// MAJIC server: takes a video + a photo, asks kie.ai (Wan 2.2 Animate) to do the magic,
// and hands the finished video back to the web page.
const express = require('express');
const multer = require('multer');
const path = require('path');
const { prepareVideo, prepareImage } = require('./lib/prep');

const PORT = process.env.PORT || 3000;
const KIE_API_KEY = process.env.KIE_API_KEY || '';
const KIE_BASE = process.env.KIE_BASE || 'https://api.kie.ai';
const KIE_UPLOAD_BASE = process.env.KIE_UPLOAD_BASE || 'https://kieai.redpandaai.co';
// Optional: comma-separated list of access codes. Leave empty to keep the app open.
const ACCESS_CODES = (process.env.ACCESS_CODES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_FILE_BYTES = 100 * 1024 * 1024; // biggest allowed by any mode; each mode is checked again below
const MAX_SECONDS = 30;

// Two modes, both powered by Wan 2.2 Animate on kie.ai
const MODES = {
  // Better quality: Kling Motion Control (same price as the Wan option)
  motion: {
    label: 'Motion Transfer',
    help: 'Your photo comes alive and performs the moves from the video.',
    resolutions: ['720p'],
    price: { '720p': 0.063 }, // about 12.6 kie credits per second
    maxVideoMB: 100,
    maxImageMB: 10,
    minSeconds: 3,
    build: (v, i, res, seconds) => ({
      model: 'kling-2.6/motion-control',
      input: {
        input_urls: [i],
        video_urls: [v],
        mode: res,
        // "image": follows your photo's look closely (video up to 10s); "video": follows the video's framing (up to 30s)
        character_orientation: seconds <= 10 ? 'image' : 'video',
      },
    }),
  },
  swap: {
    label: 'Character Swap',
    help: 'The person in the video is replaced by the person in your photo. The scene stays the same.',
    resolutions: ['480p', '580p', '720p'],
    price: { '480p': 0.03, '580p': 0.0475, '720p': 0.0625 },
    maxVideoMB: 10,
    maxImageMB: 10,
    minSeconds: 2,
    build: (v, i, res) => ({
      model: 'wan/2-2-animate-replace',
      input: { video_url: v, image_url: i, resolution: res, nsfw_checker: false },
    }),
  },
  // Backup motion engine, not shown on the page (older Wan model, lower quality)
  motion_wan: {
    hidden: true,
    label: 'Motion Transfer (Wan)',
    help: '',
    resolutions: ['720p'],
    price: { '720p': 0.0625 },
    maxVideoMB: 100,
    maxImageMB: 5,
    minSeconds: 2,
    build: (v, i, res) => ({
      model: 'wan/2-2-animate-move',
      input: { video_url: v, image_url: i, resolution: res, nsfw_checker: false },
    }),
  },
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
    modes: Object.fromEntries(Object.entries(MODES).filter(([, v]) => !v.hidden).map(([k, v]) => [k, { label: v.label, help: v.help, resolutions: v.resolutions, price: v.price, maxVideoMB: v.maxVideoMB, maxImageMB: v.maxImageMB }])),
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
      const video = req.files?.video?.[0];
      const image = req.files?.image?.[0];
      if (!mode) return res.status(400).json({ error: 'Please choose a mode.' });
      if (!video || !image) return res.status(400).json({ error: 'Please add both a video and a photo.' });
      const resolution = mode.resolutions.includes(req.body.resolution) ? req.body.resolution : mode.resolutions[0];
      if (video.size > mode.maxVideoMB * 1024 * 1024) return res.status(400).json({ error: `For ${mode.label} the video must be under ${mode.maxVideoMB} MB.` });
      if (image.size > mode.maxImageMB * 1024 * 1024) return res.status(400).json({ error: `For ${mode.label} the photo must be under ${mode.maxImageMB} MB.` });
      if (!/^video\/(mp4|quicktime|x-matroska)$/.test(video.mimetype)) {
        return res.status(400).json({ error: 'The video must be MP4, MOV or MKV.' });
      }
      if (!/^image\/(jpeg|png|webp)$/.test(image.mimetype)) {
        return res.status(400).json({ error: 'The photo must be JPG, PNG or WEBP.' });
      }

      // 1) get the files ready (find cuts, standard format)
      let vp, ip;
      try {
        [vp, ip] = await Promise.all([
          prepareVideo(video.buffer, { minSeconds: mode.minSeconds, maxSeconds: MAX_SECONDS }),
          prepareImage(image.buffer),
        ]);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      if (vp.buffer.length > mode.maxVideoMB * 1024 * 1024) {
        return res.status(400).json({ error: `After preparing, the video is still over ${mode.maxVideoMB} MB. Please use a shorter clip.` });
      }

      // 2) upload to kie.ai and start the job
      const [videoUrl, imageUrl] = await Promise.all([
        uploadToKie({ buffer: vp.buffer, mimetype: 'video/mp4', originalname: 'clip.mp4' }, 'majic/videos'),
        uploadToKie({ buffer: ip.buffer, mimetype: 'image/jpeg', originalname: 'photo.jpg' }, 'majic/images'),
      ]);

      const r = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
        method: 'POST',
        headers: kieHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(mode.build(videoUrl, imageUrl, resolution, vp.seconds)),
      });
      const j = await r.json().catch(() => ({}));
      const taskId = j?.data?.taskId;
      if (!r.ok || j.code !== 200 || !taskId) {
        return res.status(502).json({ error: j?.msg || `kie.ai refused the job (${r.status}).` });
      }
      res.json({ taskId, notes: vp.notes, seconds: Math.round(vp.seconds * 10) / 10 });
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
      console.error('kie.ai task failed:', req.params.taskId, d.failCode, d.failMsg);
      const why = d.failMsg ? `kie.ai said: "${d.failMsg}". ` : '';
      return res.json({
        state: 'fail',
        error: `${why}You were not charged. This AI needs a REAL person clearly visible in the video (not a cartoon or animation), and a clear photo of one person. Try a short clip of one real person, filmed from the front or side, and a photo showing their face and upper body.`,
      });
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
    return res.status(400).json({ error: 'That file is too big.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`MAJIC is running on port ${PORT}`));
