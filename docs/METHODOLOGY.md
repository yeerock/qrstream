# QRStream: methodology

How a file crosses from a screen to a camera with no network, as fast as a QR reader allows, and how we know it arrived intact.

## 1. The problem

A screen and a camera form a **one-way, lossy, unordered channel**. The camera sees some displayed frames sharply, some blurred, some twice, some not at all, and nothing tells the sender which. Any protocol that needs acknowledgements, retransmission of "frame 37" or a fixed order breaks here. So the design follows three rules:

1. **No back channel.** The sender never waits for the receiver.
2. **Every frame is useful.** A missed frame must never have to come round again.
3. **The end result is proven**, not assumed.

## 2. Pipeline

```
file ──gzip?──► pack(meta + bytes) ──► 142-byte source blocks ──► erasure code symbols
     ──► frame = header(20 B) + n symbols ──► CRC-32 ──► Base45 text ──► QR (v15..v40, level L)
     ──► 1–8 codes per screen ──► screen at 8–15 codes/s
                      ⋮  light  ⋮
camera ──► canvas pixels ──► Web Worker pool (own QR reader) ──► text ──► Base45 ──► CRC-32 check
     ──► erasure decoder ──► gunzip ──► SHA-256 check ──► preview / Open / Save / Share (OS share sheet)
```

| Layer | Choice | Why |
|---|---|---|
| Symbol | QR Model 2, ISO/IEC 18004, own encoder, error level **L** | Highest capacity. Error correction across frames is the erasure code's job; within a frame, L is enough because the CRC rejects any misread. |
| Text | Base45, RFC 9285, QR alphanumeric mode | 2 bytes in 3 characters, about 3 % less than byte mode, but every reader returns alphanumeric intact; some readers pass byte mode through a text decoder and corrupt bytes. |
| Integrity per frame | CRC-32 (IEEE 802.3) | A QR misread into another valid QR never reaches the decoder. |
| Erasure code | Systematic random linear fountain over GF(2), generations of 1,024 blocks | See section 3. |
| Integrity of the file | SHA-256 of the original file | End-to-end proof, shown to the user. |
| Locating damage | CRC-32 of the metadata and of each body chunk, carried in the metadata (fields `cs`, `c`, `m`; receivers that do not know them ignore them) | A wrong symbol that passed the frame CRC is found, and only the damaged blocks are read again. A repair symbol that adds no information must also cancel to zero data; one that does not is refused and counted. Limit: repair symbols are spread over all generations, so refilling one whole generation of a large file takes about as long as the file took; the saving is real for small files, light damage and damage in the metadata. |
| Compression | gzip (CompressionStream) when it saves ≥ 10 % | Text, logs, CSV, JSON shrink 3 to 10×. Media are skipped. |

### Frame format (version 3)

| Bytes | Field |
|---|---|
| 0–1 | Magic `A5 51` |
| 2 | Format version (3) |
| 3 | reserved |
| 4–7 | Stream id (random per transfer) |
| 8–11 | Packed length |
| 12–15 | Seed of the first symbol |
| 16–19 | CRC-32 of the frame (computed with these 4 bytes skipped) |
| 20… | n symbols of 142 bytes, seeds `seed … seed+n-1` |

A packed transfer is `[u16 JSON length][JSON {name, mime, sha256, size, z?, title, at}][body]`.

## 3. The erasure code (the main speed lever)

**Goal:** the receiver should finish after collecting barely more symbols than the file has blocks, whatever the loss pattern.

* **Systematic:** seeds `0 … K-1` carry the source blocks themselves. With no loss, the file is done after one pass and costs nothing extra.
* **Interleaved:** source seed `i` carries block `(i · p) mod K`, with `p` coprime to K and larger than a generation. One lost frame (20 consecutive seeds) then costs every generation a little, instead of one generation a lot.
* **Repair symbols:** seed `s ≥ K` belongs to one generation of 1,024 blocks (chosen in proportion to the generation size) and is the XOR of a pseudo-random half of that generation's blocks. Row bits come from a non-linear hash (MurmurHash3 `fmix32`).
* **Decoder:** incremental Gaussian elimination over GF(2) per generation. Each arriving symbol is reduced against the pivot rows already held and either becomes the pivot row of one more block or is dropped as redundant, so a generation never holds more than one 272-byte row per block and no elimination is ever repeated. A generation is solved by one back-substitution when its pivots and known blocks cover it. A random binary matrix reaches full rank about 2 rows after it becomes square, so the overhead is a few symbols per generation whatever the frame loss.

Background: random linear network coding (Ho et al., *IEEE Trans. Inf. Theory* 52(10), 2006, doi:10.1109/TIT.2006.881746); generation-based coding (Chou, Wu, Jain, *Allerton* 2003); fountain and LT codes (Luby, *FOCS* 2002, doi:10.1109/SFCS.2002.1181950); inactivation decoding in RaptorQ (RFC 6330).

### What we measured, and two bugs that taught us something

Symbols needed beyond the file, in simulation with frame loss (`node tests/codec.test.mjs`, plus a benchmark sweep):

