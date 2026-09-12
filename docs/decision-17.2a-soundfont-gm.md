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
- The `check-sw-precache.mjs` tool tracks the static import graph, and nothing GM-side
  enters it: SpessaSynth is fetched from an operator-supplied URL at arm() time, not
  imported.

  **CORRECTION (2026-09-11, task 25.3).** This bullet used to read that
  `/js/gm-worklet.js` "is referenced via a **non-literal variable** in `audio.js`", which
  is why the precache excluded it. That was not true, and had not been true since 17.2b:
  `audio.js` contains no reference to that file under any spelling — the only
  `addModule()` call in the file is the OPL one, `addModule('js/music-worklet.js')`. The
  17.2b redesign moved SpessaSynth to the main thread (`Synthetizer(targetNode, sf2)`
  builds its own worklet chain and cannot be nested inside a foreign processor), which
  orphaned `gm-worklet.js` entirely; this document was never amended, so a dead file kept
  a live-sounding justification. `tools/gm-frames-test.mjs` asserts
  `sink.kind === 'gm-main'` and names `'gm-worklet'` as the OLD design in its red-proof
  notes — the gate had been recording the file as superseded the whole time.

  The file is deleted as of task 25.3. It was a second, verbatim copy of
  `music-worklet.js`'s ring buffer (same queue, same offset bookkeeping, same
  `{queued, procMs}` port protocol), so the duplication cleanup had two options —
  parameterise one worklet for both, or delete the half nothing loads. Deleting is the
  honest one: parameterising would have preserved unreachable code behind an argument.
  Recover it from git history if a worklet-based GM sink is ever wanted again.

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

**Amendment, 2026-09-12 (task 25.1).** 17.2b wired two of the three parameters — the
backend picker (`settings.js`) and the soundfont bytes (`lobby.js`) — but never the
SpessaSynth URL this decision names. Nothing passed `setGmMode`'s third argument, so
`gmSpessaSynthUrl` was permanently `null`, `arm()` always took the SKIP branch, and the
GM backend could not activate under **any** configuration. It was not dead code — the
machinery is complete and the fallback is deliberately gated by `browser-sf2-test` [5] —
it was an unfinished integration that read as a delivered feature.

The operator supplies the URL through the server, matching how everything else here is
configured and keeping SpessaSynth operator-hosted per Decision 1:

```sh
WEBDOOM_SPESSASYNTH_URL=https://your.server/spessasynth/index.js ./start.sh
```

`serve.js` reports it at `GET /api/config` (`null` when unset) and `audio.js`'s `arm()`
reads it once per page. Gated by `tools/gm-config-test.mjs`. What that gate does **not**
prove is that SpessaSynth then loads and produces audible GM — it cannot, because
Decision 1 deliberately keeps SpessaSynth out of this repository, so there is nothing for
a test to load. That residual is stated rather than papered over.

## Decision 6: Size Budget Impact

This task touches only client-side JavaScript (no engine/wasm changes). The size-ledger
tracks `doom.wasm` raw bytes; that metric is unchanged. The new JS files (`mus2mid.js`,
`mus2mid.js`) are small (~5–10 KB) and are not in the wasm binary.
(`gm-worklet.js` was named here too; it was deleted in task 25.3 — see the correction above.)

SpessaSynth (~500 KB) and GeneralUser GS (~31 MB uncompressed) are loaded lazily and
operator-hosted; they do not appear in the size ledger.
