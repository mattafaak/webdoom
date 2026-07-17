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
   reproduced, and load-bearing — or it isn't claimed.

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
  `tools/golden/bench-baseline.json`.

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
WebSocket port; a transport rewrite (WebRTC/UDP) is out of scope while
LAN/tailnet head-of-line blocking remains unmeasurably small.

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

## Explicit non-goals

- Regenerating COLORMAP/gammatable at runtime (breaks PWADs / no gain).
- Per-host wasm builds (one universal artifact is the tenet).
- Rewriting the core in another language.
- Gameplay-visible "enhancements" beyond vanilla (freelook/interpolation
  stay render-side only; vanilla mode toggle preserved).
