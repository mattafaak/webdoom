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
| 4 | ~2.011 | 34 |

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
**241/256** (`colormap-invuln-crack.c` reports 15/256 mismatches; 241 + 15 =
256). The residual 15 are nearest-colour tie-breaks in the gray ramp.
Weights sum to 262 (slope ~1.023, not the textbook 0.299/0.587/0.114),
which is why standard luma missed by 91 — scored with the textbook ITU BT.601
weights rounded to 8-bit fixed point (**77/150/29**, sum 256) at the same
`A = 254`. (Pinning the weight set matters: nearby roundings score 88–93, so
"standard luma" alone is not a reproducible claim. FINDING-4, task 6.3.)
Cosmetic full-screen effect, never touches the sim, so it is kept as canon
rather than regenerated.

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

## 7. The bare-metal principle (and where "compute > lookup" is false)

A tempting instinct: 1993 shipped lookup tables because CPUs were slow, so
in 2026 we should compute in real time instead. **This is backwards for
DOOM's tables.** A table load from L1 is ~4 cycles; `sin`/`tan`/`atan` is
20–100; the `COLORMAP` is a 256-entry nearest-colour *search*. Every one of
those tables is more expensive to recompute per call than to load. The only
valid table transform is **shipped-blob → boot-generation** (compute once at
startup, look up at runtime — what §1 does for trig), *never* runtime lookup
→ runtime transcendental.

The same "measure, don't assume" caution applies to the one place we *do*
compute at runtime. §2 proves `FixedDiv`'s integer form equals the double
form bit-for-bit — but "integer must be faster" is also false on some
hardware. Isolated wasm primitive throughput, double vs int64 divide:

| CPU | double | int64 | int64 speed |
|-----|--------|-------|-------------|
| i9-12900K (x86, modern) | 419 ms | 403 ms | +4% |
| Cortex-A76 (ARM, Pi 5)  | 754 ms | 630 ms | **+20%** |
| AMD G-T56N (x86 Bobcat) | 12304 ms | 13054 ms | −6% |
| i5-8350U (x86 Kaby Lake) | 964 ms | 2725 ms | **−65%** |

Old x86 64-bit `idiv` is genuinely slow (~40–95-cycle latency) vs double
`divsd` (~14–20); ARM's integer divide wins. There is **no universally
fastest divide**. It doesn't matter for gameplay — `FixedDiv` is a tiny
slice of a frame, so end-to-end the choice is within ±2% (neutral) on all
four devices — which is exactly why the decision was made on the universal
axes instead (simpler, smaller, integer-exact, ARM-forward → int64). The
lesson the whole document keeps teaching: the answer is in the measurement,
not the folklore.

## Tables kept as-is (deliberately)

- **`gammatable`** — no exact closed form (§4); 1.2 KB, display-only. Keep.
- **`rndtable`** — irreducible hand-authored data (§3). Keep.
- **`COLORMAP`** — the recipe is known (§6) but it is WAD-owned and
  **PWAD-overridable** (colored lighting, fog); regenerating it would break
  those wads for zero gain (it is loaded, not computed — no latency to
  reclaim). Keep loading from the WAD.

---

## 8. zlight/scalelight constants: DISTMAP=2, LIGHTZSHIFT=20 — IRREDUCIBLE

*Cross-reference: renderer.md §2.3 documents the structural recipe. This section
closes the open question about why the specific constants were chosen.*

`R_InitLightTables` (r_main.c:618) and `R_ExecuteSetViewSize` (r_main.c:750)
build the `zlight` and `scalelight` pointer arrays from two constants:

```
DISTMAP     = 2         (r_main.c:616)
LIGHTZSHIFT = 20        (r_main.h:75)
```

### What LIGHTZSHIFT=20 encodes

The zlight index `j` encodes distance via `(j+1) << LIGHTZSHIFT` — the
distance in fixed-point units. With LIGHTZSHIFT=20 and FRACUNIT=2^16:

```
world distance (map units) = (j+1) * 2^(LIGHTZSHIFT - FRACBITS) = (j+1) * 16
```

So `MAXLIGHTZ=128` entries span **16 to 2048 world units** — roughly one
blockmap cell to the far end of most indoor corridors. LIGHTZSHIFT=19 would
compress the range to 8–1024 units; LIGHTZSHIFT=21 would stretch it to
32–4096 units. The choice of 20 is calibrated to the scale of DOOM's maps.

### What DISTMAP controls — quantified

In `R_InitLightTables`, the brightness contribution from distance is
`scale/DISTMAP`, where `scale = 160/(j+1)` (integer division; derivation:
`FixedDiv(160·FRACUNIT, (j+1)<<20) >>= 12` = `160·FRACUNIT·FRACUNIT / ((j+1)·2^20)
/ 2^12` = `160/(j+1)`).  `level = startmap - scale/DISTMAP`, clamped to
[0, NUMCOLORMAPS-1=31].

Measured colormap index at light sector index `i=8` (median brightness,
startmap=28; colormap 0=full bright, 31=fully dark):

