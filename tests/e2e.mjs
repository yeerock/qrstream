// End to end through the REAL CAMERA PATH, no library: the real sender page draws its QR stream, our camera simulator films each screen
// (tilt, rotation, blur, noise, uneven light) into a raw .y4m file, Chrome uses that file as its camera, and the real receiver page
// (Start Camera -> worker pool -> own QR reader -> erasure decoder) rebuilds the file, which must match the SHA-256.
// Run: npm run e2e      The last line is "E2E PASS: ..." (exit code 0) or "E2E FAIL: ..." (exit code 1).
// Options: FILE=path  DEMO=picture|text  FRAMES=n  K=1|2|3 (codes per screen)  LVL=0..4  CAM=1280x720  FPS=10 (screens per second on the camera)
//          COLOUR=off|only (colour frames)  EXPECT_TYPE=mime  BASE=https://... (test a deployed copy)  RX=https://... (receiver from another copy)  KEEP=1 (keep receiver screenshots for the demo video)
//          TIMEOUT=ms (receiver, default 180000)  PORT=n (local server; default: any free port, so runs at the same time never meet)
import fs from 'node:fs'; import path from 'node:path';
import { serve } from './serve.mjs'; import { launch, launchCamera, retryFrozenCamera } from './cdp.mjs'; import { shoot, writeY4M, feedFile } from './camera.mjs';
const E = process.env, FILE = E.FILE, N = +E.FRAMES || 60, DEMO = E.DEMO || 'picture', [CW, CH] = (E.CAM || (E.K > 1 ? '1920x1080' : '1280x720')).split('x').map(Number), FPS = +E.FPS || 10;
const OUT = path.resolve('demo/out'), feed = feedFile('e2e');
let srv, b1, b2, failed = '';
try {
  if (FILE && !fs.existsSync(FILE)) throw new Error('FILE not found: ' + FILE);
  if (E.KEEP) fs.mkdirSync(OUT, { recursive: true });
  srv = E.BASE ? null : await serve(+E.PORT || 0); const base = E.BASE || `http://127.0.0.1:${srv.port}`;
  // 1. sender: draw the stream and grab every screen as modules
  b1 = await launch();
  const sp = await b1.page(`${base}/send/?test${FILE ? '' : '&demo=' + DEMO}${E.COLOUR ? '&col=' + E.COLOUR : ''}`, { width: CW, height: CH });
  if (FILE) { await sp.eval(`(() => { const k = ${JSON.stringify(E.K || '')}, l = ${JSON.stringify(E.LVL || '')}; if (k) document.getElementById('k').value = k; if (l) document.getElementById('lvl').value = l; })()`); await sp.setFiles('#file', [FILE]); }
  try { await sp.waitFor('window.__qrsStep && 1'); } catch (e) { throw new Error(`the sender did not start its stream: ${await sp.eval("document.getElementById('err').textContent").catch(() => '')} ${sp.logs.slice(-3).join(' | ')}`); }
  if (E.DEBUG) console.log('sender ready');
  const meta = await sp.eval('window.__qrsMeta'), frames = [], shots = [];
  frames.push(shoot(await sp.eval('window.__qrsGrab()'), CW, CH, { seed: 1 }));          // the entry code first, as on a real screen
  for (let i = 1; i <= N; i++) { await sp.eval('window.__qrsStep(1)'); const bm = await sp.eval('window.__qrsGrab()'); frames.push(shoot(bm, CW, CH, { seed: i + 1 })); if (E.KEEP) shots.push(bm); }
  if (E.KEEP) fs.writeFileSync(path.join(OUT, 'sender.json'), JSON.stringify(shots.slice(0, 200)));
  if (E.DEBUG) console.log('frames shot');
  writeY4M(feed.file, CW, CH, FPS, frames); await b1.close(); b1 = null;
  console.log(`sender: ${meta.name}, ${N} screens -> camera feed ${CW}x${CH} at ${FPS} screens/s (${(fs.statSync(feed.file).size / 1048576).toFixed(0)} MB raw)`);

  // 2. receiver: Chrome films the feed through getUserMedia, exactly as on a phone. Chrome's file camera can freeze at its start (see cdp.mjs):
  //    that is seen within seconds and the receiver is started again in a fresh browser; the test never passes on anything but the rebuilt file.
  const RX = path.join(OUT, 'rx');
  const { r, secs, rp } = await retryFrozenCamera(async () => {
    if (b2) await b2.close(); b2 = await launchCamera(feed.file);
    const rp = await b2.page(`${E.RX || base}/receive/?debug`, { width: 420, height: 860 });
    const t0 = Date.now(); await rp.click('#start'); if (E.DEBUG) console.log('camera started');
    let k = 0; if (E.KEEP) { fs.rmSync(RX, { recursive: true, force: true }); fs.mkdirSync(RX); }
    const snap = () => rp.screenshot(path.join(RX, String(k++).padStart(4, '0') + '.png'));
    let r;
    try { r = await rp.waitCamera('window.__qrs && window.__qrs.done ? window.__qrs : null', +E.TIMEOUT || 180000, E.KEEP ? snap : null); }
    catch (e) {   // say where the receiver stood: a timeout alone tells nothing
      const txt = id => rp.eval(`document.getElementById('${id}').textContent`).catch(() => '?');
      e.message += `. Receiver: progress ${JSON.stringify(await rp.eval('window.__qrs || null').catch(() => '?'))}, camera pictures ${await rp.cameraFrames().catch(() => '?')}, status "${await txt('stat')}", hint "${await txt('hint')}", message "${await txt('homemsg')}", console ${JSON.stringify(rp.logs.slice(-5))}`; throw e;
    }
    const secs = (Date.now() - t0) / 1000;
    if (E.KEEP) { for (let i = 0; i < 25; i++) { await new Promise(z => setTimeout(z, 100)); await snap(); } fs.writeFileSync(path.join(RX, 'fps.txt'), String(k / (secs + 2.5))); }
    return { r, secs, rp };
  });
  const bad = rp.logs.filter(l => /Content Security Policy|Refused|exception/i.test(l)); if (bad.length) throw new Error('page errors: ' + bad.join(' | '));
  console.log(`receiver: ${r.name}, ${r.size} B in ${secs.toFixed(1)} s (${(r.size / 1024 / secs).toFixed(1)} KB/s incl. camera start), type ${r.type}, sha256 ${r.sha256.slice(0, 16)}...`);
  if (r.sha256 !== meta.sha256) throw new Error(`SHA-256 mismatch: sent ${meta.sha256}, received ${r.sha256}`);
  if (E.EXPECT_TYPE && r.type !== E.EXPECT_TYPE) throw new Error(`type ${r.type}, expected ${E.EXPECT_TYPE}`);
} catch (e) { failed = e.message || String(e); if (E.DEBUG) console.error(e); }
finally {   // always: both browsers, the server, the feed file; a cleanup that fails must not hide the result
  for (const b of [b1, b2]) if (b) await b.close().catch(() => { });
  if (srv) { srv.close(); srv.closeAllConnections(); } feed.remove();
}
if (failed) { console.error('E2E FAIL: ' + failed); process.exit(1); }
console.log('E2E PASS: file rebuilt through the camera path, SHA-256 identical');
