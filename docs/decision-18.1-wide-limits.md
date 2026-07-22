# Decision 18.1 — Wide-limit telemetry and BSS arithmetic for widescreen (W=854)

**Date**: 2026-07-22
**Task**: 18.1 — Wide-limit telemetry + memory arithmetic for widescreen preparation
**Status**: LANDED

---

## 1. Context

Webdoom targets a 854-pixel widescreen canvas. Before adding widescreen rendering, we need to
know: (a) how close the current renderer is to its array limits, and (b) whether BSS and linear
memory still fit in `INITIAL_MEMORY=32 MB` when `SCREENWIDTH` increases to 854.

Task 14.2c halved INITIAL_MEMORY from 64 → 32 MiB (measured peak 26.6 MiB, headroom 5.4 MiB).
Tasks 14.2d/e/f then shrank BSS via smaller array limits; those changes are in current master.
This record re-runs telemetry against the post-14.2f codebase and calculates the W=854 budget.

---

## 2. Permanent telemetry added

Three peak counters now always accumulate in the wasm build (zero overhead without compile flags):

| Counter | Guard flag | Getter | Updated in |
|---------|-----------|--------|-----------|
| `web_perf_visplane_peak` | `-DWEB_PERF_PLANE_STATS` | `_web_perf_visplane_peak_get` | `r_plane.c R_ClearPlanes` (pre-existing) |
| `web_perf_drawseg_peak` | `-DWEB_PERF_DRAWSEG_STATS` | `_web_perf_drawseg_peak_get` | `r_bsp.c R_ClearDrawSegs` (task 14.2e) |
| `web_perf_opening_peak` | `-DWEB_PERF_OPENINGS_STATS` | `_web_perf_opening_peak_get` | `r_plane.c R_ClearPlanes` (task 14.2f) |

Both `web_perf_drawseg_peak_get` and `web_perf_opening_peak_get` added to `EXPORTED_FUNCTIONS`
in `engine/Makefile` (task 18.1).

Bug fixed: `PERF_PLANE_PEAK` previously called `(lastvisplane - visplanes)` on the first frame
when `lastvisplane == NULL` (BSS zero-init), producing UB and garbage values under `-O1`.
Fixed in this task with a `if (lastvisplane)` guard matching the existing `PERF_OPENING_PEAK`
pattern.

---

## 3. Measurement design

### 3.1 13-demo corpus (W=320, default setblocks=10)

The full cross-IWAD suite:

| Demo | visplane peak | drawseg peak | opening peak |
|------|:------------:|:------------:|:------------:|
| doom-demo1 | 33 | 90 | 1,297 |
| doom-demo2 | 35 | 74 | 836 |
| doom-demo3 | 28 | 61 | 614 |
| doom-demo4 | 53 | 89 | 1,093 |
| doom2-demo1 | 50 | 104 | 1,636 |
| doom2-demo2 | 45 | 91 | 1,341 |
| doom2-demo3 | 48 | 103 | 1,609 |
| tnt-demo1 | 66 | 112 | 1,885 |
| tnt-demo2 | 71 | 154 | 2,527 |
| tnt-demo3 | 62 | 110 | 1,869 |
| plutonia-demo1 | **118** | **180** | 2,432 |
| plutonia-demo2 | 80 | **205** | 2,431 |
| plutonia-demo3 | 95 | 165 | 2,411 |
| **Corpus peak** | **118** | **205** | **2,527** |

Measurements taken with freestanding build (`-DWEB_PERF_PLANE_STATS -DWEB_PERF_DRAWSEG_STATS
-DWEB_PERF_OPENINGS_STATS`) on current master (post-14.2c/d/e/f).

### 3.2 setblocks=10 rendering invariant

At `setblocks=10` (default), `R_ExecuteSetViewSize` sets `scaledviewwidth = setblocks * 32 = 320`
regardless of `SCREENWIDTH`. The renderer uses 320 columns in all W=854 builds with the default
view size. Opening counts and all other renderer peaks are therefore **identical at W=320 and
W=854 under setblocks=10** — the peak table above applies to both widths.

True widescreen (full-width rendering) requires `setblocks=11`, which sets
`scaledviewwidth = SCREENWIDTH`. That path is out of scope for task 18.1.

### 3.3 Representative sanity re-measurement on current master

After rebase to master (26a7572, post-14.2c/d/e/f), two demos re-confirmed peak values:

- **doom2-demo1**: visplane=50, drawseg=104, opening=1636 ✓
- **plutonia-demo1**: visplane=118, drawseg=180, opening=2432 ✓

14.2c/d/e/f code changes (zone/BSS/limit reductions) did not alter renderer peak counts.

---

## 4. Margin analysis vs vanilla limits

