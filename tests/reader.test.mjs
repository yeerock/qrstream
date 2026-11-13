// Own QR reader against own encoder: synthetic camera pictures (scale, rotation, perspective, blur, noise, uneven light,
// several codes per picture, damaged modules). Run: node tests/reader.test.mjs
import { createRequire } from 'node:module'; import assert from 'node:assert/strict'; import { randomBytes } from 'node:crypto';
const req = createRequire(import.meta.url), Q = req('../core/qrtx.js'), R = req('../core/qrread.js');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } };

/** Render codes (each {q, x, y, s}: module size s px) into an RGBA picture through a projective warp, then blur, light gradient and noise. */
function picture(W, H, codes, { rot = 0, persp = 0, blur = 0, noise = 0, light = 0, flip = [], nseed = 1 } = {}) {
  const ink = (X, Y) => {   // inverse warp: picture point -> sheet point
    const cx = W / 2, cy = H / 2; let x = X - cx, y = Y - cy;
    const w = 1 + persp * (x / W); x /= w; y /= w;
    const c = Math.cos(-rot), s = Math.sin(-rot); const u = x * c - y * s + cx, v = x * s + y * c + cy;
    for (const k of codes) { const mx = Math.floor((u - k.x) / k.s) - 4, my = Math.floor((v - k.y) / k.s) - 4, n = k.q.size;
      if (mx >= -4 && my >= -4 && mx < n + 4 && my < n + 4) { if (mx < 0 || my < 0 || mx >= n || my >= n) return 0; let d = k.q.m[my * n + mx]; if (k.flip && k.flip.has(my * n + mx)) d ^= 1; return d; } }
    return 0;
  };
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = ink(x + 0.5, y + 0.5); g[y * W + x] = d ? 30 : 225; }
  let src = g;   // blur leaves the 1 px border as is (no dark frame)
  for (let p = 0; p < blur; p++) { const o = Float32Array.from(src); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[(y + dy) * W + x + dx]; o[y * W + x] = s / 9; } src = o; }
  const data = new Uint8ClampedArray(W * H * 4); let seed = nseed; const rnd = () => (seed = seed * 1103515245 + 12345 >>> 0) / 4294967296;
  for (let i = 0; i < W * H; i++) { const x = i % W, v = src[i] * (1 - light * x / W) + (rnd() - 0.5) * noise; data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
  return { data, width: W, height: H };
}
const frame = v => new Q.Stream(randomBytes(8000), 5).next(v);
for (const [name, v, s, W, H, opt] of [
  ['v40 straight, 4 px modules', 40, 4, 800, 800, {}],
  ['v40 3 px modules, blur', 40, 3, 620, 620, { blur: 1 }],
  ['v40 rotated 7 degrees', 40, 4, 900, 900, { rot: 0.12 }],
  ['v40 perspective + rotation', 40, 4, 900, 900, { rot: -0.08, persp: 0.18 }],
  ['v33 noise + uneven light', 33, 4, 760, 760, { noise: 60, light: 0.5 }],
  ['v25 upside down', 25, 4, 600, 600, { rot: Math.PI }],
  ['v15 small', 15, 3, 320, 320, {}],
]) t(name, () => { const text = frame(v), q = Q.encode(text, { version: v, mask: 2 }); const pic = picture(W, H, [{ q, x: (W - (q.size + 8) * s) / 2, y: (H - (q.size + 8) * s) / 2, s }], opt); assert.deepEqual(R.read(pic), [text]); });
t('3 codes side by side, perspective', () => {
  const ts = [frame(40), frame(40), frame(40)], s = 3.5, n = 185, W = Math.round(3 * n * s + 260), H = Math.round(n * s + 160);
  const pic = picture(W, H, ts.map((x, i) => ({ q: Q.encode(x, { version: 40, mask: 2 }), x: 130 + i * n * s, y: 80, s })), { persp: 0.1, blur: 1 });
  assert.deepEqual(new Set(R.read(pic)), new Set(ts));
});
t('entry link in byte mode', () => { const u = 'https://yeerock.github.io/qrstream/receive/?go', q = Q.encode(u); assert.deepEqual(R.read(picture(400, 400, [{ q, x: 60, y: 60, s: 5 }])), [u]); });
t('Reed-Solomon repairs damaged modules', () => {
  const text = frame(40), q = Q.encode(text, { version: 40, mask: 2 }), flip = new Set(); let seed = 9;
  while (flip.size < 120) { seed = seed * 1103515245 + 12345 >>> 0; const i = seed % (q.size * q.size), x = i % q.size, y = Math.floor(i / q.size); if (x > 9 && y > 9 && x < q.size - 10 && y < q.size - 10) flip.add(i); }
  assert.deepEqual(R.read(picture(800, 800, [{ q, x: 30, y: 30, s: 4, flip }])), [text]);
});
t('Reed-Solomon: corrects up to ec/2 byte errors per block, refuses more', () => {
  const { rsFix } = R._; const text = frame(10), q = Q.encode(text, { version: 10, mask: 0 });
  // build one block by hand: data then EC from the encoder's own generator (encode a 1-block version: v1 has 19 data + 7 EC)
  const T = Q._int.template(1), data = Uint8Array.from({ length: T.data }, (_, i) => (i * 37 + 5) & 255);
  const ecb = new Uint8Array(T.ec); { const { EXP, LOG } = Q._int; let g = [1]; for (let i = 0; i < T.ec; i++) { const r = new Array(g.length + 1).fill(0); g.forEach((c, j) => { r[j] ^= c; r[j + 1] ^= c ? EXP[LOG[c] + i] : 0; }); g = r; }
    const rr = new Uint8Array(T.ec); for (const d of data) { const f = d ^ rr[0]; rr.copyWithin(0, 1); rr[T.ec - 1] = 0; if (f) for (let j = 0; j < T.ec; j++) if (g[j + 1]) rr[j] ^= EXP[LOG[f] + LOG[g[j + 1]]]; } ecb.set(rr); }
  const good = Uint8Array.from([...data, ...ecb]);
  for (let e = 0; e <= 3; e++) { const w = good.slice(); for (let k = 0; k < e; k++) w[k * 7 + 1] ^= 0x5A + k; assert.ok(rsFix(w, T.ec), `fix ${e}`); assert.deepEqual(w, good); }
  const w = good.slice(); for (let k = 0; k < 5; k++) w[k * 4] ^= 0x33; assert.ok(!rsFix(w, T.ec) || !w.every((x, i) => x === good[i]) === false);
});
t('no code, no answer', () => { assert.deepEqual(R.read(picture(300, 300, [])), []); });

