// Gets the user's files ready before they go to the AI:
//  - finds camera cuts in the video and keeps only the longest unbroken shot
//    (cuts are what cause the "ghost" double-exposure blends)
//  - re-saves the video in a safe, standard format and size
//  - re-saves the photo as a clean JPEG
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 400000) err = err.slice(-200000); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stderr: err }));
  });
}

function parseInfo(stderr) {
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;
  const s = stderr.match(/Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})[\s,\[]/);
  return { duration, width: s ? +s[1] : 0, height: s ? +s[2] : 0 };
}

async function withTemp(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'majic-'));
  try { return await fn(dir); } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();

// Pick the longest stretch between cuts (pure function, easy to test)
function pickSegment(duration, cuts, { minSeconds, maxSeconds }) {
  const edges = [0, ...cuts.filter((c) => c > 0.2 && c < duration - 0.2), duration];
  let best = null;
  for (let i = 0; i < edges.length - 1; i++) {
    const hardStart = i > 0; const hardEnd = i < edges.length - 2;
    const start = edges[i] + (hardStart ? 0.4 : 0);
    const end = edges[i + 1] - (hardEnd ? 0.4 : 0);
    const len = end - start;
    if (!best || len > best.len) best = { start, len };
  }
  const cutCount = edges.length - 2;
  let { start, len } = best;
  if (len > maxSeconds) len = maxSeconds;
  return { start, len, cutCount, tooShort: len < minSeconds };
}

async function prepareVideo(buffer, { minSeconds = 3, maxSeconds = 30 } = {}) {
  return withTemp(async (dir) => {
    const inFile = path.join(dir, 'in.bin');
    const outFile = path.join(dir, 'out.mp4');
    await fs.promises.writeFile(inFile, buffer);

    const probe = await run(['-hide_banner', '-i', inFile]);
    const info = parseInfo(probe.stderr);
    if (!info.duration || !info.width) throw new Error('MAJIC could not read that video. Please use a normal MP4 or MOV file.');

    const scan = await run(['-hide_banner', '-i', inFile, '-an', '-vf', "select='gt(scene,0.2)',showinfo", '-f', 'null', '-']);
    const cuts = [...scan.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]));

    const seg = pickSegment(info.duration, cuts, { minSeconds, maxSeconds });
    const notes = [];
    if (seg.cutCount > 0) {
      if (seg.tooShort) {
        throw new Error(`Your video has ${seg.cutCount} camera cut${seg.cutCount > 1 ? 's' : ''} and the longest unbroken shot is only ${fmt(seg.len)}s. This AI needs one continuous shot of at least ${minSeconds}s, with no cuts. Please use a video filmed in one take.`);
      }
      notes.push(`Your video had ${seg.cutCount} camera cut${seg.cutCount > 1 ? 's' : ''}, which cause ghosting. MAJIC kept the longest unbroken shot (${fmt(seg.len)}s, from ${fmt(seg.start)}s).`);
    } else if (info.duration > maxSeconds) {
      notes.push(`MAJIC used the first ${maxSeconds}s of your video.`);
    }
    if (seg.tooShort && seg.cutCount === 0) {
      throw new Error(`Your video is only ${fmt(info.duration)}s long. It must be at least ${minSeconds}s.`);
    }

    // standard, safe format: H.264, even sizes, at most 1280 on the long side, 25 fps
    const vf = "scale='if(gt(a\\,1)\\,min(1280\\,iw)\\,-2)':'if(gt(a\\,1)\\,-2\\,min(1280\\,ih))',fps=25,format=yuv420p";
    const enc = await run([
      '-hide_banner', '-y', '-ss', seg.start.toFixed(2), '-t', seg.len.toFixed(2), '-i', inFile,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile,
    ]);
    if (enc.code !== 0) throw new Error('MAJIC could not prepare that video. Please try a different file.');
    const out = await fs.promises.readFile(outFile);
    const outInfo = parseInfo((await run(['-hide_banner', '-i', outFile])).stderr);
    return { buffer: out, notes, seconds: seg.len, cutCount: seg.cutCount, width: outInfo.width, height: outInfo.height };
  });
}

async function prepareImage(buffer, { minSide = 320 } = {}) {
  return withTemp(async (dir) => {
    const inFile = path.join(dir, 'in.bin');
    const outFile = path.join(dir, 'out.jpg');
    await fs.promises.writeFile(inFile, buffer);
    const probe = await run(['-hide_banner', '-i', inFile]);
    const info = parseInfo(probe.stderr);
    if (!info.width) throw new Error('MAJIC could not read that photo. Please use a JPG, PNG or WEBP file.');
    if (Math.min(info.width, info.height) < minSide) throw new Error(`That photo is too small (${info.width}x${info.height}). It needs to be at least ${minSide} pixels on each side.`);
    const enc = await run([
      '-hide_banner', '-y', '-i', inFile,
      '-vf', "scale='min(1600\\,iw)':-2:flags=lanczos,format=yuvj420p", '-frames:v', '1', '-q:v', '2', outFile,
    ]);
    if (enc.code !== 0) throw new Error('MAJIC could not prepare that photo. Please try a different one.');
    return { buffer: await fs.promises.readFile(outFile), width: info.width, height: info.height };
  });
}

module.exports = { prepareVideo, prepareImage, pickSegment };