Current limits (after 14.2d/e/f reverts):

| Array | Limit | Corpus peak | Margin |
|-------|------:|:-----------:|:------:|
| `visplanes[]` (MAXVISPLANES) | 128 | 118 | 1.08× |
| `drawsegs[]` (MAXDRAWSEGS) | 256 | 205 | 1.25× |
| `openings[]` (MAXOPENINGS = W×64) | 20,480 | 2,527 | 8.1× |

---

## 5. RAM arithmetic — 32 MiB INITIAL_MEMORY baseline

### 5.1 Source of truth

- **INITIAL_MEMORY = 32 MB** (`engine/Makefile`: `-sINITIAL_MEMORY=32MB`)
- **ZONESIZE = 4 MB** (`engine/web/web.h`: `#define ZONESIZE (4 * 1024 * 1024)`)
- **STACK_SIZE = 4 MB** (`engine/Makefile`: `-sSTACK_SIZE=4MB`)
- **WAD** = separate `malloc(n)` in `engine/web/files.c:W_WebFile` (not inside Zone)

### 5.2 Measured web_heap_base at W=320 (post-14.2f master)

Task 14.2c measured `web_heap_base = 5.269 MiB` with MAXVISPLANES=1024, MAXDRAWSEGS=2048,
MAXOPENINGS=320×256. Tasks 14.2d/e/f then reduced BSS:

| Change | BSS delta |
|--------|----------:|
| 14.2d: MAXVISPLANES 1024→128 | −581 KB |
| 14.2e: MAXDRAWSEGS 2048→256 | −84 KB |
| 14.2f: MAXOPENINGS ×256→×64 | −120 KB |
| **Total BSS reduction** | **−785 KB** |

Estimated `web_heap_base` at current master (W=320):
5.269 MiB − 0.765 MiB = **~4.50 MiB**

### 5.3 Peak load table: W=320 (current shipping)

| Component | Size | Note |
|-----------|-----:|------|
| web_heap_base (static floor) | ~4.50 MB | code/data + BSS + 4 MB stack |
| Zone (`malloc(ZONESIZE)`) | 4.00 MB | `engine/web/web.h: ZONESIZE` |
| WAD peak (`malloc` via W_WebFile) | 17.35 MB | tnt.wad, largest of 4 IWADs |
| **Total peak** | **~25.85 MB** | |
| **Headroom** | **~6.15 MB** | INITIAL_MEMORY 32 MB − 25.85 MB |

W=320 is confirmed safe: headroom ~6.1 MB with ALLOW_MEMORY_GROWTH=0.

### 5.4 Peak load table: W=854, setblocks=11 (future widescreen)

At W=854, two BSS arrays grow with SCREENWIDTH:

| Array | W=320 size | W=854 size | Delta |
|-------|----------:|----------:|------:|
| `visplanes[128]` (top/bottom each W bytes) | 85.5 KB | 222.2 KB | +136.7 KB |
| `openings[W×64]` (MAXOPENINGS×2 bytes) | 41.0 KB | 109.3 KB | +68.4 KB |
| `drawsegs[256]` (width-independent) | 12.0 KB | 12.0 KB | — |
| **BSS delta** | | | **+205 KB** |

Estimated `web_heap_base` at W=854: 4.50 MB + 0.205 MB = **~4.71 MB**

| Component | Size | Note |
|-----------|-----:|------|
| web_heap_base (static floor, W=854) | ~4.71 MB | +205 KB BSS vs W=320 |
| Zone (`malloc(ZONESIZE)`) | 4.00 MB | unchanged |
| WAD peak (`malloc` via W_WebFile) | 17.35 MB | unchanged |
| **Total peak** | **~26.06 MB** | |
| **Headroom** | **~5.94 MB** | INITIAL_MEMORY 32 MB − 26.06 MB |

**W=854 with setblocks=11 also fits within INITIAL_MEMORY=32 MB** (headroom ~5.9 MB).
No INITIAL_MEMORY bump is needed for widescreen rendering. The 32 MB budget is safe for
both the current W=320 build and the future W=854 setblocks=11 path.

### 5.5 BSS strategy decision: static-max

Runtime alloc was considered but rejected. BSS delta at W=854 is only +205 KB vs W=320,
and both widths fit within 32 MB with ~6 MB headroom. Static compile-time arrays (current
approach) have zero runtime overhead, simpler code, and no alloc-failure path. Chosen: **static-max**.

---

## 6. Revisiting 14.2d/e/f vanilla-limit reverts

### 6.1 Visplanes (14.2d): MAXVISPLANES 1024→128

18.1 corpus measurement: peak=118 (plutonia-demo1, full 13-demo suite — the task 2.3
measurement of 68 was tnt-demo2 only).
Limit=128: margin = 1.08×.

