'use strict';
/* QRStream core: one file, the same bytes on both ends (sender page and receiver page). A file becomes an endless one-way stream of QR frames; the receiver needs any set of frames slightly bigger than the file. No network.
   - QR Model 2 encoder, ISO/IEC 18004: alphanumeric mode, error level L, versions 1-40.
   - Base45, RFC 9285: QR alphanumeric mode carries 2 bytes in 3 characters (2864 bytes in version 40, against 2953 in byte mode, 3 % less), and every reader returns it intact as text.
     Byte mode comes back through text decoding on some readers and loses bytes.
   - Erasure code: systematic random linear fountain over GF(2) in generations of 1024 blocks, Gauss-Jordan decoding (see blocksOf). The first K symbols are the file
     itself. A missed frame never has to come round again, and any set of symbols a few percent larger than the file rebuilds it.
   - Frame = header + n symbols of SYMBOL bytes. The symbol size does not depend on the QR version, so changing the density on the screen keeps what the phone already holds. */
(function (root, factory) { const m = factory(); if (typeof module !== 'undefined' && module.exports) module.exports = m; else root.QRTX = m; })(typeof self !== 'undefined' ? self : this, () => {
  const SYMBOL = 142, HEADER = 20, MAGIC0 = 0xA5, MAGIC1 = 0x51, VER = 3, GEN = 1024;
  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:', A_IDX = Object.fromEntries([...ALNUM].map((c, i) => [c, i]));

  // ---- GF(256) and Reed-Solomon (ISO/IEC 18004 7.5, polynomial 0x11D)
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gens = {};
  function generator(n) {
    if (gens[n]) return gens[n];
    let g = [1];
    for (let i = 0; i < n; i++) { const r = new Array(g.length + 1).fill(0); g.forEach((c, j) => { r[j] ^= c; r[j + 1] ^= c ? EXP[LOG[c] + i] : 0; }); g = r; }
    return (gens[n] = Uint8Array.from(g));
  }
  function rs(data, off, len, n, out, at) {
    const g = generator(n), r = new Uint8Array(n);
    for (let i = 0; i < len; i++) {
      const f = data[off + i] ^ r[0];
      r.copyWithin(0, 1); r[n - 1] = 0;
      if (f) { const lf = LOG[f]; for (let j = 0; j < n; j++) { const c = g[j + 1]; if (c) r[j] ^= EXP[lf + LOG[c]]; } }
    }
    out.set(r, at);
  }

  // ---- symbol layout. Table 9 of the standard, level L
  const EC_L = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  const BLOCKS_L = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
  function alignPos(v) {
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2, size = v * 4 + 17, step = v === 32 ? 26 : Math.ceil((size - 13) / (2 * n - 2)) * 2, p = [6];
    for (let i = 0, x = size - 7; i < n - 1; i++, x -= step) p.splice(1, 0, x);
    return p;
  }
  /** BCH code word of v: v followed by the remainder of division by poly. */
  const bch = (v, poly) => { const d = 31 - Math.clz32(poly); let r = v << d; for (let i = 31 - Math.clz32(r); i >= d; i--) if (r >>> i & 1) r ^= poly << (i - d); return (v << d) | r; };
  const tpl = {};
  /** The frame of one version: fn[i] = 1 for a function module, base[i] its colour, path = the data modules in placement order. */
  function template(v) {
    if (tpl[v]) return tpl[v];
    const size = v * 4 + 17, fn = new Uint8Array(size * size), base = new Uint8Array(size * size);
    const set = (x, y, on) => { const i = y * size + x; fn[i] = 1; base[i] = on ? 1 : 0; };
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4);
    }
    for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
    const ap = alignPos(v);
    ap.forEach((ax, a) => ap.forEach((ay, b) => {
      if ((a === 0 && b === 0) || (a === 0 && b === ap.length - 1) || (a === ap.length - 1 && b === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    for (let i = 0; i < 9; i++) if (i !== 6) { fn[8 * size + i] = 1; fn[i * size + 8] = 1; }
    for (let i = 0; i < 8; i++) { fn[8 * size + size - 1 - i] = 1; fn[(size - 1 - i) * size + 8] = 1; }
    set(8, size - 8, 1);
    if (v >= 7) { const w = bch(v, 0x1F25); for (let i = 0; i < 18; i++) { const b = w >>> i & 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, b); set(c, a, b); } }
    const path = [];
    let up = true;
    for (let x = size - 1; x > 0; x -= 2) {
      if (x === 6) x--;
      for (let k = 0; k < size; k++) { const y = up ? size - 1 - k : k; for (const c of [x, x - 1]) if (!fn[y * size + c]) path.push(y * size + c); }
      up = !up;
    }
    const ec = EC_L[v - 1], blocks = BLOCKS_L[v - 1], total = path.length >> 3, data = total - ec * blocks;
    return (tpl[v] = { v, size, fn, base, path: Uint32Array.from(path), total, data, ec, blocks });
  }
  const countBits = v => v < 10 ? 9 : v < 27 ? 11 : 13;
  /** The most alphanumeric characters version v holds at level L. */
  function capacity(v) { const t = template(v), bits = t.data * 8 - 4 - countBits(v), r = bits % 11; return Math.floor(bits / 11) * 2 + (r >= 6 ? 1 : 0); }

  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0, (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const maskMaps = {};
  function maskMap(v, m) {
    const k = v + '.' + m; if (maskMaps[k]) return maskMaps[k];
    const t = template(v), a = new Uint8Array(t.size * t.size), f = MASKS[m];
    for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) if (f(x, y)) a[y * t.size + x] = 1;
    return (maskMaps[k] = a);
  }
  /** Standard penalty rules 7.8.3, used for the entry code. Stream frames are random data and take one fixed mask, which keeps a frame under a few ms. */
  function penalty(m, n) {
    let s = 0, dark = 0;
    for (let a = 0; a < 2; a++) for (let i = 0; i < n; i++) {
      let run = 0, last = -1, w = 0;
      for (let j = 0; j < n; j++) {
        const c = a ? m[j * n + i] : m[i * n + j]; w = ((w << 1) | c) & 0x7FF;
        if (c === last) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else { run = 1; last = c; }
        if (j >= 10 && (w === 0b10111010000 || w === 0b00001011101)) s += 40;
      }
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const c = m[y * n + x]; dark += c;
      if (x < n - 1 && y < n - 1 && c === m[y * n + x + 1] && c === m[(y + 1) * n + x] && c === m[(y + 1) * n + x + 1]) s += 3;
    }
    return s + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  }
  /** text (alphanumeric characters only) -> {size, m: Uint8Array size*size, 1 = dark}. mask 0-7, or -1 for the best by the penalty rules. Smallest version that fits, or `version` when given. */
  function encode(text, opt = {}) {
    const alnum = [...text].every(c => A_IDX[c] !== undefined);
    if (!alnum && !/^[\x20-\x7e]*$/.test(text)) throw new Error('This character cannot go in the code.');
    const fits = x => alnum ? capacity(x) >= text.length : template(x).data * 8 - 4 - (x < 10 ? 8 : 16) >= text.length * 8;
    let v = opt.version || 0;
    if (!v) { for (v = 1; v <= 40 && !fits(v); v++); }
    if (v > 40 || !fits(v)) throw new Error('Too much data for one QR code.');
    const t = template(v), d = new Uint8Array(t.data); let bit = 0;
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--, bit++) if (val >>> i & 1) d[bit >> 3] |= 0x80 >> (bit & 7); };
    if (alnum) {
      put(2, 4); put(text.length, countBits(v));
      for (let i = 0; i + 1 < text.length; i += 2) put(A_IDX[text[i]] * 45 + A_IDX[text[i + 1]], 11);
      if (text.length % 2) put(A_IDX[text[text.length - 1]], 6);
    } else {   // byte mode: an address with lower case letters, the one case that needs it
      put(4, 4); put(text.length, v < 10 ? 8 : 16);
      for (let i = 0; i < text.length; i++) put(text.charCodeAt(i), 8);
    }
    put(0, Math.min(4, t.data * 8 - bit)); bit = (bit + 7) & ~7;
    for (let p = bit >> 3, b = 0xEC; p < t.data; p++, b ^= 0xEC ^ 0x11) d[p] = b;
    // blocks and interleaving, 7.6
    const words = new Uint8Array(t.total), nShort = t.blocks - t.data % t.blocks, sLen = Math.floor(t.data / t.blocks), ecAll = new Uint8Array(t.ec * t.blocks), starts = [];
    for (let b = 0, off = 0; b < t.blocks; b++) { const l = sLen + (b < nShort ? 0 : 1); starts.push(off); rs(d, off, l, t.ec, ecAll, b * t.ec); off += l; }
    let w = 0;
    for (let i = 0; i < sLen; i++) for (let b = 0; b < t.blocks; b++) words[w++] = d[starts[b] + i];
    for (let b = nShort; b < t.blocks; b++) words[w++] = d[starts[b] + sLen];
    for (let i = 0; i < t.ec; i++) for (let b = 0; b < t.blocks; b++) words[w++] = ecAll[b * t.ec + i];
    const build = mask => {
      const m = t.base.slice(), map = maskMap(v, mask), p = t.path, size = t.size;
      for (let i = 0; i < p.length; i++) { const on = (i >> 3) < t.total && (words[i >> 3] >>> (7 - (i & 7)) & 1); m[p[i]] = (on ^ map[p[i]]) & 1; }
      const f = (bch(1 << 3 | mask, 0x537) ^ 0x5412) >>> 0;   // level L = 01
      const fb = i => f >>> i & 1;
      for (let i = 0; i <= 5; i++) m[i * size + 8] = fb(i);
      m[7 * size + 8] = fb(6); m[8 * size + 8] = fb(7); m[8 * size + 7] = fb(8);
      for (let i = 9; i < 15; i++) m[8 * size + 14 - i] = fb(i);
      for (let i = 0; i < 8; i++) m[8 * size + size - 1 - i] = fb(i);
      for (let i = 8; i < 15; i++) m[(size - 15 + i) * size + 8] = fb(i);
      return m;
    };
    let mask = opt.mask ?? -1, best = null;
    if (mask >= 0) best = build(mask);
    else { let low = Infinity; for (let i = 0; i < 8; i++) { const m = build(i), s = penalty(m, t.size); if (s < low) { low = s; best = m; } } }
    return { size: t.size, version: v, m: best };
  }

  // ---- Base45, RFC 9285
  function b45enc(b) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) { let n = b[i] * 256 + b[i + 1]; const c = n % 45; n = (n - c) / 45; const e = n % 45; s += ALNUM[c] + ALNUM[e] + ALNUM[(n - e) / 45]; }
    if (b.length % 2) { const n = b[b.length - 1]; s += ALNUM[n % 45] + ALNUM[Math.floor(n / 45)]; }
    return s;
  }
  function b45dec(s) {
    const n = s.length, r = n % 3; if (r === 1) return null;
    const out = new Uint8Array(Math.floor(n / 3) * 2 + (r ? 1 : 0)); let o = 0;
    for (let i = 0; i < n; i += 3) {
      const c = A_IDX[s[i]], d = A_IDX[s[i + 1]], e = i + 2 < n ? A_IDX[s[i + 2]] : undefined;
      if (c === undefined || d === undefined) return null;
      if (i + 2 < n) { if (e === undefined) return null; const v = c + d * 45 + e * 2025; if (v > 65535) return null; out[o++] = v >> 8; out[o++] = v & 255; } else { const v = c + d * 45; if (v > 255) return null; out[o++] = v; }
    }
    return out;
  }

  // ---- CRC-32 (IEEE 802.3) of every frame: a code misread into another valid code never reaches the file
  const CRC = Int32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) if (i < 16 || i >= 20) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }   // bytes 16-19 hold the CRC itself

  // ---- Erasure code: systematic, generation-based random linear code over GF(2).
  // Seeds 0..K-1 are the file blocks themselves, in interleaved order. A repair seed belongs to one generation (GEN consecutive blocks; chosen in proportion to generation size) and is the XOR of a
  // pseudo-random half of that generation's blocks. A generation of g blocks decodes, by Gauss-Jordan elimination, from about g + 2 of its symbols
  // (random GF(2) matrices: rank deficiency falls by half per extra row), so the overhead is a few symbols per generation, whatever the frame loss.
  // Same family as random linear network coding (Ho et al., IEEE Trans. Inf. Theory 52(10), 2006) and generation coding (Chou, Wu, Jain, Allerton 2003).
  // Row bits come from a non-linear hash (MurmurHash3 fmix32, multiplications), never from a GF(2)-linear generator such as xorshift:
  // rows made by a linear generator span at most 32 dimensions, and elimination could never reach full rank.
  const fmix = h => { h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16; return h >>> 0; };
  const rng = s => { let i = 0; const k = fmix(Math.imul(s + 1, 0x9E3779B1) ^ 0x5BD1E995); return () => fmix(k + Math.imul(++i, 0x27D4EB2F)); };
  /** Generation of a block, and its first block and size. */
  const genOf = b => Math.floor(b / GEN), genSpan = (g, K) => [g * GEN, Math.min(K, (g + 1) * GEN) - g * GEN];
  // Source seeds are interleaved with a stride coprime to K: one lost frame (consecutive seeds) then costs every generation a little, instead of one generation a lot.
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; }, strides = new Map();
  function stride(K) { let p = strides.get(K); if (p) return p; p = Math.min(GEN, K) + 1; if (K < 3) p = 1; else while (gcd(p, K) !== 1) p++; strides.set(K, p); return p; }
  /** Source block indexes of the symbol with this seed (all in one generation). */
  function blocksOf(seed, K) {
    if (seed < K) return [Number(BigInt(seed) * BigInt(stride(K)) % BigInt(K))];
    const g = genOf(Number(BigInt(seed - K) * BigInt(stride(K)) % BigInt(K))), [first, n] = genSpan(g, K), r = rng(seed), out = [];   // repairs go to generations in proportion to their size
    for (let i = 0; i < n; i += 32) { const w = r(); for (let j = 0; j < 32 && i + j < n; j++) if (w >>> j & 1) out.push(first + i + j); }
    if (!out.length) out.push(first + r() % n);
    return out;
  }
  const first = set => { for (const b of set) return b; };
  const blockCount = len => Math.ceil(len / SYMBOL);

  /** Most symbols per frame in version v. */
  function symbolsIn(v) { const bytes = Math.floor((capacity(v) - 1) / 3) * 2; return Math.floor((bytes - HEADER) / SYMBOL); }

  /** Sender: one transfer. frame(n) gives the text of the code that starts at seed n. */
  class Stream {
    constructor(bytes, id) { this.b = bytes; this.len = bytes.length; this.K = blockCount(this.len); this.id = id >>> 0; this.seed = 0; }
    next(v) {
      const n = symbolsIn(v), out = new Uint8Array(HEADER + n * SYMBOL), dv = new DataView(out.buffer), seed = this.seed;
      out[0] = MAGIC0; out[1] = MAGIC1; out[2] = VER; dv.setUint32(4, this.id); dv.setUint32(8, this.len); dv.setUint32(12, seed);
      for (let i = 0; i < n; i++) {
        const at = HEADER + i * SYMBOL;
        for (const b of blocksOf(seed + i, this.K)) { const s = b * SYMBOL, e = Math.min(this.len, s + SYMBOL); for (let j = s; j < e; j++) out[at + j - s] ^= this.b[j]; }
      }
      dv.setUint32(16, crc32(out));
      this.seed += n;
      return b45enc(out) + '/';   // the end mark keeps a trailing space from being trimmed by a reader
    }
  }

  /** Text read by a scanner -> {id, len, seed, n, bytes, at} or null when it is not one of our frames. */
  function parseFrame(text) {
    if (typeof text !== 'string' || text.length < 30 || text[text.length - 1] !== '/') return null;
    const b = b45dec(text.slice(0, -1));
    if (!b || b.length < HEADER + SYMBOL || b[0] !== MAGIC0 || b[1] !== MAGIC1 || b[2] !== VER || (b.length - HEADER) % SYMBOL) return null;
    const dv = new DataView(b.buffer, b.byteOffset);
    if (dv.getUint32(16) !== crc32(b)) return null;
    return { id: dv.getUint32(4), len: dv.getUint32(8), seed: dv.getUint32(12), n: (b.length - HEADER) / SYMBOL, bytes: b };
  }

  /** Receiver: peeling decoder. add() takes one parsed frame; done when every block is known. */
  class Collector {
    constructor(id, len) { this.id = id; this.len = len; this.K = blockCount(len); this.out = new Uint8Array(this.K * SYMBOL); this.known = new Uint8Array(this.K); this.solved = 0; this.seen = new Set(); this.waiting = new Map(); this.frames = 0; this.pend = new Map(); this.unk = Array.from({ length: Math.ceil(this.K / GEN) }, (_, g) => genSpan(g, this.K)[1]); this.dirty = new Set(); this.tried = new Map(); }
    get done() { return this.solved === this.K; }
    /** Share of the file already held, for the bar. Fountain symbols solve late, so symbols seen count too (about 5 % more than the file are needed). */
    get progress() { return this.done ? 1 : Math.min(0.99, Math.max(this.solved / this.K, this.rank / this.K)); }
    /** Blocks solved plus, per generation, the equations waiting for elimination (each adds one unknown's worth until full rank): what the bar shows. */
    get rank() { let r = this.solved; for (const [g, e] of this.pend) r += Math.min(e.length, this.unk[g]); return r; }
    add(f) {
      if (f.id !== this.id || f.len !== this.len) return 0;
      this.frames++; let fresh = 0;
      for (let i = 0; i < f.n; i++) {
        const seed = f.seed + i; if (this.seen.has(seed)) continue;
        this.seen.add(seed); fresh++;
        this._symbol(seed, f.bytes.slice(HEADER + i * SYMBOL, HEADER + (i + 1) * SYMBOL));
      }
      for (const g of this.dirty) this._gauss(g); this.dirty.clear();
      return fresh;
    }
    _xor(d, b) { const s = b * SYMBOL, o = this.out; for (let j = 0; j < SYMBOL; j++) d[j] ^= o[s + j]; }
    _symbol(seed, data) {
      const open = new Set();
      for (const b of blocksOf(seed, this.K)) { if (this.known[b]) this._xor(data, b); else open.add(b); }
      if (!open.size) return;
      if (open.size === 1) { this._solve([...open][0], data); return; }
      const eq = { open, data }, g = genOf(first(open));
      for (const b of open) { let l = this.waiting.get(b); if (!l) this.waiting.set(b, l = []); l.push(eq); }
      let l = this.pend.get(g); if (!l) { l = []; this.pend.set(g, l); } l.push(eq); this.dirty.add(g);
    }
    _solve(first, data) {
      const todo = [[first, data]];
      while (todo.length) {
        const [b, d] = todo.pop(); if (this.known[b]) continue;
        this.out.set(d, b * SYMBOL); this.known[b] = 1; this.solved++; this.unk[genOf(b)]--;
        const l = this.waiting.get(b); if (!l) continue;
        this.waiting.delete(b);
        for (const eq of l) {
          if (!eq.open.has(b)) continue;
          this._xor(eq.data, b); eq.open.delete(b);
          if (eq.open.size === 1) { todo.push([[...eq.open][0], eq.data]); }
        }
      }
    }
    /** Gauss-Jordan elimination over GF(2) in one generation: rows are the waiting equations (bit sets over its unsolved blocks).
        Runs when the generation holds at least as many equations as unknowns; full rank solves the whole generation at once. */
    _gauss(g) {
      const eqs = (this.pend.get(g) || []).filter(e => e.open.size > 1); this.pend.set(g, eqs);
      const [f0, n] = genSpan(g, this.K); let u = 0; const col = new Int32Array(n).fill(-1), blk = [];
      for (let i = 0; i < n; i++) if (!this.known[f0 + i]) { col[i] = u++; blk.push(f0 + i); }
      if (!u) { this.pend.delete(g); return; }
      if (eqs.length < u + 1 || eqs.length <= (this.tried.get(g) || 0)) return;   // one spare row: most attempts then succeed; never retry with no new row
      this.tried.set(g, eqs.length);
      const W = (u + 31) >>> 5, rows = eqs.map(e => { const bits = new Uint32Array(W); for (const b of e.open) { const c = col[b - f0]; bits[c >>> 5] |= 1 << (c & 31); } return { bits, data: e.data.slice() }; });
      const piv = new Int32Array(u); let rank = 0;
      for (let c = 0; c < u; c++) {
        const w = c >>> 5, m = 1 << (c & 31); let r = rank;
        while (r < rows.length && !(rows[r].bits[w] & m)) r++;
        if (r === rows.length) return;   // short of rank: wait for more symbols of this generation
        const p = rows[r]; rows[r] = rows[rank]; rows[rank] = p;
        for (let i = 0; i < rows.length; i++) if (i !== rank && rows[i].bits[w] & m) { const a = rows[i].bits, d = rows[i].data; for (let k = w; k < W; k++) a[k] ^= p.bits[k]; for (let k = 0; k < SYMBOL; k++) d[k] ^= p.data[k]; }
        piv[c] = rank++;
      }
      for (let c = 0; c < u; c++) this._solve(blk[c], rows[piv[c]].data);
      this.pend.delete(g);
    }
    bytes() { return this.out.subarray(0, this.len); }
  }

  // ---- what travels: [u16 length of the JSON][JSON name, mime, kind, sha256, title, at][file bytes]
  function pack(meta, file) {
    const j = new TextEncoder().encode(JSON.stringify(meta));
    if (j.length > 2000) throw new Error('Name too long.');
    const out = new Uint8Array(2 + j.length + file.length);
    out[0] = j.length >> 8; out[1] = j.length & 255; out.set(j, 2); out.set(file, 2 + j.length);
    return out;
  }
  function unpack(b) {
    const n = b[0] * 256 + b[1];
    if (n === 0 || 2 + n > b.length) return null;
    try { return { meta: JSON.parse(new TextDecoder().decode(b.subarray(2, 2 + n))), file: b.subarray(2 + n) }; } catch (e) { return null; }
  }
  return { _int: { template, maskMap, bch, EXP, LOG, EC_L, BLOCKS_L, ALNUM, alignPos, countBits }, GEN, encode, capacity, symbolsIn, Stream, Collector, parseFrame, pack, unpack, b45enc, b45dec, blocksOf, blockCount, SYMBOL, HEADER };
});
