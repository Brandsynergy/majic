// Self-test: runs MAJIC against a pretend kie.ai so no money is spent.
// Uses real little videos made with ffmpeg, including ones with camera cuts.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const FFMPEG = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'majic-test-'));
function ff(args) { const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(r.stderr.toString()); }
function duration(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file]);
  const m = r.stderr.toString().match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}
// a video made of pieces; each piece looks very different, so there are hard cuts between them
function makeVideo(name, pieces) {
  const sources = ['testsrc2', 'smptebars', 'mandelbrot', 'rgbtestsrc', 'cellauto', 'sierpinski'];
  const args = []; const parts = [];
  pieces.forEach((secs, i) => {
    args.push('-f', 'lavfi', '-t', String(secs), '-i', `${sources[i % sources.length]}=size=320x240:rate=25`);
    parts.push(`[${i}:v]format=yuv420p,setsar=1[v${i}]`);
  });
  const filter = parts.join(';') + ';' + pieces.map((_, i) => `[v${i}]`).join('') + `concat=n=${pieces.length}:v=1:a=0[out]`;
  const out = path.join(tmp, name);
  ff([...args, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return fs.readFileSync(out);
}
const png = (() => { const f = path.join(tmp, 'me.png'); ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x640:rate=1', '-frames:v', '1', f]); return fs.readFileSync(f); })();

const seen = { uploads: [] };
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/file-stream-upload')) {
      seen.auth = req.headers.authorization;
      const head = raw.indexOf('\r\n\r\n', raw.indexOf('name="file"')) + 4;
      const boundary = '\r\n--' + req.headers['content-type'].split('boundary=')[1];
      const fileBytes = raw.subarray(head, raw.indexOf(boundary, head));
      const name = (raw.toString('latin1', 0, 400).match(/filename="([^"]+)"/) || [])[1] || 'x';
      const f = path.join(tmp, `up-${seen.uploads.length}-${name}`);
      fs.writeFileSync(f, fileBytes);
      seen.uploads.push(f);
      return res.end(JSON.stringify({ code: 200, data: { downloadUrl: `http://localhost:4010/files/${path.basename(f)}` } }));
    }
    if (req.url.startsWith('/api/v1/jobs/createTask')) {
      seen.task = JSON.parse(raw.toString());
      return res.end(JSON.stringify({ code: 200, data: { taskId: 'task_test_1' } }));
    }
    if (req.url.startsWith('/api/v1/jobs/recordInfo')) {
      seen.polls = (seen.polls || 0) + 1;
      if (seen.polls < 2) return res.end(JSON.stringify({ code: 200, data: { state: 'generating' } }));
      return res.end(JSON.stringify({ code: 200, data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['http://localhost:4010/files/out.mp4'] }) } }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

function check(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  -', msg); }

fake.listen(4010, async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '4011', KIE_API_KEY: 'test-key', KIE_BASE: 'http://localhost:4010', KIE_UPLOAD_BASE: 'http://localhost:4010', ACCESS_CODES: 'letmein' },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 900));
  try {
    const base = 'http://localhost:4011';
    const H = { 'x-access-code': 'letmein' };
    const cfg = await (await fetch(base + '/api/config')).json();
    check(cfg.ready && cfg.needsCode, 'config says ready and needs a code');
    check(!cfg.modes.motion_wan && cfg.modes.motion && cfg.modes.swap, 'page shows Motion Transfer and Character Swap only');
    check(cfg.modes.motion.resolutions.join() === '720p,1080p' && cfg.modes.swap.resolutions.join() === '720p,1080p' && cfg.modes.swap.maxSeconds === 10, 'qualities listed per mode');

    const post = async (mode, video, resolution = '480p', headers = H) => {
      const fd = new FormData();
      fd.append('mode', mode); fd.append('resolution', resolution);
      fd.append('video', new Blob([video], { type: 'video/mp4' }), 'clip.mp4');
      fd.append('image', new Blob([png], { type: 'image/png' }), 'me.png');
      const r = await fetch(base + '/api/generate', { method: 'POST', headers, body: fd });
      return { r, j: await r.json() };
    };

    const cutVideo = makeVideo('cut.mp4', [3, 7]); // one hard cut at 3s
    let { r, j } = await post('swap', cutVideo, '720p', {});
    check(r.status === 401, 'rejects a missing access code');

    seen.uploads = [];
    ({ r, j } = await post('swap', cutVideo, '720p'));
    check(r.ok && j.taskId === 'task_test_1', 'swap job created');
    check(seen.task.model === 'wan/2-7-videoedit' && seen.task.input.resolution === '720p', 'swap uses Wan 2.7 Video Edit at 720p');
    check(seen.task.input.video_url && seen.task.input.reference_image && /reference image/.test(seen.task.input.prompt), 'swap sends video, reference photo and prompt');
    check(seen.task.input.duration >= 2 && seen.task.input.duration <= 10 && ['16:9', '9:16', '1:1'].includes(seen.task.input.aspect_ratio), 'swap duration and aspect ratio are valid');
    check(seen.auth === 'Bearer test-key', 'sends the API key');
    check(j.notes && j.notes.length === 1 && /camera cut/.test(j.notes[0]), 'tells the user a cut was found');
    const sentVideo = seen.uploads.find((f) => f.endsWith('.mp4'));
    const sentDur = duration(sentVideo);
    check(sentDur > 5.5 && sentDur < 7.2, `sent only the longest unbroken shot (${sentDur.toFixed(1)}s of a 10s video)`);
    const sentImg = seen.uploads.find((f) => f.endsWith('.jpg'));
    check(sentImg && fs.readFileSync(sentImg)[0] === 0xff, 'photo was re-saved as a clean JPEG');

    ({ r, j } = await post('motion', cutVideo, '720p'));
    check(r.ok && seen.task.model === 'kling-2.6/motion-control', 'motion uses Kling Motion Control');
    check(Array.isArray(seen.task.input.input_urls) && seen.task.input.input_urls.length === 1 && Array.isArray(seen.task.input.video_urls), 'Kling gets one photo and one video as lists');
    check(seen.task.input.mode === '720p' && seen.task.input.character_orientation === 'image', 'Kling: 720p, follows the photo for clips up to 10s');

    const longVideo = makeVideo('long.mp4', [12]);
    ({ r, j } = await post('motion', longVideo, '720p'));
    check(r.ok && seen.task.input.character_orientation === 'video' && j.notes.length === 0, 'Kling: clips over 10s follow the video; no cut notes when there are none');

    ({ r, j } = await post('motion_wan', longVideo, '480p'));
    check(r.ok && seen.task.model === 'wan/2-2-animate-move' && seen.task.input.resolution === '720p', 'backup Wan motion engine works and is forced to 720p');

    seen.uploads = [];
    ({ r, j } = await post('swap', longVideo, '720p'));
    const swapDur = duration(seen.uploads.find((f) => f.endsWith('.mp4')));
    check(r.ok && swapDur > 9 && swapDur < 10.3 && seen.task.input.duration === 10 && j.notes.length === 1, `swap trims a long clip to 10s (${swapDur.toFixed(1)}s) and says so`);

    const choppy = makeVideo('choppy.mp4', [1, 1, 1, 1, 1, 1]);
    ({ r, j } = await post('motion', choppy, '720p'));
    check(r.status === 400 && /unbroken shot/.test(j.error || ''), 'refuses a video chopped into pieces, with a clear reason');

    let s = await (await fetch(base + '/api/status/task_test_1', { headers: H })).json();
    check(s.state === 'generating' || s.state === 'success', 'status works while running');
    s = await (await fetch(base + '/api/status/task_test_1', { headers: H })).json();
    check(s.state === 'success' && /out\.mp4$/.test(s.url), 'status returns the finished video link');

    const bad = new FormData(); bad.append('mode', 'swap');
    r = await fetch(base + '/api/generate', { method: 'POST', headers: H, body: bad });
    check(r.status === 400, 'rejects a request with no files');

    r = await fetch(base + '/api/download?code=letmein&url=' + encodeURIComponent('https://evil.example.com/x.mp4'));
    check(r.status === 400, 'blocks downloads from unknown websites');

    r = await fetch(base + '/');
    check(r.ok && (await r.text()).includes('MAJIC'), 'web page loads');
  } catch (e) { console.error('FAIL:', e); process.exitCode = 1; }
  srv.kill(); fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
