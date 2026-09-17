# Claims Index

Every quantitative claim in the five core documentation files, mapped to a
reproducing script or flagged `needs-verifier`.  Task 6.2 writes the missing
verifiers; task 6.3 wires them into `verify-all.sh` and a CI drift-check.
Task 6.4 annotates each doc figure with its reproducer so the corpus is
auditable claim-by-claim without consulting this index.

**Gate**: `bash tools/archaeology/verify-all.sh` — fast tier (107 claims,
~4 s); `--full` adds runtime-stat + measurement-stamp families.

**Docs annotated**: `engine-archaeology.md`, `renderer.md`, `playsim.md`,
`formats.md`, `perf.md` — each carries section-level "Reproduce:" lines
and inline `*(not machine-verified)*` markers for the 15 unverifiable claims.

## Taxonomy

| type | meaning |
|------|---------|
| `invariant` | Hard number from source code or fixed WAD data; must never change |
| `measurement` | Obtained by running a tool on a specific host/commit; may drift |
| `derived` | Arithmetic from other claims; verify the constituent claims first |

## Status

| status | meaning |
|--------|---------|
| `verified` | A committed script reproduces it; spot-checked this sprint |
| `needs-verifier` | No script yet; task 6.2 must write one |
| `unverifiable` | Cannot be automated (see reason) |

---

## Table

