# webdoom Plans.md — deep understanding initiative

作成日: 2026-07-16
Contract: root `spec.md` — read tenet #6 first ("Understanding is verifiable
and self-defending"), which this plan operationalizes.
Prior work: the completed refinement pass (26/26) is archived in
`Plans-refinement-complete.md`.

Goal: go from "we understand DOOM's data and algorithms" (documented) to the
deepest *verifiable* understanding — every claim reproduced, the accuracy
invariants enforced by the code itself, and the platform contract put on trial
by an actual freestanding port. Three tiers escalate the depth: **predict**
(reproduce every claim), **prove** (retire "empirical/sketch"), **defend**
(understanding load-bearing in code), then **falsify** (understanding on trial).

Key existing assets to build on (do NOT reinvent): `tools/archaeology/*`
(crackers), `tools/native-sanitize/nat-doom` (a near-freestanding native build
that already dumps per-tic state hashes — the seed for Phases 9 and 11),
`tools/lint.sh` (lint baseline exists — no setup task needed), the render+sim
golden gates, the instrumented-Chocolate cross-validation.

---

## Phase 6: Executable archaeology — every claim self-verifying (PREDICT tier)

The archaeology docs mix reproducible crackers with prose numbers. Make the
*entire* corpus regenerate on demand. [tdd:skip:verification-tooling]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 6.1 | Claim inventory: enumerate every quantitative claim across engine-archaeology.md / renderer.md / playsim.md / formats.md / perf.md; map each to a reproducing script or flag "needs verifier" | `docs/claims-index.md` maps 100% of quantitative claims → a script or a needs-verifier flag; count committed | - | cc:完了 [85541b3+34cb6e1] — docs/claims-index.md: 182 claims mapped 100% (invariant/measurement/derived taxonomy for 6.3's drift-check); FINDING-1 caught a PUBLISHED error (invuln COLORMAP 242→241, arithmetically impossible: 242+15=257) — fixed in repo + public magic-data.md |
| 6.2 | Write the missing verifiers: gamma power-fit residuals, scalelight/zlight recipe check, P_AproxDistance measured error curve, DMX in-band pad verification, and every prose figure without a script | each flagged claim regenerates from a committed `tools/archaeology/` script whose output equals the doc figure | 6.1 | cc:完了 [5ac9732+7d15993] — 5 verifier families (source-constant 40, wad-data 23, runtime-stat 15, recipe-crack, stamp-check); 106/122 done → 166/182 verified (91%); 16 unverifiable w/ per-ID reasons; claims.json manifest for 6.3; FINDING-2 resolved, FINDING-3 = real doc error (gamma L4 51→34) fixed |
| 6.3 | `tools/archaeology/verify-all.sh`: regenerates every figure; a drift-check diffs committed doc numbers vs script output and FAILS on divergence; wire into run-tests.sh | verify-all green; editing any doc figure to a wrong value makes run-tests.sh fail at that claim | 6.2 | cc:完了 [91fea5e+985c128] — verify-all.sh + doc-drift.mjs three-way check (doc==manifest==script, distinguishes DOC_ERROR vs MANIFEST_STALE); fast gate 96 claims/3.8s wired into run-tests.sh; extended to the flagship claims (ea-018 headline COLORMAP, ea-023 the published-wrong figure) that the 'already verified' split had left unprotected; drift proof: corrupt 0→1 ⇒ FAIL ea-018 exit 1, revert ⇒ ALL PASS; FINDING-4 (unreproducible 'standard luma 92' pinned to 77/150/29@A=254→91) |
| 6.4 | Literate pass: annotate each archaeology figure with its generating command (caption/footnote) so the corpus is auditable claim-by-claim | zero unattributed quantitative claims remain in the archaeology docs | 6.3 | cc:完了 [5f91103] — section-level `Reproduce:` lines (extends the existing Crackers:/Script: precedent, keeps doc density); 182/182 claims attributable; 16 unverifiable marked inline with specific reasons; gate pointer + claims-index link added; values provably unchanged (lead-verified: 0 numbers removed/changed across all 5 docs) |

> **FINDING-7 (process, lead — 2026-07-17).** `Agent(isolation: "worktree")` is
> keyed by **SESSION, not by agent**. Three concurrently-spawned workers (7.2,
> 8.1, 10.1) all shared ONE worktree
> (`.harness-worktrees/<session-id>`) and ONE branch. Each worker's brief said
> "you are in an isolated git worktree" — false. Consequences observed:
> (a) worker 10.1 read siblings' **uncommitted** edits as if they were master
> and cited not-yet-existing code in a doc; (b) it filed a correct doc as
> "stale" because a sibling's unlanded insertions shifted line numbers;
> (c) any `git add -A` would sweep siblings' WIP into the wrong commit, and
> `build`/`wads` show as UNTRACKED (`.gitignore` has `wads/`+`build/` with
> trailing slashes, which do NOT match symlinks) so `-A` would commit
> absolute-path symlinks to a PUBLIC repo.
> **Mitigations:** parallel workers must (1) `git add` explicit paths only,
> never `-A`/`.`/`commit -a`; (2) cite by function name, not line number;
> (3) treat sibling-owned file failures as noise, not their own. **Safest: run
> file-coupled tasks SEQUENTIALLY** — disjoint file sets are not enough when
> the tree itself is shared. Consider fixing `.gitignore` to also ignore the
> `wads`/`build` symlinks (no trailing slash).

## Phase 7: Formal proofs — retire "empirical/sketch" (PROVE tier)

Where the docs say "2×10⁹ samples" or "sketch," replace with a proof or a
precisely-bounded, documented guarantee. [tdd:skip:proof-artifact-is-the-test]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 7.1 | FixedDiv exhaustive/SMT: prove double == int64 over the full guarded domain (`\|a\|>>14 < \|b\|`) rather than sampling — enumerate the finite boundary set or drive an SMT solver | a committed harness terminates with "proven exhaustively over the guarded domain" (or a precisely-characterized residual set); archaeology §2 updated from "empirical" to "proven" | - | cc:完了 [ca13af7] |
| 7.2 | FixedMul, P_AproxDistance bound, angle/BAM round-trips: formalize where tractable; document each intractable case with the exact reason it resists proof | every fixed-point/angle primitive has a proof OR a stated bounded-empirical guarantee with the limit named | 7.1 | cc:完了 [3bc3acd] — 6-primitive inventory (§15), every row PROOF or BOUNDED-EMPIRICAL w/ named limit. FixedMul=PROOF (product ≤2^62<INT64_MAX; 2 named IDBs C99 §6.5.7p5/§6.3.1.3p3; floor-vs-trunc asymmetry vs FixedDiv confirmed). P_AproxDistance=BOUNDED-EMPIRICAL, graded by its weakest part (continuous sup √1.25=+11.803% by calculus + integer sup √2=+41.42% at (1,1) exhaustive, but M≥65536 bound is a 65,536-pair sweep). R_PointToAngle=BOUNDED-EMPIRICAL (all 8,192 fine angles enumerated, but distance sampled → honest downgrade). SlopeDiv=PROOF. Lead-verified on master: verify-all 105 claims ALL PASS, lint OK |
| 7.3 | **RESCOPED by FINDING-5** — the original premise was false; the job became correcting the claim, not strengthening it | §6 + the PUBLIC magic-data.md carry no unsupported universality claim; byte-identity stated; HACX 3517/8192 + curve corroboration committed as a reproducer; FINDING-5 filed | 6.2 | cc:完了 [b1ad3a5] — worker DIED at 33min (stale-base worktree, FINDING-7); lead salvaged its reproducer (which independently confirmed every lead number) and wrote the corrections on master. §6 + **public magic-data.md** corrected in place. FINDING-5 + the FINDING-4 straggler (public doc still said luma-92 vs the fixed 91) filed. colormap-cross-palette.c → ea-048/049, fast gate **107 claims ALL PASS**, lint OK, drift-proved (3517→3518 ⇒ FAIL ea-048 DOC_ERROR ⇒ revert ⇒ green). Matcher divergence left as an OPEN QUESTION, not guessed. **FINDING-9 (open)**: doc-drift.mjs indexes off claims-index.md whose locators all point at engine-archaeology.md ⇒ **magic-data.md, the only PUBLISHED doc, is outside the gate's scope entirely** |

## Phase 8: The self-enforcing frozen surface (DEFEND tier)

playsim.md §16 *describes* what must never change. Make the code *enforce* it —
the honest fix for the blind spot that let the Tutti-Frutti regold hide.
[tdd:required]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 8.1 | `WEBDOOM_INVARIANTS` instrumented build: runtime asserts at the exact call site for each demo-visible invariant — P_Random per-tic call count/order, thinker traversal order, blockmap iteration order, spechit/intercepts bounds | build compiles; asserts are zero-cost when the flag is off (core stays web-layer-independent); each §16 invariant has a corresponding assert | - | cc:完了(partial) [844c3d6] — **worker STALLED at 27min idle; lead took over, ran every gate it never ran.** Landed: 11 runtime DOOM_ASSERTs + 7 _Static_asserts behind `-DWEBDOOM_INVARIANTS`; doomassert.h includes only `<assert.h>`, every include inside the #ifdef (2.2 precedent honored). Lead-verified: **zero-cost PROVEN — flag-off wasm byte-identical to clean master (md5 e7772ad6…, 359574 B)**; flag-off 13/13 sim goldens bit-identical + render pixel-identical + verify-all 105 green + lint OK; flag-on builds (365799 B) and all demos run silent. **FINDING-8**: the worker's `P_AddThinker` assert "thinker not already sentinel-marked" fired on 10/13 stock demos — it reads UNINITIALISED memory (non-mobj callers Z_Malloc without zeroing and call P_AddThinker BEFORE assigning `.function`; p_doors/p_lights/p_plats/p_ceilng/p_floor = 14 Z_Mallocs / 0 memsets; P_RemoveThinker writes exactly `(actionf_v)(-1)` so a recycled block still holds it). Removed with rationale at the site — a false invariant, not a weakened one. **OUTSTANDING → 8.1b**: the §16 20-row mapping table was never written, so the "every §16 invariant" clause is UNVERIFIED |
| 6.5 | **FINDING-9 (carved out of 7.3)**: `magic-data.md` — the only PUBLISHED doc — was outside doc-drift.mjs's scope, because the drift index is built from claims-index.md whose locators all point at engine-archaeology.md | editing any figure in magic-data.md to a wrong value makes verify-all fail at that claim (drift-proved); no published figure lacks a locator | 6.3 | cc:完了 [7eff02e] — lead did this directly (worktree pinned 13 commits stale at 34cb6e1 ⇒ delegating would repeat 7.3's death). PUBLIC_HINTS re-checks the public doc's prose against the SAME claims.json `expected` (one source of truth, both docs answer to it); 7 figures = the COLORMAP family, exactly where both escapes happened. PUBLIC_DOC_ERROR is a HARD fail. **Proved against real history, not a synthetic case**: reintroducing FINDING-4 (luma 91→92) ⇒ FAIL ea-026 exit 1; reintroducing FINDING-1 (invuln 241→242) ⇒ FAIL ea-023 exit 1; revert ⇒ public-doc 7/7, ALL PASS. Review hook caught 3 real defects in my own edit (undeclared vars ⇒ ReferenceError; exit gate ignoring publicFail ⇒ would print FAIL and exit 0 — the gamma-crack defect again). Remaining: 9 of magic-data.md's 16 numeric figures still lack locators (finesine/tantoangle/tic-count family) |
| 8.1b | **Carved out of 8.1** (worker stalled before writing it): the §16 20-row mapping table | every one of §16's 20 rows maps to exactly one classification with its evidence; no row unaccounted | 8.1 | cc:完了 [3e97c3d] — playsim.md **§16.1**: 20/20 rows, zero skipped, exactly one class each (10 runtime / 4 static / 3 already-covered / 3 not-assertable). **The worker corrected 3 errors in my draft**: rows 6+7 (block iterators) have NO asserts — I asserted they did, fabricating from expectation; verified 0 DOOM_ASSERTs in P_BlockLinesIterator/P_BlockThingsIterator/P_PathTraverse. Rows 18/19 I dual-classified, violating the exactly-one rule. Row 17 (deferred-free) proven **not assertable**: the only candidate — a post-P_RunThinkers 'all clean' check — fires on valid vanilla behavior (A's action removes an already-iterated B, which stays marked until the next pass). Lead-verified: verify-all 107 ALL PASS, lint OK |
| 8.1c | **FINDING-10 (lead, self-inflicted)**: 844c3d6's assert blocks shifted lines in 9 core files, putting **up to 120 `file:line` doc citations at risk** (r_main.c 30, p_mobj.c 22, p_map.c 19, p_maputl.c 16, p_sight.c 13, p_tick.c 10, m_random.c 4, p_local.h 3, p_user.c 3). One confirmed stale and fixed (9290bc9: playsim.md said spechit reverse was p_map.c:506-518; the loop moved to ~556). The docs carry **411** file:line citations total and nothing verifies any of them — the drift gate checks *figures*, not *locations*. Audit the 120 at-risk citations; prefer converting to function-name references (which do not drift) over re-pinning line numbers that will rot again | the 9 shifted files' citations are each verified or converted; a committed check makes a citation pointing at the wrong construct FAIL, the same way a wrong figure does | 8.1 | cc:TODO |
| 8.2 | Cross-validate: run all 13 demos + Chocolate cross-check under the invariant build; prove a deliberately-injected invariant violation trips the assert AT ITS CALL SITE (not a golden diff 5000 tics later) | clean run passes 13/13 with no assert; an injected violation is caught at the exact source line (shown in the task evidence) | 8.1 | cc:TODO |
| 8.3 | Wire the invariant build into run-tests.sh as a gate stronger than goldens (an assert is a precise cause; a golden diff is a downstream symptom) | run-tests.sh runs the invariant build over all 13 demos; documented as the primary sim-safety gate | 8.2 | cc:TODO |

