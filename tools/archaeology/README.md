# tools/archaeology — the reproducers behind engine-archaeology.md

Every derived figure in `docs/engine-archaeology.md` (where a 1993 table or
constant came from, and what it implies) has a program here that recomputes it.
None of them is part of the engine build.

`run.mjs` is the `archaeology` suite leg. It runs each reproducer and requires
it to exit 0 and to emit the values listed in its own `expect` table, or, for
the two that carry their expected values inside (`source-constant-verify.mjs`
and `wad-verify.mjs`), to report every check passed. It reads no documents: a
figure quoted in prose is kept in step with `run.mjs` by whoever edits either.

| reproducer | what it recomputes |
|---|---|
| `source-constant-verify.mjs` | constants in `engine/core`, including the raised renderer and playsim limits (MAXSEGS, MAXVISSPRITES, MAXSPECIALCROSS), which no demo golden would notice being lowered |
| `wad-verify.mjs` | figures read from `doom.wad` (needs `wads/`) |
| `finesine-stats.mjs`, `gamma-crack.mjs`, `rndtable-stats.c` | the sine, gamma and random tables from their recipes |
| `fixeddiv-proof.c`, `fixedmul-proof.c`, `angle-roundtrip-check.c`, `aprox-distance-crack.c` | the fixed-point arithmetic proofs |
| `checkcoord-verify.mjs`, `zlight-distmap.mjs` | the bounding-box and light-distance tables |
| `colormap-crack.c`, `colormap-invuln-crack.c`, `colormap-cross-palette.c` | the COLORMAP recipe against the WAD's own lump (need `wads/`) |

`rndtable.h` is the 256-byte random table, extracted, for `rndtable-stats.c`.
