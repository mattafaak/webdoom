# Phase 14 Optimization Candidate Ledger

*Built from 13.1b cycle attribution + perf archaeology. Spec tenet #2:
measure-don't-assume. Every predicted Δinstr/tic shows its arithmetic inline.
No vibes.*

**Inputs (all committed):**

- `tools/golden/cycle-floor.json` — 13.1a whole-program floor: doom.wad mean
  1.22 M instr/tic, plutonia.wad mean 1.35 M instr/tic; p50 preferred metric
  (1.3–9.9% run-to-run variance).
- `tools/golden/cycle-attribution.json` — 13.1b per-stage split, rendering ON,
  reconciliation 0.0000% exact.
- `tools/golden/zone-stats.json` — 13.2b render-ON zone HWM; np-HWM worst
  0.981 MiB (tnt-demo2), 4 MiB proven safe 13/13.
- `tools/golden/browser-pipeline-alder.json` + `browser-pipeline-wbox.json` —
  12.2b browser pipeline baselines; unlocks browser-axis rows.
- `docs/perf.md` §13.1a/b, §G, §Q2 — stage descriptions, kill verdicts, BSS
  layout data.
- `spec.md` §magic-data-policy — magic-data compliance rules.

---

## Kill-list (imported verbatim from Plans.md)

The following items are permanently killed. No task may re-propose them without
the named reopen condition.

> *span u32 packing (wbox +7.9%), wasm SIMD (no gather), visplane hash
> (ceiling 2.9%, probe depth 6.6), Q4 sim hot paths (absent perf.md's two
> reopen conditions), emcc knob re-sweeps (axes 1–5 done), per-target wasm
> builds (spec non-goal), runtime lookup→transcendental (magic-data policy),
> browser-fps-motivated wasm-side work (render = 1.71% and sim = 0.25% of the
> 35 Hz budget on the weakest host — retrospective.md already caught this
> framing error once).*

These items appear as individual killed rows in the ledger below.

---

## Stage attribution baseline (source: perf.md §13.1b, doom.wad p50)

| stage | instr/tic p50 | share | notes |
|-------|--------------|-------|-------|
| bsp+segs | 494,338 | 40.1% | R_DrawColumn + BSP traversal + wall projection |
| planes | 402,167 | 32.7% | R_DrawSpan + R_FindPlane overhead |
| masked | 138,866 | 11.3% | sprite R_DrawColumn variants |
| sim | 58,355 | 4.7% | playsim (P_Ticker and friends) |
| other | 26,020 | 2.1% | NetUpdate, inter-bracket overhead |
| frame | 2,566 | 0.2% | R_RenderPlayerView setup |
| **whole** | **1,230,745** | 100% | doom.wad p50; range across IWADs 1.23–1.49 M |

Per-IWAD bsp range: 494K (doom.wad) – 646K (plutonia.wad) p50.
Per-IWAD planes range: 353K (doom2-demo3) – 636K (plutonia-demo2) p50.

> **FLAG (spec tenet #6 — not adjudicated here):** The bsp+segs value (494,338) is transcribed
> from perf.md §13.1b and does NOT reproduce from `cycle-attribution.json`. The
> mean-of-per-demo-p50s computed directly from the JSON = 558,834 instr/tic; the "other" stage
> also differs (JSON: 26,070 vs perf.md: 26,020). The planes/masked/sim/frame stages reproduce
> exactly from the JSON. The discrepancy is flagged per spec tenet #6 (honest uncertainty); the
> 13.1b source conflict is deferred to the task that first depends on the bsp number. Where C2's
> arithmetic uses bsp, both bounds are stated.
>
> **RESOLVED (14.4):** 494,338 reproduces under NO aggregation of the committed JSON (doom.wad
> per-demo bsp p50s 489,382/512,230/525,543/708,180 → mean 558,834, median 518,886) — verdict:
> transcription/method error in the §13.1b prose; the JSON artifact is authoritative (perf.md
> §13.1b now carries the correction). Superseded by the 14.4 regenerated baseline: doom.wad bsp
> 503,704, all-13 mean 551,615.

---

## Candidates

Five required fields per row: mechanism · Δinstr/tic · axis · magic-data ·
kill rule. Final column: verdict (SURVIVES → follow-up task | KILLED → reason).

### C1 — Framebuffer transposition (deferred architectural item from 2.2)

| field | value |
|-------|-------|
| **mechanism** | Change `screens[0]` layout from row-major (column stride = SCREENWIDTH = 320 bytes) to column-major (column stride = 1 byte). `R_DrawColumn` writes become sequential; wasm SIMD v128 stores become possible without gather; bare-metal PSRAM round-trip latency per column-pixel eliminated. |
| **predicted Δinstr/tic** | **MEASURED (14.2a landed)**: cycle-floor.sh before/after on the transposed fs-doom build — doom.wad −2.77%, doom2.wad −4.63%, tnt.wad −5.12%, plutonia.wad −4.25% mean instr/tic (before: committed cycle-floor.json 13.1a baseline 1.226–1.370M; after: 1.192–1.312M). All four deltas are inside the documented 1.3–9.9% run-to-run variance band, so the honest claim is "icount-neutral-to-slightly-better", direction consistently negative across all IWADs (plausibly better codegen from the `dest++` column inner loop). The predicted bare-metal PSRAM wall-clock win remains UNMEASURED — icount cannot capture stride-latency stalls; that measurement is bare-metal hardware's job. The committed tools/golden/cycle-floor.json keeps the 13.1a pre-transposition baseline (cited by perf.md §13.1a and the atlas); regenerating it against the shipped 14.2a engine is 14.4 release-gate work. |
| **axis** | cycle-floor / portability |
| **magic-data policy** | None required. No precomputed tables introduced. **COMPLIES.** |
| **kill rule** | Any sim golden mismatch (13/13 hash diff) = kill. Any render golden pixel delta before explicit regold = kill. wasm byte-identity regression without justification = kill. |

**Verdict: SURVIVES → task 14.2a**

Notes: perf.md §Q1 explicitly flagged this as the architectural prerequisite for wasm SIMD
v128 (currently killed for lack of this). The deferred item from 2.2 (perf.md:730) states:
"stride-320 writes can't be SIMD-batched without framebuffer transposition." Before the
transposition the SIMD row also stays killed. The x86-64 icount benefit is likely small
(cache-miss stalls are wall-clock, not icount); the bare-metal benefit is potentially large.

---

### C2 — Low-detail mode as bare-metal option

| field | value |
|-------|-------|
| **mechanism** | Set `detaillevel = 1` (and `detailshift = 1`) in the bare-metal platform layer's `I_InitGraphics` equivalent. Activates existing `R_DrawColumnLow` / `R_DrawSpanLow` code paths (vanilla-inherited, already compiled): column draw renders at halved horizontal resolution with pixel doubling (each column covers 2 adjacent pixels). R_DrawColumn call count ≈ halved per frame. No engine/core modification; `detaillevel` is a runtime variable. |
| **predicted Δinstr/tic** | **MEASURED (14.2b landed)**: WD_DETAIL=1 vs high-detail on the same build (fs-doom, WD_CYCLES): whole-program mean instr/tic doom −19.5% (1,090,741→878,531), doom2 −20.1%, tnt −28.3%, plutonia −26.2%. Per-stage (cycle-attrib): bsp −21.1…−23.2% (mean −22.1%; doom 558,834→436,050), planes −39.8…−43.7% (mean −41.5%; doom 402,166→226,614). The pre-measurement prediction (bsp-side ~14–16% of whole from the "R_DrawColumn ≈70% of bsp" §Q1 estimate + planes-side ~½) overestimated the column share: measured bsp reduction is ~22% of the stage (implying R_DrawColumn ≈44% of bsp+segs, not 70%), while the planes-side halving came in almost exactly as predicted (−41.5% vs ~−50%, R_DrawSpanLow does 1 lookup / 2 px). First runtime execution of the Low paths also exposed two latent 14.2a conversion bugs (span-low count-after-shift buffer overrun, ASan-caught; column-low global dc_x mutation → exponential growth on multi-post masked columns) — both fixed the way Chocolate Doom fixed vanilla's identical defects (local copies, pre-shift count); vanilla's own behavior here is UB (OOB reads/writes), so the deviation is sanctioned by the 3.1 dc_texheight precedent. Low-detail output has NO external oracle: the 13 -render-low.json goldens are self-recorded first-recordings (recorded, then re-verified deterministic), drift-protected forward only. Sim identity proven non-vacuously: fs-doom WD_DETAIL=1 rendering ON → 13/13 per-tic state hashes bit-identical to committed sim goldens. |
| **axis** | cycle-floor / simplicity |
| **magic-data policy** | None. Uses vanilla code paths (`detaillevel` is a vanilla variable; `R_DrawColumnLow` and `R_DrawSpanLow` are vanilla functions). **COMPLIES.** |
| **kill rule** | High-detail sim golden mismatch on 13 demos = kill (low-detail is opt-in for bare-metal only; vanilla behavior must not be perturbed). |

**Verdict: SURVIVES → task 14.2b**

Notes: bare-metal.md §7.3 already lists low-detail as solution (c) for PSRAM bandwidth:
"lower resolution via the engine's existing low-detail mode (detaillevel = 1 halves
horizontal resolution)." This confirms the mechanism is documented and intentional.

