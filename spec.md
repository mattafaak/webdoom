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

## What ships (added 2026-09-12, round 6)

This contract described the engine, the tenets and the gates, and never said
what the PRODUCT is. Everything below ships today and has a suite leg;
until round 6 this file mentioned none of it, so a reader could finish it
without learning that webdoom has multiplayer spectators or a demo scrubber.
Tenet 6 says a published claim maps to a gate — the converse was the gap: a
shipped, gated feature that the contract never claimed at all.

| what | gate |
|------|------|
| Single player from a browser, no install | `browser-sp`, `smoke-doom`, `smoke-doom2` |
| Zero-config LAN co-op and deathmatch, 2–4 players | `net-2p`, `net-4p`, `browser-net` |
| Drop-in: join a game already running, re-simulated to the frontier | `join-coop`, `join-dm`, `churn`, `edge`, `browser-join` |
| **Spectators**: receive-only observers, structurally unable to inject | `spectate`, `spectate-inject` |
| **Demo recording, share permalinks, and replay** | `browser-demo`, `demo-verify`, `demo-store-fuzz` |
| **A demo scrubber** — seek within a replay, re-simulated from tic 0 | `demo-seek` |
| **A demo-verify CLI** for checking a demo against an engine | `demo-verify-cli` |
| **User WAD import** from the local disk into an IndexedDB library | `browser-wadimport`, `browser-mp-gating` |
| **Persistence**: savegames and config across reloads, per IWAD | `persist` |
| Offline single player once a WAD is cached | `browser-offline`, `sw-precache` |
| Rebindable keys, gamepad, and an OPTIONS screen on the launcher menu | `browser-options` |
| Freelook and frame interpolation — render-side, opt-in | `sim-freelook`, `sim-invariants` |
| Music: the in-engine OPL2/OPL3 sequencer from the IWAD's own GENMIDI | `opl-mode`, `browser-music-fallback` |
| **Low-detail render mode** (runtime `web_set_detail`), pixel-exact against its own goldens | `render-low` |
| **A freestanding core** with no OS, and an N64 correctness leg | `freestanding-sim`, `ro-wad`, `arm-cross`, `n64-demos` |
| **The gate machinery itself**: claims, promises, doc drift, status drift, the census | `doc-drift`, `claims-index`, `promises-index`, `status-drift`, `docs-index`, `gate-census`, `web-contract` |
| **Teardown**: play → quit → play accumulates nothing | `browser-teardown` |
| **CI** on Node 20/24/26 | `.github/workflows/ci.yml` (quick tier) |

The suite is the list: `tools/run-tests.sh --list`. If a row here has no leg,
or a leg exists for something this table does not name, one of the two is
wrong — and `promises-index-check` rule 3 already fails on a named leg that
does not exist.

## Core tenets (in priority order)

1. **Accuracy is non-negotiable.** The simulation is vanilla-exact:
   all 13 IWAD demos replay tic-identical against golden traces and
   cross-validate against instrumented Chocolate Doom (44,580 tics).
   Any change that diverges a single P_Random call is wrong.
2. **Measure, don't assume.** No optimization lands without before/after
   numbers on the three live reference hosts (wbox, tank, alder) — see the
   2026-09-11 fleet amendment below for why pi5 left that list. A
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
- **Perf gate**: `bench.mjs` per-stage numbers on the three live hosts;
  regressions on any host block, wins are recorded in
  `tools/golden/bench-baseline.json`.
  **How it runs (amended 2026-09-12):** as the `perf-fleet` suite leg, in an
  OPT-IN tier — `tools/run-tests.sh --perf`. It is opt-in because it reaches
  other machines, not because it is slow (~26 s measured for all three hosts);
  a default-tier leg that fails whenever wbox or tank is asleep is a leg people
  learn to ignore. In the default run it SKIPs with its reason named and
  counted, so it is visible in the summary table rather than absent from it.
  The comparison is `fleet-bench.sh --check`, which does **not** write the
  baseline — the same script's recording mode does, and a gate that rewrites
  its own reference to match what it just measured cannot fail. Tolerance is
  20% on per-demo `sum_ms`, set from four observed comparison runs; see the
  rationale in `fleet-bench.sh`, including why 10% was tried and rejected.
  **This clause described a gate with no leg at all until round 6.**
  The browser-pipeline baseline (per-frame JS/GPU/audio cost, input latency)
  joins this gate once a second host records one — today only alder has one,
  which finding F3 tracks, and of alder the fleet table below says "fast here
  proves nothing".
