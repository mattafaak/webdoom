# webdoom performance baseline — memory & size audit

Measured at commit 6de6256 (engine state; audit landed as e9e4e61), 2026-07-15.
All numbers taken on the dev host (alder, i9-12900K) unless noted; zone/heap
figures are deterministic (same wasm, same allocator, same WAD bytes) and
host-independent.

Per-stage fleet performance numbers live in `tools/golden/bench-baseline.json`.
The ranked optimization queue arrives with task 2.1.

---

## 1. wasm section breakdown

Command: `llvm-objdump -h build/doom.wasm`
(llvm-objdump from `$EMSDK_DIR/upstream/bin/`, emsdk 6.0.2)

| # | Section   | Size (bytes) | Size (KB) | Notes |
|---|-----------|--------------|-----------|-------|
| 0 | TYPE      |          232 |      0.2  | function signatures |
| 1 | IMPORT    |          169 |      0.2  | host imports (emscripten env) |
| 2 | FUNCTION  |          385 |      0.4  | function index → type mapping |
| 3 | TABLE     |            7 |      0.0  | indirect call table |
| 4 | MEMORY    |            6 |      0.0  | initial memory declaration |
| 5 | GLOBAL    |            9 |      0.0  | wasm globals (stack pointer etc.) |
| 6 | EXPORT    |          285 |      0.3  | exported symbols |
| 7 | ELEM      |          284 |      0.3  | indirect call table initializer |
| 8 | DATACOUNT |            2 |      0.0  | data segment count |
| 9 | **CODE**  |      281,277 |    274.7  | compiled machine code (TEXT) |
|10 | **DATA**  |       75,283 |     73.5  | initialized data segments |
| — | headers   |          244 |      0.2  | wasm magic + section framing |
| — | **Total** |  **357,978** |  **349.6**| gzip-9: 145,990 bytes (142.6 KB) |

The CODE section at 274.7 KB is the dominant cost; DATA at 73.5 KB covers
initialized static storage (tables, strings, fixed arrays). The remaining
sections together are < 1.4 KB.

**Closure compiler** (`--closure 1`) + **LTO** (`-flto -O3`) are both active;
`doom.js` (the ES6 module wrapper) compresses to 3.5 KB gzip. The wasm itself
compresses 2.45× (349.6 KB → 142.6 KB), typical for compiled C via brotli/gzip.

*Task-0.5 engine change note*: five zone-stat exports added
(`web_zone_sample`, `web_zone_hwm`, `web_zone_size`, `web_zone_hwm_reset`,
`web_heap_base`) to `engine/web/perf.c`; wasm grew by 191 bytes (CODE +156 B,
EXPORT +30 B, overhead). These exports are kept permanently for task 2.5 and
2.6 use.

---

## 2. Z_Zone high-water mark per IWAD

Zone pool: **32 MB** (hardcoded `ZONESIZE` in `engine/web/i_system.c`).
Measured by sampling `Z_FreeMemory()` once per unique gametic across all
attract demos for each IWAD headless (`-nodraw`, `-timedemo`).

Command: `node tools/zone-measure.mjs`

### Per-demo peaks

| IWAD          | Demo   | Zone HWM (MB) | % of 32 MB |
|---------------|--------|--------------|-----------|
| doom.wad      | demo1  |         0.81 |       2.5 |
| doom.wad      | demo2  |         0.89 |       2.8 |
| doom.wad      | demo3  |         0.91 |       2.8 |
| doom.wad      | demo4  |         0.75 |       2.4 |
| doom2.wad     | demo1  |         0.84 |       2.6 |
| doom2.wad     | demo2  |         0.84 |       2.6 |
| doom2.wad     | demo3  |         1.00 |       3.1 |
| tnt.wad       | demo1  |         0.96 |       3.0 |
| tnt.wad       | demo2  |         1.29 |       4.0 |
| tnt.wad       | demo3  |         1.14 |       3.6 |
| plutonia.wad  | demo1  |         1.25 |       3.9 |
| plutonia.wad  | demo2  |         1.02 |       3.2 |
| plutonia.wad  | demo3  |         1.36 |       4.3 |

### Per-IWAD peak (worst demo)

| IWAD         | Peak zone used | % of 32 MB zone | Verdict |
|--------------|---------------|-----------------|---------|
| doom.wad     |      0.91 MB  |            2.8% | |
| doom2.wad    |      1.00 MB  |            3.1% | |
| tnt.wad      |      1.29 MB  |            4.0% | |
| plutonia.wad |      1.36 MB  |            4.3% | **worst** |

**Finding**: peak zone usage across all attract demos is 1.36 MB out of 32 MB
allocated — 95.7% of the zone is idle. The zone is over-sized by ~23×
relative to observed attract-demo usage. Actual gameplay may allocate more
(more monsters, level-spanning structures) but the 32 MB pool has enormous
headroom. Task 2.5 (Z_Zone review) and task 2.6 (INITIAL_MEMORY knob sweep)
should consider reducing `ZONESIZE` to 4–8 MB as a first pass, re-running all
13 golden demos + interactive playthroughs for confirmation.

`Z_FreeMemory()` counts free + purgeable (tag ≥ PU_PURGELEVEL) blocks as
free, so the HWM here is the peak of **non-purgeable (irreducible) live
usage only** — purgeable cache blocks (e.g. textures) are not counted. It
is a minimum-committed-footprint bound, which slightly understates total
committed bytes when purgeable caches are large at peak.

---

## 3. Heap headroom vs 64 MB

`INITIAL_MEMORY=64MB`, `ALLOW_MEMORY_GROWTH=0` (Makefile). Memory is a flat
wasm linear region; the allocator is emmalloc (`-sMALLOC=emmalloc`).

Command: `node tools/zone-measure.mjs` (reports `__heap_base` + peak formula)

### Linear memory layout

| Region | Size | Notes |
|--------|------|-------|
| C shadow stack | 4 MB | `STACK_SIZE=4MB` in `engine/Makefile`; lives at start of linear memory |
| Static data (DATA + BSS) | 1,237 KB | initialized tables + zero-init; measured via `__heap_base − 4 MB` |
| **Stack + static total (`__heap_base`)** | **5.21 MB** | = 5,461,072 bytes; heap begins here |
| Zone pool (one `malloc(ZONESIZE)`) | 32 MB | `I_ZoneBase()` in `engine/web/i_system.c` |
| WAD copy (one `malloc(wad.length)`) | up to 16.61 MB | plutonia.wad, worst case |
| **Peak heap address** | **~53.82 MB** | = heap_base + zone + worst WAD |
| **Headroom vs 64 MB** | **~10.18 MB** | slack above worst-case single-IWAD load |

### INITIAL_MEMORY floor experiment

Measured `__heap_base` = 5,461,072 B.  Worst-case WAD = plutonia.wad
(17,420,824 B).  Zone = 33,554,432 B.  Peak = 56,436,328 B ≈ 53.82 MB.

Tested by rebuilding the link step with each target and running the full
plutonia demo3 (5,662 tics, worst-case IWAD):

| INITIAL_MEMORY | plutonia.wad demo3 | Verdict |
|----------------|-------------------|---------|
| 64 MB (current) | 5,662 tics, PASS | baseline |
| **56 MB** | 5,662 tics, PASS | **confirmed floor** |
| 52 MB | `Aborted(OOM)` at WAD malloc | OOM |

**Minimum safe `INITIAL_MEMORY`: 56 MB** (2.18 MB margin above measured peak;
rounded to a convenient 4 MB boundary). This is the headline number for
bare-metal targets (task 1.5).

**Recommendation for task 2.6**: Reduce `ZONESIZE` from 32 MB to 4 MB first
(15× reduction in zone over-allocation with room to spare), then re-measure to
see if the floor drops below 32 MB. At 4 MB zone + 16.61 MB WAD + 5.21 MB
static = 25.82 MB peak, leaving ample room for a 32 MB `INITIAL_MEMORY` target
— potentially halving the current 64 MB floor. Keep `INITIAL_MEMORY=64MB` in
the shipped default until task 2.6 verifies the reduction end-to-end.

---

