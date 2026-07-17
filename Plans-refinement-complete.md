# webdoom Plans.md — refinement & hyper-optimization pass

作成日: 2026-07-15
Contract: root `spec.md` (product contract) — read it first.
Fleet: wbox (weakest), tank (least optimized), pi5 (ARM ref), alder (dev).

---

## Phase 0: Measurement & baseline infrastructure

Nothing in Phase 2+ lands without these gates. [tdd:skip:test-infrastructure]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 0.1 | Per-stage profiling: engine timing hooks (sim / BSP walk / segs / planes / things / draw / blit) surfaced through `bench.mjs`; schema v2 for `bench-baseline.json` | bench reports per-stage ms per demo; runs on node with no browser | - | cc:完了 [15770d9] |
| 0.2 | Fleet bench runner: one command (ssh) runs 0.1 on wbox+tank+pi5+alder, emits 4-host comparison table, updates baseline JSON | `tools/fleet-bench.sh` produces committed baseline v2 for current HEAD | 0.1 | cc:完了 [caa81fe] |
| 0.3 | Render-golden harness: per-tic framebuffer FNV hash during demo playback, pinned for all 13 IWAD demos (`demo-test.mjs --render`) | all 13 render goldens committed and passing; a 1-pixel diff fails at the exact tic | - | cc:完了 [c1288ce] |
| 0.4 | Lint/format baseline: clang-format for `engine/web/` + `tools/archaeology/`; minimal JS lint for `client/ server/ tools/`; `engine/core/` exempt (vendored diff archaeology) | `tools/lint.sh` exits 0; wired into `run-tests.sh` | - | cc:完了 [6de6256] |
| 0.5 | Memory & size audit: wasm section breakdown, Z_Zone high-water per IWAD, heap headroom vs 64MB, JS payload sizes | tables in new `docs/perf.md` | 0.1 | cc:完了 [e9e4e61] |

> **Render-gate coverage note (0.3)**: goldens hash the indexed framebuffer + I_SetPalette call-count (not palette RGB bytes) and skip melt-wipe frames — palette-content regressions with unchanged call sequence, and f_wipe.c rendering, are outside the gate. Phase 2 tasks touching those paths need their own verification.
> **Followup (0.5→2.5/2.6)**: `WEB_ZONE_POOL_SIZE` in engine/web/perf.c duplicates `ZONESIZE` in engine/web/i_system.c with no compile-time guard — consolidate (shared define in web.h or _Static_assert) when task 2.5/2.6 touches the zone. perf.md flags ZONESIZE 32MB → 4–8MB as a 2.5/2.6 candidate.
> ~~Followup (0.2)~~ CLOSED: tank baseline filled, all four hosts coherent at 16c3354. Note: `FLEET_PI5=<user>@pi5` is required (bare `pi5` fails tailscale user lookup).

## Phase 1: Clean-room archaeology completion — no mysteries

Documentation tasks. [tdd:skip:docs-only] — but every claim must be
verified against code/goldens the way engine-archaeology.md already does.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 1.1 | Renderer internals doc (`docs/renderer.md`): BSP traversal, drawsegs, visplanes, openings, clip arrays, sprite sort; invariants; rationale for raised limits (visplanes 1024 etc.) | every `r_*.c` structure & algorithm documented; no "unknown" left | - | cc:完了 [ac9bdb1] |
| 1.2 | Playsim internals doc (`docs/playsim.md`): blockmap, P_TryMove, intercepts, sight BSP, thinkers, spechits; catalog of vanilla quirks deliberately kept for demo compat (wallrunning, blockmap oversight, intercepts overflow…) | every `p_*.c` mechanism documented incl. quirk catalog with demo evidence | - | cc:完了 [fa17d82] |
| 1.3 | Data-format reference (`docs/formats.md`): WAD/lump layouts, demo format, savegame format, DMX sfx, MUS, GENMIDI — field-level | complete enough to reimplement a reader from the doc alone | - | cc:完了 [16c3354] |
| 1.4 | Remaining magic-data sweep: scalelight/zlight recipes, s_sound distance attenuation, p_lights tables, wipe RNG use — extend `docs/engine-archaeology.md`; verdict per blob (recipe / equivalence / irreducible) | zero undocumented constants or tables remain in `engine/core` | - | cc:完了 [0feb6f4] |
| 1.5 | `docs/bare-metal.md`: exact core↔platform contract (i_* / web.h surface, memory floor, 35 Hz timing, framebuffer+palette contract), shipped-vs-boot-generated table tradeoffs for ROM targets — groundwork for the future ESP32-and-below project | a competent embedded dev could scope the ESP32 port from the doc alone | 1.1, 1.2, 1.3 | cc:完了 [18c168f] |

