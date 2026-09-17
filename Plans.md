# webdoom Plans.md

The open work, the verdicts that closed the rest, and one pointer per
finished round. Precedence: `spec.md` > sub-specs > this file. Closed rounds
are not re-told here: their task tables are in `git log` and, for the first
four initiatives, under `docs/archive/`.

## Markers

| marker | meaning |
|--------|---------|
| `cc:完了` | complete; the `[hash]` beside it is the landing commit. `cc:完了(partial)` names the remainder in the row. |
| `cc:分割` | decomposed into the lettered sub-tasks below it; not itself worked. |
| `cc:決定` | decided rather than implemented; the verdict (PARKED / PURSUABLE / REJECTED / CLOSED) is written under the tables and `tools/archaeology/status-drift-check.mjs` rule 2 asserts the two agree. |
| `cc:TODO` | open. |
| `[tdd:skip:<reason>]` | lands no test, and the reason is part of the marker. |

# Open work — the floor campaign (round 3, 2026-07-21)

Contract: `spec.md` as amended 2026-07-21. The only rows still open live in
this table; every other round-3 task is archived at
`docs/archive/Plans-field-fixes-complete.md`.

Nine rows left this table in round 11 and are archived, with the verdict that
retired each, at `docs/archive/Plans-round3-retired.md`: the four FastDoom
toggles 20.3a–d (deleted from the engine in round 10 — the DoDs name build
trees that no longer exist) and the five N64 rows past the emulator gate
(20.4d, 20.5, 20.5a, 20.5b) that need a device or a decomposition nobody has.
A row here should be something a reader can pick up.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 20.1 | Atlas v2: new measured rows — 386DX-40 chase budget (33–46% whole-program cut per committed arithmetic), N64 VR4300 @93.75 MHz, Genesis+Sega CD dual-68k + ASIC-visplane analysis (honest verdict: infeasible for tic-exact 35 Hz native-res by ~10×, external anchor krikzz doom-68k 1–2 fps — PARKED), sub-100 MHz MCU arithmetic (F_isa 3–5 M0+ → single-core 100 MHz is 1.4–2.3× short; dual-core + WHD required); spec amendment cross-referenced [tdd:skip:atlas-doc-task] | per-row arithmetic from committed measurements; verify-all green; parked verdicts recorded with anchors | - | cc:完了 [a2a53cf] |
| 20.1b | Track decomposition: session-sized task breakdown of 20.2–20.7 with per-task DoDs (the 13.3a lesson: new-ABI bring-up took 3 capped workers) — gates all implementation below [tdd:skip:planning-task] | decomposed tasks appended to this file with DoDs; no implementation task below starts before this lands | 20.1 | cc:完了 [ffb5420] |
| 20.2 | **DECOMPOSED** Fresh optimization sweep (user directive): re-mine docs/engine-archaeology.md + per-stage attribution + game code for candidates NOT in the optimization ledger, NOT in FastDoom/rp2040-doom's known catalogs (those are 20.3); hunting grounds: attribution hot spots (bsp/segs/planes/things), column-major cache-layout effects, fixed-point kernel superoptimization; output = ranked ledger candidates with icount estimates; implementations land one-per-task via 20.1b under ledger kill rules; ANY landing requires 13/13 sim-golden tic-identity (the "provably does not affect demo playback" gate, verbatim) [tdd:skip:survey-produces-ledger-entries] | (superseded — see 20.2a + candidate template 20.2b) | 20.1 | cc:分割 |
| 20.2a | Fresh opt survey: mine docs/engine-archaeology.md + per-stage attribution table + game code (bsp/segs/planes/things hotspots, column-major cache-layout effects, fixed-point kernel superoptimization); exclude FastDoom + rp2040-doom known catalogs; rank candidates by estimated icount reduction | ≥5 novel candidates committed in docs/optimization-ledger.md; each entry: description, committed icount estimate (from archaeology script or nat-doom perf), tic-exact-safe/unsafe classification with source-level reasoning, kill rule (min gain threshold before drop); verify-all green | 20.1 | cc:完了 [841e9d0] |
| 20.2b | (landing template — instantiate per ledger entry) Implement the highest-priority tic-exact-safe candidate from 20.2a under its stated kill rule; 1 task per candidate after survey | candidate passes its kill rule (measured icount gain ≥ threshold, committed); 13/13 sim-golden tic-identity proven (demo hash output unchanged from master); docs/optimization-ledger.md entry updated with before/after measurement | 20.2a | cc:完了 [90250e8] |
| 20.4 | **DECOMPOSED (ABI-landmine staging)** N64 sub-phase A (bring-up): freestanding core + libdragon shell, software render; EMULATOR (ares) leg = the repeatable gate; capture-not-cure protocol for the new-ABI landmine class (PPC signedness / ARM short-enums / MIPS alignment precedents); hardware runs via SummerCart64 UART hash logs = committed evidence, not CI | (superseded — see 20.4a–20.4d) | 20.1b | cc:分割 |
| 20.4a | N64 ABI landmine audit + freestanding core: enumerate engine/core incompatibilities with MIPS R4300 (endianness, alignment, signed-char, strict-aliasing, int-size); commit docs/n64/MIPS-ABI-LANDMINES.md with capture-not-cure disposition; confirm engine/core compiles against N64 newlib with 0 source-file changes (shim only) | docs/n64/MIPS-ABI-LANDMINES.md committed; ≥4 landmine classes enumerated; each entry: capture-not-cure rationale or explicit fix + why it does not break the 0-diff contract; engine/core diff vs master = 0 lines; verify-all green | 20.1b | cc:完了 [9e91c05] |
| 20.4b | N64 libdragon shell + software render boot: build engine/core against libdragon headers + ROM linker script (tools/n64/); boot ROM to D_DoomMain UART banner under ares emulator; software rasterizer only (RDP deferred to 20.5); WAD via libdragon FS or baked blob | ROM boots to D_DoomMain banner in ares UART output (captured + committed as tools/n64/ares-boot.log); engine/core diff vs master = 0 lines; any per-tic hash streaming blocker documented with root cause (partial filed as partial, no fabrication) | 20.4a | cc:完了 [a265404] |
| 20.4c | N64 ares 13/13 demo gate: automate 13/13 demo runs under ares; per-tic sim hashes verified against 11.1a freestanding golden traces; gate exits 0 on all-match, non-zero on any divergence | tools/n64/run-n64-demos.sh exits 0 with 13/13 bit-identical: 44,580 tics, every per-tic hash identical to the wasm golden; drift-proved (perturb `trace[500]` → `first_at_tic=500`, restore → PASS byte-identical); wired as suite leg `n64-demos` and removed from the out-of-suite registry | 20.4b | cc:完了 [25.4b] |
| 20.6 | **DECOMPOSED** 386 test bed: 86Box bench harness (cycle-configurable 386DX-40 profile) + icount-scoreboard reduction campaign toward the 1,142,857 cycles/tic budget; candidates flow from 20.2/20.3 | (superseded — see 20.6a–20.6b) | 20.1b | cc:分割 |
| 20.6a | 86Box harness: configure 86Box with cycle-configurable 386DX-40 profile; automated boot to DOS + DOOM launch + icount capture via 86Box debug port; red-provable | tools/386/run-386box.sh committed; exits 0 on successful DOOM icount run (cycles/tic received + printed); exits non-zero on boot/launch failure; drift-proved: corrupt boot image → FAIL, restore → PASS; 386DX-40 baseline cycles/tic committed | 20.1b | cc:完了 [bed8573] |
| 20.6b | 386 icount scoreboard baseline: run harness over demo1 (and 13 demos if runtime permits); decompose icount per subsystem (bsp/segs/render/playsim/transfer) using 86Box profiling; update atlas row | docs/perf/386-icount-scoreboard.md committed with per-subsystem icount breakdown; atlas row for 386DX-40 updated with measured cycles/tic and headroom to 1,142,857 target; scoreboard is regenerable from tools/386/; verify-all green | 20.6a | cc:決定 [25.5 PURSUABLE] |
| 20.7 | **DECOMPOSED** Sub-100 MHz floor measurement: arithmetic row first (20.1), then bounded attempt on underclocked RP2040-class silicon with WHD-style asset work; deliverable is a NUMBER — the measured minimum clock at which 13/13 demos stay tic-exact — not a promised record | (superseded — see 20.7a–20.7b) | 20.1b | cc:分割 |
| 20.7a | RP2040 bring-up + WHD asset pipeline: bring engine/core up on RP2040 using the freestanding shim pattern (11.1a precedent); prepare reduced-size WAD pipeline (WHD-format headless extract); document underclocking method (pico-sdk frequency define or overclock register) | RP2040 ROM boots to D_DoomMain (rp2040-doom toolchain or pico-sdk); WHD asset pipeline script committed (tools/rp2040/prep-whd.sh or equivalent); underclocking method documented with ≥2 tested clock steps; partial filed as partial (no fabrication) | 20.1b | cc:完了 [1f2efb2] |
| 20.7b | RP2040 floor clock measurement: sweep RP2040 clock downward from 100 MHz in steps; at each step run 13/13 demos tic-exact check (sim hash match); find minimum clock where all 13 pass; update atlas row with measured floor + variance | measured floor clock committed (tools/rp2040/clock-sweep-log.txt); atlas row updated: minimum MHz for 13/13 tic-exact, method, variance (≥3 retests at floor clock); FINDING filed if floor > 100 MHz; no "record" claim — the number is the deliverable | 20.7a | cc:決定 [25.5 PARKED] |

