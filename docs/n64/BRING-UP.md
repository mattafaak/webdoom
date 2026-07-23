# N64 libdragon bring-up notes — task 20.4b

## Status (2026-07-23)

ROM builds and links cleanly.  Emulator boot is blocked by a SIGSEGV in the
ares binary during GUI/window initialization — see `tools/n64/ares-boot.log`.
The ares binary itself is healthy (`--version` / `--help` return rc=0); the
crash is limited to the SDL3/GTK3 window creation path.  xvfb-run (not
installed; root required to install) is the recommended remedy.

## Memory analysis

Build configuration: `N64_ZONE_KB=512` (default), `MAXSCREENWIDTH=320`.

```
Section     Bytes        KB    Notes
--------  ---------   ------  ---------------------------------------------
.text       292,316    285.5  Code (engine/core + shim + libdragon)
.data        53,944     52.7  Initialized data
.bss        936,788    914.8  Uninitialized data (see breakdown below)
--------  ---------   ------
Total     1,283,048  1,252.0  Combined ELF size

RDRAM budget (hardware = 4 MB base, 8 MB with expansion pak)
.data + .bss in-use:     990,732 B  (  967.5 KB)  ← fits stock N64 (4 MB)
4 MB RDRAM headroom:   3,203,572 B  (3,128.5 KB)
8 MB RDRAM headroom:   7,397,876 B  (7,224.5 KB)

ROM (z64, footprint build):  360,448 B  (352 KB)
```

### Top BSS contributors

| Symbol           | Size (B)  | Source          | Notes |
|------------------|-----------|-----------------|-------|
| n64_arena        |   524,288 | i_system_n64.c  | Zone allocator arena (N64_ZONE_KB=512) |
| n64_screenbufs   |   256,000 | i_system_n64.c  | 320×200×4 shadow framebuffer (AllocLow) |
| finetangent      |    16,384 | engine/core     | Trig table |
| tantoangle       |     8,196 | engine/core     | Trig table |
| zlight           |     8,192 | engine/core     | Lighting table |
| n64_pal_rgb      |       768 | i_video_n64.c   | 256-entry RGB palette shadow |

### N64 vs RP2040 budget comparison

| Platform | .data+.bss (B) | .data+.bss (KB) | Hardware RAM | Verdict |
|----------|---------------|-----------------|--------------|---------|
| N64      |       990,732 |          967.5  | 4,096 KB     | fits (headroom 3,128 KB) |
| RP2040   |     1,082,104 |        1,056.7  |   264 KB     | over by 4.00× |

**N64 vanilla DOOM fits comfortably in RDRAM.**  The RP2040 build (task 20.7a)
exceeded the 264 KB SRAM limit by 4× and is architecturally infeasible without
a complete memory overhaul.  On N64, the zone arena (n64_arena = 524 KB) alone
is larger than the entire RP2040 address space — and N64 still has 3 MB headroom
after all statics.

Note: n64_arena (524,288 B) is a user-controlled constant (`N64_ZONE_KB=512`).
The 512 KB default was chosen deliberately to give DOOM's zone allocator room.
Reducing it to 256 KB would save 256 KB of RDRAM with no code change, if a
smaller zone suffices for the WAD in use.

## MIPS ABI landmine retrospective (from task 20.4a)

`docs/n64/MIPS-ABI-LANDMINES.md` defined 5 landmine classes.  Here is what
actually manifested during the build of task 20.4b:

### Class 1 — Endianness (big-endian MIPS vs little-endian x86)

**Disposition: Did not trigger at compile time.**
engine/core uses `#ifdef __BIG_ENDIAN__` in `m_swap.h` to reverse the swap
macros, so the same source compiles correctly on both architectures.
mips64-elf-gcc defines `__BIG_ENDIAN__` for `-mabi=o64`.
Result: clean compile, no patching needed.

### Class 2 — Unaligned memory access

**Disposition: Did not trigger.**
DOOM's data structures are already naturally aligned.  The shim allocators
(`n64_arena`, `n64_screenbufs`) are declared `__attribute__((aligned(8)))`,
so no SIGBUS exposure.

### Class 3 — `char` signedness

**Disposition: Required mitigation.**
Several engine paths treat `char` as signed (lump name comparisons, palette
index arithmetic).  mips64-elf-gcc defaults to `unsigned char` on MIPS.
Fix: `-fsigned-char` added to `COMMON_FLAGS`.  No source changes.