// ---- Replayable scenes: content and noise come from the seed, so a picture that once failed can be shown again bit for bit.
// Each seed below is a picture the reader missed before the fix named in its test (found by sweeping thousands of such scenes).
const prng = s => () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const CAM = { rot: 0.02, persp: 0.04, blur: 1, noise: 18, light: 0.25 }, ENTRY = 'https://yeerock.github.io/qrstream/receive/?go';
/** cols x rows stream codes of version v (module size s px) as the sender lays them out, optionally with the small entry code (2.2 px modules) below. */
function scene(cols, rows, v, seed, { s = 3.4, opt = CAM, entry = false } = {}) {
  const rnd = prng(seed * 7919 + v), n = v * 4 + 25, es = 2.2, eq = entry ? Q.encode(ENTRY) : null;
  const ts = Array.from({ length: cols * rows }, () => { const b = new Uint8Array(20000); for (let i = 0; i < b.length; i++) b[i] = rnd() * 256; return new Q.Stream(b, 5).next(v); });
  const W = Math.ceil(cols * n * s + 200), H = Math.ceil(rows * n * s + 160 + (entry ? (eq.size + 8) * es + 30 : 0));
  const codes = ts.map((x, i) => ({ q: Q.encode(x, { version: v, mask: 2 }), x: 100 + (i % cols) * n * s, y: 80 + Math.floor(i / cols) * n * s, s }));
  if (entry) { codes.push({ q: eq, x: 40, y: 80 + rows * n * s + 20, s: es }); ts.push(ENTRY); }
  return { pic: picture(W, H, codes, { ...opt, nseed: seed + 1 }), ts };
}
const HARD = { rot: 0.05, persp: 0.1, blur: 1, noise: 25, light: 0.35 }, SOFT = { blur: 1, noise: 10, light: 0.2 };
for (const [name, cols, rows, v, seed, o] of [
  ['2 stacked v25 (timing module shrunk to one pixel)', 1, 2, 25, 1157],
  ['2 stacked v22 (finder ring closed beside the quiet zone)', 1, 2, 22, 1002],
  ['2 stacked v30', 1, 2, 30, 1046],
  ['2 x 2 grid v19', 2, 2, 19, 1113],
  ['2 x 2 grid v24', 2, 2, 24, 1318],
  ['2 x 2 grid v33', 2, 2, 33, 1118],
  ['row of 2 v40', 2, 1, 40, 1015],
  ['row of 3 v22', 3, 1, 22, 1005],
  ['2 x 2 grid v25 plus the small entry code', 2, 2, 25, 1002, { entry: true }],
  ['2 stacked v33 plus the small entry code', 1, 2, 33, 1325, { entry: true }],
  ['2 x 2 grid v22, 3 px modules, harder camera (timing module swallowed whole)', 2, 2, 22, 1065, { s: 3, opt: HARD }],
  ['2 stacked v19, harder camera', 1, 2, 19, 1015, { opt: HARD }],
  ['v34 strong perspective (a misread version word ended the tries)', 1, 1, 34, 1074, { s: 4, opt: { rot: -0.08, persp: 0.18 } }],
  ['v40 at 2.5 px modules (below the 3 px floor)', 1, 1, 40, 1010, { s: 2.5, opt: {} }],
  ['v40 at 2.5 px modules, blur + noise (grey sampler, grey timing count)', 1, 1, 40, 1010, { s: 2.5, opt: SOFT }],
  ['v25 at 2.75 px modules, blur + noise (grey sampler)', 1, 1, 25, 1016, { s: 2.75, opt: SOFT }],
]) t(name, () => { const { pic, ts } = scene(cols, rows, v, seed, o); const got = R.read(pic, 5); assert.deepEqual(new Set(got), new Set(ts)); assert.equal(got.length, ts.length); });
t('entry code alone at 2.2 px modules, blur + noise', () => { const q = Q.encode(ENTRY); for (let k = 1; k <= 3; k++) assert.deepEqual(R.read(picture(300, 260, [{ q, x: 40, y: 40, s: 2.2 }], { ...CAM, nseed: k })), [ENTRY]); });
t('no code: noise and random blocks give no answer', () => {
  for (const [W, H, cell, seed] of [[640, 480, 1, 3], [640, 480, 3, 4], [960, 540, 5, 5], [640, 480, 9, 6]]) {
    const rnd = prng(seed), cw = Math.ceil(W / cell), cells = Uint8Array.from({ length: cw * Math.ceil(H / cell) }, () => rnd() < 0.5 ? 30 : 225), data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = cells[Math.floor(Math.floor(i / W) / cell) * cw + Math.floor((i % W) / cell)] + (rnd() - 0.5) * 20; data[i * 4 + 3] = 255; }
    assert.deepEqual(R.read({ data, width: W, height: H }, 5), [], `${W}x${H} cells of ${cell} px`);
  }
});
t('timing size: both lines agree on the true size', () => {
  const { binarize, finders, triples, timingDims } = R._;
  for (const [v, seed, o] of [[25, 1157, {}], [40, 1010, { s: 2.5, opt: SOFT }]]) { const { pic } = scene(1, 1, v, seed, o), bin = binarize(pic.data, pic.width, pic.height), tr = triples(finders(bin, pic.width, pic.height))[0];
    const d = timingDims(bin, pic.width, pic.height, tr), g = timingDims(bin, pic.width, pic.height, tr, true); assert.ok((d.agree && d[0] === v * 4 + 17) || (g.agree && g[0] === v * 4 + 17), `v${v}: binary ${d} agree ${d.agree}, grey ${g} agree ${g.agree}`); }
});
t('speed: v40 at 1280x720, 3 codes', () => {
  const ts = [frame(40), frame(40), frame(40)], pic = picture(1280, 720, ts.map((x, i) => ({ q: Q.encode(x, { version: 40, mask: 2 }), x: 30 + i * 410, y: 120, s: 2.2 })), {});
  const t0 = performance.now(); const r = R.read(pic); const ms = performance.now() - t0; console.log(`   ${r.length} codes in ${ms.toFixed(0)} ms`); assert.equal(r.length, 3);
});
// ---- colour frames: three codes in the red, green and blue channels of the same squares, through a colour camera
/** Three module sheets (one per channel) through the same geometry, then what a camera does to colour: each channel sees part of the other two (mix),
    a colour cast, noise of its own per channel, and colour kept at half resolution (4:2:0) while brightness stays full. */