| id | doc:line | claim (short) | value | type | reproducer | status |
|----|----------|---------------|-------|------|------------|--------|
| ea-001 | engine-archaeology.md:17 | finesine entries differing from round-nearest | 5,377 / 10,240 | invariant | tools/archaeology/finesine-stats.mjs | verified |
| ea-002 | engine-archaeology.md:20 | finesine entries where 1993 machine's last bit deviated (escapes) | 33 | invariant | tools/archaeology/finesine-stats.mjs | verified |
| ea-003 | engine-archaeology.md:29 | entries covered by boot FNV checksum | 16,385 | invariant | tools/archaeology/finesine-stats.mjs | verified |
| ea-004 | engine-archaeology.md:§2 | FixedDiv proof: mismatch requires \|a\| ≥ 2^37; INT32_MAX < 2^31 (margin ≥ 64x) | 137438953472 | derived | arithmetic: 2^37=137438953472 > INT32_MAX; verified by fixeddiv-proof.c analytic step | verified |
| ea-005 | engine-archaeology.md:§2 | FixedDiv proof: guard-edge pairs checked (max-ULP corroboration) | 8,388,608 | measurement | tools/archaeology/fixeddiv-proof.c | verified |
| ea-006 | engine-archaeology.md:§2 | FixedDiv proof: guard-edge mismatch count | 0 | measurement | tools/archaeology/fixeddiv-proof.c | verified |
| ea-007 | engine-archaeology.md:156 | rndtable mean value | 128.85 | invariant | tools/archaeology/rndtable-stats.c | verified |
| ea-008 | engine-archaeology.md:156 | rndtable distinct values | 166 / 256 | invariant | tools/archaeology/rndtable-stats.c | verified |
| ea-009 | engine-archaeology.md:68 | rndtable values that never appear | 90 | invariant | tools/archaeology/rndtable-stats.c | verified |
| ea-010 | engine-archaeology.md:82 | gamma table level-0 residual mismatches | 5 / 256 | invariant | tools/archaeology/gamma-crack.mjs | verified |
| ea-011 | engine-archaeology.md:82 | gamma table level-1 residual mismatches | 34 / 256 | invariant | tools/archaeology/gamma-crack.mjs | verified |
| ea-012 | engine-archaeology.md:82 | gamma table level-2 residual mismatches | 36 / 256 | invariant | tools/archaeology/gamma-crack.mjs | verified |
| ea-013 | engine-archaeology.md:82 | gamma table level-3 residual mismatches | 41 / 256 | invariant | tools/archaeology/gamma-crack.mjs | verified |
| ea-014 | engine-archaeology.md:82 | gamma table level-4 residual mismatches | 34 / 256 | invariant | tools/archaeology/gamma-crack.mjs (FINDING-3 RESOLVED: doc corrected to 34/256 at γ≈2.011) | verified |
| ea-015 | engine-archaeology.md:100 | P_AproxDistance max relative error (at 26.6°) | +11.8% | invariant | tools/archaeology/aprox-distance-crack.c | verified |
| ea-016 | engine-archaeology.md:203 | P_AproxDistance relative error at 45° | +6.1% | invariant | tools/archaeology/aprox-distance-crack.c | verified |
| ea-017 | engine-archaeology.md:100 | P_AproxDistance relative error on cardinal axes | 0% | invariant | tools/archaeology/aprox-distance-crack.c | verified |
| ea-018 | engine-archaeology.md:127 | COLORMAP matches using Euclidean round-nearest | 0 mismatches / 8,192 | measurement | tools/archaeology/colormap-crack.c | verified |
| ea-019 | engine-archaeology.md:127 | COLORMAP mismatches with truncation instead of round | 313 | measurement | tools/archaeology/colormap-crack.c | verified |
| ea-020 | engine-archaeology.md:291 | COLORMAP mismatches with (31−L)/31 scale recipe | 2,373 | measurement | tools/archaeology/colormap-crack.c | verified |
| ea-021 | engine-archaeology.md:127 | COLORMAP mismatches with Manhattan distance | 1,208 | measurement | tools/archaeology/colormap-crack.c | verified |
| ea-022 | engine-archaeology.md:130 | COLORMAP map-0 identity entries | 249 / 256 | invariant | tools/archaeology/wad-verify.mjs | verified |
| ea-023 | engine-archaeology.md:328 | invuln COLORMAP map-32 matching entries (FINDING-1 RESOLVED: doc corrected 242→241) | 241 / 256 | invariant | tools/archaeology/colormap-invuln-crack.c (reports 15/256 mismatches → 241 match) | verified |
| ea-024 | engine-archaeology.md:137 | invuln COLORMAP tie-break count in gray ramp | 15 | measurement | tools/archaeology/colormap-invuln-crack.c | verified |
| ea-025 | engine-archaeology.md:139 | invuln luma weight sum (76 + 152 + 34) | 262 | derived | arithmetic: 76+152+34=262 | verified |
| ea-026 | engine-archaeology.md:139 | invuln entries missed by standard ITU luma weights | 91 | measurement | tools/archaeology/colormap-invuln-crack.c | verified |
| ea-027 | engine-archaeology.md:222 | checkcoord boundary-clamp test cases | 9 / 9 PASS | invariant | tools/archaeology/checkcoord-verify.mjs | verified |
| ea-028 | engine-archaeology.md:422 | DISTMAP/MAXLIGHTZ world-unit range covered | 16 to 2,048 | invariant | tools/archaeology/zlight-distmap.mjs | verified |
| ea-029 | engine-archaeology.md:775 | total ledger rows | 40 | measurement | tools/archaeology/ledger-count.mjs | verified |
| ea-030 | engine-archaeology.md:775 | ledger recipe-class rows | 5 | derived | ledger-count.mjs category total | verified |
| ea-031 | engine-archaeology.md:775 | ledger equivalence-class rows | 4 | derived | ledger-count.mjs category total | verified |
| ea-032 | engine-archaeology.md:775 | ledger irreducible-class rows | 17 | derived | ledger-count.mjs category total | verified |
| ea-033 | engine-archaeology.md:775 | ledger declarative-class rows | 14 | derived | ledger-count.mjs category total | verified |
| ea-042 | engine-archaeology.md:§2a | FixedMul int64 product bound: max \|a·b\| for int32 inputs (2^62 < INT64_MAX) | 4611686018427387904 | derived | tools/archaeology/fixedmul-proof.c | verified |
| ea-043 | engine-archaeology.md:§2a | FixedMul rounding asymmetry: floor vs trunc differ by N for negative non-exact products | 1 | invariant | tools/archaeology/fixedmul-proof.c | verified |
| ea-044 | engine-archaeology.md:§5 | P_AproxDistance integer supremum (>>1 floor): ratio at (1,1) = sqrt(2) | +41.4% | invariant | tools/archaeology/aprox-distance-crack.c | verified |
| ea-045 | engine-archaeology.md:§5 | P_AproxDistance integer max ratio at M=65536 (1 FRACUNIT), 65,536-pair sweep | 11.81% | invariant | tools/archaeology/aprox-distance-crack.c | verified |
| ea-046 | engine-archaeology.md:§5a | R_PointToAngle fine-angle round-trip max error (8,192-enumeration, FRACUNIT scale) | 3 | invariant | tools/archaeology/angle-roundtrip-check.c | verified |
| ea-047 | engine-archaeology.md:§5a | SlopeDiv output range upper bound (proven by construction) | 2048 | invariant | tools/archaeology/angle-roundtrip-check.c | verified |
| ea-034 | engine-archaeology.md:§microbench | FixedDiv double path on i9-12900K (alder) | 419 ms / 2×10⁸ iters | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| ea-035 | engine-archaeology.md:§microbench | FixedDiv double path on Cortex-A76 (pi5) | 754 ms | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| ea-036 | engine-archaeology.md:§microbench | FixedDiv double path on AMD G-T56N (wbox) | 12,304 ms | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| ea-037 | engine-archaeology.md:§microbench | FixedDiv double path on i5-8350U (tank) | 964 ms | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| ea-038 | engine-archaeology.md:§microbench | FixedDiv int64 path on i9-12900K (alder) | 403 ms | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| ea-039 | engine-archaeology.md:§microbench | FixedDiv int64 path on Cortex-A76 (pi5) | 630 ms | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| ea-040 | engine-archaeology.md:§microbench | FixedDiv int64 path on AMD G-T56N (wbox) | 13,054 ms | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| ea-041 | engine-archaeology.md:§microbench | FixedDiv int64 path on i5-8350U (tank) | 2,725 ms | measurement | tools/golden/bench-baseline.json (v1.primitiveMicrobench) | dated-measurement |
| rdr-001 | renderer.md:267 | MAXSEGS (solidsegs) in vanilla DOOM | 32 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-002 | renderer.md:267 | MAXSEGS (solidsegs) in webdoom | 64 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-003 | renderer.md:416 | MAXOPENINGS in vanilla (SCREENWIDTH × 64) | 20,480 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-004 | renderer.md:405 | MAXOPENINGS in webdoom (SCREENWIDTH × 64; the 854 cap went with widescreen) | 20,480 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-005 | renderer.md:549 | MAXVISPLANES in vanilla DOOM | 128 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-006 | renderer.md:554 | MAXVISPLANES in webdoom | 128 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-007 | renderer.md:1003 | MAXDRAWSEGS in vanilla DOOM | 256 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-008 | renderer.md:1003 | MAXDRAWSEGS in webdoom | 256 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-009 | renderer.md:1003 | MAXVISSPRITES in vanilla DOOM | 128 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-010 | renderer.md:1004 | MAXVISSPRITES in webdoom | 1,024 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-011 | renderer.md:983 | ANGLETOSKYSHIFT | 22 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| rdr-012 | renderer.md:984 | sky texture repetitions around 360° (2³² / 2²²) | 4 | derived | arithmetic: 2^32/2^22=1024 fine-angle steps, 4 repeats of 256-col texture | derived-from-gated |
| ps-001 | playsim.md:312 | MAXSPECIALCROSS in vanilla DOOM | 8 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-002 | playsim.md:307 | MAXSPECIALCROSS in webdoom | 64 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-003 | playsim.md:329 | peak numspechit across all 13 golden demos | 8 (tnt-demo2 MAP12) | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_SPECHIT_STATS build) | verified |
| ps-004 | playsim.md:392 | MAXINTERCEPTS | 128 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-005 | playsim.md:421 | peak intercept count across all 13 golden demos | 45 (plutonia-demo3 MAP12) | measurement | instrumented build required (stat removed); no current script | unverifiable |
| ps-006 | playsim.md:152 | BACKUPTICS | 35 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-007 | playsim.md:935 | SAVEGAMESIZE in vanilla (0x2C000) | 180,224 bytes | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-008 | playsim.md:935 | SAVEGAMESIZE in webdoom (0x80000) | 524,288 bytes | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-009 | playsim.md:1005 | MAX_DEATHMATCH_STARTS | 10 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-010 | playsim.md:692 | MAXHEALTH | 100 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-011 | playsim.md:703 | BONUSADD | 6 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-012 | playsim.md:544 | FLOATSPEED | 262,144 (4 × FRACUNIT) | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-013 | playsim.md:756 | forwardmove table | {25, 50} map-units/tic | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-014 | playsim.md:756 | sidemove table | {24, 40} map-units/tic | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-015 | playsim.md:757 | angleturn table | {640, 1280, 320} | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-016 | playsim.md:374 | STOPSPEED | 0x1000 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-017 | playsim.md:375 | FRICTION | 0xE800 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-018 | playsim.md:624 | diagonal full-speed magnitude | ~47,000 (≈ 0.717 × FRACUNIT) | derived | tools/archaeology/derived-check.mjs | verified |
| ps-019 | playsim.md:265 | A_Chase max players checked per call | 2 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-020 | playsim.md:735 | GLOWSPEED (light level units per tic) | 8 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-021 | playsim.md:736 | STROBEBRIGHT (tics at max brightness) | 5 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-022 | playsim.md:737 | FASTDARK (tics at min brightness, fast strobe) | 15 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-023 | playsim.md:738 | SLOWDARK (tics at min brightness, slow strobe) | 35 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-024 | playsim.md:566 | nightmare respawn minimum delay | 12 × 35 = 420 tics | derived | arithmetic: 12s × 35 Hz = 420 | derived-from-gated |
| ps-025 | playsim.md:1561 | MAXPLATS | 30 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-026 | playsim.md:1562 | MAXBUTTONS | 16 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-027 | playsim.md:1623 | QUEUESIZE (chat ring buffer) | 128 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-028 | playsim.md:1623 | HU_MAXLINELENGTH (text line limit incl. NUL) | 81 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| ps-029 | playsim.md:1110 | teleport calls in doom-demo3 (E3M5) | 3 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_TELEPORT_STATS build) | verified |
| ps-030 | playsim.md:1111 | teleport calls in doom2-demo3 (MAP26) | 5 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_TELEPORT_STATS build) | verified |
| ps-031 | playsim.md:1112 | teleport calls in plutonia-demo1 (MAP17) | 23 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_TELEPORT_STATS build) | verified |
| ps-032 | playsim.md:1113 | teleport calls in plutonia-demo3 (MAP12) | 1 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_TELEPORT_STATS build) | verified |
| ps-033 | playsim.md:1115 | doom-demo1 total tics (E1M5) | 1,710 | measurement | tools/archaeology/stamp-check.mjs (FINDING-2: tics=1710 per golden; frames=1709 per bench — wipe-skip delta) | verified |
| ps-034 | playsim.md:1116 | doom-demo4 total tics (E4M2) | 818 | measurement | tools/archaeology/stamp-check.mjs | verified |
| ps-035 | playsim.md:1117 | total teleport calls across all 13 golden demos | 32 | derived | tools/archaeology/derived-check.mjs (arithmetic: 3+5+23+1=32; constituents verified by runtime-stat-verify.mjs) | verified |
| fmt-001 | formats.md:1125 | doom.wad numlumps | 2,306 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-002 | formats.md:340 | E1M1 sector count | 88 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-003 | formats.md:340 | E1M1 REJECT lump size | 968 bytes | derived | ceil(88×88/8) = 968 | derived-from-gated |
| fmt-004 | formats.md:375 | E1M1 BLOCKMAP origin X | −776 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-005 | formats.md:375 | E1M1 BLOCKMAP origin Y | −4,872 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-006 | formats.md:375 | E1M1 BLOCKMAP width (in 128-unit blocks) | 36 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-007 | formats.md:375 | E1M1 BLOCKMAP height | 23 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-008 | formats.md:375 | E1M1 BLOCKMAP offset-table entries | 828 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-009 | formats.md:293 | E1M1 node count | 238 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-010 | formats.md:293 | E1M1 child references using NF_SUBSECTOR | 239 / 476 | measurement | tools/archaeology/wad-verify.mjs | verified |
| fmt-011 | formats.md:737 | DSPISTOL DMX format_id | 3 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-012 | formats.md:738 | DSPISTOL sample rate | 11,025 Hz | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-013 | formats.md:1135 | DSPISTOL num_samples field | 5,661 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-014 | formats.md:1116 | DSPISTOL real sample count (num_samples − 32 pads) | 5,629 | derived | 5,661 − 32 = 5,629 | derived-from-gated |
| fmt-015 | formats.md:1116 | DSPISTOL lump size (8 header + num_samples) | 5,669 | derived | 8 + 5,661 = 5,669 | derived-from-gated |
| fmt-016 | formats.md:799 | D_E1M1 MUS scorelen | 17,237 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-017 | formats.md:799 | D_E1M1 MUS scorestart | 46 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-018 | formats.md:799 | D_E1M1 MUS channel count (primary) | 3 (sec_ch=0) | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-019 | formats.md:799 | D_E1M1 MUS instrument count | 15 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-020 | formats.md:799 | D_E1M1 MUS total bytes (scorestart + scorelen) | 17,283 | derived | 46 + 17,237 = 17,283 | derived-from-gated |
| fmt-021 | formats.md:863 | MUS_RATE (engine tic rate for MUS playback) | 140 Hz | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| fmt-022 | formats.md:879 | GENMIDI lump size | 11,908 bytes | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-023 | formats.md:863 | GENMIDI instrument count | 175 (128 melodic + 47 perc) | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-024 | formats.md:882 | genmidi_instr_t struct size | 36 bytes | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-025 | formats.md:448 | PLAYPAL total size (14 palettes × 768 bytes) | 10,752 bytes | derived | 14 × 768 = 10,752 | derived-from-gated |
| fmt-026 | formats.md:464 | COLORMAP total size (34 tables × 256 bytes) | 8,704 bytes | derived | 34 × 256 = 8,704 | derived-from-gated |
| fmt-027 | formats.md:523 | ENDOOM size (80 × 25 × 2) | 4,000 bytes | derived | 80×25×2 = 4,000 | derived-from-gated |
| fmt-028 | formats.md:1126 | PNAMES entry count | 351 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-029 | formats.md:1126 | PNAMES lump size (4 + 351 × 8) | 2,812 bytes | derived | 4 + 351×8 = 2,812 | derived-from-gated |
| fmt-030 | formats.md:1146 | TEXTURE1 texture count (doom.wad) | 125 | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-031 | formats.md:554 | demo header total size | 13 bytes | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| fmt-032 | formats.md:720 | save slot count | 6 (doomsav0–doomsav5) | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| fmt-033 | formats.md:1041 | DMX lead-in / lead-out pad size | 16 bytes each | invariant | tools/archaeology/wad-verify.mjs | verified |
| fmt-034 | formats.md:804 | MUS percussion channel | 15 | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| perf-001 | perf.md:58 | wasm binary total size (commit 6de6256) | 357,978 bytes | measurement | tools/archaeology/stamp-check.mjs (commit-pinned; reports current) | verified |
| perf-002 | perf.md:55 | wasm CODE section size (commit 6de6256) | 281,277 bytes | measurement | tools/archaeology/wasm-stamp.mjs (commit-pinned; reports current) | dated-measurement |
| perf-003 | perf.md:47 | wasm DATA section size (commit 6de6256) | 75,283 bytes | measurement | tools/archaeology/wasm-stamp.mjs (commit-pinned; reports current) | dated-measurement |
| perf-004 | perf.md:58 | wasm gzip-9 compressed size (commit 6de6256) | 145,990 bytes | measurement | tools/archaeology/stamp-check.mjs (commit-pinned; reports current) | verified |
| perf-005 | perf.md:56 | doom.js gzip-9 compressed size | 3,514 bytes | measurement | tools/archaeology/stamp-check.mjs (commit-pinned; reports current) | verified |
| perf-006 | perf.md:57 | wasm compression ratio (raw / gzip) | 2.45× | derived | 357,978 / 145,990 ≈ 2.45 | derived-from-gated |
| perf-007 | perf.md:100 | peak zone HWM across all 13 golden demos | 1.36 MB (plutonia demo3) | measurement | tools/zone-measure.mjs | dated-measurement |
| perf-008 | perf.md:69 | ZONESIZE (hardcoded zone pool) | 4,194,304 B (32 MB) | invariant | tools/archaeology/source-constant-verify.mjs | verified |
| perf-009 | perf.md:131 | __heap_base (static data end, heap start) | 1,512,336 bytes | measurement | tools/archaeology/wasm-stamp.mjs | verified |
| perf-010 | perf.md:132 | zone pool malloc size | 4,194,304 bytes | derived | 4 × 1024 × 1024 = 4,194,304 (32 MB pre-14.2c) | derived-from-gated |
| perf-011 | perf.md:139 | plutonia.wad file size (worst single IWAD) | 17,420,824 bytes | measurement | tools/archaeology/stamp-check.mjs | verified |
| perf-012 | perf.md:134 | peak heap address worst-case single IWAD | ~25.42 MB | derived | 5,042,416 + 4,194,304 + 17,420,824 = 26,657,544 B ≈ 25.42 MB | derived-from-gated |
| perf-013 | perf.md:135 | headroom vs 64 MB (single IWAD) | ~10.18 MB | derived | 64 MB − 53.82 MB ≈ 10.18 MB | derived-from-gated |
| perf-014 | perf.md:148 | INITIAL_MEMORY floor (tested pass/fail boundary) | 56 MB | measurement | requires emcc INITIAL_MEMORY sweep build; no current script | unverifiable |
| perf-015 | perf.md:212 | all deliverables total gzip-9 wire size | 200.8 KB | measurement | tools/payload-size.mjs (derived from sw.js SHELL_FILES) | verified |
| perf-016 | perf.md:213 | JS + CSS + HTML gzip-9 total (no wasm, no glue) | 67.1 KB | measurement | tools/payload-size.mjs (derived from sw.js SHELL_FILES) | verified |
| perf-017 | perf.md:225 | bsp+segs avg ms/frame — wbox (3-demo avg) | 0.2625 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-018 | perf.md:225 | bsp+segs avg ms/frame — tank | 0.0549 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-019 | perf.md:225 | bsp+segs avg ms/frame — pi5 | 0.0715 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-020 | perf.md:225 | bsp+segs avg ms/frame — alder | 0.0481 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-021 | perf.md:226 | planes avg ms/frame — wbox | 0.1566 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-022 | perf.md:227 | masked avg ms/frame — wbox | 0.0637 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-023 | perf.md:228 | frame-setup avg ms/frame — wbox | 0.0069 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-024 | perf.md:229 | render total avg ms/frame — wbox | 0.4897 ms | derived | sum of perf-017/021/022/023 | derived-from-gated |
| perf-025 | perf.md:230 | sim avg ms/tic — wbox | 0.0706 ms | measurement | tools/bench.mjs + bench-baseline.json | dated-measurement |
| perf-026 | perf.md:267 | wbox render fraction of 35 Hz budget | 1.71% | derived | 0.4897 / 28.571 × 100 | derived-from-gated |
| perf-027 | perf.md:275 | wbox sim fraction of 35 Hz budget | 0.25% | derived | 0.0706 / 28.571 × 100 | derived-from-gated |
| perf-028 | perf.md:239 | bsp+segs share of wbox render total | 53.6% | derived | 0.2625 / 0.4897 × 100 | derived-from-gated |
| perf-029 | perf.md:240 | planes share of wbox render total | 32.0% | derived | 0.1566 / 0.4897 × 100 | derived-from-gated |
| perf-030 | perf.md:241 | masked share of wbox render total | 13.0% | derived | 0.0637 / 0.4897 × 100 | derived-from-gated |
| perf-031 | perf.md:242 | frame-setup share of wbox render total | 1.4% | derived | 0.0069 / 0.4897 × 100 | derived-from-gated |
| perf-032 | perf.md:251 | wbox/alder bsp+segs speed ratio | 5.46× | derived | 0.2625 / 0.0481 ≈ 5.46 | derived-from-gated |
| perf-033 | perf.md:426 | total Chocolate Doom tics cross-validated | 44,580 | measurement | external Chocolate Doom instrumented run; no current script in repo | unverifiable |
| perf-034 | perf.md:712 | R_DrawColumn calls/frame avg (doom demo1) | 714.8 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_COL_STATS build, ±2% tol) | verified |
| perf-035 | perf.md:502 | R_DrawColumn avg pixels/call | 47.9 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_COL_STATS build, ±2% tol) | verified |
| perf-036 | perf.md:712 | R_DrawColumn total pixels/frame | 34,203 | derived | tools/archaeology/derived-check.mjs (±1% tolerance; inputs from unverifiable perf-034/035) | verified |
| perf-037 | perf.md:713 | R_DrawSpan calls/frame avg | 147.8 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_COL_STATS build, ±2% tol) | verified |
| perf-038 | perf.md:503 | R_DrawSpan avg pixels/call | 168.2 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_COL_STATS build, ±2% tol) | verified |
| perf-039 | perf.md:713 | R_DrawSpan total pixels/frame | 24,854 | derived | tools/archaeology/derived-check.mjs (±1% tolerance; inputs from unverifiable perf-037/038) | verified |
| perf-040 | perf.md:543 | task-2.2 unroll-4: bsp+segs improvement (wbox) | −3.5% | measurement | historical experiment requiring specific commit comparison; no current script | unverifiable |
| perf-041 | perf.md:549 | task-2.2 unroll-4: render total improvement (wbox) | −1.5% | measurement | historical experiment requiring specific commit comparison; no current script | unverifiable |
| perf-042 | perf.md:878 | -Os CODE section size reduction vs -O3 | −33.0% | measurement | requires separate -Os emcc build; no current script | unverifiable |
| perf-043 | perf.md:880 | -Os gzip-9 wire size reduction | −15.1% | measurement | requires separate -Os emcc build; no current script | unverifiable |
| perf-044 | perf.md:902 | -Os sim fps regression on wbox | −9.3% | measurement | requires -Os build bench.mjs run; no current script | unverifiable |
| perf-045 | perf.md:1043 | visplane R_FindPlane calls/frame — doom demo1 avg | 33.1 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_PLANE_STATS build, ±2% tol) | verified |
| perf-046 | perf.md:739 | visplane R_FindPlane iters/frame — doom demo1 avg | 205.2 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_PLANE_STATS build, ±2% tol) | verified |
| perf-047 | perf.md:739 | visplane peak count — doom demo1 | 33 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_PLANE_STATS build, exact) | verified |
| perf-048 | perf.md:1046 | visplane R_FindPlane calls/frame — tnt demo2 avg | 56.1 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_PLANE_STATS build, ±2% tol) | verified |
| perf-049 | perf.md:742 | visplane R_FindPlane iters/frame — tnt demo2 avg | 451.5 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_PLANE_STATS build, ±2% tol) | verified |
| perf-050 | perf.md:742 | visplane peak count — tnt demo2 (worst recorded) | 68 | measurement | tools/archaeology/runtime-stat-verify.mjs (WEB_PERF_PLANE_STATS build, exact) | verified |
| perf-051 | perf.md:1072 | PSX fire ms/tick — wbox (G-T56N) | 0.072 ms | measurement | fire.js timing requires browser/JS benchmark harness; no current script | unverifiable |
| perf-052 | perf.md:1070 | PSX fire ms/tick — alder | 0.0078 ms | measurement | fire.js timing requires browser/JS benchmark harness; no current script | unverifiable |
| perf-053 | perf.md:1071 | PSX fire ms/tick — pi5 | 0.0222 ms | measurement | fire.js timing requires browser/JS benchmark harness; no current script | unverifiable |
| perf-054 | perf.md:1074 | PSX fire headroom vs 1 ms budget (wbox) | ~14× | derived | 1.0 / 0.072 ≈ 13.9 ≈ 14 | derived-from-gated |
| perf-055 | perf.md:§v1-fps | wbox v1 fps after int64 change | 21,107 tics/s | measurement | bench-baseline.json (v1.frameThroughput.wbox-amd-g-t56n.after) | dated-measurement |
| perf-056 | perf.md:§v1-fps | alder v1 fps (pre-int64, f92fc05) | 204,937 tics/s | measurement | bench-baseline.json (v1.frameThroughput.alder.before) | dated-measurement |
| perf-057 | perf.md:§v1-fps | tank v1 fps (pre-int64) | 105,868 tics/s | measurement | bench-baseline.json (v1.frameThroughput.tank.before) | dated-measurement |
| perf-058 | perf.md:§v1-fps | pi5 v1 fps (pre-int64) | 79,377 tics/s | measurement | bench-baseline.json (v1.frameThroughput.pi5.before) | dated-measurement |
| perf-059 | perf.md:983 | worst PWAD combo peak heap (tnt.wad + tnt31.wad) | 23.06 MB | measurement | tools/archaeology/stamp-check.mjs (arithmetic from wad file sizes + perf-009 + perf-008) | verified |
| perf-059b | perf.md:1291 | PWAD combo peak heap (doom2.wad + nerve.wad) | 23.01 MB | measurement | tools/archaeology/stamp-check.mjs (arithmetic from wad file sizes + perf-009 + perf-008) | verified |
| perf-059c | perf.md:1280 | PWAD combo peak heap (doom.wad + sigil.wad) | 21.70 MB | measurement | tools/archaeology/stamp-check.mjs (arithmetic from wad file sizes + perf-009 + perf-008) | verified |
| perf-059d | perf.md:1280 | PWAD combo peak heap (plutonia.wad, no PWAD) | 22.06 MB | measurement | tools/archaeology/stamp-check.mjs (arithmetic from wad file sizes + perf-009 + perf-008) | verified |
| perf-060 | perf.md:995 | headroom vs 64 MB for worst PWAD combo | 9.17 MB | derived | 64 − 54.83 = 9.17 MB | derived-from-gated |
| perf-061 | perf.md:1325 | doom.wad mean instr/tic (cycle floor, alder, 13.1a) | 1,218,022 | measurement | tools/freestanding/cycle-floor.sh → tools/golden/cycle-floor.json | dated-measurement |
| perf-062 | perf.md:1326 | doom2.wad mean instr/tic (cycle floor, alder, 13.1a) | 1,305,794 | measurement | tools/freestanding/cycle-floor.sh → tools/golden/cycle-floor.json | dated-measurement |
| perf-063 | perf.md:1327 | tnt.wad mean instr/tic (cycle floor, alder, 13.1a) | 1,307,707 | measurement | tools/freestanding/cycle-floor.sh → tools/golden/cycle-floor.json | dated-measurement |
| perf-064 | perf.md:1328 | plutonia.wad mean instr/tic (cycle floor, alder, 13.1a) | 1,353,868 | measurement | tools/freestanding/cycle-floor.sh → tools/golden/cycle-floor.json | dated-measurement |
| perf-065 | perf.md:1330 | worst-case demo p99 instr/tic (doom-demo4, alder, 13.1a) | 2,693,222 | measurement | tools/freestanding/cycle-floor.sh → tools/golden/cycle-floor.json | dated-measurement |

