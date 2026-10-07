# Performance and memory

What the shipped artifacts cost today, where the time goes, and how to measure
any of it again with the tools in this tree. Every figure names its host, the
build it was taken on and the date. A figure that could not be tied to the
current tree is not here; `git log -- docs/perf.md` has the older ones.

The candidates that were tried against these numbers, landed or killed, are in
[optimization-ledger.md](optimization-ledger.md). Retro-hardware arithmetic that
builds on the instruction counts below is in [retro.md](retro.md), and the
core-to-platform contract a no-OS port needs is in [bare-metal.md](bare-metal.md).

Hosts: **alder** (i9-12900K, the development host; fast here proves nothing),
**tank** (i5-8350U) and **wbox** (AMD G-T56N Bobcat, 1.65 GHz, in-order: the
floor, where a regression blocks).

---

## 1. The budget, and where the time goes

DOOM runs its simulation at 35 Hz, so one tic has **28.57 ms**. The wasm engine
uses a small fraction of that on every host:

| host | wasm render, ms per frame (demo1 / demo2 / demo3) | share of 28.57 ms | sim, ms per tic |
|---|---|---|---|
| wbox | 0.5675 / 0.4980 / 0.4855 | 1.7–2.0% | 0.067–0.110 |
| tank | 0.1098 / 0.0982 / 0.0945 | 0.33–0.38% | 0.010–0.019 |
| alder | 0.0567 / 0.0498 / 0.0484 | 0.17–0.20% | 0.005–0.010 |

Source: [`tools/golden/bench-baseline.json`](../tools/golden/bench-baseline.json), the reference the perf gate compares
against — doom.wad attract demos, best of 3, recorded at f402d5c on 2026-07-22
(a 355,350-byte wasm, before the hybrid build in §2). `fleet-bench.sh --check`
on 4fedc76 (2026-10-06, alder shared with a test suite) reads alder 0.058 /
0.049 / 0.047 ms and wbox 0.559 / 0.485 / 0.462 ms, all inside the gate's 20%
band; tank was offline.

On wbox the stages split bsp+segs 51%, planes 33%, masked sprites 14%, frame
setup 2% (means over the three demos). The rank order is the same on every host.

Two consequences shape every optimization decision:

- **No wasm change is justified as a browser frame-rate win.** Halving wbox's
  render time saves under 1% of the tic. Wins are claimed in instructions per
  tic (§5) and in what they buy a bare-metal target, never in browser fps.
- **The browser side is measured separately** (§6), because palette upload,
  WebGL, rAF scheduling and audio are invisible to the wasm timers.

---

## 2. The shipped artifacts

Measured with `node tools/size-budget.mjs` on alder, emsdk 6.0.2, at 7f5c682,
2026-10-05:

| figure | measured | ceiling ([`size-budget.json`](../tools/size-budget.json)) |
|---|---|---|
| `build/doom.wasm` | 300,698 B | 307,200 B |
| `build/synth.wasm` (the AudioWorklet synth) | 21,395 B | 24,576 B |
| `__heap_base` (stack + DATA + BSS) | 1,512,512 B | 1,572,864 B |
| cold page load, gzip -9 of the 25 `SHELL_FILES` | 229,486 B | 250,000 B |
| the same without the engine (JS + CSS + HTML) | 82,220 B | 88,000 B |

`build/doom.js`, the ES module wrapper, is 8,774 B. doom.wasm compresses to
133,762 B with gzip -9 and 123,172 B with brotli at quality 6 (node zlib, same
date). The ceilings are not exact figures: a change that fits needs no edit,
and raising one needs its reason in the commit message. The `size-budget` leg
fails past any of them.

### The wire

`server/serve.js` negotiates `br` > `gzip` > identity for text, JSON and wasm
bodies of 1 KiB or more, compresses each body once, and answers a matching
`If-None-Match` with a 304. The service worker is network-first for the shell,
so a repeat load moves headers only. The 25 shell files are 554,534 B raw and
212,990 B as the server's brotli sends them (its own parameters, 7f5c682,
2026-10-05); `http-fuzz` gates the encoding, ETags and 304s. Box art arrives as
lazy 80×60 thumbnails from `/api/thumb/<file>`, and the WADs are fetched on
first play, streamed through the service worker and cached.

