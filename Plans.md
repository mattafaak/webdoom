# webdoom Plans.md

Prior initiatives archived: `docs/Plans-refinement-complete.md` (26/26),
`docs/Plans-understanding-complete.md` (Phases 6–11),
`docs/Plans-floor-initiative-complete.md` (Phases 12–15, 32/32 at 8305c4a),
`docs/Plans-field-fixes-complete.md` (round 3 Phases 16–19, 22/22 at 1f9f1e5).

## Markers used in the tables below

Both vocabularies are used on every row of this file and neither was
written down anywhere until round 6.

| marker | meaning |
|--------|---------|
| `cc:完了` | complete. A commit hash in `[...]` beside it is the landing commit. `cc:完了(partial)` means the DoD is met in part, with the remainder named in the row. |
| `cc:分割` | decomposed — this row was split into the lettered sub-tasks below it and is not itself worked. |
| `cc:決定` | decided rather than implemented; the verdict (PARKED / PURSUABLE / REJECTED / CLOSED) is written under the tables and `tools/archaeology/status-drift-check.mjs` rule 2 asserts the two agree. |
| `cc:TODO` | open. |
| `[tdd:skip:<reason>]` | this task lands no test, and the reason is part of the marker — a planning, survey or document task with no code to gate. Every use carries a reason; a bare `tdd:skip` is not valid. |

Historical note: rows citing `[this commit]` instead of a hash were
resolved to real hashes in round 6 (24.2 `5be60ba`, 25.1 `f549213`,
25.4b `e03a93b`, 25.5 `7ed98b9`).


# Planning round 3 (2026-07-21) — field fixes, music, widescreen, community tooling, the floor campaign

Contract: root `spec.md` as amended 2026-07-21 (insecure-origin tier, music
contract, widescreen sanction, floor-campaign non-goal amendment). Previous
round (Phases 12–15) complete 32/32 at 8305c4a. Size-budget rule for this
round: any task growing client JS or `doom.wasm` lands its
`size-budget.json` bump as an explicit line item in that task, never a
silent regold. Every new client module updates the SHELL precache
(`check-sw-precache` — ws-003 class).

## Phase 20: The floor campaign (sub-spec targets, atlas-first)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 20.1 | Atlas v2: new measured rows — 386DX-40 chase budget (33–46% whole-program cut per committed arithmetic), N64 VR4300 @93.75 MHz, Genesis+Sega CD dual-68k + ASIC-visplane analysis (honest verdict: infeasible for tic-exact 35 Hz native-res by ~10×, external anchor krikzz doom-68k 1–2 fps — PARKED), sub-100 MHz MCU arithmetic (F_isa 3–5 M0+ → single-core 100 MHz is 1.4–2.3× short; dual-core + WHD required); spec amendment cross-referenced [tdd:skip:atlas-doc-task] | per-row arithmetic from committed measurements; verify-all green; parked verdicts recorded with anchors | - | cc:完了 [a2a53cf] |
| 20.1b | Track decomposition: session-sized task breakdown of 20.2–20.7 with per-task DoDs (the 13.3a lesson: new-ABI bring-up took 3 capped workers) — gates all implementation below [tdd:skip:planning-task] | decomposed tasks appended to this file with DoDs; no implementation task below starts before this lands | 20.1 | cc:完了 [ffb5420] |
| 20.2 | **DECOMPOSED** Fresh optimization sweep (user directive): re-mine docs/engine-archaeology.md + per-stage attribution + game code for candidates NOT in the optimization ledger, NOT in FastDoom/rp2040-doom's known catalogs (those are 20.3); hunting grounds: attribution hot spots (bsp/segs/planes/things), column-major cache-layout effects, fixed-point kernel superoptimization; output = ranked ledger candidates with icount estimates; implementations land one-per-task via 20.1b under ledger kill rules; ANY landing requires 13/13 sim-golden tic-identity (the "provably does not affect demo playback" gate, verbatim) [tdd:skip:survey-produces-ledger-entries] | (superseded — see 20.2a + candidate template 20.2b) | 20.1 | cc:分割 |
| 20.2a | Fresh opt survey: mine docs/engine-archaeology.md + per-stage attribution table + game code (bsp/segs/planes/things hotspots, column-major cache-layout effects, fixed-point kernel superoptimization); exclude FastDoom + rp2040-doom known catalogs; rank candidates by estimated icount reduction | ≥5 novel candidates committed in docs/optimization-ledger.md; each entry: description, committed icount estimate (from archaeology script or nat-doom perf), tic-exact-safe/unsafe classification with source-level reasoning, kill rule (min gain threshold before drop); verify-all green | 20.1 | cc:完了 [841e9d0] |
| 20.2b | (landing template — instantiate per ledger entry) Implement the highest-priority tic-exact-safe candidate from 20.2a under its stated kill rule; 1 task per candidate after survey | candidate passes its kill rule (measured icount gain ≥ threshold, committed); 13/13 sim-golden tic-identity proven (demo hash output unchanged from master); docs/optimization-ledger.md entry updated with before/after measurement | 20.2a | cc:完了 [90250e8] |
| 20.3 | **DECOMPOSED** FastDoom-class presentation-side harvest: fake-flat mode, status-bar redraw skip, potato/half-width columns, differential-blit analysis — each behind a toggle, each a separate ledger entry, visual-change modes get their OWN goldens (never touch the 320 vanilla goldens), fleet + icount measured | (superseded — see 20.3a–20.3d) | 20.1b | cc:分割 |
| 20.3a | FastDoom fake-flat: sky/ceiling/floor drawn as solid color when far (texture reads skipped); guard behind `WEBDOOM_FAKEFLAT` toggle; visual-change mode → OWN render golden set required | toggle-off: wasm binary byte-identical to master (md5 match); red-proof: corrupt a vanilla golden → FAIL, restore → PASS (vanilla goldens untouched); toggle-on: own render golden set committed (generated from toggle-on build, never modified vanilla goldens); icount reduction measured on 4 fleet hosts + committed ledger row; 13/13 sim (state-hash) goldens unchanged toggle-on and toggle-off | 20.1b | cc:完了 [6d19915] |
| 20.3b | FastDoom status-bar redraw skip: skip re-rendering the status bar when nothing changed between frames; guard behind `WEBDOOM_SBSKIP` toggle; non-visual when static → may produce pixel-identical output | toggle-off: wasm binary byte-identical to master (md5 match); red-proof: corrupt vanilla golden → FAIL, restore → PASS; toggle-on: if pixel-identical to toggle-off, that identity is the proof (no separate golden set); if not pixel-identical, own golden set committed; measured speedup on 4 fleet hosts + ledger row; 13/13 sim goldens unchanged | 20.1b | cc:完了 [2d7756c] |
| 20.3c | FastDoom potato/half-width columns: half-resolution column renderer (column drawn at half width, horizontally doubled); guard behind `WEBDOOM_POTATO` toggle; visual change → OWN render golden set required | toggle-off: wasm binary byte-identical to master (md5 match); red-proof as above (vanilla goldens untouched); toggle-on: own render golden set committed; icount reduction measured on 4 fleet hosts + ledger row; 13/13 sim (state-hash) goldens unchanged toggle-on and toggle-off | 20.1b | cc:完了 [085a5ba] |
| 20.3d | FastDoom differential blit: copy only changed screen regions to the canvas transfer buffer; guard behind `WEBDOOM_DIFFBLIT` toggle; blit path only — framebuffer content unchanged so no visual delta | toggle-off: wasm binary byte-identical to master (md5 match); red-proof: corrupt vanilla golden → FAIL, restore → PASS; toggle-on: pixel output byte-identical (blit path only); measured throughput gain on wasm→canvas transfer path across 4 fleet hosts + ledger row; 13/13 sim goldens unchanged | 20.1b | cc:完了 [b150eec] |
| 20.4 | **DECOMPOSED (ABI-landmine staging)** N64 sub-phase A (bring-up): freestanding core + libdragon shell, software render; EMULATOR (ares) leg = the repeatable gate; capture-not-cure protocol for the new-ABI landmine class (PPC signedness / ARM short-enums / MIPS alignment precedents); hardware runs via SummerCart64 UART hash logs = committed evidence, not CI | (superseded — see 20.4a–20.4d) | 20.1b | cc:分割 |
| 20.4a | N64 ABI landmine audit + freestanding core: enumerate engine/core incompatibilities with MIPS R4300 (endianness, alignment, signed-char, strict-aliasing, int-size); commit docs/n64/MIPS-ABI-LANDMINES.md with capture-not-cure disposition; confirm engine/core compiles against N64 newlib with 0 source-file changes (shim only) | docs/n64/MIPS-ABI-LANDMINES.md committed; ≥4 landmine classes enumerated; each entry: capture-not-cure rationale or explicit fix + why it does not break the 0-diff contract; engine/core diff vs master = 0 lines; verify-all green | 20.1b | cc:完了 [9e91c05] |
| 20.4b | N64 libdragon shell + software render boot: build engine/core against libdragon headers + ROM linker script (tools/n64/); boot ROM to D_DoomMain UART banner under ares emulator; software rasterizer only (RDP deferred to 20.5); WAD via libdragon FS or baked blob | ROM boots to D_DoomMain banner in ares UART output (captured + committed as tools/n64/ares-boot.log); engine/core diff vs master = 0 lines; any per-tic hash streaming blocker documented with root cause (partial filed as partial, no fabrication) | 20.4a | cc:完了 [a265404] |
| 20.4c | N64 ares 13/13 demo gate: automate 13/13 demo runs under ares; per-tic sim hashes verified against 11.1a freestanding golden traces; gate exits 0 on all-match, non-zero on any divergence | tools/n64/run-n64-demos.sh exits 0 with 13/13 bit-identical: 44,580 tics, every per-tic hash identical to the wasm golden; drift-proved (perturb `trace[500]` → `first_at_tic=500`, restore → PASS byte-identical); wired as suite leg `n64-demos` and removed from the out-of-suite registry | 20.4b | cc:完了 [25.4b] |
| 20.4d | N64 SummerCart64 hardware evidence + fps: load ROM on real N64 via SummerCart64; capture UART log; compare against ares expected output; measure fps on hardware + ares (both committed) | committed UART capture (tools/n64/sc64-uart.log) showing D_DoomMain + at least one demo completing; fps committed for both ares and hardware; any ares divergence filed as FINDING; partial filed as partial (no fabrication) | 20.4c | cc:TODO |
| 20.5 | **DECOMPOSED** N64 sub-phase B (the first): RDP-rasterized columns/spans while the playsim stays bit-exact — no demo-exact vanilla port has ever shipped RDP-assisted rendering | (superseded — see 20.5a–20.5b) | 20.4 | cc:分割 |
| 20.5a | **Depends corrected 25.4a: was 20.4d (hardware), now 20.4c.** N64 RDP renderer + ares gate: implement RDP-rasterized column/span rendering alongside existing software path; enable via `WEBDOOM_RDP_RENDER` build flag; playsim untouched — ares 13/13 sim gate must still pass | ares 13/13 sim gate (20.4c script) exits 0 with RDP path enabled (sim hashes unchanged — render path does not affect playsim); own render golden set committed for RDP visual output (not vanilla); engine/core diff vs master = 0 lines (RDP path in tools/n64/ shim only) | 20.4c | cc:TODO |
| 20.5b | N64 RDP hardware speedup measurement: run sub-phase A ROM and sub-phase B ROM on real N64 via SummerCart64; measure fps for both; commit comparison | committed fps comparison (tools/n64/rdp-speedup.md): sub-phase A fps vs sub-phase B fps on hardware (≥1 map/area); speedup % stated; FINDING filed if RDP is slower or within noise; no record claim — the numbers are the deliverable | 20.5a | cc:TODO |
| 20.6 | **DECOMPOSED** 386 test bed: 86Box bench harness (cycle-configurable 386DX-40 profile) + icount-scoreboard reduction campaign toward the 1,142,857 cycles/tic budget; candidates flow from 20.2/20.3 | (superseded — see 20.6a–20.6b) | 20.1b | cc:分割 |
| 20.6a | 86Box harness: configure 86Box with cycle-configurable 386DX-40 profile; automated boot to DOS + DOOM launch + icount capture via 86Box debug port; red-provable | tools/386/run-386box.sh committed; exits 0 on successful DOOM icount run (cycles/tic received + printed); exits non-zero on boot/launch failure; drift-proved: corrupt boot image → FAIL, restore → PASS; 386DX-40 baseline cycles/tic committed | 20.1b | cc:完了 [bed8573] |
| 20.6b | 386 icount scoreboard baseline: run harness over demo1 (and 13 demos if runtime permits); decompose icount per subsystem (bsp/segs/render/playsim/transfer) using 86Box profiling; update atlas row | docs/perf/386-icount-scoreboard.md committed with per-subsystem icount breakdown; atlas row for 386DX-40 updated with measured cycles/tic and headroom to 1,142,857 target; scoreboard is regenerable from tools/386/; verify-all green | 20.6a | cc:決定 [25.5 PURSUABLE] |
| 20.7 | **DECOMPOSED** Sub-100 MHz floor measurement: arithmetic row first (20.1), then bounded attempt on underclocked RP2040-class silicon with WHD-style asset work; deliverable is a NUMBER — the measured minimum clock at which 13/13 demos stay tic-exact — not a promised record | (superseded — see 20.7a–20.7b) | 20.1b | cc:分割 |
| 20.7a | RP2040 bring-up + WHD asset pipeline: bring engine/core up on RP2040 using the freestanding shim pattern (11.1a precedent); prepare reduced-size WAD pipeline (WHD-format headless extract); document underclocking method (pico-sdk frequency define or overclock register) | RP2040 ROM boots to D_DoomMain (rp2040-doom toolchain or pico-sdk); WHD asset pipeline script committed (tools/rp2040/prep-whd.sh or equivalent); underclocking method documented with ≥2 tested clock steps; partial filed as partial (no fabrication) | 20.1b | cc:完了 [1f2efb2] |
| 20.7b | RP2040 floor clock measurement: sweep RP2040 clock downward from 100 MHz in steps; at each step run 13/13 demos tic-exact check (sim hash match); find minimum clock where all 13 pass; update atlas row with measured floor + variance | measured floor clock committed (tools/rp2040/clock-sweep-log.txt); atlas row updated: minimum MHz for 13/13 tic-exact, method, variance (≥3 retests at floor clock); FINDING filed if floor > 100 MHz; no "record" claim — the number is the deliverable | 20.7a | cc:決定 [25.5 PARKED] |

