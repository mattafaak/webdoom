# Open work

What is known and not done, with what each item would take or what blocks it.
`spec.md` outranks this file. Finished work lives in `git log`; the reasons
behind the current state live in `spec.md` and `docs/`.

## Client

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
