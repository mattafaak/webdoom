# Optimization ledger

Every optimization candidate this project has considered, what it measured and
what was decided. A killed row is not retried: its number is the reason, and
the row names what would have to change first.

Units. **instr/tic** is retired x86 user-space instructions per tic from the
freestanding build (`-m32 -O1`, p50 unless stated), the currency for anything
claimed on the bare-metal axis. **ms** figures are wasm wall-clock from
`tools/bench.mjs`. Hosts and the current baselines are in [perf.md](perf.md);
the renderer stages named here are described in [renderer.md](renderer.md).

## Candidates

| id | what | verdict | measured effect | reason |
|---|---|---|---|---|
| P1 | `R_DrawColumn` 4-wide unroll | LANDED | bsp+segs −3.5% on wbox (0.2652 → 0.2558 ms), render −1.5%; 3 interleaved reps, 2026-07-15 | all three reps below all three baseline reps; on an in-order core the loop overhead was the cost |
| P2 | hoist `dc_colormap` / `dc_source` into locals | LANDED | +0.6% on wbox, inside noise (2026-07-15) | removes two aliasing-forced global reloads per pixel (seen in the LLVM IR); correct on every target, free |
| K1 | `R_DrawSpan`: pack four output bytes into one 32-bit store | KILLED | planes +7.9% on wbox (demo1 +10.1%, demo2 +6.8%, demo3 +5.9%) | a regression on the floor host |
| K2 | wasm SIMD (v128) for the span and column loops | KILLED | assessed, not built | both loops read one texel per pixel at a computed index, a gather, and v128 has none; emulating it with lane loads costs more than the scalar loop |
| K3 | hash table for `R_FindPlane` | KILLED | worst case 451.5 search iterations per frame (tnt demo2, wbox, 2026-07-15): ceiling 2.9% of planes, 1.3% on doom.wad | below the noise once the hash's own cost is paid; the linear scan averages ~6.6 comparisons |
| K4 | sim hot paths (blockmap iterators, `P_CheckSight`, `P_ApproxDistance`) | KILLED | the sim is 3.9–6.2% of instructions per tic (alder, 2026-10-05) and under 0.4% of the 35 Hz budget on wbox | the ceiling is small and every sim change risks the 13 demo goldens; reopen only on a bare-metal profile where the sim dominates |
| K5 | whole-program `-Os`, `-Oz` or `-O2` | KILLED | `-Os`: CODE −33%, gzip −15.1%, sim −9.3% and render +3.3% on wbox (2026-07-16); `-Oz`: sim −11% on alder (2026-09-16); `-O2`: −2.7% gzip, alder sim +3.4% on one rep | `-Os`/`-Oz` regress wbox and alder; `-O2`'s size win was too small to fleet-bench; C8 gets the size without either |
| K6 | separate wasm builds per target | KILLED | — | one universal artifact is a stated non-goal in [spec.md](../spec.md) |
| K7 | replace lookup tables with runtime `sin`/`tan`/`sqrt` | KILLED | measured slower than the lookups | forbidden by the magic-data policy in spec.md |
| K8 | wasm work justified as a browser frame-rate win | KILLED | wasm render is 1.7–2.0% of the 35 Hz budget on wbox | halving it saves under 1% of a tic; kills the framing, not the optimization |
| K9 | one combined `colormap[source[]]` table per light level | KILLED | not measured | a new runtime-generated table; the magic-data policy allows only shipped blob → boot generation |
| C1 | column-major framebuffer (`screens[0]` transposed) | LANDED | mean instr/tic −2.77% doom, −4.63% doom2, −5.12% tnt, −4.25% plutonia (2026-07-18) | sequential column writes; the expected win is memory stalls on bare metal, which instruction counts cannot see |
| C2 | low-detail renderer as a runtime option (`web_set_detail`, `WD_DETAIL=1`) | LANDED | whole −19.5% doom … −28.3% tnt; bsp −22.1%, planes −41.5% (means, 2026-07-18) | vanilla's own half-width paths; opt-in, so the high-detail goldens are untouched; `render-low` gates it |
| C3 | zone 32 → 4 MiB, `INITIAL_MEMORY` 64 → 32 MiB | LANDED | linear memory halved; 4 MiB is 3.9× the worst non-purgeable peak, 13/13 sim hashes identical under eviction (re-measured 2026-10-05) | the earlier 4 MiB failures were an out-of-bounds texture read, since fixed |
| C4 | `MAXVISPLANES` 1024 → 128 (vanilla) | LANDED | BSS −594,944 B (896 × 664 B), 2026-07-18; corpus peak 118 of 128 | vanilla's size; C4b raised it again for the library |
| C4b | `MAXVISPLANES` 128 → 256, and a bound in `R_CheckPlane` | LANDED | BSS +84,992 B, 2026-10-06; SIGIL E5M6 opens at 134, library views reach about 156 | a served map died on its first frame at 128, and `R_CheckPlane` overran the array before any check |
| C5 | `MAXDRAWSEGS` 2048 → 256 (vanilla) | LANDED | BSS −86,016 B (1,792 × 48 B); corpus peak 205 of 256 (doom demo4) | vanilla's size; overflow drops the seg instead of writing out of bounds |
| C6 | `MAXOPENINGS` 320×256 → 320×64 (vanilla) | LANDED | BSS −122,880 B; corpus peak 2,527 of 20,480 (8.1×) | vanilla's size; the overflow guards fail soft |
| C7 | `STACK_SIZE` 4 → 1 MiB | LANDED | `__heap_base` −3 MiB; measured stack peak ≈14 KiB over 13 demos | 70× margin; the goldens did not move when the heap start moved |
| C8 | `-Oz` per object, `-O3` for the 17 hot files, link `-O3 -flto` | LANDED | doom.wasm 355,395 → 299,348 B (−15.8%), gzip −8.7%; alder render −1.5/−0.1/+2.0%, sim +0.3% (2026-09-16) | every speed delta inside the measured noise floor; `minsize` survives LTO, so cold code shrinks and hot code keeps its schedule |
| C9 | drop the 64,000-byte untranspose buffer | LANDED | static data −64,000 B; doom.wasm 355,883 → 355,395 B (2026-09-16) | JS reads `screens[0]` in place and the GPU swaps the axes |
| NC1 | `R_DrawSpan`: both texture coordinates in one packed accumulator | KILLED | all 13 render goldens desync at tic 0–1 (2026-07-23) | the y field's carry runs into the x field when `yfrac` wraps; reopen only with a carry-safe encoding proven on all 13 |
| NC2 | `MAXSEGS` 64 → 32 (vanilla) | KILLED | peak 17 of 64 over 44,580 tics; saving 256 B (2026-09-17) | 0.02% of static data, bought with a silently dropped wall on any map past 32 |
| NC3 | inline `R_GetColumn`'s single-patch path | LANDED | doom demo3 −4,398 instr/tic (−0.39%), demo1 −5,423; wasm render and sim inside noise, +353 B (2026-09-17) | clears its 2,000 instr/tic threshold; a cycle-floor win, invisible in the browser |
| NC4 | `R_DrawColumn` 8-wide unroll | KILLED | doom demo3 +84,524 instr/tic (+7.5% worse), demo1 +75,745; wasm flat (2026-09-17) | more step arithmetic and a longer tail on 47.9-pixel columns; at `-O3` the compiler already unrolls |
| NC5 | `R_DrawSpan` 4-wide unroll, separate accumulators | LANDED | doom demo3 −47,707 instr/tic (−4.2% whole, −11.9% planes), 2026-07-23 | 5.3× its 9,000 instr/tic threshold; same carry behaviour as the scalar loop, so pixel-identical |
| NC6 | OPL synth in the AudioWorklet (`build/synth.wasm`) | LANDED | takes a 1.84 / 4.09 / 19.7 ms p99 call every 100 ms (alder / tank / wbox) off the main thread (measured 2026-09-16, built 2026-09-17); the module is 21,395 B | on wbox the main-thread call dropped every sixth frame; see [perf.md](perf.md#why-the-synth-runs-in-the-audioworklet) |
| F1a | flat floors and ceilings beyond 512 units (FastDoom-style) | KILLED | +2.4% (+26,658 instr/tic) on doom demo3 (2026-07-23) | the distance test costs every span and few spans qualify |
| F1 | solid-colour flats, compile-time option | KILLED | −249,890 instr/tic (−22.5%) on doom demo3 (2026-07-23) | a visual change no player could select; removed with the other three |
| F2 | skip the status-bar redraw when nothing changed | KILLED | p50 −1.7%, mean +0.9% on doom demo3 (2026-07-23) | a net loss under a timedemo; the static-HUD case it targets was never measured |
| F3 | half-width "potato" columns, compile-time option | KILLED | −165,305 instr/tic (−15.1%) on doom demo3 (2026-07-23) | a visual change no player could select |
| F4 | differential blit (skip unchanged columns) | KILLED | no instrument reaches the blit; sim fps −0.6%, noise (2026-07-23) | never measured, and the untranspose buffer it skipped is gone (C9) |
| W1 | negotiated `br`/`gzip`, ETags and 304 for the shell | LANDED | shell + UI assets on the wire 1,259,266 → 444,440 B (−65%); repeat loads move headers only (alder, 2026-09-16) | served from memory, compressed once per body; `http-fuzz` gates it |
| W2 | box art as lazy thumbnails, not inline in `/api/ui-assets` | LANDED | with `br`, 444,440 → 209,035 B on the wire; `/api/ui-assets` 765 KB → 35,484 B; each thumbnail 5,568 B (alder, 2026-09-16) | seven full title pictures were sent to draw 80×60 thumbnails |
| L1 | launcher fire: precomputed noise table | LANDED | about 4× cheaper per tick than per-cell `Math.random()` (2026-07-16) | the fire runs on the main thread beside the menu |

F1–F4 were compile-time variants. None is in the engine: no player could reach
them, and the default build is byte-identical without them. The low-detail renderer (C2) is the one variant
that ships, because it is selectable at runtime.

## The kill rule

A candidate is killed by any one of these:

1. **Any sim golden changes.** The 13 demo traces are tic-identical to vanilla
   and to Chocolate Doom; a render-only change that moves one is wrong by
   definition.
2. **Any render golden changes**, unless the candidate declares a visual
   change up front and ships with its own goldens and a reason a player would
   choose it.
3. **A wall-clock regression on any fleet host**, wbox first: it is the floor.
4. **It misses its own threshold.** Before measuring, the row states a
   predicted effect and the smallest measured win that counts (NC5: 9,000
   instr/tic, half its low prediction; NC3: 2,000). Below that it is dropped
   even if it is positive.
5. **It violates the magic-data policy** in spec.md: the only sanctioned table
   change is shipped blob → boot generation.
6. **It is framed as a browser frame-rate win.** wasm is under 2% of the tic on
   the slowest host.

A change inside the noise on every host is judged on the other axes instead:
simpler, smaller, integer-exact, portable. C8 landed that way; NC2 was killed
that way.

## Measuring a new candidate

Give it the next free id and a row before writing code: what it changes, the
predicted effect with its arithmetic, and the threshold. Then measure both
sides on one host, with the same flags, demos and reps, and state all of them.

1. **Instructions.** `make -C tools/freestanding`, then
   `WD_CYCLES=1 tools/freestanding/fs-doom <doomu.wad> -timedemo demo3 -cycles c.json -attrib a.json`
   before and after, and quote p50 for demo3 and demo1. Repeat runs agree
   within 0.2% at p50 on alder. The full recipe, including why doom.wad runs
   as `doomu.wad`, is in [perf.md](perf.md#7-how-to-measure).
2. **Wall-clock.** `node bench.mjs doom.wad 3 --json` on alder before and
   after, staged as perf.md shows, and compare against the noise floor of
   relinking identical objects (render +0.7…+2.7%, sim ±1.4%). Then
   `tools/run-tests.sh --perf --only perf-fleet` for wbox and tank, which runs
   [fleet-bench.sh](../tools/fleet-bench.sh) `--check`.
3. **Size.** [size-budget.mjs](../tools/size-budget.mjs); a BSS change shows
   up in `__heap_base`, not in the wasm's byte count.
4. **Correctness.** `tools/run-tests.sh` with `--only` once per leg (it takes
   one id each): `sim-goldens`, `render-goldens`, `render-low`,
   `sim-freelook`, `sim-invariants`, `freestanding-sim`, `native-asan` and
   `fuzz-diff`, plus `opl-mode` for anything that touches the synth.

Record the numbers in the row, land or kill, and keep the row either way.
