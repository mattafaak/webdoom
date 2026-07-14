# webdoom

A slim, modern DOOM port for the browser, built directly from the
[id-Software/DOOM](https://github.com/id-Software/DOOM) `linuxdoom-1.10` source.

- Runs in stock Chrome / Edge / Firefox (WASM + WebGL2 + WebAudio)
- Modern KB+M and gamepad controls (Doom 1+2 re-release defaults)
- 1–4 players: instant single-player, zero-config network lobby
- Server-authoritative deterministic-lockstep netcode over WebSocket
- Server carries the WAD library; clients cache by content hash (Service Worker)
- Arcade profiles: join order = slot = color (Green / Indigo / Brown / Red)

## Layout

| Path      | What |
|-----------|------|
| `engine/core/` | linuxdoom-1.10, vendored pristine, patched in reviewable commits |
| `engine/web/`  | web platform layer (`i_video`, `i_sound`, `i_net`, `i_system`) |
| `client/`      | vanilla-JS shell: lobby, input, audio, service worker |
| `server/`      | Node ≥ 20, single process, single port, only dep `ws` |
| `tools/`       | emsdk env, WAD fetch/identify |
| `docs/`        | protocols + upstream README/LICENSE |

## Quick start

```sh
tools/fetch-wads.sh          # pull WAD library from TANK, build manifest
source tools/emsdk-env.sh    # emcc on PATH (pinned version)
make -C engine               # → build/doom.wasm + glue
(cd server && npm i && node serve.js)
```

Then open `http://<host>:8666/`.

## License

GPL-2.0-or-later (the id Software source re-license). Game data (WADs) is
not distributed with this repository.
