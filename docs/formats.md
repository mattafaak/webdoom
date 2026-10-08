# webdoom data-format reference

Every external byte this engine reads or writes, mapped field by field. The
test of this document: a developer with only this page can write a parser that
works on real files.

The source of truth is the reader and writer code in this repository. Where
webdoom differs from vanilla DOOM, the difference is stated.

The WAD figures quoted here were read from the IWADs in `wads/lib/`.
`tools/archaeology/wad-verify.mjs` recomputes the doom.wad ones (directory
size, E1M1 BLOCKMAP and NODES, DSPISTOL, D_E1M1, GENMIDI, PNAMES, TEXTURE1),
and `tools/archaeology/source-constant-verify.mjs` checks the source constants
(MUS_RATE, the demo header size, the save slot count, the MUS
percussion channel). Both run in the `archaeology` leg.

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
| 4 | 4 | `int32 LE` | `numlumps`: number of directory entries |
| 8 | 4 | `int32 LE` | `infotableofs`: byte offset of the directory from file start |

**IWAD vs. PWAD**: `W_AddFile` accepts both. The distinction is semantic: an
IWAD is the base game data and a PWAD supplements it. Lump lookup treats them
identically. A file whose first 4 bytes are neither `IWAD` nor `PWAD` is
rejected with `I_Error`. doom.wad (The Ultimate Doom) has 2,306 directory
entries.

### 1.2 Directory entry (`filelump_t`)

Each entry is 16 bytes. The directory begins at `infotableofs`.

| Offset | Size | Type | Meaning |
|--------|------|------|---------|
| 0 | 4 | `int32 LE` | `filepos`: byte offset of the lump data in the WAD |
| 4 | 4 | `int32 LE` | `size`: byte length of the lump data |
| 8 | 8 | `char[8]` | `name`: NUL-padded uppercase ASCII, no extension |

**Name padding**: the name field is exactly 8 bytes, with trailing `\0` bytes
when the name is shorter. `W_CheckNumForName` compares names as two `int`-width
words, so padding bytes must be `\0`.

**Lookup is last-wins.** `W_CheckNumForName` scans the directory backwards,
from `lumpinfo + numlumps` down, and returns the first match: the last entry
with that name. A PWAD loaded after the IWAD therefore overrides any IWAD lump
of the same name.

**Case**: the query is upcased (`w_strupr`) before comparing. Directory names
are compared as stored, so a lowercase name in a WAD directory never matches.

### 1.3 Internal lump descriptor (`lumpinfo_t`)

After loading, each lump is described in memory by:

```c
typedef struct {
    char  name[8];
    int   handle;    // webdoom: pointer, cast to int, into the in-heap WAD data
    int   position;  // always 0 in webdoom (unused)
    int   size;
} lumpinfo_t;
```

There is no filesystem. JS places each file's bytes in the wasm heap and
registers them (`web_register_file` in `engine/web/files.c`, at most
`MAXWEBFILES` = 40 files). `W_AddFile` gets the bytes from `W_WebFile` and
sets `handle = (int)(data + LONG(fileinfo->filepos))`, a direct pointer to the
lump. `W_ReadLump` copies from that pointer into the zone, so the registered
WAD bytes are never written; the `ro-wad` leg checks this over the 13 demos in
the freestanding build. Storing a pointer in an `int` assumes 32-bit pointers,
which every build here has (wasm32, and `-m32` for the native builds).

A registered file whose name does not end in `wad` (for example a `.lmp` demo)
is a single lump: `filepos=0`, `size=length`, named after the file's base
name. `ExtractFileBase` zero-fills the 8-byte name and calls `I_Error` for a
base name longer than 8 characters.

### 1.4 Content-hash caching scheme

`tools/wad-identify.mjs` generates `wads/manifest.json`. Each entry carries:
- `sha256`: SHA-256 hex digest of the whole WAD file
- `size`: file size in bytes
- `file`: canonical filename (lowercased)

A WAD's identity is the SHA-256 of the entire file, not a checksum of
individual lumps. `fetchWad` in `client/js/main.js` looks in three places, in
order:

1. the user's local library (IndexedDB, keyed by sha256; imported WADs that
   never reach the server);
2. without an active service worker only, the IndexedDB WAD cache
   (`client/js/wad-cache.js`, keyed by sha256);
3. the network, as `/wads/<file>?v=<first8>`, where `<first8>` is the first 8
   hex characters of the SHA-256.

With a service worker, `client/sw.js` serves `/wads/` cache-first by full URL,
query string included. The `?v` hash makes that URL immutable, so the entry is
kept forever and works offline. On a miss the response streams to the page
while a copy is cached in the background; caching it also deletes any entry
for the same path with a different `?v`. The IndexedDB cache is written only
when there is no service worker, so a WAD is stored once, never twice.

---

## 2. Map lumps

Source: `engine/core/doomdata.h`, `engine/core/p_setup.c`

A map occupies a run of 11 lumps. The first is a zero-size marker named for
the map (`E1M1`, `MAP01`, ...). The other 10 follow in fixed order
(`doomdata.h`, the `ML_*` enum):

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

`P_SetupLevel` loads each as `W_GetNumForName(mapname) + ML_*`, in the order
BLOCKMAP, VERTEXES, SECTORS, SIDEDEFS, LINEDEFS, SSECTORS, NODES, SEGS,
REJECT, THINGS. The order matters: each loader resolves indices into arrays
loaded before it.

**Fixed-point convention**: map coordinates in the lumps are `int16` map units.
The engine converts them to `fixed_t` by shifting left 16 bits (`<<FRACBITS`).
1 map unit = 65536 (0x10000) in fixed point.

**Validation webdoom adds**: an out-of-range sidedef index in a linedef
(`P_LoadLineDefs`), an out-of-range sector index in a sidedef
(`P_LoadSideDefs`), and a missing player start (`P_SetupLevel`) each end in
`I_Error` naming the record. Vanilla read past the array or crashed later.
None of these fire on a valid map.

### 2.1 THINGS (`mapthing_t`, 10 bytes each)

