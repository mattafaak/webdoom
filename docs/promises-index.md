# Promises Index

Every qualitative/behavioral promise in `README.md` and `spec.md`, every
`*(not machine-verified)*` figure in `perf.md`, and every numeric figure in
`docs/magic-data.md` (the published writeup) — mapped to a gate, committed
evidence, or an explicit `FLAGGED` entry with the reason and the future task
that closes it.

**Scope**: this index covers what `docs/claims-index.md` never covered:
qualitative/behavioral promises and the published figures in README, spec, and
magic-data. Do not confuse the two — `claims-index.md` inventories the
quantitative claims across the five archaeology docs (154 in the manifest, 204
index rows; `claims-index-check.mjs` prints the split and asserts it). This
figure used to read "gates 182 quantitative claims", which matches no count the
tooling produces. This index covers the 45 promises that
live outside that corpus. (Both figures used to be typed and both had drifted;
they are asserted against the tables now — see the note under the summary.)

**Gate**: `node tools/archaeology/doc-drift.mjs` — extended by task 12.1 to
cover README.md (README_HINTS), spec.md (SPEC_HINTS), and the remaining 7
magic-data.md figures (new PUBLIC_HINTS entries). Run the drift checker to
verify all machine-checkable figures; the qualitative promises below are indexed
here with dispositions.

