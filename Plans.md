# webdoom Plans.md

Prior initiatives archived: `Plans-refinement-complete.md` (26/26),
`Plans-understanding-complete.md` (Phases 6–11),
`Plans-floor-initiative-complete.md` (Phases 12–15, 32/32 at 8305c4a).


# Planning round 3 (2026-07-21) — field fixes, music, widescreen, community tooling, the floor campaign

Contract: root `spec.md` as amended 2026-07-21 (insecure-origin tier, music
contract, widescreen sanction, floor-campaign non-goal amendment). Previous
round (Phases 12–15) complete 32/32 at 8305c4a. Size-budget rule for this
round: any task growing client JS or `doom.wasm` lands its
`size-budget.json` bump as an explicit line item in that task, never a
silent regold. Every new client module updates the SHELL precache
(`check-sw-precache` — ws-003 class).

## Phase 16: Field bugs — the insecure-origin class + persistence
[tdd:required] (every fix ships with a red-proven test)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 16.1 | Save-slot visibility: port `M_ReadSaveStrings` (m_menu.c:527) from dead POSIX `open()` to the web bridge (`Web_FileLen >= SAVESTRINGSIZE` + `Web_FileCopy`, m_misc.c pattern). Fix persist.js `tx()` key-miss (`res(out?.result)`, drop `?? out`) + `bytes instanceof Uint8Array` guard — note this revives the currently-dead legacy-key fallback | persist-test extended: post-reload F3 Load menu slot selectable AND loads; red-proven on unfixed build; sim+render goldens unchanged | - | cc:完了 [ed75a29] |
| 16.2 | Save durability: final flush on `onQuit`/`onDoomError` reading `fileMap` directly (NOT via wasm calls — the engine is dead at that point, which is why today's path fails); persist.js `sync()` catch must not abort the savegame mirror pass; wire `doom.onFileWrite` write-through (3 s interval stays as backstop) | red-proof: save→quit-within-3s→reload loses the save today, survives after; browser test in run-tests.sh | 16.1 | cc:完了 [cd77343] |
| 16.3 | WAD cache on real origins: IndexedDB WAD store keyed by sha256, consulted in `fetchWad()` as SW-unavailable fallback / SW-miss secondary (NOT a parallel duplicate cache on secure origins); `navigator.storage.persist()` requested after first cache write; user-visible degraded-mode status when SW absent; storage arithmetic (N WADs × size vs quota) documented | insecure-origin browser test (16.5 mechanism): second session fetches 0 WAD bytes from network (LOG_REQUESTS assertion); offline-SP gate stays green | - | cc:完了 [d998d90] — IDB fallback tier (wad-cache.js, skip-on-secure-SW), storage.persist(), loud lobby status, ws-014 ledger; insecure-origin test red-proven; reviewer APPROVE (4 minor non-blocking: no sha re-verify on IDB read, redundant .catch, broad test error filter, first-load orphan race — all documented) |
| 16.4 | Music on real origins: fallback sink pulling `web_music_render` when `ctx.audioWorklet` is undefined (buffer-queue AudioBufferSource chain or ScriptProcessor); replace the swallowed `console.warn` with user-visible "music: fallback/unavailable" status | DoD asserts the pump chain, not audibility (headless can't arm audio — recorded twice): rendered frames from the fallback sink's buffer are non-zero RMS + forced-`audioWorklet`-undefined unit path; localhost worklet path byte-identical | - | cc:完了 [1bffd1c] — BufferSink fallback (scheduled AudioBufferSource chain, bounded 0.25s backlog, resume re-anchor), accurate insecure-origin vs worklet-unavailable status, sinkKind/lastChunk test hooks; red→green proven; reviewer REQUEST_CHANGES round applied (status accuracy, CHROME_BIN resolver, perf-capture comment); run-tests.sh wiring deferred to 16.5 per contract |
| 16.5 | Insecure-origin CI leg: headless Chrome `--host-resolver-rules="MAP insecure.test 127.0.0.1"` → `http://insecure.test:PORT` is a genuinely insecure context; assert music-fallback frames, WAD IDB cache hit, degradation messages | leg wired in run-tests.sh; red-provable by disabling the 16.4 fallback; kills the CI-blind environment class | 16.3, 16.4 | cc:完了 [d373884] |
| 16.6a | Drag-and-drop WAD import: client-side port of wad-identify logic (magic check, KNOWN renames, lump scan for maps, vanilla-incompat rejection e.g. HACX-v2 heuristic) with malformed-input bounds tests (hostile-WAD surface, 12.3 class); landing-page drop target; sha256 via crypto.subtle; IDB library; SP boot from a local WAD | browser test drag-drops a PWAD (DataTransfer), boots SP with it, survives reload; malformed-WAD corpus rejected cleanly | 16.3 | cc:完了 [88e4925] |
| 16.6b | WAD library UI + net gating: manifest merge into existing `stackFor()`/`groups()` paths; local WADs SP-only (MP requires server library — server never sees local shas); `MAXWEBFILES`=40 / 31-char engine-name limits enforced at import; SHELL precache updated | MP gating red-proven (local WAD absent from MP picker); Firefox smoke + lobby suite green | 16.6a | cc:完了 [ca591a9] |

## Phase 17: Music flavors (the legendary options)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 17.1 | OPL2/OPL3 mode toggle in mus_opl.c (authentic mono 9-voice OPL2 vs stereo 18-voice OPL3) + settings UI. [tdd:required] | red-proof: toggle-off output byte-identical at sample level to today; smoke-test RMS gate green in both modes; no game-state reads (determinism note in code) | 16.4 | cc:完了 [6c4013a] |
| 17.2a | SoundFont GM backend: decision record FIRST (first third-party JS runtime dep: SpessaSynth Apache-2.0 in a GPLv2+ project → effective-GPLv3 distribution note in LICENSE; lazy-load, SHELL-precache exclusion, size-budget line); mus2mid (Chocolate GPL-2 or clean-room from doomwiki spec) + SpessaSynth worklet; GeneralUser GS fetched from OWN server (fetch-wads.sh pattern) with license text alongside | pump-chain frames assertion (16.4 pattern, NOT audibility); OPL stays default; no soundfont bytes in repo | 16.4 | cc:完了 [0ea61d9] |
| 17.2b | SoundFont management UX: user-loadable .sf2 via the 16.6 library (drag-drop, IDB); backend picker in settings (OPL2/OPL3/GM) | dropped .sf2 plays (frames assertion), survives reload; picker persists via persist.js | 17.2a, 16.6b | cc:完了 [412c5da] |
| 17.3 | GUS flavor via DMXGUS→pat→sf2 through the 17.2 path. Decision-gated: licensing record in spec.md required BEFORE implementation [tdd:skip:decision-gate-first] | spec.md decision record exists; if green-lit: DMXGUS mapping honored, frames assertion | 17.2a | cc:完了 [93a6929] |

## Phase 18: Widescreen (vanilla-exact wide mode, spec §Widescreen)
[tdd:required]

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 18.1 | Wide-limit telemetry + memory arithmetic: measure visplane/drawseg/openings peaks across the 13-demo suite at candidate widths (426/560/854); BSS strategy decision (static-max arrays vs runtime alloc) with RAM arithmetic vs 32 MiB INITIAL_MEMORY (14.2c) and the 14.2d/e/f vanilla-limit reverts revisited with witnesses | numbers + chosen limits committed with arithmetic; decision recorded | - | cc:完了 [aa407be] |
| 18.2a | Runtime-width plumbing at 320: width becomes runtime state, compiled default 320; full `SCREENWIDTH` audit (119 refs / 21 files, column-major layout) incl. hidden consumers (f_wipe, M_ScreenShot, am_map, hu_lib, V_CopyRect) | ALL existing sim+render+render-low goldens byte-identical (pure-refactor proof); wasm size delta recorded | 18.1 | cc:完了 [f282bea] |
| 18.2b | Hor+ wide projection: `centerxfrac_nonwide` focal/projection (Crispy scheme), WIDESCREENDELTA 2D-draw offsets, status bar 4:3-centered with flat-filled flanks | 320 goldens still byte-identical; wide render visually verified on one demo (committed screenshot) | 18.2a | cc:完了 [6cdabe8] |
| 18.2c | `web_set_wide(w)` deferred resize + wide golden family: aspect-bucket widths, `-render-wide` goldens per bucket (storage plan stated in the task); sim traces with wide ENABLED must equal existing sim goldens exactly | wide goldens recorded + gated in run-tests.sh; sim-invariance gate green; red-proven by a deliberate wide-path pixel change | 18.2b | cc:完了 [baea449] |
| 18.3 | Client wide pipeline: dynamic canvas/texture sizing (WebGL2 `texStorage2D` is immutable → recreate on resize; canvas2d fallback handled or explicitly degraded with status); aspect-bucket selection filling display width (covers the fire background); progressive Panini/cylindrical remap in the palettizing shader, strength 0 at 4:3 → moderate at 21:9+, OFF by default, outside all goldens, under the browser-pipeline baseline tolerance regime | browser-pipeline baselines extended; toggle-off = pre-existing behavior red-proven | 18.2c | cc:完了 [62468a3] |
| 18.4 | Wide exactness artillery: PRIMARY = full sim-trace invariance wide-enabled (re-run at phase end on one named commit); `web_state_hash` coverage extended (sector floor/ceiling heights + thinker count) or the gap explicitly stated in the DoD; mixed-width netgame (one wide, one 320) per-tic equality as corroborating; sprite-edge witness demo golden (r_things.c:530 cull pin); symmetric native/wasm wide differential (same argv both sides); fleet bench wide cost → perf.md | all gates green on one named commit; wide cost recorded | 18.2c, 18.3 | cc:完了 [2c0eb0b] |

## Phase 19: Vanilla-plus QoL + community tooling (playsim-read-only, enforced)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 19.1 | QoL canon batch + fullscreen button: hover fullscreen control near top edge (Fullscreen API on #stage, auto-hide, sits where Chrome's exit-fullscreen pill lives); static crosshair; level time/stats widget; demo timer + progress bar — ALL off by default [tdd:required] | render goldens unchanged with features off (red-proven per feature); feature-on browser assertions; settings persist | - | cc:完了 [3908c42] |
| 19.2 | Demo permalinks + one-click record→share: server-stored demo id PRIMARY (size cap, retention policy stated); URL-fragment embed only under a stated byte bound; receiver must own the WAD (server library or 16.6 import — stated in UI) | record→URL→second browser replays to identical FULL trace hash (sim-golden format, not web_state_hash); caps red-proven | - | cc:完了 [cbd66f3] |
| 19.3 | Replay scrubber ("demo as video"): re-sim-from-tic-0 ONLY (keyframes = decision-gated follow-up); measured seek latency cited (15.5: ~100× realtime → worst-case 44,580-tic seek ≈ 13 s, stated in UI); input timeline strip under the scrubber | scrub-to-N full-trace hash == linear-playback-at-N; seek latency measured on wbox | 19.2 | cc:完了 [0ea0f6a] |
| 19.4 | Demo verification + divergence tool (in-repo tool + endpoint behind the existing server — NOT a public service): upload size cap, replay tic cap, rate limit, retention policy; adversarial/fuzz LMP corpus green against the verify path; per-tic attestation = full trace hash; divergence visualizer names first divergent tic | 13 golden demos verify green; doctored demo pinpoints its divergence tic; hostile-corpus gate green | 19.2 | cc:完了 [484b971] |
| 19.5 | Spectator links: server retains sealed-bundle log from game start (memory bound stated), spectator fast-forwards (drop-in machinery precedent); spectator role structurally read-only server-side (cannot inject ticcmds by protocol, not by client flag); docs/netcode.md protocol delta (SSOT rule) | spectator joins mid-game, catches up, per-tic hash matches players'; injection attempt red-proven rejected; netcode.md updated | - | cc:TODO |

## Phase 20: The floor campaign (sub-spec targets, atlas-first)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 20.1 | Atlas v2: new measured rows — 386DX-40 chase budget (33–46% whole-program cut per committed arithmetic), N64 VR4300 @93.75 MHz, Genesis+Sega CD dual-68k + ASIC-visplane analysis (honest verdict: infeasible for tic-exact 35 Hz native-res by ~10×, external anchor krikzz doom-68k 1–2 fps — PARKED), sub-100 MHz MCU arithmetic (F_isa 3–5 M0+ → single-core 100 MHz is 1.4–2.3× short; dual-core + WHD required); spec amendment cross-referenced [tdd:skip:atlas-doc-task] | per-row arithmetic from committed measurements; verify-all green; parked verdicts recorded with anchors | - | cc:完了 [a2a53cf] |
| 20.1b | Track decomposition: session-sized task breakdown of 20.2–20.7 with per-task DoDs (the 13.3a lesson: new-ABI bring-up took 3 capped workers) — gates all implementation below [tdd:skip:planning-task] | decomposed tasks appended to this file with DoDs; no implementation task below starts before this lands | 20.1 | cc:TODO |
| 20.2 | Fresh optimization sweep (user directive): re-mine docs/engine-archaeology.md + per-stage attribution + game code for candidates NOT in the optimization ledger, NOT in FastDoom/rp2040-doom's known catalogs (those are 20.3); hunting grounds: attribution hot spots (bsp/segs/planes/things), column-major cache-layout effects, fixed-point kernel superoptimization; output = ranked ledger candidates with icount estimates; implementations land one-per-task via 20.1b under ledger kill rules; ANY landing requires 13/13 sim-golden tic-identity (the "provably does not affect demo playback" gate, verbatim) [tdd:skip:survey-produces-ledger-entries] | ≥5 novel candidates in optimization-ledger.md with arithmetic; each marked tic-exact-safe/unsafe with reasoning; kill rules applied | 20.1 | cc:TODO |
| 20.3 | FastDoom-class presentation-side harvest: fake-flat mode, status-bar redraw skip, potato/half-width columns, differential-blit analysis — each behind a toggle, each a separate ledger entry, visual-change modes get their OWN goldens (never touch the 320 vanilla goldens), fleet + icount measured | per-technique: toggle-off byte-identical red-proven; measured numbers on 4 hosts; ledger rows | 20.1b | cc:TODO |
| 20.4 | N64 sub-phase A (bring-up): freestanding core + libdragon shell, software render; EMULATOR (ares) leg = the repeatable gate; capture-not-cure protocol for the new-ABI landmine class (PPC signedness / ARM short-enums / MIPS alignment precedents); hardware runs via SummerCart64 UART hash logs = committed evidence, not CI | 13/13 demos tic-exact in ares leg; hardware evidence committed; fps measured both | 20.1b | cc:TODO |
| 20.5 | N64 sub-phase B (the first): RDP-rasterized columns/spans while the playsim stays bit-exact — no demo-exact vanilla port has ever shipped RDP-assisted rendering | demo-exact maintained (ares gate); measured speedup vs sub-phase A on hardware | 20.4 | cc:TODO |
| 20.6 | 386 test bed: 86Box bench harness (cycle-configurable 386DX-40 profile) + icount-scoreboard reduction campaign toward the 1,142,857 cycles/tic budget; candidates flow from 20.2/20.3 | harness committed + red-provable; campaign progress = icount deltas per landing, atlas row updated | 20.1b | cc:TODO |
| 20.7 | Sub-100 MHz floor measurement: arithmetic row first (20.1), then bounded attempt on underclocked RP2040-class silicon with WHD-style asset work; deliverable is a NUMBER — the measured minimum clock at which 13/13 demos stay tic-exact — not a promised record | measured floor clock committed with method + variance; atlas row updated | 20.1b | cc:TODO |

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