---

### C3 — ZONESIZE 32 MiB → 4 MiB (shipping web build)

| field | value |
|-------|-------|
| **mechanism** | Change `#define ZONESIZE (32*1024*1024)` to `(4*1024*1024)` in `engine/web/web.h`. With 4 MiB zone + 17.6 MiB worst WAD (tnt+tnt31=18.5 MB per perf.md §axis-4) + 5.2 MiB static, peak = ~26.8 MB → `INITIAL_MEMORY` can drop 64→32 MiB. |
| **predicted Δinstr/tic** | 0. Zone pool size does not change instruction count; allocation pattern is identical (same zone API calls, same allocation sizes). |
| **axis** | RAM |
| **magic-data policy** | None. **COMPLIES.** |
| **kill rule** | Sim golden failure, render golden failure, or net golden failure at 4 MiB zone = kill. Source: 13.2b proven safe (zone-stats.json: 248–1,397 purges/demo, 13/13 golden, zero divergence at 4 MiB). |

**Verdict: MEASURED (14.2c) — LANDED**

Notes: 13.2b provided the evidence that was missing when task 2.5 tried and failed at 4 MiB
(that failure was dc_texheight OOB, now fixed by 3.1). The zone-stats.json defensible_min_statement
confirms: "The defensible minimum ZONESIZE is 4 MiB: non-purgeable render-ON HWM = 0.981 MiB
(tnt-demo2)... zero golden divergence across 13 demos." The win: wasm linear memory floor drops
from 64 MiB to 32 MiB (~50% reduction in INITIAL_MEMORY).

14.2c landing evidence: sim 13/13 PASS, render-high 13/13 PASS, render-low 13/13 PASS, net PASS,
invariant-build 13/13 PASS, fuzz 20-seeds PASS. web_heap_base = 5.269 MiB (static floor);
zone = 4.000 MiB; peak estimate = 5.269 + 4.000 + 17.353 (tnt.wad) = 26.622 MiB < 32 MiB.
INITIAL_MEMORY confirmed 32 MiB (buffer.byteLength = 33,554,432). fs build UNAFFECTED (own zone config).

---

### C4 — BSS diet: MAXVISPLANES 1024 → 128

| field | value |
|-------|-------|
| **mechanism** | Reduce `MAXVISPLANES` in `engine/core/r_plane.c` from 1024 (webdoom-expanded) back to vanilla's 128. BSS delta: `sizeof(visplane_t)` from `engine/core/r_defs.h` = 5×int32 (20 B) + 1 pad + 320 top-bytes + 2 pads + 320 bottom-bytes + 1 pad = **664 bytes** (note: Plans.md seed says ≈569 KiB for 1024 entries, implying ~569 bytes/struct; actual struct from source = 664 bytes — discrepancy noted, use struct sizeof). 1024×664 = 679,936 bytes = 664 KiB current; 128×664 = 85,008 bytes = 83 KiB; **savings ≈ 581 KiB BSS**. `__heap_base` shifts; render golden regold required (same regold protocol as every BSS layout change per perf.md §2.5 note). |
| **predicted Δinstr/tic** | 0. Static array size does not affect instruction count during rendering. |
| **measured Δinstr/tic** | 0. Confirmed: cycle-floor within variance across all 13 demos (parallel d4b2747 verification). |
| **axis** | RAM / portability |
| **magic-data policy** | None. **COMPLIES.** |
| **kill rule** | `I_Error("R_FindPlane: no more visplanes")` on any of 13 golden demos = kill. Evidence: task 2.3 measured peak visplane count = **68** (tnt-demo2); vanilla 128 provides 1.88× margin over measured worst case. **Kill rule NOT triggered: 13/13 demos PASS with no I_Error (verified in both parallel implementations).** |

**Verdict: MEASURED (14.2d) — LANDED**

14.2d landing evidence: sim 13/13 PASS, render-high 13/13 PASS (NO REGOLD — unpinning holds;
ledger "regold required" prediction corrected), invariant-build 13/13 PASS, fs 13/13 PASS.
BSS delta measured exactly: wasm `__heap_base` 5,525,296 → 4,930,352 = **−594,944 bytes = −581.0 KiB**
(= 896 × 664 bytes, bit-exact match to arithmetic prediction). fs-doom .bss likewise −581.0 KiB.
Regold outcome: NOT NEEDED — post-3.2 layout unpinning proves that a pure BSS-size change is
pixel-identical without regold (same pattern as 13.2a zone re-trial).

Parallel-runner cross-verification (d4b2747 — a duplicate 14.2d implementation from a concurrent
harness runner; engine diff vs c90fc10 is comment-only, so its gate results transfer): render-low
13/13 pixel-identical unregolded, fuzz 20/20, cycle-floor within variance, wasm size independently
reproduced at 356,206 B. Archaeology reconciled post-landing: rdr-005/rdr-006 expectations updated
(c90fc10 landed without them — source-constant-verify was 37/40 on master until the reconcile
commit) and perf-008 (ZONESIZE 4 MiB) healed from 14.2c.

Notes: Task 2.3 (perf.md) measured peak visplanes = 68 (tnt-demo2). With vanilla 128, there
is a 60-plane safety margin for the measured demo corpus. Custom PWADs with more open geometry
might hit higher counts; the kill rule covers this. Regold was predicted as the primary cost
but was not required — the unpinning (post-3.2) eliminated layout sensitivity.

---

### C5 — BSS diet: MAXDRAWSEGS 2048 → 256

| field | value |
|-------|-------|
| **mechanism** | Reduce `MAXDRAWSEGS` in `engine/core/r_defs.h` from 2048 (webdoom-expanded) to 256 (vanilla). `sizeof(drawseg_t)` from `engine/core/r_defs.h`: seg_t*(4) + int×2(8) + fixed_t×3(12) + int(4) + fixed_t×2(8) + short*×3(12) = **48 bytes** (wasm32, 4-byte pointers). Before: 2048×48 = 98,304 bytes ≈ 96 KiB. After: 256×48 = 12,288 bytes ≈ 12 KiB. **Savings = 84 KiB BSS** (Plans.md seed said "120 KiB" — incorrect sizeof assumption; actual sizeof=48). `__heap_base` shifts −86,016 B (exact, confirmed 14.2e). Render golden regold not required (13/13 UNREGOLDED pass). |
| **predicted Δinstr/tic** | 0. Static array. |
| **axis** | RAM / portability |
| **magic-data policy** | None. **COMPLIES.** |
| **kill rule** | `R_StoreWallRange` overflow guard fires on any 13 golden demos = kill. Overflow is silent (renderer.md §10); render-golden pixel divergence is the detector. |
| **measured peak drawsegs** | doom-demo1=59, doom-demo2=46, doom-demo3=62, **doom-demo4=205**, doom2-demo1=104, doom2-demo2=58, doom2-demo3=115, tnt-demo1=95, tnt-demo2=112, tnt-demo3=108, plutonia-demo1=180, plutonia-demo2=161, plutonia-demo3=157. **Corpus max: 205 (doom-demo4)**. |
| **margin** | 256/205 = **1.25×** ⚠️ THIN MARGIN — doom-demo4 is 51 segs below the cap. Complex PWAD scenes could exceed 256; flag for lead judgment before re-raising C6 (MAXOPENINGS). |
| **wasm size** | Before: 356,211 B raw. After: see size-ledger below. `__heap_base` −86,016 B. |
| **gates** | 13/13 sim PASS · 13/13 render PASS (unregolded) · 13/13 render-low PASS · 20/20 fuzz PASS · 13/13 fs-doom PASS · verify-all.sh rc=0 · size-ledger rc=0 |