### Build flags, and why each one

From [`engine/Makefile`](../engine/Makefile). Each row's number is the
measurement that decided it.

| flag | measured reason | where |
|---|---|---|
| `-Oz` per object, `-O3` for the 17 files in `HOT`, link `-O3 -flto` | doom.wasm 355,395 → 299,348 B (−15.8%), gzip −8.7%; alder render and sim inside the noise floor (2026-09-16) | ledger C8 |
| not whole-program `-Os` / `-Oz` | `-Os`: sim −9.3% on wbox (2026-07-16); `-Oz`: sim −11% on alder (2026-09-16) | ledger K5 |
| not `-O2` | −2.7% gzip against `-O3`; alder sim +3.4% on one rep, never fleet-benched (2026-07-16) | ledger K5 |
| `--closure 1` | doom.js 8,264 vs 19,097 B raw, 3,582 vs 6,000 B gzip (2026-07-16); the wasm is unchanged | ledger K5 |
| `-sINITIAL_MEMORY=32MB`, no growth | worst real WAD combination peaks at 23.15 MiB (§3) | ledger C3 |
| `-sSTACK_SIZE=1MB` | measured stack peak ≈14 KiB over 13 demos | ledger C7 |
| `-sMALLOC=emmalloc` | the engine makes two large mallocs (zone, WAD) and few small ones; dlmalloc's extra code buys nothing for that pattern (reasoned, not measured) | — |

---

## 3. Linear memory

The wasm memory is a flat 32 MiB (33,554,432 B) with growth off. Layout on the
current build (2026-10-06, 256 visplanes):

| region | size | source |
|---|---|---|
| C shadow stack, at the start of memory | 1 MiB | `STACK_SIZE` |
| static data (DATA + BSS) | 550,176 B (537 KiB) | `__heap_base` − 1 MiB |
| `__heap_base` | 1,598,752 B (1.52 MiB) | read from the wasm by `size-budget.mjs` |
| zone pool, one `malloc` | 4 MiB | `ZONESIZE` in `engine/web/web.h` |
| WAD copies, one `malloc` each | IWAD + optional PWAD | |

Every byte of `__heap_base` comes out of WAD headroom, which is why it has its
own ceiling. Peak address for the worst real combinations in the library
(`__heap_base` + zone + WADs; small allocations excluded):

| combination | WAD bytes | peak | headroom under 32 MiB |
|---|---|---|---|
| tnt.wad + tnt31.wad | 18,195,736 + 282,000 | 23.15 MiB | 8.85 MiB |
| doom2.wad + nerve.wad | 14,604,584 + 3,819,855 | 23.10 MiB | 8.90 MiB |
| plutonia.wad | 17,420,824 | 22.14 MiB | 9.86 MiB |
| doom.wad + sigil.wad | 12,408,292 + 4,640,210 | 21.78 MiB | 10.22 MiB |

`hacx.wad` (51 MB) is skipped by the library because it is not a
vanilla-engine IWAD, so it is not a row here.

### The zone

The zone is 4 MiB. Whether that is enough depends on the render path, not the
sim: with rendering on, composite textures and sprites fill the purgeable cache
(`PU_CACHE`), and a small zone evicts them. Measured on the freestanding build
(the same `engine/core`, rendering on) over all 13 demos, alder, 7f5c682,
2026-10-05:

| zone | worst non-purgeable peak | worst total peak | PU_CACHE purges per demo | sim hashes |
|---|---|---|---|---|
| 32 MiB | 1,081,972 B (tnt demo2) | 11,048,348 B (tnt demo3) | 0 | 13/13 identical |
| 4 MiB | 1,082,340 B (tnt demo2) | fills the zone | 251–1,428 | 13/13 identical |

So 4 MiB is 3.9× the non-purgeable floor and the cache works under eviction
without changing anything the demos can see. The shipped wasm runs the same
4 MiB zone, so `render-goldens` checks the pixels at that size on every run.

### Renderer limits

