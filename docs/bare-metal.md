# DOOM bare-metal port contract

What this repo's DOOM core demands from a platform, stated precisely enough
that an embedded developer can plan a port (ESP32-class or smaller) from this
document plus [engine-archaeology.md](engine-archaeology.md),
[renderer.md](renderer.md), [playsim.md](playsim.md),
[formats.md](formats.md) and [perf.md](perf.md) before reading the source.

Three platform layers in the repo implement the contract. Each is a reference
implementation a port can copy from:

| Layer | Where | What it shows |
|---|---|---|
| Browser | `engine/web/` | the shipped port (wasm32) |
| Hosted freestanding (`fs-doom`) | `tools/freestanding/` | the core on a static arena, a byte-out and a preloaded WAD blob, with no OS file I/O below the shim. 13/13 golden demos bit-identical on x86 `-m32` (leg `freestanding-sim`), 32-bit ARM under qemu (`arm-cross`) and big-endian PowerPC under qemu (`be-cross`) |
| Nintendo 64 | `tools/n64/` | OS-less on libdragon: 93.75 MHz big-endian MIPS, 4 MiB RDRAM, the IWAD read in place from cartridge space. 13/13 (`n64-demos`; see [retro.md](retro.md) §2) |

Code is cited by function name where a line number would go stale.

---

## Contents