```
count = lump_size / 10
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `x`: map X position |
| 2 | 2 | `int16 LE` | `y`: map Y position |
| 4 | 2 | `int16 LE` | `angle`: facing angle in degrees (0=east, counter-clockwise) |
| 6 | 2 | `int16 LE` | `type`: DoomEd type number |
| 8 | 2 | `int16 LE` | `options`: spawn flags bitmask |

`P_LoadThings` reads every field with `SHORT()`. x/y are not shifted to fixed
point here; `P_SpawnMapThing` uses them as map-unit integers.

`options` bits: bit 0 = skills 1-2, bit 1 = skill 3, bit 2 = skills 4-5,
bit 3 = ambush (deaf), bit 4 = multiplayer only.

### 2.2 LINEDEFS (`maplinedef_t`, 14 bytes each)

```
count = lump_size / 14
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `v1`: start vertex index |
| 2 | 2 | `int16 LE` | `v2`: end vertex index |
| 4 | 2 | `int16 LE` | `flags`: attribute bits |
| 6 | 2 | `int16 LE` | `special`: line special action |
| 8 | 2 | `int16 LE` | `tag`: sector tag |
| 10 | 2 | `int16 LE` | `sidenum[0]`: front sidedef index |
| 12 | 2 | `int16 LE` | `sidenum[1]`: back sidedef index, -1 if one-sided |

Source: `maplinedef_t` in `doomdata.h`; `P_LoadLineDefs`.

**Flag bits** (`doomdata.h`):

| Bit | Constant | Meaning |
|-----|----------|---------|
| 0x001 | `ML_BLOCKING` | Solid, blocks movement |
| 0x002 | `ML_BLOCKMONSTERS` | Blocks monsters only |
| 0x004 | `ML_TWOSIDED` | Has back sidedef |
| 0x008 | `ML_DONTPEGTOP` | Upper texture unpegged |
| 0x010 | `ML_DONTPEGBOTTOM` | Lower texture unpegged |
| 0x020 | `ML_SECRET` | Drawn as one-sided on the automap |
| 0x040 | `ML_SOUNDBLOCK` | Blocks sound propagation |
| 0x080 | `ML_DONTDRAW` | Never shown on the automap |
| 0x100 | `ML_MAPPED` | Already seen on the automap |

### 2.3 SIDEDEFS (`mapsidedef_t`, 30 bytes each)

```
count = lump_size / 30
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `textureoffset`: horizontal texture offset (map units) |
| 2 | 2 | `int16 LE` | `rowoffset`: vertical texture offset (map units) |
| 4 | 8 | `char[8]` | `toptexture`: NUL-padded name, `-` means none |
| 12 | 8 | `char[8]` | `bottomtexture` |
| 20 | 8 | `char[8]` | `midtexture` |
| 28 | 2 | `int16 LE` | `sector`: index of the sector this face belongs to |

Source: `mapsidedef_t` in `doomdata.h`; `P_LoadSideDefs`, which shifts
`textureoffset` and `rowoffset` to fixed point (`<<FRACBITS`).

### 2.4 VERTEXES (`mapvertex_t`, 4 bytes each)

```
count = lump_size / 4
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `x` |
| 2 | 2 | `int16 LE` | `y` |

`P_LoadVertexes` stores `SHORT(ml->x) << FRACBITS`; internal `vertex_t.x/y`
are `fixed_t`.

### 2.5 SEGS (`mapseg_t`, 12 bytes each)

```
count = lump_size / 12
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `v1`: start vertex index |
| 2 | 2 | `int16 LE` | `v2`: end vertex index |
| 4 | 2 | `int16 LE` | `angle`: direction in BAM (binary angle measure) |
| 6 | 2 | `int16 LE` | `linedef`: parent linedef index |
| 8 | 2 | `int16 LE` | `side`: 0=front, 1=back |
| 10 | 2 | `int16 LE` | `offset`: distance along the linedef to the seg start (map units) |

`P_LoadSegs` shifts `angle` and `offset` left 16 bits; the other fields are
read with `SHORT()`.

### 2.6 SSECTORS (`mapsubsector_t`, 4 bytes each)

```
count = lump_size / 4
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `numsegs` |
| 2 | 2 | `int16 LE` | `firstseg`: index into the SEGS array |

Source: `mapsubsector_t` in `doomdata.h`; `P_LoadSubsectors`.

### 2.7 NODES (`mapnode_t`, 28 bytes each)

```
count = lump_size / 28
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `x`: partition line origin X |
| 2 | 2 | `int16 LE` | `y`: partition line origin Y |
| 4 | 2 | `int16 LE` | `dx`: partition line delta X |
| 6 | 2 | `int16 LE` | `dy`: partition line delta Y |
| 8 | 16 | `int16[2][4] LE` | `bbox[2][4]`: bounding boxes of the right then left subtree (top, bottom, left, right) |
| 24 | 2 | `uint16 LE` | `children[0]`: right child |
| 26 | 2 | `uint16 LE` | `children[1]`: left child |

Source: `mapnode_t` in `doomdata.h`; `P_LoadNodes`, which shifts x/y/dx/dy and
every `bbox` value `<<FRACBITS`.

**NF_SUBSECTOR bit** (`#define NF_SUBSECTOR 0x8000`, `doomdata.h`): if bit 15
of a `children[]` value is set, the child is a subsector, with index
`children[i] & 0x7FFF`.

E1M1 (doom.wad) has 238 nodes; 239 of their 476 child references point to
subsectors, and node 0's two children are subsectors 0 and 1 (0x8000 and
0x8001). `tools/archaeology/wad-verify.mjs` recomputes the counts.

### 2.8 SECTORS (`mapsector_t`, 26 bytes each)

```
count = lump_size / 26
```

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `floorheight` |
| 2 | 2 | `int16 LE` | `ceilingheight` |
| 4 | 8 | `char[8]` | `floorpic`: flat name, NUL-padded |
| 12 | 8 | `char[8]` | `ceilingpic` |
| 20 | 2 | `int16 LE` | `lightlevel` (0..255) |
| 22 | 2 | `int16 LE` | `special`: sector effect type |
| 24 | 2 | `int16 LE` | `tag` |

Source: `mapsector_t` in `doomdata.h`; `P_LoadSectors`, which shifts
`floorheight` and `ceilingheight` `<<FRACBITS`. webdoom also copies them into
`oldfloorheight`/`oldceilingheight`, so render interpolation draws no streak
on the first frame of a level.

### 2.9 REJECT

A packed bitfield, one bit per ordered sector pair:

```
size = ceil(numsectors * numsectors / 8)  bytes
```

Bit `(s1 * numsectors + s2)` is set when sector `s1` can never see sector
`s2`, which lets sight checks skip the BSP walk. From `P_CheckSight`
(`p_sight.c`):