**Verdict: LANDED — task 14.2e** ⚠️ NOTE thin 1.25× margin at doom-demo4; lead should evaluate before further BSS reduction candidates that share render limits.

Notes: Instrumented build (`-DWEB_PERF_DRAWSEG_STATS`) run across all 13 demos before downsize to
validate peak. Peak 205 < 256 → no overflow in golden corpus → kill rule not triggered.
Render golden divergence would have been the overflow signal (silent drop, not crash).

---

### C6 — BSS diet: MAXOPENINGS 320×256 → 320×64

| field | value |
|-------|-------|
| **mechanism** | Reduce `MAXOPENINGS` in `engine/core/r_plane.h` from `SCREENWIDTH*256` (81,920 shorts = **160 KiB**) to vanilla's `SCREENWIDTH*64` (20,480 shorts = 40 KiB). **Savings: 120 KiB BSS**. `openings[]` is written during `R_StoreWallRange` as clipping bounds for masked sprites; usage is bounded by the number of visible wall segs × height. |
| **predicted Δinstr/tic** | 0. Static array. |
| **axis** | RAM / portability |
| **magic-data policy** | None. **COMPLIES.** |
| **kill rule** | `lastopening - openings > MAXOPENINGS` overflow guard fires on any 13 golden demos = kill. Kill rule NOT triggered (see measurements below). |
| **overflow behavior at ×64** | r_segs.c guards check `lastopening - openings + needed <= MAXOPENINGS` before each write. On overflow: (1) masked midtex dropped (maskedtexture=false), (2) sprtopclip nulled + SIL_TOP cleared, (3) sprbottomclip nulled + maskedtexture cleared. All fail-soft, demo-neutral. Deviates from vanilla: vanilla's RANGECHECK I_Error is a debug-only check; shipping vanilla has no guard at all (silent OOB write). webdoom's r_segs.c guards are strictly safer than vanilla's shipping behavior. |

**Measurements (task 14.2f, -DWEB_PERF_OPENINGS_STATS, 13-demo corpus):**

| demo | opening_peak |
|------|-------------|
| doom-demo1 | 1,912 |
| doom-demo2 | 906 |
| doom-demo3 | 1,400 |
| doom-demo4 | 2,455 |
| doom2-demo1 | 1,636 |
| doom2-demo2 | 1,373 |
| doom2-demo3 | 1,984 |
| tnt-demo1 | 1,783 |
| tnt-demo2 | 1,220 |
| tnt-demo3 | **2,527** ← corpus max |
| plutonia-demo1 | 2,432 |
| plutonia-demo2 | 1,954 |
| plutonia-demo3 | 2,463 |

**Corpus max: 2,527 / 20,480 limit = 8.1× margin. Kill rule not triggered. Downsize proceeds.**

Margin-flag protocol: flag only if corpus max > ~13,650 (1.5× of 20,480). 2,527 << 13,650 — no flag needed.

**Verdict: LANDED (14.2f)**

BSS savings: (81,920 − 20,480) × 2 B = 122,880 B = **120 KiB exactly**.
`__heap_base`: see commit message for before/after values.
13/13 render goldens pass UNREGOLDED (consistent with 14.2d and 14.2e patterns).

Notes: The expansion from *64 to *256 was a robustness measure applied before task 2.3.
Peak measurement shows vanilla's *64 has 8.1× headroom over the 13-demo corpus.
Overflow guards in r_segs.c (fail-soft) are the correct failure surface at *64 —
strictly safer than vanilla's shipping behavior (no guard at all).

---

### C7 — STACK_SIZE 4 MiB → 1 MiB (bare-metal / freestanding builds)

| field | value |
|-------|-------|
| **mechanism** | Prove and gate that 1 MiB of process stack is sufficient for the freestanding (i386 ELF) build. The wasm artifact (`-sSTACK_SIZE=4MB` in engine/Makefile) is **unchanged** — any reduction there shifts `__heap_base` and requires a conscious regold step (perf.md §Q2/Axis 3). For tools/baremetal/doom.ld, no explicit 4 MiB reservation exists; the ARM stack is implicitly top-of-26 MiB RAM minus heap, with a comment estimating ~64 KB actual use. The 4→1 MiB saving is a statement about portability: a future bare-metal target that reserved 4 MiB could safely cap at 1 MiB. |
| **predicted Δinstr/tic** | 0. No runtime compute change. |
| **axis** | RAM / portability |
| **magic-data policy** | None. **COMPLIES.** |
| **kill rule** | Stack overflow (crash or sanitizer report) on any 13 golden demos = kill. |
| **measured peak stack** | fs-doom binary alone: ≈14 KiB (ulimit floor at 15 KiB passes doom-demo3; 14 KiB fails). Full run-check.sh including python3 comparator: floor at 128 KiB. At 1 MiB: 13/13 pass, 0 ASan hits. The §Q2 estimate of "960 B BSP + 32 KB runtime" was correct in direction; actual is lower (~14 KiB total with glibc startup overhead). |
| **gate wired** | `make check-stack-1m` in tools/freestanding/Makefile. Runs `ulimit -s 1024` in the same shell as run-check.sh so fs-doom and python3 both inherit the limit. 13/13 PASS confirmed. |
| **RAM Δ** | Wasm: 0 (unchanged). tools/baremetal/doom.ld: 0 (no explicit reservation; stack is implicit top-of-RAM). Portability saving: a bare-metal target with a 4 MiB explicit stack reservation could reduce to 1 MiB, saving 3 MiB of SRAM/PSRAM. |

**Verdict: LANDED (14.2g)**

Notes: The wasm `STACK_SIZE=4MB` is NOT changed — perf.md §Q2/Axis 3 verdict "keep 4 MB" stands.
The tools/baremetal linker (doom.ld) has no explicit 4 MiB stack block; stack is whatever RAM
remains above .bss (implicitly ~several MiB of headroom in QEMU, practically ≪1 MiB used).
The task lands as a **proof-and-gate** step: 1 MiB is proven sufficient for all 13 golden demos
and wired as a repeatable `make check-stack-1m` gate. The ASan build at the same 1 MiB limit
reports 0 stack-overflow hits across all 13 demos. Wasm artifact md5 unchanged: `1931aa623bd0e90e408d1ddd9c9b3c28`.

---

## Killed candidates

All rows below are KILLED. A killed row does not get a follow-up task.

### K1 — R_DrawSpan: 4-wide u32 packing (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Pack 4 `ds_colormap[ds_source[spot]]` bytes into one `uint32_t` and write with one unaligned store. |
| **predicted Δinstr/tic** | -7.9% planes on wbox (source: perf.md §Q1 killed section — "planes +7.9% across demos (demo1 +10.1%, demo2 +6.8%, demo3 +5.9%)"). Note: the measured value is a REGRESSION, not a win. |
| **axis** | cycle-floor |
| **magic-data policy** | None. |
| **kill rule** | wbox regression = kill. |

**Verdict: KILLED — measured wbox planes regression +7.9%. Verbatim from Plans.md kill-list.**

Reopen condition: none stated. Kill is final.

---

