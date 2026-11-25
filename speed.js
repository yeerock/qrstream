'use strict';
// Speed test: the REAL pipeline, no camera. The page encodes a random file with the sender's own code (core/qrtx.js), draws the QR codes into a 1920 x 1080 picture
// the way a screen shows them, reads that picture back with the receiver's own reader (core/qrread.js), feeds the decoder and checks the SHA-256.
// What it does not have is a real lens: a perfect picture, no blur, no glare. So the time it reports is "time on screen at the sender's pace" for an ideal camera.
(() => {
  const $ = id => document.getElementById(id);
  if (!$('sp-run') || !window.QRTX || !window.QRREAD) return;
  const V = 40, K = 3, PACE = 15, PX = 3;                               // 3 codes of version 40 side by side at 15 screens a second, 3 picture pixels per module (a 1080p camera view)
  const per = K * QRTX.symbolsIn(V) * QRTX.SYMBOL;                       // bytes on one screen
  const sz = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1000 ? Math.round(n / 1024) + ' KB' : Math.round(n) + ' B';
  const hex = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');
  const w = ms => new Promise(r => setTimeout(r, ms));
  let running = false, cancel = false;
  const cv = $('sp-cv'), cx = cv.getContext('2d', { willReadFrequently: true });
  const set = (id, t) => { const e = $(id); if (e.textContent !== t) e.textContent = t; };

  function randomFile(n) { const b = new Uint8Array(n); let s = 0x9E3779B9 ^ n; for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; b[i] = s & 255; } return b; }   // incompressible, like a JPEG

  async function run() {
    if (running) { cancel = true; return; }
    running = true; cancel = false; $('sp-run').textContent = 'Stop'; $('sp-run').setAttribute('aria-pressed', 'true');
    const size = +$('sp-size').value, loss = +$('sp-loss').value / 100;
    ['sp-done', 'sp-ok'].forEach(i => { $(i).hidden = true; }); $('sp-bar').style.width = '0%'; $('sp-barw').setAttribute('aria-valuenow', '0');
    const bytes = randomFile(size), meta = { name: 'speedtest.bin', mime: 'application/octet-stream', sha256: await hex(bytes), size, at: 0 };
    const stream = new QRTX.Stream(QRTX.seal(meta, bytes), (Math.random() * 2 ** 32) >>> 0);
    const col = new QRTX.Collector(stream.id, stream.len);
    // one camera picture: the three codes at PX pixels per module with a 4-module quiet zone, centred on a white 1920 x 1080 picture
    const sizeM = 4 * V + 17, n = sizeM + 8, W = 1920, H = 1080; cv.width = W; cv.height = H;
    const off = document.createElement('canvas'); off.width = n * K; off.height = n; const ox = off.getContext('2d'), im = ox.createImageData(n * K, n), d = new Uint32Array(im.data.buffer);
    let screens = 0, codes = 0, lostCodes = 0, readFail = 0, t0 = performance.now(), done = false;
    while (!done && !cancel && screens < 20000) {
      d.fill(0xFFFFFFFF);
      for (let k = 0; k < K; k++) { const q = QRTX.encode(stream.next(V, 1), { version: V, mask: 2 }); for (let y = 0; y < q.size; y++) for (let x = 0, o = (y + 4) * n * K + 4 + k * n, r = y * q.size; x < q.size; x++) if (q.m[r + x]) d[o + x] = 0xFF000000; }
      ox.putImageData(im, 0, 0);
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H); cx.imageSmoothingEnabled = false; cx.drawImage(off, 0, 0, off.width, off.height, (W - off.width * PX) / 2, (H - off.height * PX) / 2, off.width * PX, off.height * PX);
      const px = cx.getImageData(0, 0, W, H); screens++;
      // a code the camera misses: blank it out of the picture (as glare or a missed frame would) with the chosen chance, before the reader sees it
      let texts = QRREAD.read(px, 9); const have = texts.length; codes += K;
      for (const t of texts) { if (Math.random() < loss) { lostCodes++; continue; } const f = QRTX.parseFrame(t); if (!f) { readFail++; continue; } try { col.add(f); } catch (e) { } }
      readFail += Math.max(0, K - have);
      done = col.done;
      if (screens % 2 === 0 || done) {
        const p = Math.floor(col.progress * 100), at = screens / PACE, rate = (col.rank * QRTX.SYMBOL) / Math.max(at, 0.001);
        $('sp-bar').style.width = p + '%'; $('sp-barw').setAttribute('aria-valuenow', String(p));
        set('sp-pct', p + '%'); set('sp-scr', String(screens)); set('sp-time', at.toFixed(1) + ' s'); set('sp-rate', sz(rate) + '/s'); set('sp-lost', String(lostCodes));
        await w(0);
      }
    }
    if (done && !cancel) {
      const u = QRTX.unpack(new Uint8Array(col.bytes())), good = u && u.file && await hex(u.file) === meta.sha256 && u.file.length === size;
      const at = screens / PACE, wall = (performance.now() - t0) / 1000;
      set('sp-time', at.toFixed(1) + ' s'); set('sp-rate', sz(size / at) + '/s');
      $('sp-ok').hidden = false; $('sp-ok').className = 'okline ' + (good ? 'yes' : 'no');
      $('sp-ok').textContent = good ? `✓ ${sz(size)} rebuilt and the SHA-256 matches. Same file, byte for byte.` : '✗ The check failed. Please report this.';
      $('sp-done').hidden = false;
      $('sp-done').textContent = `Result: ${sz(size)} in ${at.toFixed(1)} s on screen (${screens} screens at ${PACE} a second, ${K} codes each) = ${sz(size / at)}/s, with ${Math.round(loss * 100)} % of codes lost. This browser did the whole encode, draw, read and decode in ${wall.toFixed(1)} s.`;
      window.__speedtest = { size, screens, onScreenSeconds: at, ok: !!good };
    } else if (cancel) { set('sp-pct', 'Stopped'); }
    running = false; cancel = false; $('sp-run').textContent = 'Run it again'; $('sp-run').setAttribute('aria-pressed', 'false');
  }
  $('sp-run').onclick = run;
  // plain-language estimate for any size, from the measured rates (the same numbers as the table below it)
  const calc = () => {
    const kb = Math.max(1, +$('cl-size').value || 0) * +$('cl-unit').value, b = kb * 1024;
    const rows = [['One code on a phone screen', 42 * 1024 * 0.6], ['Smart mode on a Full HD screen', 65 * 1024], ['Wide 1440p screen, 3 codes at 30 a second', 131 * 1024]];
    $('cl-out').textContent = ''; rows.forEach(([name, r]) => { const s = Math.max(0.5, b * 1.02 / r), li = document.createElement('li'); const t = s < 90 ? s.toFixed(s < 10 ? 1 : 0) + ' s' : (s / 60).toFixed(1) + ' min'; li.append(Object.assign(document.createElement('span'), { textContent: name }), Object.assign(document.createElement('b'), { textContent: t })); $('cl-out').append(li); });
    $('cl-note').textContent = b > 10 * 1048576 ? 'Over 10 MB the sender will not start. Use a cable or a network.' : /^\d/.test($('cl-size').value) && b > 3 * 1048576 ? 'Large for light: it works, but a cable or Wi-Fi is faster.' : 'Text, logs, CSV and many PDFs are compressed first and finish sooner. Photos and videos are already compressed.';
  };
  $('cl-size').oninput = $('cl-unit').onchange = calc; calc();
  $('sp-size').onchange = $('sp-loss').onchange = () => { if (!running) { $('sp-run').textContent = 'Run the speed test'; } };
})();
