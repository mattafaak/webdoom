# webdoom data-format reference

Every external byte this engine reads or writes, mapped field by field. The
**reimplementation test** is the DoD: a competent developer with only this
document must be able to write a parser that works on real files.

Source authority is the reader/writer code in this repository. Where our
engine differs from the wider "vanilla Doom" family, the difference is noted
explicitly.

Quantitative claims are enumerated in `docs/claims-index.md`. Run
`bash tools/archaeology/verify-all.sh` to cross-check all figures; CI
enforces it. WAD-data figures are verified by
`node tools/archaeology/wad-verify.mjs`; source-code constants by
`node tools/archaeology/source-constant-verify.mjs`. Derived figures
(arithmetic from other claims) are noted inline.

---

## Table of contents

1. [WAD container](#1-wad-container)
2. [Map lumps](#2-map-lumps)
3. [Graphics lumps](#3-graphics-lumps)
4. [Demo format](#4-demo-format)
5. [Savegame format](#5-savegame-format)
6. [DMX sound effects](#6-dmx-sound-effects)
7. [MUS music](#7-mus-music)
8. [GENMIDI instrument bank](#8-genmidi-instrument-bank)
9. [Config / defaults](#9-config--defaults)
10. [Network wire format](#10-network-wire-format)
11. [Endianness and alignment doctrine](#11-endianness-and-alignment-doctrine)

---

## 1. WAD container

Source: `engine/core/w_wad.c`, `engine/core/w_wad.h`

### 1.1 File header (`wadinfo_t`)

| Offset | Size | Type | Meaning |
|--------|------|------|---------|
| 0 | 4 | `char[4]` | Magic: `IWAD` or `PWAD` |
| 4 | 4 | `int32 LE` | `numlumps` — number of directory entries |
| 8 | 4 | `int32 LE` | `infotableofs` — byte offset of directory from file start |

**IWAD vs. PWAD**: the engine accepts both (w_wad.c:178-188). The
distinction is purely semantic: an IWAD is the base game data; a PWAD
supplements it. For the engine's lump lookup they are treated identically.
Any file whose first 4 bytes are neither `IWAD` nor `PWAD` is rejected with
`I_Error`.

### 1.2 Directory entry (`filelump_t`)

Each entry is 16 bytes. The directory begins at `infotableofs`.

| Offset | Size | Type | Meaning |
|--------|------|------|---------|
| 0 | 4 | `int32 LE` | `filepos` — byte offset of lump data in the WAD |
| 4 | 4 | `int32 LE` | `size` — byte length of lump data |
| 8 | 8 | `char[8]` | `name` — NUL-padded, uppercase ASCII, no extension |

**Name padding rules**: the name field is exactly 8 bytes. If the lump name
is shorter than 8 characters, trailing bytes are `\0`. The engine pads with
zeros when loading (`memset(dest, 0, 8)` in `ExtractFileBase`, w_wad.c:106)
and compares as two `int`-width words (w_wad.c:325-328), so padding bytes must
be `\0`.

**Lump lookup semantics** (`W_CheckNumForName`, w_wad.c:295): the directory
is scanned **backwards** (`lump_p` starts at `lumpinfo + numlumps` and
decrements). The first match found (i.e., the last entry in the directory
with that name) is returned. **Last-wins**: a PWAD loaded after the IWAD
overrides the IWAD lump of the same name.

Name comparison is case-insensitive via `w_strupr` (w_wad.c:70-73); the
engine upcases the query string before comparing.

### 1.3 Internal lump descriptor (`lumpinfo_t`)

After WAD loading, each lump is described in memory by:

```c
typedef struct {
    char  name[8];
    int   handle;    // webdoom: pointer cast to int, points into in-heap WAD data
    int   position;  // always 0 in webdoom (unused)
    int   size;
} lumpinfo_t;
```

In **webdoom**, `handle` is `(int)(data + LONG(fileinfo->filepos))` — a
direct pointer into the WAD data buffer registered by JS before startup
(w_wad.c:200-201). There is no filesystem; WADs live in the heap. Single-file
lumps (non-WAD, e.g. a `.lmp` demo) use `filepos=0` and `size=length`.

### 1.4 Content-hash caching scheme

`tools/wad-identify.mjs` generates `wads/manifest.json`. Each entry carries:
- `sha256`: SHA-256 hex digest of the entire WAD file
- `size`: file size in bytes
- `file`: canonical filename (lowercased)

The client (`client/js/main.js:35-36`) fetches WADs as `/wads/<file>?v=<first8>` where
`<first8>` is the first 8 hex characters of the SHA-256. The service worker
(`client/sw.js:31-39`) caches WAD responses by full URL (including the query
string), making them immutable and usable offline. Identity = SHA-256 of the
entire file, not a content checksum of individual lumps.

---

## 2. Map lumps

Source: `engine/core/doomdata.h`, `engine/core/p_setup.c`

A map occupies a run of 11 lumps. The first lump is a marker (zero-size) with
the map name (`E1M1`, `MAP01`, etc.). The subsequent 10 lumps follow in fixed
order (from `doomdata.h:43-56`):

| Index | Constant | Lump name |
|-------|----------|-----------|
| 0 | `ML_LABEL` | Map marker (zero size) |
| 1 | `ML_THINGS` | THINGS |
| 2 | `ML_LINEDEFS` | LINEDEFS |
| 3 | `ML_SIDEDEFS` | SIDEDEFS |
| 4 | `ML_VERTEXES` | VERTEXES |
| 5 | `ML_SEGS` | SEGS |
| 6 | `ML_SSECTORS` | SSECTORS |
| 7 | `ML_NODES` | NODES |
| 8 | `ML_SECTORS` | SECTORS |
| 9 | `ML_REJECT` | REJECT |
| 10 | `ML_BLOCKMAP` | BLOCKMAP |

The engine loads them as `W_GetNumForName(mapname) + ML_*` (p_setup.c:651-661).

**Fixed-point convention**: all map coordinates in the lumps are `int16` (map
units). The engine scales them to `fixed_t` by left-shifting 16 bits
(`<<FRACBITS`). 1 map unit = 65536 (0x10000) in fixed-point.

### 2.1 THINGS (`mapthing_t`, 10 bytes each)

```
count = lump_size / 10
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `x` — map X position |
| 2 | 2 | `int16 LE` | `y` — map Y position |
| 4 | 2 | `int16 LE` | `angle` — facing angle in degrees (0=east, CCW) |
| 6 | 2 | `int16 LE` | `type` — DoomEd type number |
| 8 | 2 | `int16 LE` | `options` — spawn flags bitmask |

All fields read with `SHORT()` (p_setup.c:342-346). x/y are NOT shifted to
fixed-point here; `P_SpawnMapThing` uses them as map-unit integers.

`options` bit meanings: bit 0=skill 1-2, bit 1=skill 3, bit 2=skill 4-5,
bit 3=ambush (deaf), bit 4=multiplayer-only.

### 2.2 LINEDEFS (`maplinedef_t`, 14 bytes each)

```
count = lump_size / 14
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `v1` — start vertex index |
| 2 | 2 | `int16 LE` | `v2` — end vertex index |
| 4 | 2 | `int16 LE` | `flags` — attribute bits |
| 6 | 2 | `int16 LE` | `special` — line special action |
| 8 | 2 | `int16 LE` | `tag` — sector tag |
| 10 | 2 | `int16 LE` | `sidenum[0]` — front sidedef index |
| 12 | 2 | `int16 LE` | `sidenum[1]` — back sidedef index, -1 if one-sided |

Source: doomdata.h:85-93, p_setup.c:375-431. `sidenum[1] == -1` means
one-sided line.

**Flag bits** (doomdata.h:101-136):

| Bit | Constant | Meaning |
|-----|----------|---------|
| 0x001 | `ML_BLOCKING` | Solid, blocks movement |
| 0x002 | `ML_BLOCKMONSTERS` | Blocks monsters only |
| 0x004 | `ML_TWOSIDED` | Has back sidedef |
| 0x008 | `ML_DONTPEGTOP` | Upper texture unpegged |
| 0x010 | `ML_DONTPEGBOTTOM` | Lower texture unpegged |
| 0x020 | `ML_SECRET` | Drawn as 1-sided on automap |
| 0x040 | `ML_SOUNDBLOCK` | Blocks sound propagation |
| 0x080 | `ML_DONTDRAW` | Never shown on automap |
| 0x100 | `ML_MAPPED` | Already seen on automap |

### 2.3 SIDEDEFS (`mapsidedef_t`, 30 bytes each)

```
count = lump_size / 30
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `textureoffset` — horizontal texture offset (map units) |
| 2 | 2 | `int16 LE` | `rowoffset` — vertical texture offset (map units) |
| 4 | 8 | `char[8]` | `toptexture` — NUL-padded name, `-` means none |
| 12 | 8 | `char[8]` | `bottomtexture` |
| 20 | 8 | `char[8]` | `midtexture` |
| 28 | 2 | `int16 LE` | `sector` — sector index this face belongs to |

Source: doomdata.h:69-78, p_setup.c:455-462. `textureoffset` and `rowoffset`
are scaled to fixed-point on load (`<<FRACBITS`, p_setup.c:456-457).

### 2.4 VERTEXES (`mapvertex_t`, 4 bytes each)

```
count = lump_size / 4
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `x` |
| 2 | 2 | `int16 LE` | `y` |

Loaded with `SHORT(ml->x) << FRACBITS` (p_setup.c:146-147). Internal
`vertex_t.x/y` are `fixed_t`.

### 2.5 SEGS (`mapseg_t`, 12 bytes each)

```
count = lump_size / 12
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `v1` — start vertex index |
| 2 | 2 | `int16 LE` | `v2` — end vertex index |
| 4 | 2 | `int16 LE` | `angle` — direction in BAM units (binary angle measure) |
| 6 | 2 | `int16 LE` | `linedef` — parent linedef index |
| 8 | 2 | `int16 LE` | `side` — 0=front, 1=back |
| 10 | 2 | `int16 LE` | `offset` — distance along linedef to seg start (map units) |

`angle` and `offset` are shifted left 16 bits on load (`<<16`,
p_setup.c:181-182). All other fields read with `SHORT()`.

### 2.6 SSECTORS (`mapsubsector_t`, 4 bytes each)

```
count = lump_size / 4
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `numsegs` |
| 2 | 2 | `int16 LE` | `firstseg` — index into SEGS array |

Source: doomdata.h:152-158, p_setup.c:217-221.

### 2.7 NODES (`mapnode_t`, 28 bytes each)

```
count = lump_size / 28
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `x` — partition line origin X |
| 2 | 2 | `int16 LE` | `y` — partition line origin Y |
| 4 | 2 | `int16 LE` | `dx` — partition line delta X |
| 6 | 2 | `int16 LE` | `dy` — partition line delta Y |
| 8 | 16 | `int16[2][4] LE` | `bbox[2][4]` — bounding boxes for right then left subtree (top, bottom, left, right order) |
| 24 | 2 | `uint16 LE` | `children[0]` — right child |
| 26 | 2 | `uint16 LE` | `children[1]` — left child |

Source: doomdata.h:180-196, p_setup.c:284-294.

**NF_SUBSECTOR bit** (`#define NF_SUBSECTOR 0x8000`, doomdata.h:178): if
bit 15 of a `children[]` value is set, the child is a subsector; the actual
index is `children[i] & 0x7FFF`.

**Verification** (checked against `wads/lib/doom.wad` E1M1):

```bash
python3 -c "
import struct
data = open('wads/lib/doom.wad','rb').read()
n,d = struct.unpack_from('<ii',data,4)
# scan to E1M1 NODES lump
for i in range(n):
    fp,sz = struct.unpack_from('<ii',data,d+i*16)
    nm = data[d+i*16+8:d+i*16+16].rstrip(b'\\x00').decode()
    if nm=='NODES' and i>0 and data[d+(i-8)*16+8:d+(i-8)*16+10]==b'E1':
        print(f'nodes={sz//28}')
        # first node: both children are subsectors
        c0,c1 = struct.unpack_from('<HH',data,fp+24)
        print(f'node[0] children: 0x{c0:04x}(ss={c0>>15}) 0x{c1:04x}(ss={c1>>15})')
        break
"
# Result: node[0] children: 0x8000(ss=1) 0x8001(ss=1)
```

E1M1 node[0]: both children have NF_SUBSECTOR set (subsector indices 0 and 1).
E1M1 has 238 nodes; 239 of 476 child references point to subsectors.

x/y/dx/dy are shifted `<<FRACBITS` on load (p_setup.c:284-287). `bbox`
values are also shifted `<<FRACBITS` (p_setup.c:291-292).

### 2.8 SECTORS (`mapsector_t`, 26 bytes each)

```
count = lump_size / 26
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `floorheight` |
| 2 | 2 | `int16 LE` | `ceilingheight` |
| 4 | 8 | `char[8]` | `floorpic` — flat name, NUL-padded |
| 12 | 8 | `char[8]` | `ceilingpic` |
| 20 | 2 | `int16 LE` | `lightlevel` (0..255) |
| 22 | 2 | `int16 LE` | `special` — sector effect type |
| 24 | 2 | `int16 LE` | `tag` |

Source: doomdata.h:141-150, p_setup.c:245-256. `floorheight` and
`ceilingheight` are shifted `<<FRACBITS`. webdoom also saves
`oldfloorheight`/`oldceilingheight` snapshots to prevent interpolation streaks
after level load (p_setup.c:249-250).

### 2.9 REJECT

A packed bitfield: one bit per sector pair.

```
size = ceil(numsectors * numsectors / 8)  bytes
```

Bit `(s1 * numsectors + s2)` is set if sector `s1` can never see sector `s2`
(enemy AI shortcut). `p_sight.c:315-320`:

```c
pnum = s1 * numsectors + s2;
bytenum = pnum >> 3;
bitnum = 1 << (pnum & 7);
if (rejectmatrix[bytenum] & bitnum) return false;
```

Loaded raw with no byte-swapping (`W_CacheLumpNum`, p_setup.c:661). The lump
is a flat array of bytes; bit 0 of byte 0 = pair (0, 0).

**Verification**: E1M1 has 88 sectors; REJECT is `ceil(88*88/8) = 968 bytes` ✓
(confirmed in `wads/lib/doom.wad`).

### 2.10 BLOCKMAP

A 2-D grid of linked lists of linedef indices for collision detection.

**Header** (4 × `int16 LE`):

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `orgx` — map X of grid origin |
| 2 | 2 | `int16 LE` | `orgy` — map Y of grid origin |
| 4 | 2 | `int16 LE` | `bmapwidth` — grid columns |
| 6 | 2 | `int16 LE` | `bmapheight` — grid rows |

**Offset table**: `bmapwidth * bmapheight` × `int16 LE`, starting at byte 8.
Each entry is a byte offset (from the start of the lump, in units of 2 bytes)
to the head of that block's linedef list.

**Linedef lists**: each list starts at the pointed-to offset (as a `short*`
into `blockmaplump`). The first `short` in each list is always **0**
(historical artifact from the original BSP tools), then linedef indices follow,
then **0xFFFF** (-1 as signed int16) marks the end.

Source: p_setup.c:476-491. The entire lump is byte-swapped in-place:
`blockmaplump[i] = SHORT(blockmaplump[i])` for all `count = lump_size/2`
shorts (p_setup.c:480-481). `blockmap = blockmaplump + 4` (skips the 4-short
header).

**0xFFFF/-1 ambiguity**: the on-disk value is `0xFFFF`. The engine reads it
as a `short` (signed 16-bit), making the terminator -1 in C. Both `0xFFFF`
and `-1` are the same bit pattern; treat it as an unsigned 16-bit sentinel
when parsing.

**Verification** (E1M1): orgx=-776, orgy=-4872, width=36, height=23, 828
offset-table entries, 828 matching 0xFFFF terminators.

---

## 3. Graphics lumps

Source: `engine/core/r_defs.h`, `engine/core/r_data.c`, `engine/core/v_video.c`

### 3.1 patch_t — column/post format

Used for sprites, HUD graphics, menu graphics, and patches composited into
textures.

**patch header** (r_defs.h:361-369):

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `width` — bounding box width in pixels |
| 2 | 2 | `int16 LE` | `height` — bounding box height |
| 4 | 2 | `int16 LE` | `leftoffset` — pixels to the left of the sprite origin |
| 6 | 2 | `int16 LE` | `topoffset` — pixels below the sprite origin |
| 8 | 4×width | `int32 LE[]` | `columnofs[width]` — byte offsets from patch start to each column |

`columnofs` is actually declared as `int columnofs[8]` in the struct but
only `[width]` elements are used (the struct is a variable-size header).
Each offset points to a column's post list within the same lump.

**column / post_t** (r_defs.h:289-297):

A column is a list of zero or more posts (runs of opaque pixels), terminated
by a post with `topdelta == 0xFF`:

```
post_t {
    uint8  topdelta;   // row index from top where this run begins; 0xFF = end
    uint8  length;     // number of pixel bytes in this run
    // implied:
    uint8  unused;     // padding byte before data (not read by engine)
    uint8  data[length];
    uint8  unused;     // padding byte after data (not read by engine)
}
```

Source: r_data.c:198-216. The engine reads:
```c
while (patch->topdelta != 0xff) {
    source = (byte *)patch + 3;     // data starts 3 bytes into post_t
    ...
    patch = (column_t *)((byte *)patch + patch->length + 4);
}
```
So the layout per post is: `[topdelta][length][unused][data...][unused]` = 4 +
length bytes total. The two unused bytes are traditionally 0 but are not
checked.

**Tall-patch support**: this engine is vanilla. `topdelta` is `uint8`, capping
any column at 254 pixels. The ZDoom "tall patch" extension (stacking posts with
`topdelta <= previous_topdelta` for cumulative delta) is **not implemented**.
Any patch taller than 254 pixels will be silently clipped or misrendered.

### 3.2 Flats

64×64-pixel floor/ceiling images stored as raw 4096 bytes of palette indices
(no header). Row-major, left-to-right, top-to-bottom. One byte = one palette
entry. Enclosed between `F_START`/`F_END` (or `FF_START`/`FF_END`) marker
lumps in the WAD directory.

**Verification**: all flats in `doom.wad` are exactly 4096 bytes (confirmed by
scanning F_START..F_END lumps).

### 3.3 PLAYPAL

14 palettes × 768 bytes = 10752 bytes total (doom.wad verified).

Each palette: 256 RGB triples in row order:

| Offset in palette | Size | Meaning |
|-------------------|------|---------|
| 0 | 1 | Red (0..255) |
| 1 | 1 | Green |
| 2 | 1 | Blue |

Palette 0 is the standard palette. Palettes 1-8 are progressively red
(damage), 9-12 are yellow/gold (bonus pickup), 13 is green (radiation suit).
The engine uses `PLAYPAL` lump via `W_CacheLumpName("PLAYPAL", PU_CACHE)`.

### 3.4 COLORMAP

34 tables × 256 bytes = 8704 bytes (doom.wad verified). See also
`docs/engine-archaeology.md §6` and `docs/renderer.md §2.3`.

Each table maps a palette index to a darker palette index. Table 0 = full
brightness; table 31 = near-black. Tables 32 and 33 are special: table 32 is
the invulnerability sphere colormap (all-grey), table 33 repeats the source
(used for powerup-flash effect). The engine loads COLORMAP raw and stores the
pointer in `colormaps` (r_data.c:633-644).

### 3.5 PNAMES

Patch name table. Used by TEXTURE1/TEXTURE2 to reference patches by index.

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | `uint32 LE` | `count` — number of patch name entries |
| 4 | count×8 | `char[8][]` | NUL-padded patch lump names |

Source: r_data.c:415-. Total lump size = `4 + count * 8`. In doom.wad:
count=351, size=2812=4+351×8 ✓.

### 3.6 TEXTURE1 / TEXTURE2

Composite wall texture definitions.

**Header**:

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | `uint32 LE` | `numtextures` |
| 4 | numtextures×4 | `int32 LE[]` | Byte offsets from lump start to each `maptexture_t` |

**`maptexture_t`** (r_data.c:84-93):

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 8 | `char[8]` | `name` — texture name, NUL-padded |
| 8 | 4 | `int32 LE` | `masked` (boolean, legacy) |
| 12 | 2 | `int16 LE` | `width` in pixels |
| 14 | 2 | `int16 LE` | `height` in pixels |
| 16 | 4 | `int32 LE` | `columndirectory` — **obsolete**, always 0, not used |
| 20 | 2 | `int16 LE` | `patchcount` — number of patches composited |
| 22 | patchcount×10 | `mappatch_t[]` | Patch descriptors |

**`mappatch_t`** (r_data.c:69-76), 10 bytes each:

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `originx` — patch placement X (may be negative) |
| 2 | 2 | `int16 LE` | `originy` — patch placement Y |
| 4 | 2 | `int16 LE` | `patch` — index into PNAMES |
| 6 | 2 | `int16 LE` | `stepdir` — not used by our engine (legacy) |
| 8 | 2 | `int16 LE` | `colormap` — not used by our engine (legacy) |

Source: r_data.c:411-551. Textures are composited lazily on first use by
`R_GenerateComposite`.

### 3.7 ENDOOM

`ENDOOM` is an 80×25 text-mode screen: 4000 bytes of EGA character+attribute
pairs (character byte, then attribute byte, 80 columns × 25 rows). **This
engine does not read ENDOOM**. A grep of the entire `engine/` tree for
`ENDOOM` returns zero matches; there is no finale terminal screen in webdoom.

---

## 4. Demo format

Source: `engine/core/g_game.c`, lines 1508-1703.

Demos are WAD lumps named `DEMO1`–`DEMO4` (or free-standing `.lmp` files).

### 4.1 Header

| Byte | Field | Values |
|------|-------|--------|
| 0 | version | 109 or 110; engine writes `VERSION=110` (doomdef.h:33) but accepts 109 (g_game.c:1612) |
| 1 | skill | 0=ITYTD, 1=HMP, 2=UV, 3=Nightmare |
| 2 | episode | 1-4 (Doom 1) or 1 (Doom 2/TNT/Plutonia) |
| 3 | map | 1-9 (Doom 1 episodes) or 1-32 (Doom 2) |
| 4 | deathmatch | 0=cooperative/SP, 1=deathmatch |
| 5 | respawnparm | 1=monsters respawn |
| 6 | fastparm | 1=fast monsters |
| 7 | nomonsters | 1=no monsters spawned |
| 8 | consoleplayer | 0-3, which player recorded this |
| 9 | playeringame[0] | 1=player 0 active |
| 10 | playeringame[1] | 1=player 1 active |
| 11 | playeringame[2] | 1=player 2 active |
| 12 | playeringame[3] | 1=player 3 active |

Header total: 13 bytes.

### 4.2 Tic data

After the 13-byte header: a sequence of 4-byte records, one per game tic per
active player, interleaved (all players for tic 0, then tic 1, …):

| Byte | Field | Encoding |
|------|-------|----------|
| 0 | `forwardmove` | `int8` (signed), read directly (`g_game.c:1519`) |
| 1 | `sidemove` | `int8` (signed), read directly |
| 2 | `angleturn` | `uint8`, stored as `(cmd->angleturn + 128) >> 8`; read back as `((uint8)*p++) << 8` |
| 3 | `buttons` | `uint8` bit field |

**Note on `angleturn` encoding**: the full `angleturn` field is `int16`. The
demo stores only the high byte, bias-encoded: write `(angleturn+128)>>8`,
read back `(uint8)<<8`. The resolution is 256 BAM units per step; all
angleturn values are rounded to the nearest 256. This is vanilla behavior,
not a webdoom change.

**Demo terminator**: the single byte `0x80` (`DEMOMARKER`, g_game.c:1508)
signals the end of tic data. The terminator is detected in `G_ReadDemoTiccmd`
before any tic bytes are consumed (g_game.c:1513).

### 4.3 On-disk ticcmd vs. in-memory `ticcmd_t`

The **demo 4-byte format** is a lossy compressed subset of the full
`ticcmd_t` struct (`d_ticcmd.h`):

```c
typedef struct {
    char  forwardmove;   // same as demo byte 0
    char  sidemove;      // same as demo byte 1
    short angleturn;     // demo stores only high 8 bits + bias
    short consistancy;   // NOT in demo
    byte  chatchar;      // NOT in demo
    byte  buttons;       // same as demo byte 3
} ticcmd_t;             // 8 bytes in memory
```

The demo format encodes 4 fields; `consistancy` and `chatchar` are never
written to or read from demo files.

See §10 for the **network 8-byte format** (ticcmd_t sent in full over the
wire, no compression).

### 4.4 Golden demo headers (verified)

All IWADs in `wads/lib/` use **version 109** in their built-in demos,
regardless of what game version produced the rest of the data. The engine
writes VERSION=110 when recording new demos but reads both.

**doom.wad** (The Ultimate Doom):

| Lump | ver | skill | ep | map | deathmatch | players |
|------|-----|-------|----|-----|------------|---------|
| DEMO1 | 109 | 3 | 1 | 5 | 0 | [1,0,0,0] |
| DEMO2 | 109 | 3 | 2 | 2 | 0 | [1,0,0,0] |
| DEMO3 | 109 | 3 | 3 | 5 | 0 | [1,0,0,0] |
| DEMO4 | 109 | 3 | 4 | 2 | 0 | [1,0,0,0] |

**doom2.wad** (Doom II):

| Lump | ver | skill | ep | map | deathmatch | players |
|------|-----|-------|----|-----|------------|---------|
| DEMO1 | 109 | 3 | 1 | 11 | 0 | [1,0,0,0] |
| DEMO2 | 109 | 3 | 1 | 5 | 0 | [1,0,0,0] |
| DEMO3 | 109 | 3 | 1 | 26 | 0 | [1,0,0,0] |

**tnt.wad** (Final Doom: TNT):

| Lump | ver | skill | ep | map |
|------|-----|-------|----|-----|
| DEMO1 | 109 | 3 | 1 | 1 |
| DEMO2 | 109 | 3 | 1 | 12 |
| DEMO3 | 109 | 3 | 1 | 13 |

**plutonia.wad** (Final Doom: Plutonia):

| Lump | ver | skill | ep | map |
|------|-----|-------|----|-----|
| DEMO1 | 109 | 3 | 1 | 17 |
| DEMO2 | 109 | 3 | 1 | 10 |
| DEMO3 | 109 | 3 | 1 | 12 |

`ep` field is always 1 for Doom 2-engine games (doom2.wad, tnt.wad,
plutonia.wad); the map number is the full `MAP##` index. skill=3 is UV.

---

## 5. Savegame format

Source: `engine/core/g_game.c` (I/O wrappers), `engine/core/p_saveg.c`
(archive routines). See also `docs/playsim.md §13` for the archive call
sequence and pointer serialization protocol.

**webdoom-specific**: the version string in our savegames is `"webdm2 110"`,
not the vanilla `"version 110"` (g_game.c:1229, 1303). Vanilla saves are not
compatible.

### 5.1 Layout

```
[0..23]       description (24 bytes, SAVESTRINGSIZE, NUL-padded text)
[24..39]      version string (16 bytes, VERSIONSIZE, NUL-padded)
              — must equal "webdm2 110" (VERSION=110)
[40]          gameskill (byte)
[41]          gameepisode (byte)
[42]          gamemap (byte)
[43..46]      playeringame[0..3] (4 bytes)
[47]          leveltime >> 16 (byte)
[48]          leveltime >> 8  (byte)
[49]          leveltime & 0xFF (byte)
              — P_ArchivePlayers (g_game.c:1316)
[aligned]     per-player player_t structs (4-byte aligned, PADSAVEP())
              — P_ArchiveWorld (g_game.c:1317)
[...]         sector data: per-sector 7 × int16 (floor, ceiling, floorpic,
              ceilingpic, lightlevel, special, tag)
[...]         linedef data: per-linedef (flags, special, tag), then per
              active sidedef (textureoffset, rowoffset, toptexture,
              bottomtexture, midtexture) as int16 (p_saveg.c:127-156)
              — P_ArchiveThinkers (g_game.c:1318)
[...]         tc_mobj (byte 0=tc_mobj, then 4-byte aligned mobj_t) or
              tc_end (byte 0=tc_end)
              — P_ArchiveSpecials (g_game.c:1319)
[...]         special thinkers: tc_ceiling, tc_door, tc_floor, tc_plat,
              tc_flash, tc_strobe, tc_glow, tc_endspecials
              (p_saveg.c:336-346)
[last byte]   0x1d (consistency marker)
```

### 5.2 Thinker archive protocol

`tc_*` byte values (p_saveg.c:222-227, 336-346):

| Value | Constant | Meaning |
|-------|----------|---------|
| 0 | `tc_end` | End of list |
| 1 | `tc_mobj` | Mobile object (mobj_t) |
| 0 | `tc_ceiling` | Ceiling thinker (special list) |
| 1 | `tc_door` | Door thinker |
| 2 | `tc_floor` | Floor-move thinker |
| 3 | `tc_plat` | Platform thinker |
| 4 | `tc_flash` | Light-flash thinker |
| 5 | `tc_strobe` | Light-strobe thinker |
| 6 | `tc_glow` | Glow thinker |
| 7 | `tc_endspecials` | End of specials list |

**Note**: `tc_end`=0 and `tc_ceiling`=0 are the same numeric value, but
they belong to separate enum namespaces and separate list positions in the
file (mobj list first, specials list second).

Each thinker record: 1 byte type, then `PADSAVEP()` alignment to 4-byte
boundary, then the raw struct `memcpy`'d verbatim. Pointers within the
struct are serialized as integer indices:
- `mobj->state` → `(state - states)` index
- `mobj->player` → `(player - players) + 1` (1-based; 0=no player)
- sector pointers in special thinkers → `(sector - sectors)` index

### 5.3 SAVEGAMESIZE bound

`#define SAVEGAMESIZE 0x80000` (g_game.c:74) = **512 KB**. Vanilla was
0x2C000 = 180 KB; this was raised because large maps overran the original
limit. If the save exceeds this on write, the engine calls `I_Error`.

Saves are stored via `Web_FileWrite(".doomrc", ...)` → `Module.fileMap` →
IndexedDB (`client/js/persist.js`). Filename pattern: `doomsav0.dsg` through
`doomsav5.dsg` (6 slots, g_game.c:1295).

---

## 6. DMX sound effects

Source: `engine/web/i_sound.c`, client-side audio.js (WebAudio decoding)

SFX lumps are named `DS<name>` (e.g. `DSPISTOL`, `DSSHOTGN`). The engine
looks up `"ds" + sfx->name` via `W_CheckNumForName` (i_sound.c:52). Returns
-1 (no error) if absent; total-conversion WADs may omit some sounds.

### 6.1 Header (8 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `uint16 LE` | `format_id` — must be **3** |
| 2 | 2 | `uint16 LE` | `sample_rate` — Hz (typically 11025) |
| 4 | 4 | `uint32 LE` | `num_samples` — total byte count of the PCM region (includes 16-byte lead-in + real samples + 16-byte lead-out pads) |

**Lump total size** = `8 + num_samples` bytes.

### 6.2 PCM data layout (bytes 8 .. 8+num_samples-1)

The `num_samples` bytes are structured as three sub-regions
(`client/js/audio.js:57-64`):

| Sub-region | Offset | Size | Content |
|------------|--------|------|---------|
| Lead-in pad | 8 | 16 bytes | Duplicate of first real sample value |
| Real PCM | 24 | `num_samples - 32` bytes | Actual audio |
| Lead-out pad | `24 + (num_samples-32)` | 16 bytes | Duplicate of last real sample value |

Real sample count = `num_samples - 32`. The consumer (`audio.js:60,64`):

```js
const n = (num_samples >>> 0) - 32;
for (let i = 0; i < n; i++) ch[i] = (bytes[24 + i] - 128) / 128;
```

Raw unsigned 8-bit samples. 128 (0x80) = silence (center voltage). Values
0..127 = negative half-cycle, 129..255 = positive.

**Why pads exist**: the DMX driver accessed sample data with a 16-sample
read-ahead; the pads prevent reading off the end of the buffer. Pad values
duplicate the edge sample so the fade-in/out is seamless.

### 6.3 WebAudio resample path

The engine hands the entire lump (`data`, `len`) to JS via `js_sfx_start`
(i_sound.c:71). `client/js/audio.js` decodes this once per lump using
`AudioContext.decodeAudioData` with a constructed WAV wrapper around the raw
PCM. Resampling to the output sample rate (44100 Hz or device rate) is done
by the browser's audio engine. Volume, stereo separation, and pitch modulation
are applied per-channel at play time.

---

## 7. MUS music

Source: `engine/web/mus_opl.c` — the `mus_play` function and event loop.

### 7.1 Header (16 bytes + instrument list)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | `char[4]` | Magic: `MUS\x1a` (0x4d, 0x55, 0x53, 0x1a) |
| 4 | 2 | `uint16 LE` | `scorelen` — byte length of the event stream |
| 6 | 2 | `uint16 LE` | `scorestart` — byte offset of event stream from lump start |
| 8 | 2 | `uint16 LE` | `channels` — primary channels used |
| 10 | 2 | `uint16 LE` | `sec_channels` — secondary channels used |
| 12 | 2 | `uint16 LE` | `instrcount` — number of entries in instrument list |
| 14 | 2 | `uint16 LE` | reserved (0) |
| 16 | instrcount×2 | `uint16 LE[]` | instrument indices |

The engine validates: lump ≥ 16 bytes, magic == `MUS\x1a`, and
`scorestart + scorelen <= lump_size` (mus_opl.c:424-429).

**Verification** (D_E1M1, doom.wad): magic=`MUS\x1a`, scorelen=17237,
scorestart=46, channels=3, sec_channels=0, instrcount=15, total=17283 ✓.

### 7.2 MUS channels

MUS has 16 channels (0..15). Channel 15 is the **percussion channel**
(hard-coded, `PERCUSSION_CH = 15`, mus_opl.c:23). On a percussion event,
the note number selects a percussion instrument from the GENMIDI bank at
index `128 + note - 35` (mus_opl.c:240).

### 7.3 Event encoding

Events begin at `scorestart`. Each event starts with a **descriptor byte**:

| Bits | Field | Meaning |
|------|-------|---------|
| 7 | `last` | 1 = a delay follows after this event group |
| 6:4 | `type` | Event type (0..6) |
| 3:0 | `chan` | MUS channel (0..15) |

**Event types** (mus_opl.c:308-358):

| Type | Name | Payload bytes | Meaning |
|------|------|---------------|---------|
| 0 | release | 1 | note byte (bit 7 unused); key-off |
| 1 | play | 1 or 2 | note byte; if bit 7 set, a second byte follows = new volume |
| 2 | pitch bend | 1 | bend value (128=center) |
| 3 | system | 1 | system event (10/11 = all-notes-off) |
| 4 | controller | 2 | ctrl index + value (0=instrument, 3=volume) |
| 6 | score end | 0 | terminates playback |
| 5,7 | unknown | 1 | skip one byte (engine default case) |

**Delay**: if the `last` bit (bit 7) of the descriptor byte is set, a
variable-length delay follows after the event's payload. The delay is a
sequence of bytes; MSB of each byte is a continuation bit. The delay value
in MUS ticks:

```
delay = 0
while True:
    b = *ev++
    delay = (delay << 7) | (b & 0x7F)
    if not (b & 0x80): break
```

The engine runs at `MUS_RATE = 140 Hz` (mus_opl.c:20), so 1 MUS tick = 1/140
second ≈ 7.14 ms.

### 7.4 Controller map

Our engine handles a subset of the MUS controller space (mus_opl.c:340-353):

| ctrl index | Meaning |
|------------|---------|
| 0 | Set instrument (program change) |
| 3 | Set volume |
| others | Ignored |

---

## 8. GENMIDI instrument bank

Source: `engine/web/mus_opl.c`, structs at lines 27-52.

The GENMIDI WAD lump defines 175 OPL2 instruments (128 GM melodic + 47
percussion entries).

### 8.1 Lump layout

```
[0..7]       "#OPL_II#" (8-byte ASCII magic)
[8..6307]    175 × genmidi_instr_t (36 bytes each) = 6300 bytes
[6308..11907] 175 × 32-byte instrument name strings (NUL-padded ASCII)
Total: 11908 bytes
```

The engine reads only the first part: `memcpy(bank, g+8, sizeof bank)` where
`sizeof bank = 175 * 36 = 6300` bytes (mus_opl.c:385). The name strings are
**not used** by our engine.

**Verification** (doom.wad GENMIDI): size=11908, 8+6300+5600=11908 ✓.
Name[0]=`"Acoustic Grand Piano"`, Name[1]=`"Bright Acoustic Piano"`.

### 8.2 `genmidi_instr_t` (36 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `uint16 LE` | `flags` |
| 2 | 1 | `uint8` | `finetune` (128=no detune) |
| 3 | 1 | `uint8` | `fixednote` (note to use when GENMIDI_FLAG_FIXED is set) |
| 4 | 16 | `genmidi_voice_t` | `voice[0]` — primary OPL voice |
| 20 | 16 | `genmidi_voice_t` | `voice[1]` — secondary voice (GENMIDI_FLAG_2VOICE only) |

**Flags** (mus_opl.c:49-50):

| Value | Constant | Meaning |
|-------|----------|---------|
| 0x01 | `GENMIDI_FLAG_FIXED` | All notes play at `fixednote` pitch |
| 0x04 | `GENMIDI_FLAG_2VOICE` | Two simultaneous OPL voices per note (detuned for chorus) |

### 8.3 `genmidi_voice_t` (16 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 6 | `genmidi_op_t` | `mod` — modulator operator |
| 6 | 1 | `uint8` | `feedback` (OPL register 0xC0: connection + feedback bits) |
| 7 | 6 | `genmidi_op_t` | `car` — carrier operator |
| 13 | 1 | `uint8` | `unused` |
| 14 | 2 | `int16 LE` | `offset` — semitone offset for this voice (double-voice detune) |

### 8.4 `genmidi_op_t` (6 bytes)

Direct OPL2 operator register values:

| Offset | OPL reg offset | Field |
|--------|----------------|-------|
| 0 | +0x20 | `tremolo` (AM/VIB/EGT/KSR/MULT) |
| 1 | +0x60 | `attack` (AR+DR) |
| 2 | +0x80 | `sustain` (SL+RR) |
| 3 | +0xE0 | `waveform` (WS bits 0-2) |
| 4 | +0x40 high | `scale` (KSL bits, upper 2 bits) |
| 5 | +0x40 low | `level` (TL bits, lower 6 bits) |

The engine writes these directly to the OPL3 chip in compat mode (OPL2
semantics). Volume scaling modifies `level` at runtime (mus_opl.c:175-188).

---

## 9. Config / defaults

Source: `engine/core/m_misc.c`, `engine/web/files.c`, `client/js/persist.js`

### 9.1 Text format (.doomrc)

The config file is plain ASCII text, one line per setting:

```
key<TAB><TAB>value\n
```

- Integer values: decimal, no quotes (`screenblocks\t\t10`)
- String values: double-quoted (`chatmacro0\t\t"Player: %s\n"`)
- Comment lines: not supported in our parser (would be silently ignored if a
  key doesn't match any `defaults[]` entry)

Produced by `M_SaveDefaults` (m_misc.c:290-311) into a static 8192-byte
buffer, then written via `Web_FileWrite(".doomrc", buf, n)`.

### 9.2 Default keys (m_misc.c:216-280)

Key settings always present (all are integers unless noted):

| Key | Default | Type | Meaning |
|-----|---------|------|---------|
| `mouse_sensitivity` | 5 | int | Mouse speed |
| `sfx_volume` | 8 | int | SFX volume (0..15) |
| `music_volume` | 8 | int | Music volume (0..15) |
| `show_messages` | 1 | int | In-game messages |
| `use_mouse` | 1 | int | Mouse enabled |
| `mouseb_fire` | 0 | int | Mouse button for fire |
| `mouseb_strafe` | 1 | int | Mouse button for strafe |
| `mouseb_forward` | 2 | int | Mouse button for forward |
| `use_joystick` | 0 | int | Joystick enabled |
| `joyb_fire` | 0 | int | Joystick button for fire |
| `joyb_strafe` | 1 | int | |
| `joyb_use` | 3 | int | |
| `joyb_speed` | 2 | int | |
| `screenblocks` | 10 | int | View size (webdoom: full-width+status) |
| `detaillevel` | 0 | int | 0=high, 1=low |
| `snd_channels` | 3 | int | Simultaneous sound channels |
| `usegamma` | 0 | int | Gamma correction level |
| `chatmacro0`..`9` | strings | string | Chat macros |

**Note**: keyboard bindings (`key_right` etc.) and Linux/Unix device settings
are conditionally compiled for `NORMALUNIX`/`LINUX` only — not present in the
webdoom wasm build.

### 9.3 Persistence path

```
M_SaveDefaults → Web_FileWrite(".doomrc")
               → js_file_write (files.c:41-44)
               → Module.fileMap.set(".doomrc", bytes)
               → Module.onFileWrite(".doomrc")  [triggers sync]
persist.js     → IndexedDB key "config:.doomrc"
```

On startup: `persist.js: loadPersisted(iwad)` fetches from IndexedDB and
populates `Module.fileMap` before the engine boots. Saves are keyed
`"${iwad}:doomsav${N}.dsg"` to isolate per-IWAD save slots.

---

## 10. Network wire format

For the complete netcode specification, see `docs/netcode.md`. This section
adds only the ticcmd byte layout table (shared atom between demo and net
formats) and notes the precise demo/net difference.

### 10.1 `ticcmd_t` on the wire (8 bytes)

Sent client → server as bytes 4..11 of the 12-byte client message
(docs/netcode.md §Wire format):

| Byte | Field | Type | Meaning |
|------|-------|------|---------|
| 0 | `forwardmove` | `int8` | Forward/backward movement (-50..50 typically) |
| 1 | `sidemove` | `int8` | Strafe left/right |
| 2..3 | `angleturn` | `int16 LE` | Full turn delta (not compressed, unlike demo) |
| 4..5 | `consistancy` | `int16 LE` | Checksum for desync detection |
| 6 | `chatchar` | `uint8` | In-game chat keystroke (0=none) |
| 7 | `buttons` | `uint8` | Button bitmask |

**Demo vs. net difference**:

| Format | Size | angleturn | consistancy | chatchar |
|--------|------|-----------|-------------|----------|
| Demo (§4.2) | 4 bytes | 8-bit biased (lossy) | absent | absent |
| Network wire | 8 bytes | 16-bit full (lossless) | present | present |

The network protocol sends the full 8-byte `ticcmd_t`; the demo format drops 4
bytes by omitting consistancy/chatchar and compressing angleturn. This means a
demo cannot faithfully record multiplayer games with chat events, and network
demos (`netdemo=true`) that include chat are truncated silently.

---

## 11. Endianness and alignment doctrine

Source: `engine/core/m_swap.h`, `engine/core/m_swap.c`

### 11.1 Everything is little-endian

All WAD fields — header, directory, map lump data, TEXTURE/PNAMES lump — are
stored **little-endian**. The engine defines two macros (`m_swap.h:37-42`):

```c
#ifdef __BIG_ENDIAN__
short  SwapSHORT(short);
long   SwapLONG(long);
#define SHORT(x)  ((short)SwapSHORT((unsigned short)(x)))
#define LONG(x)   ((long)SwapLONG((unsigned long)(x)))
#else
#define SHORT(x)  (x)   // no-op on little-endian / wasm
#define LONG(x)   (x)
#endif
```

On x86 and wasm (the two targets this engine currently supports), `SHORT`/`LONG`
are identity functions. Every map lump read and WAD directory parse goes through
these macros. A big-endian bare-metal port (see task 1.5) must implement
`SwapSHORT` and `SwapLONG` correctly.

### 11.2 Struct packing assumptions

The engine reads many structs by direct `memcpy` or pointer cast against WAD
data (e.g. `(wadinfo_t *)data` in w_wad.c:177, `(mapthing_t *)data` in
p_setup.c:314). This is safe because:

1. All on-disk struct fields are 1- or 2-byte aligned (no field requires
   4-byte alignment within a lump).
2. The wasm32 target satisfies alignment requirements for 2-byte fields by
   construction (wasm linear memory allows unaligned loads, and emscripten
   compiles with `-mno-unaligned-access` disabled for the data structs).
3. The savegame code explicitly pads to 4-byte boundaries (`PADSAVEP()` in
   p_saveg.c:40) before writing `player_t` and `mobj_t`, because those in-memory
   structs contain pointer-size fields.

### 11.3 Savegame alignment

`#define PADSAVEP() save_p += (4 - ((int)save_p & 3)) & 3`

Applied before each `player_t`, `mobj_t`, and special-thinker block write.
This inserts 0–3 padding bytes to bring `save_p` to the next 4-byte boundary.
A reader must apply the same alignment logic; failing to do so will misread all
subsequent records.

### 11.4 Big-endian port checklist

A port to a big-endian platform (e.g. PowerPC, SPARC, network-order MIPS) must:

1. Implement `SwapSHORT` / `SwapLONG` in `m_swap.c`.
2. Define `__BIG_ENDIAN__` before including `m_swap.h`.
3. **Not** byte-swap structs that are read via `memcpy` and then accessed
   field-by-field through `SHORT()`/`LONG()` — those are already handled.
4. Handle the BLOCKMAP special case (p_setup.c:480-481): the lump is
   byte-swapped in-place in a loop rather than field-by-field.
5. Handle savegame `player_t` / `mobj_t` field endianness — these are
   `memcpy`'d verbatim and contain native-endian pointer indices; they are
   inherently platform-specific and must be version-tagged.
6. The MUS/GENMIDI lump headers use `uint16 LE` fields parsed by mus_opl.c
   with explicit `m[4] | (m[5] << 8)` bit arithmetic (mus_opl.c:427-428),
   which is correct regardless of host endianness.

---

## Open questions

None. All fields in the required coverage are accounted for.

---

## Byte verification log

The following claims were verified directly against `wads/lib/doom.wad`
(and other IWADs where noted) using Python one-liners against real bytes:

1. **WAD header**: IWAD magic, numlumps=2306, dirofs confirmed.
2. **NODES/NF_SUBSECTOR**: E1M1 node[0] children = 0x8000 / 0x8001 (both
   subsectors). 239 of 476 child references across 238 nodes use the
   NF_SUBSECTOR bit.
3. **BLOCKMAP**: E1M1 orgx=-776, orgy=-4872, width=36, height=23; 828
   offset-table entries; 828 matching 0xFFFF terminators.
4. **REJECT**: E1M1 has 88 sectors; REJECT = 968 bytes = ceil(88²/8) ✓.
5. **Demo headers**: all 4 doom.wad demos, all 3 doom2.wad demos, tnt.wad,
   plutonia.wad demos verified (version=109, all fields tabulated in §4.4).
6. **DMX SFX lead-in/lead-out pads** (DSPISTOL, doom.wad): format=3, rate=11025,
   num_samples=5661, real_n=5661-32=5629, lump_size=8+5661=5669 ✓. Lead-in
   bytes[8..23]=[126×16]; first real sample bytes[24]=126 — pad duplicates
   edge value ✓. Lead-out bytes[5653..5668]=[126×16]; last real sample
   bytes[5652]=126 — pad duplicates edge value ✓. Community "16-byte
   lead-in/lead-out pad" claim CONFIRMED.
7. **MUS**: D_E1M1 magic=`MUS\x1a`, scorelen=17237, scorestart=46 ✓.
8. **GENMIDI**: size=11908, 8+175×36+175×32=11908 ✓; Name[0]="Acoustic Grand Piano" ✓.
9. **PLAYPAL**: 14×768=10752 bytes ✓.
10. **COLORMAP**: 34×256=8704 bytes ✓.
11. **ENDOOM**: 4000 bytes ✓; engine does not read this lump.
12. **PNAMES**: 351 entries, size=2812=4+351×8 ✓.
13. **TEXTURE1**: 125 textures, verified first two entries including mappatch_t fields.