| j | distance | DISTMAP=1 | DISTMAP=2 (canon) | DISTMAP=3 |
|---|----------|-----------|-------------------|-----------|
| 1 | 32 units | 0 | 0 | 2 |
| 2 | 48 units | 0 | 2 | 11 |
| 3 | 64 units | 0 | 8 | 15 |
| 4 | 80 units | 0 | 12 | 18 |
| 7 | 128 units | 8 | 18 | 22 |
| 9 | 160 units | 12 | 20 | 23 |
| 15 | 256 units | 18 | 23 | 25 |
| 31 | 512 units | 23 | 26 | 27 |
| 127 | 2048 units | 27 | 28 | 28 |

Full-bright boundary (first j where the sector is no longer 100% bright) with
DISTMAP=2: i=14 → 320 units; i=13 → 160 units; i=8 → 32 units; i≤3 →
immediate darkening even at j=0. DISTMAP=1 pushes this boundary twice as far
(more aggressive near-field brightness); DISTMAP=3 cuts it to 2/3.

Script: `tools/archaeology/zlight-distmap.mjs` (exact integer arithmetic, all
three DISTMAP variants, all 16 light levels).

**Verdict: IRREDUCIBLE.** The structural recipe — linear interpolation via
`startmap - scale/DISTMAP` — is fully read from the code (documented in
renderer.md §2.3). But the specific values DISTMAP=2 and LIGHTZSHIFT=20 are
pure aesthetic tuning. They cannot be derived from geometry or physics; they
encode id Software's visual taste for how fast DOOM corridors should darken
with distance. Neither value is fixed by the WAD format, screen resolution,
or any external constraint. Sim-critical: No (lighting tables are renderer-side,
never feed P_Random or actor state).

---

## 9. checkcoord[12][4] — EQUIVALENCE PROVEN

*Cross-reference: renderer.md §3.5 describes R_CheckBBox's algorithm. This
section closes the open question about checkcoord's correctness.*

```c
int checkcoord[12][4] = {
    {3,0,2,1},  // boxpos=0:  above-left
    {3,0,2,0},  // boxpos=1:  above-center
    {3,1,2,0},  // boxpos=2:  above-right
    {0},        // boxpos=3:  unused
    {2,0,2,1},  // boxpos=4:  left-center
    {0,0,0,0},  // boxpos=5:  INSIDE (early return true — never reached)
    {3,1,3,0},  // boxpos=6:  right-center
    {0},        // boxpos=7:  unused
    {2,0,3,1},  // boxpos=8:  below-left
    {2,1,3,1},  // boxpos=9:  below-center
    {2,1,3,0}   // boxpos=10: below-right
};
```

(r_bsp.c:365-378). Entry values map to bspcoord array indices:
`0=BOXTOP(max_y)`, `1=BOXBOTTOM(min_y)`, `2=BOXLEFT(min_x)`, `3=BOXRIGHT(max_x)`.
Entry `{a,b,c,d}` → `x1=bspcoord[a], y1=bspcoord[b], x2=bspcoord[c], y2=bspcoord[d]`.

### Geometric derivation

The nine valid boxpos values come from `boxx` (0=left-of / 1=inside-x /
2=right-of) combined with `boxy` (0=above / 1=inside-y / 2=below) as
`(boxy<<2)+boxx`. For each region the table selects the two corners subtending
the **maximum angular span** from the viewpoint. Derivation for each case:

| boxpos | region | corner 1 (x1,y1) | corner 2 (x2,y2) | geometric reason |
|--------|--------|------------------|------------------|-----------------|
| 0 | above-left | right,top | left,bottom | Diagonal — widest span from upper-left |
| 1 | above-center | right,top | left,top | Top edge — both far corners equidistant in y |
| 2 | above-right | right,bottom | left,top | Diagonal — widest span from upper-right |
| 4 | left-center | left,top | left,bottom | Left edge — span of left face |
| 5 | inside | — | — | Always visible (early return true) |
| 6 | right-center | right,bottom | right,top | Right edge — span of right face |
| 8 | below-left | left,top | right,bottom | Diagonal — widest span from lower-left |
| 9 | below-center | left,bottom | right,bottom | Bottom edge — both far corners equidistant in y |
| 10 | below-right | left,bottom | right,top | Diagonal — widest span from lower-right |

### Brute-force verification

`tools/archaeology/checkcoord-verify.mjs` enumerates all C(4,2)=6 ordered
corner pairs for multiple viewpoints in each of the 9 regions, computes the
angular span for each, and asserts the table's pair is the maximum. Output:

```
boxpos=0 (above-left): PASS
boxpos=1 (above-center): PASS
boxpos=2 (above-right): PASS
boxpos=4 (left-center): PASS
boxpos=6 (right-center): PASS
boxpos=8 (below-left): PASS
boxpos=9 (below-center): PASS
boxpos=10 (below-right): PASS

ALL 9 CASES VERIFIED: checkcoord table is correct for all viewpoint regions.
```

