// Repair of damaged symbols: a wrong symbol that passed the frame CRC must be found and only the damaged part read again. Deterministic, Node only. Run: node tests/repair.test.mjs
// Optional: QRS_OLD_CORE=/path/to/an/older/core/qrtx.js also checks the wire format against that copy, both ways.
import { createRequire } from 'node:module'; import { createHash } from 'node:crypto'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const require = createRequire(import.meta.url), Q = require('../core/qrtx.js'); let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok ' + name); };
const sha = b => createHash('sha256').update(b).digest('hex');
const lcg = s => () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
const bytes = (n, seed) => { const r = lcg(seed), b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = r() * 256; return b; };
const GEN = Q.GEN, SYM = Q.SYMBOL, HDR = Q.HEADER;

/** The receiver of receive/app.js without the camera: add every frame that arrives; when the stream is complete check the sender's checks and the SHA-256; when one fails call repair(),
    and read everything again only when repair() cannot say where the damage is.
    o.tamper(frame, i, c) may change a parsed frame (a misread that passed the CRC) or return extra frames (another screen); o.take(i) = false loses frame i. */
function receive(o) {
  const file = bytes(o.size, o.fileSeed || 5), meta = { name: 'x.bin', mime: 'application/octet-stream', sha256: sha(file), size: file.length, title: '', at: 1763000000 };
  const data = (o.sealed === false ? Q.pack : Q.seal)(meta, file), s = new (o.Stream || Q.Stream)(data, 77), K = Q.blockCount(data.length), rnd = lcg(o.seed || 3);
  const r = { K, data, repairs: [], fulls: 0, sent: 0, got: 0, firstDone: 0, ok: false, warned: false, c: null, lost: 0, flags: 0 };
  for (let k = 0; k < (o.skip || 0); k++) s.next(o.v || 40);
  while (r.sent < (o.max || 100000)) {
    const text = s.next(o.v || 40); r.sent++;
    if (o.take ? !o.take(r.sent) : rnd() < (o.loss || 0)) continue;
    const f = Q.parseFrame(text); r.got++; assert.ok(f);
    for (const x of [f].concat(o.tamper && o.tamper(f, r.got, r.c, K) || [])) {
      if (!r.c) r.c = new Q.Collector(x.id, x.len);
      const c = r.c, lost = c.lost; c.add(x);
      if (c.lost !== lost && c.worst >= 3) r.warned = true;
      if (!c.done) continue;
      if (!r.firstDone) r.firstDone = r.sent;
      const u = Q.damaged(c.bytes()) ? null : Q.unpack(c.bytes());
      if (u && u.meta && u.meta.sha256 === meta.sha256 && sha(u.file) === meta.sha256) { r.ok = true; r.lost += c.lost; r.flags = c.flags; return r; }
      const rep = c.repair();
      if (rep) { r.repairs.push(rep); if (rep.tries >= 3) r.warned = true; } else { r.fulls++; r.lost += c.lost; r.c = null; if (r.fulls >= 3) r.warned = true; break; }
    }
  }
  if (r.c) { r.lost += r.c.lost; r.flags = r.c.flags; }
  return r;
}
/** Flip one byte of symbol k of a parsed frame: what a misread that passed Reed-Solomon and the CRC would hand to the decoder. */
const flip = (f, k = 0, at = 70) => { f.bytes = f.bytes.slice(); f.bytes[HDR + k * SYM + at] ^= 0x5A; };
/** A forged frame as another screen would show it: right stream id and length, valid frame CRC, wrong content. Built and parsed like a real one. */
function forged(id, len, seed, n, r) {
  const b = new Uint8Array(HDR + n * SYM), dv = new DataView(b.buffer); b[0] = 0xA5; b[1] = 0x51; b[2] = 3; dv.setUint32(4, id); dv.setUint32(8, len); dv.setUint32(12, seed);
  for (let i = HDR; i < b.length; i++) b[i] = r() * 256;
  const noCrc = new Uint8Array(b.length - 4); noCrc.set(b.subarray(0, 16)); noCrc.set(b.subarray(20), 16); dv.setUint32(16, Q.crc32of(noCrc));   // the frame CRC skips its own field
  const f = Q.parseFrame(Q.b45enc(b) + '/'); assert.ok(f, 'a forged frame passes the frame CRC: the CRC has no key'); return f;
}
const gensOf = c => [...c.redo].map((n, g) => n ? g : -1).filter(g => g >= 0);

