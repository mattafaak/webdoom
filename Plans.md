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

## The floor (bare metal)

Measured and predicted state: [docs/retro.md](docs/retro.md) section 5. The
gate is `tools/floor/floor-gate.mjs`; a verdict needs hardware.

**Blocked on hardware** (each a purchase or a physical step, decided by the
owner):
- **RP2350 run** (the predicted floor with an OPL2 chip): an RP2350 board with
  PSRAM, a debug probe, an SPI LCD and an I2S amplifier. The first board's
  measured cycles per instruction replace every estimate in section 5.
- **OPL2 chip** (YM3812 board): the L1 music verdict, vanilla's own setup.
- **N64 on the Analogue 3D** (SummerCart64, `sc64deployer`): would confirm
  ares's 4.21×; a real console would be needed to call it an N64 verdict.
- **Teensy 4.1:** the upper bracket, and the target for exact software music.

**Open without hardware:**
- The Cortex-M0+'s 32-bit divides are 12% of its worst tic (413 K
  instructions); the RP2040's hardware divider is only estimated.
- A pipelined two-core split (next tic's simulation on core 0 while core 1
  draws this tic's planes and masked) would take the worst tic to 71% of one
  core on ARMv6-M and 68% on ARMv8-M (instructions, zero-copy FAST builds,
  `tools/cortexm/dualcore.mjs`, 0add728), against 86% and 83% for the exact
  split. It is not argued exact: no proof yet covers all the shared state it
  would have to snapshot.
- RAM: `mobj_t` (94 KB on plutonia MAP28) is held by the savegame format;
  sector line lists and line sector pointers as indices would save about
  15 KB more.
- **The ARM RAM floor's heap figure moves with code size.** On the qemu boards
  the heap follows `.text`, and newlib keeps its break on a 4 KiB boundary, so
  `cm_heap_peak` (measured from `_heap_start`) moves by up to 4 KiB when code
  grows or shrinks, with the allocations unchanged: the 2026-10-08 changes
  moved it by −392 to −1,616 B (NOTEs, not failures). The golden's tolerance is
  1,024 B, so a code change can make `ram-floor-armv6m`/`-armv8m` fail without
  any change in what the game allocates. Measuring the peak of what malloc
  handed out, not of the break, would remove it.
- **386-class:** no harness. Measuring id's DOS binary would give the atlas a
  baseline, but nothing in this codebase could move it.

See [docs/retro.md](docs/retro.md) for the arithmetic.
