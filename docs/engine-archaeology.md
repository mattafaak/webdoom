# Engine archaeology

Forensic reverse-engineering of DOOM's "magic data" — the hardcoded
blobs whose 1992 generators were never documented and, in most retellings,
never questioned. Everything here is verified against `tools/golden/`
canon and, where it feeds the simulation, against the demo traces.

## 1. Trigonometry tables — CRACKED, regenerated at boot

`finesine` (10,240), `finetangent` (4,096), `tantoangle` (2,049):
64 KB of frozen data, now computed at boot from reverse-engineered
recipes + a correction stream (see `engine/core/tables.c`,
`tools/gen-tables.mjs`).

- **Recipe**: `sin`/`tan` with **truncation toward zero** and an
  **`(i + 0.5)` phase**, `atan(i/2048)` for the arctangent.
- **The "errors" are canon**: 5,377 of 10,240 finesine entries differ
  from ideal round-to-nearest (±1), because id truncated. Every demo
  depends on every wrong bit.
- Against a modern libm the truncation recipe leaves **33 finesine
  exceptions** — razor-edge values where the 1992 machine's last bit
  differed. These are entropy-coded into ~11 KB of corrections; a boot
  checksum (FNV over all 16,385 entries) refuses to run if the
  toolchain's libm ever computes differently.

## 2. FixedDiv float-vs-integer equivalence — PROVEN

linuxdoom-1.10 computes `FixedDiv` in `double`:
`(double)a / (double)b * 65536`. DOS DOOM used a 64/32 integer `idiv`.
Modern ports use `((int64)a << 16) / b` and trust demos.

**Claim (proven): all three are bit-identical over the guarded domain**
(`|a| >> 14 < |b|`, else the function clamps).

- *Sketch*: the guard bounds `|a/b| < 2^14`, so `a/b * 2^16 < 2^30` and
  every integer-boundary image `k / 2^16` needs ≤ 46 significant bits —
  exactly representable in a `double` (53-bit mantissa). Round-to-nearest
  cannot move a value **across** an exactly-representable point, so the
  double result and the truncating-integer result always fall in the
  same unit interval → same `(int)` cast.
- *Empirical*: 2×10⁹ random in-domain pairs + 1.8×10⁶ adversarially
  constructed near-boundary pairs → **zero** mismatches.
- *Consequence*: our `FixedDiv` can use the int64 form (faster in wasm,
  and by construction the exact value the DOS `.exe` produced) with a
  guarantee, not a hope. The double path's dead divide-by-zero
  `I_Error` is unreachable under the guard.

## 3. The random table — PROVEN not a standard PRNG

`rndtable[256]` drives every damage roll, monster decision, and
gunshot spread in the game. Folklore says "random numbers someone
typed in." We can now be precise about what it is **not**.

Brute-forced the **entire 2³² seed space** of every ubiquitous
generator, requiring an exact 256-byte match:

| generator | result |
|-----------|--------|
| ANSI C LCG (`1103515245·s+12345`, `>>16 & 0x7fff`), `%256` and `&255` | no match |
| Borland, Microsoft C, V7 LCG variants | no match |
| 4.3BSD `rand()` low byte (full 2³²) | no match |
| `drand48` top byte / `lrand48() % 256` (full 2³²) | no match |
| BSD `random()` additive feedback, both inits, warmup 0 and 310 | no match |

**Conclusion**: DOOM's random table is not the output of any of the
canonical C PRNGs of its era at any seed. It was hand-authored (or from
a source outside the standard libraries). Statistics fit the story: mean
128.85 (not 127.5), only 166 of 256 values distinct, 90 values of 0–255
never appear — a *worse* distribution than any LCG would give, i.e. the
fingerprint of human typing, not an algorithm. This is a strong,
exhaustive negative result, not an absence of evidence.

## 4. Gamma tables — approximate power curves, no exact recipe