```c
pnum = s1*numsectors + s2;
bytenum = pnum>>3;
bitnum = 1 << (pnum&7);
if (rejectmatrix[bytenum]&bitnum) return false;
```

`P_SetupLevel` caches the lump raw (`W_CacheLumpNum`), with no byte-swapping
and no length check: a REJECT shorter than the formula is read past its end,
as in vanilla. Bit 0 of byte 0 is the pair (0, 0).

E1M1 has 88 sectors and a 968-byte REJECT, which is `ceil(88*88/8)`.

### 2.10 BLOCKMAP

A 2-D grid of linedef lists, used for collision.

**Header** (4 × `int16 LE`):

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `orgx`: map X of the grid origin |
| 2 | 2 | `int16 LE` | `orgy`: map Y of the grid origin |
| 4 | 2 | `int16 LE` | `bmapwidth`: grid columns |
| 6 | 2 | `int16 LE` | `bmapheight`: grid rows |

**Offset table**: `bmapwidth * bmapheight` × `int16 LE`, starting at byte 8.
Each entry is the position of that block's linedef list, counted in 16-bit
words from the start of the lump.

**Linedef lists**: each list is a run of `int16` linedef indices ending in
**0xFFFF** (-1 as a signed short). The first entry of every list is **0**.
The engine does not skip it: `P_BlockLinesIterator` visits it as linedef 0 in
every block (vanilla behaviour, and demo-relevant). A parser that wants only
the block's own lines should skip it.

`P_LoadBlockMap` byte-swaps the whole lump in place
(`blockmaplump[i] = SHORT(blockmaplump[i])` over `lump_size/2` shorts) and
sets `blockmap = blockmaplump + 4`, past the header.

**0xFFFF and -1** are the same bit pattern. The engine reads the terminator
as a signed short (-1); a parser can treat it as an unsigned 16-bit sentinel.
Because the offsets are 16-bit, a blockmap larger than 64 KiB cannot be
addressed; [divergence-atlas.md](divergence-atlas.md) F5c covers that family.

E1M1: orgx=-776, orgy=-4872, width=36, height=23; 828 offset-table entries
and 828 lists, every one opening with 0 and closing with 0xFFFF.

---

## 3. Graphics lumps

Source: `engine/core/r_defs.h`, `engine/core/r_data.c`, `engine/core/v_video.c`

### 3.1 patch_t: column/post format

Used for sprites, HUD and menu graphics, and the patches composited into wall
textures.

**Patch header** (`patch_t`, `r_defs.h`):

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `width`: bounding box width in pixels |
| 2 | 2 | `int16 LE` | `height`: bounding box height |
| 4 | 2 | `int16 LE` | `leftoffset`: pixels to the left of the origin |
| 6 | 2 | `int16 LE` | `topoffset`: pixels below the origin (source comment) |
| 8 | 4×width | `int32 LE[]` | `columnofs[width]`: byte offset from patch start to each column |

The struct declares `int columnofs[8]`, but only `[width]` entries exist: it is
a variable-size header. Each offset points to a column's post list within the
same lump.

**column / post_t** (`r_defs.h`):

A column is a list of zero or more posts (runs of opaque pixels), ended by a
post whose `topdelta` is `0xFF`:

```
post_t {
    uint8  topdelta;   // row where this run begins; 0xFF ends the column
    uint8  length;     // number of pixel bytes in this run
    // implied:
    uint8  unused;     // padding byte before the data (not read by the engine)
    uint8  data[length];
    uint8  unused;     // padding byte after the data (not read by the engine)
}
```

The walk, from `R_DrawColumnInCache` in `r_data.c`:

```c
while (patch->topdelta != 0xff) {
    source = (byte *)patch + 3;     // data starts 3 bytes into post_t
    ...
    patch = (column_t *)((byte *)patch + patch->length + 4);
}
```

So each post is `[topdelta][length][unused][data...][unused]`, 4 + length
bytes in all.

**Tall patches**: `topdelta` is a `uint8` and 0xFF ends the column, so a post
can start no lower than row 254. The DeePsea/ZDoom tall-patch convention (a
`topdelta` not greater than the previous one is relative) is not implemented;
such a post is drawn at the absolute row its byte gives.

### 3.2 Flats

64×64-pixel floor and ceiling images, stored as 4,096 raw bytes of palette
indices with no header: row-major, left to right, top to bottom.

`R_InitFlats` takes every lump between `F_START` and `F_END` as a flat. With
last-wins lookup (§1.2), a PWAD that carries its own `F_START`/`F_END` pair
replaces the IWAD's range. The engine does not read `FF_START`/`FF_END`.

Every flat in doom.wad is exactly 4,096 bytes.

### 3.3 PLAYPAL

14 palettes × 768 bytes = 10,752 bytes (doom.wad).

Each palette is 256 RGB triples:

| Offset in triple | Size | Meaning |
|------------------|------|---------|
| 0 | 1 | Red (0..255) |
| 1 | 1 | Green |
| 2 | 1 | Blue |

Palette 0 is the normal palette. Palettes 1-8 are progressively red (damage),
9-12 yellow (item pickup), and 13 green (radiation suit); the indices are
`STARTREDPALS`, `STARTBONUSPALS` and `RADIATIONPAL` in `st_stuff.c`. The engine
reads it with `W_CacheLumpName("PLAYPAL", PU_CACHE)`.

### 3.4 COLORMAP

34 tables × 256 bytes = 8,704 bytes (doom.wad). See also
[engine-archaeology.md](engine-archaeology.md) §6, which recovers the recipe,
and [renderer.md](renderer.md) §2.3, which covers how the renderer indexes it.

Each table maps a palette index to a darker one. Tables 0-31 are the light
levels: table 0 is full brightness and table 31 near black. Table 32 is the
invulnerability inverse greyscale (`INVERSECOLORMAP` in `p_user.c`). Table 33
is all zeros (black) and the engine never selects it.

`R_InitColormaps` copies the lump into a zone block aligned to 256 bytes and
points `colormaps` at it.

### 3.5 PNAMES

The patch name table. TEXTURE1/TEXTURE2 refer to patches by index into it.

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | `uint32 LE` | `count`: number of patch names |
| 4 | count×8 | `char[8][]` | NUL-padded patch lump names |

Read by `R_InitTextures`. Lump size = `4 + count * 8`. doom.wad: count=351,
size 2,812.

### 3.6 TEXTURE1 / TEXTURE2

