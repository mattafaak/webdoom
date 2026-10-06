# Open work

What is known and not done, with what each item would take or what blocks it.
`spec.md` outranks this file. Finished work lives in `git log`; the reasons
behind the current state live in `spec.md` and `docs/`.

## Needs a decision

- **Co-op on a map with no start for a player.** Chex Quest E1M3–E1M5 have
  only player 1's start. A drop-in for another slot there now ends the session
  with an `I_Error` (the guard in `P_SpawnPlayer`), where it used to write to
  `players[-1]`. Chocolate Doom refuses such a game at level load. The
  friendlier option is to spawn the player at another player's start, as
  `G_DoReborn` already does when its own start is blocked.

## Engine

- `getSide()` (p_spec.c) can read `sides[-1]` for a glass-hack line (two-sided,
  no back side) that carries a raise-to-texture special. Chocolate has the same
  code.
- A cyclic BSP (node children in range, but looping) hangs at load rather than
  corrupting memory. It is not refused, because a refusal could catch odd real
  maps.
- A texture width of 0 or less is not checked; only the height is clamped.
- `G_DoReborn` writes through `players[n].mo` for a drop-in whose `mo` is NULL.
  In wasm that writes 0 over unused low memory and has no effect, but it is
  undefined behaviour, and a native build would fault.
- The 64-bit aarch64 cross-build of the freestanding core boots and then
  segfaulted on all 13 demos when last tried (2026-09-11). Only 32-bit builds
  have ever been made.
- MAXVISPLANES is 128 against a measured peak of 118 over the 13 demos; a busy
  community map can reach vanilla's `I_Error`. Raising it costs 664 B of BSS
  per visplane.

## Client

- WebGL context loss is not handled.
- `window.webdoom` and `window.doomAudio` keep the dead engine reachable between
  sessions. Two tests use them as seams after a session ends, so clearing them
  needs those tests changed first.
- A service-worker update drops the cached API responses until the next online
  visit.
- On an insecure origin, the IndexedDB WAD cache never prunes a WAD the server
  has replaced.
- `idb.js` leaks a connection when `onblocked` fires and the open succeeds
  later.
- Hostile colour strings from a server grow the glyph cache.
- A lost Enter keyup can arm a key rebind.
- Each `ping()` replaces the lobby's single `pong` handler, so two pings in
  flight would take each other's replies. The one caller sends them one at a
  time, and a lost ping gives up after 3 s.

## Server

- `doom.js` and `doom.wasm` are served without anything binding them to the
  same build, so a deploy mid-load can pair a new loader with an old module.
- The cache of compressed representations (`reps` in serve.js, 64 entries,
  oldest evicted on insert) can thrash when more than 64 distinct bodies are
  requested in rotation, recompressing each one.

## Measurement

- The perf gate's baseline (`tools/golden/bench-baseline.json`) was recorded at
  f402d5c on a larger wasm. alder's run on the current tree is inside the 20%
  band; wbox and tank have not been re-benched.
- `browser-pipeline` has a baseline only for alder. A second host would gate
  that host against its own past, which needs the repository, a build and the
  WADs there.
- The visplane, spechit and intercepts peaks were measured with instrumented
  builds (`-DWEB_PERF_*_STATS`); no leg re-measures them.

## Retro targets

- **N64 past the emulator gate:** display, input and sound; hardware evidence
  from a real console; an RDP renderer. `n64-demos` covers the simulation only.
- **386-class:** no harness. Measuring id's DOS binary would give the atlas a
  baseline, but nothing in this codebase could move it.
- **RP2040:** parked, 4.00× over on SRAM with the easy reductions already
  taken.

See [docs/retro.md](docs/retro.md) for the arithmetic.