Three of the renderer's fixed arrays are back at vanilla sizes; solidsegs
stays doubled. Their peaks over the 13 demos, measured on the freestanding build with the stats flags in §7 (alder,
7f5c682, 2026-10-05; solidsegs from a scratch counter on 2026-09-17, which
has no flag in the tree):

| limit | size | corpus peak | margin | on overflow |
|---|---|---|---|---|
| `MAXVISPLANES` | 256 (vanilla 128) | 118 (plutonia demo1); library views about 156 | 2.17× | `I_Error` in either allocator |
| `MAXDRAWSEGS` | 256 | 205 (doom demo4) | 1.25× | the wall seg is not drawn |
| `MAXOPENINGS` | 320 × 64 = 20,480 | 2,527 (tnt demo3) | 8.1× | clip arrays dropped, fail-soft |
| `MAXSEGS` (solidsegs) | 64 (vanilla 32) | 17 | 3.8× | the wall is dropped |

The drawseg margin is thin for community maps; it stays at vanilla's size
because raising it costs BSS, and therefore WAD headroom. The visplane array
is 256 entries because a served map, SIGIL E5M6, needs 134 in its opening
view; at 664 B each that is 84,992 B more than vanilla's 128.

---

## 4. Wall-clock per stage: bench.mjs and the perf gate

[`tools/bench.mjs`](../tools/bench.mjs) boots the engine in node and runs
doom.wad demo1–3 twice each: a render pass that reads the per-stage
accumulators (frame setup, bsp+segs, planes, masked) and a `-nodraw` pass that
measures sim throughput in tics per second. It keeps the best of N reps.

[`tools/fleet-bench.sh`](../tools/fleet-bench.sh) copies `build/doom.{js,wasm}`, `bench.mjs` and the WAD
to wbox and tank over ssh, runs alder locally, and prints a per-host table. By
default it then **rewrites** `tools/golden/bench-baseline.json`; with
`--check` it writes nothing and fails if any host's per-demo `sum_ms` is more
than 20% above the baseline (`FLEET_TOL` overrides). The tolerance comes from
four comparison runs: three stayed inside ±3.7% on all nine host/demo pairs,
and one had a single tank spike past 10%. That check is the `perf-fleet` leg,
in the opt-in perf tier because it needs wbox and tank awake; it reports zero
comparisons as a failure, not a pass.

Sim throughput in the baseline (tics per second, `-nodraw`, average of
demo1–3, f402d5c, 2026-07-22): alder 199,067; tank 98,942; wbox 19,994. The
4fedc76 run read alder 199,634 and wbox 19,337.

---

## 5. Instructions per tic: the cycle floor

Wall-clock on a desktop says little about a 100 MHz target, and it moves with
whatever else the machine is doing. The freestanding build counts retired
user-space instructions instead (`PERF_COUNT_HW_INSTRUCTIONS`, kernel
excluded), per tic and per stage. This is the currency the optimization ledger
uses.

Measured on alder at 7f5c682, 2026-10-05: `fs-doom` (`-m32 -O1`, x86), rendering
on, all 13 demos, 44,580 tics. Each cell is the mean over that IWAD's demos of
the per-demo median (p50) instructions per tic:

| IWAD | whole | sim | bsp+segs | planes | masked | sim share |
|---|---|---|---|---|---|---|
| doom.wad (4 demos) | 1,226,206 | 60,848 | 533,200 | 432,942 | 144,302 | 5.0% |
| doom2.wad | 1,359,684 | 82,409 | 580,680 | 396,761 | 173,042 | 6.1% |
| tnt.wad | 1,358,444 | 52,374 | 560,606 | 522,261 | 140,994 | 3.9% |
| plutonia.wad | 1,464,397 | 90,145 | 613,508 | 502,556 | 183,109 | 6.2% |

Frame setup is 2,558 per tic everywhere. The remainder (`other`: net update,
bracket overhead) is 27–57 K. The stage counters and the whole-tic counter read
the same perf fd, so the stages reconcile with the whole to 0.0%.

