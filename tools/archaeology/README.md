# Engine archaeology — reproducible crack programs

Standalone forensics behind `docs/engine-archaeology.md`. None are part
of the engine build; they exist so every claim in the doc can be re-run.

- `prng-crack-lcg.c`  — LCG family (ANSI/Borland/MSVC/V7) vs rndtable, full 2^32
- `prng-crack-bsd.c`  — 4.3BSD rand + BSD random() vs rndtable
- `prng-crack-full.c` — drand48/lrand48/random(), parallel full 2^32 (OpenMP)
- `rndtable.h`        — the 256-byte canon table, extracted

Build & run:
    gcc -O3 -fopenmp prng-crack-full.c -o crack && ./crack   # ~2 min, 24 threads
All three report "no match" — the table is not any standard-library PRNG.

## COLORMAP crackers

- `colormap-crack.c`        — light levels vs scale/metric, exact recipe found
- `colormap-invuln-crack.c` — invuln inverse-luma weight search

Build & run (needs PLAYPAL.bin + COLORMAP.bin extracted from a WAD):
    gcc -O2 colormap-crack.c -lm -o cm && ./cm PLAYPAL.bin COLORMAP.bin
Reports 0/8192 mismatches at scale=2 (round) with the Euclidean metric —
verified identical across doom, doom2, and plutonia palettes.