**45 promises. Counts are asserted against the table by `tools/archaeology/promises-index-check.mjs`, not typed here — the header and the summary used to disagree (5/8/15 against 5/10/13), and the checker itself matched only three of the four Parts until this pass.**

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
| rme-001 | README:5 | "347 KB of wasm" | **GATED** — `readme-001` + `size-004` in claims.json; `doc-drift.mjs` README_HINTS and `size-ledger.mjs` size-004a/b both fail if README diverges. The two ids state the same fact and `claims-index-check.mjs` asserts they agree (they had drifted, 348 vs 349, task 24.2). |
| rme-002 | README:7 | "Runs in stock Chrome / Edge / Firefox" | **GATED** — Chromium by 19 CDP legs; Firefox by `firefox-smoke` (UA + JS + /api/wads) and `firefox-frame`, which drives Firefox to a real rendered DOOM frame and MEASURES it. Three things had to be found first, all measured on this host. (1) **Firefox 155 does not speak CDP at all**: `--remote-debugging-port` serves WebDriver BiDi and `/json/list` 404s, so the recorded reason for this gap — "no CDP equivalent for Firefox in this repo" — was wrong in the other direction. The leg drives BiDi (`session.new`, `browsingContext.navigate`, `script.evaluate`, `input.performActions`, `browsingContext.captureScreenshot`); geckodriver is still not needed. (2) **Headless Firefox has no WebGL here at all** (`webgl2:false`, `webgl1:false`; prefs cannot force software GL), and the client then falls back to `createRenderer2D` and renders perfectly well — 252 colours, measured — which is exactly how a frame gate passes while proving a path no user takes. (3) Under `xvfb-run` the same Firefox reports `webgl2:true`, renderer "llvmpipe, or similar". So the leg runs under Xvfb and asserts `window.webdoom._renderer.kind === 'webgl2'`; red-proofed by running it headless, which reds with `kind=canvas2d` while every other assertion still passes. The frame assertion is a measurement, not "the screenshot changed" — a flat fill changes too — so `tools/png-stats.mjs` decodes the capture and reports distinct colours and the share of pixels differing from the dominant colour (frame: 249 colours, 94.2% varied; `about:blank` control: 1 colour, 0%). Red-proofed a second way by making that measurement constant. **Edge stays untested by policy, not oversight** (spec.md §browser-matrix): it is Chromium, so a dedicated leg re-runs the same engine through a second binary. |
| rme-003 | README:8–9 | "Uncapped framerate with 35 Hz-exact game logic (Crispy-style interpolation; vanilla mode toggle in settings, F8)" | **PARTIAL** — the F8 panel is gone: SMOOTH RENDERING is a row on the launcher's OPTIONS screen, and `browser-options-test` drives it (reaching the screen, the value in force under hostile localStorage, and Reset defaults restoring it). The toggle's *effect* is asserted as of round 8: `sim-invariants` drives interpolation active (`--smooth --fractic`) and requires it to change the framebuffer on at least 5% of tics before it will report a pass, so reading the row and proving it changes rendering are now separate, both-gated claims; see `spc-011`. The UNCAPPED-FRAMERATE half remains unasserted: `-timedemo` steps one tic per frame by construction, so no demo-driven leg can observe a render rate above the tic rate. |
| rme-004 | README:10–11 | "rebindable keys, analog twin-stick gamepad" | **PARTIAL** — the REBIND half is gated: `tools/browser-options-test.mjs` (leg `browser-options`, 34 assertions) drives the CONTROLS screen through capture, Escape-cancels, the conflict swap, a partial stored bind map and Reset defaults, and closes with the round trip the old F8 test could not make — the key bound on OPTIONS is pressed in a running level and the engine must receive `DK.UP`. Two guards it added are red-proofed: arming on keyup (a HELD Enter bound Enter without it) and the capture-phase `stopPropagation` (the menu moved its cursor without it). `browser-resilience-test` still covers gamepad hotplug (connect + disconnect) only, so **the analog twin-stick path remains ungated** — a headless runner has no stick to push, and a synthetic Gamepad object would gate the shim rather than the path. |
| rme-005 | README:24–25 | "the second load is served from that cache, single player works offline" | **GATED** — offline SP boot by `browser-offline` (boots from the SW cache with the network down) and `check-sw-precache` (the SHELL list both ways); the warm load by `load-budget`, a REGRESSION gate against a baseline committed per host, which a host without one SKIPs by name rather than passing. Two assertions: the service worker CONTROLS the page before the second load, and the warm load is within this host's budget (alder: 337 ms against 4,000 ms). **README no longer says "instant"** — that was a performance claim no gate could carry, so the sentence now describes the mechanism, which is what is actually proven. **Cold-vs-warm is reported and never graded**: over loopback the cold load pays no network cost, so the comparison measures scheduling noise more than caching — measured across three runs the warm load was 333–339 ms every time while cold ranged 358–452, leaving margins of 25, 65 and 113 ms, and grading a 25 ms margin would buy nothing and flake eventually. Red-proofed both ways: a budget of 100 ms reds with the measured number named, and a removed baseline SKIPs with the record command. |
| rme-006 | README:17–18 | "measured < 1 ms/tick on the weakest network host" (fire) | **EVIDENCED** — perf.md §fire: wbox 0.0722 ms/tick (best-of-10 × 2000, 2026-07-16); ~14× under budget. Node microbench (not browser). Committed in perf.md; not CI-automated (requires JS bench). |
| rme-007 | README:67–70 | "cross-validated tic-for-tic against an instrumented Chocolate Doom... 44,580 tics identical" | **EVIDENCED** — re-verified 2026-07-17 (task 12.5): SDL2 packages present on CachyOS host; `bash tools/build-choco-reference.sh` RC=0; `node tools/demo-test.mjs --cross` 13/13 demos PASS, 44,580 tics identical. Expected value in claims.json md-tic-001=44580 unchanged. Not gateable in CI (requires external binary + WADs); run on demand via the two commands above. |
| rme-008 | README:22–24 | "Server carries the WAD library (Ultimate Doom, Doom II, Final Doom, SIGIL, Master Levels, NRFTL, Chex Quest)" | **GATED** — `smoke-pwad` leg (`tools/smoke-pwad-test.mjs`): **24 of 24** library WADs the demo goldens do NOT cover are booted and rendered, with four assertions each — the sim advances (≥ FRAMES/4 tics), the framebuffer is non-black (≥ 10,000/64,000 px), it CHANGES over the run, and for a PWAD it differs from the base IWAD warped to the same map. The target list is derived from `wads/manifest.json` minus demo-test.mjs's four demo-bearing IWADs, so a WAD added to the library joins this gate with no edit. **The control is not decoration**: truncating `tnt31.wad` to 40 KB passed the first three assertions, because the engine fell back to `tnt.wad`'s own MAP31 — "it booted and drew a level" does not prove the PWAD loaded. With the control it reds: "identical to tnt.wad at the same map — the PWAD contributed nothing". A control that ERRORS is itself proof, since that map exists only in the PWAD. Two floors stop a vacuous pass: fewer than 20 targets discovered, or fewer than 20 actually booted, is a FAIL. HACX was listed here and in README until round 5 and was never servable — absent from the manifest and refused by wad-import.js. That half was not an untested promise, it was a false one; `tools/check-menu-reachable.mjs` gates the class. |
| rme-009 | README:41 | "`webdoom.service` is a ready systemd unit" | **GATED** — `service-file` leg (`tools/service-check.sh`), quick tier, **15 assertions**: systemd's own parser with its OUTPUT graded as well as its status (warnings exit 0), the nine directives a ready unit must carry, ExecStart's program executable and its script present in this repo, WorkingDirectory's basename matching the checkout, and DOOM_HOST/DOOM_PORT agreeing with `server/serve.js`'s own defaults. Red-proofed on five arms — a typo'd `ExecStartt=`, a removed `Restart=`, a port that disagrees with the server, an absent ExecStart script and a broken `[Install]` — each rc=1 naming a different failure. `systemd-analyze verify` alone was NOT made the gate: on a good unit it exits 0 and prints nothing, so a bare wrapper could not tell a sound unit from a dead check. **What it does not check, stated rather than implied:** whether the unit BOOTS — that needs root and a live systemd. |
| rme-010 | README:86–87 | "T07 menu-nav is a pre-existing timing flake on some CI hosts — ~1/3 pass rate" | **RESOLVED** — the promise this tracked is gone. T07 was fixed in 9ed9671 (3-attempt retry of the MP-open action, assertion unweakened, 20/20 on a fresh profile); the original cause was /tmp exhaustion from orphaned Chrome, not this codebase. README no longer claims a ~1/3 pass rate (24.3). Note `check-state-machine` verifies edge COVERAGE by token grep, not that each assertion runs. |