doom demo3, the demo the ledger quotes, is p50 **1,121,056**. The highest p99
is doom demo4 at 2,642,490 (maxima are level-load tics). Repeat runs of one demo
agree within 0.2% at p50, and with the counter on all 13 per-tic hash streams
still match the goldens.

Render (frame setup, bsp+segs, planes, masked) is 85–91% of a tic and the sim
4–6%. These are x86 instructions from a `-O1` build, not wasm and not any
target ISA; [retro.md](retro.md) converts them with its own stated factors.

---

## 6. The browser pipeline

Under `?perfmarks=1` the client records per-frame durations into
`window.__wd_perf`.
[`tools/browser-pipeline.mjs`](../tools/browser-pipeline.mjs) drives headless
Chrome through CDP into E1M1, collects at least 200 frames and 35 input
samples, and reports p50/p90/p99 per stage:

| stage | what it times |
|---|---|
| (a) palette | palette texture upload when the palette changes |
| (b) upload | framebuffer `texSubImage2D` + draw |
| (c) raf | frame-to-frame interval, and the whole rAF callback |
| (d) worklet | the AudioWorklet's `process()` |
| (e) inputLat | keydown `timeStamp` to `renderer.draw()` returning |
| (f) opl | music synthesis on the main thread |

The committed baseline is `tools/golden/browser-pipeline-alder.json` (eb85484,
2026-07-22, Chrome 150, two runs of about 4,600 frames each):

| stage | run 1 | run 2 |
|---|---|---|
| upload p99 | 0.2 ms | 0.2 ms |
| rAF callback p99 | 1.3 ms | 1.3 ms |
| rAF interval p50 | 16.7 ms | 16.7 ms |
| input latency p50 | 9.5 ms | 9.8 ms |

Input latency is about half a 60 Hz frame because events land at a random
phase; the JS pipeline adds under a millisecond of it. Compositing after
`draw()` is not included.

`tools/pipeline-gate.sh` is the `browser-pipeline` leg: it collects one run,
and `tools/browser-pipeline-compare.mjs` fails any checked stat that exceeds
the worse baseline run by more than three times max(the two runs' spread, a
per-stage floor). Input-latency p99 (n=35) and the worklet stage are not
compared. Only alder has a baseline; any other host SKIPs by name.

**Audio cannot be measured unattended.** Headless Chrome, and headed Chrome
under `xvfb-run`, arm the AudioContext and never pull it, because there is no
output device. Stages (d) and (f) read nothing there. On a desktop session,
`node tools/browser-pipeline.mjs --headed` reads them.

### Why the synth runs in the AudioWorklet

The music synth used to run on the main thread from a 100 ms timer. Measured in
node with the same wasm, `mus_intro`, 300 calls of 4,800 frames at 48 kHz after
10 discarded (2026-09-16):

| host | per 100 ms call, p50 / p99 | share of wall time |
|---|---|---|
| alder | 1.76 / 1.84 ms | 1.8% |
| tank | 3.98 / 4.09 ms | 4.0% |
| wbox | 18.5 / 19.7 ms | 18.6% |

The share was not the problem; the shape was. One synchronous 19 ms call every
100 ms drops a frame every sixth frame on wbox. `build/synth.wasm` links the
same `mus_opl.c` and `opl3.c` objects as the engine and renders each 128-frame
quantum inside the worklet, so none of that is on the main thread now. The
main-thread path remains only for insecure origins, which have no
`audioWorklet`. The `opl-mode` leg drives the shipped `client/js/music-worklet.js`
in node, 128 frames at a time, and requires its output byte-identical to the
engine's, because no browser here will run `process()` unattended.

### Page load

`tools/load-budget-test.mjs` (the `load-budget` leg) loads the page twice in
one Chrome profile and times launcher to running engine. Baseline
`tools/golden/load-budget-alder.json`, recorded 2026-09-13: cold 371 ms, warm
331 ms. The budget is the warm figure × 2.5 with a 4 s floor, so it is a
regression tripwire, not a speed claim. Hosts without a baseline SKIP.

### The launcher fire

