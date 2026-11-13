// Browser checks of the pages themselves (own DevTools driver, no library): sender controls and text sending, reduced motion, receiver first screen,
// refusal inside another site's frame, and what the receiver does when a second stream appears. Run: node tests/ui.test.mjs
// Options: PORT=n (local server; default: any free port, so runs at the same time never meet).
// The tests wait for the state they need (the stream started, the frame loaded, the picture changed) and never for a fixed time alone:
// on a busy machine a page is seconds late, and a fixed pause then tests the wrong moment.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs'; import { launch, launchCamera, retryFrozenCamera } from './cdp.mjs'; import { shoot, writeY4M, feedFile } from './camera.mjs';
const w = ms => new Promise(r => setTimeout(r, ms)); let pass = 0, fail = 0, srv, b, A, B;
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' - ' + e.message); } };
const clean = p => assert.deepEqual(p.logs.filter(l => /exception|Content Security Policy|Refused/i.test(l)), []);
const txt = (p, id) => p.eval(`document.getElementById('${id}').textContent`), hid = (p, id) => p.eval(`document.getElementById('${id}').hidden`);
// the sender shows its entry code for 2.5 s, then the stream: the stream runs once the stage canvas no longer has the entry code's size
const STREAMING = "document.getElementById('qr').width !== document.getElementById('ecode').width", SHOT = "document.getElementById('qr').toDataURL()";
const moving = async p => { await p.eval(`window.__shot = ${SHOT}`); await p.waitFor(`${SHOT} !== window.__shot`, 20000); };   // the code on the stage changes
try {
  srv = await serve(+process.env.PORT || 0); A = `http://127.0.0.1:${srv.port}`; B = `http://localhost:${srv.port}`;   // two names, one server: two sites to a browser
  b = await launch();
  await t('sender: text is sent as note.txt, focus moves to Pause, the status shows speed and a check code', async () => {
    const p = await b.page(A + '/send/', { width: 1280, height: 800 });
    await p.click('#sendtext'); assert.match(await txt(p, 'err'), /Type or paste/);
    await p.eval("document.getElementById('text').value = 'hello from the test '.repeat(40)"); await p.click('#sendtext');
    await p.waitFor("!document.getElementById('play').hidden"); assert.equal(await txt(p, 'fname'), 'note.txt');
    assert.equal(await p.eval('document.activeElement.id'), 'pause');
    await p.waitFor("!document.getElementById('fok').hidden", 30000);   // a tiny file has been shown in full within a second of the stream starting
    assert.match(await txt(p, 'fstat'), /^Showing for \d+:\d\d · pass \d+ · a phone needs about \d+ s/); assert.match(await txt(p, 'fdet'), /up to \d+ KB\/s · check code [0-9a-f]{4} [0-9a-f]{4}$/);
    clean(p); await p.close();
  });
  await t('sender: Pause and Resume labels, and the label is Pause again after Stop and a new file', async () => {
    const p = await b.page(A + '/send/?demo=text', { width: 1280, height: 800 }); await p.waitFor(STREAMING);
    await p.click('#pause'); assert.equal(await txt(p, 'pause'), 'Resume'); assert.equal(await txt(p, 'fstat'), 'Paused');
    const f1 = await p.eval(SHOT); await w(500); assert.equal(await p.eval(SHOT), f1, 'frames must not advance while paused');
    await p.click('#close'); assert.equal(await hid(p, 'play'), true); assert.equal(await p.eval('document.activeElement.id'), 'drop');
    await p.click('#demotxt'); await p.waitFor("!document.getElementById('play').hidden"); assert.equal(await txt(p, 'pause'), 'Pause');
    await p.waitFor(STREAMING); await moving(p);   // frames must advance
    clean(p); await p.close();
  });
  await t('sender: Codes 4 gives a 2 by 2 block; every layout keeps whole device pixels per module', async () => {
    const p = await b.page(A + '/send/?demo', { width: 1200, height: 1200 }); await p.waitFor(STREAMING);
    await p.eval("(() => { const k = document.getElementById('k'); k.value = '4'; k.onchange(); })()"); await moving(p); await w(300);   // the next frames use the new layout
    const g = await p.eval("(() => { const c = document.getElementById('qr'), r = c.getBoundingClientRect(); return { w: c.width, h: c.height, px: r.width * devicePixelRatio / c.width }; })()");
    assert.equal(g.w, g.h, 'a 2 by 2 block is square'); assert.ok(Math.abs(g.px - Math.round(g.px)) < 0.01 && g.px >= 3, 'module pixels ' + g.px);
    assert.match(await txt(p, 'fdet'), /2 by 2 grid of v\d+/);
    // Show the entry code large: it fills the stage for 5 seconds, then the stream comes back
    await p.click('#join'); await p.waitFor(`!(${STREAMING})`, 4000).catch(() => { throw new Error('the entry code did not fill the stage after a click'); });
    await p.waitFor(STREAMING, 30000).catch(() => { throw new Error('the stream did not come back after the large entry code'); });
    clean(p); await p.close();
  });
  await t('receiver: first screen is clean, nothing to discard or delete, no errors', async () => {
    const p = await b.page(A + '/receive/', { width: 390, height: 844 }); await w(400);
    for (const id of ['discard', 'clear', 'histh', 'scan']) assert.equal(await hid(p, id), true, id);
    assert.equal(await txt(p, 'homemsg'), ''); assert.equal(await txt(p, 'homenote'), ''); clean(p); await p.close();
  });
  await t('pages refuse to show inside a frame from another site, and still show in a frame of their own site', async () => {
    const framed = "(() => { try { return document.querySelector('iframe').contentDocument.documentElement.hidden; } catch (e) { return 'cross'; } })()";
    for (const [parent, want] of [[B, true], [A, false]]) for (const page of ['send/', 'receive/']) {
      const h = await b.page(A + '/' + page, { width: 400, height: 400 }); assert.equal(await h.eval('document.documentElement.hidden'), false, 'the page shows when it is not framed'); await h.close();
      // the reference picture first: the same parent page around an empty frame
      const p = await b.page(parent + '/tests/fixtures/frame.html?u=about:blank', { width: 800, height: 600 }); await p.waitFor('window.frameLoads >= 1'); await w(200); const empty = await p.screenshot();
      // then the page under test in that frame. Its load event comes after its scripts have run, so the refusal has happened by then
      await p.eval(`window.frameLoads = 0; document.querySelector('iframe').src = ${JSON.stringify(A + '/' + page)}`); await p.waitFor('window.frameLoads >= 1');
      assert.equal(await p.eval("document.querySelector('iframe').contentWindow.length >= 0"), true);
      if (want) {
        assert.equal(await p.eval(framed), 'cross');
        // a page that draws anything never matches the empty frame; a late repaint only delays the match
        let same = false; for (let i = 0; i < 25 && !same; i++) { same = empty.equals(await p.screenshot()); if (!same) await w(200); }
        assert.ok(same, 'a page framed by another site must draw nothing');
      } else assert.equal(await p.eval(framed), false);
      await p.close();
    }
  });
  await b.close(); b = null;
  await t('sender under reduced motion waits for Start stream', async () => {
    const b2 = await launch(['--force-prefers-reduced-motion']); try {
      const p = await b2.page(A + '/send/?demo=text', { width: 1280, height: 800 }); await p.waitFor("!document.getElementById('play').hidden"); await w(1500);
      assert.equal(await txt(p, 'pause'), 'Start stream'); assert.match(await txt(p, 'fstat'), /^Ready/);
      const f1 = await p.eval(SHOT); await w(600); assert.equal(await p.eval(SHOT), f1);
      await p.click('#pause'); assert.equal(await txt(p, 'pause'), 'Pause'); await moving(p); clean(p);
    } finally { await b2.close(); }
  });

  // ---- two streams: screens of the demo picture (stream P) and of the demo text (stream T), filmed by the camera simulator
  async function screens(demo, n) { const bb = await launch(); try { const p = await bb.page(`${A}/send/?test&demo=${demo}`, { width: 1280, height: 720 }); await p.waitFor('window.__qrsStep && 1'); const out = []; for (let i = 0; i < n; i++) { await p.eval('__qrsStep(1)'); out.push(shoot(await p.eval('__qrsGrab()'), 1280, 720, { seed: i + 1 })); } return out; } finally { await bb.close(); } }
  let filmed; const streams = () => filmed ||= (async () => ({ P: await screens('picture', 45), T: await screens('text', 30) }))();
  // Put in the page before the camera starts: notes every stream the receiver collects (by its length) and every time its percentage falls,
  // from each write the page makes to window.__qrs. A poll from here could miss a stream that was on screen for a moment.
  const RECORD = `(() => { let cur; const log = window.__log = { lens: [], falls: 0 }; Object.defineProperty(window, '__qrs', { configurable: true, get: () => cur, set: v => { if (v && v.len) { if (log.lens[log.lens.length - 1] !== v.len) log.lens.push(v.len); else if (cur && v.pct < cur.pct) log.falls++; } cur = v; } }); })()`;
  // Chrome plays the feed file in a loop and the page starts reading at no fixed picture of it, so every feed below is built to give the same
  // result wherever reading starts and however often the file wraps.
  async function receive(frames, ms = 90000) {
    const feed = feedFile('ui'); writeY4M(feed.file, 1280, 720, 10, frames);
    try {
      return await retryFrozenCamera(async () => {
        const bb = await launchCamera(feed.file);
        try {
          const p = await bb.page(A + '/receive/?debug', { width: 420, height: 860 }); await p.eval(RECORD); await p.click('#start'); let r;
          try { r = await p.waitCamera('window.__qrs && window.__qrs.done ? window.__qrs : null', ms); }
          catch (e) { e.message += `. Receiver: progress ${JSON.stringify(await p.eval('window.__qrs || null').catch(() => '?'))}, streams ${JSON.stringify(await p.eval('window.__log').catch(() => '?'))}, camera pictures ${await p.cameraFrames().catch(() => '?')}, status "${await txt(p, 'stat').catch(() => '?')}", hint "${await txt(p, 'hint').catch(() => '?')}", message "${await txt(p, 'homemsg').catch(() => '?')}", console ${JSON.stringify(p.logs.slice(-3))}`; throw e; }
          await p.waitFor("!document.getElementById('result').hidden"); clean(p); return { r, log: await p.eval('window.__log'), dname: await txt(p, 'dname'), hash: await txt(p, 'dhash') };
        } finally { await bb.close(); }
      });
    } finally { feed.remove(); }
  }
  await t('receiver: one stray screen of another stream does not wipe the transfer', async () => {
    // one screen of T in every pass of the file: never 3 different T frames in a row, so the receiver must stay on P and keep what it has
    const { P, T } = await streams(), { r, log, dname, hash } = await receive([...P.slice(0, 8), T[0], ...P.slice(8)]);
    assert.equal(r.name, 'qrstream-demo.jpg'); assert.match(dname, /received in [\d.]+ s \(\d+ KB\/s\)/); assert.match(hash, /^Check code [0-9a-f]{4} [0-9a-f]{4}/);
    assert.equal(log.lens.length, 1, 'the receiver left the picture stream: ' + JSON.stringify(log)); assert.equal(log.falls, 0, 'progress fell back: ' + JSON.stringify(log));
  });
  await t('receiver: when the screen really changes to another file, it follows', async () => {
    // 3 s of P (8 screens over and over: never enough to finish P), then 9 s of T, in a loop. Wherever reading starts, the receiver ends on T:
    // from P it follows to T; from late in T it is taken back by the 3 s of P and then follows to T again with 9 s to finish it (T needs about 1 s).
    // The test proves the switch only when P was collected before T finished, so a run that began inside T and finished there is filmed again.
    const { P, T } = await streams(), hold = Array.from({ length: 30 }, (_, i) => P[i % 8]); let got;
    for (let i = 0; i < 3 && !(got && got.log.lens.length > 1); i++) { if (got) console.log('note: the receiver began inside the second stream and finished it there; filming again to see the switch'); got = await receive([...hold, ...T, ...T, ...T]); assert.equal(got.r.name, 'qrstream-demo.txt'); }
    assert.ok(got.log.lens.length > 1, 'in 3 runs the receiver never collected the first stream before the second finished, so the switch was not tested: ' + JSON.stringify(got.log));
  });
} catch (e) { fail++; console.log('FAIL (the test run itself broke) - ' + (e.stack || e.message)); }
finally { if (b) await b.close().catch(() => { }); if (srv) { srv.close(); srv.closeAllConnections(); } }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
