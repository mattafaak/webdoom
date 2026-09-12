# webdoom

A slim, modern DOOM port for the browser, built directly from the
[id-Software/DOOM](https://github.com/id-Software/DOOM) `linuxdoom-1.10`
source. 349 KB of wasm, zero client install, zero-config multiplayer.

- Runs in stock Chrome / Edge / Firefox (WASM + WebGL2 + WebAudio)
- Uncapped framerate with 35 Hz-exact game logic (Crispy-style
  interpolation; "vanilla mode" toggle in settings, F8)
- Modern controls: pointer-lock mouse, WASD, rebindable keys, analog
  twin-stick gamepad — Doom 1+2 re-release defaults
- Authentic audio: DMX PCM sfx via WebAudio, music through an emulated
  OPL2 (Nuked OPL3) playing the IWAD's own GENMIDI bank
- 1–4 players: instant single player; arcade lobby for network play
  (join order = color: Green/Indigo/Brown/Red — nothing to type)
- PSX DOOM fire background on the launcher — chunky indexed-cell fire on
  a 64×40 grid, palette-matched, flares on every menu transition;
  measured < 1 ms/tick on the weakest network host
- Deterministic-lockstep netcode over a server tic relay (see
  [docs/netcode.md](docs/netcode.md)); verified by a headless harness
  that compares per-tic gamestate hashes across real clients
- Server carries the WAD library (Ultimate Doom, Doom II, Final Doom,
  SIGIL, Master Levels, NRFTL, Chex Quest, HACX); clients cache by
  content hash via a service worker — second load is instant, single
  player works offline

## Quick start

```sh
WAD_SRC=host:~/doom-wads tools/fetch-wads.sh   # pull your WAD library, build manifest
source tools/emsdk-env.sh    # pinned emcc on PATH
make -C engine               # → build/doom.js + doom.wasm
(cd server && npm i)
./start.sh                   # http://<host>:8666/
```

LAN players (or tailnet peers) just open the URL. First player into the
Multiplayer panel is Green, second Indigo, then Brown, Red. Anyone picks
the game/map/skill/mode; anyone hits START; 3-2-1, everyone's in.

`webdoom.service` is a ready systemd unit.

## Layout

| Path      | What |
|-----------|------|
| `engine/core/` | linuxdoom-1.10, vendored pristine in commit 1, patched in reviewable commits |
| `engine/web/`  | web platform layer: video/audio/input/net + MUS→OPL sequencer |
| `client/`      | vanilla-JS shell: lobby, WebGL2 renderer, input, audio, service worker |
| `server/`      | Node ≥ 20, single process, single port; only dep `ws` |
| `tools/`       | emsdk pin, WAD fetch/identify, test suites, bench harness, native sanitizer target |
| `docs/`        | 26 reference documents — **[the index](docs/README.md)** lists every one. The ones most people want: [netcode](docs/netcode.md), [renderer](docs/renderer.md), [playsim](docs/playsim.md), [formats](docs/formats.md), [bare-metal](docs/bare-metal.md), [perf](docs/perf.md), [state-machine](docs/state-machine.md), [engine-archaeology](docs/engine-archaeology.md) |

## Tests

```sh
tools/run-tests.sh            # everything: 81 legs, ~25 min
tools/run-tests.sh --quick    # no WADs, no build, no browser — what CI runs
tools/run-tests.sh --list     # the leg registry
```

Each leg is isolated: one red does not hide the rest, and the run ends with a
table naming every leg, its verdict and the count it reported about itself. A
leg whose prerequisites are absent is a SKIP **with its reason**, counted in
that table, and `--require-complete` turns any skip into a failure.

**What CI covers.** Game data is not distributable, so the GitHub runner has no
IWADs and runs the `--quick` tier — lint, the doc-drift gate, the state-machine
and precache checks, the gate census, and the three fuzz suites. Everything that
needs a WAD, a built engine or a browser (the sim and render goldens, netplay,
the ASan and cross-architecture legs, the 19 browser legs) runs locally and says
so. The workflow prints the list it did not cover.

- **lint**: clang-format over the web platform layer + `node --check` over
  all JS files — fails on any format drift or syntax error. The JS half runs
  in CI; the clang-format half needs the pinned major and is reported as a
  named SKIP where that is absent
- **engine smoke**: boots real IWADs headless in node, plays the attract
  demo, renders OPL music, asserts life in framebuffer and audio
- **demo compatibility**: all 13 built-in IWAD demos (Doom, Doom II, TNT,
  Plutonia) replayed headless; per-tic gamestate fingerprints pinned
  against golden traces — a single diverging P_Random call fails the suite at
  the exact tic. Needs IWADs, so it runs locally, not in CI. The baseline is cross-validated tic-for-tic against an
  instrumented Chocolate Doom (the vanilla reference):
  `tools/build-choco-reference.sh`, then
  `node tools/demo-test.mjs --cross <binary>` — 44,580 tics identical
- **render goldens**: per-tic framebuffer hashes for all 13 demos — a
  second gate that catches pixel-level render regressions (local; needs IWADs). Exposed the
  Tutti-Frutti latent out-of-window texture read (fixed, `dc_texheight`);
  render goldens are no longer heap-layout-sensitive after that fix
- **netplay**: 2 and 4 real wasm clients through the real server; per-tic
  gamestate hashes must match exactly; a client is killed mid-game and
  the survivors must keep playing
- **net fuzz**: malformed and hostile WebSocket frames thrown at the server
  across many patterns; server must survive, close cleanly, and never
  exceed the per-client message caps (`tools/net-fuzz-test.mjs`)
- **client resilience**: fetch failures, service-worker cache errors,
  visibility changes, gamepad removal, and storage unavailability handled
  gracefully — no unhandled rejections (`tools/browser-resilience-test.mjs`)
- **lobby state-machine**: enumerated JS lobby states exercised against
  all specified transitions; impossible states guarded
  (`tools/browser-lobby-test.mjs`. T07 menu-nav was a timing flake at ~1/3 pass
  rate; fixed in 9ed9671 by a 3-attempt retry of the MP-open action with the
  assertion unweakened, 20/20 on a fresh profile. The original cause was /tmp
  exhaustion from orphaned Chrome processes, not this codebase.)
- **native ASan/UBSan**: `tools/native-sanitize/` builds the engine for
  the native host with AddressSanitizer and UndefinedBehaviorSanitizer;
  runs the demo suite to surface OOB reads invisible in wasm
- **cross-architecture**: the same 13 golden demos replayed on hardware the
  browser build never sees. 32-bit ARM under `qemu-arm-static` (zig
  cross-build), and — the strongest form of the argument — an emulated
  **Nintendo 64**: 93.75 MHz big-endian MIPS R4300i, the 12.4 MB IWAD read in
  place out of cartridge space, **44,580 tics with every per-tic simulation
  hash bit-identical** to the wasm golden (`tools/n64/run-n64-demos.sh`, leg
  `n64-demos`, ~8 min; needs the mips64 toolchain and ares, so it runs locally)
- **browser**: CDP-driven Chrome — title → menu → new game → movement,
  audio arms, service worker caches; plus two tabs through the lobby
  into a co-op game. The sw-cache sub-check waits for the service
  worker to take control, then asserts the WAD is cached (exits nonzero
  on failure)

## License

GPL-2.0-or-later (the id Software source re-license; Nuked OPL3 is
GPL-2). Game data (WADs) is not distributed with this repository.