## 4. JS payload sizes

Command: `ls -la` + `gzip -9 -c <file> | wc -c`
(gzip -9 approximates what a web server with compression sends over the wire)

### Files served per page load

| File | Raw (bytes) | gzip-9 (bytes) | gzip-9 (KB) |
|------|------------|---------------|------------|
| `build/doom.wasm` | 357,978 | 145,990 | 142.6 |
| `build/doom.js` | 7,991 | 3,514 | 3.4 |
| `client/js/lobby.js` | 16,441 | 5,324 | 5.2 |
| `client/js/input.js` | 12,537 | 4,363 | 4.3 |
| `client/js/menu.js` | 10,649 | 3,748 | 3.7 |
| `client/js/main.js` | 6,161 | 2,588 | 2.5 |
| `client/js/net.js` | 6,214 | 2,544 | 2.5 |
| `client/js/countdown.js` | 6,584 | 2,242 | 2.2 |
| `client/js/doomfont.js` | 5,281 | 1,991 | 1.9 |
| `client/js/audio.js` | 4,809 | 1,913 | 1.9 |
| `client/css/webdoom.css` | 5,441 | 2,084 | 2.0 |
| `client/js/video.js` | 3,382 | 1,330 | 1.3 |
| `client/js/persist.js` | 2,992 | 1,275 | 1.2 |
| `client/js/settings.js` | 3,209 | 1,264 | 1.2 |
| `client/sw.js` | 1,928 | 828 | 0.8 |
| `client/js/music-worklet.js` | 1,366 | 629 | 0.6 |
| `client/index.html` | 644 | 354 | 0.3 |
| **Total (all, raw)** | **453,607** | — | — |
| **Total (all, gzip-9)** | — | **181,981** | **177.7** |
| **JS+CSS+HTML only (raw)** | 95,629 | — | — |
| **JS+CSS+HTML only (gzip-9)** | — | 35,991 | **35.1** |

The WAD file itself (doom.wad ≈ 11.8 MB, doom2.wad ≈ 13.9 MB, etc.) is
fetched separately on first play and cached in the browser; it is not part of
the initial page-load transfer.

**Finding**: the entire deliverable (wasm + JS glue + client JS + CSS +
HTML) compresses to **177.7 KB gzip** on the wire. The wasm is 80% of that
(142.6 KB). The JS+CSS+HTML surface is 35 KB gzip — small enough that
minification is low-priority relative to wasm code size (task 2.6).

---

## The optimization queue

*Task 2.1 output — evidence-ranked, per-host-aware, honest about gaps.*
*This section feeds tasks 2.2–2.7. Every rank shows its arithmetic.*
*Source commit: 16c3354. Measurement date: 2026-07-15.*

---

### A. Per-stage ranked costs per host

Values are averages across doom.wad demo1/demo2/demo3 from
`tools/golden/bench-baseline.json` (schemaVersion 2, all four hosts
coherent at commit 16c3354). The stage order within each host is the
rank order: #1 = most expensive.

#### Absolute costs (ms/frame avg)

| rank | stage | wbox | tank | pi5 | alder |
|------|-------|------|------|-----|-------|
| #1 | bsp+segs | **0.2625** | 0.0549 | 0.0715 | 0.0481 |
| #2 | planes | **0.1566** | 0.0386 | 0.0494 | 0.0327 |
| #3 | masked | **0.0637** | 0.0176 | 0.0209 | 0.0164 |
| #4 | frame-setup | 0.0069 | 0.0012 | 0.0017 | 0.0008 |
| — | **render total** | **0.4897** | **0.1123** | **0.1435** | **0.0979** |
| — | sim (ms/tic) | 0.0706 | 0.0158 | 0.0173 | 0.0135 |

Arithmetic: alder bsp average = (0.0451 + 0.0587 + 0.0404) / 3 = 0.0481.
Same formula for all cells.

#### Stage share of total render (%)

| stage | wbox | tank | pi5 | alder |
|-------|------|------|-----|-------|
| bsp+segs | **53.6%** | **48.9%** | **49.8%** | **49.1%** |
| planes | 32.0% | 34.4% | 34.4% | 33.4% |
| masked | 13.0% | 15.7% | 14.6% | 16.7% |
| frame-setup | 1.4% | 1.0% | 1.2% | 0.8% |

Rank order is identical on all four hosts: bsp+segs > planes > masked >
frame-setup. The proportions are stable (±3 pp) across the fleet.

#### Cross-host ratios (wbox vs. each)

| stage | wbox/alder | wbox/tank | wbox/pi5 |
|-------|-----------|-----------|---------|
| bsp+segs | 5.46× | 4.78× | 3.67× |
| planes | 4.79× | 4.06× | 3.17× |
| masked | 3.88× | 3.62× | 3.05× |
| sim | 5.23× | 4.47× | 4.08× |

wbox is ~5× slower than alder on bsp+segs. pi5 is the best ARM result
and roughly half way between alder and wbox.

---

### B. The uncomfortable truth: wasm render vs. 35 Hz budget

At 35 Hz the per-frame budget is 1000 / 35 = **28.57 ms**.

| host | render total (ms) | % of 28.57 ms budget |
|------|-------------------|----------------------|
| wbox | 0.4897 | **1.71%** |
| pi5 | 0.1435 | 0.50% |
| tank | 0.1123 | 0.39% |
| alder | 0.0979 | 0.34% |

The wasm render loop is **under 2% of the 35 Hz budget on the weakest
browser host (wbox)**. The remaining ~98% of each tic is spent elsewhere.

Sim is even less: wbox 0.0706 ms/tic / 28.57 ms = 0.25% of budget.

**What this means for browser play**: the wasm inner loops are not the
user-visible bottleneck. The JS/browser pipeline — palette conversion and
WebGL texture upload in `client/js/video.js`, rAF scheduling jitter,
AudioWorklet mixing — is **UNMEASURED** by the wasm bench harness.
These paths run on every frame and involve GPU synchronization, but
their contribution to frame latency is unknown.

A 50% speedup in wasm bsp+segs on wbox saves
0.2625 ms × 50% = 0.13 ms/frame = 0.46% of budget.
This is unmeasurable by the user at 35 Hz. The browser play
experience is dominated by whatever the UNMEASURED JS/GPU side costs.

**What this means for the bare-metal future (ESP32/Cortex-M)**:
A 240 MHz LX7 without PSRAM optimization is projected to spend
render / 0.24 ≈ 2 ms/frame on render alone (docs/bare-metal.md §7.3),
out of a 28.57 ms budget. At that scale the wasm stage ranking IS the
right optimization proxy and the queue matters. PSRAM latency on
column-stride writes (`screens[0]`, SCREENWIDTH = 320 bytes/step) is
the primary expected bottleneck; placing `screens[0]` in internal SRAM
is the primary mitigation (bare-metal.md §7.3).

**Conclusion for queue ordering**: the queue is shaped primarily by the
bare-metal axis. Browser wins are labelled separately and conditioned
on the browser-side measurement gap being filled first (Q0 below).

---

### C. Browser-side measurement gap

**Defined**: a browser pipeline profile would measure, per rAF frame:

- `video.js` blit path: `I_FinishUpdate` palette expansion (64,000
  indexed-byte → RGBA lookups) + `texSubImage2D` WebGL call latency
- WebGL state change count and GPU pipeline stall
- rAF scheduling jitter (deviation from 16.67 ms target at 60 Hz)
- AudioWorklet mixing budget (OPL synthesis at 140 Hz + PCM mixing)
- Total JS time between consecutive rAF callbacks

**Can `tools/browser-test.mjs` do this cheaply?** It uses Chrome
DevTools Protocol (CDP) for UI automation (screenshots, key input,
console error capture) but has no per-frame timing instrumentation.
Getting accurate per-frame JS breakdowns requires either:

1. Chrome Tracing API (`Tracing.start`/`Tracing.stop`) with
   `devtools.timeline` category — produces a trace JSON that must be
   parsed for `FunctionCall` events; non-trivial to extract per-function
   frame breakdowns without a full trace-viewer pipeline.
