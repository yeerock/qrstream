// Node test of the core: Base45, frames, CRC, fountain decoding under frame loss and density changes. Run: node tests/codec.test.mjs
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const Q = createRequire(import.meta.url)('../core/qrtx.js');
let pass = 0; const t = (name, fn) => { fn(); pass++; console.log('ok', name); };

t('base45 round trip (RFC 9285 vector)', () => {
  assert.equal(Q.b45enc(new TextEncoder().encode('AB')), 'BB8');
  for (const n of [0, 1, 2, 3, 1000]) { const b = randomBytes(n); assert.deepEqual(Buffer.from(Q.b45dec(Q.b45enc(b))), b); }
});
t('QR capacity v40 level L alphanumeric = 4296', () => assert.equal(Q.capacity(40), 4296));
t('encode picks the smallest version and rejects bad input', () => {
  assert.equal(Q.encode('HELLO WORLD').version, 1);
  assert.throws(() => Q.encode('é'));
});
t('frame CRC rejects a flipped character', () => {
  const s = new Q.Stream(randomBytes(5000), 7), f = s.next(15);
  assert.ok(Q.parseFrame(f));
  const i = 40, bad = f.slice(0, i) + (f[i] === 'A' ? 'B' : 'A') + f.slice(i + 1);
  assert.equal(Q.parseFrame(bad), null);
});
for (const [size, loss] of [[3000, 0], [50000, 0.3], [300000, 0.5], [1048576, 0.2]]) t(`decode ${size} B with ${loss * 100}% frames lost, density changing (generation code)`, () => {
  const file = randomBytes(size), meta = { name: 'x.bin', mime: 'application/octet-stream', sha256: createHash('sha256').update(file).digest('hex') };
  const data = Q.pack(meta, file), s = new Q.Stream(data, 42); let c = null, sent = 0, rng = 1;
  const rnd = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
  while (!(c && c.done)) {
    const v = [40, 33, 25, 15][Math.floor(sent / 50) % 4], text = s.next(v); sent++;
    if (rnd() < loss) continue;
    const f = Q.parseFrame(text); if (!c) c = new Q.Collector(f.id, f.len); c.add(f);
    assert.ok(sent < 20000, 'too many frames');
  }
  const u = Q.unpack(c.bytes());
  assert.equal(createHash('sha256').update(u.file).digest('hex'), meta.sha256);
  const symbols = c.symbols, K = Q.blockCount(data.length);
  console.log(`   ${sent} frames sent, overhead ${((symbols / K - 1) * 100).toFixed(1)}% over the file`);
});
console.log(`${pass} passed`);
