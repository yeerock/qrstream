// Test fixture for tests/ui.test.mjs only: frames the page named in ?u= so the test can see that a page refuses to draw inside another site's frame.
// It works on a local test server only, and only with an http(s) address: on a published copy of this repository it does nothing.
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  let u = null; try { u = new URL(new URLSearchParams(location.search).get('u') || '', location.href); } catch (e) { }
  if (u && /^https?:$/.test(u.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) document.querySelector('iframe').src = u.href;
}