---
| ea-048 | engine-archaeology.md:§6 | HACX COLORMAP mismatches vs the (32-L)/32 euclid recipe | 3,517 / 8,192 | invariant | tools/archaeology/colormap-cross-palette.c | verified |
| ea-049 | engine-archaeology.md:§6 | doom-family WADs shipping byte-identical PLAYPAL+COLORMAP | 4 | invariant | tools/archaeology/colormap-cross-palette.c | verified |
| readme-001 | README.md:5 | wasm size quoted in README, KB | 292 | measurement | tools/archaeology/size-ledger.mjs | verified |
| size-001 | perf.md:§size | doom.wasm raw bytes at the 14.2f base | 356,216 | measurement | tools/archaeology/size-ledger.mjs | dated-measurement |
| size-002 | perf.md:§size | doom.wasm gzip-9 bytes at the 14.2f base | 146,358 | measurement | tools/archaeology/size-ledger.mjs | dated-measurement |
| size-003 | perf.md:§size | fs-doom .text bytes at the 14.2f base | 294,785 | measurement | tools/archaeology/size-ledger.mjs | dated-measurement |
| size-004 | README.md:5 | README KB figure == round(raw/1024); same fact as readme-001 | 292 | derived | tools/archaeology/size-ledger.mjs | verified |
| spec-001 | spec.md:102 | fire.js cost per tick, alder, ms | 0.008 | measurement | (node microbench, 2026-07-16; not re-runnable here) | unverifiable |
| spec-002 | spec.md:102 | fire.js cost per tick, pi5, ms | 0.022 | measurement | (node microbench, 2026-07-16; pi5 retired 2026-09-11) | unverifiable |
| spec-003 | spec.md:102 | fire.js cost per tick, wbox, ms | 0.072 | measurement | (node microbench, 2026-07-16; not re-runnable here) | unverifiable |
| md-tic-001 | README.md:70 | tics cross-validated against instrumented Chocolate Doom | 44,580 | measurement | tools/build-choco-reference.sh + demo-test.mjs --cross | unverifiable |

