'use strict';
/* What the camera box shows when a file has arrived, inside this page only. Picture, video, a card for a PDF (Open shows it in the device's own viewer), start of docx, xlsx and pptx (own reader:
   these files are ZIP archives of XML), start of a text file, otherwise a file card. A file that cannot be previewed still saves: every failure falls back to the card. */
const Preview = (() => {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const card = (box, name) => { const ext = (name.split('.').pop() || 'file').toUpperCase().slice(0, 5); box.innerHTML = `<div class="pcard"><b>${esc(ext)}</b>${esc(name)}</div>`; };
  /** ZIP central directory (APPNOTE 4.3.12) -> path -> async text. Stored and deflated entries. */
  const LIMIT = 4 * 1048576;
  function zip(buf) {
    const d = new DataView(buf), u = new Uint8Array(buf); let e = buf.byteLength - 22;
    while (e >= 0 && d.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('not a zip');
    const out = {}; let p = d.getUint32(e + 16, true);
    for (let i = 0, n = d.getUint16(e + 10, true); i < n; i++) {
      const method = d.getUint16(p + 10, true), size = d.getUint32(p + 20, true), full = d.getUint32(p + 24, true), nl = d.getUint16(p + 28, true), xl = d.getUint16(p + 30, true), cl = d.getUint16(p + 32, true), lo = d.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nl));
      if (size > LIMIT || full > LIMIT) { p += 46 + nl + xl + cl; continue; }   // zip bomb guard: a preview reads only parts that are small before and after inflating
      out[name] = async () => {
        const st = lo + 30 + d.getUint16(lo + 26, true) + d.getUint16(lo + 28, true), raw = u.subarray(st, st + size);
        if (!method) return new TextDecoder().decode(raw);
        // the declared size can lie, so the inflated bytes are counted and cut off at the limit
        const rd = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), parts = []; let n = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > LIMIT) { rd.cancel(); throw new Error('too big'); } parts.push(value); }
        return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
      };
      p += 46 + nl + xl + cl;
    }
    return out;
  }
  // Office parts never carry a DTD; one that does could expand entities into gigabytes of text, so it is refused (the file still saves, only the preview falls back to a card)
  const xml = s => { if (/<!DOCTYPE/i.test(s)) throw new Error('DTD'); return new DOMParser().parseFromString(s, 'application/xml'); };
  const cut = t => { t = String(t); return t.length > 2000 ? t.slice(0, 2000) + '\u2026' : t; };   // a preview shows the start of each paragraph or cell, never megabytes
  const tags = (n, t) => [...n.getElementsByTagName(t)];
  async function docx(z, box) {
    const ps = tags(xml(await z['word/document.xml']()), 'w:p').slice(0, 60).map(p => tags(p, 'w:t').map(t => t.textContent).join('')).filter(Boolean);
    box.innerHTML = `<div class="pdoc">${ps.map(t => `<p>${esc(cut(t))}</p>`).join('')}</div>`;
  }
  async function xlsx(z, box) {
    const ss = z['xl/sharedStrings.xml'] ? tags(xml(await z['xl/sharedStrings.xml']()), 'si').map(s => tags(s, 't').map(t => t.textContent).join('')) : [];
    const key = Object.keys(z).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
    const rows = tags(xml(await z[key]()), 'row').slice(0, 30).map(r => tags(r, 'c').slice(0, 12).map(c => { const v = tags(c, 'v')[0], t = tags(c, 't')[0]; return c.getAttribute('t') === 's' && v ? ss[+v.textContent] ?? '' : (v || t) ? (v || t).textContent : ''; }));
    box.innerHTML = `<div class="pdoc"><table>${rows.map(r => `<tr>${r.map(x => `<td>${esc(cut(x))}</td>`).join('')}</tr>`).join('')}</table></div>`;
  }
  async function pptx(z, box) {
    const key = Object.keys(z).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))[0];
    const ps = tags(xml(await z[key]()), 'a:p').map(p => tags(p, 'a:t').map(t => t.textContent).join('')).filter(Boolean);
    box.innerHTML = `<div class="pdoc"><h3>${esc(cut(ps[0] || ''))}</h3>${ps.slice(1, 60).map(t => `<p>${esc(cut(t))}</p>`).join('')}</div>`;
  }
  async function render(box, blob, name, url) {
    const t = blob.type, ext = name.toLowerCase().split('.').pop();
    card(box, name);
    try {
      if (t.startsWith('image/')) { const i = new Image(); i.alt = name; i.onload = () => { box.textContent = ''; box.appendChild(i); }; i.src = url; return; }
      if (t.startsWith('video/')) { const m = document.createElement('video'); m.src = url; m.controls = true; m.playsInline = true; m.muted = true; m.preload = 'metadata'; box.textContent = ''; box.appendChild(m); return; }
      if (t === 'application/pdf' || ext === 'pdf') { box.innerHTML = `<div class="pcard"><b>PDF</b>${esc(name)}<small>Tap Open to read it in this device's own PDF viewer.</small></div>`; return; }
      if (['docx', 'xlsx', 'pptx'].includes(ext)) { const z = zip(await blob.arrayBuffer()); return await { docx, xlsx, pptx }[ext](z, box); }
      if (t.startsWith('text/') || ['csv', 'txt', 'json', 'log'].includes(ext)) box.innerHTML = `<div class="pdoc"><pre>${esc(await blob.slice(0, 20000).text())}</pre></div>`;
    } catch (e) { card(box, name); }
  }
  return { render };
})();