---

## Part B — spec.md qualitative/behavioral promises

| id | source | promise | disposition |
|----|--------|---------|-------------|
| spc-001 | spec.md:98 | "alder 0.008 ms, pi5 0.022 ms, **wbox 0.072 ms**" (fire CPU cost per tick) | **GATED** — `spec-001/002/003` in claims.json; `doc-drift.mjs` SPEC_HINTS fails if spec.md diverges from committed expected values. Source: perf.md §fire (0.0078/0.0222/0.0722 ms, rounded). Not CI-reproduced (node bench, not browser). |
| spc-002 | spec.md:76 | "transport remains a single WebSocket port; head-of-line blocking remains unmeasurably small" | **EVIDENCED** — task 15.5 (2026-07-19): measured inter-bundle gap distribution. Localhost: p50=30.6 ms, p99=33.5 ms, max=40.3 ms. wbox→alder via Tailscale: p50=33.8 ms, p99=83.9 ms, max=142.7 ms (n=440/424 gaps). Stall at grace boundary (graceful-close path, n=5): mean 26 ms, max 33 ms; hard-drop grace bound = 300 ms from `GRACE_MS=250`+`sealSweep=50`. Catch-up on wbox (weakest host, tailnet, n=3): 125–149 ms for 436–505 tics. HOL verdict: no-WebRTC safe; observed variance bounded by sealSweep (50 ms), not TCP retransmit. spec.md:76 updated with measured numbers. Full data: docs/netcode-numbers.md. |
| spc-003 | spec.md:91 | "`prefers-reduced-motion` gets a static frame" | **GATED** — closed in round 6, by the gate the previous disposition asked for. `browser-fire-test.mjs` arm (f) launches a SECOND Chrome with `--force-prefers-reduced-motion`, asserts the media query actually reads true (or the arm is the first one with extra steps), and then asserts the fire is static across 600 ms **and non-blank** — "static" is also what an empty canvas looks like. The animating first arm is its control. Red-proofed by forcing `reducedMotion = false` in fire.js: "(f) prefers-reduced-motion is set and the fire is STILL animating (8616 → 9904)". The CSS half landed with it: `webdoom.css` gained its first `@media (prefers-reduced-motion: reduce)` block, which the JS check never covered. |
| spc-004 | spec.md:99 | "browser-composited and negligible" (putImageData blit cost) | **EVIDENCED** — task 12.2b (2026-07-18, commit 5a71e12): per-frame profile via `?perfmarks=1` shows (b) FB upload p99=0.2 ms (alder) / p99=6.5 ms (wbox Bobcat spike) vs 35 Hz budget 28.6 ms. WebGL2 path: `texSubImage2D` 320×200 + `drawArrays`; Canvas2D: 64K pixel-expand + `putImageData`. Both sub-ms at p50; "browser-composited and negligible" confirmed. Reproduce: `node tools/browser-pipeline.mjs --url http://127.0.0.1:8666/ --json`. Golden: `tools/golden/browser-pipeline-alder.json`. |
| spc-005 | spec.md:27 | "web platform layer, client, and server stay small enough to read in a sitting" | **UNGATEABLE, by verdict (round 8)** — not flagged, decided. A LOC ceiling gates a PROXY, not the promise: "small enough to read in a sitting" is a claim about comprehensibility, and a line count neither implies it nor is implied by it — a 400-line file of dense cleverness fails the promise while passing the proxy. The number is published instead of graded (`payload-size` reports the shipped surface, and `docs-index` the documentation set), and the sentence stays as prose that says what it is. Recorded so it stops being re-discovered as an unmet gate. |
| spc-006 | spec.md:48–49 | "The browser-pipeline baseline (per-frame JS/GPU/audio cost, input latency) joins this gate once Phase 12 lands" | **EVIDENCED** — task 12.2b (2026-07-18, commit 5a71e12): `tools/browser-pipeline.mjs` collects per-stage `?perfmarks=1` distributions. Input latency: alder p50=8–9 ms (half-frame quantization at 60 fps); upload p99=0.2 ms; rAF callback p50=0.2 ms p99=0.9 ms. AudioWorklet unmeasured in headless Chrome (headless limitation — not a gap in the instrument). Goldens: `tools/golden/browser-pipeline-{alder,wbox}.json`. Gate: `node tools/browser-pipeline.mjs` exits 0 if collector runs without error; numeric baselines are golden-filed. |
| spc-007 | spec.md:17–20 | "all 13 IWAD demos replay tic-identical against golden traces and cross-validate against instrumented Chocolate Doom (44,580 tics)" | **GATED** — sim gate (demo-test.mjs) is live CI. Cross-validation re-verified 2026-07-17 (task 12.5): 44,580 tics confirmed; see rme-007. |
| spc-008 | spec.md:64–67 | Reference hardware fleet host names (wbox/tank/pi5/alder) | **EVIDENCED** — fleet is documented in spec.md table and bench-baseline.json column headers match exactly. No drift gate; names are configuration, not numeric. |
| spc-011 | spec.md "What ships" | "Freelook and frame interpolation — render-side, opt-in" | **GATED** — `sim-freelook` (leg, shipping artifact) and `sim-invariants` (leg, armed build), both via demo-test.mjs's `--sim-drawn` family: the 13 demos replayed with the FULL RENDER PATH RUNNING and the per-tic `web_state_hash()` trace compared byte-exact against the existing sim goldens. Round 8 found the blindness was `-nodraw`, not `_web_set_smooth(0)`: `d_main.c:234` returns from `D_Display` before any drawer, so the sim family never executed `R_SetupFrame`, `R_ShearView` or `R_InterpolateSectors` at all. Vacuity is asserted PER MODIFIER at the consumption site (framebuffer output), not at the setter — the `sim-wide` arm this replaces read `web_screenwidth() > 320`, which proves a variable was written and not that anything read it. Red-proofed four ways: deleting `R_InterpolateSectors(true)` reds `sim-invariants` at tic 14 while `sim-goldens`, `render-goldens` and `render-low` all stay green (13/13 each); forcing a modifier pass to control values reds with "changed 0 of 1710 frames"; a constant framebuffer hash reds the instrument check at tic 0; and `-nodraw` reds with "rendered 0 frames over 1710 tics". **One limit, recorded rather than papered over:** frame interpolation is inert under `-timedemo` — that path sets `singletics`, whose branch never calls `run_tic()`, and `run_tic()` is the only writer of `web_lastticms`, so `I_GetTimeFrac()` saturates at FRACUNIT and the lerp is a no-op (measured: `--smooth` alone changed 0 of 1710 frames). Interpolation is therefore exercised with `--fractic`, a pin that exists only in `WEBDOOM_INVARIANTS` builds, so its invariance is proven on the armed build rather than on `build/`; the playsim and interpolation sources are identical between the two, and adding the pin to the shipping build would move `__heap_base` and turn `perf-009` red. `build/doom.wasm` is byte-identical across the change (md5 a1109b9c2ad9c04374767cce8dd51712). |

