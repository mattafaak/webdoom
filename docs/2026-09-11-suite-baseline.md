# Suite baseline — 2026-09-11 (task 22.1)

First end-to-end run of `tools/run-tests.sh` since 2026-07-24 (49 days), and the
first one that could report what it did: the previous runner aborted at the
first red under `set -eo pipefail`, so any failure left every later leg
unverified and unmentioned.

**Host**: alder (i9-12900K), Node v26.8.1, clang-format 22.1.8, emsdk 6.0.2
(pinned), Chrome stable, Firefox 155.0.1.
**Commit**: round4-gate-integrity after 21.7.
**Command**: `bash tools/run-tests.sh --require-complete`
**Result**: **63 legs — 62 passed, 1 failed, 0 skipped**, ~13 min wall clock.

**End-of-round re-run** (after 21.3, 21.10, 21.12 added eight more legs):
**71 legs — 70 passed, 1 failed, 0 skipped**. The single red was F1 below.

**After F1 was root-caused and fixed: 71 legs — 71 passed, 0 failed, 0
skipped, `--require-complete`, exit 0.** Fully green.
The table at the bottom is the original 63-leg run, kept as the baseline it was
taken to be.

This is evidence, not a claim: the table below is the runner's own output.

## What the run establishes

- The 13 sim goldens, all five render golden families (vanilla, low-detail,
  wide, fakeflat, potato), the wide sim-invariance gate and the sprite-edge
  witness are all green — 78 golden comparisons.
- The differential fuzzer and the adversarial ASan map gate are green **against
  a reference rebuilt from the current tree**. Both had been answering for an
  engine 10 commits old (task 21.4); this is the first time either has spoken
  about the code that is actually in the repo.
- Four gates that existed and ran nowhere are now in the suite and green:
  the native ASan demo suite (which README already advertised), the
  freestanding 13/13 proof, the read-only-WAD XIP invariant, and the shipped
  19.4 demo-verify CLI.

## Open reds and findings

### F1 — a missed-event race in the harness (CLOSED, 6296f2d)

Not one test: across eight observed runs the red moves.

| run | red | detail |
|-----|-----|--------|
| quick tier (pre-21.x) | net-fuzz 2/30 | binary frame fuzz; rapid lobby churn |
| full run A | net-fuzz 1/30 | lobby JSON fuzz |
| isolated 1, 2, 6 | net-fuzz 1/30 | connect during countdown |
| isolated 3 | *clean* | — |
| isolated 4 | net-fuzz 1/30 | lobby JSON fuzz |
| isolated 5 | net-fuzz 2/30 | rapid lobby churn; msg rate flood |
| full run B (this baseline) | **edge** | `Error: timeout 20000ms: onceMsg` |
| full run C (end of round) | net-fuzz 1/30 **and** edge | both, same run |
| full run D (end of round) | **edge** | `Error: timeout 20000ms: onceMsg` |

Every failure is a wait-for-message timeout; `crashed` is false every time, so
the server process is alive and not answering in time. Six distinct net-fuzz
cases have failed, and `edge` failed once — so the common factor is the family
of server-spawning tests, not any one assertion.

**Refuted by measurement, do not re-open**: slow server startup. `serve.js`
accepts its first connection in **54-58 ms over 10 samples** (sd < 2 ms), while
these tests wait 600-800 ms before connecting — 10x headroom. The fixed sleeps
are ugly (task 21.7 replaced them at the suite level) but they are not this.

**Root cause, found by instrumenting the wait rather than theorising about it.**
`serverAlive()` returned a bare boolean, so it was made to say which of the
three outcomes it hit: the socket opened in 0–1 ms (`readyState=1`) and no
welcome arrived. That read as a server bug. Moving the recording listener to
**construction time** settled it — the same failing run then logged
`frames: welcome,roster` while `onceMsg` reported "no welcome within 2000 ms".

The frame had arrived and the wait had missed it. `onceMsg()` attached its
`ws.on('message')` handler only when CALLED, one or two microtasks after
`await open(ws)` resolved; a frame landing in that window was emitted to no
listener and dropped. The server answers immediately on connect, so that window
is exactly where the answer lives. `edge-test.mjs` carried the same race,
written independently.