> **These four sections are ROUND 3's planning apparatus, and the tasks they
> rank, sequence and validate — 16.x through 19.x — were archived to
> `docs/archive/Plans-field-fixes-complete.md` when that round closed 22/22 at `1f9f1e5`.
> They are kept as the record of how that round was planned, not as live
> guidance: a reader looking for what is open should read the task tables
> above, where 20.x onward live. (Round 6 flagged them; they were four
> sections of forward-looking prose about work that had already shipped.)**


## 25.5 verdicts — 20.6b and 20.7b

These sat in the same TODO bucket while being stuck in completely different ways.

### 20.7b (RP2040 floor clock): **PARKED on arithmetic**, per the Sega CD precedent

The deliverable is "the measured minimum clock at which 13/13 demos stay
tic-exact". You cannot measure a clock for a build that does not fit, and it
misses by a factor of four:

| | measured |
|---|---|
| SRAM needed (.data + .bss) | 1,082,104 B |
| RP2040 SRAM available | 270,336 B (264 KB) |
| deficit | 811,768 B — **4.00×** |
| deficit with a real zone (1,028 KB min) | ~1,565 KB |
| WHD gzip WAD vs flash | 5,536 KB vs 1,761 KB |

**Buying hardware does not unblock this**, which is why it is worth writing
down: the blocker is a footprint, not an absence. `rp2040js` is installed and
equally blocked (ELF at 0x8000 rather than XIP, plus the same overflow).

