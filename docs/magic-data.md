# DOOM's Magic Data, Cracked — and Reproducible

*The hardcoded tables nobody documented, reverse-engineered from first
principles and regenerated from source. Every number below is produced by a
script you can run.*

Repo: **https://github.com/mattafaak/webdoom** ·
Full ledger: [`docs/engine-archaeology.md`](https://github.com/mattafaak/webdoom/blob/master/docs/engine-archaeology.md) ·
Crackers: [`tools/archaeology/`](https://github.com/mattafaak/webdoom/tree/master/tools/archaeology)

---

We all know DOOM "runs on everything." I wanted to know something narrower and
harder: do we actually *understand* everything it runs on? Building a clean-room
browser port from `linuxdoom-1.10`, I kept hitting the same wall — the engine is
full of frozen data blobs (`finesine`, `COLORMAP`, `rndtable`, the gamma curves)
whose 1992 generators were never written down, and which most retellings repeat
without ever questioning. "Random numbers someone typed in." "Lookup tables
because CPUs were slow." Fine — but *which* numbers, from *what* recipe, and can
we prove it?

Turns out most of them crack. Here's what fell out, with the receipts.

## 1. The trig tables aren't magic — they're a recipe plus fossilized rounding

`finesine` (10,240 entries), `finetangent` (4,096), and `tantoangle` (2,049) are
64 KB of frozen sines and tangents. The recipe that reproduces them:

- **`sin`/`tan` with truncation toward zero** (not round-to-nearest), on an
  **`(i + 0.5)` phase**; `atan(i/2048)` for the arctangent.

The truncation is the whole story. **5,377 of the 10,240 `finesine` entries
differ from an ideal round-to-nearest table by ±1** — not because id was sloppy,
but because they truncated, and every DOOM demo ever recorded depends on every
one of those "wrong" bits. Get the rounding right and the demos desync.

Run the recipe against a *modern* libm and you're left with just **33 `finesine`
exceptions** — razor-edge values where the 1992 machine's last mantissa bit
happened to fall the other way. Those 33 are entropy-coded into ~11 KB of
corrections, and a boot-time FNV checksum over all 16,385 table entries refuses
to start the engine if the host toolchain's libm ever computes them differently.
So the port ships a *recipe plus a 33-value fossil record*, not a 64 KB blob —
and it's self-verifying.

## 2. The COLORMAP recipe — cracked, and proven *universal*

The 8,704-byte `COLORMAP` is the single most-consulted table in the renderer: 34
maps of 256 bytes that darken every wall, floor, and sprite with distance. It was
built by a tool that's been lost for 30 years. The exact recipe:

```
colormap[L][i] = argmin_j ‖ palette[j] − round(palette[i] · (32−L)/32) ‖²
```

Darken each palette colour by the linear factor `(32−L)/32`, round to nearest,
and take the **Euclidean-nearest** palette index. That's it.

Against `doom.wad` this reproduces COLORMAP **exactly — 0 mismatches out of 8,192,
all 32 levels**. And it's tightly determined: Manhattan distance misses by 1,200+,
luma-weighted misses too, truncation instead of rounding misses by 313, and the
plausible-looking `(31−L)/31` scale misses by 2,373. Nearby recipes are not close.

**Correction (2026-07-17).** An earlier version of this page said the recipe was
verified "across `doom.wad`, `doom2.wad`, AND `plutonia.wad` — three
independently-authored palettes... not an overfit to one WAD." That was wrong
twice over, and the mistake is worth showing rather than quietly deleting:

- **Those three aren't three palettes.** `doom2`, `plutonia`, `tnt` and `chex`
  ship PLAYPAL *and* COLORMAP **byte-identical** to `doom.wad`. Running the
  recipe against them re-runs the identical computation on identical input. The
  number was true; the evidence behind it was one WAD, not three. So the
  "not an overfit" argument had nothing supporting it.
- **The recipe is not universal.** `hacx.wad` — the one genuinely independent
  palette I have (748 of its 768 palette bytes differ) — misses **3,517 / 8,192
  (43%)**, reproducing **none** of its 32 levels. HACX's COLORMAP isn't broken
  either: map 0 is 255/256 identity and map 31 is 255/256 near-black *in HACX's
  own palette*. It's a properly built colormap the recipe simply can't produce.

Here's the part I like better than the claim I lost. Fit the best darkening scale
per light level against HACX's *own* colormap, and out falls **`(32−L)/32`** —
0.994, 0.878, 0.750, 0.624, 0.496, 0.375, 0.249, 0.124, within 0.008 of the recipe
across all 32 levels. Recovered independently, from a palette id never touched.

So the curve is real and it generalizes; the **nearest-colour matching is id's
alone**. Whoever built HACX's COLORMAP used the same curve and a different matcher
— tie-breaking, a restricted search range, something. I haven't cracked that, and
I'd rather say so than dress up a guess.

The lesson generalizes past DOOM: "verified against three sources" is worth
exactly as much as the sources are independent. Mine weren't, and every number I
published was correct anyway. Hash your inputs.

The invulnerability map (map 32) is a grayscale inverse-luma ramp,
`gray = 254 − ((76·r + 152·g + 34·b) >> 8)`, matching 241/256 (the residual 15 are
gray-ramp tie-breaks). Note the weights sum to 262, slope ~1.023 — *not* the
textbook 0.299/0.587/0.114, which is why standard luma formulas miss it by 91.

Reproduce it yourself:
[`colormap-crack.c`](https://github.com/mattafaak/webdoom/blob/master/tools/archaeology/colormap-crack.c),
[`colormap-invuln-crack.c`](https://github.com/mattafaak/webdoom/blob/master/tools/archaeology/colormap-invuln-crack.c).

## 3. `rndtable` is *not* a PRNG — an exhaustive negative result

The folklore is "random numbers someone typed in." I wanted to replace the shrug
with a proof, so I brute-forced the **entire 2³² seed space** of every ubiquitous
generator of the era, requiring an exact 256-byte match:

| generator | result |
|-----------|--------|
| ANSI C LCG (`1103515245·s+12345`, `>>16 & 0x7fff`), `%256` and `&255` | no match |
| Borland, Microsoft C, V7 LCG variants | no match |
| 4.3BSD `rand()` low byte (full 2³²) | no match |
| `drand48` top byte / `lrand48() % 256` (full 2³²) | no match |
| BSD `random()` additive feedback (both inits, warmup 0 and 310) | no match |

**Not one seed of any canonical C PRNG produces DOOM's table.** And the
statistics fit the "human typing" story rather than any algorithm: mean **128.85**
(not 127.5), only **166 of 256 values distinct**, and **90 of the 256 possible
byte values never appear at all** — a *worse* distribution than any LCG would
give. That's not an absence of evidence; it's a strong, exhaustive negative
result. The table really is hand-authored (or from a source outside the standard
libraries).

Crackers:
[`prng-crack-full.c`](https://github.com/mattafaak/webdoom/blob/master/tools/archaeology/prng-crack-full.c),
[`prng-crack-lcg.c`](https://github.com/mattafaak/webdoom/blob/master/tools/archaeology/prng-crack-lcg.c),
[`prng-crack-bsd.c`](https://github.com/mattafaak/webdoom/blob/master/tools/archaeology/prng-crack-bsd.c).

## 4. `FixedDiv`: the float and the integer path are bit-identical — proven

`linuxdoom-1.10` computes `FixedDiv` in `double`; DOS DOOM used a 64/32 integer
`idiv`; modern ports use `((int64)a << 16) / b` and trust the demos. I wanted the
guarantee, not the hope.

**All three are bit-identical over the guarded domain** (`|a| >> 14 < |b|`, else
the function clamps). Sketch: the guard bounds `|a/b| < 2¹⁴`, so `a/b · 2¹⁶ < 2³⁰`
and every integer-boundary image needs ≤ 46 significant bits — exactly
representable in a `double`'s 53-bit mantissa. Round-to-nearest cannot move a
value *across* an exactly-representable point, so the double result and the
truncating-integer result always land in the same unit interval and cast to the
same `int`. Empirically: **2×10⁹ random in-domain pairs + 1.8×10⁶ adversarial
near-boundary pairs → zero mismatches.** So the fast int64 form is, by
construction, the exact value the DOS `.exe` produced.

## The part I care about most: it all regenerates

None of this is a static writeup with numbers I'm asking you to trust. The trig
tables are computed at boot from the recipe in `engine/core/tables.c`; the
crackers in `tools/archaeology/` reproduce every COLORMAP and PRNG result on
demand; and the whole engine is validated per-tic — gamestate *and* framebuffer
hashes — against instrumented Chocolate Doom across all 13 built-in IWAD demos,
44,580 tics identical. When a claim here says "0 mismatches," there's a program
in the repo that prints it.

The recurring pattern, and the thing I think is worth taking away: a
"just-how-it's-always-been" blob is almost always one of three things — (a) a
simple recipe plus a fossilized rounding quirk (the trig tables, COLORMAP), (b)
provably equivalent to a faster modern form (`FixedDiv`), or (c) genuinely
irreducible human data (`rndtable`). Knowing *which* is the difference between
copying DOOM and understanding it.

Happy to go deeper on any of these — the full 40-entry verdict ledger (every
constant blob in `engine/core`, classified) is in
[`docs/engine-archaeology.md`](https://github.com/mattafaak/webdoom/blob/master/docs/engine-archaeology.md).
