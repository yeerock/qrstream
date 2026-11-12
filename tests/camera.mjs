// Own camera simulator: turns module bitmaps (what the sender canvas holds) into camera pictures and writes them as a YUV4MPEG2 (.y4m) file,
// the raw format Chrome accepts as a fake camera (--use-file-for-fake-video-capture). Projective tilt, rotation, blur, sensor noise, uneven light.
import fs from 'node:fs';
export function shoot(bm, W, H, { fill = 0.9, rot = 0.02, persp = 0.04, blur = 1, noise = 18, light = 0.25, seed = 1 } = {}) {
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
/** Luma frames -> .y4m (4:2:0, neutral chroma). */
export function writeY4M(file, W, H, fps, frames) {
  const fd = fs.openSync(file, 'w'), chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
  for (const y of frames) { fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, y); fs.writeSync(fd, chroma); }
  fs.closeSync(fd);
}