**What would NOT unblock it, and was listed here until the status-drift gate
caught it**: "the BSS diets already sitting in `docs/optimization-ledger.md` as
C4–C6 (MAXVISPLANES, MAXDRAWSEGS, MAXOPENINGS)". All three landed on
2026-07-18/19 as tasks 14.2d/e/f — *before* the 20.7a footprint measurement
above — and `tools/rp2040/Makefile` already pins `-DMAXSCREENWIDTH=320`. So the
1,082,104 B is post-diet and post-narrow, and the first item of the stated path
was a saving that had already been taken. Anyone who went and did it would have
got nothing, which is the whole cost of this class of error.

The arithmetic is unaffected and the park stands. What remains, honestly, is a
WHD-class asset pipeline, external PSRAM, and a footprint reduction nobody has
scoped — the measured deficit is 4.00× with the easy levers already pulled.
That is a phase, not a task, and it does not have a plan yet.

### 20.6b (386 icount scoreboard): **PURSUABLE** — not blocked on anything scarce

The harness boots 86Box headlessly and the BIOS ROMs are fetchable. What is
missing is two freely-obtainable assets nobody has fetched: a FreeDOS disk image
and the DOS `DOOM.EXE` (shareware v1.9 **is** freely redistributable). Unstarted
work with a known path, not an infeasibility.