---

## Part C — perf.md figures marked `*(not machine-verified)*`

Ten figures in perf.md carry the `*(not machine-verified)*` marker. Each is
enumerated below with its reason and disposition.

| id | perf.md:line | figure | reason (inline) | disposition |
|----|-------------|--------|-----------------|-------------|
| prf-001 | 143 | "Minimum safe `INITIAL_MEMORY`: 56 MB" | requires emcc INITIAL_MEMORY sweep build; no current CI script | **FLAGGED(no gate — PARKED by verdict, round 8: the sweep is a session of its own for one promise with no consumer)** — the disposition is still "no gate", because that is what is true; what round 8 added is the decision not to build one. Closing it needs an emcc `INITIAL_MEMORY` sweep build, which is a session of its own for one flagged promise, and the figure it would confirm (56 MB minimum safe) has no consumer: `perf-059`..`perf-059d` already gate the worst real PWAD combo against the 64 MB that actually ships, with 9.17 MB of headroom. Parked with the reason rather than carried as an open gap. |
| prf-002 | 193 | "177.7 KB gzip" (total wire payload) | **GATED** — `payload-size` leg (`tools/payload-size.mjs`), measured 213.3 KB gzip -9. Both figures were marked *not machine-verified* and sat `unverifiable` in claims.json, so nothing recomputed them for months and the published 177.7 KB was 1.3x low. The file set is DERIVED from `client/sw.js`'s `SHELL_FILES` — the list `check-sw-precache` already gates both ways — so a file added to the app shell joins the measurement with no edit; a typed list is what went stale. Graded as a CEILING (10% headroom), not a pin, because these move with every commit, and `perf.md`'s per-file table is regenerated from the same measurement. The verifier emits a `CLAIMS_JSON` footer so doc-drift is three-way; omitting it first time was caught by `--require-script-values`, which calls a claim with no script value a defect rather than a skip. |
| prf-003 | 196 | "35 KB gzip" (JS+CSS+HTML surface) | **GATED** — `payload-size` leg (`tools/payload-size.mjs`), measured 66.7 KB gzip -9. Both figures were marked *not machine-verified* and sat `unverifiable` in claims.json, so nothing recomputed them for months and the published 35.1 KB was **2.5x low** — the old per-file table still listed `client/js/settings.js`, which round 7 DELETED, and omitted `wad-import`, `demo`, `scrubber`, `mus2mid`, `sf2-library`, `idb`, `wad-library`, `ui` and `wad-cache`. The file set is DERIVED from `client/sw.js`'s `SHELL_FILES` — the list `check-sw-precache` already gates both ways — so a file added to the app shell joins the measurement with no edit; a typed list is what went stale. Graded as a CEILING (10% headroom), not a pin, because these move with every commit, and `perf.md`'s per-file table is regenerated from the same measurement. The verifier emits a `CLAIMS_JSON` footer so doc-drift is three-way; omitting it first time was caught by `--require-script-values`, which calls a claim with no script value a defect rather than a skip. |
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
| spec.md | 8 | 3 | 4 | 1 |
| perf.md (not-machine-verified) | 10 | 1 | 3 | 6 |
| magic-data.md | 16 | 14 | 1 | 1 |
| **Total** | **44** | **18** | **10** | **12** |

