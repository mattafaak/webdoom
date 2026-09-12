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
| 23.6 | Server resource and liveness: the `verifyInFlight` half-open wedge, uncapped spectators, unbounded history bursts | wedge reproduced and red-proofed (two wrong fixes first); 15 s body timeout; MAX_SPECTATORS; backpressure on both history bursts. `attestStore` pruning landed in round 5's A3 (8078cbc: reclaimed by age and by total bytes, red-proofed). A spectate fuzz leg is still the open half | 22.1 | cc:完了(partial) [9c800a2, A3 8078cbc] |
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