1. [The platform contract](#1-the-platform-contract)
2. [Memory map for constrained targets](#2-memory-map-for-constrained-targets)
3. [Timing contract](#3-timing-contract)
4. [Table strategy for ROM targets](#4-table-strategy-for-rom-targets)
5. [Endianness, alignment, and integer-width portability](#5-endianness-alignment-and-integer-width-portability)
6. [What this repo already proves](#6-what-this-repo-already-proves)
7. [ESP32 sketch](#7-esp32-sketch)
8. [The libc surface](#8-the-libc-surface)

---

## 1. The platform contract

The contract spans five headers:

| Header | What the core needs from it |
|---|---|
| `engine/core/i_system.h` | timing, zone memory, screen-buffer allocation, error, quit, startup hook, base ticcmd |
| `engine/core/i_video.h` | display |
| `engine/core/i_sound.h` | audio (may be all stubs) |
| `engine/web/web.h` | the file registry (`W_WebFile`, `W_WebFileExists`, `Web_FileLen`, `Web_FileCopy`, `Web_FileCopyN`, `Web_FileWrite`), `ZONESIZE`, and the `D_DoomFrame` declaration |
| `engine/web/perf.h` | per-stage timing counters (`web_perf_*`) and `web_perf_now()` |

`d_main.c`, `m_misc.c`, `m_menu.c` and `w_wad.c` include `web.h`
unconditionally. `d_main.c`, `r_main.c`, `r_bsp.c`, `r_plane.c`, `r_draw.c`,
`p_map.c` and `p_telept.c` include `perf.h` unconditionally. A port supplies
its own copy of both headers. `tools/freestanding/web.h` and
`tools/freestanding/perf.h` are minimal mirrors, and
`tools/freestanding/perf.c` and `tools/n64/perf_n64.c` define the counters.
`web_perf_now()` may return a cycle count, a microsecond clock or a constant;
nothing in the simulation reads it.

Beyond the headers, a port replaces `engine/core/d_net.c` (§1.9) and provides
the libc symbols listed in §8. §1.1 to §1.10 cover the `i_system.h`,
`i_video.h` and `i_sound.h` functions.

### Entry points the platform calls

The core has no main loop of its own. `D_DoomLoop` (d_main.c) only finishes
initialisation (it calls `I_InitGraphics`) and returns, so the platform drives
the game:

1. Make the WAD reachable through the file registry. The web layer registers
   files from JS; `tools/freestanding/files.c` serves one preloaded blob.
2. Call `D_DoomMain()` once. `IdentifyVersion` probes the registry by name, in
   the order `doom2f.wad`, `doom2.wad`, `plutonia.wad`, `tnt.wad`, `doomu.wad`,
   `doom.wad`, `doom1.wad`, and the name decides the game mode: the Ultimate
   Doom IWAD is `retail` only when presented as `doomu.wad`. `D_DoomMain` then
   loads the WAD, initialises every subsystem and returns.
3. Call `D_DoomFrame()` once per display frame. Each call runs every tic that
   is due (`TryRunTics`, §3.2), updates positional sound, renders one frame
   into `screens[0]` and calls `I_FinishUpdate`.
4. Deliver input between frames with `D_PostEvent` (§1.7).

`tools/freestanding/i_main.c` is the smallest complete driver: it loads the
WAD, calls `D_DoomMain`, then loops on `D_DoomFrame` and hashes the game state
after every tic.

### 1.1 Timing — MUST implement

```c
// i_system.h
int I_GetTime(void);
```

**Callers**: `TryRunTics` and `NetUpdate` in the platform's `d_net.c`
(several times per frame), the wipe (`D_WipeFrame`, d_main.c), and the
timedemo bookkeeping in g_game.c.

**Contract**: return the number of whole game tics elapsed since a fixed
origin. The unit is 1/35 second (`TICRATE = 35`, doomdef.h), so a tic is
28.57 ms.

**Web implementation** (`engine/web/i_system.c`):
`(int)(emscripten_get_now() * TICRATE / 1000.0)`, with module load as the
origin.

**Bare-metal**: any monotonic counter with at least 35 Hz resolution works. A
hardware timer interrupt at 35 Hz (or faster, divided down) incrementing an
integer is the canonical form. The count must not wrap within a session: a
signed 32-bit count at 35 Hz wraps after about 710 days.

**Precision**: the core is adaptive (§3), so the correct integer tic count on
each call is enough. Sub-tic precision matters only for render interpolation:

```c
// i_system.h (webdoom addition)
int I_GetTimeFrac(void);
```

**Contract**: the fraction of a tic elapsed since the simulation last
advanced, as a `fixed_t` in [0, FRACUNIT]. `R_SetupFrame` (r_main.c) reads it
only when `smoothrender` is set, and uses it to interpolate positions between
the last two tics. The web version lives in `engine/web/d_net.c` and clamps
to one tic, so a stalled simulation holds still. A port without interpolation
can return `FRACUNIT` always, or clear `smoothrender`; either way the renderer
shows end-of-tic positions, as vanilla does. **MAY stub**.

### 1.2 Error — MUST implement

```c
void I_Error(char *error, ...);
```

**Contract**: format and report the message, then never return. Spin, trap,
reboot or `abort()`.

Two callers need more than a halt:

- **Timedemo end.** `G_CheckDemoStatus` (g_game.c) ends a `-timedemo` run by
  calling `I_Error("timed %i gametics in %i realtics", ...)`. A port that
  replays demos must recognise this message as success.
  `tools/freestanding/i_system.c` matches it with `sscanf` and `longjmp`s back
  to `main`, which then reports the trace.
- **Zone exhaustion.** `Z_Malloc` reports a failed non-purgeable allocation
  through `I_Error` (§2.2).

**Web implementation** (`engine/web/i_system.c`): formats into a 512-byte
buffer, hands the text to `Module.onDoomError`, then calls `abort()`.

### 1.3 Zone memory — MUST implement

```c
byte* I_ZoneBase(int *size);
```

**Contract**: called once at startup by `Z_Init`. Return a pointer to one
contiguous block and set `*size` to its length. The zone allocator owns every
byte of it from then on. The block must be at least 4-byte aligned: `Z_Malloc`
rounds sizes to 4 bytes, so every lump copy inherits the base alignment
(§5.2).

**Implementations**:

| Layer | Zone | Source |
|---|---|---|
| web | `malloc(ZONESIZE)`, 4 MiB; `I_Error` if the allocation fails | `engine/web/i_system.c`, `ZONESIZE` in `engine/web/web.h` |
| fs-doom | static 8 MiB arena (`FS_ZONE_SIZE`, overridable with `-DFS_ZONE_SIZE_OVERRIDE=N`) | `tools/freestanding/i_system.c`, `fs_platform.h` |
| N64 | static 2.5 MiB arena (`N64_ZONE_KB ?= 2560`) | `tools/n64/i_system_n64.c`, `tools/n64/Makefile` |

`malloc` is not required. §2.2 sizes the zone.

### 1.4 Video — MUST implement (two functions; the rest may be empty)

```c
void I_InitGraphics(void);        // called once, at the end of D_DoomMain
void I_SetPalette(byte* palette); // called on every palette change
void I_FinishUpdate(void);        // called after every rendered frame
void I_UpdateNoBlit(void);        // MUST exist; MAY be empty
void I_ShutdownGraphics(void);    // called on quit; MAY be empty
```

**`I_InitGraphics`**: initialise the display. `D_DoomLoop` calls it after
`V_Init` has allocated the screen buffers, so this is also the place to
repoint `screens[0]` at a buffer of the port's choosing (§1.5). The web
version is empty.

**`I_SetPalette(byte* palette)`**:

- `palette` points to 768 bytes: 256 entries of R, G, B, one byte each. It is
  one of the 14 palettes in the `PLAYPAL` lump (14 × 768 = 10,752 bytes;
  formats.md §3.3), already selected by the caller.
- Callers: `ST_doPaletteStuff` (st_stuff.c) on every damage flash, bonus
  pickup or radiation-suit change, `ST_Stop`, `D_Display` and the gamma key
  (F11) in `M_Responder`. In practice a few times per level and a handful per second in
  combat.
- **Contract**: store or apply the palette. The web version gamma-corrects
  through `gammatable[usegamma]` into a 768-byte `webpalette` static and bumps
  a version counter the page polls. It clamps `usegamma` to 0..4 first,
  because the config file sets it with no range check. A port should do the
  same clamp, then either load hardware palette registers or keep a software
  table for the blit.

**`I_FinishUpdate`**:

- Called by `D_Display` (d_main.c) after every rendered frame.
- **Contract**: present `screens[0]`, which holds 64,000 palette indices,
  converting each through the palette set by the last `I_SetPalette`. The core
  never swaps `screens[0]` mid-frame, so double-buffering is optional.
- The web version is empty. JS reads `screens[0]` in place through
  `web_framebuffer()` and the palette through `web_palette()` after
  `D_DoomFrame` returns, uploads the buffer as a texture, and the fragment
  shader swaps the axes (`client/js/video.js`).

**Framebuffer layout**:

```
screens[0]:  byte[320 * 200] = 64,000 bytes   palette indices, COLUMN-major:
             pixel (x, y) is screens[0][x * SCREENHEIGHT + y]
```

The layout is column-major, which differs from vanilla's row-major buffer.
`R_InitBuffer` (r_draw.c) builds `columnofs[x] = x * SCREENHEIGHT` and
`ylookup[y] = screens[0] + y`, so a wall or sprite column is a run of
consecutive bytes and a floor span steps 200 bytes per pixel. The status bar
(`screens[4]`) and the view-border background (`screens[1]`) use the same
stride. The browser uploads the buffer without a copy because of this. A port
inherits it: the blit transposes, or the display controller scans in column
order (many SPI LCD controllers can swap row and column addressing).

`screens` is `byte* screens[5]` in v_video.c, all NULL until `V_Init`
assigns the first four (§1.5). `ST_Init` allocates `screens[4]` from the zone.

### 1.5 Screen buffer allocation — MUST implement

```c
byte* I_AllocLow(int length);
```

**Caller**: `V_Init` (v_video.c), once, from `D_DoomMain`, with
`length = SCREENWIDTH * SCREENHEIGHT * 4` = 256,000 bytes. `V_Init` divides
the block into four 64,000-byte regions and assigns them to `screens[0]`
through `screens[3]`.

**Contract**: return a zero-initialised, writable block of exactly `length`
bytes that stays valid for the whole session. The four regions are used as
follows, and the last use is why the block must stay contiguous:

| Region | Used for |
|---|---|
| `screens[0]` | the render target (§1.4) |
| `screens[1]` | view-border background (`R_FillBackScreen`), intermission background |
| `screens[2]`, `screens[3]` | wipe start and end frames (f_wipe.c); `screens[2]` is also the screenshot scratch |
| `screens[1] + 0x4000` onward | the savegame workspace: `G_DoSaveGame` builds the save there, spilling into `screens[2]` and `screens[3]` (175,616 bytes of room) |

**Web implementation** (`engine/web/i_system.c`): `calloc(1, length)`, with
`I_Error` on a negative length or a failed allocation.

**Placement on a constrained target**: the block is 250 KiB.

- **One region** (simplest): allocate the whole block in PSRAM or SRAM.
- **Static reservation**: return a `static byte fb_block[256000]` placed by
  the linker in the chosen memory. ESP-IDF places PSRAM-resident BSS with
  `__attribute__((section(".psram_bss")))`.
- **Hybrid** (recommended for ESP32-S3): keep the 256,000-byte block in PSRAM
  and repoint only `screens[0]` at a 64,000-byte buffer in internal SRAM,
  from `I_InitGraphics`. `tools/freestanding/i_video.c` does exactly this with
  a static buffer. Keep the replacement 4-byte aligned: the wipe casts screen
  buffers to `short*`.

The hybrid is the main mitigation for the PSRAM bottleneck in §7.3.

### 1.6 Startup hook — MUST implement (may be empty)

```c
void I_Init(void);
```

**Caller**: `D_DoomMain` (d_main.c), after `R_Init` and before
`D_CheckNetGame` and `S_Init`.

`I_Init` is the only place the sound subsystem is started. Without a call to
`I_InitSound` here, the §1.8 sound functions still have to link but are never
initialised.

**Web implementation**: `I_Init` calls `I_InitSound()` and nothing else.

**Contract**: platform initialisation needed between `D_DoomMain`'s start and
the first frame. A port with no audio may leave the body empty; the symbol
must exist.

### 1.7 Input — MUST implement (one function; the rest may be empty)

```c
ticcmd_t* I_BaseTiccmd(void);
void I_StartFrame(void);   // MAY be empty
void I_StartTic(void);     // MAY be empty (poll input here)
```

**`I_BaseTiccmd`**: `G_BuildTiccmd` (g_game.c) starts every ticcmd from a
copy of this. For a local game it is a zeroed static; the web version returns
`&emptycmd`.

**`I_StartTic`**: called once for each tic `NetUpdate` builds, before
`D_ProcessEvents`. It is the place to poll a keypad or GPIO and post events.
The web version is empty because events arrive from JS callbacks.

**Event posting**: call `D_PostEvent(event_t *ev)` with `ev_keydown`,
`ev_keyup`, `ev_mouse` or `ev_joystick` events. The default bindings are in
`m_misc.c`'s `defaults[]` table (`key_right`, `key_fire` and so on). A minimal
controller needs eight lines: forward, back, turn left, turn right, strafe,
fire, use, run.

### 1.8 Sound — MAY fully stub; MAY partially implement

Audio is optional and the simulation never reads it. Every simulation gate in
this repo runs with sound stubbed. `I_Init` (§1.6) needs to call
`I_InitSound()` only if sound is implemented.

**Full stub** (no audio, correct simulation), as in
`tools/freestanding/i_sound.c`:

```c
void I_InitSound(void) { I_InitMusic(); }
void I_UpdateSound(void) {}
void I_SubmitSound(void) {}
void I_ShutdownSound(void) {}
void I_SetChannels(void) {}
int  I_GetSfxLumpNum(sfxinfo_t *sfx) {
    char name[9];
    sprintf(name, "ds%s", sfx->name);
    return W_CheckNumForName(name);
}
int  I_StartSound(int id, int vol, int sep, int pitch, int pri) { return 0; }
void I_StopSound(int handle) {}
int  I_SoundIsPlaying(int handle) { return 0; }
void I_UpdateSoundParams(int handle, int vol, int sep, int pitch) {}
void I_InitMusic(void) {}
void I_ShutdownMusic(void) {}
void I_SetMusicVolume(int vol) {}
void I_PauseSong(int handle) {}
void I_ResumeSong(int handle) {}
int  I_RegisterSong(void *data, int len) { return 0; }
void I_PlaySong(int handle, int looping) {}
void I_StopSong(int handle) {}
void I_UnRegisterSong(int handle) {}
```

**Sound effects only**: implement `I_StartSound` to feed PCM to a DAC. Effect
lumps are DMX format (formats.md §6): an 8-byte header, then unsigned 8-bit
PCM at 11,025 Hz with 16 pad bytes at each end, so the real samples are bytes
`[24 .. 24 + num_samples - 33]`. Convert to signed with `sample - 128`.
Volume, separation and pitch arrive on every `I_StartSound` call and change
through `I_UpdateSoundParams`. Up to `snd_channels` sounds play at once
(default 3, `m_misc.c`).

**Calling frequency**: `D_DoomFrame` calls `S_UpdateSounds` once per frame,
after the tics run. It calls `I_UpdateSoundParams` for moving sources;
`I_StartSound` is called as game events start sounds. Sound code draws on
`M_Random`, never `P_Random`.

**Parameter meaning** (engine-archaeology.md §10):

- `vol`: 0..127 (`S_MAX_VOLUME`, s_sound.c). Linear from silent at 1,200 map
  units (`S_CLIPPING_DIST`) to full at 160 or closer (`S_CLOSE_DIST`).
- `sep`: 0..255, 128 centred. `S_AdjustSoundParams` computes
  `128 - (FixedMul(S_STEREO_SWING, finesine[angle]) >> FRACBITS)` with a
  swing of 96.
- `pitch`: 0..255, 128 (`NORM_PITCH`) unmodified. `S_StartSoundAtVolume` adds
  a random ±8 for the chainsaw and ±16 for most other sounds.

Music is separate: the web layer runs the MUS-to-OPL sequencer in
`engine/web/mus_opl.c` (§3.3). The core never calls it directly; only the
platform's `I_RegisterSong` / `I_PlaySong` do.

### 1.9 Net — single-player needs a stub, not a network

`engine/core/d_net.c` cannot be compiled for a bare-metal target: it pulls in
the BSD socket path through `I_InitNetwork`, and its `TryRunTics` blocks while
it waits for tics. Every build here excludes it (`CORE_EXCLUDE` in
`engine/Makefile`, with `i_main.c`, `i_net.c`, `i_sound.c`, `i_system.c` and
`i_video.c`) and links a replacement that provides `TryRunTics`, `NetUpdate`,
`D_CheckNetGame`, `D_QuitNetGame`, `I_GetTimeFrac` and the globals the core
expects (`localcmds`, `netcmds`, `nettics`, `maketic`, `ticdup`, and the
drop-in globals `web_joinTic` and `web_replaying` that g_game.c reads).

`tools/freestanding/d_net.c` is the single-player model to copy. It has no
network I/O: `D_CheckNetGame` makes player 0 the only player, `NetUpdate`
builds ticcmds from local input, and `TryRunTics` runs the due tics (§3.2).
`engine/web/d_net.c` is the multiplayer version.

For multiplayer, the relay architecture is described in
[netcode.md](netcode.md). The lockstep protocol is transport-agnostic and
could run over UART, SPI or any byte stream.

### 1.10 Remaining platform symbols — MAY stub

These are declared in `i_system.h` or `i_video.h` and must link in every
build. None has a required side effect for a headless single-player port.

| Symbol | Called from | Web body | Bare-metal stub |
|--------|-------------|----------|-----------------|
| `void I_Quit(void)` | `G_CheckDemoStatus` (single-demo playback end), `M_QuitResponse` | quits the net game, shuts sound down, saves config, signals JS `onQuit`, `emscripten_force_exit(0)` | reset or spin; must not return |
| `void I_Tactile(int on, int off, int total)` | `P_DamageMobj` | empty (rumble hook) | `{}` |
| `void I_WaitVBL(int count)` | `M_QuitResponse` (the pause before quitting) | empty: never block the browser | `{}`, or a delay of `count` 70 Hz ticks |
| `void I_ReadScreen(byte* scr)` | the wipe (`wipe_StartScreen`, `wipe_EndScreen` in f_wipe.c) | `memcpy(scr, screens[0], 64000)` | the same copy |
| `void I_BeginRead(void)`, `void I_EndRead(void)` | nothing in the core (disk-LED hooks) | empty | `{}` |

`I_ReadScreen` is the one that matters: the melt wipe captures the start and
end frames with it. A port that stubs it to `{}` gets garbage wipes; the
simulation is unaffected either way. The copy is raw column-major bytes, which
is what the wipe expects. Screenshots (`M_ScreenShot`) untranspose
`screens[0]` themselves.

A few core files also call libc directly, outside the platform layer:
`W_AddFile` (w_wad.c) grows `lumpinfo` with `realloc` once per WAD added,
`M_ScreenShot` (m_misc.c) probes file names with `access`, and `D_DoomMain`
calls `mkdir` under `-cdrom`. `realloc` must really work (a NULL return is an
`I_Error`); the other two can be stubs. §8 lists the whole libc surface.

---

## 2. Memory map for constrained targets

Sizes are binary (KiB, MiB). Where a figure comes from the wasm build it says
so: wasm and a native 32-bit target share pointer and integer widths, so data
and BSS sizes carry over closely, but code size does not.

### 2.1 Static segment

The wasm linear-memory layout (perf.md §3):

| Region | Size |
|--------|------|
| C shadow stack | 1 MiB (`-sSTACK_SIZE=1MB`, engine/Makefile) |
| Initialised data (DATA) | ~74 KiB (perf.md §1) |
| Zero-initialised BSS | ~379 KiB (DATA + BSS = 453 KiB) |
| **`__heap_base`** | **1.44 MiB** (1,512,384 bytes) |

BSS is dominated by renderer scratch arrays: `visplanes[128]` (~83 KiB),
`vissprites[1024]` (~50 KiB), `openings[20480]` (40 KiB) and
`drawsegs[256]` (~12 KiB). Only `MAXVISSPRITES` (1024, vanilla 128) and
`MAXSEGS` (64, vanilla 32) are raised above vanilla; the visplane, opening
and drawseg limits are vanilla's. The trig tables are BSS too (§4.1). The
screen buffers (250 KiB) are not in BSS; `I_AllocLow` places them (§1.5).

**What a native target needs**: 453 KiB of writable data and BSS, plus a
stack, plus the 250 KiB screen block. One MiB of stack is proven enough:
`make check-stack-1m` in `tools/freestanding/` replays all 13 demos, rendering,
under `ulimit -s 1024`. The true requirement is lower but not measured. With
a 1 MiB stack the floor is **1.44 MiB** (`__heap_base`), and **~1.68 MiB**
with the screen buffers. That is before the zone and the WAD. The budget
tables below use these figures.

The N64 build at `7f5c682`, measured with its toolchain, puts `.data + .bss`
at 3,373,068 bytes, of which 2,621,440 are the zone arena and 256,000 the
screen block ([retro.md](retro.md) §2, Memory).

### 2.2 Zone (heap)

Peak non-purgeable zone use, from the wasm build's attract demos
(perf.md §2):

| IWAD | Peak zone used (non-purgeable) |
|------|-------------------------------|
| doom.wad | 0.91 MiB |
| doom2.wad | 1.00 MiB |
| tnt.wad | 1.29 MiB |
| plutonia.wad | **1.36 MiB** (worst: demo3) |

That is live `PU_STATIC` and `PU_LEVEL` data. Purgeable cache blocks
(composite textures, flats, sprite patches) come on top and are reclaimed
under pressure.

`fs-doom` built with `-DWEB_PERF_ZONE_STATS` and run with `-zonestats <file>`
measures the same thing with rendering on. Its non-purgeable peak is
0.981 MiB (tnt demo2), its total high-water mark in a 32 MiB zone is
10.485 MiB (tnt demo3), and at 4 MiB the demos evict 248 to 1,397 `PU_CACHE`
blocks each with all 13 simulation hashes unchanged. The two instruments
disagree on the non-purgeable peak; size from the larger.

**What degrades under pressure**: when `Z_Malloc` cannot satisfy a request it
purges `PU_CACHE` blocks and the data is regenerated on next use: textures
are recomposited from their patches (`R_GenerateComposite`, renderer.md §8.1)
and lumps are re-read. The game continues; it only runs slower.

**What breaks**: `PU_STATIC` and `PU_LEVEL` blocks are never purged. When a
non-purgeable allocation cannot be satisfied, `Z_Malloc` calls
`I_Error("Z_Malloc: failed on allocation of %i bytes")`.

**Sizing**:

- **4 MiB is what ships.** The browser build's zone is 4 MiB (`ZONESIZE` in
  `engine/web/web.h`); every sim, render and net leg runs on it. The worst
  attract-demo peak is 34% of it.
- **2.5 MiB passes the simulation gate** on N64 (`N64_ZONE_KB = 2560`, sim
  only: the N64 gate runs `-nodraw`). 512 KiB fills during the first attract
  demo and `Z_Malloc` fails at gametic 171.
- Pathological PWAD maps (many large textures, many monsters) may need 8 MiB,
  which is what `fs-doom` uses.

For a first bring-up use 4 MiB, or 8 MiB if memory allows, and replay the 13
golden demos (§6.3). An `I_Error` from `Z_Malloc` means the zone is too small
for that map set.

### 2.3 WAD residency strategies

`W_CacheLumpNum` (w_wad.c) is the only lump read path. A cache hit returns the
zone copy; a miss allocates a zone block and calls `W_ReadLump`, which copies
the bytes out of the WAD. Wall texture columns go through it on every frame
(`R_GetColumn`, an inline in r_data.h, renderer.md §8.2), and map data goes
through it at level load. The WAD must therefore support **random byte-range
access by lump file position and size**.

In this port a lump's `handle` is a pointer straight into the registered WAD
buffer (`W_AddFile`: `handle = (int)(data + filepos)`), and `W_ReadLump` is a
`memcpy` from it.

#### (a) Full IWAD in PSRAM (~16 MiB class)

Load the whole WAD into memory before `D_DoomMain`. Lump access is then a
`memcpy` with no latency beyond the memory's own.

IWAD sizes:

| IWAD | Bytes | MiB |
|------|-------|-----|
| doom.wad (Ultimate Doom) | 12,408,292 | 11.83 |
| doom2.wad | 14,604,584 | 13.93 |
| plutonia.wad | 17,420,824 | 16.61 |
| tnt.wad | 18,195,736 | **17.35** (largest) |

**Budget, doom.wad in PSRAM**:

| Region | Size |
|--------|------|
| Static (stack + DATA + BSS, = `__heap_base`) | 1.44 MiB |
| Screen buffers (`I_AllocLow`) | 0.24 MiB |
| Zone | 4 MiB |
| WAD | 11.83 MiB |
| **Total** | **~17.5 MiB** |

A 16 MiB PSRAM part does not fit doom.wad this way (it is 1.5 MiB over), and
none of the commercial IWADs fit. Use (c) or (d), or the shareware WAD.

#### (b) Shareware doom1.wad (~4 MiB class)

The shareware IWAD (episode 1 only) is about 4 MiB.

| Region | Size |
|--------|------|
| Static (= `__heap_base`) | 1.44 MiB |
| Screen buffers (`I_AllocLow`) | 0.24 MiB |
| Zone | 4 MiB |
| WAD | ~4 MiB |
| **Total** | **~9.7 MiB** |

It fits in 16 MiB of PSRAM with margin, and the shareware WAD may be
redistributed. The 13 golden demos need the commercial IWADs, so a port
validating on doom1.wad records its own demos as a local golden once the
commercial set has passed elsewhere.

#### (c) Streaming from SPI flash

With no room for the WAD in RAM, it can live in SPI flash and be read on
demand. `W_ReadLump` becomes a flash read (for example
`spi_flash_read(filepos, dest, size)`) instead of a `memcpy`; `handle` then
holds a flash offset rather than a pointer. `W_CacheLumpNum` already caches on
top of `W_ReadLump`, so only the raw read changes.

The zone absorbs most of the access pattern. A 4 MiB zone over a 1.36 MiB
non-purgeable peak leaves about 2.6 MiB of purgeable cache, which holds a
typical map's textures and flats across frames; flash reads happen on misses.

Latency, estimated: at 80 MHz a 4 KiB read is a few milliseconds. The first
frame of a map, with a cold cache, stalls; later frames run from the zone.
Touching the level's textures at load time (as `R_PrecacheLevel` does when
precaching is on) moves the stall to the load.

#### (d) XIP from flash: viable, the engine never writes the WAD

The engine never writes into the WAD buffer. Every access goes through
`W_CacheLumpNum`, which copies into the zone, so the blob can sit in
execute-in-place flash or mask ROM with no RAM cost. The BLOCKMAP byte swap in
`P_LoadBlockMap` (p_setup.c) works on the zone copy too, so this holds on
big-endian targets.

Proof: `tools/freestanding/ro-wad-check.sh` (leg `ro-wad`; also
`make ro-wad-check` in `tools/freestanding/`) builds `fs-doom` with
`WD_RO_WAD=1`, which maps the preloaded WAD with `mmap`, makes it
`PROT_READ`, and installs a SIGSEGV handler that reports any write as
`WAD-BLOB WRITE`. All 13 demos run bit-identical with no write. The N64 port
relies on the same property: it reads the 12.4 MB IWAD in place out of
cartridge space.

### 2.4 Palette and framebuffer summary

| Buffer | Size | Location |
|--------|------|----------|
| `screens[0]`, render target | 64,000 B | `I_AllocLow` block, or a port's own buffer (§1.5) |
| `screens[1]`, border and intermission background | 64,000 B | `I_AllocLow` block |
| `screens[2..3]`, wipe frames and save workspace | 64,000 B each | `I_AllocLow` block |
| `screens[4]`, status bar background | 64,000 B | zone (`PU_STATIC`) |
| `webpalette`, gamma-corrected RGB | 768 B | static BSS |
| PLAYPAL lump (14 palettes) | 10,752 B | zone (`PU_CACHE`) |
| COLORMAP lump | 8,704 B | zone (`PU_STATIC`) |

`screens[0]` holds palette indices. It is the only buffer written on every
frame, which is why placing it in internal SRAM (§1.5) is the main fix for
the §7.3 bottleneck.

---

## 3. Timing contract

### 3.1 The 35 Hz tic

`TICRATE = 35` (doomdef.h): one tic is 28.57 ms. The simulation
(`G_Ticker` → `P_Ticker`) runs exactly once per tic, and every physics
constant is calibrated to that rate: `GRAVITY = FRACUNIT` per tic²,
`SLOWDARK = 35` tics for the slow strobe's dark phase, `FASTDARK = 15`
(engine-archaeology.md §11).

The tic is discrete. When `I_GetTime` advances by N, the engine runs N
simulation steps; there is no fractional tic in the simulation.

### 3.2 Adaptive underrun behaviour

`TryRunTics` lives in the platform's `d_net.c` (§1.9). The single-player
version in `tools/freestanding/d_net.c` works like this on each call:

1. `realtics` = tics elapsed since the previous call (`I_GetTime`).
2. `NetUpdate` builds one ticcmd per elapsed tic from local input, running
   `I_StartTic` and `D_ProcessEvents` for each. It stays at most
   `BACKUPTICS/2 - 1` tics ahead of the simulation, and after a gap longer
   than a second it builds only one.
3. It runs `counts = (built tics) - gametic`, capped at `realtics + 1`. The
   web version caps at `realtics + web_inputdelay`, which defaults to 1.
4. `counts` may be 0. Nothing blocks: the frame renders the unchanged world
   and returns.

**On underrun** (rendering slower than 35 Hz), each frame runs several tics
and the simulation keeps real time. At a 10 Hz display each frame runs about
three tics. Demo playback is unaffected, because only the simulation state
matters.

**On overrun** (rendering faster than 35 Hz), most frames run 0 tics. A tight
loop calling `D_DoomFrame` as fast as possible is correct; the simulation
self-throttles through `I_GetTime`. With interpolation on (§1.1), the extra
frames are not wasted: they show positions between tics.

The core's own `TryRunTics` (engine/core/d_net.c) differs: it always runs at
least one tic and busy-waits in `NetUpdate` until that tic exists. No build
here uses it.

**`singletics`** (d_main.c): when set, `D_DoomFrame` skips `TryRunTics` and
runs exactly one tic per frame regardless of time. `G_TimeDemo` sets it for
`-timedemo`, which is how every demo gate replays deterministically. A port
bringing up its timing can use it to verify the simulation before trusting
its clock.

### 3.3 Audio timing

On the web, the OPL music sequencer (`engine/web/mus_opl.c`) steps MUS events
at 140 Hz (`MUS_RATE`, formats.md §7.3) between rendered samples; the audio
worklet pulls interleaved stereo float samples through
`web_music_render()` at the output rate (44,100 Hz or the device rate). Sound
effects are 11,025 Hz PCM (formats.md §6).

On bare metal, an I²S or DAC peripheral with a refill interrupt is the
natural fit. The sequencer can be reused as is, with the worklet's pull
replaced by a DMA callback. Sound effects are separate: `I_StartSound` hands
over a DMX PCM buffer and the platform mixes channels itself.

Audio timing is **decoupled from the simulation**. No `P_Random` call happens
in sound code, and `S_UpdateSounds` runs once per frame using `M_Random` only.
Audio can run on a second core (the ESP32-S3 has two) with no synchronisation
beyond the `I_StartSound` and `I_UpdateSoundParams` calls.

---

## 4. Table strategy for ROM targets

The master verdict ledger in engine-archaeology.md §14 classifies every
hard-coded table as **recipe** (cracked, can be regenerated), **equivalence**
(provably derivable), **irreducible** (cannot be derived) or **declarative**
(art and design data). Where each one lives decides the port's flash and RAM
budget.

### 4.1 Trig tables — boot-generate (saves ~64 KiB flash)

| Table | Entries | Size | Verdict |
|-------|---------|------|---------|
| `finesine[10240]` + `finetangent[4096]` | 14,336 | 56 KiB | **recipe** (engine-archaeology.md §1) |
| `tantoangle[2049]` | 2,049 | 8 KiB | **recipe** (engine-archaeology.md §1) |
| **Total** | 16,385 | **64 KiB** | |

**How the core does it**: `T_GenerateTables` (engine/core/tables.c), called
early in `D_DoomMain`, computes the three tables with `sin`, `tan` and `atan`
(truncated toward zero, `(i + 0.5)` phase for sine and tangent), then applies
a correction stream from `tables_fix.h` that turns the host libm's output into
the exact 1993 values. A FNV-1a checksum over all 16,385 entries
(`TABLES_CRC`) must match, or boot stops with
`I_Error("T_GenerateTables: tables differ from 1993 canon ...")`. The tables
are BSS, not DATA.

The correction stream is about 11 KiB compiled: 4,097 bytes of packed 2-bit
deltas plus 1,702 32-bit escape values (1,603 of them for `tantoangle`).
`tools/gen-tables.mjs` generates it from the wasm build against the canonical
values in `tools/golden/tables-canon.json`. The same `tables_fix.h` passes the
checksum on glibc (x86 `-m32`), musl (ARM, PowerPC) and libdragon's newlib
(N64), as the 13/13 legs on each show. A target whose libm rounds differently
fails loudly at boot rather than desyncing.

**ROM target recommendation**: keep boot generation. Net flash saving is about
64 KiB of tables minus ~11 KiB of corrections minus the generator, so ~50 KiB.
Boot cost is 16,385 libm calls plus the correction pass. Estimated: at ~50
cycles per `sin` on a 240 MHz FPU core, ~3 ms, once.

**Alternative for flash-rich targets where boot time matters**: ship the
64 KiB of final values as `const` (from `tables-canon.json`) and skip
generation. On XIP flash the tables then cost no RAM.

### 4.2 Irreducible tables — ship as ROM data

These cannot be regenerated and ship as constants:

| Table | Size | Verdict | Sim-critical? |
|-------|------|---------|---------------|
| `rndtable[256]` (m_random.c) | 256 B | irreducible: no standard PRNG produces it (all 2³² seeds searched, engine-archaeology.md §3) | YES |
| `gammatable[5][256]` (v_video.c) | 1,280 B | irreducible: no exact closed form (engine-archaeology.md §4) | no |
| `fuzzoffset[50]` (r_draw.c) | 200 B | irreducible: the fixed spectre pattern | no |

On XIP flash these cost no RAM. Without XIP, copy them to SRAM at boot.

`translationtables` (the player colour remaps) is not shipped:
`R_InitTranslationTables` (r_draw.c) computes it into a 256-byte-aligned zone
block at startup.

### 4.3 WAD-owned tables — always RAM after WAD load

These are WAD lumps: they load into the zone and a PWAD can replace them
(coloured-lighting PWADs replace COLORMAP). They cannot come from ROM alone.

| Lump | Size | Notes |
|------|------|-------|
| `COLORMAP` | 8,704 B | recipe known (engine-archaeology.md §6) but PWAD-replaceable; always load from the WAD |
| `PLAYPAL` | 10,752 B | 14 palettes × 768 B |
| `PNAMES`, `TEXTURE1/2` | variable | wall texture definitions |
| sprites, flats, sounds | variable | loaded on demand |

### 4.4 Boot-computed pointer tables — RAM only

`zlight[16][128]` and `scalelight[16][48]` are arrays of pointers into
`colormaps` (the COLORMAP lump). They hold no values of their own and are
rebuilt by `R_InitLightTables` and `R_ExecuteSetViewSize` (r_main.c):

- `zlight`: 2,048 pointers × 4 = 8 KiB
- `scalelight`: 768 pointers × 4 = 3 KiB

They hold live pointers, so they go in RAM.

### 4.5 Concrete recommendation per target class

| Target class | Trig tables | rndtable / gamma | COLORMAP | Zone |
|---|---|---|---|---|
| Flash-rich, XIP (≥ 2 MiB flash) | `const` in flash, no RAM | `const` in flash | load from WAD | 4 MiB |
| Flash-constrained (< 1 MiB flash) | boot-generate (~11 KiB of corrections) | `const`, 1.5 KiB | load from WAD | 4 MiB |
| No WAD in flash (PSRAM only) | boot-generate | `const` in flash | load from WAD | 4 MiB |

**Never replace a table lookup with a runtime transcendental in the render
loop** (engine-archaeology.md §7). A cached lookup is a few cycles; `sin` is
tens. Generate once, look up always.

---

## 5. Endianness, alignment, and integer-width portability

### 5.1 Endianness

All WAD data is little-endian (formats.md §11.1). The gate is in `m_swap.h`:

```c
#ifdef __BIG_ENDIAN__
short SwapSHORT(short);
long  SwapLONG(long);
#define SHORT(x) ((short)SwapSHORT((unsigned short)(x)))
#define LONG(x)  ((long)SwapLONG((unsigned long)(x)))
#else
#define SHORT(x) (x)   // identity on little-endian hosts and wasm
#define LONG(x)  (x)
#endif
```

Every map-lump read and directory parse goes through `SHORT()` and `LONG()`
(`P_Load*` in p_setup.c, `W_AddFile` in w_wad.c). A big-endian port needs:

1. **`__BIG_ENDIAN__` defined.** clang (and `zig cc`) predefines it on
   big-endian targets; GCC does not, so a GCC build passes
   `-D__BIG_ENDIAN__` (tools/n64/Makefile does).
2. **Nothing more for the swaps.** `m_swap.c` already implements `SwapSHORT`
   and `SwapLONG` in its big-endian branch.
3. **The BLOCKMAP swap** in `P_LoadBlockMap` swaps the whole lump in place as
   a `short[]`. It runs on the zone copy, so it is correct and leaves the WAD
   untouched (§2.3d).
4. **Savegames are not portable.** `player_t` and `mobj_t` are archived with
   `memcpy` and hold native-endian values and pointers; a save from one byte
   order does not load on the other (formats.md §11.4).
5. **MUS is already safe**: `mus_opl.c` parses its header with explicit
   `m[4] | (m[5] << 8)` arithmetic.
6. **Signed `char` is required: compile with `-fsigned-char`.** The engine
   relies on x86's signed `char`; PowerPC, ARM and MIPS ABIs default to
   unsigned, which changes demo-byte and table arithmetic and diverges the
   simulation within the first 25 tics with no crash. Every cross build here
   passes the flag (`be-build.sh`, `tools/n64/Makefile`).

With these, the freestanding core replays 13/13 golden demos bit-identically
on big-endian PowerPC and MIPS under qemu-user (`be-check.sh`; PowerPC is the
default target, MIPS with `BE_TARGET=mips-linux-musleabi`) and on the N64.
The trig tables pass their boot checksum on every one of them.

### 5.2 Alignment — known unaligned access sites

On strict-alignment targets (Cortex-M0/M3, MIPS) a multi-byte load from an
address that is not a multiple of its size traps. qemu-user delivers SIGBUS
for MIPS, so the 13-demo corpus on MIPS exercises every site below.

One rule decides most cases. Lumps read through `W_CacheLumpNum` land in zone
blocks, which are 4-byte aligned (§1.3), so a field at a 4-aligned offset
from a lump's start is safe. Risk comes from arbitrary offsets inside a lump,
from the raw WAD buffer, and from buffers the core casts.

| Site | Access | Status |
|------|--------|--------|
| `R_InitTextures` (r_data.c): `maptexture_t` at an offset read from the TEXTURE1/2 directory | `int16`/`int32` fields at an arbitrary offset | **faulted on ARM and MIPS; fixed**: read with `read_le16`/`read_le32` (m_swap.h) and a byte-wise name copy |
| `R_InitSpriteDefs` (r_things.c): sprite names compared as `*(int*)` | 4-byte load from string literals (alignment 1 in `.rodata`) | **faulted; fixed** with `read_le32` on both sides |
| platform screen buffers cast to `short*` by the wipe | 2-byte loads | **faulted in fs-doom; fixed** with `__attribute__((aligned(4)))`; a port's own buffers need the same |
| `patch_t.columnofs[]` at offset 8 (`R_GenerateLookup`, `R_GenerateComposite`, `R_DrawVisSprite`, `V_DrawPatch`, `V_DrawPatchFlipped`) | `int32` array | safe: the patch is a zone copy, so offset 8 is aligned. Hit for every visible column, so it is the site to watch if lump copies ever stop being aligned |
| `P_LoadNodes` (p_setup.c): `mapnode_t` cast | `int16` fields | safe: zone copy |
| `W_AddFile` (w_wad.c): `wadinfo_t` header and `filelump_t` directory | `int32` fields in the raw WAD buffer; the directory sits at an arbitrary `infotableofs` | depends on the WAD: aligned in the IWADs, unguaranteed for PWADs |

`read_le16` and `read_le32` assemble the value from bytes. On little-endian
hosts the compiler folds them back to a single load, so the simulation and
render goldens are unchanged on wasm.

**Mitigation for the remaining sites on a strict-alignment target**:

- **Option A**: on such targets, define `LONG()` and `SHORT()` in terms of
  `read_le32`/`read_le16` taking the field's address, so every WAD-sourced
  read is byte-safe.
- **Option B**: keep lump data aligned. `W_CacheLumpNum` already copies into
  4-byte-aligned zone blocks; copy the WAD directory into an aligned buffer
  before parsing it.

The ESP32-S3's LX7 handles unaligned loads in hardware, so neither is needed
there; they matter for Cortex-M0/M3 and MIPS.

### 5.3 Integer width assumptions

`fixed_t` is `int` (32-bit, m_fixed.h), `angle_t` is `unsigned`, and
`FRACUNIT = 0x10000`.

**32-bit pointers are required.** `lumpinfo_t.handle` is an `int` that holds
a pointer into the WAD buffer (`W_AddFile`: `handle = (int)(data + filepos)`),
and savegames archive structs that contain pointers. Every build here is
ILP32 or has 32-bit pointers: wasm32, x86 `-m32`, ARM32, PowerPC32 and the
N64's libdragon ABI. An LP64 build truncates every lump handle. A port to a
64-bit-pointer target must widen `handle` first.

**FixedDiv** (engine-archaeology.md §2 and §7). The shipped form, in
m_fixed.h, is:

```c
static inline fixed_t FixedDiv (fixed_t a, fixed_t b)
{
    if ((abs(a) >> 14) >= abs(b))
        return (a ^ b) < 0 ? MININT : MAXINT;
    return (fixed_t) (((long long) a << FRACBITS) / b);
}
```

The guard keeps `|a/b|` below 2¹⁴, so the 16.16 result fits in 31 bits. Over
that domain the integer form is bit-identical to linuxdoom's `double` path
and to the DOS original's 64/32 `idiv` (proven in engine-archaeology.md §2,
reproduced by `tools/archaeology/fixeddiv-proof.c`). A port may use whichever
is faster on its hardware.

**The 64-bit divide problem**: Cortex-M0/M3/M4, LX7 and the N64's R4300 have
no 64-by-32 divide. `((long long)a << 16) / b` becomes a library call
(`__aeabi_ldivmod` on ARM), roughly 40 to 80 cycles. `FixedDiv` runs in
`R_ScaleFromGlobalAngle` for every wall segment, in sprite projection and in
`P_PathTraverse`.

Measured on wasm with a 2×10⁸-iteration microbench
(`tools/golden/bench-baseline.json`, `primitiveMicrobench`): the `int64` path
is 16% faster than `double` on a Pi 5, 2.8× slower on a Kaby Lake laptop
(i5-8350U), and 6% slower on an AMD Bobcat. Neither form wins everywhere. On
Cortex-M without an FPU both are software; on M4F/M7 the hardware divider may
win. Profile both at bring-up; the demo traces prove correctness either way.

**Other widths**:

- `int` is 32-bit throughout. A 16-bit-`int` target (AVR) does not port
  without major changes; Cortex-M is ILP32 and safe.
- `boolean` is `int` (doomtype.h). Nothing depends on bit-fields.
- `short` reads 16-bit WAD fields. Check `sizeof(short) == 2`.
- `long` is assumed 32-bit in `LONG()` and `SwapLONG`. On a 64-bit `long` the
  macros still work on little-endian hosts but waste bits.

---

## 6. What this repo already proves

### 6.1 The port lives in the platform layer

`engine/core/` is linuxdoom-1.10 with a bounded set of edits. Edits carry a
`webdoom` comment; `grep -rn "// webdoom" engine/core/` finds 132 such lines
(a lower bound, since not every edit uses that exact form). They fall into
these groups:

| Group | Examples |
|-------|---------|
| Render interpolation snapshots | `p_mobj.c`, `p_tick.c`, `R_SetupFrame` (r_main.c) |
| Raised limits | `MAXSEGS` 32→64 (r_bsp.c), `MAXVISSPRITES` 128→1024 (r_things.h), `MAXSPECIALCROSS` 8→64 (p_local.h), `SAVEGAMESIZE` 0x2c000→0x80000 (g_game.c) |
| Overflow clamps | intercepts (`p_maputl.c`), spechit (`p_map.c`) |
| Netplay and timing | `BACKUPTICS` and drop-in support (d_net.h, g_game.c) |
| Platform hooks | the file registry in `W_AddFile`/`W_ReadLump`, `T_GenerateTables`, `D_DoomFrame` |
| Robustness for real-world PWADs | HACX missing sprite frames (r_things.c), SIGIL's fifth episode (m_menu.c) |
| Framebuffer layout | column-major `screens[]` (r_draw.c, v_video.c, st_stuff.c, f_wipe.c) |

A bare-metal port replaces `engine/web/` and reuses the core unchanged. The
N64 and freestanding layers do exactly that.

### 6.2 The headless path proves video, audio and input are optional

`tools/demo-test.mjs` replays demos with `-nodraw`, empty `I_FinishUpdate`
and no audio installed. The freestanding layer has no display or audio
device at all, and the N64 gate runs headless too. All of them replay the
13 demos (44,580 tics) bit-identically, so **the simulation is independent of
the display and audio layers**. A port can bring up the simulation first and
add display and audio later.

On wbox (AMD G-T56N Bobcat, ~1 GHz), the headless wasm simulation runs at an
average of 19,994 tics per second over the three doom.wad attract demos
(`tools/golden/bench-baseline.json`, `simFpsNodraw`). Real time needs 35, so
the simulation uses about 0.2% of that CPU. The renderer is the workload.

### 6.3 The 13-demo golden gate is the port-validation tool

`tools/golden/` holds per-tic hashes of the simulation for all 13 IWAD attract
demos: doom.wad 4 demos, doom2.wad 3, tnt.wad 3, plutonia.wad 3. Each file
(`<iwad>-<demo>.json`) has `tics` and `trace`, eight hex digits per tic. The
hash is `web_state_hash()` (engine/web/i_main.c):

```c
unsigned h = 0x9e3779b9u ^ (unsigned)gametic;
h = (h ^ (unsigned)prndindex) * 0x01000193u;
for each player in game with a mobj:
    h = (h ^ mo->x) * 0x01000193u;   then y, angle, health the same way
for each sector:
    h = (h ^ floorheight) * 0x01000193u;   then ceilingheight
h = (h ^ number_of_thinkers) * 0x01000193u;
return (int)h;
```

`prndindex` is the `P_Random` cursor, so any divergence in gameplay decisions
(a wrong constant, a mis-ported fixed-point operation, a byte-swap error)
shifts the RNG and shows within a few tics. Sector heights and the thinker
count catch moving floors, doors and spawns that never touch a player.

**How a port uses it**:

1. Copy the hash exactly; `fs_state_hash` in `tools/freestanding/i_main.c` is
   a field-for-field duplicate.
2. Start the engine with `-timedemo demoN` (add `-nodraw` to skip rendering).
   This sets `singletics`, so each `D_DoomFrame` runs exactly one tic.
3. After each tic, record the hash. Send the trace over UART or any byte
   stream.
4. Compare against `tools/golden/<iwad>-<demo>.json` on a host. The run ends
   through `I_Error("timed ...")` (§1.2).
5. 13/13 identical traces means the port's simulation matches vanilla.

Present the Ultimate Doom IWAD as `doomu.wad` (§1, entry points): demo4
exists only in the retail game, and under the name `doom.wad` it desyncs at
tic 0. `tools/freestanding/run-check.sh` is the harness to copy; it maps each
demo to the file name to present.

The comparison needs only a byte-out, a host to diff on, and the demo
playback path. No display is involved.

---

## 7. ESP32 sketch

Feasibility for this and other targets, with CPU estimates, is in
[retro.md](retro.md) §4.

### 7.1 Hardware

ESP32-S3 class:

| Spec | Value |
|------|-------|
| CPU | dual-core Xtensa LX7 at 240 MHz |
| Internal SRAM | 512 KiB |
| PSRAM (external) | 2–16 MiB (quad or octal SPI) |
| Flash | 4–16 MiB SPI NOR |
| FPU | single precision only; `double` is software |
| 64-bit divide | software only |
| Unaligned loads | handled in hardware |
| I²S / I²C / SPI | native peripherals for audio and display |

### 7.2 Memory fit

The static segment needs 1.44 MiB with a 1 MiB stack (§2.1), plus the 250 KiB
screen block (§1.5). 512 KiB of internal SRAM cannot hold the static segment,
so PSRAM is mandatory. Internal SRAM is best spent on `screens[0]` (§1.5
hybrid), which addresses the §7.3 bottleneck.

**Credible configuration (shareware doom1.wad)**:

| Region | Size | Location |
|--------|------|----------|
| Static (stack + DATA + BSS, = `__heap_base`) | 1.44 MiB | PSRAM |
| `screens[0]` (render target) | 64,000 B | internal SRAM (§1.5 hybrid) |
| `I_AllocLow` block (`screens[1..3]`, save workspace) | 250 KiB | PSRAM |
| Zone | 4 MiB | PSRAM |
| WAD (doom1.wad, fully loaded) | ~4 MiB | PSRAM |
| **Total PSRAM** | **~9.7 MiB** | |
| Code | ~275 KiB (wasm CODE section, perf.md §1; native code size differs) | flash (XIP) |
| Trig corrections | ~11 KiB | flash (XIP) |
| `rndtable` + `gammatable` | ~1.5 KiB | flash (XIP) |

A 16 MiB PSRAM part leaves about 6 MiB of margin, enough for the zone to grow
to 8 MiB.

**Full doom.wad in PSRAM** needs ~17.5 MiB (§2.3a), over 16 MiB. Map the WAD
from flash instead (§2.3c, §2.3d), or use a 32 MiB PSRAM part.

### 7.3 Expected bottleneck

On wbox (AMD G-T56N Bobcat, ~1 GHz) the wasm renderer averages 0.52 ms per
frame over the three doom.wad attract demos (0.49 to 0.57 ms), and the
simulation 0.086 ms per tic (`tools/golden/bench-baseline.json`, `perStage`).
Against the 28.57 ms tic that is 1.8% of the CPU for rendering and 0.3% for
the simulation.

**Scaling is speculative.** wasm on an x86 core does not translate directly
to LX7: instruction sets, caches, the FPU and memory latency all differ.
Scaling by clock alone (240 MHz is about 0.24 of 1 GHz) puts rendering near
2.2 ms per frame, leaving most of the 28.57 ms budget. That suggests 35 Hz is
reachable **if memory latency on `screens[0]` is tolerable**.

**Memory latency, not compute, is the likely limit.** Because `screens[0]` is
column-major (§1.4), wall and sprite columns write consecutive bytes, which a
PSRAM cache handles well. Floor and ceiling spans (`R_DrawSpan`) write one
byte every 200 bytes, so each pixel lands on a different cache line; on PSRAM
with tens of nanoseconds per miss, the plane pass is the exposed stage. On
wbox the stages split roughly 51% walls (`bsp`), 33% planes and 14% sprites
and masked textures (`masked`). The fix is the same either way: put
`screens[0]` in internal SRAM with the §1.5 hybrid.

### 7.4 Known prior art

DOOM already runs on the original ESP32 (240 MHz, 4 MiB PSRAM). Espressif's
`esp32-doom` is PrBoom-based and reads the shareware WAD from a flash
partition, driving an ILI9341 SPI display; community forks such as
`davidbuzz`'s build on it. They confirm that the flash-resident WAD of §2.3c
and §2.3d works at this hardware tier.

### 7.5 Three hardest problems in order

**1. Memory bandwidth for the framebuffer** (hardest)

The plane pass misses the PSRAM cache on every span pixel (§7.3). Remedies,
best first: (a) `screens[0]` in internal SRAM via the §1.5 hybrid;
(b) low-detail mode, which halves horizontal resolution (`R_SetViewSize`
with detail 1, as `WD_DETAIL=1` does in `fs-doom`; renderer.md §7.2);
(c) a DMA path that converts and pushes the frame while the next one renders.

**2. FixedDiv's software 64-bit divide** (significant)

LX7 has no hardware 64-bit divide. At an estimated ~200 divides per frame and
40 to 80 cycles each, that is 8,000 to 16,000 cycles, about 35 to 70 µs at
240 MHz: measurable, manageable. §5.3 covers the `double` alternative; on the
ESP32-S3 `double` is also software. Profile both.

**3. WAD streaming latency for cold textures** (manageable)

Streaming the WAD from SPI NOR (§2.3c) makes the first frame of each map slow
while textures fill the zone cache; later frames run from the cache.
Touching the level's textures at load time moves the stall to the load.

---

## 8. The libc surface

The functions in §1 are what a porter writes. The libc symbols the core and
its platform layer reference are what the porter's runtime must provide.
`make imports` in `tools/freestanding/` lists them from the built `fs-doom`
binary (`nm -u`) into
[tools/freestanding/IMPORTS.md](../tools/freestanding/IMPORTS.md): 51 strong
undefined symbols and 4 weak ones, each with a disposition.

| Category | Symbols | What a bare-metal port does |
|----------|---------|-----------------------------|
| WAD loading in the hosted shim | `open`, `read`, `close`, `lseek`, `malloc`, `free` | nothing: they disappear when the WAD is a linker symbol, a ROM blob or a flash mapping |
| `-sim` trace output and config file I/O | `fopen`, `fclose`, `fwrite`, `fputc`, `fread`, `fseek`, `ftell`, `fstat` | nothing: send the trace over the byte-out; config and saves can be no-ops |
| Platform primitives | `write` (the byte-out), `clock_gettime`, `_setjmp`, `longjmp`, `abort`, `exit`, `__stack_chk_fail` | replace: UART or SWO write, hardware timer, a flag-and-poll demo exit, spin or reset; build with `-fno-stack-protector` or provide the guard |
| stdio called from the core | `fprintf`, `printf`, `putchar`, `puts`, `setbuf`, `sprintf`, `vsnprintf`, `sscanf` | provide from newlib or picolibc, routing output to the byte-out |
| Heap and filesystem called from the core | `realloc` (`W_AddFile`), `access` (`M_ScreenShot`), `mkdir` (`D_DoomMain`, `-cdrom` only) | `realloc` must work (§1.10); `access` can return −1; `mkdir` can be a no-op |
| String and memory | `memcpy`, `memset`, `strcpy`, `strncpy`, `strcmp`, `strncmp`, `strcasecmp`, `strncasecmp`, `strlen`, `strchr`, `strrchr`, `strtol` | provide from newlib, musl, picolibc or compiler built-ins |
| Math, once at boot | `sin`, `tan`, `atan` | provide libm for `T_GenerateTables`, or ship the tables as `const` and drop the call (§4.1) |
| C runtime | `__libc_start_main`, `__ctype_toupper_loc`, `stdout`, `stderr`; weak `__cxa_finalize`, `__gmon_start__`, `_ITM_*` | crt0 and the target libc |

This matters most on a constrained libc (newlib-nano, picolibc): even with
`exit` and `abort` replaced, the string, stdio and math symbols must still
resolve at link time.

---

*References*: [engine-archaeology.md](engine-archaeology.md) (trig recipe §1,
FixedDiv §2, compute versus lookup §7, sound constants §10, table ledger §14),
[perf.md](perf.md) (shipped artifacts §2, linear memory and the zone §3),
[renderer.md](renderer.md) (framebuffer §7.1, column draw §7.2, textures §8),
[playsim.md](playsim.md) (tic orchestration §1, thinkers and the zone §1.2),
[formats.md](formats.md) (WAD §1, DMX sound §6, MUS §7, endianness §11),
[netcode.md](netcode.md), [retro.md](retro.md),
[tools/freestanding/IMPORTS.md](../tools/freestanding/IMPORTS.md).
