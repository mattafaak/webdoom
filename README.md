# webdoom

A slim, modern DOOM port for the browser, built directly from the
[id-Software/DOOM](https://github.com/id-Software/DOOM) `linuxdoom-1.10`
source. 356 KB of wasm, zero client install, zero-config multiplayer.

- Runs in stock Chrome / Edge / Firefox (WASM + WebGL2 + WebAudio)
- Uncapped framerate with 35 Hz-exact game logic (Crispy-style
  interpolation; "vanilla mode" toggle in settings, F8)
- Modern controls: pointer-lock mouse, WASD, rebindable keys, analog
  twin-stick gamepad — Doom 1+2 re-release defaults
- Authentic audio: DMX PCM sfx via WebAudio, music through an emulated
  OPL2 (Nuked OPL3) playing the IWAD's own GENMIDI bank
- 1–4 players: instant single player; arcade lobby for network play
  (join order = color: Green/Indigo/Brown/Red — nothing to type)
- Deterministic-lockstep netcode over a server tic relay (see
  [docs/netcode.md](docs/netcode.md)); verified by a headless harness
  that compares per-tic gamestate hashes across real clients
- Server carries the WAD library (Ultimate Doom, Doom II, Final Doom,
  SIGIL, Master Levels, NRFTL, Chex Quest, HACX); clients cache by
  content hash via a service worker — second load is instant, single
  player works offline

## Quick start

```sh
tools/fetch-wads.sh          # pull WAD library from TANK, build manifest
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
| `tools/`       | emsdk pin, WAD fetch/identify, test suites |
| `docs/`        | netcode protocol + upstream README/LICENSE |

## Tests

```sh
tools/run-tests.sh
```

- engine smoke: boots real IWADs headless in node, plays the attract
  demo, renders OPL music, asserts life in framebuffer and audio
- demo compatibility: all 13 built-in IWAD demos (Doom, Doom II, TNT,
  Plutonia) replayed headless; per-tic gamestate fingerprints pinned
  against golden traces — a single diverging P_Random call fails CI at
  the exact tic. The baseline is cross-validated tic-for-tic against an
  instrumented Chocolate Doom (the vanilla reference):
  `tools/build-choco-reference.sh`, then
  `node tools/demo-test.mjs --cross <binary>` — 44,580 tics identical
- netplay: 2 and 4 real wasm clients through the real server; per-tic
  gamestate hashes must match exactly; a client is killed mid-game and
  the survivors must keep playing
- browser: CDP-driven Chrome — title → menu → new game → movement,
  audio arms, service worker caches; plus two tabs through the lobby
  into a co-op game

## License

GPL-2.0-or-later (the id Software source re-license; Nuked OPL3 is
GPL-2). Game data (WADs) is not distributed with this repository.
