'use strict';
// First script on every page: a page framed by another site draws nothing, so taps cannot be tricked onto its buttons (a static host cannot send frame-ancestors).
try { if (top !== self && top.location.origin !== location.origin) throw 0; } catch (e) { document.documentElement.hidden = true; }
