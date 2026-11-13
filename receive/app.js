'use strict';
/* QRStream receiver (docs/METHODOLOGY.md): film the moving code, collect fountain frames, check the SHA-256, keep the file on this device, hand it to the OS share sheet. It sends nothing anywhere. */
(() => {
  // a page that frames this one from another site could trick taps onto Open or Delete: refuse to show there
  try { if (top !== self && top.location.origin !== location.origin) throw 0; } catch (e) { document.documentElement.hidden = true; return; }
  const $ = i => document.getElementById(i), show = id => ['home', 'scan'].forEach(s => { $(s).hidden = s !== id; });
  const sz = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const info = t => { $('homenote').textContent = t; }, err = t => { $('homemsg').textContent = t; };
  const v = $('v'); let epoch = 0, other = null, saidQ = 0; let stream = null, col = null, running = false, wake = null, lastRead = 0, startedAt = 0, reads = 0, pool = [], idle = [], current = null;
  const MAX_LEN = 16 * 1048576;
  // only types a browser shows without running code; HTML, SVG, XML and scripts open as plain text or save as bytes, never in this origin
  const SAFE = /^(image\/(jpeg|png|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm)|application\/(pdf|zip|json|octet-stream|vnd\.openxmlformats-officedocument\.[\w.]+)|text\/(plain|csv))$/;
  const safeType = m => { m = String(m || '').toLowerCase().split(';')[0].trim(); return SAFE.test(m) ? m : /^text\/|xml|javascript|html|svg/.test(m) ? 'text/plain' : 'application/octet-stream'; };
  const N = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

  // ---- saved files (IndexedDB, this browser only; the newest 20)
  const db = () => new Promise((ok, no) => { const r = indexedDB.open('qrstream', 1); r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id', autoIncrement: true }); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const tx = async (mode, fn) => { const d = await db(); return new Promise((ok, no) => { const t = d.transaction('files', mode), r = fn(t.objectStore('files')); t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error); }); };
  async function remember(f) { try { await tx('readwrite', s => s.add(f)); const all = await tx('readonly', s => s.getAll()); for (const o of all.slice(0, -20)) await tx('readwrite', s => s.delete(o.id)); } catch (e) { } }
  async function history() {
    let all = []; try { all = await tx('readonly', s => s.getAll()); } catch (e) { }
    $('histh').hidden = $('histnote').hidden = $('clear').hidden = !all.length; const ul = $('hist'); ul.textContent = '';
    all.reverse().forEach(f => {
      const li = document.createElement('li'), t = document.createElement('span'), s = document.createElement('small'), o = document.createElement('button'), d = document.createElement('button');
      t.textContent = f.title || f.name; s.textContent = `${sz(f.blob.size)}, ${new Date(f.at).toLocaleString()}`; t.appendChild(s);
      o.textContent = 'Open'; o.setAttribute('aria-label', 'Open ' + f.name); o.onclick = () => finished(f); d.textContent = 'Delete'; d.setAttribute('aria-label', 'Delete ' + f.name); d.onclick = async () => { await tx('readwrite', x => x.delete(f.id)); history(); };
      li.append(t, o, d); ul.appendChild(li);
    });
  }

  // ---- reading
  // test hook: ?debug exposes progress for automated end-to-end checks
  const DEBUG = new URLSearchParams(location.search).has('debug');
  function makePool() {
    if (pool.length) return;
    for (let i = 0; i < N; i++) { const w = new Worker('worker.js'); w.onmessage = e => { idle.push(w); if (e.data.error) say('Reader: ' + e.data.error.slice(0, 80)); e.data.texts.forEach(took); pump(); }; w.onerror = () => err('The reader could not start on this browser.'); pool.push(w); idle.push(w); }
  }
  const MAX_SIDE = 1920,   // enough for 3 codes of version 40 at about 3.4 px per module; larger pictures only cost time
     gc = document.createElement('canvas'), gx = gc.getContext('2d', { willReadFrequently: true }); let note = '', noteUntil = 0;
  const say = (t, ms = 5000) => { note = t; noteUntil = Date.now() + ms; $('hint').textContent = t; };
  function pump() {
    if (!running || !idle.length || v.readyState < 2 || !v.videoWidth) return;
    const w = idle.pop();
    // each frame is drawn on a canvas here: createImageBitmap of a camera video gives blank pictures on iPhone Safari
    try {
      const k = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight)), W = Math.round(v.videoWidth * k), H = Math.round(v.videoHeight * k);
      if (gc.width !== W || gc.height !== H) { gc.width = W; gc.height = H; }
      gx.drawImage(v, 0, 0, W, H);
      const im = gx.getImageData(0, 0, W, H);
      w.postMessage({ w: W, h: H, buf: im.data.buffer }, [im.data.buffer]);
    } catch (e) { idle.push(w); say('Camera picture could not be read: ' + e.name); }
  }
  function loop() { if (!running) return; pump(); if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); else requestAnimationFrame(loop); }
  function took(text) {
    if (!running) return;   // verifying or finished: late reads from the workers must not start a second completion
    if (/^https?:\/\/\S+\/receive\/(\?go)?$/i.test(text)) { if (!col) { $('stat').textContent = 'Sender found. The file is starting.'; lastRead = Date.now(); } return; }   // the sender's entry code (a link to this page)
    const f = QRTX.parseFrame(text); if (!f || f.len < 3 || f.len > MAX_LEN) return;   // a forged header must not make this page allocate gigabytes
    lastRead = Date.now(); reads++; seenN.push([lastRead, f.n]); if (f.n > topN) topN = f.n;
    if (col && (col.id !== f.id || col.len !== f.len)) {
      // another stream in view: one stray code must not wipe what was read. Switch only after 3 codes in a row from the new stream.
      if (other && other.id === f.id && other.len === f.len) other.n++; else other = { id: f.id, len: f.len, n: 1 };
      if (other.n < 3) return;
      if (col.progress > 0.05) say('A different file started on the screen. Starting again.', 4000);
      col = null;
    }
    other = null;
    if (!col) { col = new QRTX.Collector(f.id, f.len); startedAt = Date.now(); reads = 1; shown = 0; saidQ = 0; }
    try { col.add(f); } catch (e) { return; }
    draw();
    if (col.done && running) complete();
  }
  let shown = 0, rate = 0, seenN = [], topN = 0;
  function draw() {
    if (!col) return;
    const p = col.progress, s = (Date.now() - startedAt) / 1000, n = Math.floor(p * 100); if (n < shown) return; shown = n;
    $('pct').hidden = false; $('pct').textContent = n + '%'; $('fill').style.width = (p * 100).toFixed(1) + '%'; $('barw').setAttribute('aria-valuenow', n); rate = s > 0.5 ? col.len * p / s : 0;
    $('bytes').textContent = `${sz(col.len * p)} of ${sz(col.len)}${rate ? ' \u00b7 ' + sz(rate) + '/s' : ''}`; const left = p > 0.02 ? s * (1 - p) / p : 0;
    $('stat').textContent = left > 1 ? `Keep still, about ${left < 90 ? Math.ceil(left) + ' seconds' : Math.ceil(left / 60) + ' minutes'} left` : 'Keep still';
    const q = Math.floor(n / 25); if (q > saidQ && n < 100) { saidQ = q; $('say').textContent = n + ' percent received'; }   // screen readers hear the quarters, not every percent
    if (DEBUG) window.__qrs = { pct: n, frames: col.frames, len: col.len };
  }
  setInterval(() => {
    if (!running) return;
    const gap = (Date.now() - (lastRead || startedAt)) / 1000;
    // coach: the stream mixes fast dense codes with safer ones; which of them this camera reads says what to change
    const now = Date.now(); seenN = seenN.filter(x => now - x[0] < 3000);
    const dense = seenN.filter(x => x[1] >= topN && topN > 0).length, any = seenN.length;
    let tip = '';
    if (gap > 6 && lastRead) tip = 'Lost the code. Point the camera at the screen and hold still.';
    else if (gap > 3 && !lastRead) tip = 'Fit the whole screen in the box. Turn down glare: tilt the phone a little.';
    else if (any >= 3 && (dense === 0 || topN < 8)) tip = 'Only the slower codes are getting through. Move a little closer so the codes fill the box, and hold steady.';
    else if (any >= 3 && dense / any < 0.4) tip = 'Good. Hold steadier to read the fast codes too.';
    if (Date.now() > noteUntil) note = '';
    $('hint').textContent = note || tip;
  }, 1000);
  const AUTO = /\.(jpe?g|png|gif|webp|avif|bmp|mp4|webm|mov|mp3|m4a|ogg|wav|pdf|txt|csv|log|json)$/i;   // only these save by themselves; anything else waits for a tap
  async function complete() {
    const my = epoch; running = false; $('pct').textContent = '100%'; $('fill').style.width = '100%'; $('bytes').textContent = ''; $('stat').textContent = 'Checking the file';
    const bad = () => { if (my !== epoch) return; col = null; shown = 0; running = true; loop(); say('That file did not check out (SHA-256). Reading it again.', 6000); };
    try {
      const whole = new Uint8Array(col.bytes()), u = QRTX.unpack(whole);
      if (!u || !u.meta || typeof u.meta !== 'object' || Array.isArray(u.meta) || !u.file) return bad();
      if (u.meta.z === 'gzip') {
        if (!window.DecompressionStream) { stopCamera(); col = null; show('home'); err('This browser is too old to open compressed files. Update it (Safari 16.4 or later), then try again.'); return; }
        u.file = await gunzip(u.file, MAX_LEN * 4);   // bounded: a gzip bomb stops at 64 MB
      }
      const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', u.file))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (my !== epoch) return;   // stopped while checking
      if (hex !== u.meta.sha256) return bad();
      const clean = t => String(t || '').replace(/[\p{Cc}\p{Cf}]/gu, '');   // no control or direction-override characters in anything shown
      const f = { name: (clean(u.meta.name || 'file').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'), title: clean(u.meta.title).slice(0, 200), at: Date.now(), sha: hex, secs: (Date.now() - startedAt) / 1000, blob: new Blob([u.file], { type: safeType(u.meta.mime) }) };
      if (DEBUG) window.__qrs = { pct: 100, done: true, name: f.name, size: f.blob.size, type: f.blob.type, sha256: hex };
      stopCamera(); col = null; if (navigator.vibrate) navigator.vibrate(120); beep(); await remember(f); finished(f, true);
    } catch (e) { bad(); }
  }
  function beep() { try { const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.12); o.onended = () => a.close(); } catch (e) { } }
  async function gunzip(b, limit) {
    const rd = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), parts = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > limit) { rd.cancel(); throw new Error('too big'); } parts.push(value); }
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  let url = '';
  function view(result) { $('v').hidden = result; document.querySelector('.guide').hidden = result; $('prev').hidden = !result; $('live').hidden = result; $('result').hidden = !result; show('scan'); }
  function finished(f, fresh) {
    if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(f.blob);
    $('dname').textContent = `${f.title ? f.title + ', ' : ''}${f.name}, ${sz(f.blob.size)}${f.secs ? `, received in ${f.secs.toFixed(1)} s (${sz(f.blob.size / f.secs)}/s)` : ''}`;
    $('dhash').hidden = !f.sha; if (f.sha) $('dhash').textContent = `Check code ${f.sha.slice(0, 4)} ${f.sha.slice(4, 8)} (first 8 of SHA-256). It matches the code on the sender screen when this is the same file.`;
    document.title = 'Received: ' + f.name;
    view(true); Preview.render($('prev'), f.blob, f.name, url);
    // A web page cannot write to the photo library by itself (Web Share API, Level 2 files). iOS offers it in the share sheet (Save Image, Save Video, Save to Files); on Android a saved file appears in Gallery or Files under Downloads.
    const file = new File([f.blob], f.name, { type: f.blob.type }), canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1), android = /Android/.test(navigator.userAgent), media = /^(image|video)\//.test(f.blob.type);
    const msg = t => { $('savemsg').textContent = t; }; msg('');
    const link = () => { const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); };
    const share = () => navigator.share({ files: [file], title: f.title || f.name }).catch(e => { if (e.name !== 'AbortError') msg('Sharing did not work on this device. Use Save.'); });
    const pick = async () => {
      if (!window.showSaveFilePicker) return link();
      try { const h = await showSaveFilePicker({ suggestedName: f.name }), w = await h.createWritable(); await w.write(f.blob); await w.close(); msg('Saved.'); } catch (e) { if (e.name !== 'AbortError') link(); }
    };
    const saved = () => msg(android ? (media ? 'Saved. It is in Gallery or Photos, under Downloads.' : 'Saved to Downloads.') : 'Saved to your Downloads folder.');
    $('open').hidden = f.blob.type === 'application/octet-stream'; $('open').onclick = () => { if (!window.open(url, '_blank')) link(); };
    const sv = $('save'), sh = $('share'), ml = $('mail');
    if (ios && canShare) { sv.textContent = media ? 'Save to Photos' : 'Save to Files'; sv.onclick = () => { msg(media ? `Choose ${f.blob.type.startsWith('video/') ? 'Save Video' : 'Save Image'}.` : 'Choose Save to Files.'); share(); }; }
    else if (android) { sv.textContent = 'Save'; sv.onclick = () => { link(); saved(); }; }
    else { sv.textContent = 'Save'; sv.onclick = pick; }
    sh.hidden = !canShare; sh.onclick = () => { msg(''); share(); };
    // a page cannot attach a file to an email itself: the share sheet offers Mail with the file attached; elsewhere the file is saved and the mail app opens to attach it
    ml.onclick = () => { if (canShare) { msg('Choose Mail.'); share(); return; } link(); msg('The file is saved. Attach it to the email.'); location.href = 'mailto:?subject=' + encodeURIComponent(f.title || f.name); };
    if (fresh && !ios && AUTO.test(f.name) && f.blob.type !== 'application/octet-stream') { link(); saved(); sv.textContent = 'Save Again'; }
    if (fresh) $('dtitle').focus();   // Android and computers save at once; iOS allows saving only after a tap
  }

  // ---- camera
  async function startCamera(deviceId) {
    err(''); info('');
    if (!window.isSecureContext) { err('The camera needs a secure address (https). Open the https link.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { err('This browser cannot use the camera. Use Safari or Chrome.'); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(typeof deviceId === 'string' ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }), width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } } }); }
    catch (e) { err({ NotAllowedError: 'The camera is blocked. Tap the lock or "aA" icon in the address bar, allow Camera, then tap Start Camera.', NotFoundError: 'No camera was found on this device. Use a Video of the Code instead.', NotReadableError: 'Another app is using the camera. Close it and try again.', OverconstrainedError: 'That camera could not start. Try again.' }[e.name] || 'The camera could not start.'); return; }
    makePool(); v.srcObject = stream; view(false); await v.play().catch(() => { });
    try {   // tablets and computers: any camera they have
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'), sel = $('cam'), now = stream.getVideoTracks()[0].getSettings().deviceId;
      sel.textContent = ''; cams.forEach((c, i) => sel.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === now)));
      $('camw').hidden = cams.length < 2;
      sel.onchange = async () => { const keep = col; stopCamera(); col = keep; await startCamera(sel.value); };
    } catch (e) { }
    const tr = stream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
    try { if ((cap.focusMode || []).includes('continuous')) await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { }
    if (cap.zoom) { const z = $('zoom'); z.min = cap.zoom.min; z.max = cap.zoom.max; z.step = cap.zoom.step || 0.1; z.value = tr.getSettings().zoom || cap.zoom.min; z.oninput = () => tr.applyConstraints({ advanced: [{ zoom: +z.value }] }).catch(() => { }); $('zoomw').hidden = false; }
    const tb = $('torch'); tb.hidden = !cap.torch; tb.setAttribute('aria-pressed', 'false'); tb.onclick = () => { const on = tb.getAttribute('aria-pressed') !== 'true'; tr.applyConstraints({ advanced: [{ torch: on }] }).then(() => tb.setAttribute('aria-pressed', String(on))).catch(() => { }); };
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { }
    running = true; lastRead = 0; startedAt = Date.now(); loop();
  }
  function stopCamera() { epoch++; running = false; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; v.srcObject = null; if (v.src) { URL.revokeObjectURL(v.src); v.removeAttribute('src'); } if (wake) { wake.release().catch(() => { }); wake = null; } }
  // a recorded video of the code: played slowly, read like the camera
  function fromFile(file) {
    err(''); info(''); makePool(); view(false); v.src = URL.createObjectURL(file); v.playbackRate = 0.5; running = true; startedAt = Date.now(); lastRead = 0;
    v.onended = () => { if (!running) return; stopCamera(); v.onended = null; if (col) home(`This video held ${Math.floor(col.progress * 100)} % of the file. Film longer. What was read is kept for the next try.`); else { home(''); err('No code was found in this video.'); } };
    v.play().then(loop).catch(() => { home(''); err('This video could not be played.'); });
  }
  // back to the first screen; partly read data is kept until the user discards it
  function home(msg) { show('home'); document.title = 'QRStream Receiver'; const part = col && !col.done && col.progress > 0; info(msg || (part ? `${Math.floor(col.progress * 100)} % of the last file is kept. Start Camera to continue.` : '')); $('discard').hidden = !part; history(); }
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stopCamera(); home(col ? 'Paused. Start the camera again: what was read is kept.' : ''); } });
  $('start').onclick = () => startCamera();
  $('pick').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) fromFile(f); };
  $('stop').onclick = () => { stopCamera(); home(''); };
  $('discard').onclick = () => { col = null; home(''); };
  $('again').onclick = () => home('The file is kept below, in this browser only.');
  $('clear').onclick = async () => { if (!confirm('Delete all received files from this browser?')) return; try { await tx('readwrite', x => x.clear()); } catch (e) { } history(); };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  history();
  // opened from the sender's entry code: go straight to the camera (a browser that wants a tap keeps the Start Camera button)
  if (new URLSearchParams(location.search).has('go')) startCamera();
})();