Both now record from socket construction, and `onceMsg` consults that buffer
before waiting. The buffer is the single source of truth: an arriving frame
satisfies at most one waiter and leaves the buffer when it does — resolving from
the buffer while leaving it there would let a later wait match the same frame
twice, a false pass in the other direction.

    net-fuzz   before: 1 pass / 7 fail of 8      after: 8 pass / 0 fail of 8
    edge       before: red on ~1 full run in 2   after: 8 pass / 0 fail of 8
    full suite after: 71/71, exit 0

Blast radius checked, not assumed: of the tools speaking the game protocol
directly, `browser-lobby-test` runs in the browser, `spectate-test` creates no
raw sockets, and `spectate-inject-test` polls rather than awaiting a named
frame. These two were the only instances.

### F2 — `verify-all --full` red on perf-009 `__heap_base` (CLOSED)

The suite only ever runs the fast tier, so this had no way to surface. The
script measures `__heap_base = 5,042,320`; doc and manifest say `4,721,456`.
Static data has grown ~321 KB since the stamp was taken.

It was not restamped blind. **Attributed by experiment**: rebuilding with
`MAXSCREENWIDTH` back at 320 gives `__heap_base` = 4,722,016 — within **560
bytes** of the old stamp. So 320,400 of the 320,960-byte growth is the 18.2a
widescreen dimension separation (320 → 854 scales `visplanes`, `openings` and
the per-column arrays), which `spec.md` sanctions; the residual 560 B is
everything else since, including the 23.x guards. Not a regression, and the
BSS-diet candidates C4-C6 are not implicated.

Restamped with that attribution recorded in `claims.json`. The dependent
figures moved with it: perf-012 (peak heap 25.12 → 25.42 MB), perf-059 (worst
PWAD combo 26.12 → 26.43 MB), and perf.md's memory table (static data 515 →
828 KB, headroom 6.88 → 6.58 MB).

Both stampers stopped carrying their own copy of the number — `wasm-stamp.mjs`
and `stamp-check.mjs` read the expected values from `claims.json` now, which is
the 21.9 principle: perf-059 is derived from perf-009, so a hand-typed copy has
to be edited in two places or the gate contradicts itself.

**`verify-all --full` is now ALL PASS, 137 claims, zero families skipped** — the
instrumented `build-perf/` tree was built so `runtime-stat` runs too, and the
skip message now prints the exact command to build it.

(Prior art: `archive/Plans-floor-initiative-complete.md:100` records the same claim
drifting once before, 5,461,072 -> 4,930,352, closed by task 14.4.)

### F5 — the build is byte-reproducible (CLOSED, new fact)

Not a defect — a fact the project asserted and had never re-verified. Rebuilding
`build/doom.wasm` from a clean tree returns **exactly** the md5 the optimization
ledger recorded as "proven" *at landing (b80d729, 2026-09-11)*,
`c669142745449ff04bd2fef30fa17412`, at 356,775 bytes; `build-sbskip` likewise
reproduced `1fa7322e5b2325ca585aa712a3aa1167`.

> Both figures are this document's date, not the present. be0c271 (task 25.2)
> changed `engine/web/web.h` the next day and the artifact moved with it —
> `3edea657b5a54395613fef9cd2dbc539` / 357,101 B. The claim that survives is
> reproducibility; the digits are a snapshot. `tools/toggle-identity-check.mjs`
> holds the current values against the artifacts on every run.
Re-recording the 13 sim goldens from that build produced byte-identical files.
So on the pinned toolchain the artifacts, and the goldens taken from them, are
reproducible rather than merely once-measured. `tools/toggle-identity-check.mjs`
now holds all 8 of the ledger's md5/size claims against the artifacts.

It also found one stale: `build-diffblit` had drifted from its documented md5
because commit 22fa00f changed `i_video.c` the day after the landing commit
recorded the figure, and never updated the row. Corrected, with that history
attached.

### F3 — the wbox browser-pipeline baseline is vacuous (ADDRESSED, task 21.10)

`tools/golden/browser-pipeline-wbox.json` is in the pre-`run1`/`run2` schema:
0 of 7 stages carry `run1`, so every check takes the
`SKIP: no run1/run2 in baseline` branch and the comparator prints PASS having
compared nothing. Verified by parsing both baselines — alder has `run1` on 6 of
7 stages, wbox on 0 of 7.

Fixed in both halves: the comparator now FAILS when 0 of N checks actually
compared, and the file moved to `tools/golden/archive/` so wbox SKIPs loudly.
**Still open**: wbox has no gating baseline. Recording one needs the repo, a
build and WADs on wbox, none of which are there (node v24.19.0 and
google-chrome-stable are). That is a provisioning task.