- **Cross-architecture gate**: the freestanding core replays all 13 golden
  demos bit-identically on 32-bit ARM under qemu-arm-static
  (`tools/freestanding/arm-check.sh`, suite leg `arm-cross`). This is
  correctness, not timing, and it is what the old ARM row should have been
  asserting all along.

## Reference hardware fleet

| host | CPU | role |
|------|-----|------|
| wbox | AMD G-T56N (Bobcat) | weakest — the floor; optimizations target here first |
| tank | i5-8350U (Kaby Lake) | least optimized to date; slow 64-bit idiv |
| alder | i9-12900K | fastest; dev host — fast here proves nothing; also carries the ARM correctness leg |
| ~~pi5~~ | Cortex-A76 (aarch64) | **retired from the gate 2026-09-11** — see below |

### Fleet amendment, 2026-09-11: pi5 retired, ARM reassigned

pi5 has been unreachable since before 2026-09-11 (`tailscale ping` times out),
which made the perf gate unrunnable exactly as written — "regressions on any
host block" cannot be evaluated against a host that does not answer.

What pi5 actually contributed is narrower than "ARM reference" suggests.
`fleet-bench.sh` ssh'd to it and ran `node tools/bench.mjs` against the **wasm**
build. wasm is architecture-independent by construction, so that row was a
PERFORMANCE sample and never tested ARM code generation, the ARM ABI, or ARM
alignment. There was no ARM correctness coverage to lose.

Timings do not migrate. Emulated cycles are not hardware cycles, and an ARM
performance number produced under qemu on alder would be fiction — so the perf
gate is now three hosts, honestly, rather than four with one invented.

Correctness does migrate, and it is the half that was missing. alder now
cross-builds the freestanding core for 32-bit ARM (zig's bundled musl,
`arm-linux-musleabihf`) and replays all 13 golden demos under qemu-arm-static,
asserting per-tic state hashes bit-identical. **Verified 2026-09-11: 13/13.**
So the ARM row asserts something stronger than it ever did, on a host that is up.

Its committed measurements stay in `tools/golden/bench-baseline.json` and
`docs/perf.md` as dated evidence — history is not discarded — and the fire-cost
figures in this file are unchanged. If pi5 returns, adding it back is one line
in `fleet-bench.sh`.

**Known limit, not fixed here**: the same cross-build for 64-bit aarch64
(`aarch64-linux-musl`) boots, prints through `W_Init`, and then segfaults on all
13 demos. This engine has only ever been built 32-bit — wasm32, native `-m32`,
MIPS32, thumbv6m — so 64-bit cleanliness is an unexplored axis, in the same
family as the MIPS ABI landmine audit (20.4a). Recorded, not diagnosed.

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
- A dedicated insecure-origin leg exists — `browser-insecure`, headless
  Chrome with `--host-resolver-rules="MAP insecure.test 127.0.0.1"` —
  because every other browser gate runs on `127.0.0.1`, a secure context,
  and is structurally blind to this failure class (root cause of the
  2026-07-21 field reports: silent music, WAD redownloads). It asserts an
  IDB WAD cache hit and the BufferSink music fallback on a genuinely
  insecure origin.
  **Amended 2026-09-12 (round 6): this clause said "CI gains" and CI does
  not run it.** It cannot: game data is not distributable, so the public
  `ubuntu-latest` runner has no IWADs, and without IWADs NO browser leg
  runs there — `ci.yml` says so itself and runs the `--quick` tier. The
  leg runs in the full suite on a host with the WAD library, a built
  engine and Chrome. Reading "CI" as "the public runner" made this a
  promise nothing could keep; reading it as "the suite" makes it one that
  is kept on every full run.

## Music contract (decision record, 2026-07-21)

- **Default backend**: the in-engine MUS sequencer + Nuked OPL3 core
  programmed from the IWAD's own GENMIDI lump (zero-asset, DMX-faithful).
  An OPL2-voice (mono, 9 voices, authentic 1993) vs OPL3-mode (stereo,
  18 voices) toggle is render-side audio flavor; neither reads game state.
- **No SoundFont / GM backend (removed 2026-09-16, round 10).** A GM path
  shipped 2026-07 behind an operator-hosted SpessaSynth URL that no
  deployment set; it could not activate without it and could not be gated
  end to end because the dependency was, by decision, never vendored. The
  GUS-flavour mapping that rode on it was never wired to the DMXGUS lump.
  Both are gone; the in-engine OPL sequencer is the whole music contract.
- **Never bundled**: Microsoft GS wavetable, Roland ROMs/Nuked-SC55,
  provenance-unclear soundfonts. User-supplied files are fine.
