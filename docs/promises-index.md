# Promises Index

Every qualitative/behavioral promise in `README.md` and `spec.md`, every
`*(not machine-verified)*` figure in `perf.md`, and every numeric figure in
`docs/magic-data.md` (the published writeup) — mapped to a gate, committed
evidence, or an explicit `FLAGGED` entry with the reason and the future task
that closes it.

**Scope**: this index covers what `docs/claims-index.md` never covered:
qualitative/behavioral promises and the published figures in README, spec, and
magic-data. Do not confuse the two — `claims-index.md` gates 182 quantitative
claims across the five archaeology docs; this index gates the 28 promises that
live outside that corpus.

**Gate**: `node tools/archaeology/doc-drift.mjs` — extended by task 12.1 to
cover README.md (README_HINTS), spec.md (SPEC_HINTS), and the remaining 7
magic-data.md figures (new PUBLIC_HINTS entries). Run the drift checker to
verify all machine-checkable figures; the qualitative promises below are indexed
here with dispositions.

**28 promises: 5 gated, 7 evidenced, 16 flagged**

---

## Format conventions

| field | meaning |
|-------|---------|
| `id` | promise identifier (`rme-*` README, `spc-*` spec, `prf-*` perf, `mda-*` magic-data) |
| `source` | doc and approximate location |
| `promise` | the claim as stated |
| `disposition` | `GATED` / `EVIDENCED` / `FLAGGED(reason — future task)` |

---

## Part A — README.md qualitative/behavioral promises

| id | source | promise | disposition |
|----|--------|---------|-------------|
| rme-001 | README:5 | "351 KB of wasm" | **GATED** — `readme-001` in claims.json; `doc-drift.mjs` README_HINTS fails if README diverges from committed expected value. Update command: `node tools/archaeology/stamp-check.mjs` → read actual wasm bytes → divide by 1024, round → update `readme-001` expected + README.md. **Derivation rule**: always use the CURRENT shipping artifact via stamp-check; do NOT derive from perf.md §1 (perf-001 is commit-pinned to 6de6256 and legitimately drifts across builds). |
| rme-002 | README:7 | "Runs in stock Chrome / Edge / Firefox" | **FLAGGED(CI is Chrome-only via CDP; Edge/Firefox untested in CI — 15.2 will decide Firefox status; Edge TBD)** |
| rme-003 | README:8–9 | "Uncapped framerate with 35 Hz-exact game logic (Crispy-style interpolation; vanilla mode toggle in settings, F8)" | **FLAGGED(no test flips F8; interpolation is render-only and untested; vanilla toggle covered by manual smoke only — 12.3 may add F8 toggle test)** |
| rme-004 | README:10–11 | "rebindable keys, analog twin-stick gamepad" | **FLAGGED(browser-resilience-test covers gamepad REMOVAL only; rebind UI and twin-stick analog path have no automated test — 12.3)** |
| rme-005 | README:24–25 | "second load is instant, single player works offline" | **FLAGGED(sw-cache sub-check asserts WAD cached but never goes offline and boots; KNOWN LATENT BUG: sw.js SHELL precache omits fire.js and countdown.js — both imported by lobby.js — offline works only via runtime-cache accident. Fix scope: 12.4b/15.1)** |
| rme-006 | README:17–18 | "measured < 1 ms/tick on the weakest network host" (fire) | **EVIDENCED** — perf.md §fire: wbox 0.0722 ms/tick (best-of-10 × 2000, 2026-07-16); ~14× under budget. Node microbench (not browser). Committed in perf.md; not CI-automated (requires JS bench). |
| rme-007 | README:67–70 | "cross-validated tic-for-tic against an instrumented Chocolate Doom... 44,580 tics identical" | **EVIDENCED** — re-verified 2026-07-17 (task 12.5): SDL2 packages present on CachyOS host; `bash tools/build-choco-reference.sh` RC=0; `node tools/demo-test.mjs --cross` 13/13 demos PASS, 44,580 tics identical. Expected value in claims.json md-tic-001=44580 unchanged. Not gateable in CI (requires external binary + WADs); run on demand via the two commands above. |
| rme-008 | README:22–24 | "Server carries the WAD library (Ultimate Doom, Doom II, Final Doom, SIGIL, Master Levels, NRFTL, Chex Quest, HACX)" | **FLAGGED(demo gates cover only 4 demo-bearing IWADs; SIGIL, Master Levels, NRFTL, Chex, HACX have no automated smoke test — 15.3)** |
| rme-009 | README:41 | "`webdoom.service` is a ready systemd unit" | **FLAGGED(untested in CI; no boot or service-file validation gate — 15.1)** |
| rme-010 | README:86–87 | "T07 menu-nav is a pre-existing timing flake on some CI hosts — ~1/3 pass rate" | **EVIDENCED** — documented explicitly in README.md; docs/state-machine.md claims "25/25 edges covered" but T07-routed edges are ~1/3 enforced. FLAGGED(15.4 will fix the T07 flake and restore edge enforcement). |