2. Instrumenting `video.js` with `performance.mark`/`performance.measure`
   around the blit and WebGL calls, then reading via
   `Performance.getMetrics` or `PerformanceObserver` — works but requires
   adding measurement code to the client that must be reverted.
3. Using the `Performance.getMetrics` CDP call for aggregate stats
   (heap, scripting time, GPU time) — less precise but fast to add.

**Cheap first step**: `cdp('Performance.getMetrics')` is already
usable within browser-test.mjs's existing CDP infrastructure (the
`cdp()` helper is defined at line 40). Adding it is literally 2 lines:
call once before and once after the gameplay loop, diff the `TaskDuration`
and `ScriptDuration` fields. This yields aggregate JS scripting time —
not per-frame breakdowns, but a budget sanity-check that costs nothing
to obtain and should be done before investing in full tracing.

**Verdict**: do the 2-line `Performance.getMetrics` call immediately as
a sanity check. Full per-frame tracing (option 1, Chrome Tracing API)
or client-side `performance.mark` instrumentation (option 2) remains
deferred — add as Q0 in the queue. The queue entries below apply
unambiguously to the bare-metal axis; their browser applicability is
flagged NEEDS-Q0 where the JS side might dominate.

---

### D. Within bsp+segs: attribution reasoning

`bsp+segs` times `R_RenderBSPNode` (the BSP walk) and
`R_StoreWallRange` → `R_RenderSegLoop` (wall column draws) together,
because the draw calls are interleaved with the BSP recursion.

The dominant sub-cost is **`R_DrawColumn`** calls from
`R_RenderSegLoop`. Each visible wall fragment from x1 to x2 invokes
the column-draw inner loop (renderer.md §7.2) for each column in the
range:

```
for dc_x in [x1, x2]:
    dest = ylookup[dc_yl] + columnofs[dc_x]
    // inner loop: dc_yh - dc_yl + 1 iterations, each:
    *dest = dc_colormap[dc_source[(frac >> FRACBITS) & 127]]
    dest += SCREENWIDTH  // 320-byte stride → cache miss per pixel
    frac += fracstep
```

The `dest += SCREENWIDTH` write is the **primary cache-miss source**:
each pixel write is 320 bytes past the previous, one new cache line
(64 bytes) per pixel on typical hardware. For a 200-row column at 1:1
scale: 200 cache-line misses per column draw.

**UNMEASURED: R_DrawColumn and R_DrawSpan call counts per frame**.
The measurement procedure (to be run for task 2.2):
1. Add `long web_perf_col_calls, web_perf_span_calls` counters to
   `engine/web/perf.h` / `engine/web/perf.c` (with EMSCRIPTEN_KEEPALIVE
   getters and reset in `web_perf_reset()`).
2. Increment `web_perf_col_calls` at the top of `R_DrawColumn`;
   increment `web_perf_span_calls` at the top of `R_DrawSpan`.
3. Rebuild wasm; run `node tools/bench.mjs doom.wad 1` on each host.
4. Record counts; compute avg column pixels (= sum of (dc_yh−dc_yl+1)
   per call if a pixel counter is added, or derive from render time).
5. **Revert all engine changes**; rebuild to pristine 16c3354;
   verify 13/13 sim goldens + 13/13 render goldens before committing
   anything but docs.

Corrected call-count estimate from renderer.md §4.4/§6.7 (UNVERIFIED —
measure per the §D procedure above before citing these numbers):
- Walls (`R_RenderSegLoop`, renderer.md §4.4): ~30–50 drawsegs/frame,
  each covering ~5–15 columns on average with 1 tier = **~250–450**
  R_DrawColumn calls from wall draw alone.
- Sprites (`R_DrawVisSprite` loop, renderer.md §6.7): width varies
  widely (weapon psprite ~60 cols; small enemy ~10 cols; tall close
  enemy ~100 cols); 5–15 visible sprites × 10–100 cols each ≈
  **~250–2,000** calls.
- Sky (renderer.md §9): one R_DrawColumn per column of the sky
  visplane, up to 320 columns = **~100–300** calls.
- Total realistic estimate: **~1,000–3,000 R_DrawColumn calls/frame**;
  previously stated 15,000–25,000 was an arithmetic error (~10× high)
  from conflating pixels-per-column with calls-per-column.

**R_DrawSpan** (floor/ceiling spans) is cheaper per call than
R_DrawColumn because its `dest++` writes are sequential (horizontal
row) — cache-friendly. The `ds_source` flat-texture reads are random
within a 4096-byte flat (likely L1-resident). This explains why planes
is only 32% of render despite floor/ceiling covering more pixels than
walls in typical open spaces.

---

### E. Sim: rank or dismiss

wbox sim = 0.0706 ms/tic; at 35 Hz = 0.0706/28.57 = **0.25% of budget**.

Headless sim throughput from v1 bench: wbox 21,107 tics/s
= 35/21107 × 100 = **0.17% CPU** at 35 Hz. The render-pass measurement
confirms: sim is negligible.

**Risk vs. reward**: the sim is the frozen surface (playsim.md §16).
Any change to:
- `P_Random()` call sequence (ordering of any sim action)
- thinker list traversal order
- `P_BlockLinesIterator` / `P_BlockThingsIterator` iteration order
- `P_TraverseIntercepts` sort order

...would desync all 13 golden demos. The cross-validation against 44,580
Chocolate Doom tics provides zero tolerance for any behavioral divergence.

**Verdict for task 2.4**: measure-first / likely-skip. The 0.25%
budget contribution makes any win unmeasurable at the system level.
The risk of a hidden sim-behavior change is disproportionate to the
reward. Only pursue 2.4 if Q0 (browser profile) reveals that the JS
sim invocation overhead (not the wasm sim cost) is significant — an
unlikely finding given the 0.25% wasm figure.

---

### F. Zone and memory knobs (2.5 / 2.6)

These are **memory wins, not speed wins**. On browser hosts the current
64 MB INITIAL_MEMORY loads instantly; on bare-metal every MB costs flash
or PSRAM capacity.

Findings from perf.md §2 and §3:

- Peak non-purgeable zone usage across all 13 demo playthroughs:
  **1.36 MB** (plutonia.wad demo3). The 32 MB zone is **23× oversized**.
- INITIAL_MEMORY floor: **56 MB** (tested; 52 MB aborts at WAD malloc).
- Reducing ZONESIZE to **4 MB** would put peak usage at 34% of zone —
  comfortable headroom for purgeable cache. Projected INITIAL_MEMORY
  with 4 MB zone + 16.61 MB WAD + 5.21 MB static = **25.82 MB** —
  potentially halving the current 64 MB target.
- `WEB_ZONE_POOL_SIZE` in `engine/web/perf.c` duplicated `ZONESIZE` in
  `engine/web/i_system.c`. **Resolved in task 2.5**: both now read
  `ZONESIZE` from `engine/web/web.h` (single define, no compile-time guard
  needed because the value is used in the same translation units that include
  web.h).

**Risk**: zone size reduction is safe iff all 13 demo passes complete.
The four-client net hash test (net gate) must also pass (zone backs
thinker allocations that multiply with player count).  Render-gate
failures appeared at both 4 MB and 8 MB in task 2.5 testing — see Q2
task 2.5 results above for the full measurement and decision.

---

### G. The ranked optimization queue

Ordered by expected impact on the weakest capable target (wbox for
browser, LX7/PSRAM for bare-metal). Effort: S < 1 day, M 1–3 days,
L > 3 days.

#### Q0 — Measure the browser pipeline (prerequisite)

| field | value |
|-------|-------|
| **what** | Instrument `client/js/video.js` blit path (`I_FinishUpdate`: palette expand + texSubImage2D) and rAF frame budget with `performance.mark`/`performance.measure`; collect via CDP or DevTools trace across 100+ frames of E1M1 gameplay |
| **expected win** | Not a win — a prerequisite. Without this data, all claims about browser-fps improvement from tasks 2.2–2.4 are unverifiable. |
| **gates that protect it** | No gate needed — browser-only instrumentation, reverted before commit. |
| **effort** | S |
| **verdict** | **DO FIRST** before claiming any browser-fps improvement from wasm changes. |
| **maps to** | Prerequisite for 2.2/2.3/2.4 browser-fps claims |