Composite wall texture definitions. TEXTURE2 is optional: the shareware IWAD
has only TEXTURE1.

**Header**:

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | `uint32 LE` | `numtextures` |
| 4 | numtextures×4 | `int32 LE[]` | byte offset from lump start to each `maptexture_t` |

An offset beyond the lump's length is an `I_Error` ("bad texture directory").

**`maptexture_t`** (`r_data.c`):

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 8 | `char[8]` | `name`: texture name, NUL-padded |
| 8 | 4 | `int32 LE` | `masked` (boolean, legacy) |
| 12 | 2 | `int16 LE` | `width` in pixels |
| 14 | 2 | `int16 LE` | `height` in pixels |
| 16 | 4 | `int32 LE` | `columndirectory`: obsolete, always 0, unused |
| 20 | 2 | `int16 LE` | `patchcount`: number of patches composited |
| 22 | patchcount×10 | `mappatch_t[]` | patch descriptors |

**`mappatch_t`** (`r_data.c`), 10 bytes each:

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `int16 LE` | `originx`: patch placement X (may be negative) |
| 2 | 2 | `int16 LE` | `originy`: patch placement Y |
| 4 | 2 | `int16 LE` | `patch`: index into PNAMES |
| 6 | 2 | `int16 LE` | `stepdir`: unused (legacy) |
| 8 | 2 | `int16 LE` | `colormap`: unused (legacy) |

`R_InitTextures` parses both lumps. A `patch` index whose PNAMES name has no
lump is an `I_Error` naming the texture. A `maptexture_t` can start at any
byte offset, so the fields are read with `read_le16` and the name copied byte
by byte; a strict-alignment CPU would fault on a direct load (§11.2). Textures
are composited lazily, on first use, by `R_GenerateComposite`.

doom.wad's TEXTURE1 holds 125 textures.

### 3.7 ENDOOM

`ENDOOM` is an 80×25 text-mode screen: 4,000 bytes of character and attribute
pairs (character byte, then attribute byte, 80 columns × 25 rows). **This
engine does not read ENDOOM**; nothing under `engine/` names it.

---

## 4. Demo format

