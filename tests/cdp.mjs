// Minimal Chrome DevTools Protocol driver, own code, no dependencies (Node 22+ built-in WebSocket and fetch).
// Starts the installed Chrome headless, opens pages, evaluates script, takes screenshots, sets file inputs.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CMD_MS = +process.env.CDP_TIMEOUT || 120000;   // no single DevTools command takes this long: a Chrome that hangs must fail the test, not hang it
const FREEZE_MS = 4000;                              // a live camera with no new picture for this long is frozen (the feeds run at 5 pictures a second or more)

// Browsers still open. Whatever ends the process (a failed assertion, process.exit, Ctrl-C) must not leave a Chrome running or its profile on disk.
const live = new Set(); let hooked = false;
function reap() {
  if (!live.size) return; const dirs = [...live].map(b => b.dir), nap = new Int32Array(new SharedArrayBuffer(4));
  for (const b of live) { try { b.proc.kill('SIGKILL'); } catch (e) { } } live.clear();
  // only synchronous code runs while the process ends; the helpers write the profile again for a moment (see removeDir), so remove until it stays away
  for (let i = 0, quiet = 0; i < 20 && quiet < 3; i++) { quiet++; for (const d of dirs) if (fs.existsSync(d)) { quiet = 0; try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } } Atomics.wait(nap, 0, 0, 100); }
}
function hook() {
  if (hooked) return; hooked = true; process.on('exit', reap);
  // a signal ends Node without the exit event; scripts with their own signal handlers keep them
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) if (!process.listenerCount(sig)) process.once(sig, () => { reap(); process.exit(128 + n); });
}
// Chrome's helper processes outlive the main one for a moment and write the profile again (Default/Cache came back after one plain removal,
// and every run left a folder behind): remove until the folder stays away.
async function removeDir(dir) { for (let i = 0, quiet = 0; i < 50 && quiet < 3; i++) { if (fs.existsSync(dir)) { quiet = 0; try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } } else quiet++; await sleep(100); } }

// How many pictures the page's camera video has received, or -1 while no camera runs. Asked of the browser, not of the page under test.
const CAM = `(() => { for (const v of document.querySelectorAll('video')) { const s = v.srcObject; if (s && s.active && v.getVideoPlaybackQuality) return v.getVideoPlaybackQuality().totalVideoFrames; } return -1; })()`;