### Class 4 — Strict-aliasing UB

**Disposition: Required mitigation.**
DOOM's renderer (`r_draw.c`, `v_video.c`) uses `byte *` / `int *` aliasing
patterns common in 1993 C.  Under `-O2 -fstrict-aliasing` the compiler is
permitted to misoptimize these.
Fix: `-fno-strict-aliasing` added to `COMMON_FLAGS`.  No source changes.

### Class 5 — lumpinfo handle cast (pointer ↔ int)

**Disposition: Warnings present; required warning suppression.**
`w_wad.c` casts `int` lump handles to/from `void *` (a pattern predating
64-bit pointers).  Under `mips64-elf-gcc` these generate
`-Wint-to-pointer-cast` / `-Wpointer-to-int-cast` warnings that are treated
as fatal under `-Werror`.
Fix: `-Wno-int-to-pointer-cast -Wno-pointer-to-int-cast` added to
`COMMON_FLAGS`.  The casts are functionally correct (handles are small
integers, never real pointers).

### Bonus: GNU89 / GNU11 CFLAGS split (libdragon inline semantics)

**This was the hardest issue and was not in the original 20.4a landmine list.**

`n64sys.h` (libdragon) declares functions as plain `inline` (without `static`).
Under `-std=gnu89`, the GNU C89 `inline` semantics treat a non-static inline
function as a *strong external definition* — emitting a global symbol every
translation unit that includes the header.  When multiple shim files include
`<n64sys.h>`, the linker sees multiple definitions of `sys_bbplayer`,
`get_tv_type`, etc. and raises a hard error.

Under `-std=gnu11` (C99+ semantics), a plain `inline` without `extern` is a
*weak inline* that the compiler may emit or omit — the standard-compliant
behaviour that libdragon expects.

Fix: split CFLAGS into two variables in the Makefile:
```makefile
CORE_CFLAGS := $(COMMON_FLAGS) -std=gnu89   # engine/core/*.c
PLAT_CFLAGS := $(COMMON_FLAGS) -std=gnu11   # tools/n64/*.c (shims)
```
This keeps engine/core compilable under C89 (it uses implicit-int idioms)
while giving the N64 shim the correct inline semantics from libdragon.

## Toolchain

- Compiler: `mips64-elf-gcc 14.4.0` (built from source, `~/toolchains/n64/`)
- ABI: `-mabi=o64 -march=vr4300 -mtune=vr4300` (MIPS R4300i, big-endian, ILP32 effective)
- libdragon: built from source at `~/toolchains/libdragon/`
- Linker script: `$(LIBDRAGON)/n64.ld` (provides `_start`, KSEG0 @ 0x80000000)
- ROM tool: `n64tool` compiled from `$(LIBDRAGON)/tools/n64tool.c`

## FINDING-1: ares emulator crashes during GUI initialization

**Symptom**: SIGSEGV (signal 11) every time ares opens a game window.
`--version` and `--help` return rc=0 (binary is healthy); only the
SDL3/GTK3 window-creation path crashes.

**Root cause (best hypothesis)**: Incompatibility between the pre-compiled
ares binary (built 2026-07-23) and the SDL3 or OpenGL driver state in the
current shell environment.

**Unblocking path**:
1. `pacman -S xorg-server-xvfb` (as root) then `make boot-log` (uses `xvfb-run -a`)
2. Build ares from source against the local SDL3 version
3. Once mupen64plus or cen64 is installed: adapt the boot-log target to use it

**Expected UART output** (`debugf` → ISViewer → ares UART pane):
```
N64 webdoom boot: initialising shim layer
===========================================================================
DOOM Shareware Startup v1.9
===========================================================================
```
After the banner, `W_InitMultipleFiles` calls `I_Error` (NULL WAD blob)
→ `longjmp` → "N64 webdoom: demo completed normally" → spin loop.
This is the expected exit path for a footprint build.

## Build commands

```bash
source ~/toolchains/env.sh

cd tools/n64/
make               # build ELF + z64 ROM + print size table
make boot-log      # attempt ares UART capture (requires xvfb or working display)
make clean
```

## Next steps (task 20.4c / 20.5)

- Unblock ares boot: install xvfb (`sudo pacman -S xorg-server-xvfb`) then `make boot-log`.
- 20.5: implement RDP hardware rasterizer (replace `i_video_n64.c` headless stub).
- 20.4c: controller input via libdragon `joypad.h`.