> Note: magic-data.md figures have their own gate mechanism (PUBLIC_HINTS) but
> are counted here like every other row. The table above used to carry two
> totals — "28 (excl. magic-data) / 44 (incl.)" — and a per-disposition split
> ("5/19 gated, 10/11 evidenced, 13/14 flagged") that matched neither the
> checker nor the rows. There is one inventory and one set of counts now, and
> `promises-index-check.mjs` computes them.

**45 promises in the table.** Counts are asserted against it by
`tools/archaeology/promises-index-check.mjs` rather than typed — the header and this
line used to disagree (5/8/15 against 5/10/13), which is how six stale dispositions
survived to task 24.1.

It said **34** until this pass, and the reason is worth keeping: the checker
matched a row by `cells.length === 6`, which is the shape of Parts A, B and D.
Part C — the ten perf.md figures — has a sixth column for the inline reason, so
all ten were dropped without a word, and the document's own breakdown below
listed Parts A, B and D and simply omitted C. A checker that silently skips a
whole section reports a number that is true of nothing.

- Part A: 10 — 2 evidenced, 3 flagged, 1 gated, 3 partial, 1 resolved
- Part B: 8 — 4 evidenced, 2 flagged, 2 gated
- Part C: 10 — 3 evidenced, 6 flagged, 1 gated
- Part D: 16 — 1 evidenced, 1 flagged, 14 gated

