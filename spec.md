# webdoom — product contract (spec SSOT)

Created: 2026-07-15. Precedence: this file > sub-specs > Plans.md.

## What webdoom is

A slim, modern, browser-native DOOM port built clean-room-forward from
`linuxdoom-1.10`: every inherited algorithm and data blob is either
*understood* (documented recipe), *proven equivalent* (to a faster
modern form), or *catalogued as irreducible canon*. The engine is the
closest practical thing to a bare-metal DOOM: minimal platform surface,
no filesystem, tightest routines, "runs on everything" — and runs
*well* on everything.

## Core tenets (in priority order)

1. **Accuracy is non-negotiable.** The simulation is vanilla-exact:
   all 13 IWAD demos replay tic-identical against golden traces and
   cross-validate against instrumented Chocolate Doom (44,580 tics).
   Any change that diverges a single P_Random call is wrong.
2. **Measure, don't assume.** No optimization lands without before/after
   numbers on the four reference hosts (wbox, tank, pi5, alder). A
   change that is within noise everywhere is judged on the universal
   axes instead: simpler, smaller, integer-exact, portability-forward.
3. **Code simplicity beats cleverness.** Prefer deleting code to adding
   it. The web platform layer, client, and server stay small enough to
   read in a sitting.
4. **Robustness of game, net, and menu code.** No input from the
   network, the WAD, or the user may corrupt memory or wedge a state
   machine. Fail soft, keep playing.
5. **Bare-metal adaptability.** The core ↔ platform contract is
   explicit, documented, and narrow, so a future no-OS port (ESP32 and
   below) starts from this repo's documentation, not from folklore.
6. **Understanding is verifiable and self-defending.** Every documented
   claim about the engine regenerates from a committed script (no
   "trust me" numbers); the demo-visible invariants the accuracy tenet
   depends on are enforced by the code at their exact call site, not
   merely described alongside it; and the platform contract is validated
   by an actual freestanding port, not asserted. Understanding is proven,
   reproduced, and load-bearing — or it isn't claimed. This applies to
   *published promises* too: every quantitative or behavioral claim in
   README.md and this spec maps to a gate, committed evidence, or an
   explicit FLAGGED entry — a promise without a gate is doc drift.

## Correctness gates (every change must pass)

- **Sim gate**: 13 golden demo traces tic-identical (`demo-test.mjs`);
  Chocolate cross-validation available for audits.
- **Render gate**: per-tic framebuffer hashes over the demo suite
  (render-golden harness, Phase 0) — renderer refactors must be
  pixel-identical unless the task explicitly declares a visual change.
- **Net gate**: 2- and 4-client relay tests with per-tic gamestate
  hashes; mid-game drop and drop-in survival.
- **Perf gate**: `bench.mjs` per-stage numbers on all four hosts;
  regressions on any host block, wins are recorded in
  `tools/golden/bench-baseline.json`. The browser-pipeline baseline
  (per-frame JS/GPU/audio cost, input latency) joins this gate once
  Phase 12 lands.

## Reference hardware fleet

| host | CPU | role |
|------|-----|------|
| wbox | AMD G-T56N (Bobcat) | weakest — the floor; optimizations target here first |
| tank | i5-8350U (Kaby Lake) | least optimized to date; slow 64-bit idiv |
| pi5 | Cortex-A76 (aarch64) | ARM reference; most improved from vanilla |
| alder | i9-12900K | fastest; dev host — fast here proves nothing |

## Netcode contract

Deterministic lockstep over a server tic relay (docs/netcode.md is the
protocol SSOT). Modernizations (jitter buffer, drop-in, fabricated-cmd
grace) never touch the simulation: clients execute sealed bundles only,
so desync stays impossible by construction. Transport remains a single
WebSocket port; a transport rewrite (WebRTC/UDP) is out of scope.
Measured 2026-07-19 (task 15.5, docs/netcode-numbers.md §3): inter-bundle
gap p99 = 33 ms (localhost) / 84 ms (wbox→alder via Tailscale) vs 28.57 ms
tic period; no TCP retransmit stalls observed; packet loss ≈ 0% on
LAN/Tailscale. HOL verdict: **no-WebRTC safe** — observed variance is
bounded by sealSweep (50 ms) and client processing, not TCP retransmit.

## Launcher fire background (visual contract)

