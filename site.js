'use strict';
// Hero: a real, endless QR stream of a small text, drawn by the same core the sender uses. Still under prefers-reduced-motion.
(() => {
  const cv = document.getElementById('hero'), cap = document.getElementById('herocap'); if (!cv || !window.QRTX) return;
  const text = new TextEncoder().encode('QRStream: this animation is a real stream. '.repeat(60));
  const s = new QRTX.Stream(QRTX.pack({ name: 'hello.txt', mime: 'text/plain', sha256: '' }, text), 1);
  const draw = () => { const q = QRTX.encode(s.next(15), { version: 15, mask: 2 }), n = q.size + 8; cv.width = cv.height = n; const x = cv.getContext('2d'), im = x.createImageData(n, n), d = new Uint32Array(im.data.buffer); d.fill(0xFFFFFFFF); for (let y = 0; y < q.size; y++) for (let i = 0; i < q.size; i++) if (q.m[y * q.size + i]) d[(y + 4) * n + i + 4] = 0xFF000000; x.putImageData(im, 0, 0); };
  draw(); let f = 0;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cap.textContent = 'One frame of a stream (motion reduced)'; return; }
  const t = setInterval(() => { if (document.hidden) return; if (f >= 80) { clearInterval(t); cap.textContent = 'Stream stopped after 20 seconds'; return; } draw(); cap.textContent = `Live stream · frame ${++f} · every code is new`; }, 250);
})();
