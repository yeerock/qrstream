// One QR reader in a worker: the page hands it camera frames as pixels and gets back the text of each code. Own reader (core/qrread.js), no library.
importScripts('../core/qrtx.js' + self.location.search, '../core/qrread.js' + self.location.search);   // the page's version, so a new page never runs an old cached reader
self.onmessage = e => {
  try {
    const { w, h, buf } = e.data;
    self.postMessage({ texts: QRREAD.read({ data: new Uint8ClampedArray(buf), width: w, height: h }, 9) });
  } catch (x) { self.postMessage({ texts: [], error: String(x) }); }
};