## Summary


**Total claims: 207** — asserted against this table by
`tools/archaeology/claims-index-check.mjs`, which also refuses a row that says
`verified` without a matching entry in `claims.json`, a manifest id with no row,
and a reproducer path that does not exist.

### What the status column means

Before task 24.2 it said `verified` for 50 rows that nothing checked anywhere.
The vocabulary now carries its weight:

| status | meaning |
|--------|---------|
| `verified` | present in `claims.json`; `verify-all.sh` regenerates and compares it |
| `dated-measurement` | measured once, on a stated host and date; not re-runnable here |
| `derived-from-gated` | arithmetic over gated inputs, stated in the row |
| `unverifiable` | declared so in `claims.json`, with a reason |

| type | count |
|------|-------|
| derived | 36 |
| invariant | 86 |
| measurement | 82 |

| status | count |
|--------|-------|
| dated-measurement | 29 |
| derived-from-gated | 24 |
| unverifiable | 17 |
| verified | 134 |

134 of 204 rows are gated by `claims.json`
(154 manifest entries; the difference is rows whose status says, out
loud, that nothing checks them).  The old summary claimed "172 / 188 = 91%"
alongside a stated total of 193 — three mutually inconsistent numbers in one
document, which is what prompted 24.2.

---

## Findings

**FINDING-5 (ea-018): the COLORMAP recipe was published as "proven universal" on
evidence that is vacuous — and the claim is false.**
`engine-archaeology.md` §6 and the **public** `docs/magic-data.md` both said the
recipe was verified "0/8,192 mismatches on doom.wad, doom2.wad, AND plutonia.wad
— three independently-authored palettes, same recipe, so this is the tool's actual
algorithm, **not an overfit**." Two independent defects:

1. **The three palettes are one palette.** `doom2`, `plutonia`, `tnt` and `chex`
   ship PLAYPAL **and** COLORMAP byte-identical to `doom.wad` (verified byte-exact;
   `ea-049` = 4 identical). Running the recipe against them re-executes the
   identical computation on identical input. The 0/8,192 figure is TRUE and
   regenerated green on every gate run — it simply carried no information beyond
   one WAD, so the "not an overfit" inference had nothing behind it.
2. **Universality is falsified.** `hacx.wad` — the only genuinely distinct palette
   in `wads/lib/` (748/768 palette bytes differ) — misses **3,517/8,192 (43%)**
   (`ea-048`), reproducing **0 of 32** levels under every metric/scale variant.
   Not explicable as a bad colormap: HACX map 0 is 255/256 identity and map 31 is
   255/256 near-black **in HACX's own palette** (a palette-dependent test).

**RESOLVED (task 7.3)** — §6 rewritten: the recipe is exact **for the id palette**
and tightly determined there (the near-miss table stands); the byte-identity is
stated; HACX's falsification is stated. The public `magic-data.md` carries the
correction in place rather than a quiet deletion (same precedent as FINDING-1).
**What survives is stronger than what was lost**: fitting the best scale per light
level against HACX's *own* colormap independently recovers `(32−L)/32` to within
0.008 across all 32 levels. The **curve** is id's and generalizes; the
**nearest-colour matcher** does not (~91–147 of 256 entries/level miss at the
best-fit scale). The matcher divergence is **not root-caused** — recorded as an
open question, not guessed at. Guarded by `colormap-cross-palette.c` (ea-048/049).