`client/js/fire.js` runs a 64×40 grid at about 16 Hz and pauses while the
engine runs: 0.0078 ms per tick on alder and 0.072 ms on wbox in a node
microbench (2026-07-16), against a 1 ms budget. `browser-fire` fails above
0.5 ms on alder as a gross-regression guard.

### Replay seek

`web_seek_demo(N)` re-sims the demo from tic 0 with drawing off and no
keyframes, so a seek costs the sim time of N tics, and the worst case is the
end of the longest demo: plutonia-demo1, 7,403 tics. Five seeks to tic 7,400
in one Node process on alder (Node 26.10, build at ba09f5f, 2026-10-06, load
average about 3): 58.4, 48.7, 48.4, 48.0 and 47.3 ms. `demo-seek` checks that
a seek lands where linear replay does, not how fast it gets there.

---

## 7. How to measure

All commands run from the repository root. Build first:
`source tools/emsdk-env.sh && make -C engine`.

**Sizes.** `node tools/size-budget.mjs` prints all five figures and fails past
a ceiling. For a section breakdown, `llvm-objdump -h build/doom.wasm` (from
`$EMSDK_DIR/upstream/bin/`).

**Per-stage wall-clock, one host.** `bench.mjs` loads `doom.js`, `doom.wasm`
and the WAD from its own directory, so stage them together:

```sh
d=$(mktemp -d); cp build/doom.js build/doom.wasm tools/bench.mjs wads/lib/doom.wad "$d"
(cd "$d" && node bench.mjs doom.wad 3 --json)
```

**Per-stage wall-clock, the fleet.** `bash tools/fleet-bench.sh --check`
compares against the baseline without writing it; this is what
`tools/run-tests.sh --perf --only perf-fleet` runs. `bash tools/fleet-bench.sh 3`
records a new baseline — do that only on purpose, with the reason in the commit.

**Instructions per tic.** `make -C tools/freestanding`, then:

```sh
d=$(mktemp -d); ln -s "$PWD/wads/lib/doom.wad" "$d/doomu.wad"
WD_CYCLES=1 tools/freestanding/fs-doom "$d/doomu.wad" -timedemo demo3 \
    -cycles cycles.json -attrib attrib.json -sim "$d/doom-demo3.json"
python3 tools/native-sanitize/compare.py tools/golden "$d" sim
```

`-cycles` writes whole-tic mean/p50/p99/max, `-attrib` the per-stage split and
`-sim` the per-tic hash stream. doom.wad goes in under the name `doomu.wad`, as
`tools/freestanding/run-check.sh` does it: demo4 exists only in the Ultimate
IWAD, and the goldens were recorded that way. The other IWADs need no rename.
`WD_DETAIL=1` measures the low-detail renderer.

**Zone and renderer-limit peaks.** These counters compile in only on request.
Make does not track flags, so clean before and after:

```sh
make -C tools/freestanding clean
make -C tools/freestanding EXTRA_CFLAGS="-DWEB_PERF_ZONE_STATS -DFS_ZONE_SIZE_OVERRIDE='(4*1024*1024)'"
tools/freestanding/fs-doom wads/lib/tnt.wad -timedemo demo2 -zonestats zone.json
make -C tools/freestanding clean && make -C tools/freestanding
```

`-DWEB_PERF_PLANE_STATS`, `-DWEB_PERF_DRAWSEG_STATS` and
`-DWEB_PERF_OPENINGS_STATS` print `visplane_peak`, `drawseg_peak` and
`opening_peak` on stderr at demo end. The default build is unaffected by any
of them.

**Browser.** `node tools/browser-pipeline.mjs --json` (starts its own server;
`--url` to use a running one, `--headed` for the audio stages).
`bash tools/pipeline-gate.sh` compares against this host's baseline.
`node tools/load-budget-test.mjs --record` records a load baseline for a new
host.

**Comparing two builds.** Same host, same flags, same demos and reps on both
sides, interleaved where possible, and state all of it. Measure the noise first:
relinking the same objects and benching twice moved alder's render by
+0.7…+2.7% and sim by ±1.4% (2026-09-16), so a difference inside that is no
difference. The kill rule a new candidate is judged by is in
[optimization-ledger.md](optimization-ledger.md#the-kill-rule).