t('CRC-32 of a byte range (check value of "123456789" = CBF43926); the frame CRC is unchanged', () => {
  const b = new TextEncoder().encode('xx123456789yy'); assert.equal(Q.crc32of(b, 2, 11), 0xCBF43926); assert.equal(Q.crc32of(b.subarray(2, 11)), 0xCBF43926);
  const s = new Q.Stream(bytes(5000, 1), 7), f = s.next(15); assert.ok(Q.parseFrame(f));
});
t('seal: the checks fit, an older receiver reads the same file, damage is located', () => {
  for (const [size, name] of [[1, 'a'], [142, 'a'], [5000, 'a.txt'], [1048576, 'photo.jpg'], [10 * 1048576, 'x'.repeat(120)], [10 * 1048576, '中'.repeat(120)], [10 * 1048576, '\u0001'.repeat(120)], [300000, '"'.repeat(120)]]) {
    const body = bytes(size, 2), meta = { name, mime: 'application/octet-stream', sha256: sha(body), size, title: '', at: 1763000000, z: 'gzip' }, d = Q.seal(meta, body), n = d[0] * 256 + d[1];
    assert.ok(n <= 1800, `metadata ${n} B`); const u = Q.unpack(d);
    assert.deepEqual(Buffer.from(u.file), Buffer.from(body)); for (const k in meta) assert.equal(u.meta[k], meta[k]);
    assert.ok(u.meta.cs >= SYM && Math.ceil(size / u.meta.cs) * 4 === Buffer.from(u.meta.c, 'base64').length && Object.keys(u.meta).pop() === 'm');
    assert.equal(Q.damaged(d), null);
    const x = d.slice(), at = 2 + n + (size >> 1); x[at] ^= 1; const dm = Q.damaged(x);
    assert.ok(dm && !dm.meta && dm.chunks.length === 1 && dm.chunks[0] === Math.floor((size >> 1) / u.meta.cs));
    const [f, l] = dm.blocks[0], b = Math.floor(at / SYM); assert.ok(dm.blocks.length === 1 && f <= b && b <= l && (l - f + 1) * SYM < u.meta.cs + 2 * SYM);
    const y = d.slice(); y[2 + (n >> 1)] ^= 4; assert.deepEqual(Q.damaged(y), { meta: true, blocks: [[0, Math.min(Q.blockCount(d.length), 15) - 1]] });
    if (size === 10 * 1048576 && name.length === 120 && name[0] === 'x') console.log(`   10 MB, 120-character name: metadata ${n} B, ${Math.ceil(size / u.meta.cs)} chunks of ${u.meta.cs} B`);
    if (size === 1048576) console.log(`   1 MB, short name: metadata ${n} B, ${Math.ceil(size / u.meta.cs)} chunks of ${u.meta.cs} B`);
  }
  assert.equal(Q.damaged(Q.pack({ name: 'x', sha256: 'y' }, bytes(999, 1))), null);   // a sender without checks: nothing can be said
});
t('which blocks and generations hold a byte range; the metadata shifts the body, so a chunk can straddle two generations', () => {
  assert.deepEqual(Q.span(0, 1), [0, 0, 0, 0]); assert.deepEqual(Q.span(141, 143), [0, 1, 0, 0]); assert.deepEqual(Q.span(142, 284), [1, 1, 0, 0]);
  assert.deepEqual(Q.span(GEN * SYM - 1, GEN * SYM + 1), [GEN - 1, GEN, 0, 1]);
  const j = 298, cs = 3600, i = Math.floor((GEN * SYM - 2 - j) / cs), [f, l, g0, g1] = Q.bodySpan(j, i * cs, (i + 1) * cs);   // the chunk that crosses the end of generation 0
  assert.ok(f < GEN && l >= GEN && g0 === 0 && g1 === 1 && f === Math.floor((2 + j + i * cs) / SYM));
  assert.deepEqual(Q.bodySpan(j, 0, 1), [2, 2, 0, 0]);   // the first body byte comes after 2 + 298 bytes of metadata
});
t('forget: chosen generations or blocks go back to unknown, the rest is kept, and the stream refills them', () => {
  const data = Q.seal({ name: 'x', sha256: '' }, bytes(400000, 4)), s = new Q.Stream(data, 1); let c = null;
  while (!(c && c.done)) { const f = Q.parseFrame(s.next(40)); c = c || new Q.Collector(f.id, f.len); c.add(f); }
  const K = c.K, before = sha(c.bytes()); assert.equal(c.forget([1]), GEN); assert.ok(!c.done && c.rank === K - GEN && c.redo[1] === 1 && c.lost === GEN);
  assert.equal(c.forgetBlocks([[5, 9], [K - 2, K + 50]]), 7); assert.ok(c.rank === K - GEN - 7 && c.redo[0] === 1 && c.redo[2] === 1);
  let more = 0; while (!c.done) { c.add(Q.parseFrame(s.next(40))); more++; assert.ok(more < 2000); }
  assert.equal(sha(c.bytes()), before); assert.ok(c.gens.every(g => g === null) && c.pivots === 0, 'rows are freed');
});
t('consistency check: the same block with other content, before any repair symbol: one block is forgotten', () => {
  const data = Q.seal({ name: 'x', sha256: '' }, bytes(300000, 6)), s = new Q.Stream(data, 1), f1 = Q.parseFrame(s.next(40)), c = new Q.Collector(f1.id, f1.len);
  c.add(f1); const again = Q.parseFrame(Q.b45enc(f1.bytes) + '/'); assert.equal(c.add(again), 0); assert.equal(c.flags, 0);   // an honest second read of a frame
  flip(again, 3); const b = Q.blocksOf(f1.seed + 3, c.K)[0], g = Math.floor(b / GEN);
  assert.equal(c.add(again), -1); assert.ok(c.flags === 1 && c.sus[g] === 1 && c.lost === 1 && !c.known[b] && c.redo[g] === 1);
  while (!c.done) c.add(Q.parseFrame(s.next(40))); assert.equal(sha(c.bytes()), sha(data));
});
t('consistency check: a wrong repair symbol in the basis is caught by a symbol that adds nothing; the chunk checks then name the damage', () => {
  // late join (repair symbols only). One symbol is wrong; the same symbol read correctly afterwards reduces to no blocks but not to zero data.
  const data = Q.seal({ name: 'x', sha256: '' }, bytes(500000, 8)), s = new Q.Stream(data, 1), K = Q.blockCount(data.length); for (let i = 0; i < Math.ceil(K / 20) + 1; i++) s.next(40);
  const f1 = Q.parseFrame(s.next(40)), c = new Q.Collector(f1.id, f1.len), bad = { ...f1 }; flip(bad, 0); const g = Math.floor(Q.blocksOf(f1.seed, K)[0] / GEN);
  c.add(bad); const rank = c.rank; assert.equal(c.flags, 0); c.add(f1);
  assert.ok(c.flags === 1 && c.sus[g] === 1 && c.sus.reduce((a, x) => a + x) === 1, 'flagged, in that generation only'); assert.ok(c.lost === 0 && c.rank === rank, 'nothing is thrown away on a single contradiction');
  while (!c.done) c.add(Q.parseFrame(s.next(40))); assert.notEqual(sha(c.bytes()), sha(data));
  const d = Q.damaged(c.bytes()), r = c.repair(); assert.ok(d && !d.meta && r && r.blocks >= 1 && r.blocks <= GEN + 60 && r.tries === 1, JSON.stringify([d, r]));
  assert.ok(d.blocks.every(([a, e]) => a >= g * GEN - 30 && e < (g + 1) * GEN + 30), 'the damage is in that generation (a chunk on its border reaches a few blocks into the next)');
  while (!c.done) c.add(Q.parseFrame(s.next(40))); assert.equal(sha(c.bytes()), sha(data)); assert.equal(Q.damaged(c.bytes()), null);
});
const clean = receive({ size: 1048576, loss: 0.2 });
t('1 MB at 20 % loss, nothing wrong: no flag, nothing forgotten', () => { assert.ok(clean.ok && clean.lost === 0 && clean.flags === 0 && !clean.repairs.length && !clean.fulls); console.log(`   ${clean.sent} frames shown, ${clean.K} blocks in ${Math.ceil(clean.K / GEN)} generations`); });
for (const [what, pick] of [['SOURCE', (f, K) => f.seed < K && f.seed > 2000], ['REPAIR', (f, K) => f.seed >= K + 400]]) t(`one wrong ${what} symbol in 1 MB at 20 % loss: found, only its generation is read again, SHA-256 matches`, () => {
  let g = -1;
  const r = receive({ size: 1048576, loss: 0.2, tamper: (f, i, c, K) => { if (g < 0 && pick(f, K)) { g = Math.floor(Q.blocksOf(f.seed, K)[0] / GEN); flip(f, 0); } } });
  assert.ok(r.ok && r.fulls === 0 && g > 0, 'completed without a full re-read'); const touched = gensOf(r.c), edge = 2 * Math.ceil(Q.unpack(r.data).meta.cs / SYM);   // a damaged chunk that straddles a generation border takes a few blocks of the neighbour with it
  assert.ok(touched.includes(g) && touched.every(x => Math.abs(x - g) <= 1), `generation ${g} damaged, ${touched} touched`);
  assert.ok(r.lost >= 1 && r.lost <= GEN * r.c.redo[g] + edge, `${r.lost} blocks forgotten`); assert.ok(r.repairs.length + r.flags >= 1);
  assert.ok(r.repairs.every(x => !x.meta && x.blocks <= GEN + edge));
  console.log(`   generation ${g}: ${r.lost} of ${r.K} blocks read again (${(100 * r.lost / r.K).toFixed(1)} %, generations ${touched}), ${r.repairs.length} repair after the SHA-256, ${r.flags} caught by the decoder; complete after ${r.sent} frames (first complete at ${r.firstDone}, clean run ${clean.sent})`);
});
t('little loss, so few blocks were solved from repair symbols: only part of one generation is read again', () => {
  let g = -1; const o = { size: 1048576, loss: 0.02, seed: 11 }, base = receive(o);
  const r = receive({ ...o, tamper: (f, i, c, K) => { if (g < 0 && f.seed >= K + 20) { g = Math.floor(Q.blocksOf(f.seed, K)[0] / GEN); flip(f, 0); } } });
  assert.ok(r.ok && r.fulls === 0 && r.repairs.length + r.flags >= 1, JSON.stringify([r.ok, r.fulls, r.repairs, r.flags, r.sent, g])); assert.ok(gensOf(r.c).includes(g) && gensOf(r.c).every(x => Math.abs(x - g) <= 1)); assert.ok(r.lost < GEN / 2, `${r.lost} blocks`);
  console.log(`   ${r.lost} of ${r.K} blocks read again (${(100 * r.lost / r.K).toFixed(1)} %): ${r.sent - r.firstDone} more frames after ${r.firstDone} (clean run ${base.sent})`);
});
t('damage inside the metadata block: its 15 blocks are read again; when other blocks were solved from the wrong one, everything', () => {
  const hit = (f, i) => { if (i === 1) { assert.equal(f.seed, 0); flip(f, 0, 40); } };   // seed 0 is block 0: the length and the start of the JSON
  const a = receive({ size: 1048576, tamper: hit });   // no loss: every block came as itself, the wrong one stands alone
  assert.ok(a.ok && a.fulls === 0 && a.repairs.length === 1 && a.repairs[0].meta && a.repairs[0].blocks === 15 && a.lost === 15, JSON.stringify(a.repairs)); assert.deepEqual(gensOf(a.c), [0]);
  assert.ok(a.sent - a.firstDone <= 20, `${a.sent - a.firstDone} more frames`);
  const b = receive({ size: 1048576, loss: 0.2, take: i => i === 1 || i % 5 !== 0, tamper: hit });
  assert.ok(b.ok && b.fulls === 1 && b.repairs.length === 1 && b.repairs[0].meta && b.repairs[0].blocks <= 15, JSON.stringify(b.repairs));
  console.log(`   no loss: 15 blocks read again, ${a.sent - a.firstDone} more frames after ${a.firstDone}; 20 % loss: 15 blocks, then 1 full re-read, complete after ${b.sent} frames (first complete at ${b.firstDone})`);
});
t('a stream from an old sender (no chunk checks) with one wrong symbol: falls back to reading everything again, and completes', () => {
  let done = false; const r = receive({ size: 300000, loss: 0.2, sealed: false, tamper: (f, i, c, K) => { if (!done && f.seed < K && i > 20) { done = true; flip(f, 1); } } });
  assert.ok(r.ok && r.fulls === 1 && r.repairs.length === 0); console.log(`   1 full re-read, complete after ${r.sent} frames (first complete at ${r.firstDone})`);
});
t('a forged frame from another screen now and then (every 1,500th): the transfer still completes, in a bounded number of frames', () => {
  const fr = lcg(21); let n = 0;
  const r = receive({ size: 1048576, loss: 0.2, max: 6000, tamper: (f, i, c, K) => i % 1500 === 150 ? (n++, [forged(f.id, f.len, K + 5000 + i * 97, 20, fr)]) : null });
  assert.ok(r.ok && n >= 1 && r.repairs.length + r.fulls >= 1, `ok ${r.ok} after ${r.sent}`); assert.ok(r.sent <= clean.sent * 3, `${r.sent} frames`);
  console.log(`   ${n} forged frame(s) of 20 symbols (all 8 generations hit, the metadata too): ${r.repairs.length} repair(s), ${r.fulls} full re-read(s), complete after ${r.sent} frames (clean run ${clean.sent})`);
});
t('a forged frame every 5th frame: no completion, but it is reported instead of looping in silence', () => {
  const fr = lcg(22);
  const r = receive({ size: 1048576, loss: 0.2, max: 6000, tamper: (f, i, c, K) => i % 5 === 0 ? [forged(f.id, f.len, i % 10 ? K + 5000 + i * 97 : (i * 131) % K, 20, fr)] : null });
  assert.ok(!r.ok && r.warned, 'warned'); assert.ok(r.sent === 6000 && r.c && r.c.pivots <= r.K && r.c.rank <= r.K, 'bounded state');
  console.log(`   after 6,000 frames: not complete, warning shown, ${r.repairs.length} repairs, ${r.fulls} full re-reads, ${r.lost} blocks forgotten in all`);
});
t('wire format: a stream packed without checks decodes; sealed and unsealed frames are the same kind of frame', () => {
  const r = receive({ size: 200000, loss: 0.3, sealed: false }); assert.ok(r.ok && !r.lost);
  const body = bytes(3000, 1), a = new Q.Stream(Q.pack({ name: 'x' }, body), 5).next(25), b = new Q.Stream(Q.seal({ name: 'x' }, body), 5).next(25);
  const fa = Q.parseFrame(a), fb = Q.parseFrame(b); assert.ok(fa && fb && fa.n === fb.n && fa.seed === fb.seed && fb.len > fa.len);
});
const OLD = process.env.QRS_OLD_CORE;
if (OLD && fs.existsSync(OLD)) {
  const P = require(OLD);
  t('compatibility with the older core, both ways (frames of one decode in the collector of the other, sealed metadata is ignored there)', () => {
    for (const [S, C, name] of [[P, Q, 'old sender -> new receiver'], [Q, P, 'new sender -> old receiver']]) for (const size of [1, 5000, 1048576]) {
      const file = bytes(size, 9), meta = { name: 'x.bin', mime: 'a/b', sha256: sha(file), size, title: '', at: 1 }, data = (S.seal || S.pack)(meta, file), s = new S.Stream(data, 3), rnd = lcg(4); let c = null, i = 0;
      while (!(c && c.done)) { const text = s.next([40, 25, 15][i++ % 3]); if (rnd() < 0.2) continue; const f = C.parseFrame(text); assert.ok(f, name); c = c || new C.Collector(f.id, f.len); assert.equal(typeof c.add(f), 'number'); assert.ok(i < 50000); }
      const u = C.unpack(c.bytes()); assert.equal(sha(u.file), meta.sha256, name); assert.equal(u.meta.name, 'x.bin');
      for (const k of ['id', 'len', 'K', 'rank', 'frames', 'symbols', 'progress', 'done']) assert.ok(c[k] !== undefined, k);
      if (C === Q && !S.seal) assert.equal(c.repair(), null);   // nothing to go by: the receiver reads everything again
    }
    assert.equal(new P.Stream(bytes(9000, 1), 5).next(33), new Q.Stream(bytes(9000, 1), 5).next(33));   // identical frames for identical bytes
  });
} else console.log('-- skipped: compatibility with an older core (set QRS_OLD_CORE=/path/to/core/qrtx.js)');
t('one frame that contradicts 20 known blocks counts as one event, not 20', () => {
  const file = bytes(60000, 3), s = new Q.Stream(Q.seal({ name: 'a.bin', mime: 'a/b', sha256: sha(file) }, file), 7), fr = [1, 2, 3].map(() => Q.parseFrame(s.next(40))), c = new Q.Collector(fr[0].id, fr[0].len);
  fr.forEach(f => c.add(f)); const again = { ...fr[2], bytes: fr[2].bytes.slice() }; for (let i = HDR; i < again.bytes.length; i += 7) again.bytes[i] ^= 0x55;   // the third frame, read again with other content
  c.add(again); assert.ok(c.flags >= 1, 'the contradiction is noticed'); assert.equal(c.worst, 1);
});
t('metadata too long for any check is sent as before instead of being refused', () => {
  const meta = { name: 'x'.repeat(1975) }, body = bytes(5000, 4);
  assert.deepEqual(Q.seal(meta, body), Q.pack(meta, body)); assert.throws(() => Q.seal({ name: 'x'.repeat(2100) }, body));
});
console.log(`${pass} passed`);
