// Test fixture for tests/ui.test.mjs only: frames the page named in ?u= and counts the frame's load events, so the test can wait for the framed page
// and see that it refuses to draw inside another site's frame. It works on a local test server only, and only with a local http(s) address:
// on a published copy of this repository it does nothing.
window.frameLoads = 0;
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  const f = document.querySelector('iframe'); f.addEventListener('load', () => { window.frameLoads++; });
  const raw = new URLSearchParams(location.search).get('u') || ''; let u = null; try { u = new URL(raw, location.href); } catch (e) { }
  if (raw === 'about:blank') f.src = raw;   // an empty frame, for the comparison picture
  else if (u && /^https?:$/.test(u.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) f.src = u.href;
}