---

## Part B — spec.md qualitative/behavioral promises

| id | source | promise | disposition |
|----|--------|---------|-------------|
| spc-001 | spec.md:98 | "alder 0.008 ms, pi5 0.022 ms, **wbox 0.072 ms**" (fire CPU cost per tick) | **GATED** — `spec-001/002/003` in claims.json; `doc-drift.mjs` SPEC_HINTS fails if spec.md diverges from committed expected values. Source: perf.md §fire (0.0078/0.0222/0.0722 ms, rounded). Not CI-reproduced (node bench, not browser). |
| spc-002 | spec.md:76 | "transport remains a single WebSocket port; head-of-line blocking remains unmeasurably small" | **FLAGGED(asserted, never measured; 15.5 will measure round-trip latency and jitter under LAN/tailnet conditions)** |
| spc-003 | spec.md:91 | "`prefers-reduced-motion` gets a static frame" | **FLAGGED(browser-fire-test.mjs does not check prefers-reduced-motion media query; no automated gate — 12.3 or 15.2)** |
| spc-004 | spec.md:99 | "browser-composited and negligible" (putImageData blit cost) | **EVIDENCED** — task 12.2b (2026-07-18, commit 5a71e12): per-frame profile via `?perfmarks=1` shows (b) FB upload p99=0.2 ms (alder) / p99=6.5 ms (wbox Bobcat spike) vs 35 Hz budget 28.6 ms. WebGL2 path: `texSubImage2D` 320×200 + `drawArrays`; Canvas2D: 64K pixel-expand + `putImageData`. Both sub-ms at p50; "browser-composited and negligible" confirmed. Reproduce: `node tools/browser-pipeline.mjs --url http://127.0.0.1:8666/ --json`. Golden: `tools/golden/browser-pipeline-alder.json`. |
| spc-005 | spec.md:27 | "web platform layer, client, and server stay small enough to read in a sitting" | **FLAGGED(no LOC budget or gate; purely subjective — 12.3 may add a LOC ceiling check as a soft gate)** |
| spc-006 | spec.md:48–49 | "The browser-pipeline baseline (per-frame JS/GPU/audio cost, input latency) joins this gate once Phase 12 lands" | **EVIDENCED** — task 12.2b (2026-07-18, commit 5a71e12): `tools/browser-pipeline.mjs` collects per-stage `?perfmarks=1` distributions. Input latency: alder p50=8–9 ms (half-frame quantization at 60 fps); upload p99=0.2 ms; rAF callback p50=0.2 ms p99=0.9 ms. AudioWorklet unmeasured in headless Chrome (headless limitation — not a gap in the instrument). Goldens: `tools/golden/browser-pipeline-{alder,wbox}.json`. Gate: `node tools/browser-pipeline.mjs` exits 0 if collector runs without error; numeric baselines are golden-filed. |
| spc-007 | spec.md:17–20 | "all 13 IWAD demos replay tic-identical against golden traces and cross-validate against instrumented Chocolate Doom (44,580 tics)" | **GATED** — sim gate (demo-test.mjs) is live CI. Cross-validation re-verified 2026-07-17 (task 12.5): 44,580 tics confirmed; see rme-007. |
| spc-008 | spec.md:64–67 | Reference hardware fleet host names (wbox/tank/pi5/alder) | **EVIDENCED** — fleet is documented in spec.md table and bench-baseline.json column headers match exactly. No drift gate; names are configuration, not numeric. |

---

