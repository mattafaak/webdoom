# webdoom Plans.md — refinement & the measured floor initiative

作成日: 2026-07-17
Contract: root `spec.md` — tenets #2 (measure, don't assume), #5 (bare-metal
adaptability), #6 (verifiable understanding, now extended to published
promises) govern this plan.
Prior initiatives archived: `Plans-refinement-complete.md` (26/26),
`Plans-understanding-complete.md` (Phases 6–11, understanding-on-trial, all
complete; 11.1b's OS-less demo-hash stretch deferred → picked up here as 13.4).

Goal: (1) put every remaining PROMISE on trial — engine and web; (2) measure
the engine's true resource floor (instructions/tic, RAM, read-only-ness,
endianness) on the freestanding builds; (3) optimize vanilla-exact toward that
floor, bare-metal-first; (4) refine the web interface against measured browser
reality. North star converted from aspiration to arithmetic — the **retro
feasibility atlas** (13.5).

**The SNES question, answered by the Skeptic panel (externally verified):**
stock SNES fails vanilla-exact DOOM by **~20–100× on CPU** (a software 32×32
FixedMul ≈150–400 cycles; thousands per tic vs a ~102K-cycle/tic total budget
at 3.58 MHz), **~2× on RAM** (128 KB WRAM vs the rp2040-proven ~264 KB vanilla
floor), **~10× on video bandwidth** (no framebuffer; ~6 KB/vblank VRAM DMA vs
64 KB/frame) — three independent walls. Randy Linden's SNES Doom used a 21 MHz
Super FX 2 for rendering AND a from-scratch non-vanilla playsim (no infighting,
no pellet spread, altered damage). D32XR runs game logic at 15 Hz on a Jaguar
codebase — it proves renderer headroom, not vanilla playsim cost. The honest
open frontier: **no port has ever been tic-exact below ~100 MHz-class hardware**
(GBA 16.8 MHz: demo compat broken; rp2040 2×270 MHz: smallest success). The
atlas answers "how close can webdoom get" with per-row arithmetic; a quantified
"no" is a deliverable, and the 32X/GBA-class gap is the genuinely open cell.