Source: `engine/core/g_game.c` (`G_RecordDemo`, `G_BeginRecording`,
`G_WriteDemoTiccmd`, `G_ReadDemoTiccmd`, `G_DoPlayDemo`, `G_CheckDemoStatus`)
and `engine/web/demo.c` (the web build's recording and replay entry points).

Demos are WAD lumps named `DEMO1` to `DEMO4`, or free-standing `.lmp` files.

### 4.1 Header

| Byte | Field | Values |
|------|-------|--------|
| 0 | version | 109 or 110. The engine writes `VERSION` = 110 (`doomdef.h`); `G_DoPlayDemo` accepts 110 and 109 |
| 1 | skill | 0=ITYTD, 1=HNTR, 2=HMP, 3=UV, 4=Nightmare (`skill_t`) |
| 2 | episode | 1-4 (Doom 1) or 1 (Doom 2, TNT, Plutonia) |
| 3 | map | 1-9 (Doom 1) or 1-32 (Doom 2) |
| 4 | deathmatch | 0=cooperative/single player, 1=deathmatch |
| 5 | respawnparm | 1=monsters respawn |
| 6 | fastparm | 1=fast monsters |
| 7 | nomonsters | 1=no monsters spawned |
| 8 | consoleplayer | 0-3, the player who recorded it |
| 9 | playeringame[0] | 1=player 0 active |
| 10 | playeringame[1] | 1=player 1 active |
| 11 | playeringame[2] | 1=player 2 active |
| 12 | playeringame[3] | 1=player 3 active |

The header is 13 bytes. If `playeringame[1]` is set, playback runs as a net
demo (`netgame` and `netdemo` true).

### 4.2 Tic data

After the header: 4-byte records, one per game tic per active player,
interleaved (all players for tic 0, then tic 1, and so on):

| Byte | Field | Encoding |
|------|-------|----------|
| 0 | `forwardmove` | `int8` (signed), read directly |
| 1 | `sidemove` | `int8` (signed), read directly |
| 2 | `angleturn` | `uint8`; written as `(cmd->angleturn + 128) >> 8`, read back as `((uint8)*p++) << 8` |
| 3 | `buttons` | `uint8` bit field |

**`angleturn` is lossy.** The in-memory field is `int16`; the demo keeps only
its rounded high byte, so every recorded turn is a multiple of 256 (256
headings per full circle). This is vanilla. After writing a tic,
`G_WriteDemoTiccmd` decodes the 4 bytes back into the live ticcmd, so the game
being recorded runs on exactly the commands its playback will see.

**Terminator**: the single byte `0x80` (`DEMOMARKER`) ends the tic data.
`G_ReadDemoTiccmd` tests for it before consuming any tic bytes.

**Recording uses a fixed buffer.** `G_RecordDemo` allocates 0x20000 bytes
(131,072; `-maxdemo N` sets N KiB) and sets `demoend = demobuffer + maxsize`.
`G_WriteDemoTiccmd` stops writing at `demoend - 16`: at 4 bytes per tic that
is about 32,760 tics, 15.6 minutes. A full buffer keeps the tics it holds and
later tics are not recorded. Vanilla ended the session at that point through
`G_CheckDemoStatus`, whose `I_Error("Demo %s recorded")` would abort the
browser runtime and lose the recording.

The web build starts a recording with `-record webdemo` and stops it with
`web_demo_stop` (`engine/web/demo.c`), which appends the marker and returns
the `.lmp` length; the bytes are at `web_demo_buf_ptr()`. `web_play_demo_buf`
replays an `.lmp` from memory.

### 4.3 On-disk ticcmd vs. in-memory `ticcmd_t`

The 4-byte demo record is a lossy subset of `ticcmd_t` (`d_ticcmd.h`):

```c
typedef struct {
    char  forwardmove;   // demo byte 0
    char  sidemove;      // demo byte 1
    short angleturn;     // demo keeps only the rounded high byte
    short consistancy;   // not in demos
    byte  chatchar;      // not in demos
    byte  buttons;       // demo byte 3
} ticcmd_t;             // 8 bytes in memory
```

`consistancy` and `chatchar` are never written to or read from demo files.
§10 gives the network format, which sends the whole 8-byte struct.

### 4.4 IWAD demo headers

Every IWAD in `wads/lib/` carries version-109 demos. All are skill 3 (UV),
single player (`playeringame` = [1,0,0,0], consoleplayer 0), with deathmatch,
respawn, fast and nomonsters all 0.

| IWAD | Lump | ep | map |
|------|------|----|-----|
| doom.wad (The Ultimate Doom) | DEMO1 | 1 | 5 |
| | DEMO2 | 2 | 2 |
| | DEMO3 | 3 | 5 |
| | DEMO4 | 4 | 2 |
| doom2.wad (Doom II) | DEMO1 | 1 | 11 |
| | DEMO2 | 1 | 5 |
| | DEMO3 | 1 | 26 |
| tnt.wad (Final Doom: TNT) | DEMO1 | 1 | 1 |
| | DEMO2 | 1 | 12 |
| | DEMO3 | 1 | 13 |
| plutonia.wad (Final Doom: Plutonia) | DEMO1 | 1 | 17 |
| | DEMO2 | 1 | 10 |
| | DEMO3 | 1 | 12 |

The episode byte is always 1 for the Doom II engine games; the map byte is the
full `MAP##` number.

---

## 5. Savegame format

Source: `G_DoSaveGame` and `G_DoLoadGame` in `engine/core/g_game.c`; the
archive routines in `engine/core/p_saveg.c`. [playsim.md](playsim.md) §13
covers what the archive preserves and what breaks a save.

**The version string is `"webdm2 110"`**, not vanilla's `"version 110"`.
webdoom's `mobj_t` and `player_t` carry render-interpolation fields
(`oldx`/`oldy`/`oldz`/`oldangle`, and the previous tic's `viewz`), and both
structs are `memcpy`'d into the save. The tag makes `G_DoLoadGame` refuse a
vanilla save (it returns without loading) instead of reading it as garbage.

### 5.1 Layout

```
[0..23]       description (SAVESTRINGSIZE = 24, NUL-padded text)
[24..39]      version string (VERSIONSIZE = 16, NUL-padded): "webdm2 110"
[40]          gameskill
[41]          gameepisode
[42]          gamemap
[43..46]      playeringame[0..3]
[47..49]      leveltime as 24 bits, high byte first (>>16, >>8, low byte)

P_ArchivePlayers
  for each player in game: PADSAVEP(), then player_t verbatim
  (psprite state pointers stored as indices into states[])
P_ArchiveWorld
  per sector: 7 × int16  floorheight>>FRACBITS, ceilingheight>>FRACBITS,
                         floorpic, ceilingpic, lightlevel, special, tag
  per line:   3 × int16  flags, special, tag
              then, for each side present (sidenum != -1), 5 × int16:
              textureoffset>>FRACBITS, rowoffset>>FRACBITS,
              toptexture, bottomtexture, midtexture
P_ArchiveThinkers
  per mobj:   byte tc_mobj, PADSAVEP(), mobj_t verbatim
  then:       byte tc_end
P_ArchiveSpecials
  per special thinker: byte tc_<class>, PADSAVEP(), struct verbatim
  then:       byte tc_endspecials

[last byte]   0x1d (consistency marker)
```

`G_DoLoadGame` reads the same sequence and calls `I_Error("Bad savegame")` if
the byte after the specials is not 0x1d.

### 5.2 Thinker archive protocol

`tc_*` byte values (two enums in `p_saveg.c`):

| Value | Constant | Meaning |
|-------|----------|---------|
| 0 | `tc_end` | End of the mobj list |
| 1 | `tc_mobj` | Map object (`mobj_t`) |
| 0 | `tc_ceiling` | Ceiling mover (specials list) |
| 1 | `tc_door` | Door |
| 2 | `tc_floor` | Floor mover |
| 3 | `tc_plat` | Platform |
| 4 | `tc_flash` | Light flash |
| 5 | `tc_strobe` | Light strobe |
| 6 | `tc_glow` | Glowing light |
| 7 | `tc_endspecials` | End of the specials list |

`tc_end` and `tc_ceiling` share the value 0, and `tc_mobj` and `tc_door` the
value 1. They belong to separate enums and separate lists in the file (mobjs
first, specials second), so the position tells them apart.

Each record is the 1-byte class, `PADSAVEP()` alignment to a 4-byte boundary,
then the struct copied verbatim. Pointers are stored as integers:
- `mobj->state` → `state - states`
- `mobj->player` → `(player - players) + 1` (0 = no player)
- a special thinker's `sector` → `sector - sectors`

On load, `mobj->target` is set to NULL. A ceiling in stasis has no thinker
function but is still saved as `tc_ceiling` when it is in `activeceilings`.
Thinkers of any other class (for example `T_FireFlicker`) are not saved, as in
vanilla.

### 5.3 Save buffer size

`G_DoSaveGame` mallocs the buffer before writing anything. Its size is the
50-byte header plus `P_ArchiveSize()` (p_saveg.c), an upper bound computed
from the current level. The bound counts every player slot, 14 bytes per
sector, 6 per linedef plus 10 per sidedef, and for every thinker a class byte,
3 bytes of padding and `sizeof(mobj_t)`, the largest archived struct (a
`_Static_assert` keeps it so). The buffer is freed after `M_WriteFile`.

Vanilla built the save at `screens[1] + 0x4000`, which leaves 175,616 bytes
before the end of `V_Init`'s screen block, and checked nothing first. The
biggest library levels need more at their start: Black Tower MAP25, NRFTL
MAP05 and SIGIL E5M7 save at 176–197 KB on Ultra-Violence. `save-compat` saves
and reloads all three through the menu.

A save being loaded is untrusted: it may come from another WAD, be cut short
or be edited. `G_DoLoadGame` and the `P_UnArchive*` functions check every read
against the loaded length (`save_end`), and every index read from the file
(states, mobj types, players, sectors, flats, textures, weapons) against the
array it selects, and refuse with `I_Error("Savegame does not match this
game: ...")` or `"Savegame is truncated"` before using it. Loading drops the
raw `target` and `tracer` pointers, as Chocolate Doom does.

**Where saves go**: `M_WriteFile` → `Web_FileWrite` → `js_file_write`
(`engine/web/files.c`) → `Module.fileMap`. `client/js/persist.js` mirrors the
map to IndexedDB under `<namespace>:doomsav<N>.dsg`, where the namespace is
the IWAD's name, or base plus PWAD for a PWAD game. There are 6 slots,
`doomsav0.dsg` to `doomsav5.dsg` (`SAVEGAMENAME` in `dstrings.h`).
`M_ReadFile` reads back through `Web_FileLen`/`Web_FileCopy` into a zone
block.

---

## 6. DMX sound effects

Source: `engine/web/i_sound.c` (`I_GetSfxLumpNum`, `I_StartSound`) and
`client/js/audio.js` (`decode`, `doom.sfxStart`).

SFX lumps are named `DS<name>` (`DSPISTOL`, `DSSHOTGN`, ...).
`I_GetSfxLumpNum` looks up `"ds" + sfx->name` with `W_CheckNumForName`; a
missing lump gives -1 and the sound simply does not play, because total
conversions may omit sounds.

### 6.1 Header (8 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `uint16 LE` | `format_id`: must be **3** |
| 2 | 2 | `uint16 LE` | `sample_rate`: Hz (usually 11025) |
| 4 | 4 | `uint32 LE` | `num_samples`: byte count of the sample region, including the 16-byte lead-in and lead-out pads |

Lump size = `8 + num_samples` bytes.

### 6.2 PCM data layout (bytes 8 .. 8+num_samples-1)

| Sub-region | Offset | Size | Content |
|------------|--------|------|---------|
| Lead-in pad | 8 | 16 bytes | copies of the first real sample |
| Real PCM | 24 | `num_samples - 32` bytes | the sound |
| Lead-out pad | `24 + (num_samples-32)` | 16 bytes | copies of the last real sample |

Samples are unsigned 8-bit; 128 (0x80) is silence, 0..127 the negative half
and 129..255 the positive. The pads exist because the DMX driver read 16
samples ahead; duplicating the edge values keeps that read-ahead silent.

doom.wad's DSPISTOL: format 3, rate 11025, num_samples 5661 (5,629 real
samples), lump size 5,669. Bytes 8-23 and bytes 5653-5668 are all 126, equal
to the first real sample (byte 24) and the last (byte 5652).

### 6.3 WebAudio path

`I_StartSound` caches the lump in the zone and passes the whole lump
(`data`, `len`) to JS through `js_sfx_start`. `decode()` in
`client/js/audio.js` builds an `AudioBuffer` once per sound id and caches it:

- it rejects a lump shorter than 40 bytes, a `format_id` other than 3, a
  sample count that is not positive or runs past the lump, and a rate under
  3,000 Hz (WebAudio's minimum);
- it creates a one-channel buffer at the lump's own rate and fills it with
  `(byte - 128) / 128` from byte 24 for `num_samples - 32` samples.

The browser resamples to the context rate. At play time the source gets
`playbackRate = 2^((pitch - 128) / 64)`, gain `vol / 127`, and stereo pan
`(sep - 128) / 128`, and `sfxUpdate` changes all three while it plays.

---

## 7. MUS music

Source: `engine/web/mus_opl.c` (`mus_play`, `run_event_group`).

### 7.1 Header (16 bytes + instrument list)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | `char[4]` | Magic: `MUS\x1a` (0x4d, 0x55, 0x53, 0x1a) |
| 4 | 2 | `uint16 LE` | `scorelen`: byte length of the event stream |
| 6 | 2 | `uint16 LE` | `scorestart`: byte offset of the event stream from lump start |
| 8 | 2 | `uint16 LE` | `channels`: primary channels used |
| 10 | 2 | `uint16 LE` | `sec_channels`: secondary channels used |
| 12 | 2 | `uint16 LE` | `instrcount`: entries in the instrument list |
| 14 | 2 | `uint16 LE` | reserved (0) |
| 16 | instrcount×2 | `uint16 LE[]` | instrument indices |

`mus_play` refuses (returns 0) unless a GENMIDI bank is loaded, the lump is at
least 16 bytes, the magic matches, and `scorestart + scorelen` fits in the
lump. It reads the 16-bit fields byte by byte (`m[4] | (m[5] << 8)`).

D_E1M1 (doom.wad): scorelen 17,237, scorestart 46, channels 3,
sec_channels 0, instrcount 15, lump size 17,283.

### 7.2 MUS channels

MUS has 16 channels (0..15). Channel 15 is the **percussion channel**
(`PERCUSSION_CH`). On channel 15 the note number picks a percussion
instrument at GENMIDI index `128 + note - 35`; a note outside the bank
(index below 0 or at least 175) plays nothing.

### 7.3 Event encoding

Events begin at `scorestart`. Each starts with a **descriptor byte**:

| Bits | Field | Meaning |
|------|-------|---------|
| 7 | `last` | 1 = a delay follows this event |
| 6:4 | `type` | event type (0..7) |
| 3:0 | `chan` | MUS channel (0..15) |

**Event types** (`run_event_group`):

| Type | Name | Payload bytes | Meaning |
|------|------|---------------|---------|
| 0 | release | 1 | note byte (bit 7 ignored); key off |
| 1 | play | 1 or 2 | note byte; if its bit 7 is set, a second byte follows with the new volume |
| 2 | pitch bend | 1 | bend value (128 = centre) |
| 3 | system | 1 | system event (10 or 11 = all notes off) |
| 4 | controller | 2 | controller index, then value |
| 6 | score end | 0 | ends playback |
| 5, 7 | unknown | 1 | one byte skipped |

**Delay**: when the `last` bit is set, a variable-length delay follows the
event's payload. Each byte contributes 7 bits, high bit = more bytes follow:

```
delay = 0
while True:
    b = *ev++
    delay = (delay << 7) | (b & 0x7F)
    if not (b & 0x80): break
```

The delay is in MUS ticks. The sequencer runs at `MUS_RATE` = 140 Hz, so one
tick is 1/140 s, about 7.14 ms.

**Malformed scores end the song** rather than reading out of bounds: an event
whose payload runs past `scorestart + scorelen`, and a delay longer than 4
bytes (28 bits), both stop playback. Without the 4-byte cap the shift would
overflow `int` and the render pump's wait loop would never end. The
`wad-content-fuzz` leg feeds hostile MUS and GENMIDI lumps.

### 7.4 Controller map

`mus_opl.c` handles two controllers:

| ctrl index | Meaning |
|------------|---------|
| 0 | set instrument (program change) |
| 3 | set channel volume |
| others | ignored |

---

## 8. GENMIDI instrument bank

Source: `engine/web/mus_opl.c` (structs `genmidi_op_t`, `genmidi_voice_t`,
`genmidi_instr_t`; `load_bank`).

The GENMIDI lump defines 175 OPL2 instruments: 128 General MIDI melodic
instruments and 47 percussion entries.

### 8.1 Lump layout

```
[0..7]         "#OPL_II#" (8-byte ASCII magic)
[8..6307]      175 × genmidi_instr_t (36 bytes each) = 6,300 bytes
[6308..11907]  175 × 32-byte instrument names (NUL-padded ASCII)
Total: 11,908 bytes
```

`load_bank` copies only the instruments: `memcpy(bank, g + 8, sizeof bank)`,
with `sizeof bank` = 175 × 36 = 6,300, then converts each instrument's
16-bit `flags` and both voices' `offset` with `SHORT()` (the identity on a
little-endian host). The names are not used. A lump shorter
than 8 + 6,300 bytes, or without the magic, is not loaded; a PWAD's GENMIDI
overrides the IWAD's, so a short one would otherwise be over-read. With no
bank loaded, `mus_play` refuses every song.

doom.wad's GENMIDI is 11,908 bytes; name 0 is "Acoustic Grand Piano" and name
1 "Bright Acoustic Piano".

### 8.2 `genmidi_instr_t` (36 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 2 | `uint16 LE` | `flags` |
| 2 | 1 | `uint8` | `finetune` (128 = no detune) |
| 3 | 1 | `uint8` | `fixednote`: the note played when `GENMIDI_FLAG_FIXED` is set |
| 4 | 16 | `genmidi_voice_t` | `voice[0]`: primary OPL voice |
| 20 | 16 | `genmidi_voice_t` | `voice[1]`: second voice (`GENMIDI_FLAG_2VOICE` only) |

**Flags**:

| Value | Constant | Meaning |
|-------|----------|---------|
| 0x01 | `GENMIDI_FLAG_FIXED` | every note plays at `fixednote` |
| 0x04 | `GENMIDI_FLAG_2VOICE` | two OPL voices per note (detuned for a chorus effect) |

### 8.3 `genmidi_voice_t` (16 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 6 | `genmidi_op_t` | `mod`: modulator operator |
| 6 | 1 | `uint8` | `feedback` (OPL register 0xC0: connection and feedback bits) |
| 7 | 6 | `genmidi_op_t` | `car`: carrier operator |
| 13 | 1 | `uint8` | `unused` |
| 14 | 2 | `int16 LE` | `offset`: semitone offset for this voice (the double-voice detune) |

### 8.4 `genmidi_op_t` (6 bytes)

OPL2 operator register values, written as given:

| Offset | OPL register | Field |
|--------|--------------|-------|
| 0 | +0x20 | `tremolo` (AM/VIB/EGT/KSR/MULT) |
| 1 | +0x60 | `attack` (AR+DR) |
| 2 | +0x80 | `sustain` (SL+RR) |
| 3 | +0xE0 | `waveform` (WS bits 0-2) |
| 4 | +0x40 high | `scale` (KSL, upper 2 bits) |
| 5 | +0x40 low | `level` (TL, lower 6 bits) |

The synth runs in one of two modes: OPL2, 9 voices, mono (the default), or
OPL3, 18 voices, stereo. The mode is a client setting kept in localStorage,
not in `.doomrc`. `voice_volume` adds an attenuation for the combined channel,
note and master volume to the carrier's `level` (and the modulator's, for an
additive voice), capped at 63.