Named plan: build a FreeDOS 1.3 HDD image with `mtools`, place `DOOM.EXE` and a
`timedemo.bat` in `C:\DOOM\`, boot under the existing `tools/386/run-386box.sh`,
capture cycles/tic from the debug port, and fill in the atlas row.

**Worth stating before anyone spends a day on it**: this measures *id's DOS
binary* on a 386 as a baseline for the atlas row. It does not measure this
codebase, and no change here can move the number. The atlas comparison is the
whole of its value.

---


# Open work — round 11 (2026-09-17)

The optimization ledger's own open column, which had no owner until now. Each
row is a ledger candidate, not a phase; the ledger holds the mechanism, the
kill rule and the measurement, and is the record when the row closes.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| NC6 | Run the OPL synth inside the AudioWorklet as a second wasm (`build/synth.wasm`) built from the same `mus_opl.o`/`opl3.o` the engine links, so `web_music_render` leaves the main thread; `BufferSink` stays for insecure origins | 2 s of OPL2 byte-identical to `tools/golden/opl2-ref.f32` from the standalone module AND through the shipped `music-worklet.js`; `browser-music-worklet` proves a secure origin renders non-silent audio with the main-thread stage at n=0; `browser-insecure` still proves the fallback | - | cc:TODO |
| NC2 | MAXSEGS 64→32 after the solidsegs census the ledger entry has always demanded (peak over 13 demos + 30 adversarial maps, as a runtime-stat claim) | census committed as a gated claim; land only if the peak leaves the entry's margin, else KILLED with the measured peak | - | cc:TODO |
| NC3 | `R_GetColumn` single-patch fast path | measured icount on doom.wad demo3 p50; < 2,000 instr/tic = drop; 13/13 across five golden families | - | cc:TODO |
| NC4 | `R_DrawColumn` 8-wide unroll written for the column-major framebuffer (the row-major `#if 0` block is deleted, not revived) | measured icount vs the 4-wide baseline; < 4,000 instr/tic = drop; red-proof: a poisoned unroll fails the render goldens | - | cc:TODO |


# Closed rounds

One line each. The tables, DoDs and landing hashes are in the commit history
(`git log --grep '^docs: record round'` finds each close-out).

| round | date | what it was | close-out |
|-------|------|-------------|-----------|
| refinement, understanding, floor initiative, field fixes | 2026-07-15 → 07-24 | the first four initiatives, 26/26 · 6–11 · 32/32 · 22/22 | `docs/archive/Plans-*-complete.md` |
| 4 — gate integrity | 2026-09-11 | leg-isolating runner, self-regold holes closed, golden provenance, the first honest baseline | `docs/2026-09-11-suite-baseline.md` |
| 5 — gates that pass while the thing they name is broken | 2026-09-12 | endSession, GL dispose, demo-store eviction, hostile-lobby, CSP, status-drift, docs-index | 9f2bfce |
| 6 — the program itself | 2026-09-12 | perf-fleet tier, history cap, settings SCHEMA, one reset path, one #status, keyboard-usable launcher, spec "What ships" | c2628ba |
| 7 — strip to single player, deathmatch and WADs | 2026-09-12 | OPTIONS as a menu screen, widescreen and Panini removed, four QoL overlays deleted, attestation endpoint deleted | b6bf591 |
| 9 — simplification | 2026-09-16 | menus that flow (one game list, value rows, RULES, CONNECTING, `full` handled), one boot funnel and one reset path, one IndexedDB path, comments cut to the why, one lobby loop on the server, seven dead engine getters, `tools/lib/` under every leg, Plans.md and the archives | 01b997b |
| 10 — slim and unorthodox | 2026-09-16 | GM SoundFont backend and the four FastDoom toggles cut (engine byte-identical); the GPU swaps the framebuffer axes, wasm stack 1 MB, hybrid -Oz/-O3 build (doom.wasm 355,883 → 299,348 B, goldens unmoved); br/gzip + ETag revalidation and lazy 5.5 KB box art (cold launcher 1,259,266 → 209,035 B); the OPL synth measured on every host (ledger NC6: worklet-side synth next); hex goldens; net-fuzz pooled (46 → 10 s); `run-tests.sh --jobs N` (705 → 367 s); the WAD streams into the heap (JS heap 14 → 1.5 MB); history slabs on the server (29 → 8 MB) | see `git log --grep '^docs: record round 10'` |
| 8 — the gates that were never armed | 2026-09-12 | render-path invariance gates, stamp tier, four README promises gated (`service-file`, `smoke-pwad`, `load-budget`, `firefox-frame`), the ledgers' value columns | a63048a |

