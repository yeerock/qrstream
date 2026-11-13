'use strict';
// Hero: a real, endless QR stream drawn by the same core the sender uses, as a 2 by 2 block of four codes (the sender's default layout).
// It plays for 20 seconds and then waits for a click (motion that starts by itself must stop). Still under prefers-reduced-motion.
(() => {
  const cv = document.getElementById('hero'), cap = document.getElementById('herocap'), btn = document.getElementById('heroplay'); if (!cv || !window.QRTX) return;
  const V = 20, FPS = 10, RUN = 20, per = 4 * QRTX.symbolsIn(V) * QRTX.SYMBOL;   // bytes carried by one screen
  const text = new TextEncoder().encode('QRStream: this animation is a real stream of four codes. '.repeat(4000));
  const s = new QRTX.Stream(QRTX.pack({ name: 'hello.txt', mime: 'text/plain', sha256: '' }, text), 1);
  const draw = () => {
    const qs = [0, 1, 2, 3].map(() => QRTX.encode(s.next(V), { version: V, mask: 2 })), n = qs[0].size + 8, W = n * 2; cv.width = cv.height = W;
    const x = cv.getContext('2d'), im = x.createImageData(W, W), d = new Uint32Array(im.data.buffer); d.fill(0xFFFFFFFF);
    qs.forEach((q, k) => { for (let y = 0; y < q.size; y++) for (let i = 0, o = (y + 4 + (k >> 1) * n) * W + 4 + (k & 1) * n; i < q.size; i++) if (q.m[y * q.size + i]) d[o + i] = 0xFF000000; });
    x.putImageData(im, 0, 0);
  };
  const rate = `${Math.round(per * FPS / 1024)} KB/s`;
  draw(); let f = 0, timer = 0;
  const stop = () => { clearInterval(timer); timer = 0; cap.textContent = `Stopped. Four codes a screen carry ${rate} here; a full-size screen carries more.`; if (btn) btn.textContent = 'Play the stream'; };
  const play = () => { if (timer) return; f = 0; if (btn) btn.textContent = 'Pause the stream'; timer = setInterval(() => { if (document.hidden) return; if (++f > RUN * FPS) return stop(); draw(); cap.textContent = `Live stream · 4 codes a screen · ${rate} · every code is new`; }, 1000 / FPS); };
  if (btn) { btn.hidden = false; btn.onclick = () => (timer ? stop() : play()); }   // always there: motion that starts by itself needs a way to pause it
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cap.textContent = `One screen of a stream: four codes, ${rate} when playing`; if (btn) { btn.hidden = false; btn.textContent = 'Play the stream'; } return; }
  play();
})();