---

## 9. Config / defaults

Source: `engine/core/m_misc.c` (`defaults[]`, `M_SaveDefaults`,
`M_LoadDefaults`), `engine/web/files.c`, `client/js/persist.js`

### 9.1 Text format (.doomrc)

Plain ASCII, one setting per line:

```
key<TAB><TAB>value\n
```

- Integers: decimal (`screenblocks\t\t10`). `M_LoadDefaults` also accepts
  `0x` hex.
- Strings: double-quoted (`chatmacro0\t\t"..."`).
- `M_LoadDefaults` reads each line as a whitespace-separated key and value
  (`sscanf("%79s %99[^\n]")`). A line whose key matches no `defaults[]` entry
  is ignored, so comment lines are harmless.

`M_SaveDefaults` writes every entry into a static 8,192-byte buffer, then
calls `Web_FileWrite(".doomrc", buf, n)`.

### 9.2 Default keys (`defaults[]`)

The wasm build compiles with `-DNORMALUNIX`, so the keyboard bindings are
included. `LINUX` is not defined, so `mousedev`/`mousetype` are not, and
neither are the `SNDSERV` entries.

| Key | Default | Type | Meaning |
|-----|---------|------|---------|
| `mouse_sensitivity` | 5 | int | mouse speed |
| `sfx_volume` | 8 | int | SFX volume (0..15) |
| `music_volume` | 8 | int | music volume (0..15) |
| `show_messages` | 1 | int | in-game messages |
| `key_right` | 174 (`KEY_RIGHTARROW`) | int | turn right |
| `key_left` | 172 (`KEY_LEFTARROW`) | int | turn left |
| `key_up` | 173 (`KEY_UPARROW`) | int | forward |
| `key_down` | 175 (`KEY_DOWNARROW`) | int | backward |
| `key_strafeleft` | 44 (`,`) | int | strafe left |
| `key_straferight` | 46 (`.`) | int | strafe right |
| `key_fire` | 157 (`KEY_RCTRL`) | int | fire |
| `key_use` | 32 (space) | int | use |
| `key_strafe` | 184 (`KEY_RALT`) | int | strafe modifier |
| `key_speed` | 182 (`KEY_RSHIFT`) | int | run modifier |
| `use_mouse` | 1 | int | mouse enabled |
| `mouseb_fire` | 0 | int | mouse button for fire |
| `mouseb_strafe` | 1 | int | mouse button for strafe |
| `mouseb_forward` | 2 | int | mouse button for forward |
| `use_joystick` | 0 | int | joystick enabled |
| `joyb_fire` | 0 | int | joystick button for fire |
| `joyb_strafe` | 1 | int | joystick button for strafe |
| `joyb_use` | 3 | int | joystick button for use |
| `joyb_speed` | 2 | int | joystick button for run |
| `screenblocks` | 10 | int | view size; webdoom defaults to full width with the status bar (vanilla: 9) |
| `detaillevel` | 0 | int | 0=high, 1=low |
| `snd_channels` | 3 | int | simultaneous sound channels |
| `usegamma` | 0 | int | gamma correction level |
| `chatmacro0`..`9` | strings | string | chat macros |

