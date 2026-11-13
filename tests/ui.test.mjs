// Browser checks of the pages themselves (own DevTools driver, no library): sender controls and text sending, reduced motion, receiver first screen,
// refusal inside another site's frame, and what the receiver does when a second stream appears. Run: node tests/ui.test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { serve } from './serve.mjs'; import { launch } from './cdp.mjs'; import { shoot, writeY4M } from './camera.mjs';
const A = 'http://127.0.0.1:8793', B = 'http://localhost:8793', srv = await serve(8793), w = ms => new Promise(r => setTimeout(r, ms)); let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' - ' + e.message); } };
const clean = p => assert.deepEqual(p.logs.filter(l => /exception|Content Security Policy|Refused/i.test(l)), []);
const txt = (p, id) => p.eval(`document.getElementById('${id}').textContent`), hid = (p, id) => p.eval(`document.getElementById('${id}').hidden`);
let b = await launch();
await t('sender: text is sent as note.txt, focus moves to Pause, the status shows speed and a check code', async () => {
  const p = await b.page(A + '/send/', { width: 1280, height: 800 });
  await p.click('#sendtext'); assert.match(await txt(p, 'err'), /Type or paste/);
  await p.eval("document.getElementById('text').value = 'hello from the test '.repeat(40)"); await p.click('#sendtext');
  await p.waitFor("!document.getElementById('play').hidden"); assert.equal(await txt(p, 'fname'), 'note.txt');
  assert.equal(await p.eval('document.activeElement.id'), 'pause'); await w(3400);
  assert.match(await txt(p, 'fstat'), /^Showing for 0:0\d · pass \d+ · a phone needs about \d+ s/); assert.match(await txt(p, 'fdet'), /up to \d+ KB\/s · check code [0-9a-f]{4} [0-9a-f]{4}$/);
  assert.equal(await hid(p, 'fok'), false);   // a tiny file has been shown in full within a second
  clean(p); await p.close();
});
await t('sender: Pause and Resume labels, and the label is Pause again after Stop and a new file', async () => {
  const p = await b.page(A + '/send/?demo=text', { width: 1280, height: 800 }); await w(3200);
  await p.click('#pause'); assert.equal(await txt(p, 'pause'), 'Resume'); assert.equal(await txt(p, 'fstat'), 'Paused');
  const f1 = await p.eval("document.getElementById('qr').toDataURL()"); await w(500); assert.equal(await p.eval("document.getElementById('qr').toDataURL()"), f1, 'frames must not advance while paused');
  await p.click('#close'); assert.equal(await hid(p, 'play'), true); assert.equal(await p.eval('document.activeElement.id'), 'drop');
  await p.click('#demotxt'); await p.waitFor("!document.getElementById('play').hidden"); assert.equal(await txt(p, 'pause'), 'Pause'); await w(3200);
  const f2 = await p.eval("document.getElementById('qr').toDataURL()"); await w(400); assert.notEqual(await p.eval("document.getElementById('qr').toDataURL()"), f2, 'frames must advance');
  clean(p); await p.close();
});
await t('sender: Codes 4 gives a 2 by 2 block; every layout keeps whole device pixels per module', async () => {
  const p = await b.page(A + '/send/?demo', { width: 1200, height: 1200 }); await w(3200);
  await p.eval("(() => { const k = document.getElementById('k'); k.value = '4'; k.onchange(); })()"); await w(600);
  const g = await p.eval("(() => { const c = document.getElementById('qr'), r = c.getBoundingClientRect(); return { w: c.width, h: c.height, px: r.width * devicePixelRatio / c.width }; })()");
  assert.equal(g.w, g.h, 'a 2 by 2 block is square'); assert.ok(Math.abs(g.px - Math.round(g.px)) < 0.01 && g.px >= 3, 'module pixels ' + g.px);
  assert.match(await txt(p, 'fdet'), /2 by 2 grid of v\d+/);
  await p.click('#join'); await w(500); assert.equal(await p.eval("document.getElementById('qr').width"), await p.eval("document.getElementById('ecode').width"), 'the entry code fills the stage after a click'); await w(5200); assert.notEqual(await p.eval("document.getElementById('qr').width"), await p.eval("document.getElementById('ecode').width")); clean(p); await p.close();
});
await t('receiver: first screen is clean, nothing to discard or delete, no errors', async () => {
  const p = await b.page(A + '/receive/', { width: 390, height: 844 }); await w(400);
  for (const id of ['discard', 'clear', 'histh', 'scan']) assert.equal(await hid(p, id), true, id);
  assert.equal(await txt(p, 'homemsg'), ''); assert.equal(await txt(p, 'homenote'), ''); clean(p); await p.close();
});
await t('pages refuse to show inside a frame from another site, and still show in a frame of their own site', async () => {
  for (const [parent, want] of [[B, true], [A, false]]) for (const page of ['send/', 'receive/']) {
    const p = await b.page(parent + '/tests/fixtures/frame.html?u=' + encodeURIComponent(A + '/' + page), { width: 800, height: 600 }); await w(500);
    assert.equal(await p.eval("document.querySelector('iframe').contentWindow.length >= 0"), true);
    const h = await b.page(A + '/' + page, { width: 400, height: 400 }); assert.equal(await h.eval('document.documentElement.hidden'), false); await h.close();
    const hidden = await p.eval("(() => { try { return document.querySelector('iframe').contentDocument.documentElement.hidden; } catch (e) { return 'cross'; } })()");
    if (want) { assert.equal(hidden, 'cross'); const shot = await p.screenshot(); await p.eval("document.querySelector('iframe').src = 'about:blank'"); await w(300); assert.ok(shot.equals(await p.screenshot()), 'a page framed by another site must draw nothing'); }
    else assert.equal(hidden, false);
    await p.close();
  }
});
await b.close();
await t('sender under reduced motion waits for Start stream', async () => {
  const b2 = await launch(['--force-prefers-reduced-motion']); try {
    const p = await b2.page(A + '/send/?demo=text', { width: 1280, height: 800 }); await w(1500);
    assert.equal(await txt(p, 'pause'), 'Start stream'); assert.match(await txt(p, 'fstat'), /^Ready/);
    const f1 = await p.eval("document.getElementById('qr').toDataURL()"); await w(600); assert.equal(await p.eval("document.getElementById('qr').toDataURL()"), f1);
    await p.click('#pause'); await w(600); assert.equal(await txt(p, 'pause'), 'Pause'); assert.notEqual(await p.eval("document.getElementById('qr').toDataURL()"), f1); clean(p);
  } finally { await b2.close(); }
});
// ---- two streams: frames of the demo picture (stream P) and of the demo text (stream T), filmed by the camera simulator
async function screens(demo, n) { const bb = await launch(); try { const p = await bb.page(`${A}/send/?test&demo=${demo}`, { width: 1280, height: 720 }); await p.waitFor('window.__qrsStep && 1'); const out = []; for (let i = 0; i < n; i++) { await p.eval('__qrsStep(1)'); out.push(shoot(await p.eval('__qrsGrab()'), 1280, 720, { seed: i + 1 })); } return out; } finally { await bb.close(); } }
async function receive(frames, ms = 60000) {
  const y = path.join(os.tmpdir(), `qrs-ui-${process.pid}.y4m`); writeY4M(y, 1280, 720, 10, frames);
  const bb = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y}`]);
  try { const p = await bb.page(A + '/receive/?debug', { width: 420, height: 860 }); await p.click('#start'); let r; try { r = await p.waitFor('window.__qrs && window.__qrs.done ? window.__qrs : null', ms); } catch (e) { throw new Error('not finished: ' + JSON.stringify(await p.eval('window.__qrs || null')) + ' hint=' + await txt(p, 'hint') + ' stat=' + await txt(p, 'stat') + ' logs=' + p.logs.slice(-3).join(' | ')); }
    await p.waitFor("!document.getElementById('result').hidden"); clean(p); return { r, dname: await txt(p, 'dname'), hash: await txt(p, 'dhash') }; } finally { await bb.close(); fs.rmSync(y, { force: true }); }
}
const P = await screens('picture', 45), T = await screens('text', 30);
await t('receiver: one stray screen of another stream does not wipe the transfer', async () => {
  const { r, dname, hash } = await receive([...P.slice(0, 8), T[0], ...P.slice(8)]);
  assert.equal(r.name, 'qrstream-demo.jpg'); assert.match(dname, /received in [\d.]+ s \(\d+ KB\/s\)/); assert.match(hash, /^Check code [0-9a-f]{4} [0-9a-f]{4}/);
});
await t('receiver: when the screen really changes to another file, it follows', async () => {
  const { r } = await receive([...P.slice(0, 4), ...T, ...T, ...T]);
  assert.equal(r.name, 'qrstream-demo.txt');
});
srv.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
