// End to end through the REAL CAMERA PATH, no library: the real sender page draws its QR stream, our camera simulator films each screen
// (tilt, rotation, blur, noise, uneven light) into a raw .y4m file, Chrome uses that file as its camera, and the real receiver page
// (Start Camera -> worker pool -> own QR reader -> erasure decoder) rebuilds the file, which must match the SHA-256.
// Run: npm run e2e
// Options: FILE=path  DEMO=picture|text  FRAMES=n  K=1|2|3 (codes per screen)  LVL=0..4  CAM=1280x720  FPS=10 (screens per second on the camera)
//          EXPECT_TYPE=mime  BASE=https://... (test a deployed copy)  KEEP=1 (keep receiver screenshots for the demo video)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { serve } from './serve.mjs'; import { launch } from './cdp.mjs'; import { shoot, writeY4M } from './camera.mjs';
const E = process.env, FILE = E.FILE, N = +E.FRAMES || 60, DEMO = E.DEMO || 'picture', [CW, CH] = (E.CAM || (E.K > 1 ? '1920x1080' : '1280x720')).split('x').map(Number), FPS = +E.FPS || 10;
const OUT = path.resolve('demo/out'); fs.mkdirSync(OUT, { recursive: true });
const srv = E.BASE ? null : await serve(8788), base = E.BASE || 'http://localhost:8788';
const y4m = path.join(os.tmpdir(), `agq-cam-${process.pid}.y4m`);
let b1, b2;
try {
  // 1. sender: draw the stream and grab every screen as modules
  b1 = await launch();
  const sp = await b1.page(`${base}/send/?test${FILE ? '' : '&demo=' + DEMO}`, { width: CW, height: CH });
  if (FILE) { await sp.eval(`(() => { const k = ${JSON.stringify(E.K || '')}, l = ${JSON.stringify(E.LVL || '')}; if (k) document.getElementById('k').value = k; if (l) document.getElementById('lvl').value = l; })()`); await sp.setFiles('#file', [FILE]); }
  await sp.waitFor('window.__agqStep && 1'); if (E.DEBUG) console.log('sender ready');
  const meta = await sp.eval('window.__agqMeta'), frames = [], shots = [];
  frames.push(shoot(await sp.eval('window.__agqGrab()'), CW, CH, { seed: 1 }));          // the entry code first, as on a real screen
  for (let i = 1; i <= N; i++) { await sp.eval('window.__agqStep(1)'); const bm = await sp.eval('window.__agqGrab()'); frames.push(shoot(bm, CW, CH, { seed: i + 1 })); if (E.KEEP) shots.push(bm); }
  if (E.KEEP) fs.writeFileSync(path.join(OUT, 'sender.json'), JSON.stringify(shots.slice(0, 200)));
  if (E.DEBUG) console.log('frames shot');
  writeY4M(y4m, CW, CH, FPS, frames); await b1.close(); b1 = null;
  console.log(`sender: ${meta.name}, ${N} screens -> camera feed ${CW}x${CH} at ${FPS} screens/s (${(fs.statSync(y4m).size / 1048576).toFixed(0)} MB raw)`);

  // 2. receiver: Chrome films the feed through getUserMedia, exactly as on a phone
  b2 = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`]);
  const rp = await b2.page(`${E.RX || base}/receive/?debug`, { width: 420, height: 860 });
  const t0 = Date.now(); await rp.click('#start'); if (E.DEBUG) console.log('camera started');
  let k = 0; const RX = path.join(OUT, 'rx');
  if (E.KEEP) { fs.rmSync(RX, { recursive: true, force: true }); fs.mkdirSync(RX); }
  let r = null;
  while (!r) {
    r = await rp.eval('window.__agq && window.__agq.done ? window.__agq : null');
    if (E.KEEP) await rp.screenshot(path.join(RX, String(k++).padStart(4, '0') + '.png'));
    else await new Promise(z => setTimeout(z, 100));
    if (Date.now() - t0 > (+E.TIMEOUT || 180000)) { console.error('progress', await rp.eval('JSON.stringify(window.__agq||null)'), rp.logs.slice(-5)); throw new Error('timeout'); }
  }
  const secs = (Date.now() - t0) / 1000;
  if (E.KEEP) { for (let i = 0; i < 25; i++) { await new Promise(z => setTimeout(z, 100)); await rp.screenshot(path.join(RX, String(k++).padStart(4, '0') + '.png')); } fs.writeFileSync(path.join(RX, 'fps.txt'), String(k / (secs + 2.5))); }
  const bad = rp.logs.filter(l => /Content Security Policy|Refused|exception/i.test(l)); if (bad.length) throw new Error('page errors: ' + bad.join(' | '));
  console.log(`receiver: ${r.name}, ${r.size} B in ${secs.toFixed(1)} s (${(r.size / 1024 / secs).toFixed(1)} KB/s incl. camera start), type ${r.type}, sha256 ${r.sha256.slice(0, 16)}...`);
  if (r.sha256 !== meta.sha256) throw new Error('SHA-256 mismatch');
  if (E.EXPECT_TYPE && r.type !== E.EXPECT_TYPE) throw new Error(`type ${r.type}, expected ${E.EXPECT_TYPE}`);
  console.log('E2E PASS: file rebuilt through the camera path, SHA-256 identical');
} finally { if (b1) await b1.close(); if (b2) await b2.close(); if (srv) srv.close(); fs.rmSync(y4m, { force: true }); }