| File | Frame loss | Earlier LT code (robust soliton, peeling) | Current code |
|---|---|---|---|
| 48 KB | 30 % | +24 % | **+2.0 %** |
| 292 KB | 50 % | +23 to 30 % | **+4.1 %** |
| 1 MB | 20 % | +41 to 46 % | **+2.1 %** |
| 1 MB | 50 % | +34 to 40 % | **+1.6 %** |
| 4 MB | 30 % | +42 % | **+1.6 %** |

1. **LT with a systematic start wastes symbols.** Robust soliton is tuned for non-systematic LT. After the source pass, low-degree repair symbols mostly cover blocks the receiver already has. At the point where peeling stalled, about 11 % of received symbols carried no new information.
2. **A GF(2)-linear PRNG cannot build a random GF(2) matrix.** The first dense version used xorshift to pick row bits. xorshift is linear over GF(2), so every row was a linear function of a 32-bit state and a generation never reached a rank above about 33. The decoder never finished. A non-linear hash fixed it. This bug is invisible with sparse LT degrees.
3. **Loss is bursty, generations must not be.** Without interleaving, one dropped frame removed 20 blocks from one generation, the losses per generation ranged from 24 to 112, and equal repair shares meant waiting for the worst one. Interleaving plus 1,024-block generations brought the spread close to binomial.

## 4. Density and rate (the second speed lever)

| QR version | Modules | Symbols per code | Bytes per code |
|---|---|---|---|
| 40 | 177 × 177 | 20 | 2,840 |
| 33 | 149 × 149 | 13 | 1,846 |
| 25 | 117 × 117 | 8 | 1,136 |
| 15 | 77 × 77 | 3 | 426 |

* **Several codes per screen.** The reader decodes up to 9 codes in one camera picture (8 stream codes and the entry code), so a wide screen shows two rows of four smaller codes, a square one a 2 by 2 grid, and a small one a single code. Many smaller codes fill a wide screen better than a few large ones: version 40 is 177 modules high and cannot use the rest of the height. In the end-to-end test (10 screens a second on the simulated camera) a 400 KB file took 8.0 s with two v40 codes and 7.0 s with eight v22 codes; an earlier run of a 300 KB file needed 140 screens with 1 code, 75 with 2 and 53 with 3.
* **Rate.** 8 to 15 codes per second per slot. At 15/s each code is still on screen for about 2 camera frames at 30 fps, which avoids frames torn between two codes.
* **No back channel, so Auto cycles.** The sender steps through five levels every 15 s. Symbols are 142 bytes at every level, so a change never invalidates what the receiver holds.
* **Sharp pixels.** Every module is a whole number of device pixels (`image-rendering: pixelated`) with a 4-module quiet zone.
* Raw peak: 3 codes × 2,840 B × 15/s ≈ **128 KB/s (about 1 Mbit/s)**.

## 5. The QR reader (written for this stream)

General-purpose readers spend most of their time on cases this stream never has. Ours knows the stream is level L, alphanumeric or byte mode, versions 10 to 40, and up to 8 stream codes in one picture (one or two rows of up to 4) plus the sender's small entry code.

1. **Binarise**: luma, then a threshold per 8×8 block taken over its 5×5 neighbourhood and weighted by contrast (blank white areas between stacked codes must not pull it toward white; the weighting fades out where white clips on an overexposed screen), which handles glare and uneven light.
2. **Finder patterns**: row scans for 1:1:3:1:1 runs, confirmed vertically, horizontally again and diagonally. Repeated hits are merged and counted as confidence.
3. **Triangles**: three finders that form a right isosceles triangle with matching module sizes, ranked by geometry error and confidence. A finder is claimed only by a successful decode, so several codes per picture work.
4. **Size from timing patterns**: count the dark and light runs along module row 6 and column 6 between finder centres. A code of size *d* has exactly *d − 12* runs. This works under any perspective, rejects false triangles in a few hundred samples, and replaced trial decoding (the reader went from 122 ms to 25 ms per 1080p frame). A blurred timing module often shrinks to one pixel between two fat ones; short runs are merged only when they sit inside one module, a swallowed module counts as the modules it spans, and a second count on the grey picture gives a second opinion. Before this, 140 of 153 diagnosed misses on stacked and grid layouts were a size counted 4 too small. Measured on 2,940 synthetic camera pictures in seven layouts: 152 of 7,560 codes missed before, 0 after, no wrong text, mean read time 6 % lower.
5. **Grid lock**: the fast lock finds six well-spread alignment patterns (centre of each band, centre, bottom right), refitting a least-squares homography (normalised DLT) after each one. If that decode fails, the full lock visits every alignment pattern nearest the finders first, and sampling can switch to one map per cell between alignment patterns (lens distortion, curved screens). Alignment positions are refined to 1/8 module.
6. **Decode**: format and version information by nearest BCH code word (up to 3 bit errors), unmask, de-interleave, then Reed-Solomon per block (Berlekamp-Massey, Chien search, Forney; up to 15 byte errors per v40 block).