The launcher/lobby gains a PSX-DOOM-style fire background:

- Classic indexed-byte fire propagation on a chunky low-res grid,
  nearest-neighbor upscaled — same pixel grain as the game.
- Palette drawn from the DOOM fire ramp (PLAYPAL black→red→orange→
  yellow→white indices); no colors foreign to the game's vibe.
- Steady state is **dimmed/muted** behind menus — menu text contrast
  and readability must be unaffected.
- **Flare-up** on menu transitions (brief intensity lift, then decay).
- Negligible cost: sim ticks at ~15–20 Hz decoupled from rAF, paused
  when the tab is hidden or the engine is running; measured budget
  < 1 ms/frame on wbox. `prefers-reduced-motion` gets a static frame.

**Implemented** (`client/js/fire.js`, task 4.1, commit f6d6c0a): 64×40
chunky grid, canonical 37-entry doomfire ramp, 16 Hz `setInterval` (rAF-
decoupled), sim-based flare (opacity fixed at 0.45 so contrast is never
harmed), `pause()` fully `clearInterval`s during play/hidden. **Measured
CPU cost per tick** (node microbench of sim + pixel-fill, best-of-10 ×
2000, 2026-07-16): alder 0.008 ms, pi5 0.022 ms, **wbox 0.072 ms** —
~14× under the 1 ms budget (the 2560-px `putImageData` blit is browser-
composited and negligible on top).

## Magic-data policy (from docs/engine-archaeology.md)

- Trig tables: boot-generated from cracked recipes + correction stream,
  checksum-guarded. gammatable, rndtable: irreducible canon, shipped.
  COLORMAP: recipe known, but WAD-owned and PWAD-overridable — always
  loaded, never regenerated.
- The only sanctioned table transform is shipped-blob → boot-generation.
  Runtime lookup → runtime transcendental is forbidden (measured slower).

## Deployment reality: insecure origins (decision record, 2026-07-21)

The primary player environment is plain-HTTP on a LAN/tailnet address
(`http://<host>:8666/` — exactly what `start.sh` advertises). That is an
**insecure context**: browsers withhold `navigator.serviceWorker` and
`AudioContext.audioWorklet` there. Contract:

- Every player-facing feature either works on insecure origins or
  degrades **loudly** (user-visible status line, never a swallowed
  `console.warn`). Music and WAD caching must work there via
  secure-context-free paths (IndexedDB, non-worklet audio sink).
- CI gains a dedicated insecure-origin leg (headless Chrome with
  `--host-resolver-rules="MAP insecure.test 127.0.0.1"`), because every
  existing browser gate runs on `127.0.0.1` — a secure context — and is
  structurally blind to this failure class (root cause of the 2026-07-21
  field reports: silent music, WAD redownloads).

## Music contract (decision record, 2026-07-21)

- **Default backend**: the in-engine MUS sequencer + Nuked OPL3 core
  programmed from the IWAD's own GENMIDI lump (zero-asset, DMX-faithful).
  An OPL2-voice (mono, 9 voices, authentic 1993) vs OPL3-mode (stereo,
  18 voices) toggle is render-side audio flavor; neither reads game state.
- **SoundFont GM backend** (optional, lazy-loaded): mus2mid + a worklet
  soundfont synth. Default font is GeneralUser GS (clean license) served
  from this project's own server with its license text alongside —
  **never a CDN**. User-loadable .sf2 via the local WAD/asset library.
  This is the project's first third-party JS runtime dependency; it is
  lazy-loaded, excluded from the SHELL precache unless deliberately
  added, and its size lands as an explicit size-budget line item.
- **GUS flavor** (decision record: `docs/decision-17.3-gus-flavor.md`,
  task 17.3, 2026-07-22): **GREEN-LIT** via DMXGUS mapping + existing
  SF2 stack. The original Gravis patches (proprietary, no redistribution
  right) and eawpats (redistribution-unclear; Debian dropped from non-free
  ~2016) are NOT used. DMXGUS lump is WAD-owned data; its 175-byte
  mapping table drives GM program selection in `musToMidi()`; audio
  synthesis comes from the operator-fetched SF2 (GeneralUser GS, same
  as 17.2a). No GUS .pat files are required, fetched, or redistributed.