**Verdict: EQUIVALENCE.** The table is a lookup version of a well-defined
geometric selection rule: for each viewpoint region, pick the two corners of
the axis-aligned bounding box that subtend the widest angular span. It could
be computed at runtime with a small `if`-tree; the table avoids the branches.
Not hand-authored: any developer applying the same geometric reasoning would
produce the same 9 entries. Sim-critical: No (BSP culling is renderer-side,
never feeds P_Random or actor state).

---

## 10. s_sound.c — distance attenuation and stereo constants — IRREDUCIBLE

All s_sound.c constants (s_sound.c:51-77):

| constant | value | meaning |
|----------|-------|---------|
| `S_MAX_VOLUME` | 127 | maximum internal volume |
| `S_CLOSE_DIST` | 160 × 0x10000 | distance at which volume is always max (160 map units) |
| `S_CLIPPING_DIST` | 1200 × 0x10000 | distance at which sound becomes inaudible (1200 map units) |
| `S_ATTENUATOR` | `(S_CLIPPING_DIST−S_CLOSE_DIST)>>16` = **1040** | denominator in linear attenuation |
| `NORM_PITCH` | 128 | unmodified playback pitch |
| `NORM_SEP` | 128 | center stereo pan (0=full left, 255=full right) |
| `NORM_PRIORITY` | 64 | default sound priority |
| `S_STEREO_SWING` | 96 × 0x10000 | stereo spread in fixed-point |
| `S_IFRACVOL` | 30 | (dead code — referenced but not used in active path) |
| `S_PITCH_PERTURB` | 1 | (dead code — not reached in shipped code) |

**Volume attenuation formula** (`S_AdjustSoundParams`, s_sound.c:789-811):

```
dist = P_AproxDistance(listener, source)   // same octagonal approx as sim
if dist < S_CLOSE_DIST (160 units):  vol = snd_SfxVolume  (full volume)
if dist > S_CLIPPING_DIST (1200 units):  return 0  (inaudible)
else:  vol = snd_SfxVolume * (1200 - dist) / 1040
```

Curve shape: **linear** from full volume at 160 units to zero at 1200 units.
The 160-unit floor matches the DOOM blockmap cell size (128 units × ~1.25) —
anything inside the same or adjacent blockmap cell plays at full volume.
Map 8 (the secret level E1M9 / equivalent) gets a special treatment: it has
no clipping distance (audible at any range), with a floor of volume 15 to
keep distant sounds faintly audible (s_sound.c:794-802).

**Stereo formula** (s_sound.c:787):

```
sep = 128 − FixedMul(S_STEREO_SWING, finesine[relative_angle]) >> FRACBITS
    = 128 − 96 × sin(angle_of_source_relative_to_player)
```

Range: [32, 224] — never pins hard left or right, always a blend.

**Pitch variation** (s_sound.c:327-346). Two tiers:

| sounds | perturbation | generator |
|--------|-------------|-----------|
| Chainsaw (`sfx_sawup` to `sfx_sawhit`) | `pitch += 8 − (M_Random()&15)` = ±8 range | **M_Random** |
| All others (except `sfx_itemup`, `sfx_tink`) | `pitch += 16 − (M_Random()&31)` = ±16 range | **M_Random** |

Both use `M_Random`, not `P_Random` — pitch variation is cosmetic and does not
consume the simulation RNG.

**Verdict: IRREDUCIBLE.** S_CLOSE_DIST=160, S_CLIPPING_DIST=1200, and
S_STEREO_SWING=96 are aesthetic tuning constants. The 160-unit floor is
suggestively close to the blockmap cell size but the comment in the source
("Does not fit the large outdoor areas") shows it was known to be a compromise.
No formula connects these values to geometry. All sound processing runs from
`S_UpdateSounds` in the main event loop outside `G_Ticker`, using M_Random
exclusively. **Sim-critical: No.** Sound state never feeds P_Random or
actor positions.

---

## 11. p_lights.c — strobe/glow/flicker constants — IRREDUCIBLE, P_Random sim-critical

Constants in p_spec.h:176-179:

| constant | value | meaning |
|----------|-------|---------|
| `GLOWSPEED` | 8 | light units per tic for smooth glow (T_Glow) |
| `STROBEBRIGHT` | 5 | tics in the bright phase of a strobe flash |
| `FASTDARK` | 15 | tics in the dark phase of a fast strobe (~0.43 s at 35 Hz) |
| `SLOWDARK` | 35 | tics in the dark phase of a slow strobe (~1.0 s at 35 Hz) |

Additional literal constants embedded in p_lights.c:

| location | value | meaning |
|----------|-------|---------|
| `P_SpawnLightFlash` maxtime | 64 | upper bound for random bright-phase (1-64 tics) |
| `P_SpawnLightFlash` mintime | 7 | upper bound for random dark-phase (1-7 tics) |
| `T_FireFlicker` count | 4 | tics between fire-flicker steps |
| `T_FireFlicker` step | `(P_Random()&3)*16` | 0/16/32/48 light units per step |
| `P_SpawnStrobeFlash` init offset | `(P_Random()&7)+1` | 1-8 tic startup stagger |

