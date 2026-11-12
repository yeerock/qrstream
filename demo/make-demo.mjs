// Builds docs/demo.webm (1920x1080) from a REAL camera-path run, with no tools beyond Node and Chrome: tests/e2e.mjs films the sender
// and keeps the receiver's screenshots, then demo/compose.html draws and records the video in Chrome (MediaRecorder). Run: npm run demo-video
import { execFileSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
import { serve } from '../tests/serve.mjs'; import { launch } from '../tests/cdp.mjs';
fs.rmSync('demo/out', { recursive: true, force: true });
execFileSync(process.execPath, ['tests/e2e.mjs'], { stdio: 'inherit', env: { ...process.env, KEEP: '1', FRAMES: process.env.FRAMES || '45', FPS: process.env.FPS || '6' } });
const rx = fs.readdirSync('demo/out/rx').filter(f => f.endsWith('.png')).length, rxFps = +fs.readFileSync('demo/out/rx/fps.txt', 'utf8');
const srv = await serve(8790), b = await launch(['--autoplay-policy=no-user-gesture-required']);
try {
  const p = await b.page('http://localhost:8790/demo/compose.html', { width: 1920, height: 1080 });
  const r = await p.eval(`compose(${rx}, ${rxFps}, 'SHA-256 identical · the file never touched a network')`);
  fs.writeFileSync('docs/demo.webm', Buffer.from(r.webm, 'base64'));
  fs.writeFileSync('docs/demo-poster.png', Buffer.from(r.poster.split(',')[1], 'base64'));
  console.log('docs/demo.webm', (fs.statSync('docs/demo.webm').size / 1048576).toFixed(1), 'MB');
} finally { await b.close(); srv.close(); }