The key codes are DOOM's (`doomdef.h`), not browser key codes. The OPL mode
(§8.4) is persisted by the client in localStorage and has no `.doomrc` entry.

### 9.3 Persistence path

```
M_SaveDefaults → Web_FileWrite(".doomrc")
               → js_file_write (engine/web/files.c)
               → Module.fileMap.set(".doomrc", bytes)
               → Module.onFileWrite(".doomrc")  [triggers a sync]
persist.js     → IndexedDB key "config:.doomrc"
```

Before the engine boots, `loadPersisted` in `persist.js` reads the config and
the save slots from IndexedDB into `Module.fileMap`. The config is shared by
every game; saves are keyed per game (§5.3). An entry larger than the engine
could have written (64 KiB for the config, 1 MiB for a save) is ignored with a
warning, because copying it into the heap would abort every boot.

---

## 10. Network wire format

The full netcode specification is [netcode.md](netcode.md). This section only
gives the ticcmd byte layout, the atom the demo and net formats share, and
how the two differ.

### 10.1 `ticcmd_t` on the wire (8 bytes)

Sent client → server as bytes 4..11 of the 12-byte client message
(netcode.md, "Wire format"), and server → client 8 bytes per player in each
sealed bundle. It is the in-memory struct as wasm lays it out:

| Byte | Field | Type | Meaning |
|------|-------|------|---------|
| 0 | `forwardmove` | `int8` | forward/backward movement (`G_BuildTiccmd` clamps it to ±50, `MAXPLMOVE`) |
| 1 | `sidemove` | `int8` | strafe left/right (same clamp) |
| 2..3 | `angleturn` | `int16 LE` | full turn delta (not rounded, unlike demos) |
| 4..5 | `consistancy` | `int16 LE` | checksum for desync detection |
| 6 | `chatchar` | `uint8` | chat keystroke (0 = none) |
| 7 | `buttons` | `uint8` | button bitmask |

**Demo vs. network**:

| Format | Size | angleturn | consistancy | chatchar |
|--------|------|-----------|-------------|----------|
| Demo (§4.2) | 4 bytes | high byte, rounded (lossy) | absent | absent |
| Network | 8 bytes | 16-bit (lossless) | present | present |

Because a demo omits `chatchar`, a recorded net game plays back without its
chat messages. Chat does not touch the simulation, so playback stays in sync.

---

## 11. Endianness and alignment doctrine

Source: `engine/core/m_swap.h`, `engine/core/m_swap.c`

### 11.1 Everything is little-endian

Every multi-byte WAD field (header, directory, map lumps, PNAMES, TEXTURE1/2)
is stored **little-endian**. `m_swap.h` defines:

```c
#ifdef __BIG_ENDIAN__
short  SwapSHORT(short);
long   SwapLONG(long);
#define SHORT(x)  ((short)SwapSHORT((unsigned short)(x)))
#define LONG(x)   ((long)SwapLONG((unsigned long)(x)))
#else
#define SHORT(x)  (x)   // identity on little-endian hosts and wasm
#define LONG(x)   (x)
#endif
```

On x86 and wasm `SHORT`/`LONG` are identity. Every map lump read and the WAD
directory parse go through them. `m_swap.c` implements `SwapSHORT`/`SwapLONG`
for big-endian builds.

`m_swap.h` also provides `read_le16`/`read_le32`, which assemble a value from
bytes. They are correct on any host and at any alignment, and on a
little-endian host compile to a single load, so the wasm output is unchanged.

### 11.2 Struct packing assumptions

The engine reads many structs by pointer cast over WAD data, for example
`(wadinfo_t *)data` in `W_AddFile` and `(mapthing_t *)data` in
`P_LoadThings`. Two assumptions make that work:

1. **Unaligned access is allowed.** A lump starts at any file offset, so a
   cast struct can be misaligned. x86 and wasm (whose linear memory permits
   unaligned loads) accept that. Strict-alignment CPUs do not, which is why
   `R_InitTextures` reads `maptexture_t` through `read_le16` (§3.6).
   [bare-metal.md](bare-metal.md) §5.2 lists the remaining unaligned access
   sites.
2. **Pointers and `int` are 32 bits.** `lumpinfo_t.handle` holds a pointer in
   an `int` (§1.3), the in-memory `maptexture_t` declares the 4-byte on-disk
   `columndirectory` field as a pointer, and savegames store pointers as
   integers. wasm32 meets this, and the native builds compile with `-m32`.

The savegame code pads to 4-byte boundaries (§11.3) before each `player_t`,
`mobj_t` and special-thinker struct, because those in-memory structs contain
pointer-size fields.

### 11.3 Savegame alignment

```c
#define PADSAVEP() save_p += (4 - ((int)save_p & 3)) & 3
```

Applied before each `player_t`, `mobj_t` and special-thinker record. It adds
0-3 padding bytes to bring `save_p` to the next 4-byte boundary. The rule
reads the buffer's address, not the file offset; both the buffer a save is
written in and the zone block it is loaded into are 4-byte aligned, so the
padding follows the file offset. A reader must apply the same rule or it
misreads every later record.

### 11.4 Big-endian port checklist

The `be-cross` leg runs the freestanding core 13/13 against the goldens on
big-endian PowerPC, and `n64-demos` does the same on the emulated N64 (MIPS,
big-endian). What a big-endian port needs:

1. **`__BIG_ENDIAN__` must be defined.** clang (and `zig cc`) defines it on
   PowerPC; GCC does not define it on MIPS, so the N64 Makefile passes
   `-D__BIG_ENDIAN__`. Without it the swap path compiles out silently and WAD
   data is read byte-reversed.
2. Structs read by cast and then accessed field by field through
   `SHORT()`/`LONG()` need no other handling.
3. BLOCKMAP is swapped in place by `P_LoadBlockMap`'s loop (§2.10), so it
   follows from item 1.
4. Savegames hold `player_t`, `mobj_t` and the thinker structs in native byte
   order. A save is not portable between hosts of different endianness or
   pointer width.
5. `mus_opl.c` is byte-order safe. The MUS header is parsed byte by byte, and
   `load_bank` reads GENMIDI's 16-bit `flags` and `offset` through `SHORT()`
   (§8.1; until 2026-10-08 they were read natively and
   `tools/freestanding/fs_mus.c` swapped them after the fact). `be-cross`
   compiles it for PowerPC through `fs_mus.c` and requires doom-demo4's synth
   and mixer hashes to equal the x86 reference; with the swap removed it
   fails. The N64 build still stubs sound.