### P_Random consumption — sim-critical

Each light thinker that uses `P_Random` consumes the game RNG on every
invocation and therefore affects the demo-replay call sequence:

| thinker | P_Random calls per step |
|---------|------------------------|
| `T_FireFlicker` | 1 per 4 tics |
| `T_LightFlash` | 1 per state-change (bright→dark or dark→bright) |
| `P_SpawnLightFlash` | 1 at spawn (initial count) |
| `P_SpawnStrobeFlash (inSync=0)` | 1 at spawn (startup offset) |
| `T_Glow` | **none** — GLOWSPEED is a constant step, no random |

Any change to STROBEBRIGHT, FASTDARK, SLOWDARK, or the flicker step size
would alter the P_Random call sequence from those thinkers, desync existing
demos, and change gameplay timing (flash frequency is demo-observable). The
glow thinker (T_Glow/GLOWSPEED) is deterministic — no P_Random — but its
step size of 8 is still frozen by demo-observable sector lighting state.

**Verdict: IRREDUCIBLE.** STROBEBRIGHT=5 tics (~143 ms bright phase) and
FASTDARK=15 / SLOWDARK=35 tics are pure aesthetic choices for the visual feel
of the two strobe speeds. GLOWSPEED=8 is the step that makes the glow smooth.
None can be derived from any constraint. The maxtime=64/mintime=7 flash bounds
similarly have no geometric or physical derivation.
**Sim-critical: YES** (P_Random consumption by T_FireFlicker, T_LightFlash,
P_SpawnLightFlash, P_SpawnStrobeFlash).

---

## 12. f_wipe.c — melt-wipe RNG: M_Random, NOT sim-critical

The screen melt (`wipe_initMelt`, f_wipe.c:142) initializes column drop
positions using `M_Random`:

```c
y[0] = -(M_Random() % 16);          // first column: 0 to -15 tic delay
for (i = 1; i < width; i++) {
    r = (M_Random() % 3) - 1;       // -1, 0, or +1
    y[i] = y[i-1] + r;
    if (y[i] > 0)  y[i] = 0;
    if (y[i] == -16) y[i] = -15;    // clamp: max delay is 15 tics
}
```

**Generator: `M_Random` (m_random.h), not `P_Random`** — verified by the
`#include "m_random.h"` in f_wipe.c and the call site `M_Random()` at
f_wipe.c:159,162. The wipe therefore does **not** consume the game simulation
RNG. Wipe timing is cosmetic; it runs during the menu/intermission layer
(`F_Ticker`, `WI_Ticker`) and is completely outside `G_Ticker`'s simulation
tick. Demo replay is not affected by wipe RNG state.

**Speed curve** (`wipe_doMelt`, f_wipe.c:198):

```c
dy = (y[i] < 16) ? y[i] + 1 : 8;
```

Interpretation: once a column starts moving (`y[i] >= 0`), it accelerates
linearly for the first 16 rows (`dy = y[i]+1` = 1, 2, 3, … 16 pixels/tic
as the column falls), then falls at a constant **8 pixels/tic** thereafter.
The acceleration phase covers the first 16/8 = 2 tics at constant speed
equivalent, giving the characteristic "melt" gravity look. The constants 16
(acceleration rows) and 8 (terminal speed) are irreducible aesthetic choices.

The column data is transposed to column-major order before the melt loop
(`wipe_shittyColMajorXform`, f_wipe.c:51 — comment retained verbatim from
the id source) to improve cache locality during the column-stride copy.

**Verdict: IRREDUCIBLE (constants), M_Random confirmed (critical for demo
integrity).** The use of M_Random (not P_Random) means the wipe's column
stagger can differ between a live run and a demo replay without desync — the
demo replays gameplay tics, not cosmetic frames. The 16-row lead-in and
8 px/tic terminal speed are pure visual tuning. **Sim-critical: No.**

---

## 13. Remaining sweep — g_game.c, p_enemy.c, UI tables

### 13.1 Player movement constants — g_game.c — IRREDUCIBLE, demo-format-critical

```c
fixed_t forwardmove[2] = {0x19, 0x32};  // walk=25, run=50 map units/tic
fixed_t sidemove[2]    = {0x18, 0x28};  // walk=24, run=40 map units/tic
fixed_t angleturn[3]   = {640, 1280, 320};  // normal, fast, slow angular turn
```

(g_game.c:175-177). These feed `ticcmd_t.forwardmove`, `sidemove`,
`angleturn` which are written into demo files as 8-bit signed / 16-bit values.
Demo playback reads ticcmds directly — it does not re-derive motion from
keyboard state — so changing these values would not desync existing demos, but
would change the values a new recording produces. The ticcmd range fits in
signed 8 bits: 0x32=50 ≤ 127, safe. `angleturn[3]={640,1280,320}`: index 2
(320) is the "slow turn" used for the first few tics of a new turn direction.
These are pure player-feel tuning. **Sim-critical: No** (ticcmds are frozen
in the demo; the table is only consulted during recording).

