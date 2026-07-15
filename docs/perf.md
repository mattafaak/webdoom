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