### F4 — the four-host perf gate cannot be run as specified (CLOSED)

`spec.md` required before/after numbers on wbox, tank, pi5 and alder, and said
a regression on any host blocks. **pi5 is down** (`tailscale ping` times out;
recorded as acked in the mesh notes). So the gate as written was unrunnable.
Needed a decision: three-host gate, pi5 restored, or the promise amended.

> **CLOSED — the decision was taken the same day and this entry did not move.**
> `spec.md` §"Fleet amendment, 2026-09-11" retires pi5 from the gate and the
> tenet now reads "the three live reference hosts"; commit 3bf5c6b is titled
> "migrate pi5's role to alder — ARM correctness under emulation (closes F4)".
> The amendment also records why the swap is not a loss: `fleet-bench.sh` ssh'd
> to pi5 to run `node tools/bench.mjs` against the **wasm** build, and wasm is
> architecture-independent by construction, so that row was a performance sample
> and never tested ARM codegen, ABI or alignment. The `arm-cross` leg asserts
> something strictly stronger, on a host that answers.
>
> What IS still open is narrower and is tracked as F3: the perf gate has no
> suite leg at all — neither `bench.mjs` nor `fleet-bench.sh` appears in
> `run-tests.sh` — and `browser-pipeline` gates one host, alder, of which
> spec.md's own table says "fast here proves nothing".

## The table