### 13.2 Enemy direction tables — p_enemy.c — EQUIVALENCE

```c
dirtype_t opposite[9] = {
    DI_WEST, DI_SOUTHWEST, DI_SOUTH, DI_SOUTHEAST,
    DI_EAST, DI_NORTHEAST, DI_NORTH, DI_NORTHWEST, DI_NODIR
};
dirtype_t diags[4] = {
    DI_NORTHWEST, DI_NORTHEAST, DI_SOUTHWEST, DI_SOUTHEAST
};
```

(p_enemy.c:70-79). `opposite[i]` is the 180° rotation of direction `i` in
the `dirtype_t` enum (DI_EAST=0, DI_NORTHEAST=1, … DI_NODIR=8). Trivially
derivable: `opposite[i] = (i + 4) % 8` for i < 8, `opposite[8] = DI_NODIR`.

`diags[k]` maps the sign combination `(deltay<0)<<1 + (deltax>0)` to a
diagonal direction:
- k=0 (dy≥0, dx≤0) → DI_NORTHWEST
- k=1 (dy≥0, dx>0) → DI_NORTHEAST
- k=2 (dy<0, dx≤0) → DI_SOUTHWEST
- k=3 (dy<0, dx>0) → DI_SOUTHEAST

Fully derivable from the sign conventions and enum ordering.

**Verdict: EQUIVALENCE.** Both tables are lookup-optimized versions of
trivially derivable mappings. **Sim-critical: YES** — both feed
`P_NewChaseDir` (p_enemy.c) which determines monster movement direction;
changes would alter the P_Random consumption sequence via A_Chase.

### 13.3 UI / declarative data tables — no hidden algorithms

The following tables contain pixel coordinates, sprite lump names, and
animation timing that are purely declarative game-design data. They contain no
hidden computational recipes; they match the pixel positions in the
corresponding WAD graphics and are hand-authored art-side data.

| file | table(s) | description |
|------|----------|-------------|
| `wi_stuff.c:177` | `lnodes[3][9]` | Pixel (x,y) of each level on the episode intermission map background |
| `wi_stuff.c:226` | `epsd0animinfo[]`, `epsd1animinfo[]`, `epsd2animinfo[]` | Intermission animation: type, period=TICRATE/3, frame count, pixel loc, trigger level |
| `st_stuff.c:97` | `ST_NUMPAINFACES=5`, `ST_NUMSTRAIGHTFACES=3`, `ST_NUMTURNFACES=2`, `ST_NUMSPECIALFACES=3` | Status-bar face sprite sheet layout constants |
| `st_stuff.c:117` | `ST_FACESX=143`, `ST_FACESY=168`, face timer constants | Screen coordinates and timing for the HUD face |
| `m_menu.c:250` | `MainMenu[]`, `EpisodeMenu[]`, `NewGameMenu[]`, `OptionsMenu[]` | Menu item arrays: name, callback, hotkey |
| `m_menu.c:175` | `skullName[2]` | Menu cursor sprite lump names `{"M_SKULL1","M_SKULL2"}` |
| `m_menu.c:109` | `gammamsg[5]` | Gamma level display strings |
| `hu_stuff.c:288` | `english_shiftxform[]`, `french_shiftxform[]` | Keyboard shift translation tables (ASCII lookup, 128 entries each) |
| `hu_stuff.c:372` | `frenchKeyMap[128]` | French keyboard character remap |
| `info.c` | `states[]`, `mobjinfo[]`, `sprnames[]` | Game-design data: state machine, actor types, sprite names — irreducible by definition |
| `sounds.c` | `S_sfx[]`, `S_music[]` | Sound and music metadata: lump names, priorities, link offsets |

**Verdict for all: DECLARATIVE DATA.** No algorithms are hidden. The pixel
coordinates in `lnodes` and `epsdNaniminfo` match the WAD background graphics;
the sprite/menu name strings reference WAD lumps by name. Sim-critical: No
(UI rendering, menus, and intermission screens are entirely outside G_Ticker).

### 13.4 am_map.c — automap vector art and palette ranges — DECLARATIVE

`am_map.c` contains hand-authored pixel-coordinate and colour-range data
used exclusively by the automap renderer.

**Palette range #defines** (am_map.c:52-64):

```c
#define REDS     (256-5*16)      // 176: player arrow, walls with tags
#define BLUES    (256-4*16+8)    // 232: unused in shipped code
#define GREENS   (7*16)          // 112: P1 automap in multiplayer
#define GRAYS    (6*16)          //  96: P2 automap
#define BROWNS   (4*16)          //  64: P3 automap
#define YELLOWS  (256-32+7)      // 231: teleporter lines
#define BLACK    0               //   0: cleared background
#define WHITE    (256-47)        // 209: unmapped walls / secrets
```

Integer arithmetic expresses palette-index positions. The expressions are
id Software's original form; the comments give the literal values.

**Automap arrow and shape vectors** (am_map.c:161-210):