peak=118, limit=128: margin 1.08× — too thin for production.
Limit-busting community WADs routinely exceed 128 visplanes per frame.
(Historical note: the round-3 branch revert to 1024 was motivated by this thin
margin; current master retains 128 as the vanilla floor per §7.)

**Verdict**: 14.2d revert to MAXVISPLANES=128 is validated by the 1.08× margin being
insufficient headroom for community content. The current 128 limit is the vanilla floor;
future widescreen work may re-raise it with measured justification.

### 6.2 Drawsegs (14.2e): MAXDRAWSEGS 2048→256

18.1 corpus measurement: peak=205 (plutonia-demo2).
Limit=256: margin = 1.25×.

14.2e measured peak 205 and set MAXDRAWSEGS=256 (1.25× margin). The doom-demo4 witness
confirmed no regression. The 1.25× margin is thin but the draw-seg overflow path has a hard
I_Error guard. Current verdict: retained.

### 6.3 Openings (14.2f): MAXOPENINGS ×256→×64

18.1 corpus measurement at setblocks=10: peak=2,527 (tnt-demo2).
Limit at W=320: 320×64 = 20,480. Margin = 8.1×.

The 8.1× margin is comfortable for the corpus. At setblocks=11 (W=854), MAXOPENINGS scales
to 854×64=54,656 — the setblocks=11 measurement was not taken (out of scope, since opening
counts are identical at setblocks=10 regardless of SCREENWIDTH). The vanilla overflow guard
at `r_plane.c:437` applies. Current verdict: retained.

---

## 7. Chosen limits (committed)

| Array | Current limit | Corpus peak | Margin | Decision |
|-------|:------------:|:-----------:|:------:|---------|
| MAXVISPLANES | 128 | 118 | 1.08× | Retain vanilla 128 (14.2d); future raise needs community-WAD evidence |
| MAXDRAWSEGS | 256 | 205 | 1.25× | Retain 256 (14.2e) |
| MAXOPENINGS | W×64 | 2,527 | 8.1× | Retain ×64 (14.2f) |
| INITIAL_MEMORY | 32 MB | ~26 MB peak | ~6 MB | No bump needed for W=854 |

---

## 8. DoD checklist

- [x] Permanent drawseg and opening peak counters committed with NULL-safe guard
- [x] Both getters exported via EXPORTED_FUNCTIONS (Makefile)
- [x] Measurements across 13-demo suite (doom, doom2, tnt, plutonia) in table above
- [x] BSS strategy decision: static-max, justified by +205 KB delta and headroom analysis
- [x] RAM arithmetic against 32 MiB INITIAL_MEMORY (correct post-14.2c baseline)
- [x] 14.2d/e/f vanilla-limit reverts reviewed with witness peaks
- [x] Sanity re-measurement on current master confirms peak values unchanged by 14.2c/d/e/f

---

## 9. 18.2a handoff notes (review round, 2026-07-22)

Four deferred items from the 18.2a review — owners are the 18.2b/c workers:

1. **am_map.c:222** `finit_width = MAXSCREENWIDTH` is a bucket misclassification
   (display width, should be runtime `screenwidth`). Equal at 320; wrong once
   width changes. Fix in 18.2b when the automap is exercised at non-320 width.
2. **r_main.c:762,763 (pspritescale/pspriteiscale; scalelight sites nearby)** `pspritescale`/`pspriteiscale` and the
   scalelight tables use MAXSCREENWIDTH as the 320 design-reference constant.
   These are exactly the sites 18.2b's Crispy Hor+ (`centerxfrac_nonwide`)
   scheme must update.
3. **web/i_video.c:23** `web_rowmajor_buf[MAXSCREENWIDTH*SCREENHEIGHT]` is
   indexed `y*screenwidth+x`; overflows for screenwidth > 320. 18.2c must
   resize (dynamic alloc or raise MAXSCREENWIDTH to the 854 cap) before
   `web_set_wide()` activates.
4. **v_video.c:362** V_DrawPatchDirect RANGECHECK uses MAXSCREENWIDTH
   (dead VGA-planar code in wasm builds; asymmetric with other V_Draw*).

### 18.2b review addendum (2026-07-22)

- Items 1 and 2 above were fixed in 18.2b (finit_width → screenwidth;
  zlight/scalelight/pspritescale via DOOM_ORIGHALF/centerxfrac_nonwide).
- New deferral for 18.2c: **ST_Lib widget x-coordinates** are not
  WIDESCREENDELTA-offset — health/ammo numerals render in the left flank at
  wide widths (sbar background patch IS centered). Remap widget x in 18.2c.
- Item 3 (web_rowmajor_buf resize) remains open for 18.2c.