**Why no gate caught this:** the verifiers check that a **number regenerates**,
never that the **inputs were distinct**. Every figure here was correct. See also
FINDING-6 ("the entire platform surface is in three files" — it is five). A claim
whose force comes from *N independent sources* needs those sources hashed, not
counted. Recorded in `Plans.md` as the general lesson.

**FINDING-4 straggler (ea-026): the public writeup still said 92 after the fix
landed internally.** `engine-archaeology.md` was corrected to **91** by FINDING-4,
and `claims.json` records `expected: "91"`, but `docs/magic-data.md` still read
"standard luma formulas miss it by 92" until task 7.3. **Root cause:**
`doc-drift.mjs` builds its doc index from `claims-index.md`, whose locators all
point at `engine-archaeology.md` — **`magic-data.md` is not in the drift-check's
scope at all**, so the one document that is actually published is the one document
the gate cannot see. Corrected to 91.

**The scope gap was closed by task 6.5** and this row said otherwise until round
6: `doc-drift.mjs` carries a `PUBLIC_HINTS` map keyed by claim id, re-checks the
same manifest value against `magic-data.md`'s own prose, and treats a mismatch
as a HARD failure. The residual is narrower and worth stating exactly: that map
holds **14 claim ids**, so only those figures are cross-checked in the published
doc. A number appearing in `magic-data.md` without an entry there is still
unseen — the hole is one of coverage now, not of scope.

