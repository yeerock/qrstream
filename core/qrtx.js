'use strict';
/* QRStream core: one file, the same bytes on both ends (sender page and receiver page). A file becomes an endless one-way stream of QR frames; the receiver needs any set of frames slightly bigger than the file. No network.
   - QR Model 2 encoder, ISO/IEC 18004: alphanumeric mode, error level L, versions 1-40.
   - Base45, RFC 9285: QR alphanumeric mode carries 2 bytes in 3 characters (2864 bytes in version 40, against 2953 in byte mode, 3 % less), and every reader returns it intact as text.
     Byte mode comes back through text decoding on some readers and loses bytes.
   - Erasure code: systematic random linear fountain over GF(2) in generations of 1024 blocks, Gauss-Jordan decoding (see blocksOf). The first K symbols are the file
     itself. A missed frame never has to come round again, and any set of symbols a few percent larger than the file rebuilds it.
   - Frame = header + n symbols of SYMBOL bytes. The symbol size does not depend on the QR version, so changing the density on the screen keeps what the phone already holds.
   - Repair of damage: a wrong symbol that passes the frame CRC (a rare misread, or a forged frame from another screen) must not cost the whole transfer. The decoder checks
     every symbol that adds nothing against what it holds (Collector, sus), the sender seals the metadata with CRC-32 values of consecutive chunks of the body (seal),
     and after a failed check the receiver forgets only the blocks of the chunks that fail (damaged, Collector.repair). None of this is authentication: whoever sees the
     screen can forge a stream that passes every check except being the right file; the SHA-256 and the check code on both screens stay the proof. */
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
  /** Plain CRC-32 of bytes from..to (to not included): the chunk checks of the body and the seal of the metadata. The frame CRC above is a different sum (it skips its own field). */
  function crc32of(b, from = 0, to = b.length) { let c = -1; for (let i = from; i < to; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

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

  /** Receiver. add() takes one parsed frame; done when every block is known.
      Each generation keeps its repair symbols as an echelon basis over GF(2): a new symbol is reduced against the rows already held, then either becomes the
      pivot row of one more block or turns out to add nothing and is dropped. So a generation of n blocks never holds more than n rows (272 bytes each, in one array),
      however many symbols arrive, and each symbol costs one reduction: there is no growing list of equations and no repeated elimination.
      When pivots plus known blocks cover the generation, one back-substitution solves it.
      Consistency: a symbol that adds nothing must agree with what is held (a repair symbol reduced to no blocks must have reduced to zero data; a source symbol of a known
      block must equal that block). When it does not, one of the two is wrong and nothing here can say which: the new symbol is not used, and sus[g] counts the event.
      One case is settled at once: a disputed block of a generation that has not used a repair symbol yet. Nothing depends on that block, so it alone is forgotten (neither
      content is trusted) and one later repair symbol restores it. In every other case the generation is left as it is until the final check, where the sender's chunk checks
      name the damaged blocks exactly (repair); forgetting the whole generation on the spot was measured and costs more, because of what a refill costs:
      a generation receives one repair symbol in every G of the stream (G = number of generations), so u forgotten blocks need about (u + 2) x G more symbols. A whole
      generation therefore takes about as long as the whole file took, whatever the file size; only a part of one is quick. forget() and forgetBlocks() cost no memory:
      the blocks go back to unknown and the generation's rows are freed, so the bound of one row per block stays. */
  const MAX_STREAM = 64 * 1048576, DW = Math.ceil(SYMBOL / 4);
  class Collector {
    constructor(id, len) {
      if (!(len >= 1 && len <= MAX_STREAM)) throw new RangeError('stream length');
      this.id = id; this.len = len; this.K = blockCount(len); this.out = new Uint8Array(this.K * SYMBOL); this.known = new Uint8Array(this.K); this.solved = 0; this.pivots = 0; this.frames = 0; this.symbols = 0;
      const ng = Math.ceil(this.K / GEN); this.sus = new Uint32Array(ng); this.redo = new Uint32Array(ng); this.mark = new Uint32Array(ng); this.flags = 0; this.lost = 0; this.metaTries = 0;   // inconsistencies seen, times forgotten (per generation); totals
      this.td = new Uint32Array(DW); this.t8 = new Uint8Array(this.td.buffer, 0, SYMBOL); this.tb = new Uint32Array((GEN + 31) >>> 5);   // the working row
      this.gens = new Array(Math.ceil(this.K / GEN)).fill(null); this.unk = this.gens.map((_, g) => genSpan(g, this.K)[1]);
    }
    get done() { return this.solved === this.K; }
    /** Blocks solved plus pivot rows held (each is one more block once its generation completes): what the bar shows. */
    get rank() { return this.solved + this.pivots; }
    get progress() { return this.done ? 1 : Math.min(0.99, this.rank / this.K); }
    /** Returns how much closer to complete this frame brought the file, in blocks. */
    add(f) {
      if (f.id !== this.id || f.len !== this.len) return 0;
      this.frames++; const before = this.rank;
      this.symbols += f.n;
      for (let i = 0; i < f.n; i++) this._symbol((f.seed + i) >>> 0, f.bytes, HEADER + i * SYMBOL);
      return this.rank - before;
    }
    _xor(d, b) { const s = b * SYMBOL, o = this.out; for (let j = 0; j < SYMBOL; j++) d[j] ^= o[s + j]; }
    /** A generation's storage: one slot per block (its pivot row: bit set over the generation, then the symbol data), allocated once, on its first repair symbol. */
    _gen(g) {
      let G = this.gens[g]; if (G) return G;
      const [f0, n] = genSpan(g, this.K), W = (n + 31) >>> 5;
      return this.gens[g] = { g, f0, n, W, has: new Uint8Array(n), bits: new Uint32Array(n * W), d32: new Uint32Array(n * DW), np: 0 };
    }
    _symbol(seed, src, at) {
      const bl = blocksOf(seed, this.K), g = genOf(bl[0]);
      if (bl.length === 1) {
        const b = bl[0]; if (!this.known[b]) { this._solve(b, src.subarray(at, at + SYMBOL)); return; }
        const o = this.out, s = b * SYMBOL; for (let j = 0; j < SYMBOL; j++) if (o[s + j] !== src[at + j]) { this._flag(g, b); break; }   // the same block with other content
        return;
      }
      if (!this.unk[g]) return;   // this generation is complete
      const G = this._gen(g), bits = this.tb.fill(0), d8 = this.t8; this.td.fill(0); d8.set(src.subarray(at, at + SYMBOL));
      for (const b of bl) { if (this.known[b]) this._xor(d8, b); else { const c = b - G.f0; bits[c >>> 5] |= 1 << (c & 31); } }
      this._insert(G);
    }
    /** Reduce the working row (this.tb bits, this.td data) against the basis; store it as a new pivot or drop it when nothing is left. */
    _insert(G) {
      const bits = this.tb, d = this.td, W = G.W, GB = G.bits, GD = G.d32;
      for (let w = 0; w < W; w++) while (bits[w]) {
        const low = bits[w] & -bits[w], c = (w << 5) + 31 - Math.clz32(low), b = G.f0 + c;
        if (this.known[b]) { this._xor(this.t8, b); bits[w] ^= low; continue; }   // a block solved since this bit was set
        const pb = c * W, pd = c * DW;
        if (!G.has[c]) {
          for (let k = 0; k < W; k++) GB[pb + k] = bits[k]; for (let k = 0; k < DW; k++) GD[pd + k] = d[k];
          G.has[c] = 1; G.np++; this.pivots++;
          if (G.np === this.unk[G.g]) { this._finish(G); return; }
          let one = (bits[w] ^ low) === 0; for (let k = w + 1; one && k < W; k++) if (bits[k]) one = false;
          if (one) this._solve(b, this.t8);   // the row names a single block: that block is known now
          return;
        }
        for (let k = w; k < W; k++) bits[k] ^= GB[pb + k];
        for (let k = 0; k < DW; k++) d[k] ^= GD[pd + k];
      }
      for (let k = 0; k < DW; k++) if (d[k]) { this._flag(G.g, -1); return; }   // nothing new, so the data must have cancelled too
    }
    /** An inconsistency in generation g (b = the disputed block of a source symbol, or -1). See the class comment for what is forgotten and why. */
    _flag(g, b) { this.sus[g]++; this.flags++; if (b >= 0 && this.unk[g] && !this.gens[g]) this.forgetBlocks([[b, b]], this.frames); }   // one frame with 20 disputed symbols is one event, not 20
    /** Blocks first..last of each [first, last] pair become unknown again and the stream refills them; every other block is kept. The rows of a touched generation
        are dropped too (they were reduced with blocks that are now in doubt). Returns how far the rank fell; lost adds these up, redo[g] counts the times per generation. */
    forgetBlocks(ranges, frame = 0) {
      let n = 0; const seen = new Set();
      for (const [a, e] of ranges) for (let b = Math.max(0, a), end = Math.min(e, this.K - 1); b <= end; b++) {
        const g = genOf(b);
        if (!seen.has(g)) { seen.add(g); if (!frame || this.mark[g] !== frame) { this.redo[g]++; if (frame) this.mark[g] = frame; } const G = this.gens[g]; if (G) { n += G.np; this.pivots -= G.np; this.gens[g] = null; } }
        if (this.known[b]) { this.known[b] = 0; this.solved--; this.unk[g]++; n++; }
      }
      this.lost += n; return n;
    }
    /** Forget whole generations (a list of generation numbers). */
    forget(gens) { return this.forgetBlocks([...gens].map(g => { const [f, n] = genSpan(g, this.K); return [f, f + n - 1]; })); }
    /** Most times any one generation was forgotten: 3 or more means the damage keeps coming (another screen in view). */
    get worst() { let m = 0; for (const x of this.redo) if (x > m) m = x; return m; }
    /** The complete stream failed its final check (SHA-256, gunzip or unreadable metadata): forget the damaged part only, when the sender's chunk checks can name it.
        Returns {blocks, share, meta, tries} (share = the part of the file to read again, tries = most times one of these generations was forgotten), or null
        when everything has to be read again (an old sender without checks, checks that all pass, or metadata that stays unreadable).
        Unreadable metadata takes the chunk checks with it, so nothing vouches for any other block: the blocks that can hold it are read again once (a few symbols;
        enough when no other block was solved from the wrong one), and when that does not help, everything (a whole generation would take as long). */
    repair() {
      if (!this.done) return null;
      const d = damaged(this.bytes()); if (!d || (d.meta && ++this.metaTries > 1)) return null;
      const blocks = this.forgetBlocks(d.blocks); if (!blocks) return null;
      let tries = 0; for (const [a, e] of d.blocks) for (let g = genOf(a); g <= genOf(Math.min(e, this.K - 1)); g++) if (this.redo[g] > tries) tries = this.redo[g];
      return { blocks, share: blocks / this.K, meta: d.meta, tries };
    }
    /** One block becomes known (a source symbol, or a row that came down to one block). */
    _solve(b, data) {
      if (this.known[b]) return;
      const g = genOf(b), G = this.gens[g];
      this.out.set(data.subarray(0, SYMBOL), b * SYMBOL); this.known[b] = 1; this.solved++; this.unk[g]--;
      if (!this.unk[g]) { if (G) { this.pivots -= G.np; this.gens[g] = null; } return; }
      if (!G) return;
      const c = b - G.f0;
      if (G.has[c]) {   // its pivot row now speaks about the other blocks only: take it out and reduce it again
        G.has[c] = 0; G.np--; this.pivots--;
        this.tb.fill(0); for (let k = 0; k < G.W; k++) this.tb[k] = G.bits[c * G.W + k]; for (let k = 0; k < DW; k++) this.td[k] = G.d32[c * DW + k];
        this._insert(G);
      }
      if (this.gens[g] === G && G.np === this.unk[g]) this._finish(G);
    }
    /** Full rank: back-substitute from the last pivot to the first (a later pivot row is by then the plain block, so it is XORed in whole words), then free the generation. */
    _finish(G) {
      const d8 = new Uint8Array(G.d32.buffer), D = G.d32, W = G.W;
      for (let c = G.n - 1; c >= 0; c--) {
        if (!G.has[c]) continue;
        const pd = c * DW, pb = c * W; G.bits[pb + (c >>> 5)] ^= 1 << (c & 31);
        for (let w = c >>> 5; w < W; w++) {
          let x = G.bits[pb + w];
          while (x) { const low = x & -x, j = (w << 5) + 31 - Math.clz32(low); x ^= low; if (G.has[j]) { const q = j * DW; for (let k = 0; k < DW; k++) D[pd + k] ^= D[q + k]; } else this._xor(d8.subarray(pd * 4, pd * 4 + SYMBOL), G.f0 + j); }
        }
      }
      for (let c = 0; c < G.n; c++) if (G.has[c]) { const b = G.f0 + c; this.out.set(d8.subarray(c * DW * 4, c * DW * 4 + SYMBOL), b * SYMBOL); this.known[b] = 1; this.solved++; this.unk[G.g]--; }
      this.pivots -= G.np; this.gens[G.g] = null;
    }
    bytes() { return this.out.subarray(0, this.len); }
  }

  // ---- what travels: [u16 length of the JSON][JSON name, mime, sha256, size, title, at, z; from seal() also cs, c, m][body: the file bytes, gzipped when z says so]
  const META_MAX = 2000, SEAL_ROOM = 1800, META_BLOCKS = Math.ceil((2 + META_MAX) / SYMBOL);
  function pack(meta, file) { return packJson(new TextEncoder().encode(JSON.stringify(meta)), file); }
  function packJson(j, file) {
    if (j.length > META_MAX) throw new Error('Name too long.');
    const out = new Uint8Array(2 + j.length + file.length);
    out[0] = j.length >> 8; out[1] = j.length & 255; out.set(j, 2); out.set(file, 2 + j.length);
    return out;
  }
  function unpack(b) {
    const n = b[0] * 256 + b[1];
    if (n === 0 || 2 + n > b.length) return null;
    try { return { meta: JSON.parse(new TextDecoder().decode(b.subarray(2, 2 + n))), file: b.subarray(2 + n) }; } catch (e) { return null; }
  }

  // ---- chunk checks: what lets a receiver find damage instead of reading everything again.
  // seal() is pack() plus three metadata fields that an older receiver ignores:
  //   cs = chunk size in bytes, c = Base64 of the CRC-32 values (4 bytes each, big-endian) of consecutive cs-byte chunks of the body as sent (after gzip),
  //   m  = CRC-32 (8 hex digits) of the JSON text itself with m as "00000000"; always the last field, so the receiver can tell damaged metadata from damaged content.
  // Chunk size: the whole JSON stays within SEAL_ROOM = 1,800 of the 2,000 bytes pack() allows, so the list gets what the name and type leave (about 1,560 characters
  // = 292 checks for a short name, 100 or more for the longest name the sender allows) and cs = body / that many, never under one block (142 bytes).
  // A 10 MB body gets chunks of about 36 KB, 1 MB about 3.6 KB, and up to about 40 KB one check per block. The repair is as fine as the chunks: see Collector.
  const b64 = b => { let s = ''; for (let i = 0; i < b.length; i += 3000) s += String.fromCharCode.apply(null, b.subarray(i, i + 3000)); return btoa(s); };
  function chunkChecks(body, cs) {
    const n = Math.ceil(body.length / cs), out = new Uint8Array(n * 4), dv = new DataView(out.buffer);
    for (let i = 0; i < n; i++) dv.setUint32(i * 4, crc32of(body, i * cs, Math.min(body.length, (i + 1) * cs)));
    return b64(out);
  }
  /** Chunk size for a body, given the bytes the other metadata fields take. 0 = no room for checks. */
  function chunkSize(bodyLen, metaLen) {
    const most = Math.floor(Math.floor((SEAL_ROOM - metaLen - 36) / 4) * 3 / 4);   // 36 = the field names, quotes and commas of cs, c and m, and the digits of cs and m
    return most >= 1 && bodyLen > 0 ? Math.max(SYMBOL, Math.ceil(bodyLen / most)) : 0;
  }
  const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');
  function seal(meta, body) {
    const enc = new TextEncoder(), m = { ...meta }; delete m.cs; delete m.c; delete m.m; const m0 = { ...m };
    const cs = chunkSize(body.length, enc.encode(JSON.stringify(m)).length);
    if (cs) { m.cs = cs; m.c = chunkChecks(body, cs); }
    m.m = '00000000'; const j = enc.encode(JSON.stringify(m));
    j.set(enc.encode(hex8(crc32of(j))), j.length - 10);   // the text ends with 00000000"}
    if (j.length > META_MAX) return pack(m0, body);   // no room even for the metadata check: send it as before
    return packJson(j, body);
  }
  /** Stream bytes a..e (e not included) lie in these blocks and generations: [first block, last block, first generation, last generation]. */
  const span = (a, e) => { const f = Math.floor(a / SYMBOL), l = Math.floor((Math.max(a + 1, e) - 1) / SYMBOL); return [f, l, genOf(f), genOf(l)]; };
  /** Body bytes a..e of a stream whose metadata JSON is jsonLen bytes long: the body starts after the 2 length bytes and the JSON, so a chunk can straddle two generations. */
  const bodySpan = (jsonLen, a, e) => span(2 + jsonLen + a, 2 + jsonLen + e);
  /** A decoded stream that failed its check: where is the damage?
      {meta: true, blocks} = the metadata is unreadable or fails its own check: the blocks that can hold it (it is at most 2,002 bytes, 15 blocks).
      {meta: false, blocks, chunks} = these chunks of the body fail; blocks = [first, last] pairs, merged, in order.
      null = it cannot be told (a sender without checks, or every check passes): read everything again. */
  function damaged(b) {
    const K = blockCount(b.length), head = { meta: true, blocks: [[0, Math.min(K, META_BLOCKS) - 1]] }, n = b[0] * 256 + b[1], off = 2 + n;
    if (n < 2 || n > META_MAX || off > b.length) return head;
    const j = b.subarray(2, off), tail = new TextDecoder().decode(j.subarray(Math.max(0, n - 15))), mt = /^"m":"([0-9a-f]{8})"\}$/.exec(tail); let meta;
    if (mt) { const z = j.slice(); z.fill(48, n - 10, n - 2); if (hex8(crc32of(z)) !== mt[1]) return head; }
    try { meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(j)); } catch (e) { return head; }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return head;
    if (!mt) return 'm' in meta || 'c' in meta || 'cs' in meta ? head : null;   // a seal that no longer reads as one, or a sender that made none
    const len = b.length - off, cs = meta.cs; let sums;
    if (!Number.isInteger(cs) || cs < 1 || typeof meta.c !== 'string') return null;
    try { sums = Uint8Array.from(atob(meta.c), ch => ch.charCodeAt(0)); } catch (e) { return null; }
    if (sums.length !== Math.ceil(len / cs) * 4) return null;
    const dv = new DataView(sums.buffer), blocks = [], chunks = [];
    for (let i = 0; i * cs < len; i++) {
      const a = off + i * cs, e = Math.min(b.length, a + cs); if (crc32of(b, a, e) === dv.getUint32(i * 4)) continue;
      const [f, l] = span(a, e), last = blocks[blocks.length - 1]; chunks.push(i);
      if (last && f <= last[1] + 1) last[1] = Math.max(last[1], l); else blocks.push([f, l]);
    }
    return blocks.length ? { meta: false, blocks, chunks } : null;
  }
  return { _int: { template, maskMap, bch, EXP, LOG, EC_L, BLOCKS_L, ALNUM, alignPos, countBits }, GEN, encode, capacity, symbolsIn, Stream, Collector, parseFrame, pack, unpack, seal, damaged, crc32of, chunkSize, chunkChecks, span, bodySpan, b45enc, b45dec, blocksOf, blockCount, SYMBOL, HEADER };
});
