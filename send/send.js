'use strict';
/* QRStream sender (docs/METHODOLOGY.md). Plays a file as an endless, never-repeating stream of QR codes (core/qrtx.js). One way: no network, no back channel.
   Without a back channel the sender cannot know which density the camera reads best, so Auto steps through the levels every 15 s. The symbol size is fixed,
   so a level change never loses what the receiver already holds. Every 10 s the entry code (a link to the receiver) shows for 1.5 s, so a late phone can join. */
(() => {
  const $ = i => document.getElementById(i);
  const LEVELS = [[40, 30], [40, 20], [40, 15], [40, 12], [33, 12], [25, 10], [15, 8]];   // QR version, codes per second (per code slot)
  const MAX = 10 * 1048576, RECEIVER = new URL('../receive/?go', location.href).href;
  const P = new URLSearchParams(location.search), TEST = P.has('test');   // test mode: frames advance only when the test asks (deterministic recording)
  const sz = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  $('rx').textContent = RECEIVER.replace('?go', '');

  /** One or more codes side by side, one pixel per module, with a 4-module quiet zone around and between them (ISO/IEC 18004 7.3.8). */
  function draw(cv, qs, quiet = 4) {
    qs = [].concat(qs); const s = qs[0].size, n = s + quiet * 2, W = n * qs.length; cv.width = W; cv.height = n;
    const x = cv.getContext('2d'), im = x.createImageData(W, n), d = new Uint32Array(im.data.buffer);
    d.fill(0xFFFFFFFF);
    qs.forEach((q, k) => { for (let y = 0; y < q.size; y++) for (let i = 0, o = (y + quiet) * W + quiet + k * n, r = y * q.size; i < q.size; i++) if (q.m[r + i]) d[o + i] = 0xFF000000; });
    x.putImageData(im, 0, 0);
  }
  /** Whole device pixels per module keep the code sharp; the canvas holds one pixel per module and CSS scales it. */
  function fit(cv) {
    const r = $('stage').getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const m = Math.max(1, Math.floor(Math.min((r.width - 8) * dpr / cv.width, (r.height - 8) * dpr / cv.height)));
    cv.style.width = (m * cv.width / dpr) + 'px'; cv.style.height = (m * cv.height / dpr) + 'px';
  }
  const hex = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');

  let stop = null;
  async function send(file) {
    $('err').textContent = '';
    if (file.size > MAX) { $('err').textContent = `This file is ${sz(file.size)}. The limit is 10 MB: at about 30 KB/s a larger file would take too long.`; return; }
    if (!file.size) { $('err').textContent = 'This file is empty.'; return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = { name: file.name, mime: file.type || 'application/octet-stream', sha256: await hex(bytes), size: bytes.length, title: '', at: Math.floor(Date.now() / 1000) };
    // gzip first when it saves at least 10 % (text, logs, CSV, JSON, many PDFs); the SHA-256 is of the original file
    let body = bytes, zipped = false;
    if (window.CompressionStream && !/^(image\/(jpeg|png|gif|webp|avif)|video\/|audio\/|application\/(zip|gzip|x-7z|vnd\.openxmlformats))/.test(meta.mime)) {
      try { const z = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); if (z.length < bytes.length * 0.9) { body = z; zipped = true; meta.z = 'gzip'; } } catch (e) { }
    }
    const data = QRTX.pack(meta, body), s = new QRTX.Stream(data, crypto.getRandomValues(new Uint32Array(1))[0]);
    const entry = QRTX.encode(RECEIVER), cv = $('qr');
    let paused = false, timer = 0, last = 0, began = performance.now(), frames = 0, wl = null;
    // ---- Smart mode (Density Auto): no back channel, so the stream optimises itself.
    // 1. From this screen's real device pixels, find the layouts (QR version x codes side by side) whose modules are big enough to film.
    // 2. Weave three tiers into one stream, A A A B A A B C: A = the fastest comfortable layout, B = one step safer, C = a safe layout.
    //    Every frame carries fountain symbols, so a good camera runs near A's speed and a weak one still progresses on B and C frames.
    const VERS = [40, 33, 25, 15];
    let plan = null;
    const modPx = (v, k) => { const r = $('stage').getBoundingClientRect(), n = v * 4 + 17 + 8, dpr = devicePixelRatio || 1; return Math.floor(Math.min((r.width - 8) * dpr / (k * n), (r.height - 8) * dpr / n)); };
    const kMax = () => { const v = $('k').value; return v === 'auto' ? 3 : +v; }, kFix = () => $('k').value !== 'auto';
    function makePlan() {
      const opts = []; for (const v of VERS) for (let k = kFix() ? kMax() : 1; k <= kMax(); k++) { const px = modPx(v, k); if (px >= 3) opts.push({ v, k, px, cap: k * QRTX.symbolsIn(v) * QRTX.SYMBOL }); }
      if (!opts.length) opts.push({ v: 15, k: 1, px: modPx(15, 1), cap: QRTX.symbolsIn(15) * QRTX.SYMBOL });
      const best = (minPx, below = Infinity) => opts.filter(o => o.px >= minPx && o.cap < below).sort((a, b) => b.cap - a.cap)[0];
      const A = best(4) || best(3) || opts[opts.length - 1], B = best(5, A.cap) || A, C = best(7, B.cap) || B;
      plan = [[A, 15], [A, 15], [A, 15], [B, 12], [A, 15], [A, 15], [B, 12], [C, 10]];
    }
    let slot = 0;
    const smart = () => $('lvl').value === 'auto';
    const cur = () => {
      if (smart()) { const [o, fps] = plan[slot % plan.length]; return { v: o.v, k: o.k, fps }; }
      const [v, fps] = LEVELS[+$('lvl').value]; let k = kMax(); if (!kFix()) { while (k > 1 && modPx(v, k) < 3) k--; }
      return { v, k, fps };
    };
    const stat = () => {
      const { v, k, fps } = cur(); let rate;
      if (smart()) { rate = plan.reduce((a, [o, f]) => a + o.cap * f, 0) / plan.length; } else rate = k * QRTX.symbolsIn(v) * QRTX.SYMBOL * fps;
      const head = smart() ? `Smart: ${plan[0][0].k}× v${plan[0][0].v} at 15/s, with safer frames woven in` : `${k}× QR v${v} · ${fps}/s`;
      $('fstat').textContent = `${sz(file.size)}${zipped ? ' (gzip ' + sz(data.length) + ')' : ''} · ${head} · up to ${sz(rate)}/s · about ${Math.max(1, Math.ceil(data.length * 1.02 / rate))} s at best · frame ${frames}`;
    };
    $('lvl').onchange = $('k').onchange = () => { makePlan(); stat(); };
    const step = (forceEntry) => {
      const t = performance.now() - began;
      if (forceEntry || (!TEST && t % 10000 < 1500)) { if (cv.width !== entry.size + 8) draw(cv, entry); }
      else { const { v, k } = cur(), qs = []; for (let i = 0; i < k; i++) qs.push(QRTX.encode(s.next(v), { version: v, mask: 2 })); draw(cv, qs); frames++; slot++; }
      fit(cv); stat();
    };
    const tick = t => { timer = requestAnimationFrame(tick); if (paused || t - last < 1000 / cur().fps - 2) return; last = t; step(); };
    $('fname').textContent = file.name; $('pickview').hidden = true; $('play').hidden = false; makePlan();   // measured on the visible stage
    if (TEST) { window.__agqStep = n => { for (let i = 0; i < n; i++) step(); return frames; }; window.__agqEntry = () => step(true); window.__agqMeta = meta; window.__agqGrab = () => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let b = ''; for (let i = 0; i < d.length; i += 4) b += d[i] < 128 ? '1' : '0'; return { w: cv.width, h: cv.height, b }; }; draw(cv, entry); fit(cv); }
    else { draw(cv, entry); fit(cv); setTimeout(() => { began = performance.now() - 1500; timer = requestAnimationFrame(tick); }, 2500); }   // entry code first, so the phone can open the receiver
    try { if (navigator.wakeLock) wl = await navigator.wakeLock.request('screen'); } catch (e) { }
    const onResize = () => { makePlan(); fit(cv); }; addEventListener('resize', onResize);
    stop = () => { cancelAnimationFrame(timer); removeEventListener('resize', onResize); if (wl) wl.release().catch(() => { }); if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); $('play').hidden = true; $('pickview').hidden = false; stop = null; };
    $('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; };
  }
  $('close').onclick = () => stop && stop();
  $('fs').onclick = () => { const p = $('play'); (document.fullscreenElement ? document.exitFullscreen() : p.requestFullscreen?.())?.catch?.(() => { }); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && stop && !document.fullscreenElement) stop(); if (e.key === ' ' && stop) { e.preventDefault(); $('pause').click(); } });
  $('file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) send(f); };
  const d = $('drop');
  d.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
  ['dragenter', 'dragover'].forEach(k => d.addEventListener(k, e => { e.preventDefault(); d.classList.add('on'); }));
  ['dragleave', 'drop'].forEach(k => d.addEventListener(k, e => { e.preventDefault(); d.classList.remove('on'); }));
  d.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) send(f); });

  // demo files, drawn here so the repo needs no binary samples
  function demoPicture() {
    const c = document.createElement('canvas'); c.width = 960; c.height = 540; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 960, 540); g.addColorStop(0, '#2f7bf6'); g.addColorStop(1, '#3ecf8e'); x.fillStyle = g; x.fillRect(0, 0, 960, 540);
    for (let i = 0; i < 40; i++) { x.fillStyle = `hsla(${(i * 37) % 360},80%,70%,.35)`; x.beginPath(); x.arc((i * 211) % 960, (i * 137) % 540, 20 + (i * 13) % 90, 0, 7); x.fill(); }
    x.fillStyle = '#fff'; x.font = 'bold 72px system-ui,sans-serif'; x.textAlign = 'center'; x.fillText('Sent by light', 480, 260);
    x.font = '32px system-ui,sans-serif'; x.fillText('QRStream demo · ' + new Date().toISOString().slice(0, 10), 480, 320);
    return new Promise(r => c.toBlob(b => r(new File([b], 'qrstream-demo.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.82));
  }
  function demoText() {
    const t = 'QRStream demo file\n\n' + Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: a file can travel from a screen to a phone as a stream of QR codes, one way, with no network.`).join('\n') + '\n';
    return new File([t], 'qrstream-demo.txt', { type: 'text/plain' });
  }
  $('demo').onclick = async () => send(await demoPicture());
  $('demotxt').onclick = () => send(demoText());
  if (P.has('demo')) (P.get('demo') === 'text' ? Promise.resolve(demoText()) : demoPicture()).then(send);
})();