Round 10 closed at **77 legs**, 18 quick, 19 browser, 30 documents (round 8
had closed at 91 / 19 / 20 / 32); every count in `README.md`, `ci.yml`,
`CONTRIBUTING.md` and `docs/README.md` is derived from `run-tests.sh --list`
or from the checker that grades it.

## Phase Z: decide and record — no new gates

Each verdict is written WITH its status cell, never beside a `cc:TODO`
(`status-drift` rule 2).

| item | verdict |
|------|---------|
| `rme-004` analog twin-stick | **PARTIAL, permanently, by verdict.** A headless runner has no stick, and a synthetic `Gamepad` object gates the shim rather than the path — so a gate here would assert its own mock. Round 7 reasoned this out in a bullet and left it in "What this round did NOT do", where it was re-discovered twice; it is a decision now. The contradicting `tools/run-tests.sh` comment ("Also closes promises rme-004") was corrected in Y3d |
| `spc-005` "small enough to read in a sitting" | **UNGATEABLE, by verdict** — a LOC ceiling gates a PROXY, not the promise. A 400-line file of dense cleverness fails the promise while passing the proxy. The numbers are PUBLISHED instead of graded (`payload-size` reports the shipped surface; `docs-index` the documentation set) and the sentence stays as prose that says what it is |
| `prf-001` INITIAL_MEMORY 56 MB | **FLAGGED, parked by verdict.** The disposition stays "no gate" because that is what is true; what changed is the decision not to build one. An emcc sweep is a session for one promise whose figure has no consumer — `perf-059`..`perf-059d` already gate the worst real PWAD combo against the 64 MB that ships, with 9.17 MB headroom |
| round-4 **F3**, `browser-pipeline` on wbox | **alder-only by policy.** `have_baseline()` makes a host without a golden SKIP by name, which is the correct behaviour and not a gap; `load-budget` (round 8) uses the same pattern deliberately. Committing a wbox baseline would gate a second host against ITS own past, not against alder — useful, not load-bearing, and it needs the repo, a build and WADs on wbox, none of which are there |
| mouse-sensitivity double-scaling | **by design, recorded.** `settings.mouseSens` scales mouse deltas and vanilla `mouseSensitivity` (`g_game.c:579-580`) scales the same events again, neutral at its default of 5. `g_game.c` is vanilla and on the ticcmd path, so it is deliberately untouched; the OPTIONS screen carries a header naming DOOM's own menu. Not a defect to fix — a consequence of keeping the playsim vanilla |
| `tools/coverage/run-coverage.sh` | **stays out of suite, reason unchanged.** Its registry entry says "Give it a floor and it becomes a leg", and a floor is exactly what should NOT be invented here: a coverage number committed without an argument for the number is a bar set where the code happens to be, and every later run either meets it trivially or gets it lowered. It produces a report; the report is the deliverable |


# Known open, not scheduled

- **The N64 rows past the emulator gate** (20.4d hardware evidence, 20.5/20.5a
  the RDP renderer, 20.5b its speedup) — retired to
  `docs/archive/Plans-round3-retired.md` in round 11 with the verdict that
  blocks each: a device nobody has, or a decomposition nobody has written.
  `n64-demos` runs (13/13 bit-identical on emulated N64).
- **20.6b, the 386 icount scoreboard** — `cc:決定 [25.5 PURSUABLE]` above; it
  measures id's DOS binary, never this codebase, so it can never gate a change.
- **`docs/perf.md` locator drift** — 37 of 129 locators sit beyond 60% of
  doc-drift's window; the rest are ambiguous matches the sweep leaves alone.
- **F3** — `browser-pipeline` has a baseline only for alder, by policy (Phase Z).