`gammatable[5][256]` (display brightness correction). Fit to
`round(255 · ((i+0.5)/256) ^ (1/γ))`:

| level | best γ | residual mismatches |
|-------|--------|---------------------|
| 0 | ~1.00 | 5 / 256 |
| 1 | ~1.15 | 34 |
| 2 | ~1.34 | 36 |
| 3 | ~1.61 | 41 |
| 4 | ~2.01 | 51 |

The curves are unmistakably power functions, and the black floors are
exact powers of two (min values **2, 4, 8, 16** for levels 1–4 — the
darkest input never maps below `2^level`). But **no single closed form
reproduces any level exactly**, and level 0 is not even identity. Verdict:
hand-adjusted power curves, or a generator tool now lost. Unlike the trig
tables, these are display-only (never touch the sim), so exactness is
cosmetic — kept as canon data, not regenerated.

## 5. P_AproxDistance — the honest approximation

`dist = max(|dx|,|dy|) + min(|dx|,|dy|)/2` — the octagonal
"alpha max plus beta min" norm, used for blockmap/sight culling.
Not a fossil (it's transparent code), but worth stating its exact
character, since the usual retelling gets it wrong. Measured error:
**+11.8% at 26.6° (arctan ½)** — *not* at 45°, where it is only +6.1%.
It **never underestimates** (0% error on the axes), so blockmap/sight
culling stays conservative and can't wrongly hide a monster. It feeds
the sim, so it is frozen — but now its worst case is measured, and the
"worst at 45°" folklore is corrected. (This write-up originally repeated
that folklore; the measurement in `docs` caught it.)

## 6. COLORMAP light-diminishing tables — CRACKED, universal

The 8,704-byte `COLORMAP` WAD lump: 34 maps of 256 bytes. Maps 0–31 are
the light levels that darken every wall, floor, and sprite with distance;
map 32 is the invulnerability-powerup inverse; map 33 is all-black
(fog/blackout). It was generated by a lost tool doing a nearest-color
search over the palette — the single most-consulted table in the whole
renderer, and nobody's recorded its exact recipe.

**Light levels (maps 0–31) — exact recipe, proven universal:**

```
colormap[L][i] = argmin_j || palette[j] − round(palette[i] · (32−L)/32) ||²
```

i.e. darken each palette colour by the linear factor `(32−L)/32`, round
to nearest, and take the **Euclidean**-nearest palette index. Verified
**0 / 8,192 mismatches on doom.wad, doom2.wad, AND plutonia.wad** — three
independently-authored palettes, same recipe, so this is the tool's
actual algorithm, not an overfit. (Manhattan and luma-weighted metrics
miss by 1,200+; truncation instead of rounding misses by 313; the
`(31−L)/31` scale misses by 2,373. The recipe is tightly determined.)

Notable: map 0 is *not* pure identity (249/256) — a handful of palette
colours have a nearer neighbour than themselves, because the DOOM palette
contains near-duplicate entries.

**Invulnerability map (32) — characterized:** every entry resolves to a
grayscale-ramp colour via inverse luma,
`gray = 254 − ((76·r + 152·g + 34·b) >> 8)`, then nearest gray — matching
242/256. The residual 15 are nearest-colour tie-breaks in the gray ramp.
Weights sum to 262 (slope ~1.023, not the textbook 0.299/0.587/0.114),
which is why standard luma missed by 92. Cosmetic full-screen effect,
never touches the sim, so it is kept as canon rather than regenerated.

**Map 33:** all zeros. (Trivially the blackout.)

Crackers: `tools/archaeology/colormap-crack.c`,
`colormap-invuln-crack.c`.

---

### Method note

The recurring pattern: a "just how it's always been" blob is either
(a) a simple recipe plus a fossilized rounding/precision quirk (trig,
mostly gamma), (b) provably equivalent to a faster modern form
(FixedDiv), or (c) genuinely irreducible human data (rndtable). Knowing
*which* is the difference between copying the game and understanding it.
