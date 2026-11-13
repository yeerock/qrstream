// Tiny static server for local use and tests: node tests/serve.mjs [port]. Camera access needs https or localhost.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = process.env.SERVE_ROOT ? path.resolve(process.env.SERVE_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webm': 'video/webm', '.mp4': 'video/mp4', '.txt': 'text/plain' };
/** Starts the server on 127.0.0.1 and resolves with it once it listens. Port 0 asks the system for any free port, so runs at the same time
 *  never meet; the port in use is server.port. A busy fixed port is tried again for 3 seconds (the run before may still be letting go of it),
 *  then the promise rejects with a plain message: an 'error' event nobody listens to would end Node with a bare stack trace instead. */
export function serve(port = 8787) {
  const s = http.createServer((q, r) => {
    let p; try { p = decodeURIComponent(new URL(q.url, 'http://x').pathname); } catch (e) { r.writeHead(400).end(); return; } if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p); if (f !== ROOT && !f.startsWith(ROOT + path.sep)) { r.writeHead(403).end(); return; }
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404).end('not found'); return; } r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(b); });
  });
  return new Promise((ok, no) => {
    let tries = 0; const listen = () => s.listen(port, '127.0.0.1');
    s.on('error', e => {
      if (s.listening) return;   // a later socket error must not end the process; requests answer for themselves
      if (e.code === 'EADDRINUSE' && port && ++tries <= 20) { setTimeout(() => { s.close(); listen(); }, 150); return; }
      no(e.code === 'EADDRINUSE' ? new Error(`port ${port} is in use by another program (another test run?). Stop it or choose another port.`) : e);
    });
    s.once('listening', () => { s.port = s.address().port; ok(s); });
    listen();
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { const s = await serve(process.argv[2] === '0' ? 0 : +process.argv[2] || 8787); console.log(`QRStream on http://localhost:${s.port}/`); }
  catch (e) { console.error('serve: ' + e.message); process.exit(1); }
}
