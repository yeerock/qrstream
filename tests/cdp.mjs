// Minimal Chrome DevTools Protocol driver, own code, no dependencies (Node 22+ built-in WebSocket and fetch).
// Starts the installed Chrome headless, opens pages, evaluates script, takes screenshots, sets file inputs.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => fs.existsSync(p));

export async function launch(extraArgs = []) {
  if (!CHROME) throw new Error('Chrome not found. Set CHROME=/path/to/chrome.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agq-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', ...extraArgs], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort'); let port;
  for (let i = 0; i < 200 && !port; i++) { await new Promise(r => setTimeout(r, 50)); if (fs.existsSync(portFile)) port = fs.readFileSync(portFile, 'utf8').split('\n')[0]; }
  if (!port) { proc.kill(); throw new Error('Chrome did not start'); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const wait = new Map(), listeners = new Set();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { const [ok, no] = wait.get(m.id); wait.delete(m.id); m.error ? no(new Error(m.error.message)) : ok(m.result); } else listeners.forEach(f => f(m)); };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => { const i = ++id; wait.set(i, [ok, no]); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  async function page(url, { width = 1280, height = 800, scale = 1 } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId), logs = [];
    const on = m => { if (m.sessionId !== sessionId) return; if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' ')); if (m.method === 'Log.entryAdded') logs.push(m.params.entry.level + ': ' + m.params.entry.text); };
    listeners.add(on);
    await s('Page.enable'); await s('Runtime.enable'); await s('Log.enable'); await s('DOM.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    const go = async u => { const loaded = new Promise(r => { const f = m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.delete(f); r(); } }; listeners.add(f); }); await s('Page.navigate', { url: u }); await loaded; };
    await go(url);
    const api = {
      logs, go,
      async eval(expr) { const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
      async waitFor(expr, ms = 60000) { const t = Date.now(); for (;;) { const v = await api.eval(expr).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout waiting for ' + expr); await new Promise(r => setTimeout(r, 100)); } },
      async screenshot(file, clip) { const r = await s('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); const b = Buffer.from(r.data, 'base64'); if (file) fs.writeFileSync(file, b); return b; },
      async setFiles(selector, files) { const { root } = await s('DOM.getDocument'); const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector }); await s('DOM.setFileInputFiles', { nodeId, files: files.map(f => path.resolve(f)) }); },
      async click(selector) { await api.eval(`document.querySelector(${JSON.stringify(selector)}).click()`); },
      async close() { listeners.delete(on); await send('Target.closeTarget', { targetId }); },
    };
    return api;
  }
  async function close() { const gone = new Promise(r => proc.once('exit', r)); try { await send('Browser.close'); } catch (e) { } ws.close(); await Promise.race([gone, new Promise(r => setTimeout(r, 3000))]); proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { } }
  return { page, close };
}