## Phase 2: Hot-path optimization — measure → change → prove

Every task: sim gate (13 golden demos tic-identical) + render gate (0.3)
+ fleet bench before/after (0.2). Within-noise changes are judged on
simpler/smaller/portable axes per spec.md. [tdd:skip:perf-gated-by-golden-suites]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 2.1 | Profile-driven hit list: rank per-stage costs per host; write the ordered optimization queue into `docs/perf.md` | ranked table per host committed; queue agreed | 0.2 | cc:完了 [035ceaa] |
| 2.2 | Column/span inner loops (R_DrawColumn/R_DrawSpan + variants): tighten, cache-friendly access, measure unrolling; optional wasm SIMD prototype behind a build flag. **Queue Q1 reframing (2.1)**: win axis is bare-metal + headless CI throughput, NOT browser fps (wasm render is 1.7% of budget on wbox) | render goldens identical; measured win on wbox or change rejected | 2.1, 0.3 | cc:完了 [10c9d62] — hoist+unroll-4 kept (wbox bsp −3.5%, 7× noise bar, A/B/C-proven); span u32 packing killed (+7.9% regression); SIMD assessed-skipped |
| 2.3 | Visplane hash/merge + openings management modernization (render-only) | render goldens identical; bench delta recorded | 2.1, 0.3 | cc:完了 [4a52052] — measured NOGO: R_FindPlane search ≤451 iters/frame (tnt demo2 worst), ceiling 2.9% of planes stage; hash rejected. Openings overflow → 3.2 |
| 2.4 | Sim hot paths as profiling dictates (blockmap iterators, P_CheckSight, P_ApproxDistance call sites) — tic-trace-gated. **Queue Q4 verdict (2.1)**: profiling does NOT dictate — sim is 0.25% of budget; likely-skip unless bare-metal bring-up shows otherwise | 13/13 demos + choco cross-validation 44,580/44,580 identical | 2.1 | cc:完了 [see perf.md Q4] — SKIPPED BY MEASUREMENT, no sim change (gate trivially intact); reopen conditions recorded |
| 2.5 | Z_Zone review: keep semantics exactly, simplify/harden implementation; prove allocation-pattern neutrality | demo traces + 4-client net hashes identical; less code than before | 2.1 | cc:完了 [dfea2fb] — z_zone −98 lines (3 dead fns), ZONESIZE SSOT in web.h; 32MiB kept (4/8MiB fail render gate under purge pressure — PU_CACHE hazard recorded) |
| 2.6 | emcc knob sweep: -O3/-Os, closure, stack, INITIAL_MEMORY vs actual high-water (0.5) — size×speed frontier per host | frontier documented; chosen flags justified by numbers | 0.2, 0.5 | cc:完了 [62d48ee] — current flags confirmed optimal (-Os: −15% gzip but −9.3% wbox sim fps → killed; noted as bare-metal flash option); INITIAL_MEMORY 64MB kept (worst real combo 54.83MB peak) |
| 2.7 | tank deep-dive: why is tank the least improved? isolate its bottleneck (slow 64-bit idiv? cache? browser?) and fix or document as neutral | tank gets a measured win, or `docs/perf.md` explains precisely why not | 2.1 | cc:完了 [035ceaa] — resolved by 2.1 analysis: tank render is 1.15× alder (no anomaly); the ~1.9× headless gap is general CPU throughput, stable across the FixedDiv change. DoD's second disjunct met (perf.md §Q5) |