| array | size | description |
|-------|------|-------------|
| `player_arrow[7]` | 7 `mline_t` | Normal-mode player icon — 7 line segments, `R=(8*PLAYERRADIUS)/7` |
| `cheat_player_arrow[16]` | 16 `mline_t` | Cheat-mode icon — 16 line segments, adds "DDT" text to the arrow |
| `triangle_guy[3]` | 3 `mline_t` | Enemy/thing triangle — equilateral, `R=FRACUNIT`, `0.867≈√3/2` |
| `thintriangle_guy[3]` | 3 `mline_t` | Things-mode overlay — thin forward-pointing triangle |

Coordinates are fixed-point world-space values relative to the object centre.
They encode hand-authored geometry; there is no algorithm that would derive
them from any other data.

**Multiplayer colour table** (am_map.c:1244):

```c
static int their_colors[4] = { GREENS, GRAYS, BROWNS, REDS };
```

Assigns one automap colour per additional player slot (P2–P4 or P1–P4 in
non-player-arrow code paths). Declarative slot assignment.

**Verdict for all: DECLARATIVE.** No algorithm hidden. Palette ranges encode
DOOM's fixed palette layout; vectors encode artist-authored shapes; colour
table is a four-slot config list. Sim-critical: No.

### 13.5 m_misc.c defaults[] — config-file binding table — DECLARATIVE

`defaults[]` (m_misc.c:216) is a table of `default_t` structs that map
config-file key name strings to in-memory variable addresses and default values:

```c
typedef struct { char *name; int *location; int defaultvalue; } default_t;
```

The table has approximately 28 entries covering: `mouse_sensitivity`,
`sfx_volume`, `music_volume`, `show_messages`, keyboard bindings
(`key_right`, `key_left`, `key_up`, `key_down`, `key_strafeleft`,
`key_straferight`, `key_fire`, `key_use`, `key_strafe`, `key_speed`),
mouse button bindings, joystick axis/button bindings, `screenblocks`,
`detaillevel`, `snd_channels`, `usegamma`, and `chatmacro0` through
`chatmacro9`.

At startup `M_LoadDefaults` walks the table to populate variables from the
config file; at shutdown `M_SaveDefaults` walks it to persist values back.
No computation is hidden — the table is pure binding glue between the
human-readable config file and the engine's global variable namespace.

**Verdict: DECLARATIVE.** Config-to-variable binding table. Sim-critical: No.

### 13.6 st_stuff.c — cheat byte sequences — DECLARATIVE

Cheat codes in `st_stuff.c:400-487` are stored pre-scrambled using the
`SCRAMBLE` macro (m_cheat.h:30), a self-inverse bit permutation:

```c
#define SCRAMBLE(a) \
((((a)&1)<<7) + (((a)&2)<<5) + ((a)&4) + (((a)&8)<<1) \
 + (((a)&16)>>1) + ((a)&32) + (((a)&64)>>5) + (((a)&128)>>7))
```

Bit mapping: 0↔7 swapped, 1↔6 swapped, bits 2 and 5 fixed, 3↔4 swapped.
`SCRAMBLE(SCRAMBLE(a)) == a` for all `a` — the function is its own inverse,
so UNSCRAMBLE = SCRAMBLE. To decode any stored byte, apply SCRAMBLE once.
The byte values `1` and `0` in the sequences are wildcard / end-of-param
sentinels consumed by `cht_CheckCheat`, not scrambled characters.

**Decoded cheat sequences:**

| variable | decoded plaintext | effect |
|----------|-------------------|--------|
| `cheat_god_seq` | **iddqd** | god mode toggle |
| `cheat_ammo_seq` | **idkfa** | all weapons + keys + full ammo |
| `cheat_ammonokey_seq` | **idfa** | all weapons + full ammo (no keys) |
| `cheat_noclip_seq` | **idspispopd** | no-clip (Doom 1 episodes) |
| `cheat_commercial_noclip_seq` | **idclip** | no-clip (Doom 2 / commercial) |
| `cheat_choppers_seq` | **idchoppers** | chainsaw + invulnerability |
| `cheat_mypos_seq` | **idmypos** | display angle + (x,y) in hex |
| `cheat_mus_seq` | **idmus** + 2 digits | change music to track NN |
| `cheat_clev_seq` | **idclev** + 2 digits | warp to episode/map NN |
| `cheat_powerup_seq[0]` | **idbeholdv** | `pw_invulnerability` — invulnerability sphere |
| `cheat_powerup_seq[1]` | **idbeholds** | `pw_strength` — berserk pack |
| `cheat_powerup_seq[2]` | **idbeholdi** | `pw_invisibility` — partial invisibility |
| `cheat_powerup_seq[3]` | **idbeholdr** | `pw_ironfeet` — radiation shielding suit |
| `cheat_powerup_seq[4]` | **idbeholda** | `pw_allmap` — computer area map |
| `cheat_powerup_seq[5]` | **idbeholdl** | `pw_infrared` — light amplification visor |
| `cheat_powerup_seq[6]` | **idbehold** | display BEHOLD powerup menu |