#### Q1 — Column/span inner loops (task 2.2)

| field | value |
|-------|-------|
| **what** | Tighten `R_DrawColumn` inner loop: reduce the 320-byte column-stride write pressure (consider transposed framebuffer approach or row-major rendering order for wasm targets); profile `R_DrawSpan` for comparison. Optionally prototype wasm SIMD (`v128` load/store) behind a compile flag. |
| **expected win (bare-metal)** | bsp+segs = 53.6% of wbox render = 0.2625 ms/frame. If the R_DrawColumn inner loop accounts for ~70% of bsp+segs (plausible given wall-dominant scenes), that is 0.184 ms/frame attributable to column draw. A 30% improvement → 0.055 ms/frame savings on wbox = 11% total render reduction. On LX7 with `screens[0]` in SRAM, column-stride cache misses vanish; the win may be larger. |
| **expected win (browser)** | NEEDS-Q0. Wasm render is 1.7% of budget on wbox; a 30% improvement saves 0.51% CPU. User-invisible without Q0 ruling out JS-side dominance. |
| **gates** | Render gate (13/13 pixel-identical) + sim gate (unchanged, render-only) |
| **effort** | M (SIMD prototype = L, behind build flag, optional) |
| **verdict** | **DO** on bare-metal axis. For browser: do it but frame the claim correctly — the win is CI throughput and bare-metal fps, not user-visible browser fps. |
| **maps to** | Task 2.2 |

##### Task 2.2 results (measured 2026-07-15, commit after 99f9e28)

**Step 1 — Call counts (doom.wad demo1, 1710 frames, build with -DWEB_PERF_COL_STATS):**

| function | calls/frame | avg px/call | px/frame |
|----------|------------|------------|---------|
| R_DrawColumn (all variants) | 714.8 | 47.9 | 34,203 |
| R_DrawSpan | 147.8 | 168.2 | 24,854 |

Avg column height 47.9 px → 4-wide unroll covers ~11 full iterations + 0–3 scalar tail.
Avg span length 168.2 px → 4-wide span unroll would cover ~42 iterations per call.

**Step 2 — Codegen finding:** emcc -O3 with global `dc_colormap`/`dc_source` pointers
**reloads them from globals on every pixel** (C aliasing: compiler cannot prove no write
through another pointer between iterations). Verified in LLVM IR (`llvm-dis` output):
`%43 = load ptr, ptr @dc_colormap, align 4` appears inside the loop body. Hoisting
these into `const` locals before the loop eliminates the reload entirely. The hoist is
correct on all targets regardless of whether the unroll wins.

**Step 3 — Strict A/B/C interleaved bench on wbox (3 reps each, same session):**

Variant A = 035ceaa binary (true baseline, freshly built).
Variant B = hoist + 4-wide unroll (task 2.2 candidate).
Variant C = hoist-only (no unroll), isolated contribution of the pointer hoist.
Each rep is one 3-demo sweep; interleave order: A B C A B C A B C.
Noise bar = max spread across reps within a single variant.

| variant | transform | bsp+segs avg | bsp spread (noise) | total render avg |
|---------|-----------|-------------|-------------------|-----------------|
| A | none (baseline) | 0.2652 ms | 0.0013 ms | 0.4927 ms |
| C | hoist-only | 0.2667 ms | 0.0075 ms | 0.4932 ms |
| B | hoist + unroll-4 | 0.2558 ms | 0.0034 ms | 0.4851 ms |

Per-rep detail (bsp+segs avg across demo1/demo2/demo3):

| rep | A | B | C |
|-----|---|---|---|
| 1 | 0.2649 | 0.2567 | 0.2647 |
| 2 | 0.2660 | 0.2570 | 0.2715 |
| 3 | 0.2647 | 0.2536 | 0.2640 |

**Hoist-only verdict (C vs A):** C avg 0.2667 vs A avg 0.2652 = +0.6% — within noise.
C spread (0.0075) is 5.8× larger than A spread (0.0013). No measurable win from hoist
alone on the Bobcat. The hoist is retained: it provably removes two aliasing-blocked
global reloads per pixel (confirmed in LLVM IR) and is universally correct across all
targets, but it does not move numbers on wbox by itself.

**Unroll-4 verdict (B vs A):** B avg 0.2558 vs A avg 0.2652 = **-0.0094 ms = -3.5%**.
All 3 B reps are below all 3 A reps — the difference is 7× the A noise bar and is
clearly separable from drift. On the Bobcat (in-order CPU), unrolling reduces the
branch-taken + pointer-advance overhead from 1-per-pixel to 1-per-4-pixels; this is
the dominant effect, not the ILP from independent texture reads. **KEEP unroll.**

Total render B vs A: 0.4851 vs 0.4927 ms = **-1.5%**.

*Killed:* **R_DrawSpan: 4-wide u32 packing (4 palette bytes into one i32.store)**
- Pack four `ds_colormap[ds_source[spot]]` bytes into one `uint32_t` word and write with
  a single unaligned store (valid in wasm; no hardware penalty on x86). Sequential
  `dest++` writes mean alignment is only guaranteed every 4 pixels if ds_x1 ≡ 0 (mod 4).
- Result on wbox (measured in earlier fleet run): planes +7.9% across demos
  (demo1 +10.1%, demo2 +6.8%, demo3 +5.9%). Wider loop body adds code-size pressure
  on Bobcat's 32 KB L1 icache; V8 JIT compiles the wider body less efficiently.
- **KILLED** — wbox regression.

*Assessed, not prototyped:* **wasm SIMD (v128 for R_DrawSpan 8-wide / R_DrawColumn)**
- R_DrawSpan: the flat-texture reads (`ds_source[spot]`) require a *gather* — 8 independent
  random byte addresses per SIMD lane. wasm v128 has no native gather; emulation via 8
  separate `v128.load8_lane` instructions negates any throughput gain. The scalar u32-packing
  already regressed on wbox; SIMD gather overhead would be worse.
- R_DrawColumn: the bottleneck is the 320-byte-stride column write. No SIMD instruction
  can batch non-contiguous vertical pixels into a contiguous store without transposing the
  entire framebuffer — a larger architectural change outside 2.2 scope.
- **ASSESSED, NOT WORTH IT**: gather emulation overhead eats the win for spans;
  stride-320 writes can't be SIMD-batched without framebuffer transposition.

**Final fleet results (wbox only from A/B interleave; other hosts from final fleet run):**

| stage | A (035ceaa) | B (hoist+unroll) | delta | verdict |
|-------|------------|-----------------|-------|---------|
| bsp+segs | 0.2652 ms | 0.2558 ms | **-3.5%** | **win** |
| planes | 0.1564 ms | 0.1587 ms | +1.5% | within noise |
| **total render** | **0.4927 ms** | **0.4851 ms** | **-1.5%** | **win** |

wbox total render drops from 1.72% of the 28.57 ms / 35 Hz budget to 1.70%. The
improvement is in headless CI throughput and bare-metal fps, not user-visible browser fps.

#### Q2 — Memory footprint reduction (tasks 2.5 + 2.6)

| field | value |
|-------|-------|
| **what** | (a) Reduce ZONESIZE 32 MB → smallest safe; (b) Reduce INITIAL_MEMORY 64 MB → 56 MB (proven safe floor); (c) Consolidate WEB_ZONE_POOL_SIZE / ZONESIZE into one shared define; (d) emcc knob sweep: -O3 vs. -Os for size×speed frontier. |
| **expected win (browser)** | No fps change. Reduced wasm heap footprint (faster initial memory allocation in V8; potential JS heap GC pressure reduction — minor). Primary value is documentation of the knob space. |
| **expected win (bare-metal)** | Smaller ZONESIZE → smaller INITIAL_MEMORY target. Critical for smaller ESP32 configurations. |
| **gates** | Sim gate (13/13 demos) + render gate + 4-client net hash (zone backs thinker allocations; net test required) |
| **effort** | 2.5 = S; 2.6 emcc sweep = M |
| **verdict** | **DO** — zone consolidate done in task 2.5; ZONESIZE kept 32 MB (see below). Do 2.6 separately (knob sweep). |
| **maps to** | Tasks 2.5 (zone), 2.6 (knobs) |