export async function launch(extraArgs = []) {
  if (!CHROME) throw new Error('Chrome not found. Set CHROME=/path/to/chrome.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-chrome-'));
  // With --disable-gpu, Chrome's file camera (--use-file-for-fake-video-capture) sometimes stops for good after its first 2 to 5 pictures: the track
  // stays live and the video keeps "playing" one picture. Measured on Chrome 157, macOS, on a plain getUserMedia page with nothing of ours:
  // 12 of 440 starts with the flag, 0 of 340 without. So a browser that films a file keeps its GPU process; waitCamera() below catches what is left.
  const cam = extraArgs.some(a => String(a).startsWith('--use-file-for-fake-video-capture'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', ...(cam ? [] : ['--disable-gpu']), '--hide-scrollbars', '--mute-audio', ...extraArgs], { stdio: 'ignore' });
  const me = { proc, dir }; live.add(me); hook();
  let exited = '', closed = '', ws = null, closing = null;
  const gone = new Promise(r => { proc.once('exit', (c, sig) => { exited = sig ? 'signal ' + sig : 'code ' + c; r(); }); proc.once('error', e => { exited = e.message; r(); }); });
  let id = 0; const wait = new Map(), listeners = new Set();
  const drop = why => { if (closed) return; closed = why; for (const [, [, no, tm]] of wait) { clearTimeout(tm); no(new Error(why)); } wait.clear(); };
  gone.then(() => drop(`Chrome exited (${exited})`));
  // every command is answered, refused or timed out: a Chrome that died (or was killed by another run) must never leave a test waiting for ever
  const send = (method, params = {}, sessionId, ms = CMD_MS) => new Promise((ok, no) => {
    if (closed) return no(new Error(`${method}: ${closed}`));
    const i = ++id, tm = setTimeout(() => { wait.delete(i); no(new Error(`${method}: no answer from Chrome in ${ms / 1000} s`)); }, ms); wait.set(i, [ok, no, tm]);
    try { ws.send(JSON.stringify({ id: i, method, params, sessionId })); } catch (e) { clearTimeout(tm); wait.delete(i); no(new Error(`${method}: ${e.message}`)); }
  });
  const close = () => closing ||= (async () => {
    if (ws && !closed) { try { await send('Browser.close', {}, undefined, 5000); } catch (e) { } }
    drop('the browser was closed'); try { if (ws) ws.close(); } catch (e) { }
    const within = ms => { let tm; return Promise.race([gone, new Promise(r => { tm = setTimeout(r, ms); })]).finally(() => clearTimeout(tm)); };   // the timer is cleared, or Node would stay alive for it
    await within(3000); if (!exited) { try { proc.kill('SIGKILL'); } catch (e) { } await within(2000); }
    await removeDir(dir); live.delete(me);
  })();

  try {
    // Chrome writes "port\n/devtools/browser/<id>" when it listens; a file caught half written has no line end yet
    const portFile = path.join(dir, 'DevToolsActivePort'); let port, wsPath;
    for (let i = 0; i < 600 && !port && !exited; i++) { await sleep(50); let t = ''; try { t = fs.readFileSync(portFile, 'utf8'); } catch (e) { } const m = /^(\d+)\n(\/\S+)?/.exec(t); if (m) [, port, wsPath] = m; }
    if (!port) throw new Error(exited ? `Chrome did not start (${exited})` : 'Chrome did not start in 30 s');
    if (!wsPath) wsPath = new URL((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl).pathname;
    ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('could not connect to Chrome DevTools' + (exited ? ` (Chrome exited, ${exited})` : ''))); });
    ws.onerror = () => { }; ws.onclose = () => drop('the connection to Chrome closed' + (exited ? ` (Chrome exited, ${exited})` : ''));
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { const [ok, no, tm] = wait.get(m.id); wait.delete(m.id); clearTimeout(tm); m.error ? no(new Error(m.error.message)) : ok(m.result); } else listeners.forEach(f => f(m)); };
  } catch (e) { await close(); throw e; }

  async function page(url, { width = 1280, height = 800, scale = 1 } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId), logs = [];
    const on = m => { if (m.sessionId !== sessionId) return; if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' ')); if (m.method === 'Log.entryAdded') logs.push(m.params.entry.level + ': ' + m.params.entry.text); };
    listeners.add(on);
    await s('Page.enable'); await s('Runtime.enable'); await s('Log.enable'); await s('DOM.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    // a page that cannot be reached, or never finishes loading, says so instead of waiting for ever
    const go = async (u, ms = 60000) => {
      let f, tm; const loaded = new Promise((r, no) => { f = m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') r(); }; listeners.add(f); tm = setTimeout(() => no(new Error(`the page did not load in ${ms / 1000} s: ${u}`)), ms); });
      loaded.catch(() => { });   // reported by the await below; never an unhandled rejection while Page.navigate is still out
      try { const nav = await s('Page.navigate', { url: u }); if (nav.errorText) throw new Error(`cannot open ${u}: ${nav.errorText}`); await loaded; } finally { clearTimeout(tm); listeners.delete(f); }
    };
    await go(url);
    const api = {
      logs, go,
      async eval(expr) { const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
      // waits for a truthy value; script errors on the way are expected (the page is still loading) and the last one is named on timeout
      async waitFor(expr, ms = 60000) {
        const t = Date.now(); let last = '';
        for (;;) { let v; try { v = await api.eval(expr); last = ''; } catch (e) { if (closed) throw e; last = e.message.split('\n')[0]; } if (v) return v; if (Date.now() - t > ms) throw new Error(`timeout waiting for ${expr} (${ms / 1000} s${last ? ', last error: ' + last : ''})`); await sleep(100); }
      },
      /** Pictures the camera video has received so far, -1 while no camera runs. */
      cameraFrames: () => api.eval(CAM),
      /** waitFor for a page that films the fake camera. When the camera stops delivering pictures it throws an error with code 'CAMERA_FROZEN' at once
       *  (a fault of Chrome's file camera, see launch): the caller starts a fresh browser instead of waiting out the whole timeout on a dead feed.
       *  `each`, when given, runs between polls in place of the 100 ms pause (screenshots for the demo video). */
      async waitCamera(expr, ms = 60000, each) {
        const t = Date.now(); let n = -1, moved = t, last = '';
        for (;;) {
          let v; try { v = await api.eval(expr); last = ''; } catch (e) { if (closed) throw e; last = e.message.split('\n')[0]; } if (v) return v;
          const c = await api.eval(CAM).catch(() => -1); if (c !== n) { n = c; moved = Date.now(); }
          else if (c >= 0 && Date.now() - moved > FREEZE_MS) throw Object.assign(new Error(`Chrome's fake camera froze after ${c} pictures (the camera track is live but no new picture arrives)`), { code: 'CAMERA_FROZEN' });
          if (Date.now() - t > ms) throw new Error(`timeout waiting for ${expr} (${ms / 1000} s${last ? ', last error: ' + last : ''})`);
          if (each) await each(); else await sleep(100);
        }
      },
      async screenshot(file, clip) { const r = await s('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); const b = Buffer.from(r.data, 'base64'); if (file) fs.writeFileSync(file, b); return b; },
      async setFiles(selector, files) { const { root } = await s('DOM.getDocument'); const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector }); if (!nodeId) throw new Error('setFiles: nothing matches ' + selector); await s('DOM.setFileInputFiles', { nodeId, files: files.map(f => path.resolve(f)) }); },
      async click(selector) { await api.eval(`document.querySelector(${JSON.stringify(selector)}).click()`); },
      async close() { listeners.delete(on); await send('Target.closeTarget', { targetId }); },
    };
    return api;
  }
  return { page, close };
}
/** Chrome whose camera is a .y4m file (camera.mjs writes them), played in a loop, with the camera permission already given. */
export const launchCamera = (y4m, extraArgs = []) => launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, ...extraArgs]);
/** Runs fn (which opens a camera browser and waits with page.waitCamera) again, up to `tries` times, when Chrome's camera froze. Any other error is the test's own. */
export async function retryFrozenCamera(fn, tries = 3, note = console.log) {
  for (let i = 1; ; i++) { try { return await fn(i); } catch (e) { if (e.code !== 'CAMERA_FROZEN' || i >= tries) throw e; note(`note: ${e.message}; starting the camera again (try ${i + 1} of ${tries})`); } }
}