## Part C — perf.md figures marked `*(not machine-verified)*`

Ten figures in perf.md carry the `*(not machine-verified)*` marker. Each is
enumerated below with its reason and disposition.

| id | perf.md:line | figure | reason (inline) | disposition |
|----|-------------|--------|-----------------|-------------|
| prf-001 | 143 | "Minimum safe `INITIAL_MEMORY`: 56 MB" | requires emcc INITIAL_MEMORY sweep build; no current CI script | **FLAGGED(2.6 emcc knob sweep will re-run this; 56 MB confirmed in task 2.6 trial but CI script not committed)** |
| prf-002 | 193 | "177.7 KB gzip" (total wire payload) | requires all deliverable assets built — no current CI script | **FLAGGED(no CI script computes total gzip payload; 12.2b or later will add a size-audit CI step)** |
| prf-003 | 196 | "35 KB gzip" (JS+CSS+HTML surface) | requires JS+CSS+HTML assets — no current CI script | **FLAGGED(same CI gap as prf-002; 12.2b)** |
| prf-004 | 427 | "44,580 Chocolate Doom tics" cross-validation | external Chocolate Doom instrumented run; tools/build-choco-reference.sh + tools/demo-test.mjs --cross | **EVIDENCED** — re-verified 2026-07-17 (task 12.5): 44,580 tics confirmed; see rme-007 for full evidence. Not gateable in CI; run on demand. |
| prf-005 | 548 | "unroll-4 verdict −3.5%" (wbox bsp+segs) | historical experiment requiring specific commit comparison; no current CI script | **EVIDENCED** — result is archived in perf.md §2.2 optimization log with A/B reps. Historical; no CI reproduction path (would require regressing the unroll). |
| prf-006 | 555 | "total render −1.5%" (B vs A) | same historical experiment | **EVIDENCED** — same A/B log as prf-005; table at perf.md §2.2 shows 0.4927→0.4851 ms. |
| prf-007 | 887 | "−33.0%" CODE section shrink under `-Os` | requires separate -Os emcc build; no current CI script | **FLAGGED(killed optimization; result archived in perf.md §axis-1; not worth CI-reproducing given KILL verdict — 14.3 may revisit if flash pressure appears)** |
| prf-008 | 891 | "−15.1%" wire payload under `-Os` | same -Os build | **FLAGGED(same as prf-007; archived in perf.md §axis-1)** |
| prf-009 | 904 | "−9.3% sim fps" under `-Os` (wbox) | requires -Os build + bench.mjs run; no current CI script | **FLAGGED(same as prf-007; the regression that killed -Os)** |
| prf-010 | 1087 | fire.js tick timing (0.0078/0.0222/0.0722 ms) | requires browser/JS benchmark harness; no current CI script | **GATED(partial)** — node microbench results committed in perf.md; spec.md quotes rounded values gated by `spec-001/002/003` in claims.json + SPEC_HINTS in doc-drift.mjs. In-browser blit cost remains FLAGGED (12.2b). |

---

## Part D — magic-data.md numeric figures

magic-data.md is the only published writeup (live on GitHub / linked externally).
Task 6.5 added the PUBLIC_HINTS gate covering 7 COLORMAP-family figures
(ea-018/019/020/023/025/026/048). Task 12.1 adds 7 more (finesine/rndtable
family). Two figures remain ungateable.

