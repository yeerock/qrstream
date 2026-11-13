// Offline: once opened, the receiver starts from this cache, so it works where there is no signal. New versions arrive when there is a network.
const C = 'qrstream-9', FILES = ['./', 'app.css', 'app.js', '../core/qrtx.js', '../core/qrread.js', 'preview.js', 'worker.js', 'manifest.webmanifest', '../icon.svg', '../guard.js'], KNOWN = new Set(FILES.map(f => new URL(f, location.href).pathname));
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
// network first with a short wait, so a weak signal does not hold the page up; only this app's own files are cached, one entry each
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  const saved = () => caches.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? caches.match('./') : Response.error()));
  e.respondWith(new Promise(ok => {
    let over = false; const fall = () => { if (!over) { over = true; ok(saved()); } }, t = setTimeout(fall, 2500);
    fetch(e.request).then(r => { clearTimeout(t); if (r.status === 200 && KNOWN.has(new URL(e.request.url).pathname)) { const c = r.clone(), u = new URL(e.request.url); u.search = ''; caches.open(C).then(x => x.put(u.href, c)).catch(() => { }); } if (!over) { over = true; ok(r); } }).catch(() => { clearTimeout(t); fall(); });
  }));
});