- Determinism rule (unchanged): engine music state changes only via
  `S_*` calls driven by gamestate; sample generation only via JS pulls.
  A peer with no audio at all stays tic-identical.

## Widescreen view — REVERSED 2026-09-12

Sanctioned 2026-07-21 as render-side-only, opt-in Hor+, and **removed**. It
was never a flag around unmodified code: it added a second focal length
(`centerxfrac_nonwide`), a sprite anchor correction (`anchor_offset`), a
status-bar flank filler (`ST_FillFlatFlanks`), a `WIDESCREENDELTA` offset on
every HUD widget, a runtime `screenwidth`, and a compile-time
`MAXSCREENWIDTH` of 854 that sized every per-column static array. The owner
did not use it and did not like how it looked.

The revert is proven the way the original rule demanded: **the 320 goldens did
not move.** All six families of the day were byte- or pixel-identical across
13 demos — sim, render, render-low and the four toggle legs retired in round
10 — with no regold.
Independently, `__heap_base` fell 5,042,464 → 4,722,048, and
`claims.json` `perf-009` had recorded 4,722,016 as the measured value for a
320-wide build: 32 bytes apart, so what came out was widescreen and nothing
else. `doom.wasm` shrank 357,060 → 355,893 bytes (README 349 → 348 KB at the
time; it reads 292 KB since the round-10 hybrid build).

Retired with it: legs `render-wide`, `sim-wide`, `browser-wide`,
`mixed-width-net` and `sprite-witness`, 14 golden files,
`tools/wide-experiment/`, and `bench.mjs --wide`. `docs/archive/decision-18.1-wide-limits.md`
is archived, not deleted — it holds the BSS arithmetic this revert was checked
against.

`sprite-witness` pinned the vanilla sprite cull `abs(tx) > (tz<<2)` and its
own header claimed only the 854 arm could see a tightened cull. That was
tested before deleting it: with the cull at `tz<<1`, **10 of 13 render goldens
fail at 320** (first divergence plutonia-demo3 tic 169). The pin's subject is
covered by `render-goldens`, so the leg was redundant rather than load-bearing.

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

Limits of the SMOKE leg (honest) — both closed by `firefox-frame` in round 8:
- Does not assert game-boots-to-lobby in Firefox. The stated reason ("no
  CDP equivalent for Firefox in this repo's tooling; geckodriver not
  present") was half wrong and got wronger: geckodriver is still absent,
  but Firefox 155 does not speak CDP AT ALL — `--remote-debugging-port`
  serves WebDriver BiDi and `/json/list` 404s. `firefox-frame` drives
  BiDi directly, so no third-party driver is needed.
- Does not assert WebGL2 renders a frame; only proves JS executed and
  the WASM module was requested. `firefox-frame` asserts the frame, and
  asserts the PATH: headless Firefox has no WebGL at all on this host
  (`webgl2:false`, `webgl1:false`), so the client falls back to
  `createRenderer2D` and renders perfectly well — measured, 252 colours —
  which is exactly how a frame gate could pass while proving a path no
  user takes. It runs under Xvfb and requires
  `window.webdoom._renderer.kind === 'webgl2'`.
- AudioWorklet: Firefox headless does NOT arm AudioContext without a
  real user gesture — same headless limitation as Chrome. AudioWorklet
  timing is therefore n=0 in any headless run (either browser). See
  §C residual note in `docs/perf.md`.

### Edge — verdict, 2026-09-12 (round 6)

`rme-002` has carried "Edge remains ungated and untested" since 15.2.
This settles it rather than re-flagging it.

Edge is Chromium. It shares Blink, V8, the WebGL2 implementation, the
WASM engine and the service-worker implementation with the Chrome the
19 browser legs drive; what differs is chrome-the-UI, the update
channel, and a handful of enterprise policies — none of which this
project touches. A dedicated Edge leg would re-run the same engine
through a second binary and report the same result, which is why it has
never been worth a task.

**Decision: the promise stands, and it is a CHROMIUM promise.** README
and this file say "stock Chrome / Edge / Firefox" because that is what a
player reads on the box; the evidence is Chromium (gated, 19 legs) plus
Firefox (smoke-gated, limits stated above). Edge specifically is
**untested by policy, not by oversight** — the same standing Safari/iOS
gets below, with the opposite conclusion about whether it will work.
If Edge ever diverges from Chromium in a way that reaches this code, it
becomes a bug report with a reproducer, not a missing leg.

Decision: README claim "stock Chrome / Edge / Firefox" is kept.
Gate: `run-tests.sh` firefox smoke leg, plus the 19 Chromium legs.

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