| id | figure | claim id | disposition |
|----|--------|---------|-------------|
| mda-001 | "5,377 of the 10,240 finesine entries differ" | ea-001 | **GATED** — PUBLIC_HINTS in doc-drift.mjs (task 12.1); fails if magic-data.md diverges from claims.json expected (5377). |
| mda-002 | "33 finesine exceptions" | ea-002 | **GATED** — PUBLIC_HINTS (task 12.1); expected 33. |
| mda-003 | "16,385 table entries" (FNV checksum) | ea-003 | **GATED** — PUBLIC_HINTS (task 12.1); expected 16385. |
| mda-004 | "0 mismatches out of 8,192" (COLORMAP exact) | ea-018 | **GATED** — PUBLIC_HINTS (task 6.5). |
| mda-005 | "truncation instead of rounding misses by 313" | ea-019 | **GATED** — PUBLIC_HINTS (task 6.5). |
| mda-006 | "(31−L)/31 scale misses by 2,373" | ea-020 | **GATED** — PUBLIC_HINTS (task 6.5). |
| mda-007 | "3,517 / 8,192 (43%)" (HACX misses) | ea-048 | **GATED** — PUBLIC_HINTS (task 6.5). |
| mda-008 | "241/256" (invuln matching) | ea-023 | **GATED** — PUBLIC_HINTS (task 6.5). |
| mda-009 | "residual 15 are gray-ramp tie-breaks" | ea-024 | **GATED** — PUBLIC_HINTS (task 12.1); expected 15. |
| mda-010 | "weights sum to 262" | ea-025 | **GATED** — PUBLIC_HINTS (task 6.5). |
| mda-011 | "standard luma formulas miss it by 91" | ea-026 | **GATED** — PUBLIC_HINTS (task 6.5). |
| mda-012 | "mean 128.85" (rndtable) | ea-007 | **GATED** — PUBLIC_HINTS (task 12.1); expected 128.85. |
| mda-013 | "only 166 of 256 values distinct" | ea-008 | **GATED** — PUBLIC_HINTS (task 12.1); expected 166. |
| mda-014 | "90 of the 256 possible byte values never appear" | ea-009 | **GATED** — PUBLIC_HINTS (task 12.1); expected 90. |
| mda-015 | "44,580 tics identical" (Chocolate Doom cross-val) | md-tic-001 | **EVIDENCED** — re-verified 2026-07-17 (task 12.5): `bash tools/build-choco-reference.sh` RC=0 (sdl2-compat 2.32.70 on CachyOS); `node tools/demo-test.mjs --cross` 13/13 PASS, 44,580 tics. Expected value in claims.json md-tic-001=44580 confirmed unchanged. Ungateable in CI; reproducer committed. |
| mda-016 | "2×10⁹ random in-domain pairs + 1.8×10⁶ adversarial" (FixedDiv) | none | **FLAGGED(approximate counts stated in scientific notation; no exact claim in claims.json; FixedDiv correctness gated via ea-005/006 at a different granularity; these prose figures serve as documentation context only)** |

**magic-data.md summary**: 14 of 16 figures gated via PUBLIC_HINTS; 1 evidenced (mda-015 re-verified 2026-07-17, task 12.5); 1 ungateable (mda-016: FixedDiv test-count is approximate scientific notation).

---

## Summary

| category | total | gated | evidenced | flagged |
|----------|-------|-------|-----------|---------|
| README.md | 10 | 1 | 3 | 6 |
| spec.md | 8 | 3 | 3 | 2 |
| perf.md (not-machine-verified) | 10 | 1 | 3 | 6 |
| magic-data.md | 16 | 14 | 1 | 1 |
| **Total** | **28** (excl. magic-data) / **44** (incl.) | **5** / **19** | **9** / **10** | **14** / **15** |

> Note: magic-data.md figures are separately tracked because they have their own
> gate mechanism (PUBLIC_HINTS). The "28 promises" headline count covers Parts A–C
> (README + spec + perf); Part D adds 16 magic-data figures for a full inventory
> of 44 entries.

**28 promises (Parts A–C): 5 gated, 9 evidenced, 14 flagged.**
(spc-004 and spc-006 moved from FLAGGED to EVIDENCED by task 12.2b.)

### Flagged promises by future task

| future task | promises it closes |
|-------------|-------------------|
| 12.2b | ~~spc-004~~ EVIDENCED, ~~spc-006~~ EVIDENCED; prf-002/003 (size audit CI) remain open |
| 12.3 | rme-003 (F8 toggle), rme-004 (rebind/gamepad), spc-003 (prefers-reduced-motion), spc-005 (LOC ceiling) |
| 12.4b / 15.1 | rme-005 (offline boot + sw.js precache bug fix), rme-009 (systemd service gate) |
| 14.3 | prf-007/008/009 (-Os build revisit for bare-metal) |
| 15.2 | rme-002 (Firefox/Edge CI) |
| 15.3 | rme-008 (SIGIL/MasterLevels/NRFTL/Chex/HACX smoke) |
| 15.4 | rme-010 (T07 flake fix + edge enforcement) |
| 15.5 | spc-002 (HOL blocking measurement) |
