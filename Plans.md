# Open work

What is known and not done, with what each item would take or what blocks it.
`spec.md` outranks this file. Finished work lives in `git log`; the reasons
behind the current state live in `spec.md` and `docs/`.

## Measurement

- **tank has not been re-benched** against the perf gate's baseline
  (`tools/golden/bench-baseline.json`, recorded at f402d5c on a larger wasm).
  It is a travel laptop and was offline (last seen 5 days before 2026-10-06).
  alder and wbox were re-measured on 2026-10-06 at 4fedc76
  (`fleet-bench.sh --check`), inside the 20% band on all three demos (wbox
  −1.6%, −2.7%, −4.8%). Run `bash tools/fleet-bench.sh --check` when tank is
  back.
- **`browser-pipeline` gates alder only, by policy.** A second host would be
  gated against its own past, which needs the repository, a build and the WADs
  there.

## Retro targets

- **N64 past the emulator gate:** display, input and sound; hardware evidence
  from a real console; an RDP renderer. `n64-demos` covers the simulation only.
- **386-class:** no harness. Measuring id's DOS binary would give the atlas a
  baseline, but nothing in this codebase could move it.
- **RP2040:** parked, 4.00× over on SRAM with the easy reductions already
  taken.

See [docs/retro.md](docs/retro.md) for the arithmetic.
