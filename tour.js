'use strict';
// Walkthrough: six steps, each drawn with the real code (core/qrtx.js). Step 4 runs the real decoder on a small file while you choose how many frames to lose.
(() => {
  const $ = id => document.getElementById(id);
  if (!$('tour-vis') || !window.QRTX) return;
  const S = QRTX.SYMBOL, mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const sz = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1000 ? Math.round(n / 1024) + ' KB' : n + ' bytes';
  const sample = new TextEncoder().encode(Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: a file travels from a screen to a phone as QR codes.`).join('\n'));
  let timer = 0;

  const STEPS = [
    { h: 'Pick a file', p: 'Any file up to 10 MB. It is read in your browser. Nothing is uploaded.', vis(el) {
      const c = mk('div', 'vcard'); c.append(mk('b', '', 'report.pdf'), mk('span', '', '180 KB · application/pdf')); el.append(c); el.append(mk('p', 'vcap', 'This is the whole input. No account, no app.')); } },
    { h: 'Pack and squeeze', p: 'The sender adds the name, type and a SHA-256 fingerprint, and compresses text-like files.', async vis(el) {
      const z = new Uint8Array(await new Response(new Blob([sample]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()).length, a = mk('div', 'bars');
      [['Original', sample.length, 1], ['After gzip', z, z / sample.length]].forEach(([n, v, f]) => { const r = mk('div', 'brow'); r.append(mk('span', '', n)); const t = mk('i'); t.style.width = Math.max(4, f * 100) + '%'; r.append(t, mk('b', '', sz(v))); a.append(r); });
      el.append(a, mk('p', 'vcap', `A text sample shrinks ${Math.round((1 - z / sample.length) * 100)} %. Photos and videos are already compressed and are sent as they are.`)); } },
    { h: 'Cut into blocks', p: `The file is cut into ${S}-byte blocks. This is what one 180 KB file looks like.`, vis(el) {
      const g = mk('div', 'blocks'); for (let i = 0; i < 126; i++) { const b = mk('i'); b.style.background = `hsl(${(i * 47) % 360} 70% 55%)`; g.append(b); } el.append(g, mk('p', 'vcap', '180 KB = about 1,300 blocks (126 shown).')); } },
    { h: 'Make endless fresh symbols', p: 'Each symbol mixes random blocks together. Any set slightly bigger than the file rebuilds it, so a lost frame costs nothing. Try it: this runs the real decoder.', vis(el) {
      const g = mk('div', 'blocks big'), tiles = []; for (let i = 0; i < 60; i++) { const b = mk('i', 'off'); tiles.push(b); g.append(b); }
      const lab = mk('label', 'lossl', 'Frames lost: '), r = mk('input'); r.type = 'range'; r.min = 0; r.max = 60; r.value = 30; const rv = mk('b', '', '30 %'); lab.append(r, rv);
      const out = mk('p', 'vcap', ''), go = mk('button', 'btn', 'Send it'); r.oninput = () => { rv.textContent = r.value + ' %'; };
      const file = new Uint8Array(60 * S - 40).map((_, i) => (i * 131 + 7) & 255), run = () => {
        clearInterval(timer); tiles.forEach(t => { t.className = 'off'; }); const st = new QRTX.Stream(QRTX.pack({ name: 't', mime: 'x', sha256: '' }, file), 9), v = 10, per = QRTX.symbolsIn(v);
        const col = new QRTX.Collector(st.id, st.len); let sent = 0, got = 0; const K = col.K;
        timer = setInterval(() => { for (let q = 0; q < 2; q++) { const f = QRTX.parseFrame(st.next(v)); sent++; if (Math.random() * 100 < +r.value) continue; got++; col.add(f); }
          const n = Math.round(col.progress * tiles.length); tiles.forEach((t, i) => { t.className = i < n || col.done ? 'on' : 'off'; });
          out.textContent = col.done ? `Done. ${sent} frames shown, ${sent - got} lost, ${got} used. The file is complete.` : `${sent} frames shown, ${sent - got} lost…`; if (col.done || sent > 400) clearInterval(timer); }, 120); };
      go.onclick = run; el.append(g, lab, go, out); } },
    { h: 'Show them as QR codes', p: 'Each frame is a header, up to 20 symbols and a checksum, drawn as a QR code. Smart mode puts 1 to 8 codes on the screen, about 15 times a second.', vis(el) {
      const cv = mk('canvas', 'qr'), st = new QRTX.Stream(sample, 3), q = QRTX.encode(st.next(15), { version: 15, mask: 2 }), n = q.size + 8; cv.width = cv.height = n;
      const x = cv.getContext('2d'), im = x.createImageData(n, n), d = new Uint32Array(im.data.buffer); d.fill(0xFFFFFFFF); for (let y = 0; y < q.size; y++) for (let i = 0; i < q.size; i++) if (q.m[y * q.size + i]) d[(y + 4) * n + 4 + i] = 0xFF000000; x.putImageData(im, 0, 0);
      const l = mk('ul', 'anat'); [['20 bytes', 'header: stream id, length, position, CRC-32'], ['up to 20 × 142 bytes', 'symbols, the file in disguise'], ['2,840 bytes', 'one code at QR version 40']].forEach(([a, b]) => { const li = mk('li'); li.append(mk('b', '', a), document.createTextNode(' ' + b)); l.append(li); });
      const w = mk('div', 'qrrow'); w.append(cv, l); el.append(w); } },
    { h: 'Phone films, checks, keeps', p: 'The phone reads the codes, drops damaged ones, rebuilds the file and verifies it. Then you open, save or share it.', vis(el) {
      const l = mk('ol', 'chk'); ['Read the codes in each camera picture', 'Check every frame (CRC-32)', 'Rebuild the file', 'Check the whole file (SHA-256)', 'Open · Save · Share · Email'].forEach(t => l.append(mk('li', '', t))); el.append(l);
      const li = [...l.children]; let k = 0; timer = setInterval(() => { if (k < li.length) li[k++].classList.add('on'); else { clearInterval(timer); } }, 450); } },
  ];

  let i = 0;
  async function show(n) {
    clearInterval(timer); i = Math.max(0, Math.min(STEPS.length - 1, n)); const s = STEPS[i], el = $('tour-vis'); el.textContent = '';
    $('tour-n').textContent = `Step ${i + 1} of ${STEPS.length}`; $('tour-h').textContent = s.h; $('tour-p').textContent = s.p; await s.vis(el);
    $('tour-prev').disabled = !i; $('tour-next').textContent = i === STEPS.length - 1 ? 'Start over' : 'Next';
    [...$('tour-dots').children].forEach((d, k) => { d.classList.toggle('on', k === i); d.setAttribute('aria-current', k === i ? 'step' : 'false'); });
  }
  STEPS.forEach((s, k) => { const b = mk('button', 'dot'); b.type = 'button'; b.setAttribute('aria-label', `Step ${k + 1}: ${s.h}`); b.onclick = () => show(k); $('tour-dots').append(b); });
  $('tour-prev').onclick = () => show(i - 1); $('tour-next').onclick = () => show(i === STEPS.length - 1 ? 0 : i + 1);
  show(0);
})();