```
  LEG                    VERDICT      SECS  WHAT IT REPORTED
  ────────────────────────────────────────────────────────────────────────────
  lint                   PASS            2  PASS — every pipeline-using shell script enables pipefail 
  doc-drift              PASS            5  ALL PASS verify-all: all checks green 
  state-machine          PASS            0  PASS — check-state-machine: 25/25 edges verified, 0 failures 
  sw-precache            PASS            0  ok sw.js precache integrity: 26 entries, import graph 25 paths — no drift 
  http-fuzz              PASS            4  PASS — all 15 http fuzz cases passed 
  demo-store-fuzz        PASS            0  PASS — demo-store-fuzz-test: all demo store checks green 
  net-fuzz               PASS           40  PASS — all 30 fuzz cases: server survived all attacks, caps enforced 
  gate-census            PASS            0  PASS gate-census: 62 gate-shaped tools — 57 run by the suite, 5 registered out-of-suite with a r
  freshness              PASS            0  PASS — all 3 artifact(s) current with their sources 
  size-ledger            PASS            0  PASS size-ledger: all hard checks green 
  smoke-doom             PASS           11  PASS 
  smoke-doom2            PASS           15  PASS 
  opl-mode               PASS            1  PASS: OPL2/OPL3 mode toggle verified 
  gm-frames              PASS            0  PASS — gm-frames-test: 23 assertions, 0 failures 
  build-invariants       PASS            0  PASS build-toggle: WEBDOOM_INVARIANTS -> build-invariants/doom.js 
  sim-invariants         PASS            0  PASS — all demos bit-identical to golden (13 demos) 
  fuzz-diff              PASS            1  PASS: all 20 seeds bit-identical (wasm ≡ native) 
  sim-goldens            PASS            0  PASS — all demos bit-identical to golden (13 demos) 
  render-goldens         PASS            6  PASS — all render goldens pixel-identical (13 demos) 
  render-low             PASS            6  PASS — all [low-detail] render goldens pixel-identical (13 demos) 
  render-wide            PASS           15  PASS — all wide render goldens pixel-identical (W=854, 13 demos) 
  sim-wide               PASS            0  PASS — sim invariant under wide (W=854): 13 demos byte-exact 
  build-fakeflat         PASS            1  PASS build-toggle: WEBDOOM_FAKEFLAT -> build-fakeflat/doom.js 
  render-fakeflat        PASS            6  PASS — all [fakeflat] render goldens pixel-identical (13 demos) 
  build-potato           PASS            0  PASS build-toggle: WEBDOOM_POTATO -> build-potato/doom.js 
  render-potato          PASS            6  PASS — all [potato] render goldens pixel-identical (13 demos) 
  sprite-witness         PASS            0  PASS — sprite-edge witness goldens verified (2 buckets, r_things.c:530 cull pin) 
  native-asan            PASS           12  all demos passed ASan/UBSan run 
  freestanding-sim       PASS            4  PASS: 13/13 demos bit-identical — the freestanding core matches vanilla 
  ro-wad                 PASS            4  PASS: 13/13 demos bit-identical — the freestanding core matches vanilla 
  demo-verify-cli        PASS            0  PASS — all 13 golden demos VERIFIED 
  mixed-width-net        PASS           17  PASS — mixed-width (P0=320 vs P1=854): 368 tics, 0 mismatches (wide is render-only) 
  net-2p                 PASS           21  PASS — 2-player lockstep deterministic, drop handled 
  net-4p                 PASS           22  PASS — 4-player lockstep deterministic, drop handled 
  join-coop              PASS           19  PASS — drop-in coop: slot 2 caught up, spawned, and stayed in lockstep (0 desync) 
  join-dm                PASS           19  PASS — drop-in deathmatch: slot 2 caught up, spawned, and stayed in lockstep (0 desync) 
  spectate               PASS           20  PASS — spectator caught up, per-tic hash matches P0 at all 350 common tics (0 desync) 
  spectate-inject        PASS           16  PASS — 627 injections sent; veteran hashes match on all 370 common tics — injection is a protoco
  edge                   FAIL(rc=1)     25  Error: timeout 20000ms: onceMsg 
  churn                  PASS           20  PASS — 3 join/drop cycles, 175 joiner tics in lockstep (0 desync), veterans ran 444 tics 
  demo-seek              PASS            0  PASS: seek equivalence confirmed — web_seek_demo(N) matches linear hash at N 
  demo-verify            PASS            1  PASS — demo-verify-test: all gates green (26 assertions) 
  adversarial-map        PASS            2  GATE PASS: adversarial corpus = 0 clean + 30 I_Error, 0 sanitizer reports 
  browser-sp             PASS           11  PASS — title/menu/e1m1/moved screenshots in /tmp 
  browser-net            PASS           12  PASS — drill-down lobby → name/color → sparse-slot co-op in-game 
  browser-join           PASS           17  PASS — browser drop-in: GAME IN PROGRESS → DROP IN → caught up in-game 
  persist                PASS           24  PASS — savegame survives a page reload; load slots visible; quit-within-3s durable; interval sto
  browser-resilience     PASS           13  PASS — all 5 resilience paths graceful 
  browser-lobby          PASS           69  PASS — all lobby state-machine edges covered and clean 
  browser-fire           PASS            5  PASS — all fire background assertions passed 
  browser-ierror         PASS            4  PASS — I_Error recovery: landing restored, error message shown, canvas hidden 
  browser-rafdeath       PASS            4  PASS — rAF exception recovery: landing restored, status shown, loop stopped (ws-001 fixed) 
  browser-wide           PASS            5  PASS 
  browser-qol            PASS            8  PASS 
  browser-wadimport      PASS            5  PASS — malformed corpus clean, import→entry→boot→reload all verified 
  browser-mp-gating      PASS            6  PASS — SP includes local WAD, MP excludes it; red-proof confirms filter is load-bearing 
  browser-sf2            PASS            9  PASS — SF2 malformed-corpus, drag-drop, reload survival, picker persistence, GM-OPL-fallback ass
  browser-offline        PASS            6  PASS — offline SP boot from SW cache proven 
  browser-demo           PASS           15   [Log.warning] []Automatic fallback to software WebGL has been deprecated. Please use the --enab
  browser-music-fallback PASS           10  PASS — music fallback sink: buffer, frames non-zero, status visible 
  browser-insecure       PASS           11  PASS — insecure origin: IDB WAD cache hit + BufferSink music fallback confirmed (no synthetic fo
  browser-pipeline       PASS           80  PASS browser-pipeline: within tolerance of tools/golden/browser-pipeline-alder.json 
  firefox-smoke          PASS           12  PASS firefox smoke: Firefox UA confirmed, JS executed (53 UA hits, 1 /api/wads) 
  ────────────────────────────────────────────────────────────────────────────
  63 legs: 62 passed, 1 failed, 0 skipped  (tier: full)
  SUITE FAILED: edge
```

## Reproducing

```sh
bash tools/run-tests.sh --require-complete   # everything (~13 min on alder)
bash tools/run-tests.sh --quick              # no WADs, no build, no browser
bash tools/run-tests.sh --list               # the leg registry
bash tools/run-tests.sh --only render-goldens --only sim-goldens
```