> **These four sections are ROUND 3's planning apparatus, and the tasks they
> rank, sequence and validate — 16.x through 19.x — were archived to
> `docs/Plans-field-fixes-complete.md` when that round closed 22/22 at `1f9f1e5`.
> They are kept as the record of how that round was planned, not as live
> guidance: a reader looking for what is open should read the task tables
> above, where 20.x onward live. (Round 6 flagged them; they were four
> sections of forward-looking prose about work that had already shipped.)**

## Priority matrix (round 3)

- **Required**: 16.1–16.5 (the field bugs — every one hits the spec's stated
  audience on the origin they actually play from), 20.1 (atlas rows before
  any hardware work), 20.2 (user directive: the fresh sweep).
- **Recommended**: 16.6a/b (WAD library), 17.1, 17.2a/b (the legendary music
  options), 18.1→18.4 (widescreen, in order), 19.1 (QoL batch + fullscreen
  button), 19.2 (demo permalinks — highest community reach per effort),
  20.1b, 20.3, 20.4.
- **Optional**: 17.3 (GUS, decision-gated), 19.3 (scrubber), 19.4 (verify
  tool, security DoD mandatory), 19.5 (spectators), 20.5, 20.6, 20.7.
- **Rejected / guardrails**: any public "community service" hosting
  commitment (19.4 stays behind the existing server); headless-audibility
  DoDs (structurally unprovable — recorded twice); playsim-writing QoL
  (freelook AIMING, jumping — Crispy's own forbidden list); regolding the
  320 render goldens for ANY reason in this round; bundling MS GS / Roland
  ROMs / provenance-unclear soundfonts; Sega CD as a win-condition target
  (parked with arithmetic + external anchor); "record" claims as DoDs
  (numbers are DoDs).

## Sequencing spine (round 3)

16.1→16.2 · {16.3,16.4}→16.5 (the CI leg needs both fallbacks) ·
16.3→16.6a→16.6b · 16.4→{17.1,17.2a} · 17.2a+16.6b→17.2b ·
18.1→18.2a→18.2b→18.2c→{18.3,18.4} · 19.2→{19.3,19.4} ·
20.1→20.1b→{20.3..20.7} · 20.2 may start immediately after 20.1 (survey
work), its implementation children only via 20.1b.

## Team validation (round 3)

`team_validation_mode: subagent` — six research/diagnosis agents (persistence
code-diagnosis, music code-diagnosis, music-backend research, sub-spec
feasibility research, widescreen design study, QoL survey) + one adversarial
five-perspective validator (Product / Architecture / Security / QA /
Skeptic), 2026-07-21. Validator verdict: approve-with-amendments; all
amendments applied above (task splits 16.6/17.2/18.2, unprovable headless-
audio DoDs replaced with pump-chain assertions, web_state_hash-based proofs
demoted/extended, 19.4 security DoD, 20.x epics gated behind 20.1b
decomposition, Sega CD parked with external anchor). Reinvention check:
atlas has no N64/Genesis rows (new work); OPL synth already exists in-engine
(17.x builds on it, does not reinvent); interpolation already shipped (not
re-planned). Numbering collision flagged by validator (Electron "Phase 16")
resolved: that was the abandoned side project, deleted this session at the
user's direction; single worktree, no foreign commits, namespace free.

## Spec delta (round 3 — applied 2026-07-21, consumer to approve/amend)

Applied to root `spec.md` this session:
1. **Deployment reality: insecure origins** — new decision record: LAN
   plain-HTTP is the primary player environment; features work there or
   degrade loudly; CI insecure-origin leg mandated.
2. **Music contract** — OPL/GENMIDI zero-asset default; SoundFont GM via
   own-server assets + first-third-party-dep policy; GUS decision-gated;
   never-bundle list; determinism rule restated.
3. **Widescreen view** — sanctioned render-side like freelook; 320 goldens
   never regolded; per-bucket wide goldens; mixed-width netgame sync;
   4:3 status bar; remap off-by-default outside goldens.
4. **Non-goals amended** — retro-hardware test beds sanctioned atlas-first
   (N64, 386, sub-100 MHz MCU); Genesis+Sega CD parked with arithmetic;
   SNES/GBA verdicts unchanged.

---

# Planning round 4 (2026-09-11) — gate integrity

Contract: root `spec.md`, unamended. Opened after an audit found that the gate
CULTURE was sound and the gate MACHINERY was not, and that the top-level runner
could not report which of its legs had run. Full findings and the first honest
baseline in 49 days: `docs/2026-09-11-suite-baseline.md`.

The three that mattered, each verified by reading the code rather than the docs:
the primary sim AND render goldens auto-recorded a missing golden and printed a
full-count PASS; `nat-doom` — the reference for both the differential fuzzer and
the adversarial ASan gate — was 10 engine commits stale and nothing checked;
and `run-tests.sh` never built `build/`, the artifact almost every leg loads.

## Phase 21: gate integrity

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 21.1 | Leg-isolating runner over `tools/gate.sh`: per-leg rc, summary table, tiers (`--quick`/`--only`/`--list`/`--require-complete`) | suite completes past a red and reports every other leg; skips named and counted; 0 legs run is a failure; red-proofed | - | cc:完了 [e4b7d2a] |
| 21.2 | Close the self-regold holes (`demo-test.mjs` sim + render, `sprite-witness-test.mjs`); coverage asserted against MATRIX | absent golden = named FAIL, never a silent re-record; partial WAD set cannot read green; red-proofed against the OLD file | - | cc:完了 [376e5b6] |
| 21.3 | Golden provenance: {tool, commit, dirty, build_dir, wasm_md5, reason} at record time; dirty-tree record refused without `--record-reason`; 80 goldens migrated | all 12 golden-consuming gates green with the new key; re-record byte-identical; red-proofed | 21.2 | cc:完了 [bd7a634] |
| 21.4 | Reference-binary freshness (`nat-doom`, `fs-doom`) asserted and printed by both fuzz gates | gate mode refuses a stale reference by name; provenance printed every run | - | cc:完了 [63a6978] |
| 21.5 | Build freshness: `build/` asserted current before any leg reads it | an uncompiled source edit fails the suite instead of passing it | - | cc:完了 [63a6978] |
| 21.6 | Unknown-flag rejection in `demo-test.mjs`; the orphaned `--low-detail` golden family wired | `--render-low` (which ran the SIM suite and printed a 13-demo PASS) exits 2; no golden family without a runner | - | cc:完了 [2bcfb8c] |
| 21.7 | Port/server ownership: `serve.js` listen-error handler; runner asserts the listening pid is its own child | a squatting server is refused, never tested; red-proofed | 21.1 | cc:完了 [2c929ed] |
| 21.8 | Vacuous-skip closure: `demo-verify-test`, `lint.sh` C half, emsdk pin, `verify-all` skips | no gate prints a pass with zero observations; every skip named and counted | 21.1 | cc:完了 [7c9775c] |
| 21.9 | Claim counts computed from `claims.json`, `_summary` gated | coverage line computed not typed; drift fails the doc gate | - | cc:完了 [98f54ae] |
| 21.10 | browser-pipeline comparator refuses a baseline it cannot compare; wbox single-run baseline archived | 0-of-N comparisons is a FAIL; wbox SKIPs loudly with a reason | 21.1 | cc:完了 [a134fca] |
| 21.11 | Gate census: transitive reachability + an explicit registry with reasons | 0 orphaned; four real gates wired (native ASan, freestanding 13/13, ro-wad, the 19.4 CLI); red-proofed 3 ways | 21.1 | cc:完了 [26a691a] |
| 21.12 | Gate 20.3b/20.3d (no golden family — pixel-identity IS the proof) + `toggle-identity-check.mjs` for the ledger's md5 claims | both toggle paths gated; 8/8 ledger md5 claims verified; red-proofed | 21.2 | cc:完了 [40af544] |

## Phase 22: the baseline

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 22.1 | Full suite run committed as dated evidence, reds filed as findings | summary table committed; every red has a disposition | 21.x | cc:完了 [b80d729] |
| 22.2 | Triage: F1 flake, F2 perf-009, F3 wbox baseline, F4 four-host perf gate | each red fixed, promoted to a task, or recorded with an expiry | 22.1 | cc:完了 [6296f2d, 3bf5c6b] — F1 fixed, F2 closed, F4 closed by the spec fleet amendment; F3 open (no wbox pipeline baseline) |
| 22.3 | Node 26.8.1 compatibility capture | full tier green on v26.8.1 (80/80, 0 skipped); no drift to record; CI matrix 20/24/26 and `engines: >=20` declared | 22.1 | cc:完了 [f8c9add] |

## What round 4 bought, measured

- **71 legs** where there were 32 headings; a red no longer hides the rest.
- The differential fuzzer and the adversarial ASan gate answer for the CURRENT
  engine for the first time since 2026-07-22.
- Four gates that existed and ran nowhere are wired — including the native ASan
  demo suite `README.md` already advertised.
- **The build is byte-reproducible**: `build/doom.wasm` rebuilt from a clean
  tree returns to its documented md5 — measured 2026-09-11 at b80d729, where
  that md5 was `c669142745449ff04bd2fef30fa17412` / 356,775 B — and so does
  `build-sbskip`. The ledger said "proven"; now it is re-provable.
  **The hash itself is not a constant and this line used to read as though it
  were**: be0c271 (25.2) changed `engine/web/web.h`, so the shipping artifact is
  `3edea657b5a54395613fef9cd2dbc539` / 357,101 B today. What is durable is the
  reproducibility, not the digit string. The current value is checked against
  the artifact on every suite run by `tools/toggle-identity-check.mjs`; quoting
  it here would only re-create the drift.

## Open findings (see docs/2026-09-11-suite-baseline.md)

- **F1** CLOSED [6296f2d]. Not a server flake: `onceMsg()` attached its message
  listener one or two microtasks after `open` resolved, so the `welcome` the
  server sends immediately on connect was emitted to no listener and dropped.
  Two hypotheses died on measurement first (slow startup: 54–58 ms vs 600–800 ms
  waits; "the server never sends welcome": it does, and the instrumented probe
  logged `frames: welcome,roster` while the wait timed out). net-fuzz went
  1/8 → 8/8, edge likewise, and the full suite is **71/71, exit 0**.
- **F2** CLOSED. Attributed by experiment before restamping: rebuilding at
  `MAXSCREENWIDTH` 320 gives 4,722,016, within 560 B of the old stamp, so the
  320,960 B growth is the 18.2a widescreen dimension separation, not a
  regression. Restamped with the attribution in `claims.json`; perf-012 and
  perf-059 moved with it; both stampers now read the expected value from the
  manifest instead of carrying a copy. **`verify-all --full`: ALL PASS, 137
  claims, 0 skipped.**
- **F3** wbox has no gating baseline until one is recorded ON wbox (no repo,
  build or WADs there today).
- **F4** CLOSED. It was unrunnable as `spec.md` then wrote it (pi5 down), and
  the decision it asked for was taken the same day: `spec.md`'s 2026-09-11 fleet
  amendment retires pi5 and the tenet now says "the three live reference hosts"
  (commit 3bf5c6b, "closes F4"). This line said OPEN for a day after that, in
  two documents, which is what `tools/archaeology/status-drift-check.mjs` now exists
  to catch. The narrower thing that IS open — the perf gate has no suite leg,
  and `browser-pipeline` has a baseline only for alder — is F3.

## Phase 23: memory safety and hostile input

Every task reproduced the defect against the shipping build BEFORE the fix, per
the round's ground rule. The two directions nobody had fuzzed — hostile server
into the engine, and hostile lump content — are now gates.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 23.1 | Network-controlled array indices: `web_net_bundle` tic, `web_net_setup` slot/numplayers, `web_set_console` | reproducer first; guards in the engine AND net.js; 13/13 sim tic-identity | 22.1 | cc:完了 [7764c94] |
| 23.2 | WAD-driven overreads in the music path: GENMIDI length, MUS event and VLQ bounds | reproduced with an instrumented build; OPL2 output byte-identical; red-proofed | 22.1 | cc:完了 [a1b0420] |
| 23.3 | Non-terminating patch decoder (`doomfont.js`) and the corrupt-WAD server exit (`ui-assets.js`) | both reproduced; loop bounded; server declines instead of dying; red-proofed 5/5 | 22.1 | cc:完了 [a1b0420] |
| 23.4 | Demo buffer bounds: `web_play_demo_buf` takes no length and overscans; the `#demo=` fragment path applies no cap | length parameter, all 6 call sites; a no-length call is rejected; 19.4 gates green | 22.1 | cc:完了 [9c800a2] |
| 23.5 | Unchecked `_malloc` returns (6 JS + 3 C sites) | every site checks; C sites I_Error into the fail-soft path | 22.1 | cc:完了 [9c800a2] |
| 23.6 | Server resource and liveness: the `verifyInFlight` half-open wedge, uncapped spectators, unbounded history bursts | wedge reproduced and red-proofed (two wrong fixes first); 15 s body timeout; MAX_SPECTATORS; backpressure on both history bursts. `attestStore` pruning landed in round 5's A3 (8078cbc: reclaimed by age and by total bytes, red-proofed). A spectate fuzz leg is still the open half | 22.1 | cc:完了 [9c800a2, A3 8078cbc] |  <!-- round 8 X1: the spectate fuzz leg landed -->
| 23.7 | Relay closed on quit and on engine error; `doom.netQuit` wired | socket no longer outlives the engine; net + browser gates green | 22.1 | cc:完了 [see 23.7b] |
| 23.7b | The per-boot leak set: ~11 input listeners, the qol rAF loop + 5 DOM nodes, a duplicate `#settings` panel, a GL program/VBO/2 textures with no dispose. None of input/qol/settings/video exposes a teardown | a single teardown(); play→quit→play×3 leaks nothing, MEASURED not asserted: without it listeners 23→38→53 (+15/cycle), `#settings` 1→2→3 (duplicate ids), `#stage` children 13→19→25; with it 7/0/7 flat. `browser-teardown` leg | 23.7 | cc:完了 [90a7f93] |
| 23.8 | Fuzz the untested direction: hostile SERVER frames at the engine | `tools/hostile-server-test.mjs`, 13 cases, by observation not inference; red-proofed | 23.1 | cc:完了 [7764c94] |

Suite: **74 legs, 74 passed, 0 skipped** (the 74th is `arm-cross`, see the pi5 migration).

## Phase 24: docs, promises, and the CI claim

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 24.1 | `promises-index.md` truth-up (six stale entries, self-contradicting counts) | every entry re-derived; counts computed; `promises-index-check.mjs` gates it | 22.1 | cc:完了 [9140776] |
| 24.2 | Reconcile `claims-index.md` with `claims.json` | 50 overclaiming rows re-statused; 11 unlisted manifest ids added; the bad reproducer path fixed; a manifest self-contradiction (size-004 vs readme-001) found and closed; totals computed; `claims-index-check.mjs` gates all six invariants, red-proofed | 21.9 | cc:完了 [5be60ba] |
| 24.3 | Make CI real, or stop claiming it | `.github/workflows/ci.yml` runs `--quick` on node 20/24/26 and states what it did not cover; README/engine-archaeology corrected; `lint` split so a runner without the pinned clang-format reports a counted SKIP. **ACTUALLY RUN 2026-09-12** and it was red twice before green: `sw-precache` required a build from inside the no-build tier, and `verify-all` linked `-lm` before the source so two verifier families (7 claims) had never compiled on a `--as-needed` distro. Both fixed and red-proofed; the workflow now prints the kept leg logs, because the first red named two failures and showed neither | 21.1, 21.8 | cc:完了 [642e2c0, 60ee890, fabe5f9, 5dd4926] |
| 24.4 | Stale-doc sweep (n64 BRING-UP, renderer §13, bare-metal banner, ledger bsp figure) | five documents corrected or banner-dated | 22.1 | cc:完了 [af663bd] |
| 24.5 | Document the shipped render toggles in renderer.md / perf.md | five variants documented, each with its golden family and gate | 21.12 | cc:完了 [2b10f3e] |

## Phase 25: dead code, the contract, and Phase 20

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 25.1 | The GM SoundFont backend could not activate under any configuration | operator path wired (`WEBDOOM_SPESSASYNTH_URL` → `/api/config` → `arm()`), gated by `tools/gm-config-test.mjs`, decision-17.2a amended | 22.1 | cc:完了 [f549213] |
| 25.2 | `web.h` becomes the contract it is designated to be (5 of ~45 exports, wrong arity, 4 forked copies) | arity fixed, memory-safety surface declared with bounds contracts, `web-contract-check.mjs` gates definition-vs-declaration (73 exports, all 6 pointer-taking ones in the contract) | 23.x | cc:完了 [be0c271] |
| 25.3 | Duplication cleanup (`paniniStrength`, the two ring-buffer worklets, attachRelay/attachSpectate) | `paniniStrength` → `wide-utils.js`; `makeBundlePump` shared by relay+spectate (net.js 250→223); dead `gm-worklet.js` deleted and its decision record corrected | 25.1 | cc:完了 [850976d, f2f88db] |
| 25.4 | Fix Phase 20's dependency defect (20.5a gated on hardware) and close 20.4c | 25.4a: 20.5a re-pointed at 20.4c. 25.4b: the blocker was NOT that `-timedemo` fails to engage — it was never passed (`COMMON_FLAGS +=` after `CORE_CFLAGS :=`), so every "timedemo ROM" was an attract-loop ROM. Fixed + `$(error)` on the value in force; `-nodraw` added for argv symmetry with the golden; trace extraction moved off the GDB stub to a printed block; stale-object IWAD-identity bug found and guarded. 13/13, 44,580 tics | 22.1 | cc:完了 [25.4a 7ed98b9, 25.4b e03a93b] |
| 25.5 | Decide 20.6b and 20.7b explicitly | verdicts written below: 20.7b PARKED on arithmetic, 20.6b PURSUABLE with a named plan | 22.1 | cc:完了 [7ed98b9] |

Suite: **77 legs, 77 passed, 0 skipped**.

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

# Planning round 5 (2026-09-12) — the gates that pass while the thing they name is broken

Contract: root `spec.md`, unamended. Opened after a polish audit found that
round 4 had repaired the gates that *could not fail*, and that a second class
remained: gates that pass while the thing they are named for is broken.

Three shipped fixes did not run. Two shipped verifier CLIs printed a green
verdict over zero observations. One document contradicted itself four times
inside the file its own checker reads, and passed 8/8. None of it was
sloppiness — every one sits exactly one level out from a control this project
already built and red-proofed.

## Phase A: fixes that shipped and never ran

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| A1 | 23.7b's GL `dispose()` landed in `createRenderer2D`, whose scope has no `gl`/`prog`/`quad`/`_textures` — so the WebGL2 path had no dispose at all and the canvas2d path threw into its own catch | moved; `browser-teardown` counts GL objects (its header named them and measured only DOM); pre-fix tree reads net 6→12→18 per boot, post-fix 18 created / net 0 | cc:完了 |
| A2 | `onDoomError` and the rAF catch restored `#landing` but never called the caller's `onQuit`, so the menu inside it stayed empty — an `I_Error` stranded the player on a blank page | one `endSession()` owns every exit; `browser-ierror` asserts a menu row using the selector already in the file; pre-fix reads 0 rows | cc:完了 |
| A3 | `deleteAttestation` exported, documented "called when demo is evicted", called from nowhere — every evicted or expired demo orphaned up to 800 KB, unbounded, invisible to `storeStats` (which had no caller) | all three deletion sites wired; quota + byte accounting + `Uint32Array`; `GET /api/demos/stats`; `demo-store-fuzz` drives eviction and expiry against a real server; red-proof 3 failures | cc:完了 |

## Phase C: gates that could pass without checking

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| C1 | The suite added up what ran and never compared it to the registry; 18 browser legs skipped as ONE row, so a Chrome-less host printed "64 legs … 1 skipped" against a registry of 81 | per-leg named SKIPs via a `shared` prerequisite; coverage assertion vs the tier registry; red-proofed. Also: `serve_start`'s readiness curl had no `--max-time` and hung the suite on a squatter | cc:完了 |
| C2 | `demo-verify.mjs` (the shipped 19.4 CLI) printed "PASS — all 0 golden demos VERIFIED"; `freestanding/run-check.sh` printed `$PASSES/$PASSES`; `native-sanitize/run-all.sh` printed a bare "all demos passed" over 13 skips, with `|| echo "ok"` standing in for an observation | each takes its denominator from its own matrix, reports INCOMPLETE with the missing WADs named, exits 2; ro-wad stops sharing freestanding-sim's headline | cc:完了 |
| C3 | `artifact-freshness` registered 3 artifacts; the six variant trees were unregistered, and `render-*` legs needed only `wad` while `build-*` needed `emsdk` — so a stale tree could print a full-count PASS | all six registered; 7 legs take a `fresh-<variant>` prerequisite; red-proofed. **Found `build-perf` stale on its first run** — the tree `verify-all --full`'s 15 runtime-stat claims come from | cc:完了 |
| C4 | Six legs whose summary row said nothing or the wrong thing — `browser-demo`'s green row was a Chrome deprecation warning; `lint`'s was its own nested sub-check | every one quotes what it observed; `browser-qol`/`browser-wide` hold their stages to a list; `browser-demo` gains a floor | cc:完了 |
| C5 | 21 legs launched Chrome and disagreed: `CHROME_BIN` honoured by 6, profile isolation by 6, cleanup by 7, and SEVEN duplicated ports | `chrome-harness.mjs` (bin, profile, group-reaping); all ports distinct; `check-cdp-ports.mjs` in lint. **That check's first version passed by not looking** — its name pattern required a character before "PORT" | cc:完了 |

## Phase B: the trust boundaries

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| B1 | `manifest()` was a bare `readFileSync` in the request handler and `/api/ui-assets` parsed it unguarded, with no `uncaughtException` anywhere in `server/` — so a missing or malformed `wads/manifest.json` ENDED THE PROCESS | measured: 3 of 4 states kill the shipped server (`process exited=true`). Cached against mtime, both parses guarded, stream `'error'` handler, `send()` refuses a second write, last-resort handlers that still exit before `listen`. http-fuzz grows a hostile-data-directory section against a temp tree; red-proof 3 failures | cc:完了 |
| B2 | `server/game.js` parses client frames in a `try`; `client/js/net.js` did a bare `JSON.parse` on server frames. And `ping()` had no timeout, so lobby.js's 12-ping loop before `bootDoom` could hang FOREVER under a "GO" countdown | measured: 14 assertions fail against the shipped client — 2 unhandled throws, 6 hostile slots accepted into `api.slot`, a non-string colour, the ping wedge at 5,025 ms and counting, send-after-close. `tools/hostile-lobby-test.mjs`, one connection per case | cc:完了 |
| B3 | No CSP, no `X-Content-Type-Options`, no `Referrer-Policy`; one inline `onclick` that a CSP would silently break | headers on both response paths, asserted in http-fuzz (27 cases); the inline handler moved into `lobby.js`; `<noscript>`, description and theme-color added. **All 20 browser legs green under the policy** | cc:完了 |

## Phase E: the launcher

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| E1 | `hacx.wad` in `GAME_ORDER`, absent from the manifest and refused by the importer — a menu row with no destination, and README advertised it as shipped. `promises-index` flagged rme-008 as a coverage gap; it was a truth gap | removed; README and rme-008 corrected; `tools/check-menu-reachable.mjs` gates `GAME_ORDER ⊆ manifest ∪ importable`, in two parts because only one is answerable on a clone | cc:完了 |

## Phase D: documents that contradict the record

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| D1 | The ledger stated the toggle-off md5 eight times — four table rows current, four prose lines stale — and `toggle-identity-check` passed 8/8 because its regex saw only the table form. `Plans.md` and the baseline cite the stale hash as the byte-reproducibility proof | history marked "at landing (<commit>)"; the checker fails on any md5 that is neither checked nor historical, judged per-hash not per-line; red-proofed | cc:完了 |
| D2 | Nothing verified a sentence of the form "X is still open" against the project's own record of X — four live contradictions, two of them written BY doc-hygiene tasks | `status-drift-check.mjs`; all four corrected; archives exempt whole-file and listed by name | cc:完了 |
| D3 | Counts typed rather than computed, inside the two documents whose job is inventory. `promises-index-check` matched rows by `cells.length === 6` and silently dropped all ten Part C rows | every count computed; the checker sees all four Parts (A=10 B=8 C=10 D=16); `claims-summary.mjs` made importable so there is one definition of the tier split | cc:完了 |
| D5 | 26 documents, README linked 8 | `docs/README.md`; `docs-index-check.mjs` gates both directions | cc:完了 |

## What this round did NOT do

Named so the next pass does not have to rediscover the scope:

- **E2/E3 (settings robustness, accessibility)** — localStorage is unvalidated
  user input; a newly-added keybind renders as "undefined"; "Reset defaults"
  desynchronises the live overlays; rebinding has no cancel and `Escape` is
  bindable. The complete ARIA inventory across `client/` is seven lines.
- **F: the perf gate has no leg at all.** `spec.md:55-57` makes it a required
  gate; neither `bench.mjs` nor `fleet-bench.sh` appears in `run-tests.sh`, and
  `gate-census`'s name heuristic cannot see either. `browser-pipeline` gates one
  host — alder, of which spec.md's own table says "fast here proves nothing".
  This is the largest spec-vs-reality gap in the repo.

# Planning round 6 (2026-09-12) — the other half: the program itself

Round 5 was a gate-integrity round: it worked on `tools/`, CI, the ledger
counts, and three server fixes. Re-verified against `9f2bfce`, **all 32
client/server findings from the original audit were still present**. This
round is the other half, plus the gate and document holes round 5 did not
reach.

Three scope decisions, taken with the user before any work:

- **The perf gate gets an opt-in tier and an honest SKIP**, not a full-tier
  leg — it is runnable today, and it is ~26 s, but it needs wbox and tank up.
- **Restructuring is limited to `lobby.js`'s reset paths**, the one structure
  that had already caused a real bug. `bootDoom()` and `serve.js`'s request
  handler got local fixes only.
- **No campaign work.** 20.4d / 20.5a / 20.6b stay the tail.

Baseline at the end of the round: **89 legs, 88 passed, 0 failed, 1 skipped**
(`perf-fleet`, by design, with its reason named and counted); 19.4 min of leg
time with the N64 toolchain sourced. `--perf --only perf-fleet`: **9
comparisons across 3 hosts, none beyond 20%**.

## Phase K: gate holes round 5 did not reach

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| K1–K5, K9 | A claim whose family never ran returned PASS (31 fast claims took that path in CI); `size-ledger` omitted from `fullFamilies`; a skip line that overwrote its own predecessor; `gzip \| wc -c` under `/bin/sh` returning **0 as a measurement**; two fuzz verdicts quoting their CLI argument; lint scope narrow by accident | `--require-script-values`; 136 families; the pipe removed (byte-identical, 147,308 / 3,762); verdicts quote the result arrays; empty corpus is FAIL; lint sees `tools/archaeology/*.mjs` (93→112 files) and ratchets the C scope | cc:完了 |
| K6, K7 | `assert_port_owned` returned 0 with a printed "note" nothing counted; two readiness polls proceeded regardless; `$SUMMARY` died with the `mktemp -d` the EXIT trap deletes | notes counted; both polls fail closed; `tools/.suite-logs/last-run.tsv` persists the per-leg table | cc:完了 |
| K8 | The census could not see `bench.mjs` or `fleet-bench.sh`, so it could never report the spec's perf gate as orphaned; `refsIn()` missed the `$SCRIPT_DIR/` sibling form | `GATEISH` gains `bench`; sibling form matched; `be-check.sh` removed from the out-of-suite registry | cc:完了 |

## Phase L: the perf gate spec.md has required since it was written

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| L1–L3 | `spec.md:55-59` makes the fleet perf gate mandatory and no leg existed | `--perf` tier + `perf-fleet`; `fleet-bench.sh --check` (does NOT write the baseline); tolerance 20% **on evidence** — guessed 20%, measured ±3.7%, tried 10%, went intermittently red on tank, settled back with the rejection recorded. Proven twice: SKIP with its reason in the default tier, 9 comparisons under `--perf` | cc:完了 |

## Phase G: resource lifetime

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| G1, G2 | `menu.js`'s 250 ms blink ran a `querySelector` through every frame of GAMEPLAY; `countdown.dismiss()`'s 2.5 s background-tab safety net could not be cancelled by `reset()` | blink follows visibility; the timeout is held and cancelled. `browser-teardown` gains **live timers** and **wasm instances**, plus a DURING-PLAY reading — the growth check cannot see a timer created once and never stopped | cc:完了 |
| G6, G7 | `session.history` had no ceiling — measured **266 bytes retained per 38-byte bundle**, 7× the figure `netcode.md` quotes, ~34 MB/hour; `uiAssets()` cached forever, so an operator adding a WAD needed a restart | capped at `WEBDOOM_MAX_HISTORY_TICS` with drop-in and spectate REFUSING past it (a prefix desyncs silently); ui-assets keyed per file. Both gated with control arms | cc:完了 |
| G3, G4, G5 | **NOT defects, measured not assumed.** `lobby.js` IS the page; `fire.destroy` has no caller anywhere; the wasm instance IS released — 3 built across 3 boots, 1 reachable after a full GC | recorded in the commit and in the gate's own output | cc:決定 |

## Phase H: inputs that were still not validated

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| H1–H4 | localStorage is user input and `loadSettings` validated none of it; `binds` replaced wholesale rendered "undefined" on a button with no way back; Reset defaults called no appliers; rebinding took Escape as a binding, had no timeout and no conflict handling | a SCHEMA with per-key type/range/enum; per-action bind merge; `applyAll()`; Escape cancels, 8 s timeout, conflicts swap. New leg **`browser-settings`**, red-proofed at 12 failures. Closes the rebind half of `rme-004` | cc:完了 |
| H5, H6 | `stackFor()` returns `[]` for an unknown WAD and `bootDoom` read `wads[0].file`; the server never checked `params.wad` against its own library and cast it to every client | server refuses a name it does not serve (default refuses ALL changes); client refuses with a stated reason. Red-proof: `nope.wad`, `....etcpasswd`, `.` and `..` reaching every client | cc:完了 |
| H7–H9 | `/api/ui-assets` 404s with plain text when there is no IWAD and `.json()`'s SyntaxError was reported as "cannot reach server"; `(sel + n - 1) % n` is NaN on an empty screen, reachable through `mapPick()`; `addAll` is all-or-nothing and one 404 disabled offline mode silently | `res.ok` + a named reason; NaN guarded with Escape/Backspace handled first; per-file precache via `allSettled`. Three new `browser-resilience` subtests | cc:完了 |
| H10 | The file registry no-op'd silently at `MAXWEBFILES`, so `W_WebFile` re-malloc'd the same file on every lookup | returns 1/0, `W_WebFile` frees and returns NULL, `web.h` says so. New leg `web-registry`: capacity, refusal, **and that the refusal is stable across retries** — the leak was a repeat. `web_seek_demo`'s unclamped `targetTic` is an EXISTING documented contract; `web_demo_stop`'s marker write was never reachable past `demoend - 16`. The real ceiling — 15.6 min of recording ends the session — is now in `formats.md` | cc:完了 |

## Phase J: delete, then de-duplicate

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| J1, J2 | Zero-caller exports; `.drop-hover` toggled since WAD import shipped with NO CSS rule, so drag-and-drop had zero visual feedback | six deletions; `setDmxgus`/`musToMidi` KEPT and labelled as the seam `decision-17.3` names, with `spec.md` amended to "GREEN-LIT AS A DESIGN; NOT WIRED". **The deletion found a defect**: the dead `canvas.truncated` flag, made loud, showed the decoder calling 24 of doom.wad's 63 STCFN glyphs malformed — an off-by-one on a one-byte terminator | cc:完了 |
| J3 | Four IndexedDB open dances, six `#status` idioms, three teardown ledgers | `client/js/idb.js` (adds the `onblocked` rejection none of the four had) and `client/js/ui.js`; both precached | cc:完了 |
| J4, J5 | `try { ws.terminate(); } catch {}` fifteen times, only eight with the `'error'` listener whose absence ENDS THE PROCESS; five constants written twice across the wire | `refuse()`, `capped()`, `burstHistory()`, `cleanName()`; new leg `wire-constants`. The helper was wrong twice first — not idempotent under a flood, and `log` out of scope at one site — both caught by the existing gate | cc:完了 |
| J6 | `EXPORTED_FUNCTIONS` named 64 symbols against 72 KEEPALIVE exports | **measured**: full list vs `_main,_malloc,_free` is byte-identical (`b1640770…`/`592ee0ba…`), so 61 were inert. Reduced, with the measurement recorded above LDFLAGS | cc:完了 |
| J7 | Seven partly-overlapping reset-on-failure paths in `lobby.js` — the one approved refactor | one `resetToLauncher(reason)`; every step idempotent; `lobby` nulled BEFORE close() for all callers, which only `leaveLobby` used to do | cc:完了 |

## Phase I: the launcher was unusable without a mouse

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| I1 | The settings panel was a bare `<div>`: no role, no modality, no label, no focus handling, Escape did not close it — and only the POINTERLOCK handler consulted it, so game keys reached the ENGINE behind it | a real dialog with focus move/restore and a Tab trap; `input.js` blocks game keys while it is open. Gated by counting engine input events: **0 while open, 6 while closed** | cc:完了 |
| I2 | Seven ARIA lines in the whole client; zero `:focus` rules; `#status:empty { display: none }` took the live region out of the accessibility tree; `#qol-fullscreen` was an invisible tab stop | `role=status`/`aria-live`, `role=progressbar` with a moving `aria-valuenow`, a real `role=menu` with roving tabindex, `:focus-visible`, the scrubber strip marked decorative | cc:完了 |
| I3 | The launcher's own startup showed nothing; WAD fetch was serial; a compressed response reported 0% for its whole duration | `loading` moved to `ui.js` and shown during launcher boot; parallel fetch behind one aggregate bar; **indeterminate** instead of a false 0% | cc:完了 |
| I4 | `prefers-reduced-motion` was half-kept and wholly ungated | the stylesheet's first `@media` block; `browser-fire` arm (f) under `--force-prefers-reduced-motion`, asserting the query reads true and the frame is static AND non-blank. **Closes `spc-003`** | cc:完了 |

## Phase M and N: documents, and the front door

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| M2–M4, M6 | `decision-18.1` §9 listed four open handoff items with three long closed; the ledger's Totals line had two of four figures wrong; a closed FINDING-4 residual; `[this commit]` ×4; undefined `cc:`/`tdd:skip:` vocabularies | each verified against the code, not the prose; hashes resolved; a marker legend written | cc:完了 |
| M5, M7 | Published leg counts (README 81, ci.yml 81, "19 browser legs") were stale against 89 and 21; the ledger totals were typed; a decision record could contradict its own addendum | `promises-index` rule 6 (anchored to the whole-registry phrasings, so ci.yml's true "12 legs run" does not trip it); `status-drift` rules 3 and 4 | cc:完了 |
| N1, N2 | `spec.md` never said what the product IS — spectators, permalinks, the scrubber, the CLI, WAD import, persistence, five render variants, the N64 leg, CI, the gate machinery and teardown all ship and were unmentioned. Edge and the insecure-origin leg had been re-flagged for months | a "What ships" table, 18 rows, gated by `promises-index` rule 7 (52 gate names resolve); Edge settled as a CHROMIUM promise, untested by policy; the insecure-origin clause corrected — CI *cannot* run it, and says so itself | cc:完了 |
| N3 | No CONTRIBUTING, no SECURITY, no issue template, an unreferenced screenshot, 486 lines of closed task tables at the repo root | all four written; archives moved to `docs/` and indexed; the merged `round4-gate-integrity` branch deleted; the GitHub description's drifting size figure removed rather than corrected — a number in a repo setting is outside every gate | cc:完了 |

## What this round did NOT do

- **20.4d / 20.5a / 20.6b** — the campaign tail, deliberately untouched.
- **`bootDoom()` (294 lines) and `serve.js`'s request handler (204 lines)** —
  local fixes only, by decision. Both are still long.
- **The analog twin-stick gamepad path** (`rme-004`) — a headless runner has no
  stick, and a synthetic `Gamepad` would gate the shim rather than the path.
- **Firefox asserts no rendered frame** (`rme-002`) — unchanged, and stated.
- **`perf.md`'s claim locators were already ~23 lines stale** before this round
  shifted them by +17; the ±35-line window absorbs it. Pre-existing, recorded,
  not fixed.
- **`tools/lint.sh` cannot see inside `python3 - <<'PY'` heredocs**;
  `fleet-bench.sh` has a 206-line one.

# Planning round 7 (2026-09-12) — strip it to single player, deathmatch and WADs

The owner's brief: cut the features that are not core DOOM, and get rid of the
F8 settings overlay by folding its settings into the main menu. Three menu
systems met the player — the launcher's DOOM-idiom menu, the engine's own `M_*`
menu, and an F8 HTML dialog belonging to neither and the only way to reach any
web-side setting. Widescreen and the Panini remap were opt-in render modes the
owner did not use and did not like the look of.

Five scope decisions, taken with the owner before any work:

- **The settings go on the LAUNCHER menu**, not into `m_menu.c`. Mid-game
  changes are given up deliberately; Escape still reaches DOOM's own menu for
  volume, detail and screen size.
- **Widescreen comes out of the C engine too**, not just the UI.
- **The four QoL DOM overlays go.** The GM SoundFont backend, OPL3, the
  launcher fire, the countdown, spectators, drop-in, WAD import, the demo
  record/share/scrubber, the retro side-quest dirs and the four compile-time
  render variants all **stay**.
- **The GM fallback banner moves to the OPTIONS row** rather than the backend
  being deleted.
- **The demo attestation endpoint goes** — a CLI workflow wired into the live
  multiplayer server with no product caller.

Baseline at the end of the round: **83 legs** (was 89), **19 browser** (was 21).

## Phase P: the OPTIONS screen

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| P1 | The F8 overlay (`client/js/settings.js`, 265 lines) was the only way to reach any web-side setting, and it belonged to neither menu | deleted; OPTIONS + CONTROLS screens on the launcher, built from `optionsPick()`'s existing shape. `padDeadzone` gains a control — it was in the schema with none, reachable only by hand-editing localStorage while the comment above `SCHEMA` claimed the bounds "match the panel's own controls" | cc:完了 |
| P2 | Rebinding lived inside `createInput()`'s keydown closure, which needs a `doom` and a canvas — neither exists on the launcher | `captureBind(settings, actionId, onDone)` extracted; `createInput` LOSES `capture`, `captureTimer`, `startCapture`, `cancelCapture`, `capturing()` and the `panelOpen()` check. The in-game input path got smaller | cc:完了 |
| P3 | `menu.js` had no key-capture affordance, and two defects were waiting in adding one | `capture` item type. **Armed on keyup**: a HELD Enter binds Enter otherwise — measured, `AUTOMAP: ENTER`. A single tap cannot show it (a listener added during dispatch does not receive that event), so the gate presses and holds. **Capture-phase + `stopPropagation`**: otherwise the menu's own bubble listener still moves the cursor. Both red-proofed | cc:完了 |
| P5 | 9 rows tripped `menu.js`'s multi-column wrap (meant for Doom II's 32 maps), CONTROLS' 12 rows then ran off the bottom behind a scrollbar, and the OPTIONS header ran off both edges | `nowrap` screen flag; row height follows the chosen scale through `--rowh`/`--skullw` instead of a hard 60 px; the header is fitted to width like everything else. Found by looking at the screen, which is the only instrument for this | cc:完了 |
| P4 | `browser-settings` (28 assertions) drove a dialog that no longer exists | `browser-options`, **34 assertions**, every old one mapped or replaced. The one that could not port — "0 engine key events while the dialog is open" — became structural (no wasm instance exists on the launcher) plus its real successor: the key bound on OPTIONS is pressed in a running level and the engine must receive `DK.UP`. That assertion first read 0 because `web_ui_mode()` passes printable keys through as characters at the title screen — it drives into a level now | cc:完了 |

## Phase Q: widescreen and Panini, engine included

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| Q1 | Panini: a fragment-shader remap, off by default, outside every golden | deleted from `video.js`, `main.js`, `input.js`; `wide-utils.js` deleted | cc:完了 |
| Q2 | Widescreen was projection surgery across eight core files: `centerxfrac_nonwide`, `anchor_offset`, `ST_FillFlatFlanks`, `WIDESCREENDELTA` on every HUD widget, a runtime `screenwidth`, and `MAXSCREENWIDTH` 854 sizing every per-column static array | reverted in four layers, goldens checked at each. **All six families byte- or pixel-identical, 13 demos, no regold**: `sim-goldens`, `render-goldens`, `render-low`, `render-fakeflat`, `render-potato`, `render-sbskip`, `render-diffblit`. `renderer.resize()` lost its last caller and went too | cc:完了 |
| Q3 | The revert needed a reference that was not self-consistency | `claims.json` `perf-009` had recorded **4,722,016 B** as the measured `__heap_base` for a rebuild at 320. The revert landed **4,722,048** — 32 B — so what came out was widescreen and nothing else. `doom.wasm` 357,060 → 355,893 B, README 349 → 348 KB | cc:完了 |
| Q4 | `sprite-witness` pinned the vanilla cull `abs(tx) > (tz<<2)` and its own header said only the 854 arm could see a tightened cull | **tested before deleting**: with the cull at `tz<<1`, **10 of 13 render goldens fail at 320**, first divergence plutonia-demo3 tic 169. The pin was redundant, not load-bearing. Leg, tool and both witness goldens deleted, with the experiment recorded | cc:完了 |
| Q5 | Six legs, 14 goldens and five typed counts to retire | `render-wide`, `sim-wide`, `browser-wide`, `mixed-width-net`, `sprite-witness`, `browser-qol` gone; `--render-wide`/`--sim-wide` removed from `demo-test.mjs`'s **allowed-flag list** as well as its mode table, so a stale invocation fails (rc=2) instead of silently running the sim suite; `bench.mjs --wide`, `tools/wide-experiment/`, and the `-DMAXSCREENWIDTH=320` flags the n64 and rp2040 Makefiles were already passing | cc:完了 |

## Phase R: deletions

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| R1 | The four QoL DOM overlays (`qol.js`, 215 lines) — crosshair, level stats, demo timer, hover fullscreen button, all off by default | deleted with their CSS, their leg, their four settings keys and the orphaned `web_level_state` export. The `prefers-reduced-motion` block kept `#loading-fill` rather than being emptied, which would have dropped the CSS half of `spc-003` | cc:完了 |
| R2 | `web-contract` could not catch R1: `if (!def) continue` skips a declaration it cannot pair, so deleting a function and leaving its `web.h` declaration passes silently | rule 3 — every declaration must resolve to a definition under `engine/`. Red-proofed in one line. 12 of the 21 declarations are ordinary C functions, which is why the skip existed | cc:完了 |
| R3 | `POST/GET /api/demos/:id/verify` and the attestation store (~190 lines) had no caller in `client/` at all | deleted from `serve.js` and `demo-store.js` (220 → 120 lines). `demo-store-fuzz` 43 → 27 checks; the old test reds at rc=1 against the stripped server. Its eviction/TTL half was KEPT — nothing else in the suite drives either, and deleting the section wholesale because its headline feature went would have taken that with it | cc:完了 |

## Phase S: the reports, and two defects found on the way

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| S1 | The GM fallback banner: `audio.js` called `setStatus('music: OPL fallback (GM soundfont unavailable)')` for an ordinary configured state, and `#status` has no timeout — so it sat over the game for the whole session, every session | the reason renders on the OPTIONS MUSIC row (`GM - NO SF2` / `GM - NO SYNTH URL`); the banner is kept only for the genuine failure, SpessaSynth fetched and thrown. `browser-sf2` gate 5 asserted the banner was PRESENT behind a `console.warn` escape hatch that could not fail; it asserts its ABSENCE now, red-proofed | cc:完了 |
| S2 | **Found while re-shooting the README image**: every first-time visitor was told "New version available — reload". `sw.js` calls `skipWaiting()` + `clients.claim()`, so a brand-new worker claims the already-loaded page and fires `controllerchange` — which the banner read as an update. It has no old version | the banner tests whether a controller existed BEFORE registration. Proven by effect: same harness, same fresh profile, banner present before and absent after | cc:完了 |
| S2b | `browser-teardown` counted `#settings` panels — a selector that can no longer match, so it read "ok  #settings panels: 0" while measuring nothing | the counter removed rather than left green; headline re-derived, 6 dimensions → 5 | cc:完了 |
| S3 | Bookkeeping: six gates fail without it | leg counts in README ×2 and ci.yml ×2; `spec.md` "What ships" rows; the widescreen decision record rewritten as a reversal; `decision-18.1` archived (its §5 arithmetic is what Q3 was checked against, and `status-drift` rule 4's only handoff claim lives in it); `rdr-004` 54,656 → 20,480 in five places; `perf-009`/`perf-059`/`readme-001`/`size-004` restamped; five ledger md5s; `docs/state-machine.md` 25 → 29 edges; `sw.js` SHELL v13 → v14 | cc:完了 |
| S4 | `spec.md`'s "render-side, opt-in" row was about to become an unbacked promise: `sim-wide` was the only leg proving a render option cannot reach the playsim, and freelook and interpolation are the survivors of that class | FLAGGED as `spc-011` with what would close it, rather than left reading as gated. `demo-test.mjs` pins `_web_set_smooth(0)` before every run, so the golden families are blind to both | cc:決定 |

## What this round did NOT do

- **A `sim-smooth` leg.** Recommended by the architecture pass and not taken:
  it is new gate work, not a deletion, and it was outside the approved scope.
  `spc-011` records the gap and the shape of the fix.
- **The mouse-sensitivity compounding.** `settings.mouseSens` scales mouse
  deltas and vanilla `mouseSensitivity` (`g_game.c:579-580`) scales the same
  events again, neutral at its default of 5, and both stay user-reachable. The
  OPTIONS screen carries a header line naming DOOM's own menu; `g_game.c` was
  NOT touched — it is vanilla and on the ticcmd path.
- **`perf-009` has no default-tier gate, and had silently drifted 48 B**
  (5,042,416 stamped against 5,042,464 measured) before this round moved it on
  purpose. `wasm-stamp` is `--full` only and no suite leg runs `--full`. Found,
  restamped, not closed.
- **`docs/perf.md`'s PWAD combo table had three rows already reading 4.50 MB**
  while `__heap_base` was 4.81 — stale, and the revert made them correct by
  accident. Only the first row is gated (`perf-059`), which is why only the
  first row was caught.
- The campaign tail (**20.4d / 20.5a / 20.6b**), the analog twin-stick path
  (`rme-004`) and Firefox's no-rendered-frame limit (`rme-002`) are unchanged.

---

# Planning round 8 (2026-09-12) — the gates that were never armed

The brief: close the round-7 tail. Three things set the scope, and the third was
found while planning.

- **`spc-011` was the only ungated row in the contract.** `spec.md`'s "What
  ships" table has 18 rows; seventeen named a leg and "Freelook and frame
  interpolation — render-side, opt-in" read `**ungated**`. `sim-wide` was the
  leg that proved a render-side option cannot reach the playsim, and it was
  deleted with widescreen in round 7.
- **`perf-009` has no default-tier gate.** `wasm-stamp.mjs` runs only from
  `verify-all.sh` under `--full`, and the `doc-drift` leg calls it with no
  arguments, so no suite leg has ever executed it.
- **The vacuity turned out to be a CLASS, not a case.** The blindness is
  `-nodraw`, not `_web_set_smooth(0)`: `d_main.c:234` returns from `D_Display`
  before any drawer runs, so the sim family never executed `R_SetupFrame`,
  `R_ShearView`, `R_InterpolateSectors`, `ST_Drawer` or `I_FinishUpdate`.

## Phase T: the render-path invariance gates

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| T1 | Whether `sim-sbskip`/`sim-diffblit` verify anything was a PREDICTION. Decided by measurement, not by reading | `prndindex++` poisoned into each toggle's guarded block (`web_state_hash` hashes `prndindex`, so one execution desyncs). **CONFIRMED for both.** The poisoned binaries printed `PASS — all demos bit-identical to golden (13 demos)`, rc=0, under today's `-nodraw` leg, while the SAME binaries failed the render gate 13/13 (first divergence plutonia-demo2 tic 51 / tic 49). Poison-compiled-in proved by md5 against the clean toggle build. Both legs have verified nothing since 20.3b/20.3d landed 2026-07-18/19 | cc:完了 [tdd:skip:experiment-produces-a-finding] |
| T2 | `spc-011`: the 13 demos had never run with freelook or interpolation active | `--sim-drawn` family in `demo-test.mjs`: no `-nodraw`, per-tic `web_state_hash()` compared byte-exact against the EXISTING sim goldens; records nothing and owns no goldens. **ONE PASS PER MODIFIER** — the first cut ran one combined pass, reported "1710/1710 frames changed" and looked excellent, but `--smooth` alone changed **0 of 1710**: an active pitch was vouching for an inert smooth. Five assertions: A1 sim-exact on every pass, A2 control pass, A3 control framebuffer == `-render.json` (instrument), A4 per-modifier inequality at the CONSUMPTION SITE (vacuity), A5 `web_perf_frames() >= tics/2` (the path ran). No new shipping export: `web_perf_frames()` already exists and is incremented at `r_main.c:1038` inside `R_RenderPlayerView` | cc:完了 |
| T2b | **Frame interpolation is INERT under `-timedemo` and no leg could have caught it.** That path sets `singletics`, whose branch never calls `run_tic()`, and `run_tic()` is the only writer of `web_lastticms` — so `I_GetTimeFrac()` measures against a stale timestamp, clamps at `f > 1.0`, and `fractic` saturates at FRACUNIT, bit-identical to smooth off | `--fractic N` pins the fraction, via `doom_fractic_override` **entirely inside `#ifdef WEBDOOM_INVARIANTS`**: a new global in the shipping build would move `__heap_base` and turn `perf-009` red. `build/doom.wasm` byte-identical across the change, md5 `a1109b9c2ad9c04374767cce8dd51712`, 355,893 B, proved by rebuild. `--smooth` without `--fractic` is rc=2, and `--fractic` on a build without the export is a hard FAIL, never a skip | cc:完了 |
| T3 | Four legs re-pointed onto the family; one added | NEW `sim-freelook` (shipping artifact, `--pitch 40`). Re-pointed: `sim-invariants` (**the only leg on the armed build, and it was `-nodraw`** — so `DOOM_ASSERT(doom_in_render_path == 0)`, the assert written to catch render→sim contamination, had never run in a process where the renderer executes), `sim-sbskip`, `sim-diffblit`. Re-pointed, not deleted: the old form did serve the weaker claim that the toggle build's codegen still reproduces the goldens. **Red-proof is T1's arm (c)**: the same poisoned binaries that passed the old leg now FAIL at tic 1 and tic 0. Registry 83 → 84 legs | cc:完了 |
| T4 | The contract row and the promise | `spec.md` row 8 cites `sim-freelook`, `sim-invariants` (rule 7 validates the tokens, so the legs landed first). `promises-index` spc-011 FLAGGED → **GATED** (flagged 11 → 10, gated 19 → 20) carrying the interpolation limit rather than papering over it; `rme-003`'s "the toggle's *effect* remains unasserted" half closed, its uncapped-framerate half explicitly left open | cc:完了 |

**Red-proofs, all four quoted with their numbers.** Against a build with
`R_InterpolateSectors (true)` deleted: `sim-goldens` rc=0 (13/13), `render-goldens`
rc=0 (13/13), `render-low` rc=0 (13/13), `sim-freelook` rc=0 (13/13) — and
`sim-invariants` **rc=1, DESYNC at tic 14**. Forcing a modifier pass to control
values: rc=1, `changed 0 of 1710 frames (need 85)`. A constant framebuffer hash:
rc=1, `control framebuffer differs from doom-demo1-render.json at tic 0 — the
instrument is not trustworthy`. `-nodraw` reinstated: rc=1, `control pass rendered
0 frames over 1710 tics`.

**Two traps this phase walked into, both caught by a gate rather than by
reading.** `git checkout -- engine/core/r_main.c`, used to undo a red-proof's
sabotage, also reverted the legitimate change in the same file; the guard
asserted the sabotage was GONE and never that the intended change was still
THERE, and `build-invariants` then failed to link on `undefined symbol:
doom_fractic_override`. And a red-proof that sabotaged `fnv1aRender` hit the
first of the file's TWO definitions — the render family's, which `--sim-drawn`
never calls — so R3 first read green over a sabotage that was never in the path.

## Phase U: the stamp tier — claims no suite leg had ever run

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| U1 | **`wasm-stamp` printed `3/3 passed (hard failures: 0)` while two of the three had drifted** from their 6de6256 pins — `failures` counted only HARD failures, so three statuses (hard pass, soft match, soft drift) collapsed into one word. Its header also carried a stale copy of the pre-restamp `__heap_base` (5,461,072), which the file's own comment at :16-18 forbids | summary now reads `1/1 hard passed, 0/2 soft pins matched, 2 DRIFTED (perf-002 281277 -> 278660; perf-003 75283 -> 75675)`. All three expected values read from the manifest; the file types none of them. Stale header figure deleted | cc:完了 |
| U2 | `perf-002`/`perf-003` said `"status": "verified"` while being `checkSoft` — **nothing they reported could ever fail a gate.** "Verified" meaning "a script printed INFO about it" is the 24.2 overclaim the vocabulary exists to stop | the STATUS moved, not the check: new `commit-pinned` status carrying `pinned_at`, and `claims-index-check` rule 3b binds it — a `commit-pinned` claim reads `dated-measurement` in the index, never "verified". Red-proofed: flipping one index row back to `verified` reds with the id named. Kept soft deliberately — CODE section size moves every commit, and a hard pin would make the gate regold its own reference | cc:完了 |
| U3 | **No suite leg had ever executed `wasm-stamp.mjs`**: measurement-stamp is `--full` only and the `doc-drift` leg calls `verify-all.sh` with no arguments | leg `stamp-full` (`build,fresh-perf`) running `verify-all.sh --full --require-complete`. `--require-complete` is new and is the point — `verify-all.sh` exits **0** on `PASS (INCOMPLETE)`, so a plain wrapper prints green for a run that checked nothing extra. **Red-proof is the pair**: perturbing `claims.json` perf-009 by ONE leaves `doc-drift` rc=0 green and reds `stamp-full` rc=1. And with `build-perf` moved aside: `--require-complete` rc=1 vs rc=0 `PASS (INCOMPLETE)` without it | cc:完了 |
| U3b | The fast tier's own verdict read `ALL PASS verify-all: all checks green` over 33 claims it had not run — the tier a verdict was reached in is part of the verdict | it now reads `fast tier green (107 claims); 33 full-tier claims NOT run (--full)`. `verify-all.sh` also gained a real argument loop; it read only `$1` and silently ignored anything after it | cc:完了 |
| U4 | `gate-census`'s name heuristic could not see `wasm-stamp`, `size-ledger`, `doc-drift`, `ledger-count` or `claims-summary` — the whole claims-machinery class was invisible to the census | broadened: **77 → 82 gate-shaped tools, 0 orphaned**, red-proofed by hiding verify-all's reference (rc=1, then rc=0 restored). **This closes nothing by itself and the comment says so**: reachability is a text grep, so `wasm-stamp.mjs` counted as "run by the suite" while sitting inside `if [ "$FULL" = "1" ]`. The census cannot see tiers; U3 is the fix | cc:完了 |
| U5 | `docs/perf.md`'s Axis 4 PWAD combo table has FOUR rows and only the first was gated. The other three read 4.50 MB while `__heap_base` was 4.81 — stale, then made correct by accident by the widescreen revert | all four gated: `perf-059` plus new `perf-059b/c/d`, each derived from perf-009 + ZONESIZE + the two wad sizes, with a guard that fails if the loop checks fewer rows than it declares. **One ungated row was still wrong**: `doom.wad + sigil.wad` read 24.77 against 24.76 computed. Fixed. `stamp-check`'s own summary had U1's defect one file over — a hardcoded `${7 - failures}/7` beside a run reporting ten claims; deriving it revealed **three further drifted soft pins** (perf-001/004/005) the old line had hidden | cc:完了 |

Registry 84 → 85 legs. `promises-index` rule 6 caught the count drift on both
occasions it happened, which is the gate doing its job.

## Phase W: the four README promises, gated rather than narrowed

The owner's call, taken against the cheaper path of narrowing the README text
to what was already proven.

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| W1 | `rme-009` — README:41 says `webdoom.service` is a ready systemd unit, and **nothing checked it**: no boot test, no file validation, not one assertion | `service-file` leg (`tools/service-check.sh`), quick tier, **15 assertions**. `systemd-analyze verify` alone was NOT made the gate: on a good unit it exits 0 and prints NOTHING, so a bare wrapper cannot tell a sound unit from a dead check — its OUTPUT is graded as well as its status, since warnings exit 0. Adds the nine directives a ready unit must carry, ExecStart's program and script, WorkingDirectory's basename, and DOOM_HOST/DOOM_PORT agreeing with `server/serve.js`'s own defaults. Red-proofed on **five** arms, each rc=1 naming a different failure. **What it does not check is stated, not implied**: whether the unit BOOTS needs root and a live systemd | cc:完了 |
| W2 | `rme-008` — the demo goldens cover the four demo-bearing IWADs; the other **24** manifest entries (SIGIL, NRFTL, Chex Quest, the 20 Master Levels) had no automated test of any kind | `smoke-pwad` leg: 24 of 24 booted and rendered, four assertions each, target list **derived from `wads/manifest.json`** so a new WAD joins the gate with no edit. Two vacuity floors (fewer than 20 discovered, or fewer than 20 booted, is a FAIL) | cc:完了 |
| W2b | **The red-proof failed first, and the gate was wrong, not the proof.** Truncating `tnt31.wad` to 40 KB still PASSED: the engine fell back to `tnt.wad`'s own MAP31, so "it booted and drew a level" never proved the PWAD loaded at all | a base-IWAD control, the same shape as T2's A3/A4 — boot the base at the same map and require the PWAD's frame to differ. It now reds: `identical to tnt.wad at the same map — the PWAD contributed nothing (did it load?)`. A control that ERRORS is itself proof, since that map exists only in the PWAD (sigil's E5) | cc:完了 |
| W2c | Two harness defects this leg walked into. `chex.wad` failed `W_InitFiles: no files found` — the engine identifies games by 1993 filenames and a doom-shaped TC must register as `doomu.wad`; `client/js/main.js:20`'s `ENGINE_NAME` map already said so and the gate had re-derived it wrongly. And the first cut read **1, 2, 3, 4, 5 … tics** down the target list | the tic count was measuring the harness's own position in its run: outside `-timedemo` the engine advances from real elapsed time via `TryRunTics`, so an unpaced loop reports the process's age. Paced at 70 fps like `smoke-test.mjs`; every target now reads a uniform 53 tics | cc:完了 |
| W3 | `rme-005` — "second load is instant" is a performance claim with no gate | — | cc:TODO |
| W4 | `rme-002` — `firefox-smoke` asserts UA + JS + `/api/wads` but never a rendered frame | — | cc:TODO |

## Phase Y: the ledgers

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| Y1 | **`docs/claims-index.md`'s VALUE column was compared to nothing.** Rules 1–3 checked status, presence and the unverifiable vocabulary; nothing compared the number a reader actually reads | rule 3c: a row whose id has a manifest `expected` must CONTAIN it after stripping separators and normalising U+2212. *Contains*, not equals, because the index legitimately writes units and gloss around the figure — a checker that parsed units would be a second source of bugs. Vacuity floor: fewer than 130 rows compared is a FAIL. Red-proofed three ways: one manifest byte flipped → 1 row named; an index row reverted to its stale value → `rdr-006: index "1,024" vs manifest "128"`; the rule narrowed → `compared only 86 rows` | cc:完了 |
| Y1b | Eleven rows disagreed, and **seven were stale by a lot** | `perf-009` 5,461,072 → 4,722,048; `perf-059` 54.83 → 26.13 MB; `rdr-006` 1,024 → 128; `rdr-008` 2,048 → 256; `readme-001`/`size-004` 349 → 348; `ea-026` 92 → 91. The four that could not normalise were **RESTATED to carry their number, not exempted** — `ea-021` "1,200+" → "1,208", `ps-012` → "262,144 (4 × FRACUNIT)", `perf-008` → "4,194,304 B (32 MB)" — because an exemption list is one edit away from exempting the stale ones, which is the failure the rule exists to stop. **One skip, defined and named**: `fmt-033`'s expected is the boolean `true`, an assertion rather than a figure; skips are counted and printed | cc:完了 |

**A trap this round walked into TWICE, and the second time it destroyed
finished work.** `git checkout -- <path>` used to undo a red-proof's sabotage
also reverts every other uncommitted change in that file. It took the T2 fractic
pin out of `r_main.c` (caught by `build-invariants` failing to link on
`undefined symbol: doom_fractic_override`) and then took rule 3c out of
`claims-index-check.mjs` (caught only by grepping for it afterwards). A guard
that asserts the SABOTAGE IS GONE does not assert THE INTENDED CHANGE IS STILL
THERE. Sabotage/restore now goes through a backup copy verified by `diff`, and
`git checkout` is reserved for files with no other uncommitted work.

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| Y3a | `docs/optimization-ledger.md`'s three surviving candidates (NC2, NC3, NC4) all read `SURVIVES → task 20.2b`, and **20.2b is `cc:完了`** — it was round 3's landing TEMPLATE and closed at 90250e8. A survivor owned by a finished task reads as scheduled work and has no owner at all. Rule 1 catches a LANDED candidate still called open; nothing caught the mirror | `status-drift` **rule 5**: a ledger verdict may not name a task Plans.md records as `cc:完了`. `no live owner` is the accepted alternative, deliberately — a survivor with nobody to do it should say so rather than borrow a closed task's name. Six verdicts re-pointed. Red-proofed by pointing one back (rc=1), and the rule immediately caught the explanatory note added beside it, which quoted the old form | cc:完了 |
| Y3b | `promises-index`'s "Flagged promises by future task" table named eight tasks — 12.2b, 12.3, 12.4b/15.1, 14.3, 15.2, 15.3, 15.4, 15.5 — and **every one was closed and archived**. Round 8 closed four of the promises it listed without any of those tasks existing | replaced with "Open promises and who owns them", which names an owner or says there is none. **"No live owner" is a real entry**, not a gap to fill with the nearest task number; two rows read "none, by verdict" | cc:完了 |
| Y3c | Five files promised cross-ISA conversion factors as "task 13.5's job" — **eleven locations**, six of them in `docs/perf.md` — and 13.5 closed having produced the feasibility atlas but not them | all eleven restated: the factors are unclaimed and unowned, and the atlas's own FINDING-2 is the reason — instruction share is not wall share, so a conversion needs memory-system error bars rather than an ISA ratio. Both the generator scripts and the goldens they write were changed together, so the next regeneration does not reintroduce the claim | cc:完了 |
| Y3d | `tools/run-tests.sh` said "Also closes promises rme-004" while `promises-index` recorded it PARTIAL. **Nothing scans `tools/` comments for claims like that**, which is why it survived | corrected to name the half that is closed (rebind) and the half that is not (analog twin-stick), with the reason it went unnoticed written beside it | cc:完了 |

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| W4 | `rme-002` — README says "runs in stock Chrome / Edge / Firefox". Chromium had 19 CDP legs; Firefox had `firefox-smoke`, which asserts a Firefox UA fetched the page and `/api/wads` was requested — the HTML parsed and JS ran — and **no rendered frame**. `spec.md` recorded the reason as "no CDP equivalent for Firefox in this repo's tooling; geckodriver not present" | `firefox-frame` leg, **6 assertions**, 13 s. Three findings had to come first, all measured: **(1) Firefox 155 does not speak CDP at all** — `--remote-debugging-port` serves WebDriver BiDi and `/json/list` 404s, so the recorded reason was wrong in the other direction; the leg drives BiDi directly and geckodriver is still not needed. **(2) Headless Firefox has no WebGL here** (`webgl2:false`, `webgl1:false`; prefs cannot force software GL) and the client then falls back to `createRenderer2D` **and renders perfectly well — 252 colours, measured**, which is exactly how a frame gate passes while proving a path no user takes. **(3) Under `xvfb-run` the same Firefox reports `webgl2:true`, "llvmpipe, or similar"**. So the leg runs under Xvfb and asserts `window.webdoom._renderer.kind === 'webgl2'` | cc:完了 |
| W4b | "The screenshot changed" is not a frame assertion — a flat fill changes too | `tools/png-stats.mjs`, a dependency-free PNG decoder (IHDR, inflate, unfilter), reports distinct colours and the share of pixels differing from the DOMINANT colour. **Flatness, not whiteness**: the first cut counted non-white pixels and read "100% non-white" for `about:blank`, because under Xvfb a blank page captures transparent and unfilters to 0,0,0 — the metric called the emptiest possible image maximally interesting. Frame: 249 colours / 94.2% varied; `about:blank` control: 1 colour / 0%. Red-proofed twice — headless reds with `kind=canvas2d` while every other assertion still passes, and a constant measurement reds both picture assertions | cc:完了 |
| W4c | Two of my own assertions were weak and one was wrong about DOOM | "the frame changes when the player moves" passed while DOOM's own menu was open — the blinking skull cursor satisfies it whether or not input reached the engine; replaced with a liveness check on the attract demo plus a separate Escape-opens-the-menu input check. And that liveness check first read RED on a healthy engine: DOOM holds a **static title screen for ~170 tics** before the demo starts, so two captures 1.5 s apart are legitimately identical. It polls now and reports when motion began (3,000 ms) | cc:完了 |
| X1 | `Plans.md` 23.6 was `cc:完了(partial)` — "a spectate fuzz leg is still the open half", never written | `spectate-fuzz` leg, **8 hostile cases** against `/ws/spectate`: the `MAX_SPECTATORS` cap, close-handler bookkeeping, a 4,096-byte frame against `maxPayload: 64`, 20 ticcmd-shaped injection frames, 30 churn cycles, a stalled half-open observer. **The closing case is a LEGITIMATE observer being served**, because "the attacks were refused" and "everything is refused" are the same observation from the attacker's side. Red-proofed both ways: removing the cap gives `3 over-cap observer(s) were ADMITTED past 2`; removing the close handler gives `the cap stayed full after close() — spectators leak`. 23.6 → `cc:完了` | cc:完了 |
| X3 | `tools/lint.sh` runs `node --check` over JS and clang-format over C, and **nothing can see inside a heredoc** — three tracked shell scripts carry 252 lines of Python, the largest 232 lines inside `fleet-bench.sh`, which is the perf gate | `check-heredoc-lang.mjs`, wired into `lint.sh`: extracts each python heredoc and `py_compile`s it, and **also flags a module used with no import** — which `py_compile` cannot catch, because the module compiles and the name only resolves when that line runs. Its own vacuity guard caught the first scanner, which found 2 of 3: `fleet-bench.sh` opens its heredoc four backslash-continuations below `python3 -`, and the scanner only looked at the opening line | cc:完了 |

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| W3 | `rme-005` — "second load is instant". The OFFLINE half was gated (`browser-offline`, `check-sw-precache`); **"instant" was a performance claim with no gate at all** | `load-budget` leg: a REGRESSION gate against a baseline committed per host, which a host without one SKIPs BY NAME through a prereq rather than passing — the test's own internal skip exits 0 and would have read as a PASS in the suite table. Two assertions: the service worker CONTROLS the page before the second load, and the warm load is within this host's budget (alder 337 ms against 4,000 ms). Red-proofed both ways — a 100 ms budget reds naming the measured number, a removed baseline SKIPs with the record command | cc:完了 |
| W3b | **"Instant" is not a measurable word, so README stopped using it.** The sentence now describes the mechanism ("the second load is served from that cache"), which is what the gate actually proves. Lowering a claim to what is provable is not the same as lowering a bar | and the cold-vs-warm comparison is **reported, never graded**: over loopback the cold load pays no network cost, so it measures scheduling noise more than caching. Measured over three runs the warm load was **333–339 ms every time** while cold ranged **358–452**, leaving margins of 25, 65 and 113 ms — grading a 25 ms margin buys nothing and flakes eventually | cc:完了 |

**All four promises the owner chose to gate are gated**: `rme-002`, `rme-005`,
`rme-008`, `rme-009`. promises-index: 24 gated, 2 partial, 8 flagged.

| Task | 内容 | DoD | Status |
|------|------|-----|--------|
| Z1 | `prf-002`/`prf-003` — `perf.md` published "177.7 KB gzip" total and "35 KB" for the JS+CSS+HTML surface, both marked *(not machine-verified)*, and `perf-015`/`perf-016` sat `unverifiable` in claims.json. **Nothing recomputed them for months** | `payload-size` leg. Measured: total **236 KB** (published 177.7, 1.3× low) and surface **89.2 KB** (published 35.1, **2.5× low**). The per-file table still listed `client/js/settings.js`, which round 7 DELETED, and omitted `wad-import`, `demo`, `scrubber`, `mus2mid`, `sf2-library`, `idb`, `wad-library`, `ui` and `wad-cache`. The set is DERIVED from `client/sw.js`'s `SHELL_FILES` — the list `check-sw-precache` already gates both ways — so a file added to the shell joins the measurement with no edit here; a typed list is exactly what went stale. Graded as a CEILING with 10% headroom, not a pin, because these move with every commit | cc:完了 |
| Z1b | The first cut was checked two ways, not three | `--require-script-values` caught it: the verifier emitted no `CLAIMS_JSON` footer, so `perf-015`/`perf-016` were compared doc-vs-manifest only, and verify-all calls a claim with no script value **a defect rather than a skip**. The tool emits the footer now and is a verify-all family of its own | cc:完了 |
| Y4 | `docs/perf.md`'s claim locators had drifted, and **my own 8-row table regeneration is what pushed two over the edge** — `perf-036`/`perf-039` went `DOC_NOT_FOUND` at a 38-line drift | the mechanism, read rather than assumed: the ±35 window binds **only** for claims carrying an `extract_re`, and the full-document fallback fires only when the NEEDLE is absent from the window. So a needle still inside the window while the FIGURE has moved out is precisely the failure mode — which is what happened. 25 locators with an unambiguous single match re-anchored; **beyond-60%-of-window drift 52 → 37 of 129**. One re-anchor (`perf-008`) moved a locator to a line where its `extract_re` could not work and was reverted, which is why the sweep only moves unambiguous matches | cc:完了 |
