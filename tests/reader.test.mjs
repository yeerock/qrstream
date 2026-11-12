// Own QR reader against own encoder: synthetic camera pictures (scale, rotation, perspective, blur, noise, uneven light,
// several codes per picture, damaged modules). Run: node tests/reader.test.mjs
import { createRequire } from 'node:module'; import assert from 'node:assert/strict'; import { randomBytes } from 'node:crypto';
const req = createRequire(import.meta.url), Q = req('../core/qrtx.js'), R = req('../core/qrread.js');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } };

/** Render codes (each {q, x, y, s}: module size s px) into an RGBA picture through a projective warp, then blur, light gradient and noise. */
function picture(W, H, codes, { rot = 0, persp = 0, blur = 0, noise = 0, light = 0, flip = [] } = {}) {
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
  const data = new Uint8ClampedArray(W * H * 4); let seed = 1; const rnd = () => (seed = seed * 1103515245 + 12345 >>> 0) / 4294967296;
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
t('speed: v40 at 1280x720, 3 codes', () => {
  const ts = [frame(40), frame(40), frame(40)], pic = picture(1280, 720, ts.map((x, i) => ({ q: Q.encode(x, { version: 40, mask: 2 }), x: 30 + i * 410, y: 120, s: 2.2 })), {});
  const t0 = performance.now(); const r = R.read(pic); const ms = performance.now() - t0; console.log(`   ${r.length} codes in ${ms.toFixed(0)} ms`); assert.equal(r.length, 3);
});
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
