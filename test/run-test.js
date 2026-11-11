// Self-test: runs MAJIC against a pretend kie.ai so no money is spent.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

let polls = 0;
const seen = {};
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/file-stream-upload')) {
      seen.auth = req.headers.authorization;
      const name = (body.match(/filename="([^"]+)"/) || [])[1] || 'x';
      return res.end(JSON.stringify({ code: 200, data: { downloadUrl: `http://localhost:4010/files/${name}` } }));
    }
    if (req.url.startsWith('/api/v1/jobs/createTask')) {
      seen.task = JSON.parse(body);
      return res.end(JSON.stringify({ code: 200, data: { taskId: 'task_test_1' } }));
    }
    if (req.url.startsWith('/api/v1/jobs/recordInfo')) {
      polls++;
      if (polls < 2) return res.end(JSON.stringify({ code: 200, data: { state: 'generating' } }));
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
    const cfg = await (await fetch(base + '/api/config')).json();
    check(cfg.ready && cfg.needsCode, 'config says ready and needs a code');

    const mk = (mode) => {
      const fd = new FormData();
      fd.append('mode', mode); fd.append('resolution', '480p');
      fd.append('video', new Blob([Buffer.alloc(2000, 1)], { type: 'video/mp4' }), 'clip.mp4');
      fd.append('image', new Blob([Buffer.alloc(500, 2)], { type: 'image/png' }), 'me.png');
      return fd;
    };

    let r = await fetch(base + '/api/generate', { method: 'POST', body: mk('swap') });
    check(r.status === 401, 'rejects a missing access code');

    r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'x-access-code': 'letmein' }, body: mk('swap') });
    let j = await r.json();
    check(r.ok && j.taskId === 'task_test_1', 'swap job created');
    check(seen.task.model === 'wan/2-2-animate-replace', 'swap uses the Replace model');
    check(seen.task.input.resolution === '480p' && /clip/.test(seen.task.input.video_url) && /me/.test(seen.task.input.image_url), 'sends video, photo and 480p to kie.ai');
    check(seen.auth === 'Bearer test-key', 'sends the API key');

    r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'x-access-code': 'letmein' }, body: mk('motion') });
    await r.json();
    check(seen.task.model === 'wan/2-2-animate-move', 'motion uses the Move model');

    let s = await (await fetch(base + '/api/status/task_test_1', { headers: { 'x-access-code': 'letmein' } })).json();
    check(s.state === 'generating' || s.state === 'success', 'status works while running');
    s = await (await fetch(base + '/api/status/task_test_1', { headers: { 'x-access-code': 'letmein' } })).json();
    check(s.state === 'success' && /out\.mp4$/.test(s.url), 'status returns the finished video link');

    const bad = new FormData(); bad.append('mode', 'swap');
    r = await fetch(base + '/api/generate', { method: 'POST', headers: { 'x-access-code': 'letmein' }, body: bad });
    check(r.status === 400, 'rejects a request with no files');

    r = await fetch(base + '/api/download?code=letmein&url=' + encodeURIComponent('https://evil.example.com/x.mp4'));
    check(r.status === 400, 'blocks downloads from unknown websites');

    r = await fetch(base + '/');
    check(r.ok && (await r.text()).includes('MAJIC'), 'web page loads');
  } catch (e) { console.error('FAIL:', e); process.exitCode = 1; }
  srv.kill(); fake.close();
});