### K2 — wasm SIMD (v128 for R_DrawSpan 8-wide / R_DrawColumn) (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Use wasm v128 SIMD for R_DrawSpan gather (8 parallel palette lookups) or R_DrawColumn (batch column writes). |
| **predicted Δinstr/tic** | Unmeasurable win: R_DrawSpan requires gather (`ds_source[spot]` = random addresses); wasm v128 has no native gather; emulation via 8 × `v128.load8_lane` negates throughput. R_DrawColumn requires framebuffer transposition first (C1). |
| **axis** | cycle-floor |
| **magic-data policy** | None. |
| **kill rule** | wasm SIMD gather emulation overhead ≥ scalar; confirmed by perf.md assessment. |

**Verdict: KILLED — no gather in wasm v128. Verbatim from Plans.md kill-list.**

Reopen condition: framebuffer transposition (C1) lands AND eliminates the stride-320 blocker for
R_DrawColumn; R_DrawSpan gather blocker remains regardless of C1.

---

### K3 — Visplane hash (R_FindPlane O(n) → hash) (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Replace R_FindPlane linear search with a small hash (key = height×picnum×lightlevel). |
| **predicted Δinstr/tic** | Ceiling: 2.9% of planes stage (task 2.3 measurement: worst case 451.5 iters/frame × 10 ns/iter = 4.5 µs vs 156.6 µs baseline = 2.9% of planes). With planes at 32.7% of whole: max win = 0.029 × 0.327 × 1,231K = ~11.7K instr/tic — less than measurement noise (1.3–9.9% = 16–129K). Not measurable. |
| **axis** | cycle-floor |
| **magic-data policy** | None. |
| **kill rule** | ceiling 2.9% of planes stage, probe depth 6.6 iters average — unmeasurably small gain. |

**Verdict: KILLED — ceiling 2.9% of planes, probe depth 6.6. Verbatim from Plans.md kill-list.**

Reopen condition: none. The linear scan is cheap at measured visplane counts (≤68).

---

### K4 — Q4 sim hot paths (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Profile blockmap iterators (P_BlockLinesIterator, P_BlockThingsIterator), P_CheckSight, P_ApproxDistance for sim speedup. |
| **predicted Δinstr/tic** | sim = 3.4–8.3% of whole-program (48–87K instr/tic p50 per cycle-attribution.json per_iwad). Any sim speedup is ≤8.3% of whole at the measurement floor; frozen-surface risk (13 sim goldens + Chocolate cross-validation) is disproportionate. |
| **axis** | cycle-floor |
| **magic-data policy** | None. |
| **kill rule** | Absent perf.md's two reopen conditions: (a) Q0 finding that JS-side sim invocation overhead dominates, or (b) a bare-metal profile where sim dominates. Neither condition is currently met. |

**Verdict: KILLED — Q4 sim hot paths. Verbatim from Plans.md kill-list.**

Reopen conditions: (a) 12.2b closed but did not find JS-side sim dominance — rAF callback median
0.2 ms, sim not identified as bottleneck; (b) no bare-metal profile yet shows sim dominance
(13.1b: sim = 3.4–8.3% of whole on x86-64). Both conditions remain unmet.

---

### K5 — emcc knob re-sweeps (axes 1–5) (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Re-sweep -O3/-Os/-O2 (Axis 1), --closure (Axis 2), STACK_SIZE (Axis 3), INITIAL_MEMORY combos (Axis 4), emmalloc vs dlmalloc (Axis 5). |
| **predicted Δinstr/tic** | Varies by axis; all five axes measured and closed in task 2.6 (see perf.md §Q2). -Os: -9.3% wasm sim fps = KILL; -O2: marginal gain, KILL; others: no speed impact, keep shipped defaults. |
| **axis** | cycle-floor / size |
| **magic-data policy** | None. |
| **kill rule** | wbox regression = kill. Applied to -Os (-9.3% sim fps). Other axes closed with document-only verdicts. |

**Verdict: KILLED — axes 1–5 done. Verbatim from Plans.md kill-list.**

Exception: -Os revisit is explicitly reserved for bare-metal flash-pressure scenario (14.3
references prf-007/008; the CODE section shrinks 33% under -Os which is meaningful for flash).
That is a bare-metal-specific task, not a universal-artifact re-sweep.

---

### K6 — Per-target wasm builds (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Build separate wasm artifacts per target (e.g., -Os for embedded, -O3 for desktop). |
| **predicted Δinstr/tic** | Per-target savings vary; universality is lost. |
| **axis** | size / cycle-floor |
| **magic-data policy** | None. |
| **kill rule** | spec non-goal ("one universal artifact is the tenet" per spec.md explicit non-goals). |

**Verdict: KILLED — spec non-goal. Verbatim from Plans.md kill-list.**

---

### K7 — Runtime lookup → runtime transcendental (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Replace precomputed trig/color tables with runtime `sin`/`tan`/`sqrt` calls at lookup sites. |
| **predicted Δinstr/tic** | Regression: runtime transcendentals are slower than table lookups (perf.md §magic-data: "Runtime lookup → runtime transcendental is forbidden (measured slower)"). The tables are boot-generated from cracked recipes (magic-data.md), not shipped blobs. |
| **axis** | cycle-floor |
| **magic-data policy** | VIOLATES: "The only sanctioned table transform is shipped-blob → boot-generation. Runtime lookup → runtime transcendental is forbidden (measured slower)." Per spec.md §magic-data-policy. |
| **kill rule** | Magic-data policy violation = kill. spec.md §magic-data-policy explicitly forbids this transform with "measured slower" as the documented empirical reason. |

**Verdict: KILLED — magic-data policy violation. Verbatim from Plans.md kill-list.**

---

### K8 — Browser-fps-motivated wasm-side work (from Plans.md kill-list)

| field | value |
|-------|-------|
| **mechanism** | Any wasm optimization framed as a browser-fps improvement (reducing wasm render time to improve browser framerate). |
| **predicted Δinstr/tic** | Real but browser-irrelevant. wasm render = 1.71% of 28.57 ms budget on wbox (browser-pipeline-wbox.json: rAF callback p50 = 0.2 ms; perf.md §C: render is not the bottleneck). A 50% wasm speedup saves 0.85% — unmeasurable by browser users at 35 Hz. |
| **axis** | cycle-floor |
| **magic-data policy** | None. |
| **kill rule** | render = 1.71% and sim = 0.25% of the 35 Hz budget on the weakest host. retrospective.md already caught this framing error once. |

**Verdict: KILLED — browser-fps framing invalid. Verbatim from Plans.md kill-list.**

