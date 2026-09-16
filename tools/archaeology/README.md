# tools/archaeology — the claims machinery, and the crack programs behind it

Two things live here. The crack programs are the standalone forensics behind
`docs/engine-archaeology.md`: none are part of the engine build, and they
exist so every claim in that document can be re-run. The verifiers are what
turned those claims into a gate: `verify-all.sh` checks each one three ways
(`doc figure == claims.json expected == script output`) and is the `doc-drift`
suite leg; `--full` adds the families that need an instrumented build, and is
the `stamp-full` leg.

## The verifier families (`verify-all.sh`)

| family | script | what it checks |
|---|---|---|
| source-constant | `source-constant-verify.mjs` | a constant in `engine/core` equals the doc's figure |
| wad-data | `wad-verify.mjs` | a figure read from an IWAD (needs `wads/`) |
| recipe-crack | `finesine-stats.mjs`, `gamma-crack.mjs`, `rndtable-stats.c`, `fixeddiv-proof.c`, `fixedmul-proof.c`, `aprox-distance-crack.c`, `angle-roundtrip-check.c`, `checkcoord-verify.mjs`, `zlight-distmap.mjs`, `ledger-count.mjs` | a table or constant regenerates from its recipe |
| derived | `derived-check.mjs` | a figure computed from other gated figures |
| citations | `check-citations.mjs` | every `file:line` in `docs/*.md` points at what it names |
| colormap | `colormap-crack.c`, `colormap-invuln-crack.c`, `colormap-cross-palette.c` | COLORMAP recipe vs the WAD's own lump (needs PLAYPAL/COLORMAP) |
| runtime-stat (`--full`) | `runtime-stat-verify.mjs` | counters read from the instrumented `build-perf/` |
| measurement-stamp (`--full`) | `stamp-check.mjs`, `wasm-stamp.mjs`, `size-ledger.mjs`, `payload-size.mjs` (in `tools/`) | artifact sizes and section stamps |

The manifest is `claims.json`; `claims-summary.mjs --counts` computes every
coverage figure the verdict prints. `doc-drift.mjs` runs last and compares the
three sources per claim.

## The index checkers (each is its own suite leg)

| leg | script | asserts |
|---|---|---|
| `claims-index` | `claims-index-check.mjs` | `docs/claims-index.md` rows match the manifest, including the value column |
| `promises-index` | `promises-index-check.mjs` | `docs/promises-index.md` and README's counts match the registry |
| `status-drift` | `status-drift-check.mjs` | no document says "still open" about a landed verdict; Plans.md agrees with itself |
| `docs-index` | `docs-index-check.mjs` | every file under `docs/` is linked from `docs/README.md` |
| `size-ledger` | `size-ledger.mjs` | `doom.wasm` against `size-budget.json` and README's KB figure |

## Crack programs run by hand (not by any gate)

- `prng-crack-lcg.c`, `prng-crack-bsd.c`, `prng-crack-full.c` — rndtable vs
  every standard-library PRNG family, full 2^32 (`-fopenmp`, ~2 min on 24
  threads). All three report "no match": the table is not a library PRNG.
  `rndtable.h` is the 256-byte canon table, extracted.
- `fixeddiv-microbench.c` — the timing behind the FixedDiv verdict.

## Measurement tools elsewhere in `tools/`, outside the suite by design

These produce numbers or artifacts rather than verdicts, so `gate-census`
does not count them and no leg runs them: `bench.mjs` (run remotely by
`fleet-bench.sh`, the `perf-fleet` leg), `browser-metrics.mjs`, `gen-tables.mjs`
(writes `golden/tables-canon.json`), `hol-measure.mjs`, `plane-measure.mjs`,
`zone-measure.mjs`, `build-choco-reference.sh` (needs SDL2),
`freestanding/{cycle-attrib,cycle-floor,gen-imports,zone-stats}.sh`,
`native-sanitize/compare.py`, `coverage/parse-gcov.py`, `386/fetch-roms.sh`,
`rp2040/prep-whd.sh`. The three that are gate-shaped but cannot run are in
`tools/gates-not-in-suite.json` with their reasons.