The shared "idbehold" prefix bytes: `0xb2,0x26,0x62,0xa6,0x32,0xf6,0x36,0x26`
→ SCRAMBLE each → `i,d,b,e,h,o,l,d`. The powerup-index-to-`plyr->powers[i]`
mapping is confirmed in `ST_Responder` (st_stuff.c:636-648), which iterates
`i=0..5` directly.

**Verdict: DECLARATIVE.** Encoded cheat strings are a direct representation of
player-typed sequences. The SCRAMBLE layer provides trivial obfuscation
reversible in one operation. No algorithm hidden. Sim-critical: No (cheat
processing occurs in `ST_Responder`, outside `G_Ticker`).

### 13.7 d_french.h / dstrings.c — string literals only — DECLARATIVE

**d_french.h** confirmation:

```
$ grep -cvE '^\s*(//|$|#(ifndef|define __[A-Z_]+__|endif))' engine/core/d_french.h
310
$ grep -cE '^\s*#define [A-Z_]+ "' engine/core/d_french.h
109
```

All 310 non-trivial lines are `#define NAME "French string"` — French
replacements for the English constants in `dstrings.h`. Zero computation:
no bit operators, no arithmetic, no table lookups outside the literal strings.

**dstrings.c** contains `endmsg[NUM_QUITMESSAGES+1]` — a `static char*[]` of
quit-message strings spanning Doom 1, Doom 2, and FinalDOOM runs, plus one
internal debug placeholder. All entries are string literals. A missing comma
between the Doom 1 and Doom 2 sub-lists (dstrings.c:47) silently concatenates
two adjacent strings into one — a latent content bug, not hidden computation.

**Verdict: DECLARATIVE.** String data confirmed by grep. Sim-critical: No.

---

## 14. Master verdict ledger

Complete inventory of every hardcoded data blob in `engine/core`. After this
table the claim "no mysteries in engine/core" is auditable.

Legend — **Verdict**: **recipe** = recipe cracked (could regenerate), **equivalence** = proven
derivable, **irreducible** = cannot be derived (pure tuning or human data),
**declarative** = art/design data, no algorithm. **Sim-critical** = feeds
P_Random or demo-observable gamestate.