## Phase 9: Differential understanding beyond the 13 demos

The 13 demos are fixed inputs. Explore the space they can't cover.
[tdd:skip:differential-harness-is-the-test]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 9.1 | Differential tic-fuzzer: synthesize valid ticcmd streams, feed to webdoom AND instrumented Chocolate (extend `tools/native-sanitize/nat-doom`'s per-tic hash dump), assert identical gamestate per tic | fuzzer runs ≥1000 synthetic games with 0 divergences (or a divergence is root-caused as a real finding); committed as a CI-able tool | 8.2 | cc:TODO |
| 9.2 | Coverage / negative-space audit: record which engine/core functions+branches are hit across all 13 demos + the fuzzer; classify every UN-exercised path as understood-by-inference (documented) or unknown (flagged) | coverage report committed; zero "unknown un-exercised" paths — every path either exercised or documented as inferred | 9.1 | cc:TODO |
| 9.3 | Map-mutation differential: procedurally mutate valid maps within the format's rules, same differential check vs Chocolate — hunt for setup/load divergences | mutation harness runs; any divergence root-caused; else recorded as "map-load behavior matches vanilla under mutation" | 9.1 | cc:TODO |

## Phase 10: The divergence atlas — map the whole compatibility landscape

Position webdoom precisely against the entire port lineage, not just Chocolate.
[tdd:skip:docs-with-verified-evidence]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 10.1 | Catalog every known behavioral fork across vanilla / Boom / MBF / MBF21 / PrBoom+ / dsda-doom — spechit & intercepts overflow families, wallrunning, blockmap, sight asymmetries, comp_* flags — with, for each: what it is, which webdoom implements, why, and demo evidence | `docs/divergence-atlas.md`: every catalogued fork states webdoom's position + evidence; cross-referenced to playsim.md quirk catalog | 1.2-done | cc:TODO (unblocked — 8.1 landed at 844c3d6; re-verify citations against master NOW, cite by function name not line number) — atlas drafted (e810823, 9 fork families, 698 lines) but **NOT merged**: FINDING-7 (below) means every file:line in it was read from a tree carrying 8.1's uncommitted edits; it cites `p_local.h:84 _Static_assert(MAXSPECIALCROSS==64)` and a `p_map.c:533-554 WEBDOOM_INVARIANTS` block that DO NOT EXIST on master. Its reported playsim.md §5.1 "drift" (606-607→612-613) is a FALSE POSITIVE — playsim.md is correct for master; the shift is 8.1's unlanded work. Blocked on 8.1 landing, then re-verify all citations against master and cite by FUNCTION NAME, not line number |
| 10.2 | Compatibility statement: state exactly which vanilla quirks webdoom preserves vs which modern fixes it deliberately does NOT take, each traceable to an atlas row | a one-screen compatibility position, every claim linking to a divergence-atlas entry | 10.1 | cc:TODO |

## Phase 11: Bare-metal falsification — understanding on trial (the crown jewel)

Put bare-metal.md's contract on trial by actually porting across it. The only
real proof you understand what it takes to run DOOM anywhere. [tdd:skip:bring-up-is-the-test]

> **FINDING-6 (lead, found by inspection BEFORE any bring-up — the contract is
> already falsified).** `bare-metal.md` §1 claims "The entire platform surface is
> in **three files**: `i_system.h`, `i_video.h`, `i_sound.h`" and that the
> completeness claim "is auditable by diffing against the two header files."
> Both statements are wrong, and the section contradicts itself (*three* files
> vs *"both headers"/"the two header files"*).
> Reality: `engine/core` **unconditionally** includes two further platform
> headers — `engine/web/web.h` and `engine/web/perf.h` (d_main.c:79-80,
> m_misc.c:63, r_main.c:43, w_wad.c:50) — and calls six functions from web.h:
> `D_DoomFrame` (d_main.c), `W_WebFile` (w_wad.c), `W_WebFileExists` (d_main.c),
> `Web_FileLen`/`Web_FileCopy`/`Web_FileWrite` (m_misc.c), plus perf.h's
> counters. A porter following §1 fails to compile four core files.
> **Dispositive evidence**: `tools/native-sanitize/` already ships THREE shims —
> `nat_platform.h`, `perf.h`, AND `web.h`. The repo has already been forced to
> work around the gap the doc denies. The true surface is FIVE headers.
> This is the exact doc-vs-reality discrepancy 11.3 was scheduled to discover
> *after* the bring-up; it is now an input to 11.1, not an output of 11.3.
> NOTE: this also means "core is web-layer-independent" is false as a blanket
> rule — it holds only for the flag-guarded counters (p_telept.c/p_map.c/
> r_draw.c/r_plane.c guard their `perf.h` include inside the `#ifdef`; the five
> above do not). That narrower rule is the real, enforced precedent from 2.2.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 11.1 | Freestanding headless core: extend `tools/native-sanitize` into a genuinely freestanding target — engine/core + a minimal platform layer assuming only a memory region + a byte-out — dumping per-tic state hashes. Rung 1: minimal hosted build; Rung 2: a QEMU bare-metal ELF (Cortex-M or RISC-V, no OS) | a freestanding build (no OS services beyond memory + putchar) boots the sim headless and dumps per-tic hashes; QEMU rung documented even if rung 1 ships first | 8.1 | cc:TODO |
| 11.2 | Run the 13-demo trace on the freestanding build — 13/13 tic-identical PROVES the bare-metal.md contract is real and complete | all 13 demos' per-tic state hashes match the golden traces on the freestanding target | 11.1 | cc:TODO |
| 11.3 | Contract-on-trial: record every gap the bring-up exposed between bare-metal.md's *predicted* contract and reality; promote bare-metal.md from claim to tested contract; refine ESP32 scoping from what the bring-up actually needed | bare-metal.md updated with "validated by freestanding bring-up [commit]"; every doc-vs-reality discrepancy recorded and resolved | 11.2 | cc:TODO |

---

## Priority matrix

- **Required** (the spine of tenet #6): 6.1–6.3 (executable archaeology — fastest, highest-credibility understanding win), 8.1–8.2 (self-enforcing invariants — the "defend" tier, and the honest fix for the golden blind spot), 11.1–11.2 (bare-metal falsification — the crown jewel; also de-risks the future ESP32 project).
- **Recommended**: 6.4, 7.1, 7.3, 8.3, 9.1, 9.2, 10.1, 11.3.
- **Optional** (diminishing returns — do a bounded pass, don't chase): 7.2 (formalize every primitive), 9.3 (map fuzz), 10.2.
- **Rejected / guardrails** (per spec tenet #3, simplicity): don't pursue intractable formal proofs — 7.2 explicitly caps at "proof OR bounded-empirical with the limit named." Don't let the divergence atlas become an open-ended survey — 10.1 is bounded to the known *major* forks. Don't add a heavyweight proof-assistant dependency if an exhaustive enumeration or a single SMT invocation suffices (7.1 prefers the lightest tool that closes the domain).

## Team validation

`team_validation_mode: manual-pass` (perspectives evaluated separately; no subagents spawned during planning).
- **Product** — every task directly serves spec tenet #6; nothing here changes gameplay or the shipped artifact (all tasks are verification tooling, proofs, invariant asserts, or docs). Reinvention check: builds on existing crackers, the native harness, and the golden gates — no duplication.
- **Architecture** — the invariant asserts (8.1) and any core instrumentation must stay behind a build flag so `engine/core` keeps zero web-layer dependency (the rule established in task 2.2's review). The freestanding target (11.1) extends `tools/native-sanitize`, honoring the documented core↔platform contract rather than forking it.
- **Security** — no new untrusted-input surface beyond the existing net fuzz; the differential fuzzer (9.1) synthesizes inputs for *offline* comparison, not network exposure. No secrets, no supply-chain additions (SMT/QEMU are dev-only tools, gated to the tasks that use them). No `.env`/secret reads required.
- **QA** — every task's DoD is a yes/no verifiable artifact + gate (a script that prints the number, an assert that fires at a line, 13/13 hashes on new hardware). The lint baseline already exists. The sim/render/net gates remain the floor; new gates only strengthen them.
- **Skeptic** — biggest risks: (a) bare-metal (Phase 11) is large scope → mitigated by the two-rung structure (minimal hosted freestanding first, QEMU second) so partial progress still validates the contract; (b) formal proofs (Phase 7) may hit intractability → mitigated by the explicit "proof OR bounded-empirical, limit named" cap; (c) the coverage audit (9.2) could surface un-exercised code that's genuinely un-understood → that's the point, and it's a finding, not a failure. No task claims completion without an artifact that a skeptic can run.

## Spec delta

Updated root `spec.md`: added **tenet #6 — "Understanding is verifiable and
self-defending"** (every documented claim regenerates from a committed script;
demo-visible invariants are enforced by the code at their call site; the platform
contract is validated by an actual freestanding port). This plan operationalizes
that tenet; precedence remains `spec.md > Plans.md`.