## Phase 3: Robustness & hardening

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3.1 | UB sweep: native ASan/UBSan build target (core + stub platform) running the full demo suite; fix UB without sim change [tdd:skip:sanitizer-gated]. **Priority target (2.5 finding)**: render output is heap-layout-dependent — a 16-byte BSS shift fails 3 render goldens (tnt-demo1/plut-demo1/plut-demo3); suspected out-of-window texture read (Tutti-Frutti/Medusa family), predates 2.2, ASan will pinpoint it. Also: P_RunThinkers advance-after-free; extern spechit[8]/[64] mismatch; PU_CACHE use-after-purge under small zones (perf.md §F) | UBSan/ASan clean across all 13 demos; goldens identical | - | cc:完了 [818ff27+a0c67c1] — root cause was the Tutti-Frutti `&127` mask (fixed via dc_texheight; BSS-probe acceptance PASS, goldens no longer layout-pinned); +5 UB fixes; native -m32 ASan target in tools/native-sanitize/; 10 render goldens consciously regolded. Residual: R_RenderMaskedSegRange dc_texheight (noted), PU_CACHE small-zone fix deferred (32MiB never purges) |
| 3.2 | Limits/overflow audit: savegame buffer, intercepts[], spechit[], donut, hu/st buffers — per-site policy: never corrupt memory, preserve vanilla demo behavior; decisions documented | audit table in `docs/playsim.md`; guards in place; goldens identical | 1.2 | cc:完了 [cd88311] — 10-row §19 audit; 5 new fail-soft guards + SIL-guard crash fixed in review; chat path audited-safe; BONUS: masked-seg/masked-column dc_texheight residuals closed, dual-probe (RODATA+BSS) acceptance green — layout unpinning complete |
| 3.3 | Net fuzz & abuse: malformed lobby JSON, truncated/oversized binary frames, slot spoofing, rejoin/drop-in races, resource caps (conns, msg rate, buffer growth) [tdd:required] | fuzz corpus + tests in `tools/`; server survives all cases; caps enforced | - | cc:完了 [1f425c9] — tools/net-fuzz-test.mjs (20 cases, 6 surfaces, red-baseline TDD); 5 real vulns fixed + 2 more crash gaps closed in review (upgrade-URL throw, cap-path race); caps MAX_CONNS=50/RATE=300s/maxPayload; happy path 2p+4p intact |
| 3.4 | Client resilience: WAD fetch failure, sw update mid-session, tab hide/resume, gamepad hotplug, storage-quota errors — extend browser tests [tdd:required] | each failure path has a test and a graceful UX outcome | - | cc:完了 [f5c2b32] — tools/browser-resilience-test.mjs (5 paths); WAD-fail restores interactive menu (retry verified), sw-update non-blocking reload prompt, visibility→audio resume, gamepad-disconnect padPrev reset, localStorage quota+disabled caught; happy-path browser+join intact |
| 3.5 | Menu/lobby state-machine audit: enumerate states & transitions, eliminate impossible states, diagram in docs | state diagram committed; browser tests cover every transition edge | 3.4 | cc:完了 [7d4eff7] — docs/state-machine.md (11 states, 25 edges, Mermaid); 4 impossible states guarded incl. the review-caught ESC-mid-countdown stuck-overlay (T25); browser-lobby-test.mjs 25/25 edges; happy paths intact |

## Phase 4: Launcher PSX fire background

Visual contract lives in spec.md §Launcher fire. [tdd:skip:visual-effect-perf-asserted]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 4.1 | Fire module: indexed-byte PSX fire propagation on a chunky low-res grid, PLAYPAL fire-ramp palette, nearest-neighbor upscale; ~15–20 Hz sim decoupled from rAF; paused when hidden/in-game; dimmed steady state; `prefers-reduced-motion` → static frame | measured < 1 ms/frame on wbox; menu contrast unaffected; browser test asserts effect present + no fps regression | - | cc:完了 [f6d6c0a] — client/js/fire.js: 64×40 doomfire, 16Hz, sim-flare, pause=clearInterval; wbox MEASURED 0.072ms/tick (14× under budget, lead fleet bench); browser-fire-test 5 assertions; menu contrast preserved (opacity 0.45) |
| 4.2 | Flare-up integration: brief intensity lift on menu transitions with decay back to muted; tuning pass on real hardware | flare visible but never harms readability; cost still within 4.1 budget | 4.1 | cc:完了 [8f05c4f] — single menu.js onTransition hook (dedup of 5 sites, no cursor-move flares, verified); tuned curve (peak 36 root / 28 nav, 400ms hold, step-2/80ms decay); flare-peak screenshot confirms text readable; menu.js layout untouched (launcher-only) |