**Kill-list** (imported from perf.md §G/Q1–Q5 — no task may re-propose without
the named reopen condition): span u32 packing (wbox +7.9%), wasm SIMD (no
gather), visplane hash (ceiling 2.9%, probe depth 6.6), Q4 sim hot paths
(absent perf.md's two reopen conditions), emcc knob re-sweeps (axes 1–5 done),
per-target wasm builds (spec non-goal), runtime lookup→transcendental
(magic-data policy), browser-fps-motivated wasm-side work (render = 1.71% and
sim = 0.25% of the 35 Hz budget on the weakest host — retrospective.md already
caught this framing error once).

**Process guardrails** (FINDING-7 + worker-cap history): file-coupled tasks run
SEQUENTIALLY; workers `git add` explicit paths only (never `-A`/`.`); cite by
function name, not line number; tasks pre-sized under the ~107-tool-call cap
with budget-briefed workers; every regold validates against a pre-change build,
never self-consistency; exit codes measured bare, never through a pipe.

---

## Phase 12: Scrutiny — every promise on trial (engine + web)
[tdd:skip:verification-tooling] (12.3/12.4b fixes: [tdd:required] per fix)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 12.1 | Promise inventory — the DELTA only (claims-index already gates 182 quantitative claims): qualitative/behavioral promises in README+spec (browsers, offline, gamepad, "readable in a sitting", HOL "unmeasurably small", prefers-reduced-motion, WAD-library breadth, systemd path), perf.md's "(not machine-verified)" figures, magic-data.md's 9 unlocatored figures. Known-stale seed: README "356 KB of wasm" (shipping = 359,574 B) | `docs/promises-index.md` maps 100% of enumerated promises → {gate \| committed evidence \| FLAGGED}; drift checker extended to README+spec published figures and FAILS on divergence (the 6.5 pattern); count committed | - | cc:完了 [7db1096] — promises-index.md 44 entries (19 gated / 5 evidenced / 20 flagged w/ owning task); doc-drift gate extended to README+spec (readme-guard 1/1, spec-guard 3/3, public-doc 7→14 figures); README stale "356 KB" fixed AND gated; drift-proved (351→999 ⇒ FAIL readme-001 exit 1 ⇒ revert ⇒ green). **REVIEW CATCH (iteration 1)**: worker derived the README figure from perf.md's COMMIT-PINNED 357,978 (⇒"350") — stamp-check on master says 359,566 ⇒ **351 KB**; the new gate would have enshrined a wrong number while green. Rule recorded: artifact unmeasurable in the worktree ⇒ ask the lead for the measured value, never substitute a historical pinned figure. Bonus finding: claims.json _summary stale since 7.2, recomputed (150 total). Gates on master: doc-drift 0, lint 0, verify-all ALL PASS |
| 12.2a | Browser pipeline, cheap pass: CDP `Performance.getMetrics` per-frame aggregate diff (perf.md §C names this a ~2-line step on the browser-test.mjs `cdp()` helper) | aggregate frame metrics committed for ≥2 fleet hosts; go/no-go note on which stages merit 12.2b marks | - | cc:完了 [5583968] — tools/browser-metrics.mjs + JSONs for **alder AND wbox** (the weakest host); perf.md §C results subsection. Headline: browser main-thread JS = **3.0% of wall on alder, 0.97% on wbox** (rAF rate-limited there — honest artefact caveat recorded), Layout/RecalcStyle deltas exactly 0 during play, V8 heap 1.5–1.9 MB. Go/no-go for 12.2b: rAF jitter + AudioWorklet + input latency MERIT marks; palette expand + texSubImage2D ruled negligible by aggregate. **REVIEW CATCH (iteration 1)**: worker's input-latency verdict said NEGLIGIBLE from "3% CPU headroom" — category error (throughput vs queueing delay) that contradicted promises-index (which owes a committed latency number, owner 12.2b); fixed to MERITS 12.2b. Gates: doc-drift 0 / lint 0 / browser-test 0; claims-index line hints re-pinned after §C insertion |
| 12.2b | Browser pipeline, real pass (perf.md Q0 "DO FIRST" — the known UNMEASURED gap): `performance.mark` instrumentation of the palette expand, texSubImage2D upload, rAF jitter, AudioWorklet cost, input-event→ticcmd→pixel latency. Full-trace option-1 explicitly forbidden (perf.md dis-recommends) | committed script regenerates a per-frame profile (≥100 frames) on ≥2 fleet hosts; baseline JSON mirrors bench-baseline.json; EVERY perf.md NEEDS-Q0 verdict re-adjudicated with the new data | 12.2a | cc:完了 [fcdc5a6] — ?perfmarks=1 marks (zero-cost off) across 5 stages; browser-pipeline.mjs + baselines for alder AND wbox; both NEEDS-Q0 verdicts re-adjudicated in place (JS side measured non-dominant — browser-fps motivation for wasm work stays dead); spc-004+spc-006 promises EVIDENCED; **input latency measured: alder p50 8–9 ms = half-frame quantization (frame interval, not JS cost)**. AudioWorklet honestly n=0 (headless Chrome never arms AudioContext — instrumentation ready, needs interactive run; residual for 15.2). **Worker died at cap mid-validation (2nd occurrence this loop); lead finished**: re-pinned perf-036/039 locators, 3rd independent collector run reproduced baselines (PASS), added strict unknown-arg rejection after diagnosing a confusing failure — positional URL silently ignored ⇒ DEFAULT_URL hit a STALE MAIN-REPO SERVER (long-running serve.js on 8666) whose uninstrumented client booted fine — the run-fuzz loud-fail lesson, now applied. Gates: doc-drift/citations/lint 0, browser suite green. **PHASE 12 COMPLETE** |
| 12.3 | Tenet-4 robustness closure: fix the 9.3-recorded no-player-start null-deref fail-soft; adversarial map corpus runs ASan-clean natively (I_Error allowed, memory corruption NOT); wasm client returns to landing on engine I_Error instead of wedging | each fixed path has a regression test; adversarial corpus green under the stated rule; browser I_Error → landing proven by a committed browser test | - | cc:完了 [a606528] — 3 fail-soft guards in p_setup.c (sidedef→sector incl. negatives, linedef sidenum[0]/[1], missing-player-start w/ zeroed playerstarts sentinel); onDoomError → restoreOnFailure + loop stop ('running' hoisted for pre-loop I_Error); run-map-fuzz **--adversarial-gate** (30 I_Error / 0 sanitizer vs 9.3's recorded traps) + browser-ierror-test, both wired into run-tests.sh. **Worker died at 100-call cap pre-validation; lead finished (8.1 precedent)**: caught the negative-sidenum hole (-5 passed `!=-1 && >=numsides`), the 9.1b-class vacuous pass (gate without nat-doom silently downgraded to wasm-only — now loud GATE FAIL, drift-proved), folded duplicated landing-restore into restoreOnFailure(). Full gates lead-run: sim+render+invariants 13/13, fuzz-fast 20/20, adv-gate 30/0, browser×2, lint/doc-drift/citations 0. Shipping wasm rebuilt 360,187 B → README size gate took its FIRST legit update (351→352 KB via documented command). Residual noted for 12.4a: drop-in player on a start-less map (G_DoReborn path) is theoretical-only, unreached by valid IWADs |
| 12.4a | Web scrutiny ledger — client/js (~2.3k lines) + server (~0.6k lines) + sw.js, every file. Panel-found seeds: main.js per-frame catch swallows ALL exceptions → frozen canvas wedge; onDoomError hides panel but never restores landing; sw.js SHELL precache omits fire.js/countdown.js (offline-by-accident); sw.js skipWaiting mid-game semantics; serve.js static HTTP path has zero tests | findings ledger committed, every file covered, each finding disposed fix / won't-fix-with-reason; ledger is read-only (fixes live in 12.4b/15.3) | - | cc:完了 [9264b19] — docs/web-scrutiny.md: 13 findings / 18 files (2 high, 3 med, 7 low, 1 already-fixed-by-12.3), every file in the coverage table incl. honest 0-rows; all 6 seeds dispositioned. **Two NEW real bugs beyond the seeds**: ws-008 persist.js setInterval never cleared — pokes dead wasm after quit→reboot (lead-verified: no clearInterval in file); ws-010 settings.js writes legacy `mouseMove` key that input.js migration DELETES on load — checkbox permanently inert once `mouseY` exists (lead-verified against input.js migration). ws-005 serve.js traversal: on-paper bypass attempts recorded, guard held. 6 rows → 12.4b, 1 → 15.3, ws-004 skipWaiting mid-game swap won't-fix w/ mitigation noted. Worker: 40 calls, clean first-pass APPROVE (no review iterations needed) |
| 12.4b | Apply the ledger's Required fixes (server side + sw.js precache pin) + add server static-HTTP fuzz/malformed-path cases to run-tests.sh | every applied fix carries a test; HTTP fuzz in run-tests.sh green; precache list pinned against `client/js/*` by a build-time check (no sw manifest machinery — tenet #3) | 12.4a | cc:完了 [6b7968b] — all 6 fix(12.4b) rows: ws-003 precache (+check-sw-precache.mjs pin, drift-proved), ws-007 audio listener leak, ws-008 persist interval teardown (syncHandle.stop in onQuit AND onDoomError; persist-test Phase 3), ws-010 settings mouseY key, ws-012 AudioContext try/catch, ws-013 gamepad optional-chain; + http-fuzz-test.mjs 15 cases; both wired into run-tests.sh. **REVIEW CATCHES (lead)**: (1) worker DELETED the pre-freelook migration (legacy stored mouseMove:true would silently lose the user's 1993-style pref) — restored before the key strip; (2) worker's rc_lines showed the browser suite was never actually run — lead ran all 6 (browser/lobby/resilience/fire/ierror/persist) + both new gates: ALL RC=0. Ledger dispositions updated to fixed(12.4b) |
| 12.5 | Chocolate cross-validation re-enablement (blocked on SDL2 since 8.2): install SDL2 dev pkgs, `build-choco-reference.sh`, `demo-test.mjs --cross` | the strongest external oracle green again (44,580-tic cross-check reproduced on current master) BEFORE Phase 14 touches the engine | - | cc:完了 [b2525df] — the 8.2-era blocker no longer exists (lead: SDL2 present at system level on CachyOS — sdl2-compat 2.32.70/mixer/net; NO sudo, NO install needed; the old note's apt instructions were debian-flavored, script itself was already portable cmake+pkg-config, zero changes). build-choco-reference RC=0; `demo-test.mjs --cross` **13/13 demos, 44,580 tics bit-identical — exactly the 8.2-era figure, now re-confirmed on a master that includes 12.3's new map-load guards**. 4 promise rows FLAGGED→EVIDENCED (rme-007/spc-007/prf-004/mda-015) with dated reproducers; summary arithmetic consistent. Worker: 37 calls, clean first-pass APPROVE. **PHASE 12 REMAINING: 12.2b only** |

## Phase 13: The measured floor (bare-metal falsification, continued)
[tdd:skip:measurement-harness-is-the-test]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 13.1a | Cycle-floor harness: deterministic per-tic instruction counts on fs-doom/nat-doom (callgrind Ir / `perf stat` / qemu icount — noise-free, unlike the wall-clock benches that were noise-limited at ~0.001 ms) | committed script regenerates whole-program instructions/tic for all 13 demos: avg AND p99/max per tic (35 Hz is a deadline; texture-composite frames spike) | - | cc:完了 [1f36f1f] — **the project's first cycle-floor numbers**: per-IWAD avg instr/tic = doom 1.218M / doom2 1.306M / tnt 1.308M / plutonia 1.354M (full sim+render, x86-64 user-space retired instructions via perf_event_open in the fs-doom SHIM — engine/core ZERO diff); worst p99 = 2.693M (doom-demo4); max tics are level-load boundaries (excluded from floor analysis). First atlas arithmetic: a 2×23 MHz 32X-class budget (~657K cycles/tic/CPU) is ~2× short of the x86 instr count — NOT the 20–100× SNES wall; the open cell stays open. FINDING: pe.size=0 required for -m32 compat-mode perf_event_open (sizeof silently yields zero counts). Variance honestly 1.3–9.9% (vDSO/scheduling noise; p50 recommended as the comparison metric — NOT hidden). Sim-untouched proven: 13/13 hashes identical in counting AND normal modes; run-check green from master. Gates: doc-drift/citations/lint 0. Worker: 85 calls, clean first-pass APPROVE |
| 13.1b | Per-subsystem attribution: callgrind inclusive costs mapped to the established bench stages (sim vs bsp+segs vs planes vs masked) | committed table, regenerable by one script; stage sums reconcile against whole-program counts; this becomes Phase 14's scoreboard | 13.1a | cc:完了 [56c53fd] — fs shim's perf layer reads the SAME perf_event fd at core's existing stage brackets (engine/ ZERO diff, verified) ⇒ reconciliation **exact 0.0000% by construction** all 13 demos ×2. **THE HEADLINE THE ATLAS NEEDED: sim = 3.4–8.3% of whole-program — sim p50 per IWAD = 48–87K instr/tic** (render: bsp 40–53% dominant, planes 25–44%; rank order matches wall-clock §A). First 32X-cell arithmetic: worst-IWAD sim ≈13% of ONE 23 MHz SH-2's 657K cycles/tic budget pre-ISA-conversion — sim-only tic-exact on 32X-class looks plausible; 13.5 formalizes. KEY CAVEAT (FINDING-2): instr share ≠ wall share (sim 3–8% instr vs 0.25% wall — render pays cache misses instructions don't see) ⇒ atlas conversion factors need memory-system error bars, not just ISA ratios. 13.1a consistency: render WAS on in both. Gates: fs run-check 13/13 from master, doc-drift/citations/lint 0. Worker: 76 calls, clean first-pass APPROVE |
| 13.2a | Zone floor, decisive cheap step: re-run the 4 MB and 8 MB ZONESIZE render+net gates on post-3.2 master (task 2.5's failures predate the dc_texheight OOB fixes — they may simply vanish) | pass/fail per size recorded with the render gate AND the 4-client net gate (zone backs thinker allocations); if failures persist, failing golden set named | - | cc:完了 [e3ba4ec] — **both 4 MiB AND 8 MiB pass everything**: sim 13/13, render 13/13 pixel-identical (0 failing goldens vs 2.5-era's 10/6), 4-client net ~1385 tics 0 mismatches, both sizes. Verdict: **the 2.5 failures were ENTIRELY the dc_texheight OOB layout-pinning (fixed 3.1/3.2); PU_CACHE use-after-purge FALSIFIED** for the 13-demo corpus. The credible zone floor drops 32→4 MiB (demo-proven; bare-metal.md §2.2's 4 MiB first-pass guidance now evidence-backed). Shipping ZONESIZE unchanged (14.x decision, needs 13.2b render-ON HWM). Sanctioned plumbing only: web.h #ifndef guard + net-test --build-dir (demo-test precedent). Worst-PWAD case honestly not-exercised (no existing script; Axis-4 figure is static analysis). Shipping wasm md5 untouched. Worker: 56 calls, clean first-pass APPROVE |
| 13.2b | Render-enabled zone instrumentation (the retrospective.md trap: -nodraw HWM is proven NOT a safe floor): peak + purge counts with rendering ON, flag-guarded, off the shipping build | render-ON HWM + purge-pressure numbers committed per IWAD; shipping wasm byte-identical with the flag off (8.1 md5 precedent); a defensible minimum ZONESIZE stated with its evidence | 13.2a | cc:完了 [3cfdbcc] — WEB_PERF_ZONE_STATS (perf.h family precedent) in z_zone.c incl. Z_ChangeTag2 np/p migration tracking; zone-stats.sh → zone-stats.json (13 demos × {32M, 4M} × 2 passes, **byte counters fully deterministic across passes**). **The honest render-ON numbers: non-purgeable HWM worst 0.98 MiB (tnt-demo3); purgeable cache retention grows to 10.49 MiB total HWM when a 32 MiB zone lets it; at 4 MiB the purge machinery sustains 248–1397 purges/demo (worst plutonia-demo1) with 13/13 bit-identical hashes — defensible minimum: 4 MiB** (np-HWM ~1 MiB + working cache; purging proven correct under pressure, not just 'happens to pass'). Byte-identity proven TWICE: worker in worktree + lead rebuild on master post-pick (md5 5d3464dc… both). z_zone.c:391 diagnostic = vanilla's own (unsigned)block->user quirk, inherited canon, not this diff. Gates: fs run-check 13/13, doc-drift/citations/lint 0. Worker: 92 calls (context-split mid-session, resumed clean), first-pass APPROVE |
| 13.2c | Read-only-WAD proof (XIP feasibility): mprotect the fs-doom WAD blob PROT_READ, run 13 demos; verify the BLOCKMAP in-place byte-swap (bare-metal.md §5.1) hits the zone copy, not the blob | 13/13 green under PROT_READ or every writer named+dispositioned; result recorded in bare-metal.md §2.3 (this doubles as a trap for 13.4's wild write) | - | cc:完了 [bf746d5] — **WAD blob proven READ-ONLY over all 13 demos (mprotect PROT_READ, SIGSEGV trap never fired) ⇒ XIP-viable**. BLOCKMAP question answered definitively: W_CacheLumpNum always Z_Mallocs a zone copy (W_ReadLump memcpy's INTO it); P_LoadBlockMap's SHORT() swap operates on that copy, never the blob — XIP-safe on LE AND BE. WD_RO_WAD=1 mode + ro-wad-check.sh committed; the trap stays armed for 13.4 wild-write triage (a blob write now produces a NAMED SIGSEGV with faulting address). bare-metal.md §2.3 verdict recorded. Gates all 0. Worker: 54 calls, 18 turns, clean first-pass APPROVE |
| 13.3a | Big-endian trial, rung A — the first BE execution in repo history (SwapSHORT/LONG are identity macros, proven unreachable on LE by 9.2b): qemu-user m68k fs-doom (BE, tolerates unaligned — isolates pure byte-order bugs) | 13/13 per-tic hashes bit-identical on m68k; Swap implementations live inside the sanctioned `#ifdef` in m_swap.h; LE wasm proven byte-identical to master; bare-metal.md §5.1 promoted prediction→tested | - | cc:完了 [673dcaf] — **FIRST BIG-ENDIAN EXECUTION IN PROJECT HISTORY: 13/13 bit-identical on PowerPC** (ladder: m68k LLVM-experimental → powerpc-linux-musleabi via zig cc + qemu-ppc-static; rung-A semantics preserved — PPC tolerates unaligned integer loads). Swaps in m_swap.c's vanilla #else (LE-dead: shipping wasm md5 unchanged, proven). **ROOT CAUSE was char signedness** (PPC/ARM ABIs default unsigned; engine inherits x86 signed) — -fsigned-char ⇒ 13/13; doctrine gap → bare-metal.md §5.1 item 6 + §8 held-with-gap row; **ARM carry-forward flagged for 13.4b**. Hard-won: worker capped 3× (106+107+111 calls; bounded-capture protocol kept evidence durable); **lead REFUTED the worker's tables/libm root-cause claim via the armed TABLES_CRC contradiction** (unconditionally defined in tables_fix.h; PPC musl PASSED = third-libm validation of the trig recipe — a positive finding extracted from a wrong hypothesis) and made the char-signedness diagnosis. Also caught: stale instrumented fs-doom binary masquerading as an x86 regression (clean rebuild 13/13). be-build/be-check/BE-NOTES committed. Gates all 0 |
| 13.3b | Big-endian trial, rung B — BE + strict alignment: qemu-user mips BE, exercising bare-metal.md §5.2's 7 unaligned-access sites (r_data.c columnofs is per-frame) | 13/13 on mips BE; §5.2's site list validated or corrected; any core fix follows the 13.4b core-touch policy | 13.3a, 13.4a | cc:TODO |
| 13.4a | Rung-2 fault CAPTURE (not cure — never brief "debug until fixed"): exception vectors + fault handler in tools/baremetal; pin the 11.1b wild write (known: PC ~0x800000 below code, sp=0, stack relocation ruled out; candidates: baked-WAD offset, unaligned access) | faulting PC + faulting write address + named candidate site committed to tools/baremetal/README.md — all three yes/no | - | cc:TODO |
| 13.4b | Rung-2 fix + the deferred crown-jewel stretch: R_InitData completes, OS-less ARM streams per-tic UART hashes. Core-touch policy (pre-decided): alignment fixes are EITHER a strict-alignment-guarded macro override (with 13.3b CI keeping it exercised) OR a universal helper proven wasm-perf-neutral (13.1a counts) and render-pixel-identical | 13/13 per-tic hashes match goldens over the emulated UART, NO OS — retroactively completes 11.1b's stretch and upgrades 11.2 from hosted-freestanding to OS-less; bare-metal.md §8 updated | 13.4a | cc:TODO |
| 13.5 | Retro feasibility atlas — the north star as arithmetic: rows = stock SNES, SNES+SuperFX2, 32X, GBA, 386/486, ESP32-S3, RP2040; columns = measured webdoom floors (13.1b instructions/tic avg+p99, 13.2b RAM, 13.2c ROM/XIP split) vs platform budgets, conversion factor with stated error bars, verdict as a RATIO. Prior-art anchor rows: rp2040-doom (264 KB but 2×270 MHz, WHD compression), GBADoom (demo-compat broken), D32XR (15 Hz logic, Jaguar codebase) — "what tic-exact vanilla costs vs what prior art paid to ship". Stock SNES = paper verdict (the arithmetic is conclusive); 32X/GBA-class = the open cells | `docs/feasibility-atlas.md`: every row shows its arithmetic in-repo (perf.md §A precedent); UNMEASURED cells labeled UNMEASURED, never extrapolated silently; verdicts cross-checked against the external anchors; wired into the claims drift gate | 13.1b, 13.2b, 13.2c | cc:TODO |

## Phase 14: Vanilla-exact optimization, floor-driven
[tdd:skip:gates-are-the-test] — every landing passes sim+render goldens,
invariant build, fuzz fast tier; regolds only against a pre-change build.
Wins are claimed in 13.1 units (instructions/tic) and CI/bare-metal throughput,
NEVER browser fps (perf.md §B: render is 1.71% of the browser budget).

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 14.1 | Candidate ledger from 13.1b attribution + archaeology understanding. Each row: mechanism, predicted Δinstructions/tic, axis (cycle-floor / RAM / size / simplicity / portability), magic-data policy check, kill rule ("wbox regression = kill"). Kill-list imported verbatim; browser-motivated rows BLOCKED until 12.2b data exists. Known seeds: framebuffer transposition (2.2's deferred architectural item), low-detail mode as a bare-metal option, BSS diet (visplanes ≈569 KiB + openings 160 KiB + drawsegs 120 KiB) if 13.2b motivates it | committed ledger; every candidate has all five fields; one follow-up task PER surviving candidate appended to this table (not monoliths) | 13.1b, 12.2b | cc:TODO |
| 14.2 | (emitted by 14.1 — one task per surviving candidate; placeholder, do not start) | per candidate: before/after 13.1 counts + four-host bench (or universal-axes justification per spec tenet #2); sim + render + invariant + fuzz-fast green | 14.1 | cc:TODO |
| 14.3 | Size ledger gate: extend stamp-check.mjs into a CI-tracked size ledger (wasm raw+gzip, fs-doom .text) with a committed byte budget; README's size figure regenerates from the build | run-tests.sh FAILS if doom.wasm exceeds budget; README figure can never go stale again (kills the 12.1 seed permanently); several "(not machine-verified)" size claims close | - | cc:TODO |
| 14.4 | Phase release gate: the full artillery on the phase's final state — invariant build 13/13, 1000-seed fuzz FULL tier, render+sim+net goldens, 4-host fleet bench (interleaved 3-rep protocol, FLEET_PI5 env documented in the brief) | all gates green on one named commit; results recorded in perf.md with before/after vs the phase-start baseline | 14.2 | cc:TODO |

## Phase 15: Web interface refinement (measured, not vibes)
[tdd:required] (fixes ship with their tests)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 15.1 | Offline SP gate — the promise with a latent bug behind it (precache rot): a committed test loads the app, goes network-disabled, reloads, boots single-player | offline gate in run-tests.sh; fails today's precache-rot class (proven by reverting the 12.4b pin); green after | 12.4b | cc:TODO |
| 15.2 | Browser baseline in CI + the browser-matrix decision: wire the 12.2b JSON into run-tests.sh with regression comparison; decide Firefox (add a smoke leg and keep README's claim, or de-promise) — decision recorded in spec.md | baseline comparison runs in CI; Firefox either smoke-tested in CI or README+spec amended; Safari/iOS recorded as explicit non-goal | 12.2b | cc:TODO |
| 15.3 | Client error-path UX: the main.js wedge pair (per-frame catch-all → frozen canvas; onDoomError → no landing restore) + any 12.4a Required client findings — return-to-landing on every engine death, message shown | each path has a browser test that kills the engine and asserts landing restore + user-visible message; no silent wedge remains in the 12.4a ledger | 12.4a | cc:TODO |
| 15.4 | State-machine gate: mechanical cross-check that every docs/state-machine.md edge ID maps to a live test (the edge→test table is machine-checkable) + root-cause the T07 ~1/3-pass lobby flake (a flaky gate trains people to ignore red) | edge↔test checker in run-tests.sh, fails on an unmapped edge; T07 either fixed (≥19/20 pass) or quarantined WITH a replacement test covering its edges | - | cc:TODO |
| 15.5 | Persistence + netcode UX numbers: persist.js round-trip test (save/config survives reload); measure the promised-but-unmeasured net numbers — stall length at the grace boundary, drop-in catch-up duration on the weakest host, LAN/tailnet HOL blocking (spec.md's "unmeasurably small" gets a number) | round-trip test green in CI; three measured numbers committed and linked from promises-index; the HOL number either confirms the no-WebRTC scope decision or triggers a spec conversation (NOT a transport task) | - | cc:TODO |

---

## Priority matrix

- **Required**: 12.1 (promise gate — a README number is wrong TODAY; cheapest
  credibility win), 12.2a+b (the keystone — every browser claim and half of
  Phase 14's scoping depend on it), 12.3 (tenet-4 debt, known null-deref),
  12.5 (external oracle back before optimizing), 13.1a+b (the measurement
  substrate — sequence-critical, before ALL of Phase 14), 13.4a+b (the one
  open falsification of the crown-jewel contract), 13.3a (first-ever BE
  execution), 14.1, 15.1, 15.3.
- **Recommended**: 12.4a+b, 13.2a→c, 13.3b, 13.5 (the atlas — the north star
  deliverable), 14.3, 15.2, 15.4, 15.5.
- **Optional**: individual 14.2 candidates beyond the first two survivors
  (diminishing returns governed by the ledger's own kill rules).
- **Rejected / guardrails**: actual SNES/32X/GBA hardware bring-up (the atlas
  IS the deliverable; a port is a future project that starts from it); any
  kill-list re-litigation; browser-fps-motivated wasm work before 12.2b;
  WebRTC/UDP transport revisit (unless 15.5's HOL number comes back non-small
  — then it's a spec change, not a task); sw.js versioned-manifest machinery
  (the fix is a precache pin, tenet #3); -Os for the universal artifact
  (−9.3% wbox sim — bare-metal flash builds may revisit).

## Sequencing spine (hard edges)

13.1 before all 14.x (deterministic counts are the scoreboard) · 12.2 before
15.2 and before any browser-motivated candidate · 13.2a before 13.2b (may
dissolve it) · 13.4a before 13.3b (alignment findings interact) · 12.5 before
Phase 14 landings (external oracle armed).

## Team validation

`team_validation_mode: subagent` — three independent perspectives, run during
planning (2026-07-17):
- **Skeptic (+external research)** — verified SNES/D32XR/rp2040-doom/GBADoom
  facts against primary sources; premise verdict "stock SNES: no, by ~20–100×
  CPU / ~2× RAM / ~10× video, independently"; reframed the north star as the
  falsifiable atlas; risks: exactness-breaking opts (→ gates + regold
  discipline), wrong-metric optimization (→ icount scoreboard), hand-waved
  conversion factors (→ per-row arithmetic + external anchors), non-vanilla
  renderer scope creep (→ pixel-identical rule), evidence inflation (→
  numbers with in-repo arithmetic, exit codes bare).
- **Architecture+Perf** — reinvention check: zone floor partially done (2.5)
  with the decisive re-run named; XIP mostly designed (§2.3), open delta =
  PROT_READ proof; BE genuinely first; render queue mined out (kill-list);
  13.1 fixes Phase 14's noise-limit problem; universal-artifact byte-identity
  clauses required on every core touch; 13.4b core-touch policy pre-decided;
  all tasks split under the worker cap.
- **Product+QA** — promise-audit seed (13 unbacked promises incl. one stale
  today + a latent sw.js precache bug + two user-wedging error paths found by
  inspection); web track expanded from 3 vague tasks to 7 concrete gated ones;
  six permanent gates specified; spec deltas drafted; browser-fps-before-Q0
  flagged as a documented past mistake.

## Spec delta

Applied to root `spec.md` (consumer to approve/amend):
1. **Tenet #6 extended** — published promises (README + spec) now inside the
   verifiable-understanding rule: every quantitative/behavioral claim maps to
   a gate, committed evidence, or an explicit FLAGGED entry.
2. **Perf gate amended** — the browser-pipeline baseline joins the gate once
   Phase 12 lands.
3. **Non-goals extended** — actual retro-console ports (the feasibility atlas
   is the deliverable); Safari/iOS/mobile-touch not promised (Firefox status
   to be decided by 15.2 and recorded).
