// Decoder robustness: edge sizes, heavy and bursty loss, duplicates, late join (repair symbols only), bounded memory, hostile streams. Run: node tests/decoder.test.mjs
// (finding and re-reading damaged symbols: tests/repair.test.mjs)
import { createRequire } from 'node:module'; import { createHash, randomBytes } from 'node:crypto'; import assert from 'node:assert/strict';
const Q = createRequire(import.meta.url)('../core/qrtx.js'); let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok ' + name); };
const sha = b => createHash('sha256').update(b).digest('hex');
let rs = 7; const rnd = () => (rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296;
// CPU time of this thread in ms: the per-symbol bound must not fail because another program had the processor (wall time did, on a busy machine)
const cpuMs = () => { const u = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; };
/** Play a stream into a collector. take(i) says whether frame i is received; skip = frames shown before the receiver starts. */
function run(size, { v = 40, take = () => true, skip = 0, dup = false, max = 200000 } = {}) {
  const file = randomBytes(size), data = Q.pack({ name: 'x', mime: 'a/b', sha256: sha(file) }, file), s = new Q.Stream(data, 9); let c = null, i = 0;
  for (let k = 0; k < skip; k++) s.next(v);
  while (!(c && c.done)) {
    const text = s.next(v); i++; assert.ok(i < max, 'too many frames'); if (!take(i)) continue;
    const f = Q.parseFrame(text); c = c || new Q.Collector(f.id, f.len); c.add(f); if (dup) c.add(Q.parseFrame(text));
  }
  assert.equal(sha(Q.unpack(c.bytes()).file), sha(file)); return { c, K: Q.blockCount(data.length), frames: i };
}
t('edge sizes: 1 B to just over one generation, at v15 and v40', () => {
  for (const v of [15, 40]) for (const n of [1, 2, 141, 142, 143, 283, 284, 285, 1000, 142 * 1024 - 60, 142 * 1024, 142 * 1024 + 200, 142 * 2048 + 1]) run(n, { v });
});
t('random loss 0 to 60 %, 200 KB', () => { for (const loss of [0, 0.1, 0.3, 0.6]) { const r = run(200000, { take: () => rnd() >= loss }); assert.ok(r.c.symbols <= r.K * 1.08 + 25, `overhead at ${loss}: ${r.c.symbols} for ${r.K}`); } });
t('bursty loss: 15 frames lost in every 40', () => { const r = run(400000, { take: i => i % 40 >= 15 }); assert.ok(r.c.symbols <= r.K * 1.08 + 25); });
t('every frame delivered twice', () => { const r = run(100000, { dup: true }); assert.ok(r.c.rank === r.K); });
t('late join: the receiver starts after every source symbol has passed (repairs only), 1 MB', () => {
  const K = Q.blockCount(1048576 + 60), skip = Math.ceil(K / Q.symbolsIn(40)) + 2, m0 = process.memoryUsage().heapUsed, r = run(1048576, { skip });
  assert.ok(r.c.symbols <= r.K * 1.05 + 40, `needed ${r.c.symbols} symbols for ${r.K} blocks`);
  console.log(`   ${r.c.symbols} repair symbols for ${r.K} blocks (${((r.c.symbols / r.K - 1) * 100).toFixed(1)} % over)`);
});
t('memory stays bounded on a hostile 16 MB stream of repair symbols that never completes', () => {
  // forged header: 16 MB, repair seeds only, and every row leaves block 0 of its generation out, so no generation ever reaches full rank
  const len = 16 * 1048576, K = Q.blockCount(len), c = new Q.Collector(1, len), sym = new Uint8Array(Q.HEADER + Q.SYMBOL); let fed = 0, seed = K, worst = 0;
  global.gc && global.gc(); const m0 = process.memoryUsage().rss, t0 = Date.now();
  while (fed < 60000) { const bl = Q.blocksOf(seed, K); seed++; if (bl[0] % Q.GEN === 0) continue; const a = cpuMs(); c.add({ id: 1, len, seed: seed - 1, n: 1, bytes: sym }); const ms = cpuMs() - a; if (ms > worst) worst = ms; fed++; }
  const mb = (process.memoryUsage().rss - m0) / 1048576, secs = (Date.now() - t0) / 1000;
  console.log(`   60,000 hostile symbols: +${mb.toFixed(0)} MB, ${secs.toFixed(1)} s in all, slowest symbol ${worst.toFixed(1)} ms of CPU, held rows ${c.pivots}`);
  assert.ok(!c.done); assert.ok(c.pivots <= K); assert.ok(mb < 120, 'memory grew by ' + mb.toFixed(0) + ' MB'); assert.ok(worst < 50, 'one symbol took ' + worst.toFixed(1) + ' ms');
});
t('a hostile stream that contradicts itself: every contradiction is counted, a disputed block is forgotten, and nothing grows', () => {
  // forged frames with random content: each source symbol arrives twice with different content, and repair symbols are noise
  const len = 4 * 1048576, K = Q.blockCount(len), c = new Q.Collector(1, len), fr = n => { const b = new Uint8Array(Q.HEADER + n * Q.SYMBOL); for (let i = Q.HEADER; i < b.length; i++) b[i] = rnd() * 256; return b; };
  for (let seed = 0; seed < 4000; seed += 20) for (let k = 0; k < 2; k++) c.add({ id: 1, len, seed, n: 20, bytes: fr(20) });
  assert.equal(c.flags, 4000); assert.equal(c.lost, 4000); assert.equal(c.rank, 0); assert.ok(c.worst >= 3 && [...c.sus].reduce((a, x) => a + x) === 4000);
  for (let seed = K; seed < K + 20000; seed += 20) c.add({ id: 1, len, seed, n: 20, bytes: fr(20) });
  assert.ok(!c.done && c.pivots === 20000 && c.pivots <= K && c.rank <= K && c.solved + c.unk.reduce((a, x) => a + x) === K, 'the counts stay consistent');
});
t('bad lengths are refused', () => { for (const n of [0, -1, 65 * 1048576, 0xFFFFFFFF, NaN]) assert.throws(() => new Q.Collector(1, n)); });
t('a frame of another stream is ignored', () => { const c = new Q.Collector(1, 5000); assert.equal(c.add({ id: 2, len: 5000, seed: 0, n: 1, bytes: new Uint8Array(Q.HEADER + Q.SYMBOL) }), 0); assert.equal(c.rank, 0); });
console.log(`${pass} passed`);