Whole table: 10 evidenced, 12 flagged, 18 gated, 3 partial, 1 resolved.

`PARTIAL` is new in 24.1 and earns its place: three promises are compound, and calling
them GATED or FLAGGED was wrong in both directions. "stock Chrome / Edge / Firefox" has
two thirds gated and Edge untested; the vanilla-mode toggle gates the OPTIONS row but not
the toggle's effect; "second load is instant, single player works offline" gates the
offline boot but not the word "instant".
(spc-004 and spc-006 moved from FLAGGED to EVIDENCED by task 12.2b; spc-002 moved by task 15.5.)

### Open promises and who owns them

Every entry of the table this replaces named a task — 12.2b, 12.3, 12.4b/15.1,
14.3, 15.2, 15.3, 15.4, 15.5 — and **all eight were closed and archived**, some
of them for months. A promise pointed at a finished task reads as scheduled work
and is not: it had no owner at all. Round 8 closed four of the promises that
table listed (rme-008 and rme-009 by gate, spc-011 by gate, rme-003's
toggle-effect half by gate) without any of those tasks existing.

So this table names an owner or says there is none. "No live owner" is a real
entry, not a gap to be filled with the nearest task number.

| promise | state | owner |
|---------|-------|-------|
| rme-002 (Firefox rendered frame) | PARTIAL | no live owner — needs geckodriver or Firefox's Remote Protocol in the harness |
| rme-003 (uncapped framerate) | PARTIAL | no live owner — the toggle's *effect* is gated (`sim-invariants`); the render RATE is unobservable through a demo-driven leg, which steps one tic per frame |
| rme-004 (analog twin-stick) | PARTIAL | no live owner — a headless runner has no stick, and a synthetic `Gamepad` would gate the shim rather than the path |
| rme-005 ("second load is instant") | PARTIAL | no live owner — needs a committed load-time budget, and inherits `browser-pipeline`'s host-drift problem |
| spc-005 (small enough to read in a sitting) | FLAGGED | no live owner — a LOC ceiling gates a proxy, not the promise |
| prf-001 (INITIAL_MEMORY 56 MB) | FLAGGED | no live owner — needs an emcc INITIAL_MEMORY sweep |
| prf-002 / prf-003 (total gzip payload) | FLAGGED | no live owner — a `gzip -9c` budget over the deliverable set, `size-ledger`-shaped, is the cheapest of these |
| prf-007 / prf-008 / prf-009 (`-Os` figures) | FLAGGED | **none, by verdict** — killed optimization, archived; not worth CI-reproducing |
| mda-016 (FixedDiv magnitudes) | FLAGGED | **none, by verdict** — approximate scientific notation in prose; no exact claim exists to gate |
