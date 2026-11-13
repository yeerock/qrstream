// Own camera simulator: turns module bitmaps (what the sender canvas holds) into camera pictures and writes them as a YUV4MPEG2 (.y4m) file,
// the raw format Chrome accepts as a fake camera (--use-file-for-fake-video-capture). Projective tilt, rotation, blur, sensor noise, uneven light.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
export function shoot(bm, W, H, o = {}) {
  const { fill = 0.9, rot = 0.02, persp = 0.04, blur = 1, noise = 18, light = 0.25, seed = 1 } = o;
  if (bm.c) return shootColour(bm, W, H, o);
  const k = Math.min(W * fill / bm.w, H * fill / bm.h), ox = (W - bm.w * k) / 2, oy = (H - bm.h * k) / 2, cx = W / 2, cy = H / 2;
  const c = Math.cos(-rot), s = Math.sin(-rot), g = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    let x = X + 0.5 - cx, y = Y + 0.5 - cy; const w = 1 + persp * (x / W); x /= w; y /= w;
    const u = x * c - y * s + cx, v = x * s + y * c + cy, mx = Math.floor((u - ox) / k), my = Math.floor((v - oy) / k);
    const dark = mx >= 0 && my >= 0 && mx < bm.w && my < bm.h && bm.b.charCodeAt(my * bm.w + mx) === 49;
    g[Y * W + X] = dark ? 35 : 220;
  }
  let src = g;
  for (let p = 0; p < blur; p++) { const o = Float32Array.from(src); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { let t = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) t += src[(y + dy) * W + x + dx]; o[y * W + x] = t / 9; } src = o; }
  const out = Buffer.alloc(W * H); let r = seed >>> 0 || 1;
  for (let i = 0; i < W * H; i++) { r = (Math.imul(r, 1103515245) + 12345) >>> 0; const v = src[i] * (1 - light * (i % W) / W) + (r / 4294967296 - 0.5) * noise; out[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
  return out;
}
/** A colour screen (bm.c: which channels are dark at each screen pixel) through a colour camera. Returns { y, u, v } planes in 4:2:0.
 *  What a camera does to colour, and black and white pictures do not show: each camera channel also sees part of the other two screen colours (mix, uneven:
 *  green leaks most), the white balance is off (cast), every channel has sensor noise of its own, and the video pipeline keeps brightness at full
 *  resolution but colour averaged over 2 x 2 pixels. */
function shootColour(bm, W, H, { fill = 0.9, rot = 0.02, persp = 0.04, blur = 1, noise = 18, light = 0.25, seed = 1, mix = 0.15 } = {}) {
  const k = Math.min(W * fill / bm.w, H * fill / bm.h), ox = (W - bm.w * k) / 2, oy = (H - bm.h * k) / 2, cx = W / 2, cy = H / 2, c = Math.cos(-rot), s = Math.sin(-rot);
  let ch = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    let x = X + 0.5 - cx, y = Y + 0.5 - cy; const w = 1 + persp * (x / W); x /= w; y /= w;
    const u = x * c - y * s + cx, v = x * s + y * c + cy, mx = Math.floor((u - ox) / k), my = Math.floor((v - oy) / k);
    const bits = mx >= 0 && my >= 0 && mx < bm.w && my < bm.h ? bm.c.charCodeAt(my * bm.w + mx) - 48 : 0, i = Y * W + X;
    for (let q = 0; q < 3; q++) ch[q][i] = bits >> q & 1 ? 35 : 220;
  }
  ch = ch.map(src => { for (let p = 0; p < blur; p++) { const o = Float32Array.from(src); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { let t = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) t += src[(y + dy) * W + x + dx]; o[y * W + x] = t / 9; } src = o; } return src; });
  const MX = [[1 - 1.6 * mix, 1.2 * mix, 0.4 * mix], [0.9 * mix, 1 - 1.7 * mix, 0.8 * mix], [0.3 * mix, 1.4 * mix, 1 - 1.7 * mix]], cast = [0.9, 1, 1.08];
  const y = Buffer.alloc(W * H), U = new Float32Array(W * H), V = new Float32Array(W * H); let r = seed >>> 0 || 1; const rn = () => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return (r / 4294967296 - 0.5) * noise; };
  for (let i = 0; i < W * H; i++) {
    const g = 1 - light * (i % W) / W, a = ch[0][i], b = ch[1][i], d = ch[2][i];
    const R = cast[0] * g * (a * MX[0][0] + b * MX[0][1] + d * MX[0][2]) + rn(), G = cast[1] * g * (a * MX[1][0] + b * MX[1][1] + d * MX[1][2]) + rn(), B = cast[2] * g * (a * MX[2][0] + b * MX[2][1] + d * MX[2][2]) + rn();
    const yy = 0.299 * R + 0.587 * G + 0.114 * B; y[i] = yy < 0 ? 0 : yy > 255 ? 255 : yy; U[i] = (B - yy) * 0.564 + 128; V[i] = (R - yy) * 0.713 + 128;
  }
  const u = Buffer.alloc(W * H / 4), v = Buffer.alloc(W * H / 4), cl = t => t < 0 ? 0 : t > 255 ? 255 : t;
  for (let Y = 0; Y < H; Y += 2) for (let X = 0; X < W; X += 2) { const a = Y * W + X, j = (Y / 2) * (W / 2) + X / 2; u[j] = cl((U[a] + U[a + 1] + U[a + W] + U[a + W + 1]) / 4); v[j] = cl((V[a] + V[a + 1] + V[a + W] + V[a + W + 1]) / 4); }
  return { y, u, v };
}
/** Frames -> .y4m (4:2:0). A frame is a brightness plane (colour left neutral) or { y, u, v } from a colour screen. */
export function writeY4M(file, W, H, fps, frames) {
  // 4:2:0 halves both sides: an odd size or a short frame gives a file Chrome plays as garbage, with no error anywhere
  if (!(W > 0 && H > 0) || W % 2 || H % 2) throw new Error(`writeY4M: the picture size must be even, got ${W}x${H}`);
  const fd = fs.openSync(file, 'w'), chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  let n = 0, ok = false;   // frames may be any iterable (an array, a generator); each is checked as it is written
  try {
    fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
    for (const f of frames) { const y = f.y || f; if (y.byteLength !== W * H) throw new Error(`writeY4M: frame ${n} holds ${y.byteLength} bytes, ${W}x${H} needs ${W * H}`); fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, y); if (f.y) { fs.writeSync(fd, f.u); fs.writeSync(fd, f.v); } else fs.writeSync(fd, chroma); n++; }
    if (!n) throw new Error('writeY4M: no frames');
    ok = true;
  } finally { fs.closeSync(fd); if (!ok) fs.rmSync(file, { force: true }); }
}
/** A place for one camera feed, in a folder of its own: runs at the same time, and two feeds of one run, never share a file name.
 *  Returns { file, remove() }. Feeds are 1.4 MB a picture at 1280x720, so whatever is still there when the process ends is removed too. */
const feeds = new Set(); let hooked = false;
export function feedFile(name = 'feed') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-cam-')), rm = () => { feeds.delete(rm); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } };
  feeds.add(rm); if (!hooked) { hooked = true; process.on('exit', () => { for (const f of [...feeds]) f(); }); }
  return { file: path.join(dir, name + '.y4m'), remove: rm };
}
