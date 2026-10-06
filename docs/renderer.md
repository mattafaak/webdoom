# webdoom renderer internals

The software renderer is the 1993 design: a front-to-back BSP walk that builds
a horizontal clip list, vertical column draws for walls, horizontal span fills
for floors and ceilings, and a back-to-front sprite sort. This document
describes it from the source in `engine/core/r_*.c`. Code is cited by file and
function; a line number appears only where it pins a `#define`.

Every renderer limit and constant quoted here that a demo golden would not
notice changing is re-read from the source by
`node tools/archaeology/source-constant-verify.mjs` (part of the
`archaeology` leg). Where a table's origin is derived rather than read, the
derivation lives in [engine-archaeology.md](engine-archaeology.md).

---

## Contents

1. [Frame pipeline overview](#1-frame-pipeline-overview)
2. [Frame setup — r_main.c](#2-frame-setup--r_mainc)
3. [BSP traversal — r_bsp.c](#3-bsp-traversal--r_bspc)
4. [Wall pipeline — r_segs.c](#4-wall-pipeline--r_segsc)
5. [Visplanes — r_plane.c](#5-visplanes--r_planec)
6. [Sprites and things — r_things.c](#6-sprites-and-things--r_thingsc)
7. [Column and span draw — r_draw.c](#7-column-and-span-draw--r_drawc)
8. [Texture and data — r_data.c](#8-texture-and-data--r_datac)
9. [Sky — r_sky.c](#9-sky--r_skyc)
10. [Raised limits table](#10-raised-limits-table)
11. [Per-stage performance mapping](#11-per-stage-performance-mapping)
12. [Cross-cutting invariants](#12-cross-cutting-invariants)
12b. [Render variants](#12b-render-variants)

---

## 1. Frame pipeline overview

`R_RenderPlayerView` (r_main.c) drives one frame in four timed stages:

```
frame-setup+clears   → web_perf_frame_us
  R_SetupFrame        (viewpoint, interpolation, colormap state)
  R_ShearView         (freelook y-shear; skips if lookdir is unchanged)
  R_InterpolateSectors(false)  (lerp sector heights for the render)
  R_ClearClipSegs / R_ClearDrawSegs / R_ClearPlanes / R_ClearSprites

BSP+segs             → web_perf_bsp_us
  R_RenderBSPNode     (recursive; draws wall columns, records drawsegs
                       and visplane extents)

planes               → web_perf_planes_us
  R_DrawPlanes        (span-fill every floor/ceiling visplane, draw sky)

masked               → web_perf_masked_us
  R_DrawMasked        (sort sprites, draw back to front, then psprites)

R_InterpolateSectors(true)     (restore the true sector heights)
```

`NetUpdate()` runs after each stage, so the network pump keeps turning inside
a long frame.

The stage accumulators and `web_perf_sim_us` (the ticker) live in
`engine/web/perf.c`. `tools/bench.mjs` reads them per rendered frame, and the
per-host results are kept in `tools/golden/bench-baseline.json` (§11).

**webdoom additions not in vanilla**: render interpolation (`smoothrender`,
`fractic`, `R_LerpFixed`, `R_LerpAngle`), freelook y-shear (`lookdir`,
`R_ShearView`), and sector height interpolation (`R_InterpolateSectors`). All
three are render-local. `R_InterpolateSectors` swaps lerped floor and ceiling
heights in for the frame and restores the true values before returning, so
game code between frames always sees unlerped state.

---

## 2. Frame setup — r_main.c

### 2.1 View basis

`R_SetupFrame` establishes the view every frame:

| variable | type | value |
|----------|------|-------|
| `viewx`, `viewy`, `viewz` | `fixed_t` | lerped between the previous and current tic by `fractic` |
| `viewangle` | `angle_t` (uint32) | lerped (short way round) + `viewangleoffset` |
| `viewsin`, `viewcos` | `fixed_t` | `finesine[viewangle>>19]`, `finecosine[…]` |
| `projection` | `fixed_t` | `centerxfrac` = `(viewwidth/2)<<16` |
| `extralight` | `int` | gun-flash brightness bump |

`fractic` comes from `I_GetTimeFrac()` (0…`FRACUNIT`). With `smoothrender`
off it is pinned at `FRACUNIT`, which reproduces vanilla exactly. In
`WEBDOOM_INVARIANTS` builds `doom_fractic_override` pins it to a fixed
intermediate value, because `-timedemo` never advances the frame clock and
would otherwise leave the lerp saturated and untested.

If the player has a `fixedcolormap` (invulnerability, light amplification),
`R_SetupFrame` points `walllights` at `scalelightfixed`, whose every entry is
that one colormap. `R_SetupFrame` also increments `validcount` (§12).

`projection` is the focal length in fixed-point pixels. DOOM uses a flat
projection plane, not a fisheye. With `FIELDOFVIEW = 2048` fine angles out of
8192, the horizontal field of view is exactly 90°, and the focal length equals
half the view width.

View size comes from `R_ExecuteSetViewSize`: at `setblocks == 11` the view is
the full 320×200; otherwise `scaledviewwidth = setblocks*32` and
`viewheight = (setblocks*168/10) & ~7`. `viewwidth = scaledviewwidth >>
detailshift`.

### 2.2 Angle→column mapping: `viewangletox` and `xtoviewangle`

Built in `R_InitTextureMapping`, called from `R_ExecuteSetViewSize` whenever
the view size or detail changes.

**`viewangletox[i]`** maps a fine-angle index `i` (0…FINEANGLES/2−1) to the
screen column where that ray hits the projection plane:

```
focallength = FixedDiv(centerxfrac, finetangent[FINEANGLES/4 + FIELDOFVIEW/2])
for i in 0..FINEANGLES/2:
    if finetangent[i] >  2*FRACUNIT: t = -1             (far left)
    elif finetangent[i] < -2*FRACUNIT: t = viewwidth+1  (far right)
    else:
        t = FixedMul(finetangent[i], focallength)
        t = (centerxfrac - t + FRACUNIT - 1) >> FRACBITS
        clamped to [-1, viewwidth+1]
    viewangletox[i] = t
```

`FINEANGLES = 8192` and `ANGLETOFINESHIFT = 19` (tables.h), so `angle_t >> 19`
gives a fine-angle index in 0…8191. The table covers the visible half-circle
(4096 entries).

**`xtoviewangle[x]`** is the inverse: the smallest view angle that maps to
column `x`, found by scanning `viewangletox[]`:

```
for x in 0..viewwidth:
    i = 0
    while viewangletox[i] > x: i++
    xtoviewangle[x] = (i << ANGLETOFINESHIFT) - ANG90
```

After that scan the fencepost values are folded in: `-1` becomes `0` and
`viewwidth+1` becomes `viewwidth`. `clipangle = xtoviewangle[0]` is the
half-FOV angle used by both the BSP frustum test and the seg clipper.

Every column draw and every texture-offset calculation goes through one of
these two tables.

### 2.3 `scalelight` and `zlight` — lighting tables

Two 2D pointer arrays into `colormaps`. Both map a light level and a distance
to a COLORMAP entry. The light-level index is always
`(sector->lightlevel >> LIGHTSEGSHIFT) + extralight`, clamped to
[0, LIGHTLEVELS−1]. Constants (r_main.h): `LIGHTLEVELS = 16`,
`LIGHTSEGSHIFT = 4`, `NUMCOLORMAPS = 32`, `MAXLIGHTZ = 128`,
`LIGHTZSHIFT = 20`, `MAXLIGHTSCALE = 48`, `LIGHTSCALESHIFT = 12`; and
`DISTMAP = 2` (r_main.c).

**`zlight[LIGHTLEVELS][MAXLIGHTZ]`**: distance-based, for floor and ceiling
spans. Built once in `R_InitLightTables`:

```
startmap = ((LIGHTLEVELS-1-i)*2) * NUMCOLORMAPS / LIGHTLEVELS
scale = FixedDiv((SCREENWIDTH/2 * FRACUNIT), (j+1) << LIGHTZSHIFT)
scale >>= LIGHTSCALESHIFT
level = startmap - scale/DISTMAP, clamped to [0, NUMCOLORMAPS-1]
zlight[i][j] = colormaps + level*256
```

`R_MapPlane` indexes it with `distance >> LIGHTZSHIFT`, clamped to
`MAXLIGHTZ−1`. Because `distance` is 16.16 fixed point, one `j` step is
2^20 / 2^16 = 16 map units, and the table covers distances 16 to 2048 map
units; everything farther uses the last column (reproduced by
`tools/archaeology/zlight-distmap.mjs`).

**`scalelight[LIGHTLEVELS][MAXLIGHTSCALE]`**: scale-based, for walls and
sprites. Rebuilt in `R_ExecuteSetViewSize`, because it depends on
`viewwidth`:

```
startmap = ((LIGHTLEVELS-1-i)*2) * NUMCOLORMAPS / LIGHTLEVELS
level = startmap - j * SCREENWIDTH / (viewwidth << detailshift) / DISTMAP
level clamped to [0, NUMCOLORMAPS-1]
scalelight[i][j] = colormaps + level*256
```

Walls index it with `rw_scale >> LIGHTSCALESHIFT`, sprites with
`xscale >> (LIGHTSCALESHIFT - detailshift)`, both clamped to
`MAXLIGHTSCALE−1`. A larger scale (closer surface) gives a higher `j` and a
brighter map. The `SCREENWIDTH / viewwidth` factor keeps reduced-size views
lit the same as full-size ones.

These tables are mechanical linear ramps between the brightest and darkest
COLORMAP at each light level; the recipe is readable straight from the code.
Why `DISTMAP = 2` and `LIGHTZSHIFT = 20` specifically is settled in
[engine-archaeology.md](engine-archaeology.md) §8.

### 2.4 `yslope` and `distscale`

**`yslope[y]`** (declared in r_plane.c) is the flat-to-eye distance
multiplier for each screen row:

```
dy = |((y - centery) << FRACBITS) + FRACUNIT/2|
yslope[y] = FixedDiv((viewwidth << detailshift) / 2 * FRACUNIT, dy)
```

The half-pixel offset keeps `dy ≥ FRACUNIT/2`, so the division never sees
zero, even at the horizon row.

`R_ExecuteSetViewSize` builds `yslope` for a centred view and calls
`R_ForceReshear`. `R_ShearView` rebuilds it around the sheared `centery`
whenever `lookdir` differs from the last value it rendered. `lookdir` (set
from JS by `web_set_pitch`) is clamped to ±(`viewheight/2 − 8`).

**`distscale[x]`** (declared in r_plane.c, built in `R_ExecuteSetViewSize`)
corrects flat distances for oblique viewing at each screen column:

```
cosadj = |finecosine[xtoviewangle[x] >> ANGLETOFINESHIFT]|
distscale[x] = FixedDiv(FRACUNIT, cosadj)
```

`distscale` depends only on the horizontal geometry, so freelook does not
touch it.

---

## 3. BSP traversal — r_bsp.c

### 3.1 `R_RenderBSPNode` — the recursion

```c
void R_RenderBSPNode(int bspnum) {
    if (bspnum & NF_SUBSECTOR) {
        if (bspnum == -1)                         // degenerate: single-subsector map
            R_Subsector(0);
        else
            R_Subsector(bspnum & ~NF_SUBSECTOR);
        return;
    }
    bsp = &nodes[bspnum];
    side = R_PointOnSide(viewx, viewy, bsp);     // which side is the camera?
    R_RenderBSPNode(bsp->children[side]);         // front subtree first
    if (R_CheckBBox(bsp->bbox[side^1]))           // back subtree maybe
        R_RenderBSPNode(bsp->children[side^1]);
}
```

The root call is `R_RenderBSPNode(numnodes-1)` from `R_RenderPlayerView`.

**Traversal order** is front to back relative to the viewpoint. The recursion
visits the front child before the back child at every node, so subsectors
arrive at `R_Subsector` nearest first. The `solidsegs` clipper depends on
this: once a screen column is covered by solid walls, every later seg that
projects onto it can be skipped.

**`NF_SUBSECTOR = 0x8000`** (doomdata.h). A node's `children[]` holds either
a node index or a subsector index with the high bit set.

**`R_PointOnSide`** (r_main.c) classifies a point against a node's partition
line. Axis-aligned partitions (`dx == 0` or `dy == 0`) are decided by a
single comparison. Otherwise a sign-bit test on
`node->dy ^ node->dx ^ dx ^ dy` settles most cases without a multiply, and
only the rest fall through to the fixed-point cross product.

### 3.2 `R_Subsector` — leaf processing

For each BSP leaf (subsector):

1. Find or allocate a floor visplane if the floor is below `viewz`.
2. Find or allocate a ceiling visplane if the ceiling is above `viewz` or is
   sky.
3. Call `R_AddSprites(frontsector)`, which projects the sector's things into
   `vissprites[]` once per sector per frame (guarded by `validcount`).
4. Call `R_AddLine` for each seg in the subsector.

### 3.3 `R_AddLine` — seg clipping

For a single seg:

1. **Backface cull**: if `angle1 - angle2 >= ANG180` the seg faces away;
   skip it.
2. **Frustum clip**: both endpoint angles are tested against `±clipangle`.
   Fully outside, skip; partly outside, clamp the endpoint to the edge.
3. Map the clipped angles to screen columns through `viewangletox[]`.
4. **Zero width**: if `x1 == x2` the seg covers no pixel; skip it.
5. **Route**: single-sided lines and closed doors (back ceiling ≤ front floor
   or back floor ≥ front ceiling) go to `R_ClipSolidWallSegment`. Two-sided
   lines with a height change go to `R_ClipPassWallSegment`.
6. **Trigger lines**: a two-sided line with identical floor and ceiling
   heights, flats and light on both sides and no middle texture is invisible
   and is skipped. Such lines exist only to carry specials.

Both clip routines call `R_StoreWallRange` for each visible fragment.

### 3.4 `solidsegs` — the horizontal clip list

```c
#define MAXSEGS  64    // webdoom: was 32
cliprange_t* newend;   // one past the last valid entry
cliprange_t solidsegs[MAXSEGS];
```

`cliprange_t` is `{int first; int last}`, a closed range of screen columns.
The array is a sorted list of the column ranges already covered by solid
walls this frame.

**Invariants**:
- Entries are sorted by `first`, strictly increasing.
- No two entries overlap or touch (touching ranges are merged).
- `R_ClearClipSegs` installs two sentinel bookends,
  `solidsegs[0] = {-0x7fffffff, -1}` and
  `solidsegs[1] = {viewwidth, 0x7fffffff}`, so the scans need no boundary
  checks.

**`R_ClipSolidWallSegment`** takes a new solid range `[first, last]`, scans
for the entries it touches, calls `R_StoreWallRange` for each still-visible
fragment, then merges the range into the list, inserting, extending and
crunching in one linear pass.

**`R_ClipPassWallSegment`** does the same scan but never inserts: a portal
leaves the columns behind it open.

**Overflow**: vanilla writes past `solidsegs[32]` with no check. webdoom
raises the limit to 64 and guards the one insertion point in
`R_ClipSolidWallSegment`: when the list is full, the wall is still drawn but
its clip entry is dropped. The cost is overdraw from walls behind it, never a
memory write out of bounds. The 13-demo corpus peaks at 17 entries;
[optimization-ledger.md](optimization-ledger.md) NC2 records why 64 is kept
(reverting saves 256 bytes).

### 3.5 `R_CheckBBox` — node frustum culling

Before recursing into the back subtree, `R_RenderBSPNode` asks whether that
subtree's bounding box can be visible:

1. Classify the viewpoint against the box: `boxx` is 0/1/2 for left of /
   inside / right of the box's x range, `boxy` the same for y (top first).
   `boxpos = (boxy<<2) + boxx`.
2. `boxpos == 5` means the viewpoint is inside the box: return true.
3. `checkcoord[boxpos]` names the two box corners that subtend the widest
   angle from that position. Project both to angles; if the span is 180° or
   more (viewpoint on an edge), return true.
4. Clip the span to the FOV, map it to columns, and return false if it lands
   on one column or lies entirely inside one `solidsegs` entry.

`checkcoord[12][4]` has nine meaningful rows (indices 3, 7 and 11 are unused
padding of the `<<2` packing, and row 5 is never read). That it is the
correct corner choice for all nine positions is proved in
[engine-archaeology.md](engine-archaeology.md) §9 and reproduced by
`tools/archaeology/checkcoord-verify.mjs`.

---

## 4. Wall pipeline — r_segs.c

### 4.1 `R_StoreWallRange` — drawseg creation

Called for every visible column range of a seg. It fills one `drawseg_t` and
draws the wall columns immediately through `R_RenderSegLoop`, which is why
wall drawing is charged to the BSP stage.

If `drawsegs[]` is full it returns at once (§10).

**Geometry setup**:

```
rw_normalangle = curline->angle + ANG90       // perpendicular to the seg
offsetangle = |rw_normalangle - rw_angle1|    // rw_angle1 = angle to v1
offsetangle = min(offsetangle, ANG90)
distangle = ANG90 - offsetangle
hyp = R_PointToDist(v1->x, v1->y)             // distance to v1
rw_distance = FixedMul(hyp, finesine[distangle >> ANGLETOFINESHIFT])
```

That is `d_perp = d_hyp * sin(angle_between)`.

**Scale at each end**:

```
scale1 = R_ScaleFromGlobalAngle(viewangle + xtoviewangle[x1])
scale2 = R_ScaleFromGlobalAngle(viewangle + xtoviewangle[x2])
scalestep = (scale2 - scale1) / (x2 - x1)
```

`R_ScaleFromGlobalAngle` (r_main.c):

```
anglea = ANG90 + (visangle - viewangle)
angleb = ANG90 + (visangle - rw_normalangle)
num = FixedMul(projection, sin(angleb)) << detailshift
den = FixedMul(rw_distance, sin(anglea))
scale = den > num>>16 ? FixedDiv(num, den) : 64*FRACUNIT
clamped to [256, 64*FRACUNIT]
```

The lower bound 256 is 1/256 of a pixel per texel (a very distant wall); the
upper bound is 64 pixels per texel (a wall at the eye).

Vanilla's comment that "both sines are always positive" is wrong: `anglea`
and `angleb` are signed ints, and when `visangle - viewangle < -ANG90` the
signed shift gives a negative `finesine` index, an out-of-bounds read. webdoom
casts each angle to `angle_t` before the shift, which wraps the index into
[0, 8191] and is bit-identical to vanilla whenever vanilla's index was valid.
No golden demo reaches the negative case; the differential fuzzer does. The
change is render-only.

**Scale step truncation**: `scalestep` is an integer division, so the
accumulated error at `x2` can reach `x2 − x1` units. On very wide, very close
walls this shows as a slight scale drift at the right edge. It is vanilla
behaviour and render-only.

**Fake contrast**: the wall light level is the sector's, minus one for
horizontal segs (`v1->y == v2->y`) and plus one for vertical segs
(`v1->x == v2->x`). This is why axis-aligned walls in the same sector differ
in brightness.

### 4.2 `drawseg_t` — the drawseg record

(r_defs.h)

| field | type | meaning |
|-------|------|---------|
| `curline` | `seg_t*` | the source seg |
| `x1`, `x2` | `int` | screen column range |
| `scale1`, `scale2`, `scalestep` | `fixed_t` | scale at left, right, and per column |
| `silhouette` | `int` | `SIL_NONE=0 / SIL_BOTTOM=1 / SIL_TOP=2 / SIL_BOTH=3` |
| `bsilheight`, `tsilheight` | `fixed_t` | world heights of the bottom/top silhouette |
| `sprtopclip`, `sprbottomclip` | `short*` | per-column sprite clip arrays (slices of `openings[]`) |
| `maskedtexturecol` | `short*` | per-column texture column for a masked mid-texture |

**Silhouette flags** decide how this drawseg clips sprites drawn later:

- `SIL_BOTTOM`: the front floor is higher than the back floor, so sprites
  behind are clipped from below at `bsilheight`.
- `SIL_TOP`: the front ceiling is lower than the back ceiling, so sprites
  behind are clipped from above at `tsilheight`.
- Single-sided lines: `SIL_BOTH`, `sprtopclip = screenheightarray`,
  `sprbottomclip = negonearray`, `bsilheight = MAXINT`,
  `tsilheight = MININT`: everything behind is hidden.

A two-sided line with no height difference gets `silhouette = 0` and clips
nothing. A two-sided line whose back floor is above the eye (or back ceiling
below it) sets `SIL_BOTTOM` (or `SIL_TOP`) with a `MAXINT`/`MININT` height,
meaning "clip everything on that side". A closed back sector sets both with
the full-screen arrays.

If the sidedef has a middle texture, `maskedtexture` is set and
`maskedtexturecol` is carved from `openings[]`. A masked drawseg always ends
with both silhouette bits set, even with no height difference, because the
mid-texture itself can hide sprites.

### 4.3 `openings[]` — shared clip-array pool

```c
#define MAXOPENINGS  (SCREENWIDTH*64)   // r_plane.h, vanilla value
short openings[MAXOPENINGS];
short* lastopening;
```

One flat array serves as a bump allocator for per-column sprite clip data.
Each drawseg that needs `sprtopclip`, `sprbottomclip` or `maskedtexturecol`
takes a slice through `lastopening`. Nothing is freed within a frame;
`R_ClearPlanes` resets `lastopening = openings`.

`MAXOPENINGS` is vanilla's `SCREENWIDTH*64 = 20480`. The 13-demo corpus peaks
at 2527 (8.1× margin; [optimization-ledger.md](optimization-ledger.md) C6).

Vanilla writes past the end on overflow. webdoom guards each of the three
allocations in `R_StoreWallRange` and fails soft: a full pool drops the
masked mid-texture, or clears the matching silhouette bit so `r_things.c`
never sees a NULL clip pointer. Sprites may then fail to clip against that
wall; nothing is corrupted. The `RANGECHECK` check in `R_DrawPlanes` still
calls `I_Error` on overflow in debug builds.

### 4.4 `R_RenderSegLoop` — the inner wall draw

For each column `rw_x` from `x1` to `x2`:

1. Compute `yl` and `yh`, the top and bottom pixel of the wall opening,
   clamped to `ceilingclip[rw_x]` and `floorclip[rw_x]`.
2. If `markceiling`: record `ceilingplane->top/bottom[x]` for the gap between
   `ceilingclip+1` and `yl−1`.
3. If `markfloor`: record `floorplane->top/bottom[x]` for the gap between
   `yh+1` and `floorclip−1`.
4. If the seg is textured, compute the texture column and light:
   ```
   angle = (rw_centerangle + xtoviewangle[x]) >> ANGLETOFINESHIFT
   angle &= FINEANGLES/2 - 1                          // webdoom
   texturecolumn = (rw_offset - FixedMul(finetangent[angle], rw_distance)) >> FRACBITS
   dc_colormap = walllights[min(rw_scale >> LIGHTSCALESHIFT, MAXLIGHTSCALE-1)]
   dc_iscale = 0xffffffffu / (unsigned)rw_scale
   ```
5. Draw the mid tier (single-sided), or the top and bottom tiers (two-sided),
   setting `dc_texheight` to that texture's height before each draw (§7.2).
   A two-sided line with a masked mid-texture records `texturecolumn` in
   `maskedtexturecol[x]` for later.
6. Narrow `ceilingclip[x]` and `floorclip[x]` past whatever was drawn.

The mask in step 4 is a webdoom bound fix: when
`rw_centerangle + xtoviewangle` reaches exactly 90°, the raw index is
`FINEANGLES/2`, one past the end of `finetangent`. Masking keeps it in range
and changes nothing for any in-range index.

`rw_scale` advances by `rw_scalestep` per column. `topfrac` and `bottomfrac`
(tier edges) advance by `topstep` and `bottomstep`. These carry
`HEIGHTBITS = 12` fractional bits (`HEIGHTUNIT = 4096`), so the pixel row is
`frac >> 12`.

---

## 5. Visplanes — r_plane.c

### 5.1 `visplane_t` structure

(r_defs.h)

| field | meaning |
|-------|---------|
| `height` | floor or ceiling world height |
| `picnum` | flat index |
| `lightlevel` | sector light level |
| `minx`, `maxx` | leftmost and rightmost column touched |
| `top[SCREENWIDTH]` | per-column top row of the plane |
| `bottom[SCREENWIDTH]` | per-column bottom row |
| `pad1`…`pad4` | single bytes either side of `top[]` and `bottom[]` |

The pads make `top[minx−1]` and `top[maxx+1]` addressable. `R_DrawPlanes`
writes `0xff` there so the `R_MakeSpans` scan terminates at both ends without
a bounds check. `0xff` in `top[x]` means "column not in this plane".

Each `visplane_t` is 664 bytes at width 320.

### 5.2 `R_FindPlane` — linear search, no hash

```c
if (picnum == skyflatnum) { height = 0; lightlevel = 0; }   // all skies merge
for (check = visplanes; check < lastvisplane; check++)
    if (height == check->height && picnum == check->picnum
        && lightlevel == check->lightlevel)
        break;
if (check < lastvisplane) return check;
if (lastvisplane - visplanes == MAXVISPLANES)
    I_Error("R_FindPlane: no more visplanes");
lastvisplane++;    // new plane: minx = SCREENWIDTH, maxx = -1, top[] = 0xff
```

The search is O(n) over the planes allocated this frame. With a dozen or so
visible flats it is cheap. A hash was evaluated and rejected: its ceiling was
2.9% of the planes stage ([optimization-ledger.md](optimization-ledger.md)
K3).

**Sky merge**: forcing `height` and `lightlevel` to 0 for the sky flat means
every sky column shares one visplane, whatever the sector's ceiling height.

### 5.3 `R_CheckPlane` — splitting

`R_StoreWallRange` calls this when a seg is about to mark columns
`[start, stop]` of a plane. If none of those columns is already committed
(`top[x] == 0xff` across the overlap with `[minx, maxx]`), the plane's range
is extended. Otherwise a new visplane with the same height, flat and light is
allocated for `[start, stop]`.

Invariant after `R_CheckPlane`: the returned plane has `top[x] == 0xff` for
every x in `[start, stop]`, so `R_RenderSegLoop` can write `top[x]` without
overwriting a committed span.

### 5.4 `R_MakeSpans` — span emission

`R_DrawPlanes` walks each plane's columns `minx…maxx+1` and calls
`R_MakeSpans(x, t1, b1, t2, b2)` with the previous column's extent
`[t1, b1]` and the current column's `[t2, b2]`. A row present in the old
extent but not the new one ends its horizontal run, which is emitted to
`R_MapPlane`. A row present in the new extent but not the old one starts a
run (`spanstart[y] = x`).

This column-walking generator keeps every span as long as possible.

### 5.5 `R_MapPlane` — span setup and draw

For a finished span on screen row `y` from `x1` to `x2`:

```
distance = FixedMul(planeheight, yslope[y])       // world distance to this row
ds_xstep = FixedMul(distance, basexscale)         // texture step per column
ds_ystep = FixedMul(distance, baseyscale)
length = FixedMul(distance, distscale[x1])        // distance at the left edge
angle = (viewangle + xtoviewangle[x1]) >> ANGLETOFINESHIFT
ds_xfrac =  viewx + FixedMul(finecosine[angle], length)
ds_yfrac = -viewy - FixedMul(finesine[angle], length)
ds_colormap = fixedcolormap ? fixedcolormap
            : planezlight[min(distance >> LIGHTZSHIFT, MAXLIGHTZ-1)]
```

`distance`, `ds_xstep` and `ds_ystep` are cached per row (`cachedheight[]`,
cleared by `R_ClearPlanes`), so several spans at the same height on one row
cost one set of multiplies. `R_ClearPlanes` also sets the per-frame step
basis:

```
angle = (viewangle - ANG90) >> ANGLETOFINESHIFT
basexscale =  FixedDiv(finecosine[angle], centerxfrac)
baseyscale = -FixedDiv(finesine[angle], centerxfrac)
```

These rotate the span stepping with the view, so flats turn correctly with
the player.

### 5.6 Overflow: a bound in both allocators

`MAXVISPLANES` is 256, twice vanilla's 128 (r_plane.c). A plane is allocated
in two places, and both stop with an `I_Error` at the bound:
`R_FindPlane` ("no more visplanes", as in vanilla) and `R_CheckPlane`, which
splits a plane when a new wall range overlaps columns it already holds.
Vanilla's `R_CheckPlane` had no bound: it wrote past `visplanes[]` and the
overrun was noticed only afterwards, by `R_DrawPlanes`' `RANGECHECK`.

The 13-demo corpus peaks at 118 visplanes (plutonia-demo1). The library goes
higher: SIGIL E5M6's opening view needs 134, which is why the limit is 256,
and views of the busiest SIGIL and NRFTL maps reach about 156. Each visplane
costs 664 B of BSS ([optimization-ledger.md](optimization-ledger.md) C4,
C4b). `crafted-maps` (sigil-e5m6) draws E5M6 in wasm and under ASan, and a
128-plane native build stops at `R_CheckPlane`'s bound. Like every renderer
limit, it cannot affect demo compatibility (§10).

---

## 6. Sprites and things — r_things.c

### 6.1 `vissprite_t` structure

(r_defs.h)

| field | meaning |
|-------|---------|
| `prev`, `next` | doubly linked list for the sort |
| `x1`, `x2` | screen column range |
| `gx`, `gy` | lerped world position (for the line-side test) |
| `gz`, `gzt` | world bottom and top of the sprite (`gzt = gz + spritetopoffset`) |
| `startfrac` | texture column at `x1` (fixed point) |
| `scale` | screen scale (`projection / tz`) |
| `xiscale` | texture column step per screen column (negative if flipped) |
| `texturemid` | `gzt − viewz`: texture origin relative to the eye |
| `patch` | sprite lump index |
| `colormap` | pointer into `colormaps[]`; `NULL` means shadow (fuzz) draw |
| `mobjflags` | the thing's flags (for translation and shadow) |

### 6.2 `R_ProjectSprite` — visibility and projection

For each thing in a sector being processed:

1. **Interpolate**: position and facing are lerped first
   (`R_LerpFixed(thing->oldx, thing->x)` and so on; `R_LerpAngle` for the
   angle). This is a webdoom addition.
2. **Transform to view space**:
   ```
   tz = FixedMul(tr_x, viewcos) + FixedMul(tr_y, viewsin)     // depth
   tx = -(FixedMul(tr_y, viewcos) - FixedMul(tr_x, viewsin))  // sideways
   ```
3. **Cull behind the view plane**: `tz < MINZ` (`4*FRACUNIT`) → skip.
4. **Cull far off to the side**: `|tx| > tz*4` → skip.
5. **Frame check**: a frame index beyond the sprite's `numframes` drops the
   sprite for this frame. Vanilla aborts there under `RANGECHECK`; webdoom
   returns, so a WAD with missing frames still runs.
6. **Rotation**: for an 8-rotation frame,
   `rot = (R_PointToAngle(thing) - thing_angle + ANG45/2*9) >> 29`.
   `R_PointToAngle` gives the direction from the eye to the thing; adding
   180° turns it into the direction from the thing to the eye, and the extra
   22.5° centres each 45° bin, so `>> 29` picks one of eight views.
7. **Project**: `x1 = (centerxfrac + tx*xscale) >> FRACBITS`, likewise `x2`;
   fully off screen → skip.
8. **Fill** a vissprite from `R_NewVisSprite`.
9. **Light**: `NULL` (shadow) for `MF_SHADOW`; `fixedcolormap` when one is
   active; `colormaps` (map 0, full bright) for `FF_FULLBRIGHT` frames;
   otherwise `spritelights[min(xscale >> (LIGHTSCALESHIFT-detailshift),
   MAXLIGHTSCALE-1)]`.

At init, `R_InitSpriteDefs` warns instead of aborting when a sprite has no
patches for a frame or is missing rotations. Total conversions such as HACX
drop frames of monsters they never spawn; the frame check in step 5 makes
that fatal-free unless the game draws the missing frame.

### 6.3 `R_SortVisSprites` — O(n²) selection sort

After the BSP walk:

1. Link `vissprites[0..count-1]` into a doubly linked `unsorted` ring.
2. `count` times: scan the ring for the entry with the smallest `scale`
   (farthest away), unlink it and append it to `vsprsortedhead`.
3. `vsprsortedhead` is now sorted by ascending scale: back to front.

This is O(n²). A dozen sprites cost nothing. At the raised `MAXVISSPRITES` of
1024 a pathological scene could reach about 500,000 comparisons per frame; no
shipped map comes close.

### 6.4 `R_DrawSprite` — sprite occlusion by drawsegs

For each vissprite, every column of `clipbot[]` and `cliptop[]` starts at −2
("unset"). The drawsegs are scanned from the most recent back to the first:

1. Skip drawsegs that do not overlap the sprite's columns, or that have
   neither a silhouette nor a masked mid-texture.
2. If the drawseg is behind the sprite (its larger scale is below the
   sprite's, or its smaller scale is below and the sprite is in front of the
   line by `R_PointOnSegSide`), it cannot hide the sprite. If it has a masked
   mid-texture, draw that now with `R_RenderMaskedSegRange`, because it is
   behind the sprite and must go down first. Continue.
3. Otherwise the drawseg is in front. Drop `SIL_BOTTOM` if the sprite's
   bottom `gz` is at or above `bsilheight`, and `SIL_TOP` if its top `gzt` is
   at or below `tsilheight`. For each remaining bit, copy
   `ds->sprbottomclip[x]` / `ds->sprtopclip[x]` into still-unset columns.

Columns left unset default to `viewheight` (bottom) and −1 (top). The sprite
is then drawn through `R_DrawVisSprite` with `mfloorclip = clipbot` and
`mceilingclip = cliptop`.

`R_DrawMasked` draws all sprites this way, then draws any masked mid-textures
not yet drawn, then the weapon psprites.

### 6.5 Weapon psprites — `R_DrawPSprite`

`R_DrawPlayerSprites` runs at the end of `R_DrawMasked`, so the weapon always
appears in front. It is skipped when `viewangleoffset` is non-zero (side
views). Differences from world sprites:

- No rotation: always `lump[0]`.
- Horizontal placement is `lerp(oldsx, sx) − 160*FRACUNIT − spriteoffset`,
  scaled by `pspritescale`; the vertical position lerps `oldsy`/`sy` the same
  way (webdoom interpolation of the bob).
- `vis->texturemid` includes `lookdir << FRACBITS`, which keeps the weapon at
  the same screen position while the horizon shears for freelook.
- No wall clipping: `mfloorclip = screenheightarray`,
  `mceilingclip = negonearray`.
- Shadow draw when invisibility has more than `4*32` tics left or bit 3 of
  the countdown is set (the blink as it runs out). Otherwise
  `fixedcolormap`, full bright for `FF_FULLBRIGHT`, or
  `spritelights[MAXLIGHTSCALE-1]` (the sector light at its brightest scale).

### 6.6 `R_AddSprites` — dedup via validcount

A sector can be split across several subsectors. The
`sec->validcount == validcount` test ensures each sector's things are
projected at most once per frame. `R_AddSprites` also picks `spritelights`
from the sector's light level plus `extralight`.

### 6.7 `R_DrawVisSprite` and `R_DrawMaskedColumn` — the sprite column-draw bridge

**`R_DrawVisSprite`** sets up the per-sprite draw state and drives the column
loop:

```c
patch = W_CacheLumpNum(vis->patch + firstspritelump, PU_CACHE);
dc_colormap = vis->colormap;
// NULL → colfunc = fuzzcolfunc
// MF_TRANSLATION → colfunc = R_DrawTranslatedColumn, dc_translation from the flags
dc_iscale = abs(vis->xiscale) >> detailshift;
dc_texturemid = vis->texturemid;
frac = vis->startfrac;
spryscale = vis->scale;
sprtopscreen = centeryfrac - FixedMul(dc_texturemid, spryscale);

for (dc_x = vis->x1; dc_x <= vis->x2; dc_x++, frac += vis->xiscale) {
    texturecolumn = frac >> FRACBITS;
    column = (column_t*)((byte*)patch + LONG(patch->columnofs[texturecolumn]));
    R_DrawMaskedColumn(column);
}
colfunc = basecolfunc;   // undo the fuzz/translated dispatch
```

`frac` walks the patch's columns at `vis->xiscale` per screen column. For a
flipped sprite `xiscale` is negative and `startfrac` begins at the rightmost
column. `spryscale` and `sprtopscreen` are globals that `R_DrawMaskedColumn`
uses for vertical placement.

Psprites take the same path, with a stack-local `vissprite_t` instead of a
pool entry and full-screen clip arrays.

`R_RenderMaskedSegRange` (r_segs.c) also feeds `R_DrawMaskedColumn`, passing
`R_GetColumn(texnum, col) − 3` so a wall texture column reads as a post list.
For a composite column (§8.1) that memory is a flat run of pixels rather than
posts, which produces vanilla's "Medusa" artifact on multi-patch masked
mid-textures. webdoom keeps the vanilla behaviour.

**`R_DrawMaskedColumn`** iterates the posts of one `column_t`:

```c
basetexturemid = dc_texturemid;
for (; column->topdelta != 0xff; ) {
    topscreen    = sprtopscreen + spryscale * column->topdelta;
    bottomscreen = topscreen    + spryscale * column->length;
    dc_yl = (topscreen    + FRACUNIT - 1) >> FRACBITS;
    dc_yh = (bottomscreen - 1)            >> FRACBITS;
    if (dc_yh >= mfloorclip[dc_x])   dc_yh = mfloorclip[dc_x] - 1;
    if (dc_yl <= mceilingclip[dc_x]) dc_yl = mceilingclip[dc_x] + 1;
    if (dc_yl <= dc_yh) {
        dc_source     = (byte*)column + 3;              // pixels start at byte 3
        dc_texturemid = basetexturemid - (column->topdelta << FRACBITS);
        dc_texheight  = column->length;                 // webdoom
        colfunc();
    }
    column = (column_t*)((byte*)column + column->length + 4);   // next post
}
dc_texturemid = basetexturemid;
```

**Post format** (`post_t` in r_defs.h, see also [formats.md](formats.md) §3.1):
- byte 0: `topdelta`, the top row of this run; `0xff` ends the column
- byte 1: `length`, the number of opaque pixels
- byte 2: unused padding
- bytes 3…3+length−1: palette indices
- one more padding byte, hence the `+ 4` to the next post

Rebasing `dc_texturemid` per post keeps the texture coordinate continuous
across transparent gaps.

`mfloorclip[dc_x]` / `mceilingclip[dc_x]` are the clip arrays from
`R_DrawSprite` (§6.4), or `screenheightarray` / `negonearray` for unclipped
draws. Any pixel outside them is skipped.

Setting `dc_texheight` to the post length makes the column draw wrap at the
post's own height (§7.2). Sprite posts are rarely a power of two tall, so
they take the column draw's true-modulo path.

---

## 7. Column and span draw — r_draw.c

### 7.1 Framebuffer layout

The framebuffer is **column-major**: pixel (x, y) of `screens[n]` is
`screens[n][x*SCREENHEIGHT + y]` (v_video.c). All five screens share the
layout, so `V_CopyRect` and friends copy one contiguous column at a time.

```c
byte* ylookup[MAXHEIGHT];   // ylookup[y]   = screens[0] + (viewwindowy + y)
int   columnofs[MAXWIDTH];  // columnofs[x] = (viewwindowx + x) * SCREENHEIGHT
```

`R_InitBuffer` builds both tables. A pixel address is still
`ylookup[y] + columnofs[x]`, as in vanilla; only the values differ. The
render target is `screens[0]`, 320 × 200 bytes of palette indices.
`R_FillBackScreen` draws the border pattern into `screens[1]`.

Column-major storage makes every column draw (walls, sprites, fuzz) write
sequential bytes, which is the inner loop that touches the most pixels. Spans
pay instead: successive span pixels are `SCREENHEIGHT` bytes apart. The trade
is recorded in [optimization-ledger.md](optimization-ledger.md) C1.

The layout is invisible outside the engine:
- `engine/web/i_video.c` hands `screens[0]` to JS in place through
  `web_framebuffer()`. `client/js/video.js` uploads it as a 200-wide,
  320-tall R8 texture and swaps the axes in the fragment shader, so no copy
  or transpose happens per frame.
- `M_ScreenShot` (m_misc.c) untransposes before writing a PCX.
- `V_DrawBlock` takes a row-major source and transposes as it copies.

### 7.2 `R_DrawColumn` — wall/sprite column draw

The inner loop for one vertical column of a wall or sprite:

```c
dest = ylookup[dc_yl] + columnofs[dc_x];
fracstep = dc_iscale;
frac = dc_texturemid + (dc_yl - centery) * fracstep;
// power-of-two dc_texheight (walls): mask = dc_texheight - 1, 4-wide unrolled
    *dest++ = dc_colormap[dc_source[(frac >> FRACBITS) & mask]];   frac += fracstep;
// otherwise (sprite posts): true modulo, frac normalised into [0, dc_texheight<<16)
    *dest++ = dc_colormap[dc_source[frac >> FRACBITS]];
    if ((frac += fracstep) >= heightmask) frac -= heightmask;
```

**Key facts**:

- `dc_texheight` replaces vanilla's fixed `& 127`. Every caller sets it to
  the height of the column it hands over: the texture height for walls and
  masked mid-textures, the sky texture height for the sky, and the post
  length for sprites. It defaults to 128, which reproduces vanilla.
  - Why: vanilla's `& 127` reads past the end of any column shorter than 128
    texels. With the height pinned, every read stays inside the column, and
    for 128-tall textures the output is unchanged.
  - Power-of-two heights (all standard wall textures) take the fast masked
    path, unrolled four pixels per iteration. Other heights take a scalar
    true-modulo path, the same method PrBoom uses, because
    `frac & (h−1)` is not a modulo when `h` is not a power of two.
- `dc_colormap[]` is a 256-byte light table. One lookup per pixel makes it
  the hottest byte access in the renderer; it fits in L1.
- `dc_iscale` is the inverse scale: texels per screen pixel.
  `R_RenderSegLoop` computes it as `0xffffffffu / (unsigned)rw_scale`.
- Access pattern: one read from `dc_source` (near-sequential at 1:1 scale),
  one read from `dc_colormap`, one sequential write (`dest++`, from the
  column-major layout).

**`R_DrawColumnLow`**: low-detail mode, half horizontal resolution. It
doubles `dc_x` into a local and writes each pixel to two adjacent columns.
Vanilla doubled the global `dc_x` in place, which compounds across the posts
of a multi-post column; webdoom keeps the global intact, as Chocolate Doom
does. Vanilla's own comment "Hack. Does not work corretly" [sic] is still in
the source.

### 7.3 `R_DrawFuzzColumn` — spectre/shadow

Draws the spectre effect. Instead of reading `dc_source`, it reads
`dest[fuzzoffset[fuzzpos]]`, the framebuffer pixel one row above or below,
and remaps it through colormap 6 (`colormaps[6*256 + pixel]`), a slightly
darkened copy. `fuzzoffset` is a fixed 50-entry table of ±1 offsets
(`FUZZOFF = 1`, one row in the column-major layout; vanilla's `SCREENWIDTH`
meant the same row step). The pattern is deterministic, not random.

`fuzzpos` is a global that advances per pixel and wraps at 50; it is shared
by all fuzz columns in a frame. Fuzz has no low-detail variant.

### 7.4 `R_DrawTranslatedColumn` — player color translation

Adds one indirection per pixel:

```c
*dest = dc_colormap[dc_translation[dc_source[frac >> FRACBITS]]];
```

`dc_translation` is one of three 256-byte tables that remap the green ramp
(indices `0x70`–`0x7f`) for multiplayer player colours. Built in
`R_InitTranslationTables` into a 256-aligned zone block:

```
for i in 0x70..0x7f:
    translationtables[i]      = 0x60 + (i & 0xf)  // gray
    translationtables[i+256]  = 0x40 + (i & 0xf)  // brown
    translationtables[i+512]  = 0x20 + (i & 0xf)  // red
all other indices: identity
```

`0x60`, `0x40` and `0x20` start the gray, brown and red ramps in PLAYPAL. The
table is chosen by the thing's `MF_TRANSLATION` bits. It uses the same
`dc_texheight` dispatch as `R_DrawColumn`.

### 7.5 `R_DrawSpan` — floor/ceiling span

A horizontal span across `[ds_x1, ds_x2]` on row `ds_y`:

```c
dest = ylookup[ds_y] + columnofs[ds_x1];
// 4-wide unrolled; four independent spots per iteration
spot = ((yfrac >> 10) & 4032) | ((xfrac >> 16) & 63);
*dest = ds_colormap[ds_source[spot]];
dest += SCREENHEIGHT;            // next column in the column-major layout
xfrac += ds_xstep; yfrac += ds_ystep;
```

**Flat addressing**: `ds_source` is a 64×64 flat (4096 bytes), indexed as
`row * 64 + column`. `(yfrac >> 10) & 4032` is the integer part of `yfrac`,
modulo 64, times 64 (`4032 = 63*64`). `(xfrac >> 16) & 63` is the integer
part of `xfrac` modulo 64.

The unroll keeps `xfrac` and `yfrac` as separate 32-bit accumulators and is
bit-identical to the scalar loop ([optimization-ledger.md](optimization-ledger.md)
NC5).

**Memory access**: `ds_source` reads jump around the 4096-byte flat at the
view angle's step, but the flat fits in L1. `ds_colormap` is 256 bytes. The
writes stride `SCREENHEIGHT` bytes.

**`R_DrawSpanLow`**: low-detail mode. Each texel is written to two adjacent
columns. The pixel count is taken before `ds_x1` and `ds_x2` are doubled;
vanilla computed it after, which writes twice the span and overruns. webdoom
fixes it as Chocolate Doom does.

### 7.6 Column-draw function dispatch

`colfunc`, `basecolfunc`, `fuzzcolfunc`, `transcolfunc` and `spanfunc` are
global function pointers (r_main.c), set by `R_ExecuteSetViewSize`:

| detail | `colfunc` / `basecolfunc` | `fuzzcolfunc` | `transcolfunc` | `spanfunc` |
|--------|---------------------------|---------------|----------------|------------|
| high | `R_DrawColumn` | `R_DrawFuzzColumn` | `R_DrawTranslatedColumn` | `R_DrawSpan` |
| low | `R_DrawColumnLow` | `R_DrawFuzzColumn` | `R_DrawTranslatedColumn` | `R_DrawSpanLow` |

Fuzz and translated columns exist only at high detail. `R_DrawVisSprite`
switches `colfunc` to the fuzz or translated routine for one sprite and
restores `basecolfunc` afterwards.

---

## 8. Texture and data — r_data.c

### 8.1 Composite texture assembly

Wall textures are defined in the `TEXTURE1`/`TEXTURE2` lumps as named lists
of patches placed on a canvas ([formats.md](formats.md) §3.6).
`R_InitTextures` reads the definitions, resolves patch names through
`PNAMES` (a missing patch is an `I_Error`), allocates the per-texture arrays
and calls `R_GenerateLookup` for each texture.

**`R_GenerateLookup`** counts, for each column, how many patches cover it:

- **One patch**: `collump[col]` is that patch lump and `colofs[col]` is the
  byte offset of its column data plus 3, i.e. the pixels of the first post.
  The draw reads straight from the patch. A patch with transparent gaps used
  this way reads the post headers and the following bytes as pixels; that is
  vanilla behaviour.
- **Several patches**: `collump[col] = -1` (composite) and `colofs[col]` is
  an offset into the texture's composite block, which grows by
  `texture->height` per such column. A composite block over 64 KiB is an
  `I_Error`.
- **No patch**: a warning is printed and the rest of the texture's lookup is
  skipped (vanilla behaviour; the `I_Error` is commented out in the source).

**`R_GenerateComposite`** runs lazily on first use of a composite column. It
allocates the block `PU_STATIC`, draws every overlapping patch column into it
with `R_DrawColumnInCache` (clipped to the texture height), then retags the
block `PU_CACHE`. Under memory pressure the zone may purge it, and the next
use rebuilds it.

**Zone tags**: `PU_STATIC` blocks are never purged; `PU_CACHE` blocks may be.
`R_DrawPlanes` caches each flat `PU_STATIC` while drawing its plane and
retags it `PU_CACHE` afterwards, so a flat cannot vanish mid-plane but stays
reusable across frames.

### 8.2 `R_GetColumn` — column retrieval path

`R_GetColumn` is a `static inline` in r_data.h; the composite branch calls
`R_GetColumnComposite` in r_data.c:

```c
col &= texturewidthmask[tex];
lump = texturecolumnlump[tex][col];
ofs  = texturecolumnofs[tex][col];
if (lump > 0) return W_CacheLumpNum(lump, PU_CACHE) + ofs;  // single patch
return R_GetColumnComposite(tex, ofs);   // builds the composite on first use
```

`texturewidthmask[tex]` is the **largest power of two not exceeding** the
texture width, minus 1. A texture whose width is not a power of two therefore
tiles at the smaller power of two, and its columns past that point are never
drawn. This is vanilla behaviour; the standard IWAD textures all have
power-of-two widths.

### 8.3 Animation translation tables

`texturetranslation[]` and `flattranslation[]` start as identity. The playsim
rewrites them for animated textures and flats (`P_UpdateSpecials`, see
[playsim.md](playsim.md) §10.1). The wall, masked and flat paths all index
through them, so animation is invisible to the renderer.

### 8.4 Colormap initialization

`R_InitColormaps` loads the `COLORMAP` lump into a 256-byte-aligned zone
block. It is always read from the WAD and never regenerated: a PWAD may
replace it, and the recipe that produced id's lump does not hold for every
IWAD. The recipe is in [engine-archaeology.md](engine-archaeology.md) §6.

### 8.5 Sprite lump init

`R_InitSpriteLumps` reads `width`, `leftoffset` and `topoffset` from each
sprite patch header into `spritewidth[]`, `spriteoffset[]` and
`spritetopoffset[]`, caching each lump `PU_CACHE` only long enough to read it.
Projection needs only these three; the patch data is loaded when the sprite
is drawn.

---

## 9. Sky — r_sky.c

Sky drawing lives in `R_DrawPlanes`, not in a sky module. `skyflatnum` (the
flat `F_SKY1`, looked up in `G_DoLoadLevel`) marks a ceiling or floor as sky;
`R_FindPlane` merges every sky surface into one visplane (§5.2).

`r_sky.c` holds only `skyflatnum`, `skytexture`, `skytexturemid` and
`R_InitSkyMap`, which sets `skytexturemid = 100*FRACUNIT`.

**Sky selection**: `G_InitNew` picks `SKY1`…`SKY4` by episode.
`G_DoLoadLevel` overrides it for DOOM II, TNT and Plutonia by map:
`SKY1` below MAP12, `SKY2` below MAP21, `SKY3` from there on. Vanilla tested
`gamemode` against `GameMission_t` values in that override, and since
`retail == pack_plut == 3` Ultimate DOOM's E2–E4 got E1's sky. webdoom tests
`gamemission`, so each episode shows its own sky. The fix is render-only.

**Sky column draw** (per column of the sky visplane):

```
dc_iscale     = pspriteiscale >> detailshift
dc_colormap   = colormaps                       // map 0: always full bright
dc_texturemid = skytexturemid
dc_texheight  = textureheight[skytexture] >> FRACBITS
angle = (viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT
dc_source = R_GetColumn(skytexture, angle)
colfunc()
```

`ANGLETOSKYSHIFT = 22` (r_sky.h), so a full turn spans 1024 column indices.
A 256-column sky texture is masked to 256, repeating four times around the
circle, and a 90° view shows exactly one texture width. Because the sky
always uses map 0, the invulnerability colormap does not apply to it; the
source comment calls this out as deliberate.

**Freelook**: `R_ShearView` sets
`skytexturemid = 100*FRACUNIT + (lookdir << FRACBITS)`, so the sky scrolls
with the pitch. At `lookdir = 0` it is vanilla's value; `R_ForceReshear`
restores it.

The trig tables the sky and everything else read are covered by
[engine-archaeology.md](engine-archaeology.md) §1.

---

## 10. Raised limits table

| limit | vanilla | webdoom | defined at | overflow: vanilla | overflow: webdoom |
|-------|---------|---------|------------|-------------------|-------------------|
| `MAXVISPLANES` | 128 | 256 | r_plane.c | `I_Error` in `R_FindPlane`; `R_CheckPlane` writes past the array | `I_Error` in either |
| `MAXDRAWSEGS` | 256 | 256 | r_defs.h:55 | wall silently not drawn | same |
| `MAXVISSPRITES` | 128 | 1024 | r_things.h:31 | extra sprites share `overflowsprite` | same |
| `MAXSEGS` (solidsegs) | 32 | 64 | r_bsp.c:106 | out-of-bounds write | clip entry dropped, wall still drawn |
| `MAXOPENINGS` | SCREENWIDTH×64 = 20480 | 20480 | r_plane.h:36 | out-of-bounds write (`I_Error` only in `RANGECHECK` builds) | allocation dropped fail-soft (§4.3) |

`node tools/archaeology/source-constant-verify.mjs` re-reads every value in
the webdoom column.

Measured peaks over the 13 golden demos, which the limits are sized against:

| limit | peak | margin | witness | ledger entry |
|-------|------|--------|---------|--------------|
| `MAXVISPLANES` | 118 (library views: about 156) | 2.17× | plutonia-demo1 | C4, C4b |
| `MAXDRAWSEGS` | 205 | 1.25× | doom-demo4 | C5 |
| `MAXOPENINGS` | 2527 | 8.1× | | C6 |
| `MAXSEGS` | 17 | 3.8× | | NC2 |

The ledger entries are in [optimization-ledger.md](optimization-ledger.md).

**MAXDRAWSEGS overflow**: `R_StoreWallRange` begins with
`if (ds_p == &drawsegs[MAXDRAWSEGS]) return;`. Walls past the limit are
neither stored nor drawn: they vanish, with no crash. The margin is thin, so
a complex PWAD scene can show missing walls; that is vanilla's behaviour at
the same limit.

**MAXVISSPRITES overflow**: `R_NewVisSprite` returns `&overflowsprite` (a
file-scope global) when the pool is full. Every later sprite overwrites that
one struct, which is never linked into the sort, so the extra sprites are
silently dropped.

**Demo compatibility**: all five limits are render-side. They govern which
walls, planes, sprites and clips are displayed; nothing they protect feeds
the simulation (`P_Random`, actor positions, line triggers). None of the
overflow paths touches `gametic`, `P_Random` or any `mobj_t` field the sim
reads, so changing a limit cannot change what `G_Ticker` computes.

---

## 11. Per-stage performance mapping

Per-stage cost comes from `tools/bench.mjs`, which runs the three doom.wad
attract demos with rendering on and divides each `web_perf_*_us`
accumulator by the frames rendered. The per-host results live in
`tools/golden/bench-baseline.json` (`perStage`), and the `perf-fleet` leg
re-measures each host against them.

The averages below are that file's current contents (recorded at commit
f402d5c), in ms per frame:

| stage | doc section | alder | tank | wbox |
|-------|-------------|-------|------|------|
| frame-setup+clears | §2 | 0.0004 | 0.0011 | 0.0088 |
| bsp+segs | §3, §4 | 0.0230 | 0.0487 | 0.2657 |
| planes | §5 | 0.0177 | 0.0330 | 0.1687 |
| masked | §6 | 0.0105 | 0.0180 | 0.0737 |
| render total | | 0.0516 | 0.1008 | 0.5170 |
| sim (per tic, not per frame) | [playsim.md](playsim.md) | 0.0074 | 0.0144 | 0.0863 |

The ranking is the same on every host: bsp+segs > planes > masked. The BSP
stage includes all wall column drawing, because `R_StoreWallRange` draws as
it goes.

On wbox, the slowest host, the whole render costs 0.517 ms, 1.8% of the
28.57 ms a 35 Hz tic allows; the sim adds 0.3%. The rest of a frame's budget
goes to the browser side (JS, texture upload, compositing), which the
`browser-pipeline` leg measures per host.

---

## 12. Cross-cutting invariants

1. **Front-to-back BSP order** is what makes the `solidsegs` clipper correct.
   The BSP guarantees that, at every node, nothing in the back child can hide
   anything in the front child.

2. **`validcount`** is incremented once per frame by `R_SetupFrame`. The
   renderer uses it to project each sector's things once (`R_AddSprites`).
   The playsim shares the same global for its own line and sector marking.
   Sharing is safe because every user increments `validcount` before marking
   and compares only for equality, so the renderer's increments never change
   a sim result. The `sim-invariants` and `sim-freelook` legs run the
   renderer against the sim goldens and confirm it.

3. **`floorclip[x]` / `ceilingclip[x]`** are the only per-column state that
   carries from one seg to the next during the BSP walk. `R_ClearPlanes`
   starts them at `viewheight` and −1; they narrow as walls are drawn.
   Visplane extents depend on them being correct before `R_RenderSegLoop`
   writes `top[x]` and `bottom[x]`.

4. **`openings[]` is frame-scoped.** `R_ClearPlanes` resets
   `lastopening = openings`; slices handed out during the BSP walk stay valid
   until the next frame's reset.

5. **Texture column pointers** from `R_GetColumn` must not be held across a
   zone purge. A wall draw finishes long before any purge could free the
   lump. Composite blocks are `PU_CACHE` after generation and are freed only
   under zone pressure, never at a frame boundary.

6. **The sky visplane** is the only one drawn without spans. Its `top[]` and
   `bottom[]` are filled by `R_RenderSegLoop` like any other plane, but
   `R_DrawPlanes` draws it as columns (§9).

7. **The renderer must not touch sim state.** It reads mobjs and sectors but
   writes only render scratch, and `R_InterpolateSectors` restores every
   sector height it lerped before `R_RenderPlayerView` returns. In
   `WEBDOOM_INVARIANTS` builds `R_RenderPlayerView` sets
   `doom_in_render_path` for the whole frame, and `P_Random` aborts if called
   while it is set ([playsim.md](playsim.md) §16).

---

## 12b. Render variants

One render variant ships beside the default path, and it is a runtime switch,
not a build: low detail, the half-horizontal-resolution column and span
routines of §7.6. `web_set_detail(detail)` (engine/web/i_main.c) routes
through vanilla's `R_SetViewSize`, so `R_ExecuteSetViewSize` rebuilds every
view table with the new `detailshift` on the next frame. Setting
`detailshift` directly would leave those tables stale.

| variant | build dir | what changes | golden family | suite leg |
|---------|-----------|--------------|---------------|-----------|
| default | `build/` | the vanilla path | `*-render.json` (13) | `render-goldens` |
| low detail (`--low-detail`) | `build/` | `R_DrawColumnLow` / `R_DrawSpanLow` via `web_set_detail` | `*-render-low.json` (13) | `render-low` |

The low-detail goldens have no external reference: no other port reproduces
webdoom's low-detail output byte for byte, so they were recorded from this
engine and protect against drift only. Low detail changes only render tables
and draw routines, none of which the simulation reads.

There are no compile-time render variants. Toggles of that kind were
unreachable by players and measured no worthwhile gain; their measurements
are in [optimization-ledger.md](optimization-ledger.md).
