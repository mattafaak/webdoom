# webdoom Plans.md

Prior initiatives archived: `Plans-refinement-complete.md` (26/26),
`Plans-understanding-complete.md` (Phases 6–11),
`Plans-floor-initiative-complete.md` (Phases 12–15, 32/32 at 8305c4a),
`Plans-field-fixes-complete.md` (round 3 Phases 16–19, 24/24 at 1f9f1e5).


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
| 20.4c | N64 ares 13/13 demo gate: automate 13/13 demo runs under ares; per-tic sim hashes verified against 11.1a freestanding golden traces; gate exits 0 on all-match, non-zero on any divergence | tools/n64/run-n64-demos.sh committed; exits 0 with 13/13 bit-identical sim-hash matches vs 11.1a goldens; drift-proved: corrupt a golden hash → FAIL naming it, restore → PASS; verify-all green | 20.4b | cc:TODO |
| 20.4d | N64 SummerCart64 hardware evidence + fps: load ROM on real N64 via SummerCart64; capture UART log; compare against ares expected output; measure fps on hardware + ares (both committed) | committed UART capture (tools/n64/sc64-uart.log) showing D_DoomMain + at least one demo completing; fps committed for both ares and hardware; any ares divergence filed as FINDING; partial filed as partial (no fabrication) | 20.4c | cc:TODO |
| 20.5 | **DECOMPOSED** N64 sub-phase B (the first): RDP-rasterized columns/spans while the playsim stays bit-exact — no demo-exact vanilla port has ever shipped RDP-assisted rendering | (superseded — see 20.5a–20.5b) | 20.4 | cc:分割 |
| 20.5a | N64 RDP renderer + ares gate: implement RDP-rasterized column/span rendering alongside existing software path; enable via `WEBDOOM_RDP_RENDER` build flag; playsim untouched — ares 13/13 sim gate must still pass | ares 13/13 sim gate (20.4c script) exits 0 with RDP path enabled (sim hashes unchanged — render path does not affect playsim); own render golden set committed for RDP visual output (not vanilla); engine/core diff vs master = 0 lines (RDP path in tools/n64/ shim only) | 20.4d | cc:TODO |
| 20.5b | N64 RDP hardware speedup measurement: run sub-phase A ROM and sub-phase B ROM on real N64 via SummerCart64; measure fps for both; commit comparison | committed fps comparison (tools/n64/rdp-speedup.md): sub-phase A fps vs sub-phase B fps on hardware (≥1 map/area); speedup % stated; FINDING filed if RDP is slower or within noise; no record claim — the numbers are the deliverable | 20.5a | cc:TODO |
| 20.6 | **DECOMPOSED** 386 test bed: 86Box bench harness (cycle-configurable 386DX-40 profile) + icount-scoreboard reduction campaign toward the 1,142,857 cycles/tic budget; candidates flow from 20.2/20.3 | (superseded — see 20.6a–20.6b) | 20.1b | cc:分割 |
| 20.6a | 86Box harness: configure 86Box with cycle-configurable 386DX-40 profile; automated boot to DOS + DOOM launch + icount capture via 86Box debug port; red-provable | tools/386/run-386box.sh committed; exits 0 on successful DOOM icount run (cycles/tic received + printed); exits non-zero on boot/launch failure; drift-proved: corrupt boot image → FAIL, restore → PASS; 386DX-40 baseline cycles/tic committed | 20.1b | cc:完了 [bed8573] |
| 20.6b | 386 icount scoreboard baseline: run harness over demo1 (and 13 demos if runtime permits); decompose icount per subsystem (bsp/segs/render/playsim/transfer) using 86Box profiling; update atlas row | docs/perf/386-icount-scoreboard.md committed with per-subsystem icount breakdown; atlas row for 386DX-40 updated with measured cycles/tic and headroom to 1,142,857 target; scoreboard is regenerable from tools/386/; verify-all green | 20.6a | cc:TODO |
| 20.7 | **DECOMPOSED** Sub-100 MHz floor measurement: arithmetic row first (20.1), then bounded attempt on underclocked RP2040-class silicon with WHD-style asset work; deliverable is a NUMBER — the measured minimum clock at which 13/13 demos stay tic-exact — not a promised record | (superseded — see 20.7a–20.7b) | 20.1b | cc:分割 |
| 20.7a | RP2040 bring-up + WHD asset pipeline: bring engine/core up on RP2040 using the freestanding shim pattern (11.1a precedent); prepare reduced-size WAD pipeline (WHD-format headless extract); document underclocking method (pico-sdk frequency define or overclock register) | RP2040 ROM boots to D_DoomMain (rp2040-doom toolchain or pico-sdk); WHD asset pipeline script committed (tools/rp2040/prep-whd.sh or equivalent); underclocking method documented with ≥2 tested clock steps; partial filed as partial (no fabrication) | 20.1b | cc:完了 [1f2efb2] |
| 20.7b | RP2040 floor clock measurement: sweep RP2040 clock downward from 100 MHz in steps; at each step run 13/13 demos tic-exact check (sim hash match); find minimum clock where all 13 pass; update atlas row with measured floor + variance | measured floor clock committed (tools/rp2040/clock-sweep-log.txt); atlas row updated: minimum MHz for 13/13 tic-exact, method, variance (≥3 retests at floor clock); FINDING filed if floor > 100 MHz; no "record" claim — the number is the deliverable | 20.7a | cc:TODO |

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
| 22.2 | Triage: F1 flake, F2 perf-009, F3 wbox baseline, F4 four-host perf gate | each red fixed, promoted to a task, or recorded with an expiry | 22.1 | cc:完了(partial) [6296f2d] — F1 fixed, F3 addressed; F2 and F4 recorded, F4 needs a decision |
| 22.3 | Node 26.8.1 compatibility capture | drift recorded with the version boundary named | 22.1 | cc:TODO |

