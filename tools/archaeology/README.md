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