The legitimate framing for wasm render optimization is bare-metal fps / CI throughput (Plans.md
Phase 14 preamble: "Wins are claimed in 13.1 units (instructions/tic) and CI/bare-metal
throughput, NEVER browser fps"). K8 kills the framing, not the optimization.
Candidates C1 and C2 are correctly framed on the bare-metal axis.

---

### K9 — Combined ds_colormap×ds_source lookup table (new candidate, killed on policy)

| field | value |
|-------|-------|
| **mechanism** | Precompute at level-load time a combined `uint8_t flat_color[N_lightlevels][N_texels]` table collapsing `ds_colormap[ds_source[spot]]` to a single lookup. Eliminates one indirection in R_DrawSpan inner loop. |
| **predicted Δinstr/tic** | planes = 402,167 instr/tic (doom.wad p50). R_DrawSpan double-lookup (`ds_colormap[ds_source[spot]]`) is the inner-loop bottleneck. Removing one level saves ~1 instruction per pixel in the scan-line loop; R_DrawSpan averages 168.2 px/call × 147.8 calls/frame. Single-instruction savings ≈ small fraction of 402K but unmeasured. |
| **axis** | cycle-floor |
| **magic-data policy** | VIOLATES: policy allows "shipped-blob → boot-generation" only. A runtime-generated flat_color table is a NEW table not in vanilla, not boot-generated from a cracked recipe, not shipped. "The only sanctioned table transform is shipped-blob → boot-generation" (spec.md §magic-data-policy). This table would be generated at level-load time from in-memory data — not sanctioned. |
| **kill rule** | Magic-data policy violation = kill. spec.md §magic-data-policy: "The only sanctioned table transform is shipped-blob → boot-generation." A runtime level-load-time generated table is neither a shipped blob nor a boot-generation transform from one. |

**Verdict: KILLED — magic-data policy violation (new runtime-generated precomputed table not
sanctioned by policy).**

---

## Summary

| id | mechanism | axis | Δinstr/tic | verdict |
|----|-----------|------|------------|---------|
| C1 | Framebuffer transposition | cycle-floor / portability | MEASURED: −2.77…−5.12% mean instr/tic (within variance band, direction consistently negative); bare-metal PSRAM wall-clock win still UNMEASURED | LANDED (14.2a) |
| C2 | Low-detail mode (bare-metal option) | cycle-floor / simplicity | MEASURED: whole-program −19.5…−28.3% instr/tic (bsp −22.1% mean, planes −41.5% mean); exposed+fixed 2 latent 14.2a Low-path bugs | LANDED (14.2b) |
| C3 | ZONESIZE 32→4 MiB shipping | RAM | 0 instr/tic; -28 MiB zone pool; 64→32 MiB INITIAL_MEMORY | LANDED (14.2c) |
| C4 | MAXVISPLANES 1024→128 | RAM / portability | 0 instr/tic; 581 KiB BSS savings (896 × 664 bytes) | LANDED (14.2d) |
| C5 | MAXDRAWSEGS 2048→256 | RAM / portability | 0 instr/tic; 84 KiB BSS savings (1792 × 48 B); peak 205/256 ⚠️ thin 1.25× | LANDED — 14.2e |
| C6 | MAXOPENINGS 320×256→320×64 | RAM / portability | 0 instr/tic; 120 KiB BSS savings (61,440 × 2 bytes); peak 2,527/20,480 = 8.1× margin | LANDED — 14.2f |
| C7 | STACK_SIZE 4→1 MiB (bare-metal builds) | RAM / portability | 0 instr/tic; measured peak ≈14 KiB (fs-doom) / ≈128 KiB (harness); 1 MiB = 70×/8× margin; wasm unchanged | LANDED (14.2g) |
| K1 | R_DrawSpan u32 packing | cycle-floor | wbox +7.9% planes REGRESSION | KILLED |
| K2 | wasm SIMD | cycle-floor | no gather in v128 | KILLED |
| K3 | Visplane hash | cycle-floor | ceiling 2.9% of planes, probe depth 6.6 | KILLED |
| K4 | Q4 sim hot paths | cycle-floor | reopen conditions unmet | KILLED |
| K5 | emcc knob re-sweeps (axes 1–5) | cycle-floor / size | all closed; -Os kills speed | KILLED |
| K6 | Per-target wasm builds | size | spec non-goal | KILLED |
| K7 | Runtime lookup→transcendental | cycle-floor | magic-data policy violation (measured slower) | KILLED |
| K8 | Browser-fps-motivated wasm work | cycle-floor | framing invalid (render 1.71% of budget) | KILLED |
| K9 | Combined flat_color lookup table | cycle-floor | magic-data policy violation (new runtime table) | KILLED |
| NC1 | R_DrawSpan packed-position single-increment | cycle-floor | KILLED — packed 16-bit y-field carry propagates into x-field on yfrac overflow; all 13 render goldens PIXEL DESYNC at tic 0–1 | KILLED (20.2b) |
| NC2 | MAXSEGS solidsegs census (64→32 candidate) | RAM / portability | 0 instr/tic; 256 bytes BSS (survey required); UNMEASURED | SURVIVES → task 20.2b |
| NC3 | R_GetColumn composite fast-path inlining | cycle-floor | predicted −3K…−4K instr/tic (0.6–0.9% of bsp; anchor: perf-034 = 714.8 calls/tic × 5 instr/call = 3,574 instr/tic); UNMEASURED | SURVIVES → task 20.2b |
| NC4 | R_DrawColumn 8-wide unroll (extend existing 4-wide) | cycle-floor | predicted −5K…−10K instr/tic (1–2% of bsp); UNMEASURED | SURVIVES → task 20.2b |
| NC5 | R_DrawSpan 4-wide loop unroll | cycle-floor | MEASURED: −47,707 instr/tic p50 doom.wad demo3 (−4.2% whole, −11.9% planes); scalar xfrac/yfrac, no packing | LANDED (20.2b) |

**Totals: 21 candidates, 12 survivors (8 landed, 4 surviving), 10 killed.**

---

*Generated: task 14.1 (C1–K9). NC1–NC5 added task 20.2a. NC1 killed, NC5 landed: task 20.2b.
Sources: cycle-attribution.json, cycle-floor.json, zone-stats.json,
browser-pipeline-{alder,wbox}.json, perf.md §13.1a/b/§G/§Q1, spec.md §magic-data-policy,
bare-metal.md §7.3, docs/renderer.md §7.2, r_draw.c, r_bsp.c.*

---

## Phase 20.2b — NC5 R_DrawSpan 4-wide unroll (task 20.2b)

### NC1 kill: packed-position carry divergence

NC1 proposed encoding `xfrac`/`yfrac` into a single packed `uint32_t position` (x in bits 16–31,
y in bits 0–15) so that one `position += step` replaces two additions per pixel. The mechanism
appeared algebraically equivalent but has a critical flaw: when `yfrac` overflows its 16-bit
sub-field during repeated addition of `ystep`, the carry bit propagates into the x-field (bits
16+). In scalar form `yfrac` overflows silently in 32-bit space and the extraction mask isolates
the correct 6-bit index; in packed form the overflow corrupts the x-index. Empirically: all 13
render goldens showed PIXEL DESYNC at tic 0–1 on master with real WADs. NC1 filed KILLED.

### NC5 implementation: 4-wide unroll, scalar accumulators

`R_DrawSpan` in `engine/core/r_draw.c` replaced with a 4-wide unrolled loop:

- `xfrac`/`yfrac` remain separate `fixed_t` accumulators — no packing, bit-identical carry
  behaviour to the original scalar loop
- Each 4-pixel group pre-computes `xf0..xf3`, `yf0..yf3` by 3 incremental adds
- Four independent `spot` values → four independent `ds_source[spot_k]` loads (OOO-parallel)
- Writes: `dest[0]`, `dest[SCREENHEIGHT]`, `dest[2*SCREENHEIGHT]`, `dest[3*SCREENHEIGHT]`
  (column-major 14.2a stride)
- Advance: `xfrac += 4*ds_xstep; yfrac += 4*ds_ystep; dest += 4*SCREENHEIGHT; count -= 4`
- Tail loop handles 0–3 remaining pixels (same scalar body as original)

Bundled pre-existing fixes also landed in this commit:
- `r_draw.c:590` UB cast `(int)translationtables` → `(uintptr_t)translationtables` +
  `~255` → `~(uintptr_t)255`; `#include <stdint.h>` added
- `tools/freestanding/i_system.c`: `FS_ALLOCLOW_SIZE` uses `MAXSCREENWIDTH` (not `SCREENWIDTH`)
- `tools/freestanding/i_video.c`: static buf uses `MAXSCREENWIDTH`; function bodies use
  `screenwidth` at runtime

### Instruction count measurement (WD_CYCLES=1, doom.wad demo3, fs-doom -m32 -O1)

| build | p50 instr/tic | mean instr/tic | p99 instr/tic |
|-------|--------------|----------------|---------------|
| before (89b0ca9 scalar) | 1,123,751 | 1,033,734.9 | 1,620,227 |
| after (NC5 4-wide unroll) | 1,076,044 | 963,902.9 | 1,530,440 |
| **delta** | **−47,707** | **−69,832** | **−89,787** |

p50 gain: **47,707 instr/tic** = **−4.2% whole-program** / **−11.9% of planes stage**
(planes baseline 402,167 doom.wad p50, perf.md §13.1b).
Kill threshold was 9,000 instr/tic; actual gain is 5.3× the threshold.

Notes (measurement transparency):
- The NC5 prediction was 18K–37K instr/tic; measured 47.7K exceeds the upper
  bound by ~29% because at `-O1` the compiler does not auto-unroll the scalar
  baseline at all — the conservative prediction assumed partial compiler
  realization. Not evidence inflation: before/after are symmetric (same flags,
  same demo, same host) and the margin over the kill threshold is 5.3×.
- The kill rule's "doom.wad p50" is anchored to **demo3** for this measurement
  (the earlier reverted iteration used demo2 under the same label); both sides
  of the comparison use demo3, so the delta is internally valid.
- `-O1` native only; the shipped wasm `-O3` gain is unmeasured and likely
  smaller — optimized codegen may partially unroll the scalar baseline.

### Gate results (all with real WADs, non-vacuous)

| gate | command | result |
|------|---------|--------|
| sim | `node tools/demo-test.mjs` | PASS — all demos bit-identical to golden **(13 demos)** |
| render-high | `node tools/demo-test.mjs --render` | PASS — all render goldens pixel-identical **(13 demos)** |
| render-low | `node tools/demo-test.mjs --render --low-detail` | PASS — all [low-detail] render goldens pixel-identical **(13 demos)** |
| render-wide | `node tools/demo-test.mjs --render --render-wide` | PASS — all render goldens pixel-identical **(13 demos)** |
| sim-wide | `node tools/demo-test.mjs --sim-wide` | PASS — sim invariant under wide (W=854): 13 demos byte-exact **(13 demos)** |
| sprite-witness | `node tools/sprite-witness-test.mjs` | PASS — sprite-edge witness goldens verified (r_things.c:530 cull pin) |
| mixed-width-net | `node tools/mixed-width-net-test.mjs` | PASS — mixed-width (P0=320 vs P1=854): 368 tics, 0 mismatches |
| size-ledger | `node tools/archaeology/size-ledger.mjs` | PASS size-ledger: all hard checks green |
| lint | `bash tools/lint.sh` | lint: OK |
| verify-all | `bash tools/archaeology/verify-all.sh` | ALL PASS verify-all: all checks green (107 claims) |

---

## Phase 20.2a — Fresh optimization survey (task 20.2a)

Hunting grounds: bsp/segs/planes hotspots, column-major cache-layout effects, fixed-point
kernel micro-optimizations. Excluded by design: FastDoom visual-quality catalog (fake-flat,
sb-skip, potato columns, diff-blit) and rp2040-doom known techniques (DMA span, reduced
colormap levels). Each entry below includes a one-line "non-overlap" marker showing it is
independent of both excluded catalogs and the existing C1–K9 ledger.

### NC1 — R_DrawSpan packed-position single-increment

| field | value |
|-------|-------|
| **mechanism** | Replace the two separate `fixed_t xfrac, yfrac` accumulators in R_DrawSpan's inner loop with a single packed `uint32_t position` register. Encoding: `position = ((xfrac << 10) & 0xffff0000) \| ((yfrac >> 6) & 0xffff)`, step likewise. Each pixel then does `position += step` (1 increment) instead of `xfrac += xstep; yfrac += ystep` (2 increments). Spot extraction: `x_idx = position >> 26` (`&63` implicit in 6-bit field), `y_idx = (position >> 4) & 4032` (`4032 = 63*64`), `spot = x_idx \| y_idx` (matches existing `((yfrac>>(16-6))&(63*64)) + ((xfrac>>16)&63)`). The approach is already present in r_draw.c as a commented-out `#if 0` block (r_draw.c:700–766) labelled "Loop unrolled" with the exact same packing. **The block cannot be re-enabled directly:** (a) r_draw.c:709 has a `usingned spot;` typo — must be corrected to `unsigned spot;` before the block will compile; (b) the block uses pre-14.2a row-major stride — `dest[0]`, `dest[1]`, `dest[2]`, `dest[3]`, then `dest += 4` — which writes to consecutive framebuffer bytes; after the 14.2a column-major transposition, the correct stride is `dest[0]`, `dest[SCREENHEIGHT]`, `dest[2*SCREENHEIGHT]`, `dest[3*SCREENHEIGHT]`, then `dest += 4*SCREENHEIGHT`. The packed-position arithmetic itself is valid and reusable; only the typo fix and stride adaptation are required. |
| **predicted Δinstr/tic** | Anchor: R_DrawSpan total pixels/tic = 24,854 (perf.md §2.2 doom-demo1, 1,710 frames; verified by claims perf-039, recomputed 24,860). Saving: replacing 2 fixed-point additions with 1 per pixel = 1 instr/pixel saved. Upper bound: 24,854 × 1 = 24,854 instr/tic = 6.2% of planes (402,167 doom.wad p50, perf.md §13.1b). Conservative (compiler already ILP-schedules independent additions): 1–3% of planes = 4,027–12,065 instr/tic = 0.3–1.0% of whole (whole = 1,230,745 doom.wad p50). Arithmetic: 24,854 px × 1 instr/px = 24,854 upper; × 0.2–0.5 compiler-realization factor = **4,971–12,427 instr/tic predicted range**. |
| **axis** | cycle-floor |
| **magic-data policy** | None. No new tables. No precomputation. **COMPLIES.** |
| **tic-exact-safe?** | **YES.** R_DrawSpan is render-only. `ds_source`, `ds_colormap`, `dest` (framebuffer) — none of these feed P_Random, actor state, or any sim-visible variable. The packing is a pure accumulator transformation; texture index `spot` is mathematically identical to the existing formula (verified algebraically from the `#if 0` block). Sim goldens are unchanged by construction. |
| **kill rule** | Measured icount improvement < 4,000 instr/tic (1% of planes) on doom.wad p50 after instrumentation = drop. Any sim golden mismatch (13/13) = kill (impossible for this change, but stated for completeness). Any render golden pixel divergence before explicit regold = kill. |
| **non-overlap** | K1 (killed) packed 4 *palette-output bytes* into one u32 store to reduce memory writes — a different mechanism (write compression) that measured a regression. NC1 packs the *texture coordinate state* into one accumulator to reduce arithmetic — orthogonal to K1 and unrelated to FastDoom's visual-quality reductions. Not in rp2040-doom DMA/colormap catalog. |

**Verdict: KILLED — 20.2b (packed-position carry divergence)**

**Kill reason:** The 16-bit y-field in the packed accumulator overflows during repeated `ystep` addition. In the unpacked scalar form, overflow of `yfrac` is harmless: the extraction mask `(yfrac>>(16-6))&(63*64)` discards upper bits and the accumulated value stays in the correct 6-bit index range. In the packed form the y-field occupies bits 0–15 of the `uint32_t`; on overflow the carry propagates into x-field bits 16+, corrupting the x-index on every span where `yfrac` wraps. Observed impact: **all 13 render goldens showed PIXEL DESYNC at tic 0–1** when NC1 was applied to master with real WADs (first detected post cherry-pick in a prior 20.2b attempt).

**Reopen condition:** Reopen only if a carry-safe encoding is proven bit-exact across all 13 render goldens on all IWADs. The encoding must prevent carry from crossing the y/x field boundary under all plausible `ystep` sequences, including negative steps and large-magnitude steps as used on steep view angles.

*(Note: the joint-implementation plan was superseded. NC5 was implemented independently — see §20.2b below.)*

---

### NC2 — MAXSEGS solidsegs census (64→32 downsize candidate)

| field | value |
|-------|-------|
| **mechanism** | `solidsegs[MAXSEGS]` in r_bsp.c is the clip list for solid wall segments; MAXSEGS was doubled from vanilla 32 to 64 as a robustness measure (r_bsp.c:106: `"webdoom: was 32"`). If the 13-demo corpus peak solidsegs count is < 32, the array can revert to vanilla's 32. BSS saving: 32 entries × 8 bytes (sizeof cliprange_t = 2 × int) = **256 bytes**. Protocol: instrument with `-DWEB_PERF_SOLIDSEGS_STATS` (same pattern as drawseg/openings/visplane instrumentation in prior tasks), run 13 demos, record peak. If corpus max ≤ ~22 (1.5× margin below 32), proceed; otherwise keep 64. |
| **predicted Δinstr/tic** | **0.** Reducing a static BSS array does not change instruction count at runtime. Identical to C4/C5/C6 pattern. |
| **axis** | RAM / portability |
| **magic-data policy** | None. **COMPLIES.** |
| **tic-exact-safe?** | **YES.** r_bsp.c:144 comment confirms: "demo-neutral: solidsegs is render-only, never read by the sim." R_ClipSolidWallSegment and R_ClipPassWallSegment are renderer-only functions. No P_Random consumption. No sim-visible state. Source constant rdr-001 = 32 (vanilla) and rdr-002 = 64 (webdoom) verified by verify-all.sh source-constant gate. |
| **kill rule** | `I_Error("R_ClipSolidWallSegment: too many (start)")` fires on any of 13 golden demos = kill. Render golden pixel divergence on any demo (solid-seg overflow causes silent missed walls, not crash, so pixel delta is the correct kill detector). |
| **non-overlap** | C4 reduced MAXVISPLANES, C5 reduced MAXDRAWSEGS, C6 reduced MAXOPENINGS. NC2 targets MAXSEGS (solidsegs), the one remaining BSS array in r_bsp.c not yet surveyed. Not in FastDoom visual-quality catalog. Not in rp2040-doom catalog. |

**Verdict: SURVIVES → task 20.2b (priority: low; 256 bytes BSS only; requires survey pass first)**

---

### NC3 — R_GetColumn composite fast-path inlining

| field | value |
|-------|-------|
| **mechanism** | In R_RenderSegLoop (r_segs.c), `dc_source = R_GetColumn(midtexture, texturecolumn)` is called once per wall column. R_GetColumn (r_data.c:383–401) performs: (a) `col &= texturewidthmask[tex]`, (b) look up `texturecolumnlump[tex][col]` and `texturecolumnofs[tex][col]`, (c) if `lump > 0` return via W_CacheLumpNum (rare: multi-patch textures); (d) if `!texturecomposite[tex]` generate composite (rare: first access); (e) return `texturecomposite[tex] + ofs`. For single-patch textures (the common case in DOOM's WADs), `lump ≤ 0` and `texturecomposite[tex]` is already populated, so the hot path is just branch (c) = false + branch (d) = false + `return base + ofs`. The optimization: hoist `comp_base = texturecomposite[tex]`, `widthmask = texturewidthmask[tex]`, and `colofs = texturecolumnofs[tex]` outside the column loop; inside the loop replace the function call with `dc_source = comp_base + colofs[texturecolumn & widthmask]`. The same inlining applies to toptexture and bottomtexture segments. |
| **predicted Δinstr/tic** | Anchor: perf-034 = 714.8 R_DrawColumn calls/tic (doom-demo1, perf.md §2.2 committed measurement; confirmed by perf-036 = 34,203 px, 47.9 avg px/call → 34,203/47.9 = 714.0 calls). Each R_DrawColumn call is preceded by exactly one R_GetColumn call (R_RenderSegLoop calls R_GetColumn once before each colfunc() invocation), so 714.8 R_DrawColumn calls/tic = 714.8 R_GetColumn calls/tic. Note: perf.md §Q1 cites "~1,000–3,000 R_DrawColumn calls/frame" as an **UNVERIFIED** estimate; the committed measurement perf-034 = 714.8 is the binding anchor. Function call overhead saved per call: ~8 instrs (call setup, 2 table reads for lump/ofs, 2 conditional branches, return). Inline replacement: 1 AND + 1 array index + 1 addition = 3 instrs. Net saving: ~5 instrs/call. Arithmetic: 714.8 × 5 = **3,574 instr/tic** = 0.71% of bsp (503,704 doom.wad p50) = 0.29% of whole. Conservative range accounting for call-overhead uncertainty (±1 instr/call): 2,859–4,289 instr/tic. |
| **axis** | cycle-floor |
| **magic-data policy** | None. No new tables. Reads existing `texturecomposite`, `texturewidthmask`, `texturecolumnofs` arrays. **COMPLIES.** |
| **tic-exact-safe?** | **YES.** R_GetColumn returns a pointer into the texture composite buffer. `dc_source` is a rendering-only global consumed only by R_DrawColumn/R_DrawColumnLow, which write to `screens[0]` (the framebuffer). No P_Random consumption. No sim-visible state. The inlined arithmetic is algebraically equivalent to R_GetColumn's composite path (same texturewidthmask AND, same ofs lookup, same base + ofs return). Sim goldens unchanged. Render goldens unchanged (pixel-identical output). |
| **kill rule** | Measured icount improvement < 2,000 instr/tic on doom.wad p50 = drop (below the revised honest estimate of 3,574 instr/tic; threshold set at ~56% of estimate to allow measurement variance). Any sim golden mismatch = kill. Any render golden pixel divergence = kill (inlining must be pixel-identical to R_GetColumn's output by construction). |
| **non-overlap** | FastDoom "potato columns" reduces the number of wall columns drawn (visual quality reduction). NC3 reduces the per-column function call overhead for the same column count — orthogonal. rp2040-doom DMA approach is a bulk-transfer optimization, not function-call inlining. No entry in C1–K9 ledger targets R_GetColumn. |

**Verdict: SURVIVES → task 20.2b (priority: low-medium; 3K–4K instr/tic predicted (anchor: perf-034); bsp stage)**

---

### NC4 — R_DrawColumn 8-wide loop unroll (extending existing 4-wide from task 2.2)

| field | value |
|-------|-------|
| **mechanism** | Task 2.2 introduced a 4-wide unroll for R_DrawColumn's power-of-2 path (`while (count >= 3)` handles 4 pixels, then a 1-pixel tail). Extending to 8-wide adds an outer layer `while (count >= 7)` handling 8 pixels before falling into the existing 4-wide and 1-pixel tail. For a column with count=N: 4-wide incurs ceil(N/4) + (N mod 4) loop-control ops; 8-wide (with 4-wide fallthrough) incurs floor(N/8) + (N mod 8)/4 + (N mod 4) iterations — fewer iterations for any N ≥ 8. The 8-wide block unrolls 8 independent `colormap[source[((frac+k*fracstep)>>FRACBITS)&mask]]` reads, allowing out-of-order execution to issue all 8 texture reads in parallel. |
| **predicted Δinstr/tic** | Anchors: R_DrawColumn total px/tic = 34,203 (perf-036 claim); calls/tic = 714.8; avg px/call = 47.9 (perf.md §2.2). Loop overhead analysis per call (avg count = 46): 4-wide path: floor(46/4) = 11 four-pixel iterations + 2-pixel tail = 13 total loop overhead steps. 8-wide (with 4-wide inner): floor(46/8) = 5 eight-pixel iterations + floor(6/4) = 1 four-pixel iter + 2 tail steps = 8 total loop overhead steps. Saving: 13 − 8 = 5 steps/call × ~2 instrs/step = 10 instrs/call × 714.8 calls = **7,148 instr/tic** = 1.4% of bsp (503,704) = 0.6% of whole. Upper bound (including OOO parallelism win for tall walls): ~2% of bsp = 10,074 instr/tic. |
| **axis** | cycle-floor |
| **magic-data policy** | None. **COMPLIES.** |
| **tic-exact-safe?** | **YES.** R_DrawColumn writes to `screens[0]` (framebuffer). The 8-wide inner loop computes identical pixel values to the 4-wide path: same `colormap[source[((frac+k*fracstep)>>FRACBITS)&mask]]` expression, same traversal order (top to bottom of column), same `frac` update (`+= fracstep*8` at end of 8-wide block). No P_Random involvement. No demo-observable state. The only output is pixel bytes in the framebuffer. Render golden regold not expected (output is pixel-identical to the current 4-wide path by construction). |
| **kill rule** | Measured icount improvement < 4,000 instr/tic on doom.wad p50 vs the current 4-wide baseline = drop. Any sim golden mismatch = kill. Any render golden pixel divergence = kill (output must be identical to 4-wide baseline). |
| **non-overlap** | The task 2.2 4-wide R_DrawColumn unroll is documented in perf.md §Q1 line 662+ (not in the C1 ledger entry). NC4 is the next unroll level (8-wide) which is not in the ledger. Note: r_draw.c:232–286 contains a stale 8-wide `#if 0` variant from before task 2.2, but it uses row-major stride (`dest += 4` per group of 4 pixels) — incompatible with the 14.2a column-major framebuffer and not directly re-enableable; NC4 requires writing a new 8-wide block with correct `dest += SCREENHEIGHT` stride. FastDoom's known catalog does not include loop unrolling (it uses visual quality reductions). rp2040-doom's DMA approach is a bulk-transfer technique, not loop unrolling. K1 (killed) packed palette outputs, not the loop structure. |

**Verdict: SURVIVES → task 20.2b (priority: low-medium; 5K–10K instr/tic predicted; bsp stage)**

---

### NC5 — R_DrawSpan 4-wide loop unroll

| field | value |
|-------|-------|
| **mechanism** | Task 2.2 added a 4-wide unroll to R_DrawColumn but left R_DrawSpan as a plain single-pixel `do { ... } while (count--)` loop. R_DrawSpan's inner loop is: `spot = ((yfrac>>(16-6))&(63*64)) + ((xfrac>>16)&63); *dest = ds_colormap[ds_source[spot]]; dest += SCREENHEIGHT; xfrac += ds_xstep; yfrac += ds_ystep; count--`. A 4-wide unroll computes 4 spots, issues 4 `ds_source[spot_k]` reads (independent, can issue in parallel under OOO), and writes 4 pixels before decrementing count by 4. The 4 spot reads are independent of each other (each uses a precomputed offset `xfrac+k*xstep`, `yfrac+k*ystep`), so the CPU can overlap all 4 cache-miss loads. Loop control overhead drops from N iterations to N/4 iterations for the bulk. |
| **predicted Δinstr/tic** | Anchors: R_DrawSpan total px/tic = 24,854 (perf-039); calls/tic = 147.8; avg px/call = 168.2 (perf.md §2.2 doom-demo2). Loop overhead: current loop has 1 `count--` + 1 branch per pixel = 2 instrs/pixel loop control. 4-wide: 2 instrs / 4 pixels = 0.5 instrs/pixel. Saving: 1.5 instrs/pixel × 24,854 px/tic = **37,281 instr/tic** (upper bound = pure loop overhead). Realistic (tail loop for remainder, count mod 4): avg remainder = 1.5 px/call × 147.8 calls × 2 instrs/px = 443 instrs for tail overhead. Net loop overhead saving: (37,281 − 443) = 36,838 instr/tic = 9.2% of planes (402,167) = 3.0% of whole. Conservative (compiler may partially unroll): **18,000–37,000 instr/tic = 4.5–9.2% of planes**. This is the highest-priority NC candidate by predicted icount reduction. |
| **axis** | cycle-floor |
| **magic-data policy** | None. No new tables. **COMPLIES.** |
| **tic-exact-safe?** | **YES.** R_DrawSpan writes to `screens[0]` (framebuffer) only. `ds_colormap`, `ds_source`, `ds_xfrac`, `ds_yfrac`, `ds_xstep`, `ds_ystep` are all render-only globals. No P_Random. No actor state. The 4-wide unroll produces identical pixel bytes in the same order as the scalar loop (spots computed for x1, x1+1, x1+2, x1+3 in order; writes go to dest, dest+SCREENHEIGHT, dest+2×SCREENHEIGHT, dest+3×SCREENHEIGHT). Render golden regold not expected (output is pixel-identical by construction). |
| **kill rule** | Measured icount improvement < 9,000 instr/tic on doom.wad p50 (half of lower-bound estimate) = drop. Any sim golden mismatch = kill. Any render golden pixel divergence = kill. |
| **non-overlap** | K1 (killed) packed 4 *output palette bytes* into a u32 store to reduce write count — a different dimension (write compression) that measured a regression (+7.9%). NC5 unrolls the *loop control* and exposes instruction-level parallelism for 4 independent texture reads — orthogonal to K1. Task 2.2 applied 4-wide unroll to R_DrawColumn only; NC5 applies the same technique to R_DrawSpan, which currently has no unroll. FastDoom's fake-flat/sb-skip/diff-blit are visual quality reductions; NC5 makes no visual change. rp2040-doom DMA approach is a bulk-transfer technique, not loop-unroll. |

**Verdict: LANDED — task 20.2b**

20.2b landing evidence: NC5 4-wide unroll (scalar xfrac/yfrac, column-major stride +SCREENHEIGHT).
Measured gain: doom.wad demo3 p50 **1,123,751 → 1,076,044 instr/tic = −47,707 instr/tic** (−4.2%
of whole; −11.9% of planes stage). Exceeds the 9,000 instr/tic kill threshold by 5.3×.
sim 13/13 PASS · render-high 13/13 PASS · render-low 13/13 PASS · render-wide 13/13 PASS ·
sim-wide 13/13 PASS · sprite-witness PASS · mixed-width-net PASS · lint PASS ·
verify-all.sh ALL PASS · size-ledger hard checks green.

---

## Phase 20.3a — FastDoom fake-flat: distance-based solid-color flats (task 20.3a)

| field | value |
|-------|-------|
| **mechanism** | `WEBDOOM_FAKEFLAT` compile-time toggle in `engine/core/r_plane.c` R_MapPlane(). When `distance > FAKEFLAT_DIST_THRESHOLD` (512 world units in fixed_t 16.16), the full texture walk (R_DrawSpan via spanfunc()) is skipped and the span is filled with a single representative colour: `ds_colormap[ds_source[32 + 32*64]]` — the center pixel of the 64×64 flat tile, properly lit by the distance-based colormap. FastDoom technique: center pixel at flat index 2080 (= 32 + 32×64). Column-major fill: `*dest = solid; dest += SCREENHEIGHT;` per pixel. A `#line 221` directive after the `#endif` resets the compiler's source-line counter, making the toggle-off build byte-identical to master. |
| **toggle-off byte-identity** | `build/doom.wasm` md5 = `c669142745449ff04bd2fef30fa17412` (proven: git-stash baseline matches toggle-off rebuild). Size 356,775 bytes. |
| **toggle-on build** | `build-fakeflat/doom.wasm` md5 = `e5447d43491ae527e37494a815a1a5de`. Size 357,061 bytes (budget: 360,448 bytes → green). Built with: `EXTRA_CFLAGS=-DWEBDOOM_FAKEFLAT BUILD=../build-fakeflat OUT=../build-fakeflat/doom.js`. |
| **golden set name** | `*-render-fakeflat.json` (13 files: doom-demo{1-4}, doom2/tnt/plutonia-demo{1-3}). Vanilla goldens (`-render.json`) untouched. |
| **icount (local, doom.wad demo3)** | toggle-off: `total_instr=4,092,146,708` mean=1,059,318 instr/tic p50=1,104,391. toggle-on: `total_instr=4,196,318,811` mean=1,086,285 instr/tic p50=1,117,049. **Delta: +26,658 instr/tic p50 (+2.4%)** — regression on doom-demo3. E1M3 content does not expose many spans beyond 512wu; branch overhead for qualifying check adds cost without enough qualifying spans. Fleet measurement unavailable (SSH env not provisioned). Honest note: effectiveness is content-dependent; threshold may need tuning for measurable speedup in practice. |
| **sim invariance** | 13/13 sim goldens bit-identical in both modes (render-only change; playsim untouched). |
| **magic-data policy** | No new tables. Center pixel index 2080 is a deterministic expression (32+32×64), not a magic constant. COMPLIES. |
| **tic-exact-safe?** | YES. R_MapPlane writes to `screens[0]` only via the fill loop or spanfunc(); no P_Random, no actor state, no demo-observable side effects. |
| **gates** | sim 13/13 PASS · render-fakeflat 13/13 PASS · render-high 13/13 PASS (vanilla goldens unchanged) · red-proof PASS (PIXEL DESYNC at tic 42 naming doom-demo1 → restore → PASS) · sim-wide 13/13 PASS · verify-all.sh ALL PASS |