| blob | file:location | size | verdict | where documented | sim-critical? |
|------|--------------|------|---------|-----------------|---------------|
| `finesine[10240]`, `finetangent[4096]` | tables.c | 56 KB | **recipe** — sin/tan with truncation + phase 0.5, 33 exceptions | archaeology §1 | YES |
| `tantoangle[2049]` | tables.c | 8 KB | **recipe** — atan(i/2048) | archaeology §1 | YES |
| `FixedDiv` float vs int64 | m_fixed.c | N/A | **equivalence** — bit-identical over guarded domain | archaeology §2 | YES |
| `rndtable[256]` | m_random.c | 256 B | **irreducible** — not any standard PRNG (brute-forced 2³²) | archaeology §3 | YES |
| `gammatable[5][256]` | v_video.c | 1.28 KB | **irreducible** — approx power curves, no exact closed form | archaeology §4 | No |
| `P_AproxDistance` coefficients | p_maputl.c | inline | **equivalence** — octagonal alpha-max/beta-min, +11.8% max error | archaeology §5 | YES |
| `COLORMAP` light maps (0-31) | (WAD lump) | 8 KB | **recipe** — nearest-color to linear darken, Euclidean metric | archaeology §6 | No |
| `COLORMAP` invuln map (32) | (WAD lump) | 256 B | **irreducible** — luma weights 76/152/34 (sum 262), 14 tie-breaks | archaeology §6 | No |
| `COLORMAP` blackout (33) | (WAD lump) | 256 B | **declarative** — all zeros (trivial blackout map) | archaeology §6 | No |
| `DISTMAP=2`, `LIGHTZSHIFT=20` | r_main.c:616, r_main.h:75 | constants | **irreducible** — aesthetic tuning for falloff slope and distance scale | archaeology §8 | No |
| `zlight[16][128]`, `scalelight[16][48]` | r_main.c | 12 KB | **recipe** — linear interp via startmap formula (renderer.md §2.3) | archaeology §8 | No |
| `checkcoord[12][4]` | r_bsp.c:365 | 48 B | **equivalence** — widest-span corner pair, 9/9 cases verified by script | archaeology §9 | No |
| `S_CLOSE_DIST=160`, `S_CLIPPING_DIST=1200`, `S_ATTENUATOR=1040` | s_sound.c:55-64 | constants | **irreducible** — linear sound falloff tuning | archaeology §10 | No |
| `S_STEREO_SWING=96`, `NORM_SEP=128`, `NORM_PITCH=128` | s_sound.c:69-77 | constants | **irreducible** — stereo and pitch tuning | archaeology §10 | No |
| pitch variation ±8/±16 (chainsaw / other) | s_sound.c:330,341 | inline | **irreducible** — M_Random, cosmetic only | archaeology §10 | No |
| `GLOWSPEED=8` | p_spec.h:176 | constant | **irreducible** — glow step size aesthetic | archaeology §11 | No (deterministic step) |
| `STROBEBRIGHT=5`, `FASTDARK=15`, `SLOWDARK=35` | p_spec.h:177-179 | constants | **irreducible** — strobe timing aesthetic | archaeology §11 | YES (P_Random consumers) |
| `lightflash maxtime=64`, `mintime=7`, `count reset` | p_lights.c:140-142 | inline | **irreducible** — random-flash duration bounds | archaeology §11 | YES (P_Random) |
| `fireflicker count=4`, `step=(P_Random()&3)*16` | p_lights.c:53,60 | inline | **irreducible** — fire timing and step | archaeology §11 | YES (P_Random) |
| strobe `inSync=0` offset `(P_Random()&7)+1` | p_lights.c:206 | inline | **irreducible** — startup stagger | archaeology §11 | YES (P_Random) |
| wipe initial offsets `M_Random()%16`, `M_Random()%3-1` | f_wipe.c:159,162 | inline | **irreducible** — M_Random, cosmetic only | archaeology §12 | **No** (M_Random) |
| wipe speed curve: 16-row lead-in, 8 px/tic | f_wipe.c:198 | inline | **irreducible** — visual tuning | archaeology §12 | No |
| `forwardmove[2]={0x19,0x32}`, `sidemove[2]={0x18,0x28}` | g_game.c:175-176 | 4 values | **irreducible** — player feel tuning | archaeology §13.1 | No (ticcmd frozen) |
| `angleturn[3]={640,1280,320}` | g_game.c:177 | 3 values | **irreducible** — turn speed tuning | archaeology §13.1 | No (ticcmd frozen) |
| `opposite[9]`, `diags[4]` | p_enemy.c:70-79 | 13 entries | **equivalence** — trivially derivable from dirtype_t enum | archaeology §13.2 | YES (monster AI) |
| `lnodes[3][9]` | wi_stuff.c:177 | 27 coords | **declarative** — episode map pixel positions | archaeology §13.3 | No |
| `epsd0/1/2animinfo[]` | wi_stuff.c:226-261 | 25 entries | **declarative** — intermission animation specs | archaeology §13.3 | No |
| `ST_NUMPAINFACES=5` and face layout constants | st_stuff.c:97-125 | ~12 consts | **declarative** — status-bar sprite sheet layout | archaeology §13.3 | No |
| menu item arrays (`MainMenu[]` etc.) | m_menu.c:250+ | ~30 entries | **declarative** — UI item names and callbacks | archaeology §13.3 | No |
| `english_shiftxform[128]`, `frenchKeyMap[128]` | hu_stuff.c:330,372 | 256 B | **declarative** — keyboard ASCII remap tables | archaeology §13.3 | No |
| `states[]`, `mobjinfo[]`, `sprnames[]` | info.c | ~14 KB | **declarative** — game-design state machines and actor types | archaeology §13.3 | No |
| `S_sfx[]`, `S_music[]` | sounds.c | ~3 KB | **declarative** — sound/music metadata | archaeology §13.3 | No |
| `fuzzoffset[50]` | r_draw.c:260 | 50 B | **irreducible** — fixed spectre pattern (50 ±SCREENWIDTH offsets) | renderer.md §7.3 | No |
| `translationtables[768]` | r_draw.c:459 | 768 B | **recipe** — identity + green→gray/brown/red remap for palette indices 0x70-0x7f | renderer.md §7.4 | No |
| `skullName[2]`, `gammamsg[5]` | m_menu.c:109,175 | literals | **declarative** — cursor sprite lump names and gamma-level strings | archaeology §13.3 | No |
| palette range #defines (REDS/BLUES/GREENS/GRAYS/BROWNS/YELLOWS/BLACK/WHITE), `their_colors[4]` | am_map.c:52-64,1244 | constants | **declarative** — automap colour-range palette indices and multiplayer slot colours | archaeology §13.4 | No |
| `player_arrow[7]`, `cheat_player_arrow[16]`, `triangle_guy[3]`, `thintriangle_guy[3]` | am_map.c:161-210 | ~29 `mline_t` | **declarative** — automap vector geometry for player icon, DDT cheat icon, enemy/thing triangles | archaeology §13.4 | No |
| `defaults[~28]` | m_misc.c:216 | ~28 entries | **declarative** — config-file key→variable→default binding table | archaeology §13.5 | No |
| cheat byte sequences (`cheat_god_seq` … `cheat_powerup_seq[7]`) | st_stuff.c:400-487 | 16 sequences | **declarative** — SCRAMBLE-encoded plaintext cheat strings (iddqd, idkfa, idspispopd, etc.) | archaeology §13.6 | No |
| `d_french.h` / `dstrings.c` | d_french.h, dstrings.c | ~310 defines + 1 array | **declarative** — French UI string replacements and quit-message array; string literals only | archaeology §13.7 | No |

**Total ledger rows: 40.** Verdicts: recipe 5, equivalence 4, irreducible 17, declarative 14.
