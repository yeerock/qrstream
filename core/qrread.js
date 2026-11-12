'use strict';
/* QRStream reader: own code, no library. Finds and decodes QR codes (Model 2, level L, alphanumeric and byte mode) in a camera picture.
   Steps (ISO/IEC 18004 annex on reference decoding, done our own way):
   1. Luma, then a local threshold per 8x8 block averaged over its 5x5 block neighbourhood (handles uneven light and screen glare).
   2. Finder patterns: row scans for dark-light-dark-light-dark runs in ratio 1:1:3:1:1, confirmed by a vertical and a second horizontal scan.
   3. Finders grouped into codes: three centres that make a right isosceles triangle with matching module sizes (several codes per picture).
   4. Geometry: a perspective map from the three finders plus the bottom-right alignment pattern; for version 2 and up, every alignment pattern is
      located and each cell between them gets its own map, which absorbs lens distortion and a slightly curved screen.
   5. Format and version information: nearest valid BCH code word (corrects up to 3 bit errors).
   6. Unmask, de-interleave, Reed-Solomon decode per block (Berlekamp-Massey, Chien search, Forney), then the data segments.
   Needs core/qrtx.js (the encoder's tables). Works in a browser, a worker and Node. */
(function (root, factory) { const m = factory(root.QRTX || globalThis.QRTX || (typeof require === 'function' ? require('./qrtx.js') : null)); if (typeof module !== 'undefined' && module.exports) module.exports = m; else root.QRREAD = m; })(typeof self !== 'undefined' ? self : this, QRTX => {
  const { template, maskMap, bch, EXP, LOG, EC_L, BLOCKS_L, ALNUM, alignPos, countBits } = QRTX._int;

  // ---- 1. binarize
  function binarize(rgba, W, H) {
    const g = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    const B = 8, bw = Math.ceil(W / B), bh = Math.ceil(H / B), avg = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let mn = 255, mx = 0, sum = 0, n = 0;
      for (let y = by * B, ye = Math.min(H, y + B); y < ye; y++) for (let x = bx * B, xe = Math.min(W, x + B), o = y * W; x < xe; x++) { const v = g[o + x]; sum += v; n++; if (v < mn) mn = v; if (v > mx) mx = v; }
      let a = sum / n;
      if (mx - mn <= 24) {   // flat block: lean to white unless the neighbours say otherwise
        a = mn / 2;
        if (by > 0 && bx > 0) { const nb = (avg[(by - 1) * bw + bx] + 2 * avg[by * bw + bx - 1] + avg[(by - 1) * bw + bx - 1]) / 4; if (mn < nb) a = nb; }
      }
      avg[by * bw + bx] = a;
    }
    const bin = new Uint8Array(W * H);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) { const yy = by + dy; if (yy < 0 || yy >= bh) continue; for (let dx = -2; dx <= 2; dx++) { const xx = bx + dx; if (xx < 0 || xx >= bw) continue; s += avg[yy * bw + xx]; n++; } }
      const t = s / n;
      for (let y = by * B, ye = Math.min(H, y + B); y < ye; y++) for (let x = bx * B, xe = Math.min(W, x + B), o = y * W; x < xe; x++) bin[o + x] = g[o + x] <= t ? 1 : 0;
    }
    return bin;
  }

  // ---- 2. finder patterns
  function ratioOK(c, tol = 0.7) {
    const t = c[0] + c[1] + c[2] + c[3] + c[4]; if (t < 7) return false;
    const m = t / 7, d = m * tol;
    return Math.abs(m - c[0]) < d && Math.abs(m - c[1]) < d && Math.abs(3 * m - c[2]) < 3 * d && Math.abs(m - c[3]) < d && Math.abs(m - c[4]) < d;
  }
  /** Runs along a line through (x, y) in direction (dx, dy); returns [counts, centre offset] or null. */
  function cross(bin, W, H, x, y, dx, dy, maxRun) {
    const at = (i) => { const xx = Math.round(x + dx * i), yy = Math.round(y + dy * i); return xx < 0 || yy < 0 || xx >= W || yy >= H ? -1 : bin[yy * W + xx]; };
    const c = [0, 0, 0, 0, 0]; let i = 0;
    if (at(0) !== 1) return null;
    while (at(i) === 1) { c[2]++; i--; if (c[2] > maxRun * 3) return null; }
    while (at(i) === 0) { c[1]++; i--; if (c[1] > maxRun) return null; }
    while (at(i) === 1) { c[0]++; i--; if (c[0] > maxRun) return null; }
    const start = i + 1;
    i = 1; while (at(i) === 1) { c[2]++; i++; if (c[2] > maxRun * 3) return null; }
    while (at(i) === 0) { c[3]++; i++; if (c[3] > maxRun) return null; }
    while (at(i) === 1) { c[4]++; i++; if (c[4] > maxRun) return null; }
    if (!c[0] || !c[1] || !c[3] || !c[4] || !ratioOK(c)) return null;
    const ctr = start + c[0] + c[1] + c[2] / 2 - 0.5;   // offset along the line
    return [c, ctr];
  }
  function finders(bin, W, H) {
    const found = [], step = Math.max(1, Math.floor(H / 400));
    const add = (x, y, ms) => {
      for (const f of found) if (Math.abs(f.x - x) <= f.ms * 2 && Math.abs(f.y - y) <= f.ms * 2 && Math.abs(f.ms - ms) < f.ms * 0.5) { const n = f.n + 1; f.x = (f.x * f.n + x) / n; f.y = (f.y * f.n + y) / n; f.ms = (f.ms * f.n + ms) / n; f.n = n; return; }
      found.push({ x, y, ms, n: 1 });
    };
    const check = (c, x, y) => {
      const t = c[0] + c[1] + c[2] + c[3] + c[4], cx0 = x - c[4] - c[3] - c[2] / 2, maxRun = Math.ceil(t / 7 * 2.5);
      const v = cross(bin, W, H, Math.round(cx0), y, 0, 1, maxRun); if (!v) return false;
      const cy = y + v[1], vt = v[0].reduce((a, b) => a + b, 0); if (Math.abs(vt - t) > t * 0.5) return false;
      const h = cross(bin, W, H, Math.round(cx0), Math.round(cy), 1, 0, maxRun); if (!h) return false;
      const cx = Math.round(cx0) + h[1], ht = h[0].reduce((a, b) => a + b, 0);
      const d = cross(bin, W, H, Math.round(cx), Math.round(cy), 1, 1, maxRun); if (!d) return false;   // diagonal check removes most false finders in random data
      add(cx, cy, (ht + vt) / 14); return true;
    };
    for (let y = step - 1; y < H; y += step) {
      const c = [0, 0, 0, 0, 0]; let st = 0; const o = y * W;
      for (let x = 0; x <= W; x++) {
        const b = x < W ? bin[o + x] : 0;
        if (b) { if (st & 1) st++; c[st]++; continue; }
        if (st === 0) { if (c[0]) { st = 1; c[1] = 1; } continue; }
        if (st & 1) { c[st]++; continue; }
        if (st === 4) {
          if (ratioOK(c) && check(c, x, y)) { c.fill(0); st = 0; }
          else { c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0; st = 3; }
        } else { st++; c[st]++; }
      }
    }
    return found;
  }

  // ---- 3. group finders into codes
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function triples(fs) {
    const cand = [];
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) for (let k = j + 1; k < fs.length; k++) {
      const p = [fs[i], fs[j], fs[k]], ms = (p[0].ms + p[1].ms + p[2].ms) / 3;
      if (p.some(f => Math.abs(f.ms - ms) > ms * 0.4)) continue;
      const d = [dist(p[1], p[2]), dist(p[0], p[2]), dist(p[0], p[1])], h = d.indexOf(Math.max(...d));
      const A = p[h], o = p.filter((_, n) => n !== h), a = dist(A, o[0]), b = dist(A, o[1]);
      if (Math.abs(a - b) > Math.max(a, b) * 0.2) continue;
      const hyp = d[h], err = Math.abs(hyp - Math.hypot(a, b)) / hyp; if (err > 0.1) continue;
      const side = (a + b) / 2 / ms; if (side < 13 || side > 175) continue;
      let [B, C] = o; if ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) < 0) [B, C] = [C, B];   // A top-left, B top-right, C bottom-left
      // rank: geometry error, then how often each finder was confirmed (finders seen on one scan line only are often random data)
      const weak = p.reduce((k, f) => k + (f.n < 2 ? 1 : 0) + (f.n < 3 ? 0.5 : 0), 0);
      cand.push({ tl: A, tr: B, bl: C, ms, err: err + Math.abs(a - b) / Math.max(a, b) + weak * 0.08 });
    }
    return cand.sort((x, y) => x.err - y.err);
  }

  // ---- 4. geometry: perspective map from four point pairs (unit square in between)
  function sq2quad(x0, y0, x1, y1, x2, y2, x3, y3) {
    const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
    const a13 = (dx3 * dy2 - dx2 * dy3) / den, a23 = (dx1 * dy3 - dx3 * dy1) / den;
    return [x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0, y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0, a13, a23, 1];
  }
  function adj(m) { const [a, b, c, d, e, f, g, h, i] = m; return [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d]; }
  function mul(m, n) { const r = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = m[i * 3] * n[j] + m[i * 3 + 1] * n[3 + j] + m[i * 3 + 2] * n[6 + j]; return r; }
  /** Map that takes src quad (module coords) to dst quad (image coords); points in order (0,0),(1,0),(1,1),(0,1) of the square. */
  function quad2quad(s, d) {
    const S = sq2quad(...s), D = sq2quad(...d);
    // sq2quad gives [a11 a21 a31; a12 a22 a32; a13 a23 a33] laid out row-wise as columns; apply as x' = (m0 u + m1 v + m2)/(m6 u + m7 v + m8)
    return mul(D, adj(S));
  }
  const apply = (m, u, v) => { const w = m[6] * u + m[7] * v + m[8]; return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w]; };
  const mapFor = (pts) => quad2quad([pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1]], [pts[0][2], pts[0][3], pts[1][2], pts[1][3], pts[2][2], pts[2][3], pts[3][2], pts[3][3]]);

  const OFFS = new Map();
  /** Best match of the 5x5 alignment pattern near module centre (u, v); returns the image point or null.
      Coarse search on a half-module grid, then the centre of all top-scoring offsets on a 1/8-module grid (sub-module accuracy). */
  function findAlign(bin, W, H, m, u, v, R) {
    const score = (cu, cv) => {
      let s = 0;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        const [px, py] = apply(m, cu + x, cv + y), xx = Math.round(px), yy = Math.round(py);
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) { s--; continue; }
        if (bin[yy * W + xx] === (Math.max(Math.abs(x), Math.abs(y)) === 1 ? 0 : 1)) s++;
      }
      return s;
    };
    let best = -Infinity, bu = 0, bv = 0;
    const offs = OFFS.get(R) || (OFFS.set(R, (() => { const o = []; for (let du = -R; du <= R; du += 0.5) for (let dv = -R; dv <= R; dv += 0.5) o.push([du, dv]); return o.sort((a, b) => Math.hypot(...a) - Math.hypot(...b)); })()), OFFS.get(R));
    for (const [du, dv] of offs) { const s = score(u + du, v + dv); if (s > best) { best = s; bu = du; bv = dv; if (s === 25) break; } }   // nearest first: stop at a perfect match
    if (best < 23) return null;
    let su = 0, sv = 0, n = 0, top = -Infinity; const hits = [];
    for (let du = bu - 0.375; du <= bu + 0.375; du += 0.125) for (let dv = bv - 0.375; dv <= bv + 0.375; dv += 0.125) { const s = score(u + du, v + dv); hits.push([s, du, dv]); if (s > top) top = s; }
    for (const [s, du, dv] of hits) if (s === top) { su += du; sv += dv; n++; }
    return apply(m, u + su / n, v + sv / n);
  }

  /** Least-squares homography (direct linear transform, h33 = 1) from >= 4 pairs [u, v, x, y], with both sides normalised for conditioning. */
  function fitH(P) {
    const norm = (k0, k1) => { let mx = 0, my = 0; for (const p of P) { mx += p[k0]; my += p[k1]; } mx /= P.length; my /= P.length; let d = 0; for (const p of P) d += Math.hypot(p[k0] - mx, p[k1] - my); const sc = Math.SQRT2 * P.length / (d || 1); return [sc, mx, my]; };
    const [su, mu, mv] = norm(0, 1), [sx, mx, my] = norm(2, 3);
    const A = Array.from({ length: 8 }, () => new Float64Array(9));
    for (const p of P) {
      const u = (p[0] - mu) * su, v = (p[1] - mv) * su, x = (p[2] - mx) * sx, y = (p[3] - my) * sx;
      for (const [r, t] of [[[u, v, 1, 0, 0, 0, -u * x, -v * x], x], [[0, 0, 0, u, v, 1, -u * y, -v * y], y]])
        for (let i = 0; i < 8; i++) { for (let j = 0; j < 8; j++) A[i][j] += r[i] * r[j]; A[i][8] += r[i] * t; }
    }
    for (let c = 0; c < 8; c++) {   // Gaussian elimination with partial pivoting on the normal equations
      let pr = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[pr][c])) pr = r;
      [A[c], A[pr]] = [A[pr], A[c]]; const d = A[c][c]; if (Math.abs(d) < 1e-12) return null;
      for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / d; if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]; }
    }
    const h = A.map((r, i) => r[8] / r[i]);
    const N = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    const T = [sx, 0, -sx * mx, 0, sx, -sx * my, 0, 0, 1], Ti = adj(T), S = [su, 0, -su * mu, 0, su, -su * mv, 0, 0, 1];
    return mul(Ti, mul(N, S));   // un-normalise: image = T^-1 * N * S * module
  }

  /** Locks the module grid of one candidate code at size `dim`: the three finders, then alignment patterns, refitting the homography after each find.
      Fast lock: six well-spread patterns (centre of each edge band, centre, bottom-right), enough for perspective. Full lock: every pattern, nearest
      the finders first, so strong distortion never throws a later prediction off; it also enables one map per cell. */
  function lock(bin, W, H, t, dim, full) {
    const v = (dim - 17) / 4, e = dim - 3.5;
    const pts = [[3.5, 3.5, t.tl.x, t.tl.y], [e, 3.5, t.tr.x, t.tr.y], [3.5, e, t.bl.x, t.bl.y]];
    let m = mapFor([pts[0], pts[1], [e, e, t.tr.x + t.bl.x - t.tl.x, t.tr.y + t.bl.y - t.tl.y], pts[2]]);
    if (v < 2) return { m };
    const G = alignPos(v).map(a => a + 0.5), n = G.length, P = new Array(n * n).fill(null), corner = (i, j) => (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
    let order;
    if (full) { order = []; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!corner(i, j)) order.push([i, j, Math.min(i + j, (n - 1 - i) + j, i + (n - 1 - j))]); order.sort((a, b) => a[2] - b[2]); }
    else { const c = (n - 1) >> 1; order = [[c, 0], [0, c], [c, c], [n - 1, c], [c, n - 1], [n - 1, n - 1]].filter(([i, j], k, a) => !corner(i, j) && a.findIndex(x => x[0] === i && x[1] === j) === k); }
    for (const [i, j] of order) {
      const f = findAlign(bin, W, H, m, G[i], G[j], pts.length < 5 ? 3 : full ? 1.5 : 2.5);
      if (f) { P[j * n + i] = f; pts.push([G[i], G[j], f[0], f[1]]); if (pts.length >= 4) m = fitH(pts) || m; }
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!P[j * n + i]) P[j * n + i] = apply(m, G[i], G[j]);
    return { m, G, P };
  }
  /** Module matrix from a lock. cells = false: one homography; true: one map per cell between alignment patterns. */
  function sample(bin, W, H, dim, L, cells) {
    let get = (x, y) => apply(L.m, x + 0.5, y + 0.5);
    if (cells && L.G) {
      const G = L.G, P = L.P, n = G.length, maps = new Map();
      const cellMap = (ci, cj) => {
        const k = ci * 64 + cj; let c = maps.get(k); if (c) return c;
        const q = (i, j) => [G[i], G[j], P[j * n + i][0], P[j * n + i][1]];
        c = mapFor([q(ci, cj), q(ci + 1, cj), q(ci + 1, cj + 1), q(ci, cj + 1)]); maps.set(k, c); return c;
      };
      const idx = u => { let i = 0; while (i < n - 2 && u >= G[i + 1]) i++; return i; };
      get = (x, y) => apply(cellMap(idx(x + 0.5), idx(y + 0.5)), x + 0.5, y + 0.5);
    }
    const out = new Uint8Array(dim * dim);
    for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) {
      const [px, py] = get(x, y), xx = Math.round(px), yy = Math.round(py);
      out[y * dim + x] = xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : bin[yy * W + xx];
    }
    return out;
  }
  /** Kept for tests and tools: sampler(mode 0 = full lock, one map; 1 = full lock, cell maps). */
  const sampler = (bin, W, H, t, dim, mode) => sample(bin, W, H, dim, lock(bin, W, H, t, dim, true), mode === 1);

  // ---- 5. format and version information
  const FORMATS = Array.from({ length: 32 }, (_, d) => [(bch(d, 0x537) ^ 0x5412) >>> 0, d]);
  const VERSIONS = Array.from({ length: 34 }, (_, i) => [bch(i + 7, 0x1F25), i + 7]);
  const pop = x => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
  const nearest = (word, table) => { let best = null, bd = 4; for (const [w, d] of table) { const h = pop(word ^ w); if (h < bd) { bd = h; best = d; } } return best; };
  function format(M, n) {
    const b = (x, y) => M[y * n + x];
    let a = 0, c = 0;
    const A = []; for (let i = 0; i <= 5; i++) A.push(b(8, i)); A.push(b(8, 7), b(8, 8), b(7, 8)); for (let i = 9; i < 15; i++) A.push(b(14 - i, 8));
    const C = []; for (let i = 0; i < 8; i++) C.push(b(n - 1 - i, 8)); for (let i = 8; i < 15; i++) C.push(b(8, n - 15 + i));
    A.forEach((v, i) => { a |= v << i; }); C.forEach((v, i) => { c |= v << i; });
    const r = nearest(a, FORMATS); return r !== null ? r : nearest(c, FORMATS);
  }
  function version(M, n) {
    let a = 0, c = 0;
    for (let i = 0; i < 18; i++) { const x = n - 11 + i % 3, y = Math.floor(i / 3); a |= M[y * n + x] << i; c |= M[x * n + y] << i; }
    const r = nearest(a, VERSIONS); return r !== null ? r : nearest(c, VERSIONS);
  }

  // ---- 6. Reed-Solomon decoding, GF(256) with polynomial 0x11D, generator roots a^0 .. a^(n-1) (as the encoder)
  const gmul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0, gdiv = (a, b) => a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0;
  const evalLow = (p, x) => { let r = 0; for (let i = p.length - 1; i >= 0; i--) r = gmul(r, x) ^ p[i]; return r; };   // p[0] lowest degree
  /** Corrects block w (data then EC, w[0] highest power) in place; false when it holds more errors than ec/2. */
  function rsFix(w, ec) {
    const N = w.length, S = new Uint8Array(ec); let any = 0;
    for (let i = 0; i < ec; i++) { let r = 0; const x = EXP[i]; for (let j = 0; j < N; j++) r = gmul(r, x) ^ w[j]; S[i] = r; any |= r; }
    if (!any) return true;
    let C = [1], B = [1], L = 0, m = 1, b = 1;
    for (let k = 0; k < ec; k++) {
      let d = S[k]; for (let i = 1; i <= L; i++) d ^= gmul(C[i] || 0, S[k - i]);
      if (!d) { m++; continue; }
      const T = C.slice(), coef = gdiv(d, b), need = B.length + m; while (C.length < need) C.push(0);
      for (let i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
      if (2 * L <= k) { L = k + 1 - L; B = T; b = d; m = 1; } else m++;
    }
    if (L * 2 > ec) return false;
    const Om = new Uint8Array(ec); for (let i = 0; i < ec; i++) { let s = 0; for (let j = 0; j <= i; j++) s ^= gmul(S[i - j], C[j] || 0); Om[i] = s; }
    const dC = []; for (let i = 1; i < C.length; i += 2) { dC[i - 1] = C[i]; dC[i] = 0; }
    let found = 0;
    for (let j = 0; j < N; j++) {
      const p = N - 1 - j, Xinv = EXP[(255 - p) % 255];
      if (evalLow(C, Xinv)) continue;
      const den = evalLow(dC, Xinv); if (!den) return false;
      w[j] ^= gmul(EXP[p], gdiv(evalLow(Om, Xinv), den)); found++;
    }
    if (found !== L) return false;
    for (let i = 0; i < ec; i++) { let r = 0; const x = EXP[i]; for (let j = 0; j < N; j++) r = gmul(r, x) ^ w[j]; if (r) return false; }
    return true;
  }

  // ---- 7. modules -> text
  function decodeMatrix(M, n) {
    const v = (n - 17) / 4; if (v < 1 || v > 40 || v !== Math.floor(v)) return null;
    const f = format(M, n); if (f === null || (f >> 3) !== 1) return null;   // level L only, the level QRStream writes
    const mask = f & 7, t = template(v), map = maskMap(v, mask), p = t.path, words = new Uint8Array(t.total);
    for (let i = 0; i < p.length && (i >> 3) < t.total; i++) if (M[p[i]] ^ map[p[i]]) words[i >> 3] |= 0x80 >> (i & 7);
    const nb = t.blocks, ec = t.ec, sLen = Math.floor(t.data / nb), nShort = nb - t.data % nb, blocks = [];
    for (let b = 0; b < nb; b++) blocks.push(new Uint8Array(sLen + (b < nShort ? 0 : 1) + ec));
    let w = 0;
    for (let i = 0; i < sLen; i++) for (let b = 0; b < nb; b++) blocks[b][i] = words[w++];
    for (let b = nShort; b < nb; b++) blocks[b][sLen] = words[w++];
    for (let i = 0; i < ec; i++) for (let b = 0; b < nb; b++) blocks[b][blocks[b].length - ec + i] = words[w++];
    const data = new Uint8Array(t.data); let o = 0;
    for (const bl of blocks) { if (!rsFix(bl, ec)) return null; data.set(bl.subarray(0, bl.length - ec), o); o += bl.length - ec; }
    let bit = 0; const rd = k => { let r = 0; for (let i = 0; i < k; i++, bit++) r = (r << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1); return r; };
    let out = '';
    while (bit + 4 <= data.length * 8) {
      const mode = rd(4);
      if (mode === 0) break;
      if (mode === 2) { let len = rd(countBits(v)); while (len >= 2) { const x = rd(11); out += ALNUM[Math.floor(x / 45)] + ALNUM[x % 45]; len -= 2; } if (len) out += ALNUM[rd(6)]; }
      else if (mode === 4) { let len = rd(v < 10 ? 8 : 16); while (len--) out += String.fromCharCode(rd(8)); }
      else return null;   // a mode this reader does not need (numeric, kanji, ECI)
    }
    return out;
  }

  /** Size of the code from its timing patterns, perspective-proof: walk the line through module row 6 (and column 6) from finder centre to finder
      centre and count dark/light runs. Row 6 holds the finder's bottom edge, a light separator, d-16 alternating timing modules, a separator and
      the next finder's edge: d - 12 runs. Returns the sizes both lines agree on (or each one's), [] when neither looks like a timing pattern. */
  function timingDims(bin, W, H, t) {
    const runs = (a, b, toward, msA, msB) => {
      const ux = toward.x - a.x, uy = toward.y - a.y, ul = Math.hypot(ux, uy), ox = ux / ul, oy = uy / ul;
      const x0 = a.x + ox * 3 * msA, y0 = a.y + oy * 3 * msA, x1 = b.x + ox * 3 * msB, y1 = b.y + oy * 3 * msB;   // 3 modules from row 3 to row 6
      const len = Math.hypot(x1 - x0, y1 - y0), steps = Math.ceil(len * 2), seq = [];
      for (let i = 0; i <= steps; i++) { const f = i / steps, xx = Math.round(x0 + (x1 - x0) * f), yy = Math.round(y0 + (y1 - y0) * f); seq.push(xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : bin[yy * W + xx]); }
      const min = Math.min(msA, msB) * 2 * 0.4;   // samples are half a pixel apart; runs under 0.4 module are noise
      const r = []; for (const v of seq) { if (r.length && r[r.length - 1][0] === v) r[r.length - 1][1]++; else r.push([v, 1]); }
      for (let k = 1; k < r.length - 1;) { if (r[k][1] < min) { r[k - 1][1] += r[k][1] + r[k + 1][1]; r.splice(k, 2); } else k++; }
      if (r[0][0] !== 1 || r[r.length - 1][0] !== 1) return 0;
      const d = r.length + 12; return d >= 21 && d <= 177 && (d - 17) % 4 === 0 ? d : 0;
    };
    const a = runs(t.tl, t.tr, t.bl, t.tl.ms, t.tr.ms), b = runs(t.tl, t.bl, t.tr, t.tl.ms, t.bl.ms);
    return a && a === b ? [a] : [a, b].filter(Boolean);
  }
  /** ImageData-like {data, width, height} -> array of decoded texts (up to `max` codes). */
  function read(img, max = 4) {
    const W = img.width, H = img.height, bin = binarize(img.data, W, H), fs = finders(bin, W, H);
    if (fs.length < 3) return [];
    const fs2 = fs.length > 40 ? fs.sort((a, b) => b.n - a.n).slice(0, 40) : fs;   // bound the triangle search
    const out = [], used = new Set(); let tries = 0;
    for (const t of triples(fs2)) {
      if (out.length >= max || tries >= 4 * max + 8) break;
      if (used.has(t.tl) || used.has(t.tr) || used.has(t.bl)) continue;   // a finder belongs to one code; marked only after a decode succeeds
      tries++;
      const side = (dist(t.tl, t.tr) + dist(t.tl, t.bl)) / 2 / t.ms;
      let dim = Math.round(side) + 7; const r = dim & 3; dim += r === 0 ? 1 : r === 2 ? -1 : r === 3 ? -2 : 0;
      const tried = new Set(); let text = null;
      const tryDim = d => {
        if (d < 21 || d > 177 || tried.has(d)) return null; tried.add(d);
        // fast lock first; the full grid lock (and then cell maps) only when that fails
        const plans = (d - 17) / 4 < 2 ? [[false, false]] : [[false, false], [true, false], [true, true]]; let Lf = null;
        for (const [full, cells] of plans) {
          const L = full ? (Lf = Lf || lock(bin, W, H, t, d, true)) : lock(bin, W, H, t, d, false), M = sample(bin, W, H, d, L, cells);
          if (d >= 45 && !full) { const vv = version(M, d); if (vv && vv * 4 + 17 !== d) return tryDim(vv * 4 + 17); }
          const s = decodeMatrix(M, d); if (s !== null) return s;
        }
        return null;
      };
      // timing patterns (row 6 and column 6 alternate dark/light between the finders) prove the triangle is a code and pick its size, for a few
      // hundred samples instead of a full decode attempt per guess
      const sizes = timingDims(bin, W, H, t);
      if (!sizes.length && t.err < 0.05) sizes.push(dim);   // timing unreadable (heavy blur) but a clean triangle: try the geometric size once
      for (const d of sizes) { text = tryDim(d); if (text !== null) break; }
      if (text !== null) { out.push(text); used.add(t.tl); used.add(t.tr); used.add(t.bl); }
    }
    return out;
  }
  return { read, _: { binarize, finders, triples, decodeMatrix, rsFix, timingDims, sampler, lock, sample, findAlign, mapFor, apply } };
});
