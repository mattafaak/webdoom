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
| **mechanism** | Reduce `STACK_SIZE` linker flag from 4 MiB to 1 MiB for bare-metal / freestanding builds (not the universal wasm artifact, where the change would require a regold of three layout-pinned goldens). C stack depth analysis from perf.md §Q2/Axis 3: BSP recursion max depth ≈15 frames × 64 bytes = 960 bytes; emscripten runtime overhead ~16–32 KB; 1 MiB provides ~30× margin. For bare-metal (tools/freestanding), the C stack lives in a fixed region; 1 MiB is sufficient per the analysis and frees 3 MiB of precious SRAM/PSRAM. |
| **predicted Δinstr/tic** | 0. Linker constant; no runtime compute change. |
| **axis** | RAM / portability |
| **magic-data policy** | None. **COMPLIES.** |
| **kill rule** | Stack overflow (crash or sanitizer report) on any 13 golden demos after size change = kill. |

**Verdict: SURVIVES → task 14.2g**

Notes: perf.md §Q2/Axis 3 explicitly documented this as "almost certainly sufficient" and
"document only; no change" specifically because the wasm STACK_SIZE change shifts __heap_base.
For bare-metal builds (tools/freestanding), the stack is separate from the wasm linear memory
layout; the regold concern does not apply. This is a portability win, not a web-artifact change.

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
| C7 | STACK_SIZE 4→1 MiB (bare-metal builds) | RAM / portability | 0 instr/tic; -3 MiB per build | SURVIVES → 14.2g |
| K1 | R_DrawSpan u32 packing | cycle-floor | wbox +7.9% planes REGRESSION | KILLED |
| K2 | wasm SIMD | cycle-floor | no gather in v128 | KILLED |
| K3 | Visplane hash | cycle-floor | ceiling 2.9% of planes, probe depth 6.6 | KILLED |
| K4 | Q4 sim hot paths | cycle-floor | reopen conditions unmet | KILLED |
| K5 | emcc knob re-sweeps (axes 1–5) | cycle-floor / size | all closed; -Os kills speed | KILLED |
| K6 | Per-target wasm builds | size | spec non-goal | KILLED |
| K7 | Runtime lookup→transcendental | cycle-floor | magic-data policy violation (measured slower) | KILLED |
| K8 | Browser-fps-motivated wasm work | cycle-floor | framing invalid (render 1.71% of budget) | KILLED |
| K9 | Combined flat_color lookup table | cycle-floor | magic-data policy violation (new runtime table) | KILLED |

**Totals: 16 candidates, 7 survivors, 9 killed.**

---

*Generated: task 14.1. Sources: cycle-attribution.json, cycle-floor.json, zone-stats.json,
browser-pipeline-{alder,wbox}.json, perf.md §13.1a/b/§G, spec.md §magic-data-policy,
bare-metal.md §7.3, docs/renderer.md §7.2.*
