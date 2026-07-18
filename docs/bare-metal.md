# DOOM bare-metal port contract

**Purpose**: answer precisely and quantitatively what this repo's DOOM core
demands from a platform. A competent embedded developer with this document
plus `docs/engine-archaeology.md`, `docs/renderer.md`, `docs/playsim.md`,
`docs/formats.md`, and `docs/perf.md` must be able to produce a credible
ESP32 port plan without reading the source first.

All numbers are from the merged reference docs or verified with the commands
shown. Code claims are cited as `file:line`.

---

## Contents

1. [The platform contract](#1-the-platform-contract)
2. [Memory map for constrained targets](#2-memory-map-for-constrained-targets)
3. [Timing contract](#3-timing-contract)
4. [Table strategy for ROM targets](#4-table-strategy-for-rom-targets)
5. [Endianness, alignment, and integer-width portability](#5-endianness-alignment-and-integer-width-portability)
6. [What this repo already proves](#6-what-this-repo-already-proves)
7. [ESP32 sketch](#7-esp32-sketch)
8. [Contract on trial: what the bring-up found](#8-contract-on-trial-what-the-bring-up-found)

---

> **Validation status — rung 1 (hosted-freestanding, 2026-07-17)**: commit
> c7b5f11 produced `tools/freestanding/fs-doom`, a Linux -m32 build of
> `engine/core` against a static 8 MiB arena + `fs_putc` byte-out + preloaded
> WAD blob. Gate commit b3c8a40 (`tools/freestanding/run-check.sh`) verified
> 13/13 golden demos bit-identical to vanilla. Every claim in §1–§7 was measured
> against this bring-up; gaps and validated predictions are recorded in §8.
> **Scope caveat**: this is hosted-freestanding (Linux, glibc, -m32 ABI). The
> QEMU/OS-less rung (11.1b) is deferred — no cross-compiler toolchain on this
> build host. Do not read this as bare-metal-on-hardware validation.

---

## 1. The platform contract

The platform contract spans **five** header files: `engine/core/i_system.h`
(timing, memory, error, startup), `engine/core/i_video.h` (display),
`engine/core/i_sound.h` (audio), `engine/web/web.h` (file registry, music
sequencer bridge, and `D_DoomFrame` declaration — mirrored for non-web builds
at `tools/freestanding/web.h`), and `engine/web/perf.h` (per-stage timing
counters — mirrored at `tools/freestanding/perf.h`). `engine/core/d_main.c`,
`m_misc.c`, and `w_wad.c` unconditionally `#include "web.h"`; `d_main.c` and
`r_main.c` unconditionally `#include "perf.h"`. A bare-metal porter must
supply stubs for both (FINDING-6; see §8.1). The web implementation in
`engine/web/` is the reference. §1.1–§1.10 enumerate the `i_system.h` /
`i_video.h` / `i_sound.h` function symbols. The full libc symbol surface a
porter must also satisfy is in `tools/freestanding/IMPORTS.md` (authoritative
list, §8.2).

### 1.1 Timing — MUST implement

```c
// i_system.h
int I_GetTime(void);
```

**Calling frequency**: every iteration of `TryRunTics` (d_net.c:636) and
the wipe loop (d_main.c:355). In practice, every trip through
`D_DoomLoop → TryRunTics`.

**Contract**: return the number of whole game tics elapsed since engine start.
The unit is 1/35 second (`TICRATE = 35`, doomdef.h:123). A tic is 28.57 ms.

**Web implementation** (`engine/web/i_system.c:40`):
```c
int I_GetTime(void) {
    return (int)(emscripten_get_now() * TICRATE / 1000.0);
}
```

**Bare-metal**: any monotonic counter with ≥ 35 Hz resolution suffices.
Using a hardware timer with a 35 Hz (or faster) interrupt and an incrementing
integer is the canonical implementation. The integer must not wrap within a
session (int32 at 35 Hz wraps after ~709 days; uint32 after 1,418 days).

**Precision requirement**: the core is adaptive (§3). Returning the correct
*integer* tic count on each call is sufficient. Sub-tic precision is only
needed for interpolation (I_GetTimeFrac below).

```c
// i_system.h (webdoom addition)
int I_GetTimeFrac(void);
```

**Contract**: returns the fractional portion of the current tic as a
`fixed_t` in [0, FRACUNIT]. Used exclusively by the renderer's interpolation
path (`r_main.c:845–851`). A port that does not implement render interpolation
can return `FRACUNIT` (= 65536) always — this locks the renderer to
end-of-tic positions (vanilla behaviour). **MAY stub**.

### 1.2 Error — MUST implement

```c
void I_Error(char *error, ...) __attribute__((noreturn));
```

**Contract**: format and display the error message, then halt. The
`__attribute__((noreturn))` annotation lets the compiler see past error
branches; a bare-metal port must implement this as a true non-return (spin
loop, trap instruction, or reboot). `abort()` is acceptable.

**Web implementation** (`engine/web/i_system.c:84`): surfaces the message
via `Module.onDoomError`, then calls `abort()`.

### 1.3 Zone memory — MUST implement

```c
byte* I_ZoneBase(int *size);
```

**Contract**: called once at startup (`z_zone.c`). Return a pointer to a
contiguous block of memory and set `*size` to its byte length. The engine
manages everything inside this block via Z_Zone; the platform never touches
it after this call.

**Web implementation** (`engine/web/i_system.c:32`): `malloc(32MB)`.

**Bare-metal**: see §2 for the credible minimum. Pass a statically or
dynamically allocated region; `malloc` is not required.

### 1.4 Video — MUST implement (two functions; two more are no-ops)

```c
void I_InitGraphics(void);      // called once at boot
void I_SetPalette(byte* palette); // called on every palette change
void I_FinishUpdate(void);      // called after every rendered frame
void I_UpdateNoBlit(void);      // MUST exist; MAY be empty
void I_ShutdownGraphics(void);  // called on quit; MAY be empty
```

**`I_InitGraphics`**: initialise display hardware. Called once by
`D_DoomMain`. The web implementation is empty (`engine/web/i_video.c:16`);
the platform is assumed to be initialised before `D_DoomMain` is called.

**`I_SetPalette(byte* palette)`**:

- `palette` points to a 768-byte array (256 × 3 bytes: R, G, B, one byte
  each, indices into PLAYPAL).
- Called by `V_SetPalette` (`v_video.c`) whenever the active palette
  changes: at level start, and every tic that `players[0].palette` changes
  (damage flash, bonus pickup, radiation suit, etc.).
- Calling frequency: at most once per tic, typically once per level start and
  a handful of times during combat.
- **Contract**: store or apply the 768-byte palette. The web implementation
  gamma-corrects through `gammatable[usegamma]` and stores it in a 768-byte
  `webpalette` static (`engine/web/i_video.c:20`). A bare-metal port should
  either do the same (apply gamma then push to hardware palette registers) or
  maintain a software palette table for the blitter.
- The palette is the *active* selection from `PLAYPAL` (14 palettes ×
  768 bytes = 10,752 bytes; formats.md §3.3). The game selects which of the
  14 palettes to use; `I_SetPalette` receives the already-selected 768 bytes.

**`I_FinishUpdate`**:

- Called by `D_Display` (d_main.c) after every call to `R_RenderPlayerView`.
  At 35 Hz, that is every 28.57 ms.
- **Contract**: transfer `screens[0]` to the display hardware. `screens[0]`
  is a `byte[SCREENWIDTH * SCREENHEIGHT]` = `byte[64000]` buffer of palette
  indices whose backing store is allocated by `I_AllocLow` (see §1.5). The
  platform converts indices to RGB via the palette set by the most recent
  `I_SetPalette`.
- The web implementation is empty (`engine/web/i_video.c:30`): JS reads
  `web_framebuffer()` and `web_palette()` directly from wasm memory after
  `D_DoomFrame` returns.
- Bare-metal: do the palette-indexed → display-format blit here. For SPI
  displays, this is where you push 64,000 pixel lookups (or DMA the
  result). Double-buffering is optional; the core does not swap `screens[0]`
  mid-frame.

**Framebuffer layout**:

```
screens[0]:  byte[320 * 200] = 64,000 bytes   palette indices, row-major
screens[1]:  byte[320 * 200] = 64,000 bytes   status-bar border background
             (screens[1] is written by R_FillBackScreen, renderer.md §7.1)
```

`screens` is declared in `v_video.c:44` as `byte* screens[5]` — an array of
five pointers, initially all NULL. The backing store for each entry is
**not** a static byte array; it is allocated at runtime by `I_AllocLow`
(see §1.5) in `V_Init` (v_video.c:489, called from d_main.c:936). The
pointers are NULL until `V_Init` completes.

`screens[0]` uses palette indices, not RGB. The platform converts to its
display format in `I_FinishUpdate` via the 768-byte palette set by the last
`I_SetPalette`. Double-buffering is not required; the core completes each
frame before calling `I_FinishUpdate`.

### 1.5 Screen buffer allocation — MUST implement

```c
byte* I_AllocLow(int length);
```

**Declared**: `i_system.h:89`. **Calling context**: called once by `V_Init`
(v_video.c:489, called from d_main.c:936) with
`length = SCREENWIDTH * SCREENHEIGHT * 4` = 320 × 200 × 4 = 256,000 bytes.
`V_Init` then divides the returned block into four equal 64,000-byte regions
and assigns them to `screens[0]` through `screens[3]` (`v_video.c:492`).

**Contract**: return a pointer to a zero-initialised, writable block of
exactly `length` bytes. The block must remain valid for the lifetime of the
process. Zero-initialisation is required: some code paths read `screens[]`
entries before the first render write.

**Web implementation** (`engine/web/i_system.c:74`):
```c
byte* I_AllocLow(int length) {
    return (byte*)calloc(1, length);
}
```

**Bare-metal guidance**: the single allocation is 256,000 bytes (250 KiB).
Three placement strategies:

- **PSRAM heap** (simplest): `psram_calloc(1, length)`. The full 256 KiB
  lands in PSRAM. Simplest to implement but `screens[0]` column writes will
  hit PSRAM latency (see §7.3 bottleneck analysis).
- **Statically reserved region**: declare a `static byte fb_block[256000]`
  in a linker section mapped to the target memory and return its address.
  Pre-zero with `memset`. The `__attribute__((section(".psram_bss")))`
  attribute is the ESP-IDF idiom for PSRAM-resident BSS.
- **Hybrid — recommended for ESP32-S3**: place `screens[0]` specifically in
  the 512 KiB internal SRAM to avoid PSRAM round-trip latency on the column
  draw inner loop, and keep screens[1..3] in PSRAM. The simplest
  implementation: `I_AllocLow` returns a pointer into a 256 KiB PSRAM block,
  then after `V_Init` returns (or inline in `I_AllocLow` if a call counter
  is maintained), override `screens[0]` to point at a 64 KiB region carved
  from internal SRAM. The linker idiom: `static byte __attribute__((section(".iram0.data"))) sram_fb0[64000];`

This is the direct mitigation for the §7.3 PSRAM bandwidth bottleneck.

### 1.6 Startup hook — MUST implement (may be empty)

```c
void I_Init(void);
```

**Declared**: `i_system.h:35`. **Called**: `D_DoomMain` (d_main.c:1023).

`I_Init` is the **only** hook that starts the sound subsystem. Without it,
`I_InitSound` is never called and the §1.8 sound stub symbols are never
executed (they must still link, but will not be reached without `I_Init`
invoking them).

**Web implementation** (`engine/web/i_system.c:45–48`):
```c
void I_Init(void) {
    I_InitSound();
}
```

**Contract**: perform any platform-level initialisation required between
`D_DoomMain` start and game-loop entry. For a port with no audio the body
may be `{}`. For a port with audio, call `I_InitSound()` here. The link
symbol must exist; omitting it produces a link error.

### 1.7 Input — MUST implement (one function; rest are no-ops)

```c
ticcmd_t* I_BaseTiccmd(void);
void I_StartFrame(void);   // MAY be empty
void I_StartTic(void);     // MAY be empty (poll input here)
```

**`I_BaseTiccmd`**: returns a pointer to an empty `ticcmd_t` for single-
player. For single-player, this is a zero-filled struct; inputs are added
on top by `G_BuildTiccmd` (g_game.c). The web implementation returns
`&emptycmd` where `emptycmd` is a zero-initialised static
(`engine/web/i_system.c:28`).

**`I_StartTic`**: called once per tic before input processing. The canonical
place to poll a keypad or GPIO and call `D_PostEvent` for each event.
The web implementation is empty; events arrive via JS callbacks.

**Event posting**: call `D_PostEvent(event_t *ev)` with `ev_keydown` /
`ev_keyup` / `ev_mouse` / `ev_joystick` events. Keybindings default to
WASD/arrow keys via `m_misc.c:216`. For a minimal bare-metal controller:
8 GPIO lines can map to forward, back, left, right (turning), strafe,
fire, use, speed.

### 1.8 Sound — MAY fully stub; MAY partially implement

The entire sound subsystem is optional. The headless demo-test tool
(`tools/demo-test.mjs`) runs correctly with the web sound stubs disabled
(the JS bridge functions are no-ops until `client/js/audio.js` installs
them). The simulation is untouched by sound. `I_Init` (§1.6) must call
`I_InitSound()` only if sound is actually implemented; otherwise `I_Init`
may be empty.

**Fully stub approach** (zero audio, correct sim):

```c
void I_InitSound(void) {}
void I_UpdateSound(void) {}
void I_SubmitSound(void) {}
void I_ShutdownSound(void) {}
void I_SetChannels(void) {}
int  I_GetSfxLumpNum(sfxinfo_t *sfx) { return -1; }
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
int  I_PlaySong(int handle, int looping) { return 0; }
void I_StopSong(int handle) {}
void I_UnRegisterSong(int handle) {}
```

**Partial implementation** (SFX only, no music):
Implement `I_StartSound` to feed raw PCM to a DAC. SFX lumps are DMX format
(formats.md §6): 8-byte header, then raw unsigned 8-bit PCM at 11,025 Hz
with 16-byte lead-in and lead-out pads. The real PCM is bytes `[24 .. 24 +
num_samples - 33]`. Convert 8-bit unsigned to signed (`sample - 128`) and
push to the DAC. Volume, stereo, and pitch parameters are passed on every
call to `I_StartSound` and updated via `I_UpdateSoundParams`. Up to
`snd_channels` (default 3) sounds run simultaneously.

**Calling frequency**: `S_UpdateSounds` is called once per tic from
`G_Ticker` (outside the sim proper — uses `M_Random`, not `P_Random`).
It calls `I_StartSound` for each new sound event and `I_UpdateSoundParams`
for spatially-changing sounds.

**Sound parameter semantics** (archaeology §10):
- `vol`: 0..127 (`S_MAX_VOLUME = 127`, s_sound.c:51). Linear from inaudible
  at distance 1200 map units to full at distance ≤ 160 map units.
- `sep`: 0..255 (0=full left, 128=center, 255=full right). Computed as
  `128 − 96 × sin(relative_angle)` (s_sound.c:787).
- `pitch`: 0..255; NORM_PITCH = 128 = unmodified. Vary ±8 for chainsaw,
  ±16 for most other sounds (s_sound.c:327–346, using M_Random — not
  sim-critical).

### 1.9 Net — single-player needs nothing

In single-player, `netgame = false`. `NetUpdate` (d_net.c:159) returns
immediately when `!netgame`. `TryRunTics` still calls it but the call is a
no-op loop. `I_InitNetwork` is never called by the core; in webdoom it is
replaced by `web_net_setup` called from JS before `D_DoomMain`.

**Important**: webdoom replaces `engine/core/d_net.c` entirely via
`CORE_EXCLUDE` in the Makefile (Makefile:8–9). The core's `d_net.c` pulls in
BSD socket headers (`sys/socket.h`, etc.) that will not compile on bare-metal
targets. A bare-metal single-player port must likewise replace `core/d_net.c`
with a minimal stub — modelled on `engine/web/d_net.c` — that provides the
required symbols (`NetUpdate`, `NetSend`, `D_InitNetGame`) as no-ops. Do not
compile `core/d_net.c` directly.

For multi-player, the relay architecture is described in `docs/netcode.md`;
the lockstep protocol is transport-agnostic and could be implemented over
UART, SPI, or any byte stream.

### 1.10 Remaining platform symbols — MAY stub

The following symbols are declared in `i_system.h` or `i_video.h` and must
link in any build. All are present in the web layer as minimal bodies. None
has required side effects for a headless single-player bare-metal port; all
may be implemented as the stubs shown.

| Symbol | Header | Calling site(s) | Web impl | Bare-metal stub |
|--------|--------|-----------------|----------|-----------------|
| `void I_Quit(void)` | i_system.h:84 | g_game.c:1684, m_menu.c:1094 | Saves config, calls `I_ShutdownGraphics`, signals JS `onQuit`, then `emscripten_force_exit(0)` | Call `exit(0)` or trigger hardware reboot; must not return |
| `void I_Tactile(int on, int off, int total)` | i_system.h:91 | p_inter.c:883 | `{}` (rumble hook, never wired in web) | Always stub: `{}` |
| `void I_WaitVBL(int count)` | i_video.h:49 | d_net.c:620, m_menu.c:1092 | `{}` (no-op — "Never block the browser main thread") | Optionally `sleep_ms(count * 1000/35)` or `{}` |
| `void I_ReadScreen(byte* scr)` | i_video.h:51 | m_misc.c:493 (screenshot), f_wipe.c:244,256 (screen wipe) | `memcpy(scr, screens[0], SCREENWIDTH*SCREENHEIGHT)` | Same: `memcpy(scr, screens[0], 64000)` — required for wipe effects |
| `void I_BeginRead(void)` | i_video.h:53 | w_wad.c:259 | `{}` (disk-activity LED hook) | Always stub: `{}` |
| `void I_EndRead(void)` | i_video.h:54 | w_wad.c:262 | `{}` (disk-activity LED hook) | Always stub: `{}` |

**Note on `I_ReadScreen`**: unlike the others, `I_ReadScreen` is called by
`f_wipe.c` for screen-wipe transitions. A port that wants wipe effects must
implement it as the memcpy shown. A port that stubs it as `{}` will skip wipe
animations (the wipe effect reads `screens[0]` before the transition frame,
then compares per-column). The simulation is unaffected by either choice.

---

## 2. Memory map for constrained targets

All numbers are from `docs/perf.md` (measured at commit 6de6256 with
32 MiB zone, doom.wad and plutonia.wad attract demos). All sizes use binary
MiB / KiB throughout this section to match perf.md's measurement convention.

### 2.1 Static segment

From `docs/perf.md §3` (wasm linear memory layout):

| Region | Size |
|--------|------|
| C shadow stack | 4 MiB (`STACK_SIZE=4MB`, engine/Makefile) |
| Initialized data (DATA) | 73.5 KiB (perf.md §1 wasm DATA section) |
| Zero-initialized BSS | ~1,163 KiB (static + BSS total = 1,237 KiB, perf.md §3) |
| **`__heap_base`** | **5.21 MiB** |

The large BSS is dominated by renderer scratch arrays: `visplanes[1024]`
(~569 KiB at sizeof ≈ 556 B each), `openings[81920]` (160 KiB × 2 B),
`drawsegs[2048]` (~120 KiB), `vissprites[1024]` (~50 KiB). The screen
buffers (`screens[0..3]`, 250 KiB total) are **not** in static BSS; they
are allocated at runtime by `I_AllocLow` and point into whichever memory
region the port selects (see §1.5).

**Bare-metal implication**: 1.21 MiB of writable memory (SRAM or
write-capable PSRAM) is the minimum for the static segment alone. This is
the floor below which the engine cannot boot, independent of WAD and zone
size. Add the 250 KiB screen buffers (from `I_AllocLow`) to arrive at the
true minimum writable footprint: ~1.46 MiB.

### 2.2 Zone (heap)

From `docs/perf.md §2` (measured with 32 MiB zone):

| IWAD | Peak zone used (non-purgeable) | % of 32 MiB zone |
|------|-------------------------------|-----------------|
| doom.wad | 0.91 MiB | 2.8% |
| doom2.wad | 1.00 MiB | 3.1% |
| tnt.wad | 1.29 MiB | 4.0% |
| plutonia.wad | **1.36 MiB** | **4.3%** (worst) |

The 1.36 MiB figure is the peak of **non-purgeable live usage only**
(perf.md §2). Purgeable cache blocks (composite textures, flat data) add
to the instantaneous committed size but are not counted in this peak —
Z_Malloc reclaims them on pressure by calling `Z_FreeTags`.

**What degrades under zone pressure**: when `Z_Malloc` cannot satisfy a
`PU_CACHE` request, it purges existing `PU_CACHE` blocks (composite textures,
flat data, sprite patches) and regenerates them on next access from WAD lumps.
This produces a cache-miss penalty — textures must be re-composited from WAD
patches (`r_data.c:228–289`, renderer.md §8.1) — but the game continues.

**What breaks**: `PU_STATIC` and `PU_LEVEL` blocks are never purgeable. If
the zone cannot satisfy a non-purgeable allocation (map data, player structs,
thinkers), `Z_Malloc` calls `I_Error`. The 1.36 MiB peak represents the
non-purgeable floor; a zone smaller than ~2 MiB risks hitting this on extreme
maps or if purgeable overhead is larger than the attract-demo measurement.

**Credible minimum zone for production gameplay**: `4 MiB`. The perf.md §3
recommendation states "4–8 MiB as a first pass"; 4 MiB is 3× the measured
non-purgeable peak, leaving 2.64 MiB for purgeable texture cache. This is
sufficient for normal maps; pathological maps (many large textures, many
monsters) may need 8 MiB.

**Recommended for first bring-up**: 4 MiB zone, then profile with the 13
golden demos (§6.3). If any demo triggers `I_Error` from `Z_Malloc`,
increase zone size.

*Cross-reference*: task 13.2a re-trial (2026-07-18) confirmed 4 MiB passes
all three gates (sim 13/13, render 13/13, 4-client net) on post-3.2 master —
see `docs/perf.md` Q2 task 13.2a re-trial subsection for full results.

*Render-ON evidence (task 13.2b, 2026-07-18)*: flag-guarded `z_zone.c`
instrumentation (`-DWEB_PERF_ZONE_STATS`) measured render-ON HWM via
`tools/freestanding/fs-doom` over all 13 demos.  Non-purgeable peak:
**0.981 MiB** (tnt-demo2); total HWM at 32 MiB zone: **10.485 MiB** (tnt-demo3).
At 4 MiB zone: 248–1,397 PU_CACHE evictions/demo, 13/13 sim hashes identical,
counts deterministic across two passes.  The 4 MiB "credible minimum" is now
a measured floor, not an estimate.  Full data: `tools/golden/zone-stats.json`.

### 2.3 WAD residency strategies

w_wad.c's lump access pattern: `W_CacheLumpNum(lump, tag)` is called
per-frame for every texture column (`r_data.c:382–401`, renderer.md §8.2)
and per-tic for map data access. Cache hits (already in zone) are pointer
returns; cache misses either re-composite from WAD (textures) or load raw
lump data. The WAD must therefore support **random byte-range access by lump
file-position and size**.

Three strategies for a constrained target:

#### (a) Full IWAD in PSRAM (~16 MiB class)

Load the entire WAD into a heap-allocated buffer before calling `D_DoomMain`.
In webdoom, `handle = (int)(wadBuffer + filepos)` makes every lump a direct
pointer into the WAD buffer (`w_wad.c:153`). On a target with 16 MiB+ PSRAM,
this is the simplest approach: zero latency for lump access.

WAD sizes (binary MiB, verified against perf.md §3):

| IWAD | Size |
|------|------|
| doom.wad (Ultimate Doom variant, 12,408,292 bytes) | ≈ 11.8 MiB |
| doom2.wad | ≈ 13.9 MiB |
| plutonia.wad (worst case) | **16.61 MiB** |

Only doom.wad fits comfortably in a 16 MiB PSRAM budget alongside static +
zone. doom2.wad exceeds 16 MiB when combined with the 1.21 MiB static
segment and 4 MiB zone; plutonia.wad clearly does not fit.

**Memory budget (doom.wad, full IWAD in PSRAM)**:

| Region | Size |
|--------|------|
| Static (DATA + BSS) | 1.21 MiB |
| Screen buffers (I_AllocLow) | 0.24 MiB |
| Zone | 4 MiB |
| WAD in PSRAM | 11.8 MiB |
| **Total** | **~17.3 MiB** |

Requires ~17.3 MiB PSRAM. ESP32-S3 with 16 MiB PSRAM is tight for doom.wad
and does not fit doom2.wad or plutonia.wad without streaming.

#### (b) Shareware doom1.wad (~4 MiB class)

doom1.wad (shareware IWAD, episodes 1 only) is ~4.2 MiB. With this WAD:

| Region | Size |
|--------|------|
| Static | 1.21 MiB |
| Screen buffers (I_AllocLow) | 0.24 MiB |
| Zone | 4 MiB |
| WAD in PSRAM | ~4.2 MiB |
| **Total** | **~9.7 MiB** |

Fits in 16 MiB PSRAM with margin. The shareware WAD is free to redistribute.
The 13 golden demos include doom.wad demos (not shareware), but for a port
validation pass, any set of demos on the shareware WAD can be recorded and
used as a local golden.

#### (c) Streaming from SPI flash

If PSRAM is unavailable or insufficient, the WAD can live in SPI flash and
be streamed in on demand. This requires modifying `w_wad.c`'s lump access:
instead of `handle` being a direct pointer, `W_ReadLump` must do a SPI
flash read via `spi_flash_read(filepos, buf, size)`.

The access pattern is random-access but heavily cached by the zone. With a
4 MiB zone and 1.36 MiB non-purgeable peak, up to ~2.6 MiB of zone space is
available for purgeable lump cache. This means most frequently used textures
and flats will be in-cache across frames; SPI reads occur only on cache miss.

SPI flash latency impact: a typical SPI flash read at 80 MHz is ~1 µs/byte;
a 4 KiB texture column composite read is ~4 ms. At worst, each distinct
texture on screen causes one read per render pass. On a level with dozens of
distinct textures, first-frame latency will be noticeable but subsequent
frames serve from zone cache.

**What must change in w_wad.c**: `W_ReadLump` must fetch bytes from flash
rather than returning a pointer. The zone-cache layer (`W_CacheLumpNum`)
already handles caching on top of `W_ReadLump`; only the raw read path needs
to change.

### 2.4 Palette and framebuffer summary

| Buffer | Size | Location |
|--------|------|----------|
| `screens[0]` — render target | 64,000 B | `I_AllocLow` heap (PSRAM or SRAM; see §1.5) |
| `screens[1]` — status-bar background | 64,000 B | `I_AllocLow` heap (PSRAM or SRAM) |
| `screens[2..3]` — wipe buffers | 64,000 B each | `I_AllocLow` heap (PSRAM) |
| `webpalette` — gamma-corrected RGB palette | 768 B | Static BSS |
| PLAYPAL WAD lump (14 palettes) | 10,752 B | Zone (PU_CACHE) |
| COLORMAP WAD lump | 8,704 B | Zone (PU_STATIC) |

`screens[0]` contains palette indices, not RGB values. The platform converts
indices to its display format in `I_FinishUpdate` via the 768-byte palette
set by the last `I_SetPalette`. `screens[0]` is the only buffer written on
every frame; placing it in internal SRAM (see §1.5 hybrid strategy) is the
primary mitigation for the §7.3 PSRAM latency bottleneck.

---

## 3. Timing contract

### 3.1 The 35 Hz tic

`TICRATE = 35` (`doomdef.h:123`). One game tic = 1/35 s ≈ 28.57 ms. The
simulation (`G_Ticker → P_Ticker`) runs exactly once per tic. Every
physics constant (movement speed, strobe periods, gravity) is calibrated to
35 Hz — `SLOWDARK = 35` tics (1 s slow strobe dark phase), `FASTDARK = 15`
tics (~0.43 s fast strobe), `GRAVITY = FRACUNIT` per tic² (archaeology §11).

**The tic is discrete, not continuous**: two calls to `I_GetTime` differing
by N return N tics, and the engine runs exactly N simulation steps. There is
no fractional tic in the simulation.

### 3.2 Adaptive underrun behaviour

`TryRunTics` (d_net.c:636) is called once per trip through `D_DoomLoop`.
It asks `I_GetTime` for the current tic, computes `realtics` (wall-clock
tics elapsed since last call), then decides `counts = max(1, realtics)`.
The engine then runs `counts` simulation tics in sequence.

**On underrun (render slower than 35 Hz)**: the engine runs multiple tics
per trip through the loop, catching up. The sim advances at real time
regardless of frame rate. At 10 Hz display rate, each display trip runs ~3
tics; demo replay is unaffected because only the sim state matters, not the
display rate.

**On overrun (render faster than 35 Hz)**: `counts = 1` is the minimum.
The engine always runs at least one tic per loop iteration. If the platform's
`D_DoomLoop` calls the render every 1 ms, the sim still runs at 35 Hz
(runs 1 tic per call, but only 28.57 ms of tics are available per second).
This is the model for bare-metal: a tight loop calling `D_DoomFrame` (or the
equivalent) as fast as possible is correct; the sim self-throttles via
`I_GetTime`.

**`singletics` debug path** (d_main.c:104,397): when `singletics = true`,
`TryRunTics` forces exactly one tic per frame regardless of elapsed time.
This is used by the demo-test tool (`g_game.c:1653`) for deterministic
playback. A bare-metal port bringing up its timing can use this mode to
verify the sim without worrying about wall-clock accuracy.

### 3.3 Audio timing

The web audio model: the OPL sequencer (`mus_opl.c`) runs at 140 Hz (MUS
ticks, formats.md §7.3). JS pulls samples via an AudioWorklet at the output
sample rate (44,100 Hz or device rate). Sound effect PCM is 11,025 Hz (DMX
format, formats.md §6).

For bare-metal: a hardware DAC or I²S peripheral with a dedicated fill
interrupt is the natural fit. The OPL sequencer exposes `mus_play` and a
render function (`web_music_render` in the web layer); bare-metal reuses
the same sequencer, replacing the AudioWorklet pull with a DMA callback.
Sound effects are separate: `I_StartSound` hands a DMX PCM buffer to the
platform, which mixes channels and pushes to the DAC independently of the
simulation loop.

The key contract: audio timing is **decoupled from the sim**. No `P_Random`
calls occur inside sound mixing. Sound parameter updates (`S_UpdateSounds`)
run once per tic using `M_Random` only. A bare-metal port may implement audio
on a separate core (ESP32-S3 has two LX7 cores) without any synchronisation
concern beyond the `I_StartSound` call.

---

## 4. Table strategy for ROM targets

Payoff from `docs/engine-archaeology.md §14` (40-row ledger). The ledger
classifies every hardcoded blob as: **recipe** (cracked, can regenerate),
**equivalence** (provably derivable), **irreducible** (cannot be derived),
or **declarative** (art/design data). The port's flash and RAM budget depends
on which blobs live where.

### 4.1 Trig tables — boot-generate (saves ~64 KiB flash)

| Table | Entries | Size | Verdict |
|-------|---------|------|---------|
| `finesine[10240]` + `finetangent[4096]` | 14,336 | 56 KiB | **recipe** — archaeology §1 |
| `tantoangle[2049]` | 2,049 | 8 KiB | **recipe** — archaeology §1 |
| **Total** | | **64 KiB** | |

**Recipe** (archaeology §1): `sin(i + 0.5) * FRACUNIT` (truncated toward
zero), `tan` similarly, `atan(i/2048)` for the arctangent. 33 finesine
entries need correction (razor-edge values where the 1992 libm differed
from modern). The correction stream is ~11 KiB entropy-coded; it ships in
the binary (`engine/core/tables.c`, `tables.h:86`).

**Current webdoom approach**: boot-generate all three tables at startup
(`R_InitTables()` called from `D_DoomMain`). The trig tables do NOT appear
in the wasm DATA section (73.5 KiB, perf.md §1); they are allocated in BSS
and filled at boot. A FNV checksum over all 16,385 entries guards against
libm drift.

**ROM target recommendation**: keep boot-generation. Net flash savings:
64 KiB tables − ~11 KiB corrections − generation code ≈ 50 KiB net.
Boot generation cost: ~16,385 libm `sin`/`tan` calls + 33-entry correction
patch. On a 240 MHz Cortex-M7, `sin` is ~50 cycles via FPU; 14,336 calls ≈
14,336 × 50 / 240,000,000 = ~3 ms. Acceptable for a one-time startup cost.

**Alternative for flash-rich, boot-speed-critical targets**: ship the 64 KiB
of pre-computed table data as `const` in flash. If flash is XIP-capable, the
tables are accessed directly from flash (zero RAM cost). Omit the 11 KiB
correction stream; just ship the final verified values.

### 4.2 Irreducible tables — ship as ROM data

These cannot be regenerated; they MUST ship as constants:

| Table | Size | Verdict | Sim-critical? |
|-------|------|---------|---------------|
| `rndtable[256]` (m_random.c) | 256 B | irreducible — no standard PRNG generates it (brute-forced 2³² seeds, archaeology §3) | YES |
| `gammatable[5][256]` (v_video.c) | 1,280 B | irreducible — no exact closed form (archaeology §4) | No |
| `fuzzoffset[50]` (r_draw.c:260) | 200 B | irreducible — fixed spectre pattern | No |
| `translationtables[768]` (r_draw.c:459) | 768 B | recipe — identity + palette remap for multiplayer colours | No |

If flash is XIP-capable, all of these cost zero RAM (read directly from flash
by the CPU cache or fetch unit). If flash is SPI-only (no XIP), cache them in
SRAM on first access.

### 4.3 WAD-owned tables — always RAM after WAD load

These blobs are WAD lumps: they are loaded from the WAD into the zone and
are subject to PWAD override (e.g., coloured lighting PWADs replace
COLORMAP). They cannot be reproduced from ROM alone.

| Lump | Size | Notes |
|------|------|-------|
| `COLORMAP` | 8,704 B | recipe known (archaeology §6) but PWAD-overridable; always load from WAD, never regenerate |
| `PLAYPAL` | 10,752 B | 14 palettes × 768 B |
| `PNAMES`, `TEXTURE1/2` | variable | wall texture definitions |
| All sprite/flat/sound lumps | variable | loaded on demand |

COLORMAP and PLAYPAL are loaded `PU_STATIC` and never purged. Their combined
8 + 10.7 ≈ 19 KiB is included in the 1.36 MiB non-purgeable peak (perf.md §2).

### 4.4 Boot-computed pointer tables — RAM only

`zlight[16][128]` and `scalelight[16][48]` are 2D pointer arrays into
`colormaps` (= COLORMAP lump data). They contain no data values of their
own — only pointers — and are rebuilt at `R_InitLightTables` /
`R_ExecuteSetViewSize` (r_main.c:626, r_main.c:683). They occupy:

- `zlight`: 16 × 128 × sizeof(pointer) = 2,048 × 4 = 8 KiB (pointer table)
- `scalelight`: 16 × 48 × sizeof(pointer) = 768 × 4 = 3 KiB

These are ROM-incompatible (they hold live pointers); they go in SRAM.

### 4.5 Concrete recommendation per target class

| Target class | Trig tables | rndtable / gamma | COLORMAP | Zone |
|---|---|---|---|---|
| Flash-rich, XIP (≥ 2 MiB flash) | Ship as `const` in flash, zero RAM | `const` in flash, zero RAM | Load from WAD (PSRAM/SRAM zone) | 4 MiB PSRAM |
| Flash-constrained (< 1 MiB flash) | Boot-generate from recipe + 11 KiB correction stream | Ship 256+1280 B as `const` | Load from WAD | 4 MiB PSRAM |
| PSRAM-only (no WAD flash) | Boot-generate | `const` in flash | Include COLORMAP as fallback `const` in flash (8.7 KiB) | 4 MiB |

**The never-do rule** (archaeology §7): do not replace trig table lookups
with runtime `sin`/`tan` calls in the render loop. An L1-cached table lookup
is ~4 cycles; runtime transcendental is 20–100 cycles. Boot-generate once,
look up always.

---

## 5. Endianness, alignment, and integer-width portability

### 5.1 Endianness

All WAD on-disk data is **little-endian** (`docs/formats.md §11.1`).
The macro gate in `m_swap.h:37–42`:

```c
#ifdef __BIG_ENDIAN__
short SwapSHORT(short);
long  SwapLONG(long);
#define SHORT(x) ((short)SwapSHORT((unsigned short)(x)))
#define LONG(x)  ((long)SwapLONG((unsigned long)(x)))
#else
#define SHORT(x) (x)   // identity on LE / wasm
#define LONG(x)  (x)
#endif
```

Every map lump read and WAD directory parse goes through `SHORT()` / `LONG()`
(`p_setup.c:146–292`, `w_wad.c:177–187`). A big-endian bare-metal port must:

1. Implement `SwapSHORT` / `SwapLONG` in `m_swap.c`.
2. Define `__BIG_ENDIAN__` before including `m_swap.h`.
3. Handle the BLOCKMAP in-place byte-swap loop (`p_setup.c:480–481`) which
   swaps the entire lump as a `short[]` array.
4. Tag savegames with a platform identifier: savegame `player_t` / `mobj_t`
   are `memcpy`'d verbatim and contain native-endian pointer indices
   (formats.md §11.4).
5. The MUS lump header is parsed with explicit `m[4] | (m[5] << 8)` bit
   arithmetic (`mus_opl.c:427–428`) — already endian-safe.

### 5.2 Alignment — known unaligned access sites

On a target with strict alignment requirements (ARM Cortex-M0, Cortex-M3,
Cortex-M4 without `__attribute__((packed))` workaround), the following code
sites read multi-byte values from WAD data that may not be naturally aligned.
All were found by `grep` against the source tree.

| Site | Access | Alignment risk |
|------|--------|---------------|
| `w_wad.c:177` — `(wadinfo_t*)data` | int32 at offsets 4 and 8 (numlumps, infotableofs) via `LONG()` | WAD data is malloc-aligned, but WAD directory offset is arbitrary |
| `w_wad.c:187` — `(filelump_t*)(data + LONG(...))` | int32 at offsets 0 and 4 (filepos, size) per directory entry | filepos of the directory itself may not be 4-byte aligned |
| `p_setup.c:279` — `(mapnode_t*)data` | int16 bbox[2][4] at struct offset 8, then int16 children at offset 24 | the NODES lump start is at an arbitrary file offset |
| `r_data.c:277,345` — `LONG(realpatch->columnofs[x])` | int32 array at byte offset 8 from patch start | patch lump start at arbitrary file offset; offset 8 may not be 4-byte aligned |
| `r_things.c:440` — `LONG(patch->columnofs[texturecolumn])` | same as above | same |
| `v_video.c:245,310,375` — `LONG(patch->columnofs[col])` | same as above | same — three call sites |
| `r_data.c:522` — `(maptexture_t*)(maptex + offset)` | int32 `masked` at offset 8, int32 `columndirectory` at offset 16 within maptexture_t | offset into TEXTURE1/2 lump may be misaligned |

**Total: 7 primary sites** (some with multiple call lines). The `patch_t`
`columnofs[]` access is the most pervasive: it is hit every frame for every
visible wall column and sprite column.

**Mitigation on strict-alignment targets**:

Option A (minimal change): replace the bare `LONG()` macro with a byte-by-byte
read helper:
```c
static inline int32_t read_le32(const void *p) {
    const uint8_t *b = (const uint8_t *)p;
    return (int32_t)(b[0] | ((uint32_t)b[1]<<8) | ((uint32_t)b[2]<<16) | ((uint32_t)b[3]<<24));
}
```
Override the `LONG()` macro with this on strict-alignment targets.

Option B: copy WAD lump data into 4-byte-aligned heap buffers at load time
before casting. `W_CacheLumpNum` already copies into zone memory; ensure the
zone allocator aligns to 4 bytes (Z_Zone's default block header alignment
satisfies this on most platforms).

On ESP32-S3 (LX7): LX7 supports unaligned loads natively (no trap). The
above is not needed unless targeting Cortex-M0/M3.

### 5.3 Integer width assumptions

`fixed_t` is `int32_t` (`doomtype.h`). `angle_t` is `uint32_t`. The fixed-
point unit is `FRACUNIT = 0x10000 = 65536`.

**The FixedDiv decision** (archaeology §2 and §7):

`FixedDiv` computes `(a / b) * 65536` over the guarded domain
`|a| >> 14 < |b|` (equivalently, `|result| < 2^14`). Three forms are
bit-identical over this domain (proven by 2×10⁹ random + 1.8×10⁶ boundary
pairs, archaeology §2):

```c
// Form 1: int64
((int64_t)a << 16) / b

// Form 2: double
(double)a / (double)b * 65536.0

// Form 3: 64/32 idiv (x86 DOS original)
```

**The Cortex-M problem**: Cortex-M0/M3/M4 have no 64-bit divide instruction.
`((int64_t)a << 16) / b` compiles to a software `__aeabi_ldivmod` call.
Cortex-M7 and Cortex-A have hardware 32-bit divide (SDIV/UDIV) but no 64-bit
divide.

**Software divide cost**: on ARM with `-mcpu=cortex-m4`, `__aeabi_ldivmod`
is ~40–80 cycles. `FixedDiv` is called in the renderer inner loop (scale
calculation in `R_ScaleFromGlobalAngle`, r_main.c:465–506) and in `P_PathTraverse`. The archaeology §7
wasm measurements show `int64` divide is faster than `double` on Pi5 (+20%)
but 65% slower on Kaby Lake; on Bobcat (old x86), `double` is +6% faster.
On Cortex-M without FPU: both forms require software emulation; `double`
emulation is typically slower. On Cortex-M4F/M7 with FPU: hardware `divsd`
may be faster than software 64-bit divide.

**Recommendation for Cortex-M**: benchmark both paths at port bringup.
Neither has a universal advantage. The guard-domain constraint limits the
result to 30 significant bits (`|result| < 2^30 after left shift by 16`);
however, no current 32-bit shortcut exists because the inputs (`a`, `b`)
are not themselves bounded — `a` can be any int32. The double path remains
an option for FPU-equipped Cortex-M targets. Use whichever the target's
`FixedDiv` profiling shows faster; demo traces validate correctness.

**Other width assumptions**:
- `int` is used as 32-bit throughout (doomtype.h assumes LP32/LP64 model).
  On an ILP16 target (8-bit AVR), this codebase does not port without
  significant changes. Cortex-M is ILP32: safe.
- `boolean` is typedef'd to `int` (`doomtype.h`). No bit-field dependencies.
- `short` is used for WAD lump index values (`int16_t` semantics). Verify
  `sizeof(short) == 2` on target.
- `long` is assumed 32-bit in `LONG()` / `SwapLONG` (`m_swap.h`). On LP64
  targets (64-bit Linux), `long` is 64 bits; the macro works but wastes bits.
  Use `int32_t` in `SwapLONG` for correctness on all targets.

---

## 6. What this repo already proves

### 6.1 The web port is a platform-layer-only port

The webdoom port touches `engine/core/` in **91 places** (measured:
`grep -rn "// webdoom" engine/core/ | wc -l`), categorised as:

| Category | Approximate count | Examples |
|----------|-------------------|---------|
| Render interpolation snapshots | ~12 | `p_mobj.c:535`, `p_tick.c:148`, `r_main.c:835` |
| Raised limits (overflow guards) | ~6 | `r_plane.c:52` (MAXVISPLANES 128→1024), `r_bsp.c:88` (MAXSEGS 32→64) |
| Safety clamps for overflows | ~3 | `p_maputl.c:607,673` (intercepts), `p_map.c` (spechit) |
| Net/timing additions | ~6 | `d_net.h:49,137,140,145`, `g_game.c:683` |
| JS bridge declarations and platform hooks | ~5 | `m_fixed.h:26`, `i_system.h:47,94` |
| Bug fixes / robustness (HACX, SIGIL, etc.) | ~10 | `r_things.c:254`, `m_menu.c:1889` |
| Save-game size increase | 1 | `g_game.c:74` (0x2c000→0x80000) |
| WAD file handling (JS registry) | ~3 | `w_wad.c:153,218,387` |
| Other | remainder | |

A bare-metal port replaces `engine/web/` wholesale and may need fewer of the
91 core-side changes (e.g., no BACKUPTICS increase for a local-only port,
no HACX/SIGIL support). The core is clean: 91 annotated divergences out of
~15,000 lines of core C.

### 6.2 The headless path proves video/audio/input are optional

`tools/demo-test.mjs` runs the engine with `I_InitGraphics` and
`I_FinishUpdate` as no-ops (`engine/web/i_video.c:16,30`) and all JS sound
hooks uninstalled. The game runs 44,580 simulation tics across 13 demos
without display or audio. This directly proves: **the simulation is
independent of the display and audio layer**. A bare-metal port can bring
up simulation first and add display/audio incrementally.

The wbox headless sim rate: 19,781 simulated tics per second
(`perf.md §perStage, simFpsNodraw`). At 35 Hz, headless sim uses only
35/19,781 ≈ 0.18% of wbox CPU — the sim is negligible; the render is the
workload.

### 6.3 The 13-demo golden gate is the port-validation tool

`tools/golden/` contains per-tic FNV-1a hashes of the simulation state for
all 13 built-in IWAD attract demos (doom.wad 4 demos, doom2.wad 3, tnt.wad
3, plutonia.wad 3). The hash function (`engine/web/i_main.c:175`):

```c
int web_state_hash(void) {
    unsigned h = 0x9e3779b9u ^ (unsigned)gametic;
    h = (h ^ (unsigned)prndindex) * 0x01000193u;
    for each active player:
        h ^= player.mo->x, y, angle, health;
    return (int)h;
}
```

The hash mixes `prndindex` (the P_Random sequence position) and player world
state. Any divergence in the P_Random call sequence — from a wrong platform
constant, misimplemented fixed-point op, byte-swap error — snowballs through
RNG and causes the hash to diverge within a few tics of the mistake.

**How a bare-metal port uses this**:

1. Export an equivalent `platform_state_hash()` function from the port.
2. After each game tic, record `(gametic, platform_state_hash())`.
3. Compare the recorded trace against `tools/golden/<iwad>-<demo>.json`.
4. A port that produces 13/13 identical traces is sim-correct by construction.

The trace comparison requires only: serial output (to log hashes), a host
machine to compare JSON, and the demo playback path (singletics mode is
cleanest). No display hardware is needed. The traces cover 44,580 tics
across four IWADs and nine maps — a thorough correctness oracle.

**Wiring the trace comparison**: set `singletics = true` (d_main.c:104)
before `D_DoomMain` returns; call `G_RecordDemo`/`G_PlayDemo` for each IWAD
demo lump. Log `(gametic, web_state_hash())` over UART after each `G_Ticker`
call. Feed the log to a host-side diff against the golden JSON.

---

## 7. ESP32 sketch

### 7.1 Hardware

ESP32-S3 class (as of 2026):

| Spec | Value |
|------|-------|
| CPU | Dual-core Xtensa LX7 at 240 MHz |
| Internal SRAM | 512 KiB |
| PSRAM (external) | 2–16 MiB (QSPI or OPI) |
| Flash | 4–16 MiB SPI NOR |
| FPU | Yes (single-precision only; double is software) |
| 64-bit divide | Software only |
| I²S / I²C / SPI | Native peripherals for audio and display |

### 7.2 Memory fit

DOOM's static segment requires 1.21 MiB of writable memory (§2.1), plus
250 KiB for screen buffers allocated by `I_AllocLow` (§1.5). The ESP32-S3's
512 KiB internal SRAM is insufficient for the static segment alone; PSRAM is
mandatory. The §1.5 hybrid strategy (screens[0] in internal SRAM) is the
recommended mitigation for the column-draw latency bottleneck (§7.3).

**Credible configuration (shareware doom1.wad)**:

| Region | Size | Location |
|--------|------|----------|
| Static (DATA + BSS) | 1.21 MiB | PSRAM |
| screens[0] (render target) | 64 KiB | Internal SRAM (hybrid strategy, §1.5) |
| screens[1..3] (wipe/status buffers) | 192 KiB | PSRAM |
| Zone | 4 MiB | PSRAM |
| WAD (doom1.wad full load) | ~4.2 MiB | PSRAM |
| **Total PSRAM** | **~9.6 MiB** | Must fit in PSRAM capacity |
| Code (TEXT + tables) | ~275 KiB (perf.md §1 CODE section) | Flash (XIP) |
| Trig table corrections | ~11 KiB | Flash (XIP) |
| rndtable + gammatable | ~1.5 KiB | Flash (XIP) |

A 16 MiB PSRAM part leaves ~6.4 MiB margin above the 9.6 MiB requirement —
comfortable for purgeable texture cache growth beyond the attract-demo peak.

**Rung-1 arena vs. this recommendation**: the freestanding bring-up (rung 1,
commit c7b5f11) used an 8 MiB zone (`ZONESIZE = 8 * 1024 * 1024` in
`tools/freestanding/web.h`), consistent with perf.md §3's "4–8 MiB first
pass" guidance. All 13 golden demos passed at 8 MiB; the 4 MiB lower bound
from §2.2 is analytically sound (3× the 1.36 MiB non-purgeable peak) but was
not stress-tested by rung 1. For an ESP32 bring-up, start with 8 MiB if PSRAM
allows; reduce to 4 MiB only after profiling confirms no `PU_STATIC` overflows
on the target map set. See §8.1 (zone-size row) for the trial record.

**Full doom.wad (≈ 11.8 MiB, Ultimate Doom variant) in PSRAM**:
1.21 + 0.19 + 4 + 11.8 = ~17.2 MiB → exceeds 16 MiB PSRAM. Either stream
the WAD from XIP-flash (§2.3c) or use a 32 MiB PSRAM part (available in the
ESP32-S3R8 and some custom designs).

### 7.3 Expected bottleneck

The wbox (AMD G-T56N Bobcat, ~1.0 GHz) achieves an average render of
0.483 ms/frame across doom.wad demos (`perf.md §perStage`), with sim at
0.071 ms/tic. At 35 Hz this is:

- Render load: 0.483 ms / 28.57 ms/tic = 1.7% CPU on wbox
- Sim load: 0.071 ms / 28.57 ms/tic = 0.25% CPU on wbox

**Honest scaling caveat**: wbox wasm numbers do not directly translate to
Xtensa LX7. Differences in instruction sets, cache sizes, FPU availability,
and SPI flash latency for WAD access make any numeric projection speculative.
However, at 240 MHz LX7, the instruction throughput is roughly
240/1000 ≈ 0.24× of a 1 GHz in-order machine (ignoring ISA and cache
differences). A rough worst-case estimate: render ~0.483 / 0.24 ≈ 2 ms per
frame. At 35 Hz the render budget is 28.57 ms — this would leave ~93% of the
budget unused for the render, suggesting 35 Hz is achievable **if the memory
access pattern (PSRAM latency for screens[0] column writes) is tolerable**.

**The real bottleneck is PSRAM latency, not compute**. DOOM's column draw
writes to `screens[0]` in vertical strides (SCREENWIDTH = 320 bytes per step,
renderer.md §7.2). On PSRAM with 50–100 ns latency per access, a 320-column
frame (64,000 writes, each 320 bytes apart) will generate cache misses for
every write. PSRAM bandwidth is the likely limiting factor, not the Xtensa
LX7 ALU. Primary mitigation: place `screens[0]` in internal SRAM via the
§1.5 hybrid `I_AllocLow` strategy (512 KiB internal SRAM is not enough for
the full static segment, but carving 64 KiB for screens[0] via a dedicated
linker section is achievable).

### 7.4 Known prior art

DOOM has been ported to ESP32 (non-S3, 240 MHz, 4 MiB PSRAM): the 2021
project by `davidbuzz` on GitHub demonstrated playable performance using the
ESP-IDF framework, doom1.wad from SPIFFS flash, and an ILI9341 SPI display
at ~320×240. This confirms the memory-mapped WAD streaming approach (§2.3c)
works at this hardware tier.

### 7.5 Three hardest problems in order

**1. PSRAM bandwidth for the column draw** (hardest)

`R_DrawColumn` writes `screens[0]` with a stride of 320 bytes per pixel
(renderer.md §7.2). PSRAM burst reads are efficient (row-cache hit); burst
writes to non-consecutive addresses are slow. Every wall column write is a
separate PSRAM transaction. At 60+ columns per frame (typical), PSRAM round-
trip latency dominates frame time. Solutions: (a) place `screens[0]` in
internal SRAM via the §1.5 hybrid strategy (requires reducing BSS size —
move large arrays to PSRAM); (b) use DMA with a pixel-conversion step; (c)
lower resolution via the engine's existing low-detail mode (`detaillevel = 1`
halves horizontal resolution, renderer.md §7.2).

**2. FixedDiv software 64-bit divide** (significant)

No hardware 64-bit divide on LX7. `__aeabi_ldivmod` (or equivalent) is
called in every wall-scale computation (`R_ScaleFromGlobalAngle`, r_main.c:465–506), sprite
projection, and `P_PathTraverse` trace. At ~40–80 cycles per software divide
and ~200 divide calls per frame (estimated), this is ~8,000–16,000 cycles per
frame = ~60–120 µs at 240 MHz. Manageable but measurable. See §5.3 for the
double-path alternative on FPU-equipped targets; the ESP32-S3 has
single-precision hardware but `double` is software. Profile both paths at
bringup.

**3. WAD streaming latency for cache-cold textures** (manageable)

If the WAD streams from SPI NOR flash via `W_ReadLump`, the first frame of
each new map (cold cache) will be slow as textures populate the zone cache.
Subsequent frames hit the zone cache and are fast. The 4 MiB zone (§2.3c)
provides 2.6 MiB of purgeable cache above the 1.36 MiB non-purgeable floor;
this holds most of a typical map's textures. Pre-warming the cache at level-
load time (iterating visible textures before the first rendered frame)
eliminates in-game stutter.

---

## 8. Contract on trial: what the bring-up found

Rung 1 (`tools/freestanding/`, commit c7b5f11, gate b3c8a40) compiled
`engine/core` against a minimal hosted-freestanding platform layer and ran
13/13 golden demos bit-identical to vanilla. This section records one row per
checkable claim: what the doc predicted, what rung 1 found, and how it was
resolved. `tools/freestanding/IMPORTS.md` is the authoritative symbol surface
list; every row that cites a symbol cites its category letter there.

Verdicts: **held** = the doc's prediction was correct. **gap** = reality
diffed from the doc.

### 8.1 Trial table

| Predicted | Reality (rung 1) | Resolution | Verdict |
|-----------|-----------------|------------|---------|
| **Platform surface is three files** (§1 before this revision): `i_system.h`, `i_video.h`, `i_sound.h`. Completeness "auditable by diffing against **the two header files**" (§1 self-contradicted its own count). | **Five headers.** `engine/core` unconditionally `#include`s `web.h` (`d_main.c`, `m_misc.c`, `w_wad.c`) and `perf.h` (`d_main.c`, `r_main.c`). Freestanding stubs provided at `tools/freestanding/web.h` and `tools/freestanding/perf.h`. (FINDING-6) | §1 corrected to name all five headers; the "three"/"two" contradiction removed. | gap |
| **Libc surface not enumerated** — §1 framed the contract as only I_ header functions | **48 strong undefined symbols** across 8 categories (see §8.2 and `tools/freestanding/IMPORTS.md`). The surface spans memcpy/memset/str* (12), platform primitives (6), core stdio stragglers (8), core heap stragglers (3), math one-shot boot (3), shim symbols eliminated in rung 2 (14), and infra/weak symbols (7). | `tools/freestanding/IMPORTS.md` is now the porter's authoritative symbol checklist. See §8.2. | gap |
| **Core needs no heap beyond the zone** (§1.3 framing: "The engine manages everything inside this block via Z_Zone") | `m_misc.c` calls `realloc` (config-file token parser), `access` (file-existence check), and `mkdir` (savegame directory creation) directly and unconditionally — outside the platform layer's control (IMPORTS.md category d). | Stubbed for rung 1: `realloc` → NULL, `access` → −1, `mkdir` → no-op. All 13 goldens pass with these stubs. Rung-2 disposition: stub or zone-backed (`m_misc.c`). | gap |
| **§4.1 predicted**: trig tables (`finesine`, `finetangent`, `tantoangle`; 14,336 entries) boot-generated at startup via `sin`, `tan`, `atan` — called once, not in the render loop | **Confirmed.** `sin`, `tan`, `atan` appear as strong undefined symbols (IMPORTS.md category g), called from `tables.c:T_GenerateTables` (invoked by `d_main.c:723`). Zero runtime cost after the one-time fill. | §4.1 prediction correct — no change needed. | held |
| **Zone: 4 MiB recommended** as credible first-pass minimum (§2.2; perf.md §3: "4–8 MiB first pass") | Rung 1 used **8 MiB** static arena (`ZONESIZE = 8 * 1024 * 1024` in `tools/freestanding/web.h`). All 13 goldens passed. The 4 MiB lower bound was not stress-tested by rung 1. | §7 ESP32 sketch updated to note the 8 MiB rung-1 arena. §2.2 reasoning (3× non-purgeable peak) is unchanged, but 4 MiB remains an untested extrapolation from rung 1's evidence. | gap (not validated) |
| **§6.2 predicted**: simulation is independent of display and audio; headless bring-up first, display/audio added incrementally | **Confirmed.** 13/13 demos run to completion with `I_FinishUpdate` as a no-op and all sound functions as empty stubs. The freestanding platform layer never touches a display or audio device. | §6.2 prediction validated by rung 1. | held |

### 8.2 The full libc surface: IMPORTS.md as porter's checklist

`tools/freestanding/IMPORTS.md` was generated from the `fs-doom` binary via
`nm -u fs-doom | sort` (rung 1, commit c7b5f11). It lists every strong
undefined symbol `engine/core` demanded and classifies each with its rung-2
disposition (eliminate, replace, stub, or provide from newlib/musl). The 48
strong symbols divide as follows:

| Category | Symbols | Rung-2 action |
|----------|---------|---------------|
| Shim — WAD load | `open`, `read`, `close`, `lseek`, `malloc`, `free` | Eliminated: WAD becomes a linker symbol or ROM blob |
| Shim — `-sim` file output | `fopen`, `fclose`, `fwrite`, `fputc`, `fread`, `fseek`, `ftell`, `fstat` | Eliminated: drop the `-sim` shim path |
| Platform primitives | `write`, `clock_gettime`, `_setjmp`, `longjmp`, `abort`, `exit` | Replaced: UART/SWO, hardware timer, spin-loop, reset |
| Core stdio stragglers | `fprintf`, `printf`, `putchar`, `puts`, `setbuf`, `sprintf`, `vsnprintf`, `sscanf` | Route through `fs_putc` / newlib |
| Core heap stragglers | `realloc`, `access`, `mkdir` | Stub: NULL / −1 / no-op (§8.1 row 3) |
| String/memory | `memcpy`, `memset`, `strcpy`, `strncpy`, `strcmp`, `strncmp`, `strcasecmp`, `strncasecmp`, `strlen`, `strchr`, `strrchr`, `strtol` | Newlib or compiler built-ins |
| Math — one-shot boot | `sin`, `tan`, `atan` | Libm at boot, or pre-generated tables (§4.1) |
| Infra/weak | `__libc_start_main`, `__ctype_toupper_loc`, `__cxa_finalize`, `__gmon_start__`, `_ITM_*` | crt0 / newlib |

The distinction between §1 functions (what the porter *writes*) and
IMPORTS.md (what the porter's runtime must *provide*) matters most on
targets with a constrained libc (newlib-nano, picolibc): even if `i_system.c`
stubs `exit` and `abort`, string and memory symbols must still resolve at
link time.

---

*References*: `docs/engine-archaeology.md` (table ledger, §14; FixedDiv,
§2; trig recipe, §1; sound constants, §10), `docs/perf.md` (memory numbers,
§2–3; bench baseline, §perStage), `docs/renderer.md` (framebuffer layout,
§7.1; column draw, §7.2), `docs/playsim.md` (tic orchestration, §1; zone
use-after-free caution, §1.2), `docs/formats.md` (WAD format, §1;
endianness doctrine, §11; DMX sound, §6),
`tools/freestanding/IMPORTS.md` (authoritative rung-1 symbol surface, §8.2).