## What round 4 bought, measured

- **71 legs** where there were 32 headings; a red no longer hides the rest.
- The differential fuzzer and the adversarial ASan gate answer for the CURRENT
  engine for the first time since 2026-07-22.
- Four gates that existed and ran nowhere are wired — including the native ASan
  demo suite `README.md` already advertised.
- **The build is byte-reproducible**: `build/doom.wasm` rebuilt from a clean
  tree returns to its documented md5 `c669142745449ff04bd2fef30fa17412`, and so
  does `build-sbskip`. The ledger said "proven"; now it is re-provable.

## Open findings (see docs/2026-09-11-suite-baseline.md)

- **F1** CLOSED [6296f2d]. Not a server flake: `onceMsg()` attached its message
  listener one or two microtasks after `open` resolved, so the `welcome` the
  server sends immediately on connect was emitted to no listener and dropped.
  Two hypotheses died on measurement first (slow startup: 54–58 ms vs 600–800 ms
  waits; "the server never sends welcome": it does, and the instrumented probe
  logged `frames: welcome,roster` while the wait timed out). net-fuzz went
  1/8 → 8/8, edge likewise, and the full suite is **71/71, exit 0**.
- **F2** `verify-all --full` red: perf-009 `__heap_base` 5,042,320 vs a
  documented 4,721,456 — static data grew ~321 KB. Understand before restamping.
- **F3** wbox has no gating baseline until one is recorded ON wbox (no repo,
  build or WADs there today).
- **F4** the four-host perf gate is unrunnable as `spec.md` writes it: pi5 down.

## Phase 23: memory safety and hostile input

Every task reproduced the defect against the shipping build BEFORE the fix, per
the round's ground rule. The two directions nobody had fuzzed — hostile server
into the engine, and hostile lump content — are now gates.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 23.1 | Network-controlled array indices: `web_net_bundle` tic, `web_net_setup` slot/numplayers, `web_set_console` | reproducer first; guards in the engine AND net.js; 13/13 sim tic-identity | 22.1 | cc:完了 [7764c94] |
| 23.2 | WAD-driven overreads in the music path: GENMIDI length, MUS event and VLQ bounds | reproduced with an instrumented build; OPL2 output byte-identical; red-proofed | 22.1 | cc:完了 [a1b0420] |
| 23.3 | Non-terminating patch decoder (`doomfont.js`) and the corrupt-WAD server exit (`ui-assets.js`) | both reproduced; loop bounded; server declines instead of dying; red-proofed 5/5 | 22.1 | cc:完了 [a1b0420] |
| 23.4 | Demo buffer bounds: `web_play_demo_buf` takes no length and overscans; the `#demo=` fragment path applies no cap | reproducer first; length parameter; 19.4 gates green | 22.1 | cc:TODO |
| 23.5 | Unchecked `_malloc` returns (5 sites; `main.js:196` would `HEAPU8.set(wad, 0)`) | every site checks; failure degrades loudly | 22.1 | cc:TODO |
| 23.6 | Server resource and liveness: the `verifyInFlight` half-open wedge, unbounded `session.history`, uncapped spectators, unpruned `attestStore` | reproducers first; `net-fuzz` extended to the spectate endpoint (today: zero coverage) | 22.1 | cc:TODO |
| 23.7 | `bootDoom` teardown: no `doom.netQuit`, `relay.quit()` production-dead, ~11 listeners and the GL objects leak per boot | a single teardown(); play→quit→play×5 leaks nothing, measured | 22.1 | cc:TODO |
| 23.8 | Fuzz the untested direction: hostile SERVER frames at the engine | `tools/hostile-server-test.mjs`, 13 cases, by observation not inference; red-proofed | 23.1 | cc:完了 [7764c94] |

Suite: **73 legs, 73 passed, 0 skipped**.

## Phases 24–25 (planned, not started)

Docs/promises truth-up and the CI claim; dead code, the `web.h` contract, and
the Phase 20 disposition. Detail in the round-4 plan.
