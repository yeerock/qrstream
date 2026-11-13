'use strict';
/* QRStream sender (docs/METHODOLOGY.md). Plays a file as an endless, never-repeating stream of QR codes (core/qrtx.js). One way: no network, no back channel.
   Without a back channel the sender cannot know which density the camera reads best, so Smart mode weaves fast and safer layouts into one stream. The symbol
   size is fixed, so a layout change never loses what the receiver already holds. The entry code (a link to the receiver) fills the stage for the first 2.5 s
   and then stays in a corner of the bar, so a late phone can join without costing the stream any time. */
(() => {
  try { if (top !== self && top.location.origin !== location.origin) throw 0; } catch (e) { document.documentElement.hidden = true; return; }
  const $ = i => document.getElementById(i);
  const LEVELS = [[40, 30], [40, 20], [40, 15], [40, 12], [33, 12], [25, 10], [15, 8]];   // QR version, codes per second (per code slot)
  const MAX = 10 * 1048576, RECEIVER = new URL('../receive/?go', location.href).href;
  const P = new URLSearchParams(location.search), TEST = P.has('test');   // test mode: frames advance only when the test asks (deterministic recording)
  const sz = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  $('rx').textContent = RECEIVER.replace('?go', '');

  /** One or more codes in a row or a grid (cols per row), one pixel per module, with a 4-module quiet zone around and between them (ISO/IEC 18004 7.3.8). */
  function draw(cv, qs, quiet = 4, cols = 0) {
    qs = [].concat(qs); cols = cols || qs.length; const s = qs[0].size, n = s + quiet * 2, W = n * cols, H = n * Math.ceil(qs.length / cols); cv.width = W; cv.height = H;
    const x = cv.getContext('2d'), im = x.createImageData(W, H), d = new Uint32Array(im.data.buffer);
    d.fill(0xFFFFFFFF);
    qs.forEach((q, k) => { for (let y = 0; y < q.size; y++) for (let i = 0, o = (y + quiet + Math.floor(k / cols) * n) * W + quiet + (k % cols) * n, r = y * q.size; i < q.size; i++) if (q.m[r + i]) d[o + i] = 0xFF000000; });
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
    if (file.size > MAX) { $('err').textContent = `This file is ${sz(file.size)}. The limit is 10 MB. Sending by light suits files up to a few MB; use a cable or the network for larger ones.`; return; }
    if (!file.size) { $('err').textContent = 'This file is empty.'; return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = { name: String(file.name || 'file').slice(-120), mime: file.type || 'application/octet-stream', sha256: await hex(bytes), size: bytes.length, title: '', at: Math.floor(Date.now() / 1000) };
    // gzip first when it saves at least 10 % (text, logs, CSV, JSON, many PDFs); the SHA-256 is of the original file
    let body = bytes, zipped = false;
    if (window.CompressionStream && !/^(image\/(jpeg|png|gif|webp|avif)|video\/|audio\/|application\/(zip|gzip|x-7z|vnd\.openxmlformats))/.test(meta.mime)) {
      try { const z = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); if (z.length < bytes.length * 0.9) { body = z; zipped = true; meta.z = 'gzip'; } } catch (e) { }
    }
    const data = QRTX.pack(meta, body), s = new QRTX.Stream(data, crypto.getRandomValues(new Uint32Array(1))[0]);
    const entry = QRTX.encode(RECEIVER), cv = $('qr');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches && !TEST;   // people who asked for less motion start the flicker themselves
    let paused = still, timer = 0, last = 0, frames = 0, syms = 0, shownMs = 0, wl = null; const need = Math.ceil(data.length / QRTX.SYMBOL);
    // ---- Smart mode (Density Auto): no back channel, so the stream optimises itself.
    // 1. From this screen's real device pixels, find the layouts (QR version x codes side by side) whose modules are big enough to film.
    // 2. Weave three tiers into one stream, A A A B A A B C: A = the fastest comfortable layout, B = one step safer, C = a safe layout.
    //    Every frame carries fountain symbols, so a good camera runs near A's speed and a weak one still progresses on B and C frames.
    const VERS = Array.from({ length: 31 }, (_, i) => 40 - i).filter(v => QRTX.symbolsIn(v) >= 1);   // every size from 40 down to 10: the planner keeps the one that carries most
    let plan = null;
    const dpr = () => devicePixelRatio || 1;
    // layouts as [columns, rows]: a row of 1 to 3 codes, 2 stacked, or a 2 x 2 block. Smart mode picks whichever carries most on this screen's shape.
    const GRIDS = [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2]];
    const modPx = (v, c, r = 1) => { const b = $('stage').getBoundingClientRect(), n = v * 4 + 17 + 8; return Math.floor(Math.min((b.width - 8) * dpr() / (c * n), (b.height - 8) * dpr() / (r * n))); };
    // what a phone camera can resolve in one picture (1920 x 1080 at about 3.4 pixels per module): the whole layout must fit in 560 x 315 modules
    const filmable = (v, c, r) => { const n = v * 4 + 17 + 8, a = c * n, b = r * n; return Math.max(a, b) <= 560 && Math.min(a, b) <= 315; };
    const kSel = () => $('k').value, kFix = () => kSel() !== 'auto';
    const grids = () => kFix() ? GRIDS.filter(g => g[0] * g[1] === +kSel()) : GRIDS;
    function makePlan() {
      const opts = []; for (const v of VERS) for (const [c, r] of grids()) { const px = modPx(v, c, r); if (px >= 3 && px / dpr() >= 2 && filmable(v, c, r)) opts.push({ v, k: c * r, c, px, cap: c * r * QRTX.symbolsIn(v) * QRTX.SYMBOL }); }
      if (!opts.length) opts.push({ v: 15, k: 1, c: 1, px: modPx(15, 1), cap: QRTX.symbolsIn(15) * QRTX.SYMBOL });
      // a module must be big enough in device pixels (sharp) and in CSS pixels (physical size: a phone screen has 3 device pixels per CSS pixel)
      const best = (minPx, below = Infinity, css = 0) => opts.filter(o => o.px >= minPx && o.px / dpr() >= css && o.cap < below).sort((a, b) => b.cap - a.cap || a.k - b.k)[0];
      const A = best(4, Infinity, 2.5) || best(3) || opts[opts.length - 1], B = best(5, A.cap, 3) || A, C = best(7, B.cap, 3.5) || B;
      plan = [[A, 15], [A, 15], [A, 15], [B, 12], [A, 15], [A, 15], [B, 12], [C, 10]];
    }
    let slot = 0;
    const smart = () => $('lvl').value === 'auto';
    const cur = () => {
      if (smart()) { const [o, fps] = plan[slot % plan.length]; return { v: o.v, k: o.k, c: o.c, fps }; }
      const [v, fps] = LEVELS[+$('lvl').value];
      // a fixed density: the layout with the most codes whose modules are still at least 3 device pixels
      const g = grids().filter(([c, r]) => modPx(v, c, r) >= 3 && filmable(v, c, r)).sort((a, b) => b[0] * b[1] - a[0] * a[1] || a[1] - b[1])[0] || (kFix() ? grids()[0] : [1, 1]);
      return { v, k: g[0] * g[1], c: g[0], fps };
    };
    const shape = (k, c) => k === c ? `${k}\u00d7` : `${c} by ${k / c} grid of`;
    const clock = t => { t = Math.floor(t / 1000); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
    const stat = () => {
      const { v, k, fps } = cur(); let rate;
      if (smart()) { rate = plan.reduce((a, [o, f]) => a + o.cap * f, 0) / plan.length; } else rate = k * QRTX.symbolsIn(v) * QRTX.SYMBOL * fps;
      const head = smart() ? `Smart: ${shape(plan[0][0].k, plan[0][0].c)} v${plan[0][0].v} at 15/s, with safer frames woven in` : `${shape(k, cur().c)} QR v${v} \u00b7 ${fps}/s`, pass = syms / need, secs = Math.max(1, Math.ceil(data.length * 1.02 / rate));
      $('fstat').textContent = paused ? (frames ? 'Paused' : 'Ready. Press Start stream.') : `Showing for ${clock(shownMs)} \u00b7 pass ${Math.floor(pass) + 1} \u00b7 a phone needs about ${secs} s of clear view`;
      $('fdet').textContent = `${sz(file.size)}${zipped ? ' (gzip ' + sz(data.length) + ')' : ''} \u00b7 ${head} \u00b7 up to ${sz(rate)}/s \u00b7 check code ${meta.sha256.slice(0, 4)} ${meta.sha256.slice(4, 8)}`;
      $('fok').hidden = pass < 1; $('play').classList.toggle('enough', pass >= 1);
    };
    $('lvl').onchange = $('k').onchange = () => { makePlan(); stat(); };
    const step = (forceEntry) => {
      if (forceEntry) { if (cv.width !== entry.size + 8) draw(cv, entry); }
      else { const { v, k, c } = cur(), qs = []; for (let i = 0; i < k; i++) qs.push(QRTX.encode(s.next(v), { version: v, mask: 2 })); draw(cv, qs, 4, c); frames++; slot++; syms += k * QRTX.symbolsIn(v); }
      fit(cv); stat();
    };
    const tick = t => { timer = requestAnimationFrame(tick); if (paused) { last = t; return; } const dt = t - last; if (dt < 1000 / cur().fps - 2) return; if (last) shownMs += Math.min(dt, 500); last = t; step(); };
    const setPause = p => { paused = p; $('pause').textContent = p ? (frames ? 'Resume' : 'Start stream') : 'Pause'; $('ssay').textContent = p ? 'Paused' : 'Stream playing'; stat(); };
    $('fname').textContent = file.name; $('pickview').hidden = true; $('play').hidden = false; $('opts').open = innerWidth > 600; makePlan();   // measured on the visible stage
    draw($('ecode'), entry); draw(cv, entry); fit(cv); setPause(still); $('pause').focus();
    if (TEST) { window.__qrsStep = n => { for (let i = 0; i < n; i++) step(); return frames; }; window.__qrsEntry = () => step(true); window.__qrsMeta = meta; window.__qrsGrab = () => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let b = ''; for (let i = 0; i < d.length; i += 4) b += d[i] < 128 ? '1' : '0'; return { w: cv.width, h: cv.height, b }; }; }
    else { const t0 = setTimeout(() => { timer = requestAnimationFrame(tick); }, still ? 0 : 2500); var early = () => clearTimeout(t0); }   // entry code first, so the phone can open the receiver
    try { if (navigator.wakeLock) wl = await navigator.wakeLock.request('screen'); } catch (e) { }
    const onResize = () => { makePlan(); fit(cv); }; addEventListener('resize', onResize);
    const onShow = async () => { if (!document.hidden && navigator.wakeLock) { try { wl = await navigator.wakeLock.request('screen'); } catch (e) { } } }; document.addEventListener('visibilitychange', onShow);   // the lock is lost when the tab is hidden
    stop = () => { cancelAnimationFrame(timer); if (early) early(); removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onShow); $('ssay').textContent = 'Stopped'; if (wl) wl.release().catch(() => { }); if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); $('play').hidden = true; $('pickview').hidden = false; stop = null; $('drop').focus(); };
    $('pause').onclick = () => setPause(!paused);
  }
  $('close').onclick = () => stop && stop();
  $('fs').onclick = () => { const p = $('play'); (document.fullscreenElement ? document.exitFullscreen() : p.requestFullscreen?.())?.catch?.(() => { }); };
  addEventListener('keydown', e => {
    if (!stop || /^(BUTTON|SELECT|INPUT|TEXTAREA|SUMMARY)$/.test(e.target.tagName) && e.key !== 'Escape') return;
    if (e.key === 'Escape' && !document.fullscreenElement) stop();
    if (e.key === ' ') { e.preventDefault(); $('pause').click(); }
    if (e.key === 'f' || e.key === 'F') $('fs').click();
  });
  const take = files => { if (!files || !files.length || stop) return; if (files.length > 1) { $('err').textContent = `One file at a time: ${files.length} were chosen. Put them in one zip file and send that.`; return; } send(files[0]); };
  $('file').onchange = e => { const f = [...e.target.files]; e.target.value = ''; take(f); };
  const d = $('drop');
  d.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
  // a file dropped anywhere on the page is taken; without this the browser would open it and leave the page
  ['dragenter', 'dragover'].forEach(k => addEventListener(k, e => { e.preventDefault(); if (!stop) d.classList.add('on'); }));
  ['dragleave', 'drop'].forEach(k => addEventListener(k, e => { e.preventDefault(); d.classList.remove('on'); }));
  addEventListener('drop', e => take([...e.dataTransfer.files]));
  // text: typed or pasted, sent as a small text file
  const textFile = t => new File([t], 'note.txt', { type: 'text/plain' });
  $('sendtext').onclick = () => { const t = $('text').value; if (!t.trim()) { $('err').textContent = 'Type or paste some text first.'; return; } send(textFile(t)); };
  addEventListener('paste', e => {
    if (stop || !e.clipboardData) return;
    const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); take(fs); return; }   // a copied picture or file
    if (e.target === $('text')) return;
    const t = e.clipboardData.getData('text/plain'); if (t) { e.preventDefault(); $('text').value = t; $('textbox').open = true; $('text').focus(); }
  });

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