function colourPicture(W, H, layers, opt, mix) {
  const ch = layers.map(codes => picture(W, H, codes, opt).data), out = new Uint8ClampedArray(W * H * 4), P = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
  const MX = [[1 - 1.6 * mix, 1.2 * mix, 0.4 * mix], [0.9 * mix, 1 - 1.7 * mix, 0.8 * mix], [0.3 * mix, 1.4 * mix, 1 - 1.7 * mix]], cast = [0.85, 1, 1.12]; let q = 5; const rn = () => (q = (Math.imul(q, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5;
  for (let i = 0; i < W * H; i++) { const v = [ch[0][i * 4], ch[1][i * 4], ch[2][i * 4]]; for (let c = 0; c < 3; c++) P[c][i] = cast[c] * (v[0] * MX[c][0] + v[1] * MX[c][1] + v[2] * MX[c][2]) + rn() * 20; }
  const U = new Float32Array(W * H), V = new Float32Array(W * H), Y = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { Y[i] = 0.299 * P[0][i] + 0.587 * P[1][i] + 0.114 * P[2][i]; U[i] = (P[2][i] - Y[i]) * 0.564; V[i] = (P[0][i] - Y[i]) * 0.713; }
  for (let y = 0; y < H - 1; y += 2) for (let x = 0; x < W - 1; x += 2) { const a = y * W + x, ids = [a, a + 1, a + W, a + W + 1], u = ids.reduce((t, k) => t + U[k], 0) / 4, v = ids.reduce((t, k) => t + V[k], 0) / 4; for (const k of ids) { U[k] = u; V[k] = v; } }
  for (let i = 0; i < W * H; i++) { out[i * 4] = Y[i] + 1.403 * V[i]; out[i * 4 + 1] = Y[i] - 0.344 * U[i] - 0.714 * V[i]; out[i * 4 + 2] = Y[i] + 1.773 * U[i]; out[i * 4 + 3] = 255; }
  return { data: out, width: W, height: H };
}
for (const [name, v, c, r, s, mix] of [['colour: one v40 square, 4 px modules', 40, 1, 1, 4, 0.15], ['colour: 2 by 2 grid of v25, 3.4 px, strong mixing', 25, 2, 2, 3.4, 0.25], ['colour: two rows of four v22 (24 codes in one picture), 4 px', 22, 4, 2, 4, 0.15]]) t(name, () => {
  const n = v * 4 + 25, W = Math.ceil(c * n * s + 200) & ~1, H = Math.ceil(r * n * s + 160) & ~1, texts = [0, 1, 2].map(() => Array.from({ length: c * r }, () => frame(v)));
  const place = ts => ts.map((x, i) => ({ q: Q.encode(x, { version: v, mask: 2 }), x: 100 + (i % c) * n * s, y: 80 + Math.floor(i / c) * n * s, s }));
  const got = new Set(R.read(colourPicture(W, H, texts.map(place), { rot: 0.02, persp: 0.04, blur: 1, noise: 18, light: 0.25 }, mix), 9));
  for (const x of texts.flat()) assert.ok(got.has(x), 'a code of the colour frame was not read'); assert.equal(got.size, 3 * c * r);
});
t('colour off: a colour frame gives nothing, and a black and white frame is still one text through the colour camera', () => {
  const v = 25, n = v * 4 + 25, s = 4, W = (n * s + 200) & ~1, a = frame(v), b = frame(v), c = frame(v), at = x => [{ q: Q.encode(x, { version: v, mask: 2 }), x: 100, y: 80, s }];
  assert.deepEqual(R.read(colourPicture(W, W, [at(a), at(b), at(c)], { blur: 1, noise: 18 }, 0.15), 5, { colour: false }), []);
  assert.deepEqual(R.read(colourPicture(W, W, [at(a), at(a), at(a)], { blur: 1, noise: 18 }, 0.15)), [a]);
});
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