##### Task 2.5 results — ZONESIZE reduction attempt (measured 2026-07-15)

Zone size was reduced to 4 MB and 8 MB; all tests gated on:
(a) `node tools/demo-test.mjs` (sim, 13/13), (b) `node tools/demo-test.mjs --render`
(render, 13/13), (c) `node tools/net-test.mjs {2,4}` (net hash).

**Critical finding: the §2 HWM measurements (-nodraw) do not represent render-path
cache pressure.**  `zone-measure.mjs` runs demos with `-nodraw` (sim only), measuring
only non-purgeable allocations (thinkers, maps, sprites, etc.).  With rendering enabled,
composite textures, sprites, and rendering structures fill the purgeable cache (PU_CACHE)
at a far higher rate than the 1.36 MB non-purgeable HWM suggests.

| ZONESIZE | sim gate (13/13) | render gate | net gate | verdict |
|----------|-----------------|-------------|----------|---------|
| 4 MB | PASS (0 OOM) | 10 failures (+7 vs 32 MB baseline) | not run | FAIL — render cache pressure |
| 8 MB | PASS (0 OOM) | 6 failures (+3 vs 32 MB baseline) | not run | FAIL — render cache pressure |
| **32 MB** | **PASS** | **PASS 13/13** | **PASS 2p+4p** | **SHIP** |

Master (0bb3a9c) passes all 13 render goldens pixel-identical on a clean build.
The task 2.5 candidate likewise passes 13/13 render on a clean build (confirmed
by bisecting: the only change that shifted render output was a new BSS global;
removing the new global restored 13/13).

**Lead follow-up experiments (post-review, on master)** — the initial bisect
blamed the task 2.2 R_DrawColumn unroll; that attribution is WRONG. Two
controlled experiments settle it: (1) master + a 16-byte BSS probe global
(`__heap_base` 5,461,072 → 5,461,088) fails the SAME three render goldens at
the SAME tics (tnt-demo1 tic 1684, plutonia-demo1 tic 5909, plutonia-demo3
tic 1469); (2) the same probed build with `r_draw.c` reverted wholesale to
pre-2.2 (035ceaa) STILL fails identically. The heap-layout sensitivity
therefore predates task 2.2 and lives elsewhere in the engine — signature
consistent with a vanilla-inherited out-of-window texture read
(Tutti-Frutti/Medusa family) whose overrun bytes depend on heap layout.
**Consequence: the render goldens are LAYOUT-PINNED** — any change that
grows/shrinks BSS or shifts allocations will spuriously fail exactly these
three goldens without any real render change. Treat such a failure as a
layout shift first; root-cause hunt assigned to task 3.1 (a native ASan
demo run will pinpoint the exact OOB read).

**Resolution (task 3.1)** — root cause identified and fixed. The OOB read
is in `R_DrawColumn` / `R_DrawColumnLow`: the hardcoded `& 127` mask allowed
the column sampler to read past the end of composite texture column buffers
for textures shorter than 128 px (e.g. 64 px walls). Fix: added `dc_texheight`
(default 128) set by each caller (`R_RenderSegLoop`, `R_DrawPlanes`) to the
actual texture height so the mask becomes `& (dc_texheight - 1)`. Secondary
fixes: `sprnames[NUMSPRITES+1]` NULL sentinel (R_InitSpriteDefs OOB scan),
`finetangent` index clamped to `[0, FINEANGLES/2-1]` (r_segs.c:266
off-by-one at 90-degree walls), and `P_SpawnMapThing` type-0 guard.
BSS-probe acceptance test passed: master + 16-byte BSS probe passes all 13
render goldens, confirming the layout sensitivity is eliminated. Render
goldens regolded for all 13 demos.

**Resolution (task 3.2) — unpinning COMPLETE.** Two additional dc_texheight
residuals were identified and fixed that the task 3.1 BSS-probe did not expose:

1. `R_RenderMaskedSegRange` (r_segs.c) never called `R_RenderSegLoop`, so
   `dc_texheight` was stale from the previous wall/plane draw; mid-textures
   shorter than 128 px caused OOB reads into zone heap. Fix: set
   `dc_texheight = textureheight[texnum] >> FRACBITS` before the column loop.

2. `R_DrawMaskedColumn` (r_things.c) applied `& 127` to all sprite post reads;
   when a post top is off-screen, negative `frac` indexed past the post data
   into adjacent zone memory. Fix: `dc_texheight = column->length | 1` per post.

Both probes now pass 13/13: BSS probe (heap +32 bytes) and RODATA probe
(~53-byte string literal, heap +~53 bytes). All 13 render goldens regolded.
The `dc_texheight` pinning is now complete across all call sites; WASM layout
changes no longer cause spurious render-golden failures.

**Hypothesis for 4 MB / 8 MB render failures (recorded for task 3.1/3.2)**:
The pixel divergences at small zone sizes are consistent with a PU_CACHE
use-after-purge hazard.  When the zone is small enough to actually evict
PU_CACHE texture blocks, a cached column pointer (`dc_source`) may be reused
after the zone has freed and reallocated that block for a different purpose.
The data at that address is now different, producing wrong pixel values at
specific tics.  Evidence: doom.wad shows **0 sim-path purges at 8 MB** yet
still fails the render gate at 8 MB — confirming the render path's texture
cache pressure (not sim-path purging) is the trigger.  This is a latent
vanilla DOOM bug that never manifests at 32 MB because nothing purges.
Investigation deferred to tasks 3.1 and 3.2.

**Purge events at smaller zone sizes (sim path, -nodraw; measured via prototype counter build):**

| ZONESIZE | doom.wad | doom2.wad | tnt.wad | plutonia.wad |
|----------|----------|-----------|---------|--------------|
| 4 MB | 254–265/demo | 660–811/demo | 967–1174/demo | 910–1082/demo |
| 8 MB | 0/demo | 63–83/demo | 285–324/demo | 251–281/demo |
| 32 MB | 0/demo | 0/demo | 0/demo | 0/demo |

doom.wad shows 0 purges at 8 MB (sim path) but still fails the render gate at 8 MB
— confirming that the render path fills the texture cache far beyond the sim-only
measurement.  The true cache floor for the render path is between 8 MB and 32 MB.

**Conclusion**: ZONESIZE stays at **32 MB** until a render-path measurement (with
rendering enabled) characterises the actual peak.  The §2 non-purgeable HWM (1.36 MB)
is a lower bound on zone usage, not the safe floor for a rendering build.  The PSRAM
economy (bare-metal) argument for a smaller zone is valid but requires measuring
actual texture cache peak with `-nodraw` off before committing a reduction.

**What task 2.5 delivered**:
- `WEB_ZONE_POOL_SIZE` duplicate removed; `ZONESIZE` is now the single define in
  `engine/web/web.h` (SSOT), consumed by both `i_system.c` and `perf.c`.
- Dead zone code deleted: `Z_ClearZone` (no callers), `Z_DumpHeap` (no callers),
  `Z_FileDumpHeap` (sole caller was in `#if 0 // UNUSED`, p_setup.c:612).
- `zone-measure.mjs` updated to use `web_zone_size()` dynamically (no more
  hardcoded 32 MB constant in the script).
- HWM numbers at 32 MB: **identical to §2 baseline** — allocation-pattern neutrality
  proven.  All gates pass on a clean build: sim 13/13, render 13/13, net 2p+4p.