**FINDING-1 (ea-023): invuln COLORMAP match count — doc says 242/256, script says 241/256.**
`tools/archaeology/colormap-invuln-crack.c` reports `15/256 mismatches`;
256 − 15 = 241, not 242. The doc also states "residual 15 are nearest-colour
tie-breaks", but 242 + 15 = 257 ≠ 256.  The correct value is **241/256**.
This is an arithmetic error in `engine-archaeology.md:137`.

**RESOLVED (lead, same cycle)** — ground truth reproduced directly:
`colormap-invuln-crack.c PLAYPAL.lmp COLORMAP.lmp` →
`gray = 254 - ((76*r+152*g+34*b)>>8) → 15/256 mismatches (wsum=262)`.
Corrected to **241/256** in `engine-archaeology.md` AND in the public
`docs/magic-data.md` writeup (which had inherited the error before it was
published). The formula and the 15-tie-break characterization were correct;
only the match count was off by one.

**FINDING-2 (ps-033): doom-demo1 tic count — doc says 1,710, bench shows 1,709 frames.**

**RESOLVED (task 6.2)** — Both figures are correct; they measure different things.
`tools/golden/doom-demo1.json` records `"tics": 1710` (gametics run by the timedemo
engine).  `tools/golden/bench-baseline.json` (perStage, all four hosts) records
`"frames": 1709` because `tools/bench.mjs` calls `web_wipe_skip()` before each frame
to suppress wipe transitions for determinism; this suppresses the wipe frame, reducing
rendered-frame count by 1.  The same 1-frame delta appears for every demo (demo2:
2347 vs 2346; demo3: 3863 vs 3862).  The doc figure 1,710 tics is **correct**; no
doc change needed.  The `ps-033` claim is verified by `stamp-check.mjs` reading the
golden file; `bench-baseline.json` intentionally records rendered frames, not total tics.

**FINDING-3 (ea-014): gamma table level-4 residual — doc said 51/256, script found 34/256.**

**RESOLVED (task 6.2)** — `tools/archaeology/gamma-crack.mjs` sweeps γ from 0.5 to 5.0
at 0.001 steps and finds the minimum residual for level-4 is **34/256** at γ ≈ 2.011,
not 51/256 as originally stated in `engine-archaeology.md:82`.  The doc value was likely
computed with coarser γ granularity.  Levels 0–3 verify correctly (5, 34, 36, 41
mismatches respectively).  `engine-archaeology.md` level-4 row corrected to
"best γ ≈ 2.011, residual 34/256".  `docs/magic-data.md` had no gamma figure to correct.
ea-014 expected value updated to 34/256 in this index.

**NOTE (ps-018): diagonal speed 47,000 is stated as a fixed constant but is
not obviously derived from the sim constants alone.** The doc's derivation at
`playsim.md:624` claims ~0.717 × FRACUNIT ≈ 46,998 ≈ 47,000; `derived-check.mjs`
verifies that 0.717 × 65536 ≈ 46,989 rounds to 47,000 within ±500 units tolerance.
