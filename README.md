# webdoom

A slim, modern DOOM port for the browser, built directly from the
[id-Software/DOOM](https://github.com/id-Software/DOOM) `linuxdoom-1.10`
source. 347 KB of wasm, zero client install, zero-config multiplayer.

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
| `docs/`        | reference docs: [netcode](docs/netcode.md), [renderer](docs/renderer.md), [playsim](docs/playsim.md), [formats](docs/formats.md), [bare-metal](docs/bare-metal.md), [perf](docs/perf.md), [state-machine](docs/state-machine.md), [engine-archaeology](docs/engine-archaeology.md) |

## Tests

```sh
tools/run-tests.sh
```

- **lint**: clang-format over the web platform layer + `node --check` over
  all JS files — fails CI on any format drift or syntax error
- **engine smoke**: boots real IWADs headless in node, plays the attract
  demo, renders OPL music, asserts life in framebuffer and audio
- **demo compatibility**: all 13 built-in IWAD demos (Doom, Doom II, TNT,
  Plutonia) replayed headless; per-tic gamestate fingerprints pinned
  against golden traces — a single diverging P_Random call fails CI at
  the exact tic. The baseline is cross-validated tic-for-tic against an
  instrumented Chocolate Doom (the vanilla reference):
  `tools/build-choco-reference.sh`, then
  `node tools/demo-test.mjs --cross <binary>` — 44,580 tics identical
- **render goldens**: per-tic framebuffer hashes for all 13 demos — a
  second CI gate that catches pixel-level render regressions. Exposed the
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
  (`tools/browser-lobby-test.mjs`; T07 menu-nav is a pre-existing timing
  flake on some CI hosts — ~1/3 pass rate independent of this codebase)
- **native ASan/UBSan**: `tools/native-sanitize/` builds the engine for
  the native host with AddressSanitizer and UndefinedBehaviorSanitizer;
  runs the demo suite to surface OOB reads invisible in wasm
- **browser**: CDP-driven Chrome — title → menu → new game → movement,
  audio arms, service worker caches; plus two tabs through the lobby
  into a co-op game. The sw-cache sub-check waits for the service
  worker to take control, then asserts the WAD is cached (exits nonzero
  on failure)

## License

GPL-2.0-or-later (the id Software source re-license; Nuked OPL3 is
GPL-2). Game data (WADs) is not distributed with this repository.
