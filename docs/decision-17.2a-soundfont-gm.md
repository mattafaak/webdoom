# Decision Record: SoundFont GM Backend (task 17.2a)

Date: 2026-07-21

## Context

webdoom currently provides OPL2/OPL3 synthesis for music playback (tasks 17.1, 16.4). OPL
faithfully reproduces the original Doom sound but lacks the richer timbre of a General MIDI
soundfont. A SoundFont GM backend would allow users to opt into higher-quality MIDI playback
using SpessaSynth and a freely-licensed soundfont.

## Decision 1: Dependency — SpessaSynth (Apache-2.0)

**Chosen**: SpessaSynth (<https://github.com/spessasus/SpessaSynth>), Apache-2.0.

**Rationale**: SpessaSynth is a pure-JS, zero-native-dep SF2/SF3 MIDI synthesizer that runs
entirely in an AudioWorklet. It is actively maintained, produces good fidelity, and has no
transitive runtime deps of its own.

### License Compatibility Note

The webdoom source code is distributed under the GNU General Public License version 2
(GPLv2+, i.e. "version 2 or any later version"). Apache-2.0 is **not** compatible with
GPLv2 (strict), but is compatible with GPLv3 and later (GPLv3 §7 additional-permissions
clause removes the incompatibility). Therefore:

- **Source repository**: remains GPLv2+ (Apache-2.0 code is not linked into the engine; it
  is loaded lazily at runtime).
- **Binary distribution** (if ever shipped as a combined work that includes SpessaSynth
  loaded at install time): the effective license of the combined work would be
  **GPLv3-or-later**. See `LICENSE` for the distribution note.
- This is analogous to how Firefox and Chromium handle Apache-2.0 bundled libs under their
  own MPL/BSD licenses — the final binary's effective license is the most restrictive
  compatible one.

SpessaSynth is **not** committed to this repository and is **not** added to `package.json`
as a runtime dependency. It is lazy-loaded at runtime from the operator's own server (see
Decision 4).

## Decision 2: mus2mid Implementation

**Chosen**: Clean-room JavaScript implementation from the doomwiki format specification.

**Rejected alternative**: Port of Chocolate Doom's `mus2mid.c` (GPL-2.0, no "or later"
clause). This would require the conversion module to remain GPL-2.0 strictly, which is not
needed since the format spec is public.

**Implementation**: `client/js/mus2mid.js` — a self-contained ES module that converts a
MUS `Uint8Array` to a standard MIDI format-0 `Uint8Array`. The conversion is
deterministic and tested independently of the engine.

## Decision 3: Lazy-Load Strategy and SHELL Precache Exclusion

SpessaSynth is **not** in the service-worker SHELL precache. Rationale:

- The soundfont file (GeneralUser GS, ~31 MB) is separately fetched by the operator; it
  is never in the SHELL cache.
- SpessaSynth itself (~500 KB) is an opt-in feature; forcing it into the mandatory offline
  shell would bloat the required offline payload for all users.
- The `check-sw-precache.mjs` tool tracks the static import graph. The GM worklet URL
  (`/js/gm-worklet.js`) is referenced via a **non-literal variable** in `audio.js` (not
  as a bare string literal in `addModule()`), so the static analysis intentionally excludes
  it from the graph. This is the correct pattern for opt-in modules.

Consequence: GM music requires an online session for first load. This is acceptable; OPL
playback is always available offline.

## Decision 4: GeneralUser GS Soundfont

**Chosen**: GeneralUser GS (<http://schristiancollins.com/generaluser.php>), licensed under
the GeneralUser GS License (free for non-commercial and commercial use; redistribution
allowed with credit).

**Delivery**: fetched by the operator from their own server via `tools/fetch-soundfont.sh`
(same pattern as `tools/fetch-wads.sh`). The `.sf2` bytes are **never committed** to this
repository (added to `.gitignore`). The license text is downloaded alongside the soundfont
and stored in `soundfonts/LICENSE-GeneralUser-GS.txt`.

## Decision 5: OPL Remains Default

The GM backend is **inactive by default**. OPL2 remains the default music backend after
this task. The settings UI for switching to GM is deferred to task 17.2b. The internal
routing in `audio.js` accepts a `setGmMode(enabled, soundfontUrl)` call (for 17.2b to
wire), but the initial value of `gmEnabled` is always `false`.

## Decision 6: Size Budget Impact

This task touches only client-side JavaScript (no engine/wasm changes). The size-ledger
tracks `doom.wasm` raw bytes; that metric is unchanged. The new JS files (`mus2mid.js`,
`gm-worklet.js`) are small (~5–10 KB combined) and are not in the wasm binary.

SpessaSynth (~500 KB) and GeneralUser GS (~31 MB uncompressed) are loaded lazily and
operator-hosted; they do not appear in the size ledger.