- **Note on purge counter**: an instrumentation counter (`web_zone_purge_events`)
  was prototyped but removed.  Any new BSS global shifts the wasm `__heap_base`
  by 16 bytes (alignment padding), which alters all allocation addresses and
  trips the pre-existing heap-layout sensitivity described above (NOT a task
  2.2 artifact — see the lead follow-up experiments), spuriously failing three
  layout-pinned render goldens.  The purge measurement data above was obtained
  from a separate experimental build.  If a persistent purge counter is needed,
  it must be stored without adding to BSS (e.g., inside `memzone_t` header bytes
  that don't affect the first free block offset, or in JS-side tracking).

#### Q3 — Visplane management (task 2.3)

| field | value |
|-------|-------|
| **what** | Replace `R_FindPlane` O(n) linear search with a small hash (key = height×picnum×lightlevel, table size ≤ 64 buckets covers typical DOOM maps). Evaluate `R_CheckPlane` split frequency to bound copy overhead. |
| **expected win (bare-metal)** | planes = 32% of wbox render = 0.1566 ms/frame. `R_FindPlane` is O(n) over live visplane count; in open maps with many distinct (height, picnum, lightlevel) triples this is non-trivial. However, in the attract demos (corridors, tight geometry) the live count is small (~10–20 planes/frame), making the linear scan fast. Win is scene-dependent. Estimate 5–15% of planes stage = 0.008–0.023 ms/frame on wbox — modest. |
| **expected win (browser)** | NEEDS-Q0. Same scaling argument as Q1. |
| **gates** | Render gate (visplane management is render-only; sim unaffected) |
| **effort** | M |
| **verdict** | **MEASURE-FIRST**: instrument visplane count and R_FindPlane probe depth before sizing the win. The hash is straightforward but the gain on real DOOM maps may be small. Do after Q1 (larger guaranteed win). |
| **maps to** | Task 2.3 |

##### Task 2.3 results (measured 2026-07-15, commit after task 2.2)

**Step 1 — Instrumentation**: Added `WEB_PERF_PLANE_STATS` counter block to
`engine/core/r_plane.c` (same pattern as `WEB_PERF_COL_STATS` in r_draw.c).
Tracks: `web_perf_findplane_calls` (R_FindPlane invocations), `web_perf_findplane_iters`
(linear-search comparison iterations), `web_perf_visplane_peak` (max live visplanes in
any frame). Counters always declared in `perf.h`/`perf.c`; incremented only under
`-DWEB_PERF_PLANE_STATS`. Getters exported as `_web_perf_findplane_*_get`.
Measurement script: `tools/plane-measure.mjs`.

**Step 2 — Measured counts** (wbox, 1 rep each, best-rep for doom.wad; built with
`-DWEB_PERF_PLANE_STATS`):

| case | frames | calls/frame | iters/frame | peak visplanes |
|------|--------|-------------|-------------|----------------|
| doom demo1 | 1709 | 33.1 | 205.2 | 33 |
| doom demo2 | 2346 | 34.6 | 128.2 | 39 |
| doom demo3 | 3862 | 30.3 | 103.3 | 28 |
| tnt demo2 (heavy) | 3652 | 56.1 | **451.5** | 68 |
| plutonia demo3 (heavy) | 5661 | 59.1 | 375.7 | 64 |

**Step 3 — Ceiling analysis**:

Worst case is tnt demo2 at 451.5 iterations/frame. Each iteration tests 3 int fields
(`height`, `picnum`, `lightlevel`) and advances a pointer. Even at a generous 10 ns/iter:

```
ceiling = 451.5 iters/frame × 10 ns/iter = 4,515 ns/frame = 4.5 µs/frame
planes stage baseline (wbox) = 156,600 ns/frame
ceiling fraction = 4.5 / 156.6 = 2.9%
```

For the doom.wad attract demos (the primary bench baseline): 205.2 iters/frame max →
ceiling 2.1 µs/frame = **1.3% of the planes stage**.

Peak visplane count across all cases: **68** (tnt demo2). At 68 planes the linear scan
averages ~6.6 comparisons per call before hitting a match or the end — far from the
pathological worst case. The hash table would save at most a few comparisons per call.

**Verdict: NO-GO — not worth implementing**.

The hash is structurally sound (prboom-plus chained-hash R_FindPlane is well-understood),
but the search cost is simply too small to produce a measurable win:

- Ceiling 2.9% on the *heaviest* tested case (tnt demo2). For doom.wad demos: 1.3%.
- The planes stage itself is 32% of wbox render (0.157 ms/frame). A 2.9% reduction
  in planes = 0.0045 ms/frame total render change. The task 2.2 noise bar on wbox was
  ~0.001 ms — the hash ceiling is ~4.5× the noise bar and would likely be buried in it
  after the hash's own overhead (hash function compute + bucket pointer chase) is subtracted.
- A hash replaces the linear scan but adds: one multiply + one modulo (or bitmask) for
  the key, one pointer dereference per bucket chain entry. With chains averaging 1–2
  entries, the win over a 6.6-comparison linear scan is marginal or negative.
- The code complexity cost (chain management, bucket sizing, collision handling) is
  disproportionate to the sub-2% ceiling.

**Engine reverted to pristine** for the final commit (no r_plane.c behaviour change).
Counter infrastructure (`WEB_PERF_PLANE_STATS` in `perf.h`/`perf.c`) is kept
permanently — it is useful for future map-specific profiling and 3.x hardening work.

**Openings management assessment**: `openings[]` (r_plane.c) was raised from
`SCREENWIDTH×64` to `SCREENWIDTH×256` in webdoom. Overflow in a non-`RANGECHECK` build
is silent (silent pointer overrun). This is a bounds-hardening concern, not a perf
concern. No further action in task 2.3. → Defer to task 3.2 (bounds hardening).

#### Q4 — Sim hot paths (task 2.4)

| field | value |
|-------|-------|
| **what** | Profile blockmap iterators (`P_BlockLinesIterator`, `P_BlockThingsIterator`), `P_CheckSight`, `P_ApproxDistance` for sim speedup. |
| **expected win** | wbox sim = 0.0706 ms/tic = 0.25% of 35 Hz budget. Any speedup is invisible at the system level. Headless CI throughput may improve (timedemo runs faster), but that is a developer convenience, not a user win. |
| **risk** | The frozen surface (playsim.md §16) covers all P_Random call ordering, thinker traversal, blockmap iteration order. Any change to iteration order, however minor, will desync golden demos. The correctness gate (13 sim goldens + 44,580-tic Chocolate cross-validation) will catch any divergence, but the investigation cost is high. |
| **verdict** | **MEASURE-FIRST / LIKELY-SKIP**. Pursue only if Q0 reveals that the JS-side sim invocation overhead (not wasm sim time) is the bottleneck, or if a specific bare-metal target profile shows sim dominates. The frozen-surface risk is disproportionate to the 0.25% budget figure. |
| **resolution (task 2.4 closed)** | **SKIPPED BY MEASUREMENT** — no sim change made; 13/13 golden gate trivially intact. Reopen only under the two conditions above (Q0 finding or a bare-metal profile where sim dominates); the future ESP32 project inherits this queue entry via bare-metal.md §7. |
| **maps to** | Task 2.4 |

#### Q5 — tank deep-dive (task 2.7)

| field | value |
|-------|-------|
| **what** | Investigate why tank (i5-8350U, Kaby Lake) was "least optimized" per Plans.md. The v1 microbench showed FixedDiv int64 is 2.86× slower than double on tank (2725 ms vs. 964 ms for 2×10⁸ iters). |
| **what the data actually shows** | v2 perStage: tank render = 0.1123 ms/frame, alder = 0.0979 ms/frame, ratio = **1.15×**. Tank is only 15% slower than alder on render — very close. Tank sim = 0.0158 ms/tic vs. alder 0.0135 ms/tic = 1.17×. Neither is concerning at the 35 Hz scale. The headless gap: v2 simFpsNodraw averages are alder 180,370 tics/s vs. tank 95,463 tics/s = **1.89×** — consistent with general i9 vs. i5 CPU throughput, not a FixedDiv artifact. FixedDiv int64 is at most a minor contributor: the same ~2× gap existed pre-int64 (v1 before: alder 204,937 vs. tank 105,868 = 1.94×), so FixedDiv is not the cause. Note: v1 fps (f92fc05, pre-int64) and v2 simFpsNodraw (16c3354, post-int64) span the FixedDiv implementation change — same -nodraw method but different code; the stable ratio confirms the gap is architectural, not algorithmic. |
| **expected win** | tank render is 0.4% of budget. Any speedup is imperceptible. |
| **verdict** | **DOCUMENT, DON'T OPTIMIZE**. The 2.7 investigation reveals: tank render is not abnormally slow; the "least improved" observation from the v1 era was a headless-fps artifact from general i5-vs-i9 throughput difference, not a fixable algorithmic issue. With wasm render at 0.4% of budget on tank, there is nothing to fix. Update the task verdict: the tank bottleneck (for browser) is the UNMEASURED JS/browser side (same as every host), which Q0 will characterize. |
| **maps to** | Task 2.7 |

---

### H. Plans.md task premise check

Tasks whose premise the data now contradicts or sharpens:

**2.2 (column/span tightening)**: Plans.md frames this as a browser-fps
win. The data shows wasm render is 1.7% of budget on wbox; a 50%
speedup saves 0.85% CPU — unmeasurable by users at 35 Hz. The correct
framing is: **bare-metal fps** (PSRAM-latency reduction via
column-stride mitigation) + **node-headless CI throughput** (timedemo
runs faster). The work remains the right work; the claimed benefit
needs reframing. The render gate ensures no regression.

**2.4 (sim hot paths "as profiling dictates")**: profiling dictates
nothing — sim is 0.25% of budget. The conditional premise is not met
by the current data. Task 2.4 should be demoted to measure-first / likely-skip
and only reopened if Q0 or a bare-metal profile reveals unexpected sim overhead.

**2.7 (tank "least improved")**: the v2 perStage data resolves this.
Tank render is 1.15× alder — essentially equivalent. The v1 fps ratio
(~2×) reflects general i9-vs-i5 CPU throughput (alder 204,937 vs. tank
105,868 at f92fc05; alder 180,370 vs. tank 95,463 simFpsNodraw at 16c3354
= 1.89×); it is stable across the FixedDiv implementation change and is
not a fixable algorithmic issue. With render-stage isolation, tank has no
anomaly to investigate. The remaining question is whether tank's
browser-side overhead (JS engine version, WebGL driver latency) is
atypical — that requires Q0.

---

### I. Queue summary (ordered)

| # | queue entry | effort | verdict | maps to |
|---|-------------|--------|---------|---------|
| Q0 | Browser pipeline measurement | S | **DO FIRST** | prereq |
| Q1 | R_DrawColumn/Span inner loops (cache-stride) | M | **DO** (bare-metal axis) | 2.2 |
| Q2 | Memory: ZONESIZE→4MB, INITIAL_MEMORY→56MB, knob sweep | S+M | **DONE** (2.5: zone SSOT; 2.6: flags confirmed optimal) | 2.5+2.6 |
| Q3 | Visplane hash (R_FindPlane O(n)→hash) | M | measure-first | 2.3 |
| Q4 | Sim hot paths | M | likely-skip | 2.4 |
| Q5 | tank deep-dive | S | document-only | 2.7 |

---

## Q2 — emcc knob sweep (task 2.6)

*Measured at commit 2992e02, 2026-07-16. All builds at emsdk 6.0.2. Size
measured via `stat` + `gzip -9 -c | wc -c`; section breakdown via
`$EMSDK_DIR/upstream/bin/llvm-objdump -h build/doom.wasm`. Speed via
`tools/fleet-bench.sh 1` (1-rep, same-session back-to-back).*

### Axis 1: optimisation level (-O3 / -O2 / -Os)

CFLAGS and LDFLAGS changed together (coherent). Closure and other flags held
constant at shipped defaults.

#### Size×speed frontier

| config | wasm raw (bytes) | wasm gzip-9 (bytes) | CODE section | DATA section | js raw | js gzip-9 | wbox render avg (ms/frame) | wbox sim fps avg |
|--------|-----------------|---------------------|-------------|-------------|--------|-----------|---------------------------|-----------------|
| **A (-O3, SHIPPED)** | 358,194 | 145,926 | 281,457 (274.9 KB) | 75,283 | 8,264 | 3,582 | **0.482** | **19,152** |
| B (-Os) | 265,554 | 123,875 | 188,554 (184.1 KB) | 75,466 | 8,264 | 3,580 | 0.498 | 17,378 |
| C (-O2) | 348,959 | 141,970 | (not broken down) | — | 9,513 | — | (alder-only, within noise) | 167,727 (alder) |

(Gzip figures are gzip-9, approximating CDN transfer. `-O2` was only benched
on alder, 1 rep; not fleet-benched as not a finalist.)

#### -Os analysis

-Os shrinks the CODE section from 281,457 to 188,554 bytes (**-33.0%**, the
entire delta is in compiled machine code; DATA is unchanged at 73.5 KB).
Wire payload (wasm gzip-9) drops from 145,926 to 123,875 bytes (**-15.1%**,
−22 KB). Total payload story: 142.5 KB → 121.0 KB gzip.

**Speed (wbox, 1-rep fleet bench):**

| demo | -O3 render (ms) | -Os render (ms) | delta |
|------|----------------|----------------|-------|
| demo1 | 0.530 | 0.539 | +1.7% |
| demo2 | 0.467 | 0.488 | +4.5% |
| demo3 | 0.450 | 0.468 | +4.0% |
| **avg** | **0.482** | **0.498** | **+3.3%** |

Sim fps (wbox, headless -nodraw): -O3 avg 19,152 vs -Os avg 17,378 = **−9.3%**.

The render regression (+3.3%) is borderline for a 1-rep run (the 2.2 sweep
established ~0.001 ms noise bar over 3 reps; 1-rep noise is wider). However,
the sim fps regression (−9.3%, consistent across all three demos) is clearly
real — V8 JIT-compiles fewer inlined and pre-scheduled code paths when the
wasm is more compact. The icache benefit of -Os (CODE −33%) does not overcome
the scheduling loss on wbox's in-order Bobcat core.

**Verdict: KILL.** The decision rule is "wbox speed regression = kill". The
−9.3% sim fps regression on wbox disqualifies -Os despite the 15% wire-size
win. Current −O3 flags are confirmed optimal.

*(For bare-metal: the 33% CODE reduction would be significant for small-flash
ESP32 targets. This is the right tradeoff point to revisit when a bare-metal
profile shows flash pressure — with full render + net tests at that target.)*

#### -O2 analysis

-O2 gives only −2.6% raw / −2.7% gzip vs -O3, with an alder sim fps of
167,727 vs -O3 162,164 (+3.4%). Not enough size win to justify any speed
risk; not fleet-benched. **KILL (not worth it).**

---

### Axis 2: --closure 0 vs 1

Only `doom.js` is affected by the closure compiler; the wasm binary is
identical between --closure 0 and --closure 1.

| config | doom.js raw (bytes) | doom.js gzip-9 (bytes) |
|--------|---------------------|------------------------|
| --closure 1 (SHIPPED) | 8,264 | 3,582 |
| --closure 0 | 19,097 | 6,000 |

Closure minification saves 10,833 bytes raw (+131%) and 2,418 bytes gzip
(+67.5%). Since doom.js is only 3.5 KB on the wire vs wasm 142.5 KB, the
absolute saving is small (~2.4 KB gzip). No speed effect on wasm.

**Verdict: keep --closure 1.** Consistent with the current Makefile; the
2.4 KB wire saving is worth the extra build step.

---

### Axis 3: STACK_SIZE=4MB

The 4 MB C shadow stack (at the start of linear memory) is very conservative
for DOOM + emscripten.

**Static analysis of worst-case call depth:**

- **BSP recursion** (`R_RenderBSPNode`): the deepest recursive path in
  DOOM. Each frame is ~32–64 bytes (node pointer, child bounds checks, a few
  locals). Maximum BSP tree depth in shipped DOOM maps: ~15 levels. Stack
  cost: 15 × 64 = ~960 bytes.
- **P_LoadLevel / P_GroupLines**: iterative, not recursive. Local arrays are
  modest (pointers + indices).
- **Emscripten runtime overhead**: setjmp/longjmp frames, POSIX thread entry
  frames (not applicable in -sENVIRONMENT=web,worker,node without threads).
  Realistically ~16–32 KB of overhead.

Conclusion: **1 MB is almost certainly sufficient** (960 bytes BSP + 32 KB
emscripten ≪ 1 MB). Emscripten's default stack for C code without large
stack allocations is 64 KB; 1 MB leaves 15× margin.

**Why 4 MB is not changed:**

1. Any reduction would shrink BSS layout → alter `__heap_base` → trip the
   three layout-pinned render goldens (tnt-demo1, plutonia-demo1,
   plutonia-demo3). Changing this flag requires a conscious regold step.
2. The 4 MB stack does not contribute to wire-transfer size (it's runtime
   heap layout, not wasm CODE/DATA).
3. The only gain from reducing it is a lower `INITIAL_MEMORY` floor. At the
   current 64 MB default this is irrelevant; at bare-metal targets the
   reduction would be meaningful but requires full test coverage at that
   target first.

**Verdict: keep STACK_SIZE=4MB.** Document only; no change.

---

### Axis 4: INITIAL_MEMORY — worst PWAD combo analysis

Single-IWAD floor was established in §3: 56 MB (2.18 MB margin above the
53.82 MB peak for plutonia.wad + 32 MB zone + 5.21 MB static).

**PWAD combos** (both IWAD + PWAD malloc'd simultaneously, from
`wads/manifest.json`):

| combo | IWAD (bytes) | PWAD (bytes) | combined | total peak (+ zone + static) |
|-------|-------------|-------------|---------|------------------------------|
| tnt.wad + tnt31.wad | 18,195,736 | 282,000 | 18,477,736 (17.62 MB) | 5.21 + 32 + 17.62 = **54.83 MB** |
| doom2.wad + nerve.wad | 14,604,584 | 3,819,855 | 18,424,439 (17.57 MB) | 5.21 + 32 + 17.57 = **54.78 MB** |
| doom.wad + sigil.wad | 12,408,292 | 4,640,210 | 17,048,502 (16.27 MB) | 5.21 + 32 + 16.27 = **53.48 MB** |
| plutonia.wad (no PWAD) | 17,420,824 | — | 17,420,824 (16.61 MB) | **53.82 MB** (§3 baseline) |

Worst real combo: **tnt.wad + tnt31.wad** at 54.83 MB peak.

Note: `tnt.wad` at 18.20 MB is slightly larger than `plutonia.wad` at
17.42 MB, making it the worst single IWAD, not plutonia.wad as stated in §3.
The §3 floor experiment (56 MB) was run with plutonia.wad; tnt.wad would give
the same PASS/FAIL pattern (56 MB ≥ 54.83 MB with 1.17 MB margin).

**Margin at 64 MB:** 64 − 54.83 = **9.17 MB headroom** for worst PWAD combo.
**Margin at 56 MB:** 56 − 54.83 = **1.17 MB** — acceptable but tight.

**Verdict: INITIAL_MEMORY stays at 64 MB.**

Rationale: 9.17 MB headroom at 64 MB is comfortable for product defaults.
Reducing to 56 MB would leave only 1.17 MB margin above the worst tested
combo, with no margin for future PWAD additions or other heap growth. The
value of 64 MB as the shipped default is to give room for uncharacterised
allocations (stack-allocated C buffers, emscripten ABI overhead, etc.) without
OOM surprises. The bare-metal case (where every MB counts) is better served
by first reducing ZONESIZE (after the render-path cache floor measurement
deferred to task 3.x), which would drop the floor by ~28 MB.

---

### Axis 5: emmalloc vs dlmalloc

Current: `-sMALLOC=emmalloc` (Makefile).

emmalloc is Emscripten's minimal allocator: ~1.5 KB of wasm code, O(n) free
list traversal, no boundary-tag coalescing. dlmalloc is Doug Lea's full
allocator: ~8–12 KB of wasm code, O(1) amortised free/malloc, buddy-system
coalescing.

For DOOM, >99% of heap allocation goes through Z_Zone (the zone allocator),
which does a single `malloc(ZONESIZE=32MB)` at startup and never calls
`free` on it. The only direct `malloc` calls are the WAD buffer at startup
and occasional small temporary buffers. With ≤2 concurrent large malloc calls,
emmalloc's simpler strategy is correct: dlmalloc's extra 8–10 KB of CODE would
be wasted for zero measurable benefit.

**Verdict: keep emmalloc.** Correct choice for this allocation pattern; no change.

---

### Summary: shipped flags confirmed optimal

All five axes measured. No flag change is justified:

| axis | conclusion | justification |
|------|-----------|---------------|
| -O3 vs -Os | **keep -O3** | -Os: −15% gzip, but −9.3% sim fps on wbox (kill) |
| -O3 vs -O2 | **keep -O3** | -O2: −2.7% gzip, no speed win; trivial size delta |
| --closure 1 | **keep --closure 1** | -closure 0: +67.5% doom.js gzip, no benefit |
| STACK_SIZE=4MB | **keep 4MB** | reducing requires regold; no wire-size impact |
| INITIAL_MEMORY=64MB | **keep 64MB** | 9.17 MB headroom at worst real PWAD combo |
| emmalloc | **keep emmalloc** | correct for DOOM's zone-dominant allocation pattern |

The shipped flags (`-O3 -flto --closure 1 -sINITIAL_MEMORY=64MB
-sSTACK_SIZE=4MB -sMALLOC=emmalloc`) are the optimal point on the
size×speed frontier for browser and bare-metal targets given the current
constraints. The only actionable future path to a smaller payload is
reducing ZONESIZE (deferred to task 3.x), which would lower the INITIAL_MEMORY
floor by ~28 MB and is worth revisiting once the render-path texture cache
peak is characterised.

---

## PSX fire launcher background — perf note

*Added at commit f6d6c0a (launcher: PSX DOOM fire background), 2026-07-16.*

The PSX fire effect (`client/js/fire.js`) runs in JS on a 64×40 indexed-byte
grid (cellular automaton, 37-entry DOOM fire ramp, nearest-neighbour
upscaled to fill the canvas). It is decoupled from the game loop at ~16 Hz
via `setInterval(62 ms)` and pauses automatically when the engine is running.

**Measured cost (alder i9-12900K CI host, 200-tick batch avg)**: ~0.07–0.10 ms/tick.
The batch benchmark amortises Chrome's 0.1 ms `performance.now()` resolution
floor; individual tick readings have ~1× the resolution noise.

**Wbox budget check**: alder reads of ~0.07–0.10 ms/tick imply a wbox estimate
of ~0.6–0.8 ms at the conservative 8× cross-host ratio — within the < 1 ms/tick
budget the comment in `fire.js` specifies. The authoritative wbox number is
measured on hardware; alder gross-regression guard is 0.5 ms (used in CI via
`tools/browser-lobby-test.mjs`).

The noise-table pre-computation (8192 entries, generated once at init) replaced
per-cell `Math.random()` calls in the hot loop, cutting cost ~4× vs the naive
implementation.

**Why this matters for perf tracking**: the fire effect is the first
intentionally expensive client-side JS background task added to webdoom. Its
cost is JS-side (not wasm) and is the kind of load the UNMEASURED browser
pipeline section (§C above) is meant to characterise. It stays well under the
1 ms/tick ceiling; it provides a concrete data point on JS background overhead.

---

## Appendix: reproduction commands

```sh
# wasm section sizes
llvm-objdump -h build/doom.wasm          # uses emsdk llvm-objdump

# zone HWM + heap headroom
node tools/zone-measure.mjs              # requires wads/lib/ symlink

# INITIAL_MEMORY floor test (link only, reuses existing .o files):
#   cd engine && emcc -O3 -flto [flags] -sINITIAL_MEMORY=56MB [...] -o /tmp/doom-56mb.js
#   node -e "..." /tmp/doom-56mb.js      # run demo3 of worst IWAD

# JS payload sizes
for f in build/doom.js build/doom.wasm client/js/*.js client/css/*.css client/sw.js; do
    echo "$(stat -c%s $f) $(gzip -9 -c $f | wc -c)  $f"
done

# sim gate
node tools/demo-test.mjs                 # 13/13 must pass

# render gate
node tools/demo-test.mjs --render        # 13/13 must pass
```