## Phase 5: Consolidation

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 5.1 | Docs & README refresh with measured results; retrospective; promote learnings to memory | README/docs match reality; baseline JSON current | Phase 2, Phase 3, Phase 4 | cc:完了 [ecc195b+f8de315] — README refreshed (all new suites, doc links, fire feature; honest about flaky tests); docs/retrospective.md; perf.md fire section corrected to MEASURED wbox 0.072ms/tick; 4 learnings promoted to project memory |
| 5.2 | Full matrix: run-tests.sh + fleet bench + browser tests on all four hosts; golden refresh audit. **Known flake to fix (found in 4.1 review)**: `tools/browser-lobby-test.mjs` Test 1 (lobby-menu-nav / T07) passes only ~1/3 on master — a CDP harness race, NOT a 3.5 guard defect (guards verified static). Suspect: `patchWS`/`waitForCleanServer` server-session bleed between tests, or the 6s START-GAME poll too short under load. Stabilize (retry/isolation/longer wait) so the gate is reliable. **Second known issue (confirmed by lead)**: `tools/browser-test.mjs` fails with "service worker cached no WADs" (0 entries) — the sw WAD-cache-on-fetch isn't populating within the test's single-load window. (CORRECTION: the test DOES exit 1 correctly — an earlier "exits 0" note was a pipe-masking measurement error; the gate is not silently passing.) Likely an async sw-activation race, a headless-swiftshader caching quirk, or a real regression from 3.4's sw.js controllerchange / main.js fetch changes — bisect against pre-3.4. Fix the sw-cache path or the test's timing so the assertion is reliable | everything green everywhere; one commit pins the pass | 5.1 | cc:完了 [82a754a + T07 9ed9671] — sw-cache fixed (SW lifecycle race + headless NetworkError → ArrayBuffer cache-put; verified 3/3); T07 fixed (retry the flaky MP-open action, 5/5; earlier 1/5 was /tmp exhaustion from orphaned Chrome procs, not the test); fleet baseline refreshed |

> **HOTFIX [fff2a52] (user-reported live bug, post-plan)**: sprite vertical clone-stamp on ALL sprites (items/enemies/corpses/gun hand), walls fine. ROOT CAUSE = my own task 3.1/3.2 regression: `dc_texheight = length|1` made `frac & (dc_texheight-1)` a non-modulo garble for non-pow2 sprite posts. The 3.2 render-golden regold had ENCODED the artifact (goldens were wrong for sprites). FIX: pow2/non-pow2 dispatch in R_DrawColumn/Low/Translated — pow2 keeps the fast &mask+unroll (walls); non-pow2 uses prboom true-modulo (sprites). Validated: sprite bodies bit-match pre-3.1 build 62d48ee; ASan clean; sim 13/13; render goldens RE-regolded to correct output; BSS+RODATA layout probes pass; also fixes non-pow2 wall textures (72/96px) the old mask silently broke. **Lesson: regolding a golden to make a failing gate pass can encode a real bug — a regold needs an independent correctness reference (here: the pre-regression build), not just self-consistency.**

---

## Priority matrix

- **Required**: 0.1–0.4, 2.1, 2.2, 3.3, 4.1 — the measurement spine, the top render win, net safety, and the explicitly requested fire effect.
- **Recommended**: 0.5, 1.1–1.5, 2.3–2.5, 2.7, 3.1, 3.2, 3.4, 3.5, 4.2, 5.1, 5.2.
- **Optional**: 2.6 (knob sweep), wasm SIMD half of 2.2.
- **Rejected** (with reasons, per spec.md non-goals): runtime COLORMAP/gammatable regeneration (PWAD-breaking, zero latency to reclaim); WebRTC/UDP transport rewrite (TCP HOL unmeasurable on LAN/tailnet; complexity vs tenet 3); per-host wasm builds (violates universal artifact); core rewrite in another language (destroys the archaeology).
