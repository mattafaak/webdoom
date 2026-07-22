# Decision Record: GUS Flavor (task 17.3)

Date: 2026-07-22

## Context

DOOM's original DOS executable supported Gravis Ultrasound (GUS) soundcard output via
the DMX sound library. GUS playback was controlled by a `DMXGUS` lump embedded in the
WAD, which mapped the 175 MUS voice/instrument numbers (0–174) to Gravis patch numbers
(0–127). The task asks whether webdoom can ship a "GUS flavor" that honors this mapping.

The `DMXGUS` lump is WAD data (user-owned, same as `GENMIDI`). Using its mapping table
to influence playback raises no licensing question. The question is about the *patch files*
that supply the audio.

## Licensing Research

### Original Gravis Ultrasound patches

The GUS patches shipped on floppy disk with the Gravis Ultrasound card (Advanced Gravis
Computer Technology Ltd., later Kensington). They are **proprietary commercial assets**.
No public license has been issued granting redistribution rights. Hosting or auto-fetching
them is not permissible.

Primary source consulted: the patches themselves carry no license text; the soundcard
documentation grants the purchaser a right to use, not redistribute.

### eawpats (Eric A. Welsh patch set)

`eawpats` is a widely-used Linux package that derives from the original Gravis patches
with substitutions and additions by Eric A. Welsh. Its `README` historically stated "freely
redistributable," but Debian's ftpmaster ruled otherwise: eawpats was moved to `non-free`
and then removed from the Debian archive entirely (~2016) on the grounds that the
redistribution claim was unsubstantiated relative to the underlying Gravis patch provenance.
Ubuntu followed. The package is absent from current Debian/Ubuntu main and non-free trees.

**Verdict**: redistribution rights unverified; do not auto-fetch or bundle.

### FreePats

<https://freepats.zenvoid.org/> provides openly-licensed GUS-format `.pat` files
(various CC0 / GPLv2+ per instrument). These are **independently created**, not derived
from the Gravis patches, and are freely redistributable. They target General MIDI
instrument numbering, not the Gravis-specific patch set.

FreePats would enable a genuine `.pat`-file playback path, but that requires implementing
a GUS/timidity-style `.pat` synthesizer in JS — a separate, substantial effort. Deferred
as a named follow-on; not part of this task.

### DMXGUS lump itself

The `DMXGUS` lump is part of the IWAD (Doom, Doom II, etc.). It is the user's WAD data.
Using the mapping table it contains — which voice maps to which patch number — is
equivalent to reading `GENMIDI` for OPL: the data is user-supplied, not redistributed by
webdoom. This raises no licensing question.

## Decision

**GREEN-LIT** for the following specific form:

| Component | Status | Rationale |
|-----------|--------|-----------|
| Original Gravis patches | NOT USED | Proprietary; no redistribution right |
| eawpats | NOT USED | Redistribution-unclear; Debian dropped ~2016 |
| FreePats (.pat synth path) | DEFERRED | Freely-licensed but requires `.pat` synthesizer (out of scope) |
| DMXGUS lump (mapping table) | USED | WAD-owned; user data; no redistribution |
| GeneralUser GS SF2 (17.2a) | USED | Clean license (GeneralUser GS License); operator-fetched |
| SpessaSynth (17.2a) | USED | Apache-2.0; lazy-loaded; same as 17.2a |

**What "GUS flavor" means in this implementation:**

The `musToMidi()` converter accepts an optional `dmxgusMap` parameter (a `Uint8Array`
of length 175). When provided, MUS controller-0 (instrument-change) events use
`dmxgusMap[instrumentValue] & 0x7f` as the MIDI program number instead of the raw MUS
instrument value. This means instrument selection in the MIDI output follows the mapping
the WAD author intended for GUS playback rather than treating MUS values as GM program
numbers directly.

Audio synthesis is handled by the existing SF2 stack (SpessaSynth + GeneralUser GS).
The GUS flavor and the GM flavor share the same synthesizer; they differ only in which
GM program numbers are written into the MIDI stream.

**Delivery**: `audio.setDmxgus(map)` accepts a **pre-parsed** `Uint8Array[175]` lookup
table (index = MUS instrument number, value = remapped GM program) and passes it to
`musToMidi()`. This API is parallel to `audio.setGmMode()` and `audio.musToMidi`.
Note: the raw `DMXGUS` lump is **text-format** (175 comma-separated lines) — feeding raw
lump bytes to `setDmxgus()` would be garbage. The future engine wiring
(`W_CheckNumForName` → text parse → `setDmxgus`) must include that parse step.

## Non-decisions (explicitly parked)

- Engine-side wiring (`W_CheckNumForName("DMXGUS")` → text-format parse →
  `setDmxgus()` call): deferred to a follow-on task, mirroring the 17.2b
  operator-deferral pattern. `setDmxgus()` is test-injection-only until then.
- A `.pat`-file synthesizer path (FreePats or user-supplied `.pat` files): parked pending
  demand; would require a timidity-style `.pat` renderer.
- Bundling or auto-fetching any GUS patch files: explicitly prohibited by the licensing
  findings above.
- Supporting DMXGUS without the SF2 backend: not a goal — DMXGUS mapping only has
  audible effect when GM mode is active.

## Size / licensing impact

No new dependencies. No new files bundled or fetched. Size delta: ~20 lines in
`mus2mid.js`, ~10 lines in `audio.js`. The `DMXGUS` bytes come from the user's WAD and
are never committed to this repository.