- **Never bundled**: Microsoft GS wavetable, Roland ROMs/Nuked-SC55,
  provenance-unclear soundfonts. User-supplied files are fine.
- Determinism rule (unchanged): engine music state changes only via
  `S_*` calls driven by gamestate; sample generation only via JS pulls.
  A peer with no audio at all stays tic-identical.

## Widescreen view (decision record, 2026-07-21)

Sanctioned the same way freelook was: **render-side only, opt-in**.
Crispy-style Hor+ (vanilla vertical FOV and world scale; extra columns
are true rays). A wide player sees more of the world, including in MP —
accepted and recorded, like freelook. Hard rules:

- The 320×200 default path stays **byte-identical** (render goldens are
  never regolded for this; if they move, the change is wrong).
- Wide mode gets its own golden family per aspect bucket.
- Mixed-width netgames must remain per-tic sync-identical.
- The status bar keeps 4:3 proportions (centered, flat-filled flanks).
- Any client-side projection remap (progressive Panini/cylindrical for
  very wide aspects) is a post-process on the palettized image,
  off-by-default and outside all goldens.

## Browser matrix (task 15.2 decision record, 2026-07-19)

### Firefox — smoke-tested and kept

Verified on alder (Firefox 152.0.6, headless):
- Firefox headless loads the page, executes JS, registers the service
  worker, fetches `/api/wads` (lobby JS entry point), and fetches
  `doom.js` + `doom.wasm` via the service worker prefetch chain.
- Smoke assertion: `LOG_REQUESTS=1` server + Firefox headless on a
  dedicated port; gate checks Firefox UA + `/api/wads` in request log.
- Leg wired in `tools/run-tests.sh` (SKIP loudly when `/usr/bin/firefox`
  absent, so CI without Firefox is valid).

Limits of the smoke leg (honest):
- Does not assert game-boots-to-lobby in Firefox (no CDP equivalent for
  Firefox in this repo's tooling; geckodriver not present).
- Does not assert WebGL2 renders a frame; only proves JS executed and
  the WASM module was requested.
- AudioWorklet: Firefox headless does NOT arm AudioContext without a
  real user gesture — same headless limitation as Chrome. AudioWorklet
  timing is therefore n=0 in any headless run (either browser). See
  §C residual note in `docs/perf.md`.

Decision: README claim "stock Chrome / Edge / Firefox" is kept.
Gate: `run-tests.sh` firefox smoke leg.

### Safari / iOS — explicit non-goal

Safari and iOS are untested and not promised. No future task will add
Safari/iOS support without a separate decision record in this file.
Reason: WebKit's WebAudio and AudioWorklet behavior differ; testing
Safari would require macOS/iOS hardware not in the fleet; the target
audience is LAN/tailnet DOOM-night players who have Chrome/Firefox
available. This non-goal is recorded explicitly so the absence of
Safari coverage is documented policy, not oversight.

## Explicit non-goals

- Regenerating COLORMAP/gammatable at runtime (breaks PWADs / no gain).
- Per-host wasm builds (one universal artifact is the tenet).
- Rewriting the core in another language.
- Gameplay-visible "enhancements" beyond vanilla (freelook/interpolation
  stay render-side only; vanilla mode toggle preserved).
- ~~Actual retro-console ports~~ **Amended 2026-07-21 (floor campaign)**:
  the atlas remains the doctrine — no hardware target is attempted
  before its atlas row exists with arithmetic — but real-hardware
  **test beds are now sanctioned** where the row supports them:
  N64/VR4300 (owned hardware: SummerCart64 + Analogue 3D; emulator leg
  is the repeatable gate, hardware runs are committed evidence),
  386-class (86Box/real hardware), and a sub-100 MHz MCU floor
  measurement (RP2040-class, underclocked — deliverable is the measured
  minimum clock at which 13/13 demos stay tic-exact, not a promised
  record). Genesis+Sega CD stays **parked**: its atlas row concludes
  infeasible for tic-exact 35 Hz at native res by ~10× (external anchor:
  krikzz doom-68k, 1–2 fps FPGA-assisted); any future bring-up is a
  named-cuts stunt, not a promise of this project. SNES/GBA-class
  verdicts unchanged (infeasible, atlas rows closed).
- Safari/iOS and mobile/touch support — explicit non-goal; see
  browser matrix decision above.
