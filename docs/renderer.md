# webdoom renderer internals

The software renderer is a classic 1993 design: front-to-back BSP walk to build
a horizontal clip list, vertical column draws for walls, horizontal span fills
for floors/ceilings, back-to-front sprite sort. Every piece is documented here
from the actual source (`engine/core/r_*.c`). Claims are cited by file and line;
where the code was verified by experiment the one-liner is shown.

Tone standard: `docs/engine-archaeology.md`. Where folklore is wrong, say so.

Quantitative claims are enumerated in `docs/claims-index.md`. Run
`bash tools/archaeology/verify-all.sh` to cross-check all figures; CI
enforces it. Invariant source constants (raised-limits table) are
verified by `node tools/archaeology/source-constant-verify.mjs`.

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
13. [Open questions for task 1.4](#13-open-questions-for-task-14)

---

## 1. Frame pipeline overview

`R_RenderPlayerView` (r_main.c:957) drives one complete frame in four timed
stages:

```
frame-setup+clears   → web_perf_frame_us
  R_SetupFrame        (viewpoint, interpolation, colormap state)
  R_ShearView         (freelook y-shear, lazy — skips if lookdir unchanged)
  R_InterpolateSectors (lerp sector heights to render scratch, restore after)
  R_ClearClipSegs / R_ClearDrawSegs / R_ClearPlanes / R_ClearSprites

BSP+segs             → web_perf_bsp_us
  R_RenderBSPNode     (recursive; emits drawsegs + visplane extents)

planes               → web_perf_planes_us
  R_DrawPlanes        (span-fill every floor/ceiling visplane)

masked               → web_perf_masked_us
  R_DrawMasked        (sort sprites, draw back-to-front + weapon psprites)
```

`NetUpdate()` is called between each stage (r_main.c:992,1002,1011,1024) —
the network tick pump runs inside the render loop to keep latency low.

The five `web_perf_*_us` accumulators (declared in engine/web/perf.c) are read
by `bench.mjs` and written to `tools/golden/bench-baseline.json`.

**webdoom additions not in vanilla**: render interpolation (`smoothrender`,
`fractic`, `R_LerpFixed`, `R_LerpAngle`), freelook y-shear (`lookdir`,
`R_ShearView`), sector height interpolation (`R_InterpolateSectors`). These
are render-local: the simulation always runs on true, unlerped values.

---

## 2. Frame setup — r_main.c

### 2.1 View basis

`R_SetupFrame` (r_main.c:852) establishes the view every frame:

| variable | type | value |
|----------|------|-------|
| `viewx`, `viewy`, `viewz` | `fixed_t` | lerped world position |
| `viewangle` | `angle_t` (uint32) | lerped + `viewangleoffset` |
| `viewsin`, `viewcos` | `fixed_t` | `finesine[viewangle>>19]`, `finecosine[…]` |
| `projection` | `fixed_t` | `centerxfrac` = `(viewwidth/2)<<16` |
| `extralight` | `int` | gun-flash brightness bump |

`projection` is the focal length in fixed-point pixels. DOOM uses a flat-screen
projection, not a fisheye: the projection plane is `centerx` pixels wide, and
the focal length equals half that width. Combined with `FIELDOFVIEW = 2048`
fine-angle units, the horizontal FOV is `2 * atan(SCREENWIDTH/2 / focallength)`
— approximately 90°. (The exact value depends on screen width via
`R_InitTextureMapping`; `FIELDOFVIEW = 2048` fine-angles out of 8192 = 90°
exactly.)

### 2.2 Angle→column mapping: `viewangletox` and `xtoviewangle`

Built in `R_InitTextureMapping` (r_main.c:548), called from
`R_ExecuteSetViewSize` whenever the view size changes.

**`viewangletox[i]`** — maps a fine-angle index `i` (0…FINEANGLES/2−1) to the
screen column where that ray hits the projection plane. Recipe (r_main.c:563):

```
focallength = centerxfrac / finetangent[FINEANGLES/4 + FIELDOFVIEW/2]
for i in 0..FINEANGLES/2:
    t = FixedMul(finetangent[i], focallength)
    viewangletox[i] = (centerxfrac - t + FRACUNIT - 1) >> FRACBITS
    clamped to [-1, viewwidth+1]; fencepost -1→0, viewwidth+1→viewwidth
```

`FINEANGLES = 8192` (tables.h:36); `ANGLETOFINESHIFT = 19` (tables.h:55), so
`angle_t >> 19` gives a fine-angle index in 0…8191. The viewangletox table
covers the visible half-circle (4096 entries). Angles outside
`[-clipangle, +clipangle]` map to sentinel values -1 or viewwidth, which the
clipper uses to detect fully-off-screen walls (r_main.c:566-579).

**`xtoviewangle[x]`** — inverse: the leftmost fine-angle that maps to column
`x`. Built by scanning `viewangletox[]` left to right (r_main.c:586-592):

```
for x in 0..viewwidth:
    i = 0
    while viewangletox[i] > x: i++
    xtoviewangle[x] = (i << 19) - ANG90
```

`clipangle = xtoviewangle[0]` is the half-FOV angle used by both the BSP
frustum test and the seg clipper.

These two tables are the linchpin of perspective: every column draw and every
texture-offset calculation goes through one of them.

### 2.3 `scalelight` and `zlight` — lighting tables

Two 2D pointer arrays into `colormaps`. Both map a lighting level and a
distance to the appropriate COLORMAP entry.

**`zlight[LIGHTLEVELS][MAXLIGHTZ]`** — distance-based, for floor/ceiling spans.
Built in `R_InitLightTables` (r_main.c:618). `LIGHTLEVELS = 16`,
`MAXLIGHTZ = 128`. Per entry:

```
startmap[i] = ((LIGHTLEVELS-1-i)*2) * NUMCOLORMAPS / LIGHTLEVELS
scale = FixedDiv((SCREENWIDTH/2 * FRACUNIT), (j+1) << LIGHTZSHIFT)
scale >>= LIGHTSCALESHIFT
level = startmap[i] - scale/DISTMAP
level clamped to [0, NUMCOLORMAPS-1]
zlight[i][j] = colormaps + level*256
```

Constants (r_main.h): `NUMCOLORMAPS = 32`, `LIGHTZSHIFT = 20`,
`LIGHTSCALESHIFT = 12`, `DISTMAP = 2` (r_main.c:616).

`LIGHTZSHIFT = 20` means the column index `j` encodes distance in units of
`1/2^20` of a world unit; `(j+1) << 20` is the distance in fixed-point.
At `j = 0` (closest possible, distance ~1), scale is enormous and light is
maximum. At `j = 127` (MAXLIGHTZ−1), scale is minimal and light fades to dark.

**`scalelight[LIGHTLEVELS][MAXLIGHTSCALE]`** — scale-based, for walls and
sprites. Rebuilt in `R_ExecuteSetViewSize` every time the view size changes,
because it depends on `viewwidth` (r_main.c:750-765). `MAXLIGHTSCALE = 48`.
Per entry:

```
startmap[i] = ((LIGHTLEVELS-1-i)*2) * NUMCOLORMAPS / LIGHTLEVELS
level = startmap[i] - j * SCREENWIDTH / (viewwidth << detailshift) / DISTMAP
level clamped to [0, NUMCOLORMAPS-1]
scalelight[i][j] = colormaps + level*256
```

The `j` index is derived from `rw_scale >> LIGHTSCALESHIFT` (r_segs.c:269) —
larger scale (closer wall) → higher `j` → brighter light. The
`SCREENWIDTH / viewwidth` factor adjusts for reduced-size views.

**Folklore correction**: these tables are *not* mysterious magic — they are
mechanical linear interpolations between the darkest and brightest COLORMAPs at
each light level. The recipe is fully readable from the code; no reverse
engineering is required. Task 1.4 needs to verify the exact constant choices
(DISTMAP=2, LIGHTZSHIFT=20) against the original id Software intent, but the
structure is unambiguous.

### 2.4 `yslope` and `distscale`

**`yslope[y]`** (r_plane.c:85, built in r_main.c:734-738): the flat-to-eye
distance multiplier for each screen row. For row `y`:

```
dy = |y - centery + 0.5|   (in FRACUNIT)
yslope[y] = ((viewwidth << detailshift) / 2 * FRACUNIT) / dy
```

At `y = centery`, `dy` approaches 0 and `yslope` would overflow — but that row
is the horizon and never receives span fills because the floor is always below
the horizon (r_main.c has clamp at `viewheight/2 − 8` via `R_ShearView`).

**`distscale[x]`** (r_plane.c:86, built in r_main.c:742-745): corrects flat
distances for oblique viewing angles at each screen column:

```
cosadj = |finecosine[xtoviewangle[x] >> ANGLETOFINESHIFT]|
distscale[x] = FRACUNIT / cosadj
```

Both arrays are rebuilt by `R_ShearView` when `lookdir` changes (r_main.c:
907-928), which happens when the player pitches view.

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

(r_bsp.c:552-578). The root call is `R_RenderBSPNode(numnodes-1)` (r_main.c:997).

**Traversal order**: front-to-back relative to the viewpoint. The recursion
visits the front child before the back child at every node, so subsectors arrive
at `R_Subsector` in approximate front-to-back order. This is the property the
`solidsegs` clipper exploits: once a screen column is fully covered by solid
walls, all subsequent segs that project onto it can be skipped.

**`NF_SUBSECTOR = 0x8000`** (doomdata.h:178). The BSP node children array
stores either a node index or a subsector index with the high bit set.

**`R_PointOnSide`** (r_main.c:166): classifies a point against a node's
partition line. Uses fixed-point cross product after two fast sign-bit tests
(r_main.c:195-203). The sign-bit fast-path avoids the multiply when the
signs of `node->dy ^ node->dx ^ dx ^ dy` make the result obvious.

### 3.2 `R_Subsector` — leaf processing

(r_bsp.c:497-542). For each BSP leaf (subsector):

1. Allocate/find a `visplane` for the floor (if below viewpoint).
2. Allocate/find a `visplane` for the ceiling (if above viewpoint or sky).
3. Call `R_AddSprites(frontsector)` — collects things for this sector into
   the `vissprites[]` array (once per sector per frame, guarded by `validcount`).
4. Loop over all segs in the subsector, calling `R_AddLine` for each.

### 3.3 `R_AddLine` — seg clipping

(r_bsp.c:259-356). For a single seg:

1. Backface cull: if `angle1 - angle2 >= ANG180`, the seg faces away —
   skip. (r_bsp.c:279)
2. Frustum clip: both endpoints are tested against `±clipangle`. If the span
   is fully outside, skip. Partially outside: clip endpoint to `±clipangle`.
   (r_bsp.c:287-307)
3. Map clipped angles to screen columns via `viewangletox[]`.
4. Zero-width: if x1 == x2, skip (r_bsp.c:317).
5. Route to `R_ClipSolidWallSegment` (for single-sided lines or closed doors)
   or `R_ClipPassWallSegment` (for two-sided portals). These call
   `R_StoreWallRange` for each visible fragment.

### 3.4 `solidsegs` — the horizontal clip list

```c
#define MAXSEGS  64    // webdoom: was 32
cliprange_t solidsegs[MAXSEGS];
cliprange_t* newend;   // one past the last valid entry
```

(r_bsp.c:88-92). `cliprange_t` is `{int first; int last}` — a horizontal
pixel range. The array is a sorted list of closed screen-column intervals that
are fully covered by solid (opaque, single-sided) walls seen so far this frame.

**Invariants**:
- Entries are sorted by `first` in strictly increasing order.
- No two entries overlap or are adjacent (they are merged).
- `solidsegs[0] = {-0x7fffffff, -1}` and `solidsegs[1] = {viewwidth, 0x7fffffff}`
  are sentinel bookends that simplify boundary conditions (r_bsp.c:247-251).

**`R_ClipSolidWallSegment`** (r_bsp.c:96-185): given a new solid range
[first, last], scans the list to find intersecting entries, calls
`R_StoreWallRange` for each visible fragment, then merges the new range into
the list. Inserts, splits, and crunches in a single linear pass.

**`R_ClipPassWallSegment`** (r_bsp.c:193-238): same scan, but does *not*
insert into `solidsegs` — portals remain transparent.

**Overflow behavior (webdoom)**: MAXSEGS was 32 in vanilla; webdoom raised it
to 64 (r_bsp.c:88). At 32, a map with 33 or more separated solid walls visible
at once would overflow the array — the code writes past the end of `solidsegs`
into adjacent stack/data. In vanilla this caused undefined behavior or a crash.
Webdoom's 64-entry limit makes overflow far less likely; when it *does*
overflow (`newend++` would exceed the array), the write still happens — there
is no bounds check on `newend`. This is not a hard abort; it is silent
corruption. The practical risk at 64 is negligible for any normal DOOM map.

### 3.5 `R_CheckBBox` — node frustum culling

(r_bsp.c:381-487). Before recursing into the back subtree, checks whether the
node's bounding box might be visible.

**Algorithm**:
1. Determine which corner of the box is the "closest" from the viewpoint's
   perspective using `boxx` (0/1/2 for left-of/inside/right-of) and `boxy`
   (similarly for Y). Combined into `boxpos = (boxy<<2)+boxx`, the
   `checkcoord[12][4]` table (r_bsp.c:365-378) maps `boxpos` to the pair of
   corners that define the widest angular span.
2. If `boxpos == 5` (viewpoint inside the box), return `true` immediately.
3. Compute screen columns for the two corners. If they project to the same
   column, or the entire span is already covered in `solidsegs`, return `false`.

The `checkcoord` table is a lookup that picks which pair of the box's four
corners subtends the widest angle as seen from the viewpoint, depending on
which of nine positions the viewpoint occupies relative to the box.

---

## 4. Wall pipeline — r_segs.c

### 4.1 `R_StoreWallRange` — drawseg creation

(r_segs.c:374-745). Called for every visible pixel-range fragment of a seg.
Produces one `drawseg_t` entry and draws the wall columns immediately via
`R_RenderSegLoop`.

**Geometry setup** (r_segs.c:399-413):

```
rw_normalangle = curline->angle + ANG90    // perpendicular to seg
offsetangle = |rw_normalangle - rw_angle1|  (rw_angle1 = angle to seg v1)
distangle = ANG90 - offsetangle
hyp = R_PointToDist(v1->x, v1->y)          // distance to v1 from viewpoint
rw_distance = hyp * finesine[distangle]    // perpendicular distance to line
```

This is the standard formula: `d_perp = d_hyp * sin(angle_between)`.

**Scale at each endpoint** (r_segs.c:419-446):

```
scale1 = R_ScaleFromGlobalAngle(viewangle + xtoviewangle[x1])
scale2 = R_ScaleFromGlobalAngle(viewangle + xtoviewangle[x2])
scalestep = (scale2 - scale1) / (x2 - x1)
```

`R_ScaleFromGlobalAngle` (r_main.c:457-506):

```
anglea = ANG90 + (visangle - viewangle)
angleb = ANG90 + (visangle - rw_normalangle)
scale = projection * sineb / (rw_distance * sinea)   (fixed-point)
clamped to [256, 64*FRACUNIT]
```

Both sines are guaranteed positive because both angles are in [0, ANG90] by
construction. Scale is clamped to prevent extreme near/far values; the
lower bound 256 = 1/256 pixel height corresponds to a very distant wall, the
upper bound 64*FRACUNIT = 64 pixel height per texture pixel (very close wall).

**Fixed-point scale interpolation quirk**: `scalestep` is computed as integer
division `(scale2 - scale1) / (x2 - x1)`. Division truncates, so the
accumulated error by column x2 can be up to `(x2-x1)` units. On very wide,
very close walls this is a known vanilla imprecision that causes a slight scale
drift at the rightmost column. It does not affect demo compatibility (scales
feed only the render, not the sim).

### 4.2 `drawseg_t` — the drawseg record

(r_defs.h:327-352):

| field | type | meaning |
|-------|------|---------|
| `curline` | `seg_t*` | the source seg |
| `x1`, `x2` | `int` | screen column range |
| `scale1`, `scale2`, `scalestep` | `fixed_t` | scale at left, right, per-column step |
| `silhouette` | `int` | `SIL_NONE=0 / SIL_BOTTOM=1 / SIL_TOP=2 / SIL_BOTH=3` |
| `bsilheight`, `tsilheight` | `fixed_t` | world heights for bottom/top silhouette |
| `sprtopclip`, `sprbottomclip` | `short*` | per-column sprite clip arrays (into `openings[]`) |
| `maskedtexturecol` | `short*` | per-column texture column index for masked mid-texture |

**Silhouette flags** determine how this drawseg clips sprites drawn later:
- `SIL_BOTTOM`: the front sector floor is higher than the back → sprites behind
  get clipped from below at `bsilheight`.
- `SIL_TOP`: the front sector ceiling is lower than the back → clips from above
  at `tsilheight`.
- Single-sided lines: `SIL_BOTH`, `bsilheight=MAXINT`, `tsilheight=MININT`
  (effectively infinite clip in both directions).

A two-sided line with no height difference sets `silhouette = 0` — it does not
clip sprites. A two-sided line where the back floor/ceiling height is above/
below the view also sets `SIL_BOTTOM` or `SIL_TOP` with MAXINT/MININT heights
as a "clip everything" sentinel (r_segs.c:493-524).

If a masked mid-texture is present (`sidedef->midtexture != 0`), `maskedtexture=true`
and `maskedtexturecol` is allocated from `openings[]` (r_segs.c:609-613).
Silhouette flags are additionally OR-ed with `SIL_BOTH` for masked textures even
if there is no height difference, because the masked texture itself can occlude
sprites (r_segs.c:734-743).

### 4.3 `openings[]` — shared clip-array pool

```c
#define MAXOPENINGS  SCREENWIDTH*256   // webdoom: was *64
short openings[MAXOPENINGS];
short* lastopening;
```

(r_plane.c:59-60). One large flat array used as an allocator for per-column
sprite clip data. Each `drawseg_t` that needs `sprtopclip`, `sprbottomclip`,
or `maskedtexturecol` carves out a slice of `openings[]` via `lastopening`
(r_segs.c:611, 721-732). The pointer is bumped but never freed within a frame
(reset to `openings` at `R_ClearPlanes`, r_plane.c:198).

Vanilla MAXOPENINGS was `SCREENWIDTH*64 = 20480`. Webdoom raises it to
`SCREENWIDTH*256 = 81920`. Overflow is detected only in `RANGECHECK` mode
(r_plane.c:384-387); in a release build, `lastopening` would write past the
array end silently. The 4× increase covers complex maps with many two-sided
lines.

### 4.4 `R_RenderSegLoop` — the inner wall draw

(r_segs.c:206-364). For each column `rw_x` from `x1` to `x2`:

1. Compute `yl`, `yh` (top/bottom pixel of the wall opening), clamped to
   `ceilingclip[rw_x]` and `floorclip[rw_x]`.
2. If `markceiling`: record `ceilingplane->top[x] = ceilingclip+1`,
   `bottom[x] = yl-1`.
3. If `markfloor`: record `floorplane->top[x] = yh+1`,
   `bottom[x] = floorclip-1`.
4. Compute `texturecolumn` via angle offset (r_segs.c:265-266):
   ```
   angle = (rw_centerangle + xtoviewangle[x]) >> ANGLETOFINESHIFT
   texturecolumn = rw_offset - FixedMul(finetangent[angle], rw_distance)
   texturecolumn >>= FRACBITS
   ```
5. Look up light level from `walllights[rw_scale >> LIGHTSCALESHIFT]`.
6. Draw the appropriate wall tier (mid, top, bottom) or set masked column.
7. Update `ceilingclip[x]` / `floorclip[x]` after drawing each tier.

`rw_scale` is stepped by `rw_scalestep` each column. `topfrac` and `bottomfrac`
(for two-sided line tier edges) are stepped by `topstep` / `bottomstep`.
These are fixed-point values in `HEIGHTBITS = 12` fractional units
(`HEIGHTUNIT = 4096`). The frac→pixel conversion is `frac >> 12`.

---

## 5. Visplanes — r_plane.c

### 5.1 `visplane_t` structure

(r_defs.h:464-485):

| field | meaning |
|-------|---------|
| `height` | floor or ceiling world height |
| `picnum` | flat texture index |
| `lightlevel` | sector light level |
| `minx`, `maxx` | leftmost and rightmost column touched |
| `top[SCREENWIDTH]` | per-column top pixel of the plane span |
| `bottom[SCREENWIDTH]` | per-column bottom pixel |
| `pad1`…`pad4` | single bytes before/after top[] and bottom[], sentinel guards |

The `pad` bytes are used as sentinels: `R_DrawPlanes` sets `top[minx-1] = 0xff`
and `top[maxx+1] = 0xff` to terminate the `R_MakeSpans` scan without an
explicit bounds check (r_plane.c:438-439). The pads ensure `top[-1]` and
`top[SCREENWIDTH]` are always accessible one past the used range.

### 5.2 `R_FindPlane` — linear search, no hash

```c
for (check = visplanes; check < lastvisplane; check++) {
    if (height == check->height && picnum == check->picnum
        && lightlevel == check->lightlevel)
        break;
}
if (check < lastvisplane) return check;
// else allocate new:
if (lastvisplane - visplanes == MAXVISPLANES) I_Error(...);
lastvisplane++;
...
```

(r_plane.c:217-258). O(n) search over all allocated visplanes. In a typical
DOOM frame with a dozen visible flats, this is fast. In pathological open maps
with many distinct light levels or mixed floor heights, it can be slow (task 2.3
targets this with a hash/merge approach).

**Sky flat special case** (r_plane.c:225-228): if `picnum == skyflatnum`,
height is forced to 0 and lightlevel to 0 — all sky columns share exactly one
visplane regardless of sector height.

### 5.3 `R_CheckPlane` — splitting

(r_plane.c:265-323). Called from `R_RenderSegLoop` when a seg extends the
plane's column range. If the new columns [start, stop] don't overlap any
already-committed columns in the existing visplane, the range is simply
extended. If overlap occurs (some `top[x] != 0xff` in the intersection), the
plane must be split: a new visplane with the same height/pic/light is allocated
and given `[start, stop]`.

Invariant after `R_CheckPlane`: the returned visplane has `top[x] == 0xff` for
all x in [start, stop]. This ensures `R_RenderSegLoop` can write `top[x]`
without overwriting a previously committed span.

### 5.4 `R_MakeSpans` — span emission

(r_plane.c:329-359). Called column-by-column across each visplane's [minx, maxx]
range during `R_DrawPlanes`. Takes the previous column's [t1, b1] and the
current column's [t2, b2] spans. Any row present in the old span but not the
new span has its accumulated horizontal run terminated and emitted to
`R_MapPlane`. Any row present in the new span but not the old has its run
started.

This is the classic "column walking" span generator: spans are emitted as
horizontal rows close (consecutive columns no longer share the same row), which
keeps them as long as possible.

### 5.5 `R_MapPlane` — span setup and draw

(r_plane.c:120-177). For a completed horizontal span at screen row `y`:

```
distance = planeheight * yslope[y]                // world distance to this row
ds_xstep = distance * basexscale                  // texture step per column
ds_ystep = distance * baseyscale
length = distance * distscale[x1]                // distance at left edge
angle = (viewangle + xtoviewangle[x1]) >> ANGLETOFINESHIFT
ds_xfrac = viewx + finecosine[angle] * length    // texture origin
ds_yfrac = -viewy - finesine[angle] * length
```

Distance is cached per row (`cachedheight[]`) to avoid redundant multiplies
when the same height appears in multiple spans at the same row. `basexscale`
and `baseyscale` are set in `R_ClearPlanes` (r_plane.c:204-208):

```
angle = (viewangle - ANG90) >> ANGLETOFINESHIFT
basexscale = finecosine[angle] / centerxfrac
baseyscale = -finesine[angle] / centerxfrac
```

These encode the viewing direction into the span stepping, so the flat texture
rotates correctly with the player's angle.

### 5.6 Overflow: vanilla crash vs. webdoom `I_Error`

**Vanilla (MAXVISPLANES = 128)**: `R_FindPlane` calls `I_Error` when the 128th
plane would be exceeded — a hard abort, same as a crash. Vanilla's `I_Error`
exits via `longjmp`-like logic. Webdoom does the same: `I_Error` is called at
r_plane.c:246.

**Webdoom (MAXVISPLANES = 1024)**: the limit is raised 8× (r_plane.c:52). The
overflow behavior is identical — `I_Error("R_FindPlane: no more visplanes")` at
the same code path. The difference is that overflow requires more than 1024
distinct (height, picnum, lightlevel) triples visible at once, which no shipped
DOOM map achieves. The constant choice was verified: `grep MAXVISPLANES
engine/core/r_plane.c` → `#define MAXVISPLANES 1024 // webdoom: was 128`.

**Demo-compat safety**: visplanes are entirely render-side. They encode nothing
that enters the simulation. Raising `MAXVISPLANES` cannot affect P_Random calls,
actor positions, or any other sim-observable state. The same applies to
MAXDRAWSEGS, MAXVISSPRITES, MAXSEGS, and MAXOPENINGS.

---

## 6. Sprites and things — r_things.c

### 6.1 `vissprite_t` structure

(r_defs.h:378-414):

| field | meaning |
|-------|---------|
| `prev`, `next` | doubly-linked list links for sort |
| `x1`, `x2` | screen column range |
| `gx`, `gy`, `gz` | lerped world position |
| `gzt` | top of sprite in world coords (`gz + spritetopoffset`) |
| `startfrac` | initial texture column (fixed-point) |
| `scale` | screen scale (`projection / tz`) |
| `xiscale` | texture column step per screen column (negative if flipped) |
| `texturemid` | `gzt - viewz` — texture origin relative to view |
| `patch` | sprite lump index |
| `colormap` | pointer into `colormaps[]`; `NULL` means shadow draw |
| `mobjflags` | original thing flags (for translation and shadow) |

### 6.2 `R_ProjectSprite` — visibility and projection

(r_things.c:454-616). For each thing in the sector being processed:

1. **Transform to view space** (r_things.c:498-502):
   ```
   tz = FixedMul(tr_x, viewcos) - FixedMul(tr_y, viewsin)
   tx = -(FixedMul(tr_y, viewcos) + FixedMul(tr_x, viewsin))
   ```
   `tz` is the depth (Z in view space), `tx` is horizontal displacement.

2. **Cull if behind view plane**: `tz < MINZ (= 4*FRACUNIT)` → skip.
3. **Cull if too far sideways**: `|tx| > tz*4` → skip.
4. **Rotation selection** (r_things.c:531-543): if the sprite has 8 rotations,
   pick the rotation based on the angle from the sprite to the player:
   `rot = (ang - iangle + ANG45/2*9) >> 29`. The `*9` accounts for the
   clockwise-vs-counterclockwise convention mismatch mentioned in the source comment.
5. **Project onto screen**: `x1 = (centerxfrac + tx*xscale) >> FRACBITS`,
   similarly `x2`. Off-screen fully → skip.
6. **Fill vissprite fields** and push into `vissprites[]`.
7. **Light level selection** (r_things.c:589-615): `NULL` for shadow
   (MF_SHADOW), `fixedcolormap` for invulnerability/night-vision,
   `colormaps` (map 0, full bright) for FF_FULLBRIGHT frames, else
   `spritelights[xscale >> (LIGHTSCALESHIFT-detailshift)]`.

Webdoom addition: position is interpolated via `R_LerpFixed(thing->oldx, thing->x)`
etc. before projection (r_things.c:490-493).

Webdoom robustness: frame index out of range returns instead of `I_Error`
(r_things.c:527-529). Missing sprite frames during init print a warning instead
of aborting (r_things.c:253-259).

### 6.3 `R_SortVisSprites` — O(n²) selection sort

(r_things.c:801-849). After all sectors have been traversed:

1. Link all `vissprites[0..count-1]` into a doubly-linked `unsorted` ring.
2. For `i` in `0..count-1`: scan the ring for the entry with smallest `scale`
   (farthest away), unlink it, append it to `vsprsortedhead` ring.
3. Result: `vsprsortedhead` is sorted ascending by scale (back-to-front).

This is O(n²) — for each of n sprites, a linear scan of the remaining n−i
sprites. For the typical case of a dozen sprites it is fast. With MAXVISSPRITES
raised to 1024, pathological maps could push this to ~1024²/2 ≈ 500,000
comparisons per frame. Not a problem for any shipped map; worth noting for
custom content (task 2.1 can measure and 2.3 can address if needed).

### 6.4 `R_DrawSprite` — sprite occlusion by drawsegs

(r_things.c:856-964). For each vissprite, scans `drawsegs[]` backward (most
recently drawn first):

1. Skip drawsegs that don't overlap the sprite's x range or have no silhouette.
2. Compare scales: if `ds->scale > spr->scale` (drawseg is closer), the sprite
   is behind the wall. Use `ds->sprtopclip` / `ds->sprbottomclip` to clip the
   sprite. A finer test `R_PointOnSegSide(spr->gx, spr->gy, ds->curline)` handles
   the near case where the drawseg scale range straddles the sprite scale.
3. If the drawseg is farther, it might have a masked mid-texture — call
   `R_RenderMaskedSegRange` now (the texture is behind the sprite and must be
   drawn before the sprite overwrites it).

The per-column `clipbot[]`/`cliptop[]` arrays are filled from the matching
`ds->sprbottomclip[]` / `ds->sprtopclip[]` (which point into `openings[]`). A
column starts at sentinel −2 ("unset"); unset columns after the scan default to
`viewheight`/`-1` respectively.

### 6.5 Weapon psprites — `R_DrawPSprite`

(r_things.c:658-752). Drawn in `R_DrawMasked` after all world sprites, so they
always appear in front. Key difference from world sprites:

- No rotation selection (always lump[0]).
- Position is lerped between `psp->oldsx`/`psp->sx` and `psp->oldsy`/`psp->sy`
  (r_things.c:686, 708).
- The `lookdir` term in `vis->texturemid` (r_things.c:709) pins the weapon at
  screen-center while the horizon shears for freelook.
- Drawn directly via `R_DrawVisSprite` with `mfloorclip = screenheightarray`,
  `mceilingclip = negonearray` — no clipping against walls.
- Invisibility: if `powers[pw_invisibility]` countdown `> 4*32` or has bit 3
  set, uses shadow draw (`colormap = NULL`).

### 6.6 `R_AddSprites` — dedup via validcount

(r_things.c:625-651). A sector can be split across multiple subsectors. The
`sec->validcount == validcount` guard (r_things.c:634) ensures each sector's
things are projected at most once per frame, even if visited from multiple
subsectors.

### 6.7 `R_DrawVisSprite` and `R_DrawMaskedColumn` — the sprite column-draw bridge

**`R_DrawVisSprite`** (r_things.c:398-445). Sets up per-sprite draw state and
drives the column loop:

```c
patch = W_CacheLumpNum(vis->patch + firstspritelump, PU_CACHE);
dc_colormap = vis->colormap;
// dispatch: NULL→fuzzcolfunc, MF_TRANSLATION→transcolfunc, else colfunc
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
colfunc = basecolfunc;   // restore from fuzz/translated dispatch
```

`frac` walks the patch's texture columns at `vis->xiscale` per screen column.
For a flipped sprite `vis->xiscale` is negative and `vis->startfrac` begins at
the rightmost column. `spryscale` and `sprtopscreen` are set here and used by
`R_DrawMaskedColumn` for vertical placement.

Psprites reuse this same path via `R_DrawPSprite` → `R_DrawVisSprite`, with a
stack-local `vissprite_t avis` instead of a pool entry and with
`mfloorclip`/`mceilingclip` set to full-screen arrays (no wall clipping).

**`R_DrawMaskedColumn`** (r_things.c:353-390). Iterates the post list of a
`column_t` patch:

```c
// post format: topdelta (1 byte), length (1 byte), data at byte offset 3
// sentinel: topdelta == 0xff ends the column
for (; column->topdelta != 0xff; ) {
    topscreen    = sprtopscreen + spryscale * column->topdelta;
    bottomscreen = topscreen    + spryscale * column->length;
    dc_yl = (topscreen    + FRACUNIT - 1) >> FRACBITS;
    dc_yh = (bottomscreen - 1)            >> FRACBITS;
    // clip to sprite's per-column floor/ceiling from R_DrawSprite:
    if (dc_yh >= mfloorclip[dc_x])  dc_yh = mfloorclip[dc_x]  - 1;
    if (dc_yl <= mceilingclip[dc_x]) dc_yl = mceilingclip[dc_x] + 1;
    if (dc_yl <= dc_yh) {
        dc_source    = (byte*)column + 3;   // data starts at byte 3
        dc_texturemid = basetexturemid - (column->topdelta << FRACBITS);
        colfunc();
    }
    column = (column_t*)((byte*)column + column->length + 4);  // advance to next post
}
```

**Post format** (`post_t` in r_defs.h:291-294):
- byte 0: `topdelta` — top pixel of this run within the column; `0xff` = end sentinel
- byte 1: `length` — number of opaque pixels in this run
- byte 2: unused padding
- bytes 3…3+length−1: palette indices (the pixel data)

`dc_source = (byte*)column + 3` points directly at the pixel data. `dc_texturemid`
is rebased per post: `basetexturemid - (topdelta << FRACBITS)` keeps the
texture coordinate continuous across transparent gaps.

**`mfloorclip[dc_x]` / `mceilingclip[dc_x]`**: per-column clip arrays filled by
`R_DrawSprite` from the drawseg silhouettes (§6.4), or set to `screenheightarray`
/ `negonearray` for unclipped draws (psprites and fuzz). These are the only
columns that can be drawn for this sprite — any pixel outside the clip range is
silently skipped.

The 128-texel wrap in `R_DrawColumn` (`& 127`) does not apply here: sprite and
masked-texture columns are drawn at their natural `length`, with `dc_texturemid`
positioning them correctly within the render window.

---

## 7. Column and span draw — r_draw.c

### 7.1 Framebuffer layout

```c
byte* ylookup[MAXHEIGHT];   // ylookup[y] = screens[0] + (y+viewwindowy)*SCREENWIDTH
int   columnofs[MAXWIDTH];  // columnofs[x] = viewwindowx + x
```

(r_draw.c:69-70, built in `R_InitBuffer` r_draw.c:694-719). The render target
is `screens[0]`, a flat `SCREENWIDTH × SCREENHEIGHT = 320 × 200` byte array
(index is palette color). `ylookup` avoids a multiply per pixel by pre-computing
row pointers. `columnofs` handles the sub-window horizontal offset.

`screens[0]` is declared in `v_video.c`; `R_FillBackScreen` uses `screens[1]`
for the status-bar border background.

### 7.2 `R_DrawColumn` — wall/sprite column draw

(r_draw.c:105-148). Inner loop for a vertical column of a wall or sprite:

```c
dest = ylookup[dc_yl] + columnofs[dc_x];
fracstep = dc_iscale;
frac = dc_texturemid + (dc_yl - centery) * fracstep;
do {
    *dest = dc_colormap[dc_source[(frac >> FRACBITS) & 127]];
    dest += SCREENWIDTH;
    frac += fracstep;
} while (count--);
```

**Key facts**:
- `dc_source` points to a 128-byte column of texture data (or sprite patch data).
- `(frac >> FRACBITS) & 127` — the `& 127` wraps at 128 texels. This is the
  texture-height wrap. All standard DOOM wall textures have heights that are
  powers of two up to 128; taller textures are composited but the column
  returned by `R_GetColumn` is always exactly `texture->height` bytes, so the
  128 wrap only matters for textures whose height is 128.
- `dc_colormap[]` is a 256-byte pointer into `colormaps[]` that applies the
  distance/light diminishment. One array lookup per pixel: this is the single
  hottest byte-access per rendered pixel.
- `dc_iscale` is the inverse scale — how many texture pixels to advance per
  screen pixel. Calculated as `0xffffffffu / (unsigned)rw_scale` (r_segs.c:276).
- Memory access pattern: random reads from `dc_source` (sequential in the
  common case of scale=1:1, but jumpy at other scales), then a random read from
  `dc_colormap` (256-byte, fits in L1 easily), then a sequential write to
  `dest` (column-stride = SCREENWIDTH = 320 bytes, which is *not* cache-
  friendly — a vertical column write skips one cache line per pixel on typical
  64-byte line hardware). This is the primary cache-miss source in the column
  draw inner loop.

**`R_DrawColumnLow`** (r_draw.c:211-253): low-detail mode (halved resolution).
`dc_x <<= 1`, writes two adjacent `dest` and `dest+1` pixels per iteration.
The comment "Hack. Does not work corretly" [sic] (r_draw.c:246) refers to a
visual artifact that was known but never fixed in vanilla.

### 7.3 `R_DrawFuzzColumn` — spectre/shadow

(r_draw.c:285-368). Draws the spectre effect: instead of `dc_source`, reads
`dest[fuzzoffset[fuzzpos]]` (a neighbor pixel from the framebuffer), then
indexes `colormaps[6*256 + neighbor]`. Map 6 out of 32 is a moderately dark
colormap (~6/32 of the way from brightest to darkest). The result is a
brightened-neighbor smear. `fuzzoffset` is a fixed 50-entry table of ±SCREENWIDTH
offsets (one row up or down). The table is pre-determined, not random —
spectre patterns are deterministic and the same every time.

`fuzzpos` is a global that advances and wraps at 50 (r_draw.c:274), shared
across all fuzz column calls in a frame.

### 7.4 `R_DrawTranslatedColumn` — player color translation

(r_draw.c:385-447). Adds one extra indirection per pixel:

```c
*dest = dc_colormap[dc_translation[dc_source[frac >> FRACBITS]]];
```

`dc_translation` is one of three 256-byte tables that remap the green palette
ramp (indices 0x70–0x7f) to gray, brown, or red for multiplayer player
distinguishing. Built in `R_InitTranslationTables` (r_draw.c:459-483):

```
for i in 0x70..0x7f:
    translationtables[i]      = 0x60 + (i & 0xf)  // gray
    translationtables[i+256]  = 0x40 + (i & 0xf)  // brown
    translationtables[i+512]  = 0x20 + (i & 0xf)  // red
all other indices: identity
```

Indices 0x60, 0x40, 0x20 are the gray, brown, and red ramp starts in PLAYPAL.
Applied only for things with `MF_TRANSLATION` flag set.

### 7.5 `R_DrawSpan` — floor/ceiling span

(r_draw.c:520-563). Horizontal span across `[ds_x1, ds_x2]` at screen row `ds_y`:

```c
dest = ylookup[ds_y] + columnofs[ds_x1];
xfrac = ds_xfrac; yfrac = ds_yfrac;
do {
    spot = ((yfrac >> (16-6)) & (63*64)) + ((xfrac >> 16) & 63);
    *dest++ = ds_colormap[ds_source[spot]];
    xfrac += ds_xstep; yfrac += ds_ystep;
} while (count--);
```

**Flat format**: `ds_source` is a 64×64 byte flat lump (4096 bytes). `spot`
indexes the flat as `y_in_texture * 64 + x_in_texture`:

```
spot = ((yfrac >> 10) & (63*64)) + ((xfrac >> 16) & 63)
     = (yfrac_top6 * 64) + xfrac_top6
```

`yfrac >> (16-6) = yfrac >> 10` extracts the top 6 bits of yfrac's integer
part shifted to column-of-64 units, then `& (63*64)` = `& 4032` keeps only
the row index times 64. `xfrac >> 16` extracts the integer part of xfrac, `& 63`
keeps 6 bits = column in 0..63.

**Memory access**: `ds_source` reads are random (angle-dependent stepping
through the 4096-byte flat). `ds_colormap` is a 256-byte sequential lookup.
`dest` writes are sequential (horizontal row). This is more cache-friendly than
the column draw: the flat fits in L1; writes are sequential.

**`R_DrawSpanLow`** (r_draw.c:643-686): low-detail mode; `ds_x1 <<= 1`, each
spot written to two adjacent pixels `*dest++` twice.

### 7.6 Column-draw function dispatch

`colfunc`, `fuzzcolfunc`, `transcolfunc`, `spanfunc` are global function
pointers (r_main.c:137-141) set in `R_ExecuteSetViewSize` (r_main.c:716-725).
High-detail: `{R_DrawColumn, R_DrawFuzzColumn, R_DrawTranslatedColumn, R_DrawSpan}`.
Low-detail: `{R_DrawColumnLow, R_DrawFuzzColumn, R_DrawTranslatedColumn, R_DrawSpanLow}`.
`R_DrawFuzzColumn` and `R_DrawTranslatedColumn` are the same in both modes (only
high-detail versions exist).

`basecolfunc` holds `R_DrawColumn` / `R_DrawColumnLow`. `R_DrawVisSprite` sets
`colfunc = fuzzcolfunc` for shadow draw, restores to `basecolfunc` after
(r_things.c:413-444).

---

## 8. Texture and data — r_data.c

### 8.1 Composite texture assembly

DOOM wall textures are defined in the `TEXTURE1`/`TEXTURE2` WAD lumps as named
lists of patches (r_data.c:69-125). At startup, `R_InitTextures` (r_data.c:411)
reads these definitions, allocates `texture_t` structs, and calls
`R_GenerateLookup` for each texture.

**`R_GenerateLookup`** (r_data.c:296-374): for each column of a texture:
- If exactly one patch covers this column, record `collump[col] = patch_lump`,
  `colofs[col] = byte_offset_in_patch`. The patch will be read directly from
  the WAD at render time.
- If more than one patch covers this column, set `collump[col] = -1` (composite
  flag), `colofs[col] = offset_into_composite_block`. The composite block size
  is accumulated in `texturecompositesize[texnum]`.

**`R_GenerateComposite`** (r_data.c:228-289): called lazily on first use of a
composite column. Allocates a Z_Zone block tagged `PU_STATIC`, fills each
composite column by calling `R_DrawColumnInCache` for each patch that overlaps
that column, then changes the tag to `PU_CACHE` (purgeable). If the zone is
under memory pressure, the composite can be freed and regenerated later.

**Zone tag semantics**: `PU_STATIC` blocks are never purged; `PU_CACHE` blocks
are purgeable. Flat data is loaded `PU_STATIC` during spans (r_plane.c:422) and
changed to `PU_CACHE` after (r_plane.c:451). This prevents the flat from being
purged mid-frame but allows reuse across frames.

### 8.2 `R_GetColumn` — column retrieval path

(r_data.c:382-401):

```c
col &= texturewidthmask[tex];   // wrap column to power-of-two width
lump = texturecolumnlump[tex][col];
ofs  = texturecolumnofs[tex][col];
if (lump > 0) return W_CacheLumpNum(lump, PU_CACHE) + ofs;  // single-patch
if (!texturecomposite[tex]) R_GenerateComposite(tex);        // lazy composite
return texturecomposite[tex] + ofs;
```

`texturewidthmask[tex]` is the next power-of-two of the texture width minus 1,
allowing bitwise column wrap (r_data.c:551-555). Textures whose width is not a
power of two are still masked to the next power of two, so the column index
wraps at that boundary. (Standard DOOM textures are always power-of-two width.)

### 8.3 Animation translation tables

`texturetranslation[i]` and `flattranslation[i]` (r_data.c:153-155) are
initialized to identity. The playsim updates them for animated textures and
flats (via `P_AnimatePictures`). `R_GetColumn` and the flat loading path always
go through these tables, so animation is transparent to the renderer.

### 8.4 Colormap initialization

`R_InitColormaps` (r_data.c:633-644): loads the `COLORMAP` WAD lump into a
256-byte-aligned Z_Zone block. The recipe for COLORMAPs is documented in
`docs/engine-archaeology.md §6`. The colormaps pointer is always loaded from
the WAD; it is never regenerated (spec.md non-goal, and PWAD-overridable).

### 8.5 Sprite lump init

`R_InitSpriteLumps` (r_data.c:603-626): reads `patch->width`, `leftoffset`,
and `topoffset` from each sprite lump header (cached `PU_CACHE` and released)
into `spritewidth[]`, `spriteoffset[]`, `spritetopoffset[]`. These are the only
sprite fields needed during projection — the full patch data is only loaded when
actually drawing.

---

## 9. Sky — r_sky.c

Sky rendering is handled inline by `R_DrawPlanes` (r_plane.c:396-419), not by
a separate sky module. The sky "texture" is a wall texture selected by episode/
map in `G_DoLoadLevel`/`R_InitSkyMap`. `skyflatnum` is a special flat index
that triggers sky treatment when used as a ceiling or floor picnum.

`r_sky.c` is nearly empty — it only initializes `skytexturemid = 100*FRACUNIT`
(r_sky.c:60) and provides `skyflatnum`, `skytexture`, `skytexturemid` as
externals. All rendering logic is in `R_DrawPlanes`.

**Sky column draw**: for each column in the sky visplane (r_plane.c:406-418):
```
angle = (viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT
dc_source = R_GetColumn(skytexture, angle)
colfunc()
```
`ANGLETOSKYSHIFT = 22` (r_sky.h:35). The sky texture is 256 columns wide and
repeats 4 times around the 360° circle (`2^32 / 2^22 = 1024` distinct angular
units, divided into 256-column segments → 4 repeats). Sky is always drawn at
full brightness (`dc_colormap = colormaps` = map 0), so invulnerability inverse
mapping does not apply (r_plane.c:404-405 — deliberate, noted in source).

Reproduce (ANGLETOSKYSHIFT): `node tools/archaeology/source-constant-verify.mjs`

**webdoom freelook**: `skytexturemid` is updated in `R_ShearView` (r_main.c:927)
to scroll the sky with the pitch. At `lookdir = 0`, `skytexturemid = 100*FRACUNIT`
(the vanilla value). Pitching up shifts `skytexturemid` upward, revealing the
upper sky texture.

`tables.c` — covered by `docs/engine-archaeology.md`. Not duplicated here.

---

## 10. Raised limits table

| limit | vanilla | webdoom | file:line | overflow: vanilla | overflow: webdoom |
|-------|---------|---------|-----------|-------------------|-------------------|
| `MAXVISPLANES` | 128 | 1024 | r_plane.c:52 | `I_Error` (hard abort) | `I_Error` (same) |
| `MAXDRAWSEGS` | 256 | 2048 | r_defs.h:55 | see below | see below |
| `MAXVISSPRITES` | 128 | 1024 | r_things.h:31 | `overflowsprite` silent | same |
| `MAXSEGS` (solidsegs) | 32 | 64 | r_bsp.c:88 | silent array overwrite | silent array overwrite |
| `MAXOPENINGS` | SCREENWIDTH×64 = 20480 | SCREENWIDTH×256 = 81920 | r_plane.c:59 | `I_Error` only in RANGECHECK build | same |

**MAXDRAWSEGS overflow detail**: `R_StoreWallRange` checks
`if (ds_p == &drawsegs[MAXDRAWSEGS]) return;` (r_segs.c:386) — it silently
skips storing the drawseg and returns without drawing. This means walls past the
limit become invisible, no crash. Same behavior in vanilla and webdoom; the
limit difference is 256 vs 2048.

**MAXVISSPRITES overflow detail**: `R_NewVisSprite` returns `&overflowsprite`
(a file-scope global, external linkage, r_things.c:328, 332) when the pool is
full. All subsequent projected sprites overwrite this one struct. The last-written
sprite is drawn once; others are silently dropped. Same behavior in vanilla and
webdoom.

**Demo-compat argument**: all five limits are strictly render-side. They govern
which walls, planes, sprites, and clips are *displayed*; nothing they protect
feeds the simulation's state machine (P_Random, actor positions, line triggers).
Raising them cannot change what `G_Ticker` computes, so golden demo traces
remain tic-identical. Verified by inspection: none of the overflow paths touch
`gametic`, `P_Random`, or any `mobj_t` field used by the sim.

Reproduce (raised-limits table): `node tools/archaeology/source-constant-verify.mjs`

---

## 11. Per-stage performance mapping

Stage timing is from `tools/golden/bench-baseline.json` (commit 16c3354,
2026-07-15). Values are averages across the three doom.wad attract demos
on all four fleet hosts (tank perStage data added at 16c3354 — all four
hosts are now coherent; see `docs/perf.md §The optimization queue`).

| stage | doc section | alder (ms/frame) | tank (ms/frame) | pi5 (ms/frame) | wbox (ms/frame) |
|-------|-------------|-----------------|----------------|----------------|----------------|
| frame-setup+clears | §2 | ~0.001 | ~0.001 | ~0.002 | ~0.007 |
| bsp+segs | §3, §4 | ~0.048 | ~0.055 | ~0.072 | ~0.263 |
| planes | §5 | ~0.033 | ~0.039 | ~0.049 | ~0.157 |
| masked | §6 | ~0.016 | ~0.018 | ~0.021 | ~0.064 |
| sim (per tic, not per frame) | (playsim doc) | ~0.014 | ~0.016 | ~0.017 | ~0.071 |

BSP+segs dominates on all four hosts. On wbox, bsp+segs alone is 0.263 ms,
planes 0.157 ms, masked 0.064 ms — sum 0.490 ms/frame render cost. At 35 Hz
(28.57 ms budget) the render sum is 0.490 ms = 1.7% of budget, leaving ~98%
for the JS/browser pipeline (UNMEASURED; see perf.md §The optimization queue §B).
wbox's sim is 0.071 ms/tic = 0.25% of budget. Tank render (0.118 ms/frame) is
only 1.15× alder — the rank ordering is the same on all hosts:
bsp+segs > planes > masked. Cache-unfriendly column writes (§7.2) dominate.

Task 2.1 will rank optimization targets more precisely; task 2.2 targets
column/span inner loops (§7); task 2.3 targets visplane management (§5.2).

---

## 12. Cross-cutting invariants

1. **front-to-back BSP order** drives the solidsegs clipper. The BSP ensures
   the front child is always fully in front of the back child at any node — this
   is the geometric guarantee that makes the clipper correct. If two segs at the
   same node have equal depth, one is arbitrarily chosen as front; the clipping
   may produce a minor visual artifact but no crash.

2. **`validcount`** is incremented once per frame by `R_SetupFrame`
   (r_main.c:887). Any struct that tracks "was I processed this frame?"
   (`sector_t`, `line_t`) compares its own `validcount` field to the global.
   This avoids double-processing without allocating per-frame clear buffers.

3. **`floorclip[x]` / `ceilingclip[x]`** are the only per-column state that
   propagates between segs in the BSP walk. They start at `viewheight` and `-1`
   respectively and narrow as solid walls are drawn. Span collection depends on
   these being correct at each column before `R_RenderSegLoop` writes
   `floorplane->top[x]` / `ceilingplane->top[x]`.

4. **`openings[]` is frame-scoped**: allocated from `lastopening = openings` at
   `R_ClearPlanes` and filled incrementally during the BSP walk. The pointers
   stored in `drawseg_t.sprtopclip` etc. remain valid for the whole frame.
   They become invalid next frame when `lastopening` is reset.

5. **Texture column pointers** from `R_GetColumn` must not be held across WAD
   cache evictions. In practice, a single-frame wall draw completes before any
   cache pressure frees the lump. Composite textures are `PU_CACHE` tagged after
   generation but are only freed on zone pressure, not on frame boundaries.

6. **Sky visplane** is the only visplane that does not use floor/ceiling span
   mechanics. Its `top[]`/`bottom[]` arrays are filled by `R_RenderSegLoop`
   just like other planes, but `R_DrawPlanes` handles it with a column draw
   loop, not `R_MakeSpans` (r_plane.c:396-419).

---

## 13. Open questions for task 1.4

1. **`DISTMAP = 2` and `LIGHTZSHIFT = 20` rationale**: the exact parameter
   choices for the zlight/scalelight recipes (§2.3) are clear in structure but
   the specific constant values (why 2, why 20?) are not documented. A numerical
   comparison against the DOS binary's lighting tables would confirm whether
   these produce bit-identical colormap index sequences or are close approximations.

2. **`checkcoord[12][4]` table**: the 12-entry bounding-box corner selection
   table (r_bsp.c:365-378) is correct by inspection for the nine non-degenerate
   viewpoint positions, but the specific index packing
   `boxpos = (boxy<<2)+boxx` is undocumented in the source. A diagram verifying
   all 9 cases (one of which, `boxpos==5`, is the "inside" case) would be clean
   confirmation.