Tests (`tests/reader.test.mjs`) draw our own encoder's codes through a projective camera model with rotation, blur, noise, uneven light, 180°, three codes per picture and 120 flipped modules. In a sweep of 90 codes (3 per picture, perspective 0.1, blur, 3.5 to 4 px per module) all 90 decode. The floor is about 3 px per module.

## 6. Smart mode and the coach (hands-free)

* The sender measures its stage in device pixels and lists the layouts (version × codes per screen) with at least 3 px per module.
* **A** is the highest-capacity layout with at least 4 px per module, **B** the best one with at least 5 px below A, and **C** a safe one with at least 7 px.
* The stream plays **A A A B A A B C** with 15, 12 and 10 codes per second. With a fountain code every frame adds information, so throughput follows the best tier the camera can read, with no probing and no waiting.
* The receiver records which frame sizes it decodes. It says nothing while all is well, and asks the user to move closer, hold steadier or reduce glare only when the fast tier is not getting through.
* Entry: the link code fills the stage for 2.5 s and then stays in a corner of the sender bar, so it costs the stream no time. The phone's camera app opens the receiver, which starts its camera by itself. Common picture, video, audio, PDF and text types save by themselves on Android and computers; other types wait for a tap.
* Layouts: Smart mode tries every QR version from 10 to 40 in one or two rows of 1 to 4 codes (up to 8 codes a screen) and keeps what carries most: on a Full HD screen two rows of four v22 codes carry 81 KB/s where two v40 codes carried 71. A layout must give modules of at least 3 device pixels and 2 CSS pixels and fit 560 by 315 modules, which is what a 1920 by 1080 camera picture resolves at about 3.4 pixels per module.

## 7. Receiver engineering

* The camera is requested at up to 4K with continuous focus; frames are scaled to at most 1,920 px and handed to 1 to 3 workers. A screen wake lock is held.
* The progress bar shows rank (solved blocks plus independent equations waiting), so it does not jump.
* The result shows in the camera box: image, video, the start of docx, xlsx and pptx (own ZIP and XML reader), text, or a card for PDF and other types (Open uses the device's own viewer). Below it are **Open, Save, Share** (Web Share API, the OS share sheet) and **Email**.
* The last 20 files are kept in IndexedDB on the device. It works offline through a service worker.

## 8. Security model

| Threat | Mitigation |
|---|---|
| Hostile file runs script when opened | MIME allowlist. HTML, SVG, XML and JavaScript become `text/plain`, unknown types become `application/octet-stream`. Tested with a hostile HTML file through the full pipeline. |
| Data leaves the device | No server. CSP `default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and no referrer. |
| Forged or corrupted frames | Magic, version and CRC-32 checks. A length under 3 bytes or over 16 MB is ignored. The decoder holds at most one row per block and does one reduction per symbol, so a stream that never completes cannot grow memory or stall the page (tests/decoder.test.mjs). |
| Decompression bombs | gunzip is streamed and capped at 64 MB. Document previews count the inflated bytes and stop at 4 MB. |
| Unsafe filenames | Names are reduced to `[A-Za-z0-9_.-]` with no leading dots, at most 120 characters. |
| Supply chain | No third-party code at all, no CDN, no build step, no npm packages (not even for tests). |
| Shoulder surfing | Inherent to an optical link: anyone filming the screen receives the file. Do not stream secrets on a screen others can see. Encrypt first if needed. |

## 9. Verification

* `npm test`: the codec (Base45 against the RFC 9285 vector, QR capacity, CRC tamper rejection, decoding at 0 to 50 % frame loss with density changes), the reader (32 picture cases, see section 5), the decoder (edge sizes, bursty loss, late join, a hostile stream that never completes) and repair (a damaged source or repair symbol, damaged metadata, a forged frame, streams from senders without checks, the wire format against an older core).
* `npm run ui`: the pages in a real browser: sender controls, text sending, reduced motion, refusal inside another site's frame, a stray screen of another stream, a real change of stream.
* `npm run e2e`: **the real camera path**. The real sender page draws its stream, our camera simulator films each screen into a raw `.y4m` file, Chrome uses it as its webcam (`--use-file-for-fake-video-capture`), and the real receiver page decodes it and must match the SHA-256 with no CSP violation or exception. It is driven by our own Chrome DevTools Protocol client (`tests/cdp.mjs`).
* Measured (this machine, through the camera path): 300 KB of random data in 11.9 / 6.8 / 4.7 s with 1 / 2 / 3 codes at 10 screens/s; 2.1 to 2.3 s (128 to 137 KB/s) at 3 codes and 30 screens/s; Smart mode 4.5 s on a 1080p screen and 7.0 s on 720p; a 334 KB log in 0.9 s.
* `npm run demo-video`: builds `docs/demo.webm` from a real e2e run, recorded in Chrome with MediaRecorder.

## 10. Limits and roadmap

* Not yet measured with physical cameras across phone models. The numbers above come from the camera simulator, which models tilt, blur, noise and light but not rolling shutter or screen flicker. Field results will be added.
* Colour codes (three channels) could triple density again, but they need a custom decoder robust to camera white balance.
* Smart mode could become closed-loop with an optional optical back channel (the phone's screen filmed by the sender's webcam) could stop the stream early and pick the density adaptively.
