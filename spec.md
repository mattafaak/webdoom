# webdoom — product contract

This file outranks the documents under `docs/` and `Plans.md`. It states what
ships, what each part must guarantee, and which suite leg checks it.

## What webdoom is

A slim, browser-native DOOM port built from `linuxdoom-1.10`. Every inherited
algorithm and data blob is either *understood* (a documented recipe), *proven
equivalent* to a faster modern form, or *catalogued as irreducible canon*. The
engine keeps the platform surface minimal, has no filesystem, and is meant to
run well on everything from a fast desktop to a no-OS target.

## What ships

Each row is shipped behaviour and the legs that check it. The suite is the
list (`tools/run-tests.sh --list`), and `tools/check-docs.mjs` (leg `docs`)
fails when a leg named here does not exist.

| what | gate |
|------|------|
| Single player from a browser, no install | `browser-sp`, `smoke-iwads` |
| Zero-config LAN co-op and deathmatch, 2–4 players | `net-2p`, `net-4p`, `browser-net` |
| Drop-in: join a running game, re-simulated to the frontier | `join-coop`, `join-dm`, `churn`, `edge`, `browser-join` |
| A seat bound to the lobby socket it was given to | `net-fuzz` |
| Spectators: receive-only observers, unable to inject | `spectate`, `spectate-inject` |
| A session that loses its relay, or ends while loading, says so and leaves nothing running | `net-hidden`, `browser-boot-abort` |
| Demo recording, share permalinks and replay | `browser-demo`, `demo-verify`, `demo-replay`, `demo-store-fuzz` |
| A demo scrubber: seek within a replay, re-simulated from tic 0 | `demo-seek` |
| A demo-verify CLI for checking a demo against an engine | `demo-verify-cli` |
| User WAD import into an IndexedDB library | `browser-wadimport`, `browser-mp-gating` |
| Savegames and config across reloads, per game (a PWAD's saves are its own) | `persist`, `browser-pwad-session`, `save-compat` |
| Offline single player once a WAD is cached | `browser-offline`, `sw-precache` |
| A loader is answered only with the module it was linked with (`doom.wasm?v=<sha256[:12]>`; any other v is 409) | `http-fuzz`, `freshness` |
| Rebindable keys, gamepad, and an OPTIONS screen | `browser-options`, `browser-gamepad` |
| The lobby's RULES (no monsters, fast, respawn, timer) reach the engine | `launch-args` |
| Freelook and frame interpolation, render-side and opt-in | `sim-freelook`, `sim-invariants` |
| Music: the in-engine OPL2/OPL3 sequencer from the IWAD's GENMIDI, on the audio thread, or the main thread on an insecure origin | `opl-mode`, `browser-music-worklet`, `browser-insecure` |
| Low-detail render mode, pixel-exact against its own goldens | `render-low` |
| A freestanding core with no OS, and an N64 correctness leg | `freestanding-sim`, `ro-wad`, `arm-cross`, `be-cross`, `n64-demos` |
| The engine's derived figures reproduce, the artifacts fit their ceilings, and the platform contract matches the exports | `archaeology`, `size-budget`, `web-contract` |
| Play → quit → play accumulates nothing | `browser-teardown` |
| A lost WebGL context: the game runs on, draws again once it is restored, and a boot onto a lost one comes up | `browser-resilience` |
| CI on Node 20/24/26 | `.github/workflows/ci.yml` (the quick tier) |

## Core tenets (in priority order)

1. **Accuracy is non-negotiable.** The simulation is vanilla-exact: all 13
   IWAD demos replay tic-identical against golden traces and cross-validate
   against instrumented Chocolate Doom (44,580 tics). A change that moves a
   single P_Random call is wrong.
2. **Measure, don't assume.** No optimization lands without before/after
   numbers on the live reference hosts (wbox, tank, alder). A change within
   noise everywhere is judged on the universal axes instead: simpler, smaller,
   integer-exact, more portable.
3. **Code simplicity beats cleverness.** Prefer deleting code to adding it.
   The web platform layer, client and server stay small enough to read in a
   sitting.
4. **Robustness of game, net and menu code.** No input from the network, a
   WAD, a savegame or the user may corrupt memory or wedge a state machine.
   Fail soft: refuse with a reason and keep the rest of the program alive.
5. **Bare-metal adaptability.** The core-to-platform contract is explicit,
   documented and narrow ([docs/bare-metal.md](docs/bare-metal.md)), so a
   no-OS port starts from this repository's documentation.
6. **Understanding is verifiable.** A behavioural promise in this file or the
   README maps to a leg. A derived engine figure (a table recipe, a constant's
   origin) has a reproducer in `tools/archaeology/`, which the `archaeology`
   leg runs. The demo-visible invariants accuracy depends on are asserted at
   their call sites (`sim-invariants`). Prose is not machine-graded; a claim
   with no leg or reproducer behind it is a claim to fix or delete.

## Correctness gates

- **Sim:** the 13 golden traces, tic-identical (`sim-goldens`). The
  Chocolate Doom cross-check (`tools/choco-trace.patch`,
  `demo-test.mjs --cross`) is the external reference any regold needs.
- **Render:** per-tic framebuffer hashes over the same demos
  (`render-goldens`, `render-low`). A renderer change is pixel-identical
  unless it declares a visual change.
- **Net:** 2- and 4-client relay tests with per-tic gamestate hashes, mid-game
  drops and drop-ins (`net-2p`, `net-4p`, `join-*`, `churn`, `edge`), and
  hostile clients and servers on both sides (`net-fuzz`, `hostile-lobby`,
  `hostile-server`).
- **Hostile input:** maps (`adversarial-map`, `crafted-maps`), lump contents
  (`wad-content-fuzz`), savegames (`save-compat`) and the web layer's entry
  points (`hostile-calls`) are refused before any out-of-bounds access.
- **Perf:** `bench.mjs` per-stage numbers on wbox, tank and alder, compared by
  `fleet-bench.sh --check` against `tools/golden/bench-baseline.json` with a
  20% band (leg `perf-fleet`, opt-in with `--perf` because it reaches other
  machines). The check never writes its own baseline.
- **Cross-architecture:** the freestanding core replays all 13 demos
  bit-identically on 32-bit ARM and big-endian PowerPC under qemu
  (`arm-cross`, `be-cross`) and on an emulated N64 (`n64-demos`).

## Reference hardware

| host | CPU | role |
|------|-----|------|
| wbox | AMD G-T56N (Bobcat) | the floor; optimizations target it first |
| tank | i5-8350U (Kaby Lake) | slow 64-bit idiv |
| alder | i9-12900K | development host; fast here proves nothing; runs the cross-architecture legs |

Timings come from real hardware only: an emulated cycle is not a hardware
cycle. Emulation is used for correctness. The 64-bit aarch64 cross-build boots
and then segfaulted on all 13 demos when last tried (2026-09-11); this engine
has only been built 32-bit, and 64-bit cleanliness is unexplored.

## Netcode contract

Deterministic lockstep over a server tic relay
([docs/netcode.md](docs/netcode.md) is the protocol reference). The jitter
buffer, drop-in and fabricated-cmd grace never touch the simulation: clients
execute sealed bundles only, so a desync is impossible by construction.
Transport is one WebSocket port. WebRTC/UDP is out of scope: the measured
inter-bundle gap and loss on LAN and tailnet are bounded by the relay's own
pacing, not by TCP retransmits ([docs/netcode.md](docs/netcode.md#measured)).

## Launcher fire background

A PSX-DOOM-style fire behind the launcher: classic indexed-byte propagation
on a 64×40 grid, nearest-neighbour upscaled, drawn only from the DOOM fire
ramp. It is dimmed behind menus (menu contrast is never harmed), flares
briefly on menu transitions, ticks at about 16 Hz off rAF, pauses while the
engine runs or the tab is hidden, and shows a static frame under
`prefers-reduced-motion`. Budget: under 1 ms per tick on wbox
([docs/perf.md](docs/perf.md#the-launcher-fire)); gate `browser-fire`.

## Magic-data policy

- Trig tables are generated at boot from cracked recipes plus a correction
  stream, checksum-guarded. gammatable and rndtable are irreducible canon,
  shipped. COLORMAP's recipe is known, but it is WAD-owned and
  PWAD-overridable, so it is always loaded, never regenerated.
- The only sanctioned table transform is shipped blob → boot generation.
  Replacing a runtime lookup with a runtime transcendental is forbidden
  (measured slower).

## Insecure origins

The primary environment is plain HTTP on a LAN or tailnet address
(`http://<host>:8666/`, what `start.sh` advertises). That is an insecure
context: browsers withhold `navigator.serviceWorker` and
`AudioContext.audioWorklet`. So:

- Every player-facing feature works there or degrades loudly, on the status
  line, never in a swallowed `console.warn`. An informational notice clears
  itself (the music notice after 8 s); an error stays.
- WAD caching uses IndexedDB, and music uses the main-thread pump into a
  `BufferSink` instead of the worklet-hosted synth: the same sequencer and
  the same samples on a different thread.
- `browser-insecure` checks both on a genuinely insecure origin (headless
  Chrome with a host-resolver rule), because every other browser leg runs on
  `127.0.0.1`, a secure context. It runs in the full suite on a host with the
  WAD library; the public CI runner has no IWADs, so it runs the quick tier.

## Music contract

- The one backend is the in-engine MUS sequencer and the Nuked OPL3 core,
  programmed from the IWAD's own GENMIDI lump: no assets, DMX-faithful. The
  OPL2 (mono, 9 voices) and OPL3 (stereo, 18 voices) modes are render-side
  flavour; neither reads game state.
- Never bundled: Microsoft GS wavetable, Roland ROMs or Nuked-SC55, or
  soundfonts of unclear provenance.
- On a secure origin the AudioWorklet runs its own copy of the sequencer,
  `build/synth.wasm`, linked from the same `mus_opl.c` and `opl3.c`, and the
  engine posts it song bytes and control events. Elsewhere the main thread
  pulls `web_music_render` from the engine's synth. `opl-mode` holds the two
  byte-identical.
- Engine music state changes only through `S_*` calls driven by gamestate,
  and neither synth can reach the playsim, so a peer with no audio stays
  tic-identical.

## Browsers

- **Chromium (Chrome, Edge):** the browser legs drive headless Chrome. Edge
  shares Blink, V8, WebGL2, wasm and the service worker with it, so it is
  covered by those legs and untested as a separate binary, by policy. If Edge
  ever diverges in a way that reaches this code, that is a bug report with a
  reproducer.
- **Firefox:** `firefox-frame` drives Firefox over WebDriver BiDi under Xvfb
  and requires a real WebGL2 frame and input. Headless Firefox has no WebGL,
  and the 2D fallback would render a frame no user's browser takes.
- **Headless audio:** neither browser arms an AudioContext without a real
  gesture, so AudioWorklet timing is never measured headless.
- **Safari / iOS:** not promised and not tested. WebKit's audio differs and
  testing it needs hardware this project does not have. Adding it needs a
  decision recorded here first.

## Non-goals

- Regenerating COLORMAP or gammatable at runtime (breaks PWADs, no gain).
- Per-host wasm builds: one universal artifact.
- Rewriting the core in another language.
- Gameplay-visible enhancements beyond vanilla. Freelook and interpolation
  stay render-side.
- A widescreen view. 320×200 is the view; a Hor+ mode was built, measured
  and removed.
- Safari/iOS and mobile/touch support.

### Hardware targets

No hardware target is attempted before its row in
[docs/retro.md](docs/retro.md) exists, with arithmetic.

| target | status |
|--------|--------|
| N64 (VR4300) | **test bed.** `n64-demos` is the gate (13/13, emulated); hardware runs are evidence, not the gate. |
| RP2040 | **parked.** 4.00× over on SRAM. |
| 386-class | **no harness.** Nothing here measures this code on one. |
| ESP32-S3 | **plausible, untested.** Needs PSRAM. |
| Sega 32X | **open.** The simulation fits one SH-2; rendering does not. |
| Genesis + Sega CD, GBA, SNES | **infeasible.** |
