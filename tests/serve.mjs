// Tiny static server for local use and tests: node tests/serve.mjs [port]. Camera access needs https or localhost.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = process.env.SERVE_ROOT ? path.resolve(process.env.SERVE_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webm': 'video/webm', '.mp4': 'video/mp4', '.txt': 'text/plain' };
export function serve(port = 8787) {
  const s = http.createServer((q, r) => {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p); if (!f.startsWith(ROOT)) { r.writeHead(403).end(); return; }
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404).end('not found'); return; } r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(b); });
  });
  return new Promise(ok => s.listen(port, () => ok(s)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const port = +process.argv[2] || 8787; await serve(port); console.log(`QRStream on http://localhost:${port}/`); }
