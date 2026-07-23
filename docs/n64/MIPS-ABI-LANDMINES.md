# MIPS ABI Landmine Audit — N64 freestanding core (task 20.4a)

**Status**: static audit, capture-not-cure disposition.
**Scope**: `engine/core/` vs. MIPS R4300 (N64 o32 ABI, big-endian, strict alignment).
**Engine/core diff vs master**: 0 lines — all findings are shim-level mitigations only.

---

## Background and scope

The N64 uses a MIPS R4300i CPU: a 64-bit MIPS chip running in 32-bit
compatibility mode. The standard toolchain is libdragon's `mips64-elf-gcc
-mabi=32 -march=vr4300` — effective ABI is o32: `int=32, long=32, ptr=32`.
The bus is big-endian (word MSB at low byte address), making the N64 a
**big-endian strict-alignment ILP32** target — the hardest combination for a
codebase written for x86 little-endian.

Reference reading: `docs/bare-metal.md §5` (endianness/alignment/integer-width
contract) and `tools/freestanding/BE-NOTES.md` (iteration log from the
powerpc-linux-musleabi and mips-linux-musleabi bring-ups). This document
records only what is new or MIPS-specific; overlapping content is cited rather
than duplicated.

---

## Landmine class 1: WAD endianness (big-endian host, LE WAD format)

### Citation

`engine/core/m_swap.h:34–42` — SHORT()/LONG() macros.
`engine/core/m_swap.c:55–77` — SwapSHORT/SwapLONG for `__BIG_ENDIAN__`.
`engine/core/w_wad.c:177,187` — `(wadinfo_t*)data` / `(filelump_t*)(data+LONG(...))`.
`engine/core/p_setup.c:139,243,279,314,373,467` — map lump struct casts.
`engine/core/p_saveg.c:60–92` — raw `memcpy` of `player_t`, `mobj_t`, thinker structs.

### Why it does not manifest on x86/wasm32

x86 and wasm32 are both little-endian. `SHORT(x)` and `LONG(x)` expand to
identity (`x`), so every WAD read is a no-op macro. No byte-reversal code path
is exercised.

### MIPS R4300 exposure

The WAD format is unconditionally little-endian (`docs/formats.md §11.1`). On a
big-endian host, every multi-byte field in the WAD directory, map geometry
lumps, and lump headers requires byte-swapping. The `__BIG_ENDIAN__` path in
`m_swap.h/c` implements this. **This path is already implemented and tested:**
the `mips-linux-musleabi` qemu-user trial (bare-metal.md §5.2) achieved 13/13
golden demos bit-identical. No source change is needed.

**Savegame structs** (p_saveg.c:60, 91, 246, 302, 506–578) are `memcpy`'d
verbatim as native-endian binary blobs. They contain live pointers (e.g.,
`mobj_t::thinker.function`, thinker linked-list pointers) stored in native byte
order. N64 savegames are therefore valid only across the same N64 binary;
loading an x86-generated savegame on N64 would corrupt all integer and pointer
fields. This is expected behaviour for a bare-metal port — document it as a
known limitation, not a bug to fix.

### Disposition: capture-not-cure

No `engine/core` changes needed. The `__BIG_ENDIAN__` swap path is in place and
verified. Shim requirement: define `__BIG_ENDIAN__` before including any core
header (standard on big-endian GCC targets; libdragon's toolchain sets this
automatically).

### Detection

`bash tools/freestanding/be-check.sh` (requires a working MIPS cross-compiler)
— tests 13/13 golden demos for sim-hash identity.

---

## Landmine class 2: unaligned memory access (MIPS hardware alignment trap)

### Citation

`engine/core/r_data.c:277,345` — `LONG(realpatch->columnofs[x])` (patch column
offsets: int32 inside patch lump, potentially at offset 8 from an
arbitrarily-placed lump start).
`engine/core/r_things.c:454-455` — same `columnofs` access pattern.
`engine/core/v_video.c:252` (V_DrawPatch) and `:317` (V_DrawPatchFlipped) — two
further live `columnofs` access sites. (V_DrawPatchDirect's body, v_video.c:351-401,
is commented out — its `columnofs` use is dead code and not a port concern.)
`engine/core/r_data.c:522` — `(maptexture_t*)(maptex + offset)` (texture
composite struct at an unaligned offset within TEXTURE1/2 lump).
`engine/core/p_setup.c:279` — `(mapnode_t*)data` (BSP node array, int16 fields
at struct offset 8).

### Why it does not manifest on x86/wasm32

x86 handles unaligned loads and stores in hardware with no penalty or trap.
wasm32 has no strict alignment requirement at the language level; the Emscripten
runtime generates byte-by-byte fallback paths for the affected access patterns.
Neither platform ever raises an alignment fault.

### MIPS R4300 exposure

The R4300i raises a hardware exception (SIGBUS on Linux, abort on bare-metal) on
any multi-byte load or store whose address is not naturally aligned. A 32-bit
load from an odd address faults.

**Mitigated sites (already in codebase):**

`r_data.c:522` (`maptexture_t` cast): patched with `read_le16/read_le32`
byte-safe accessors (m_swap.h:50–60). This was the fault confirmed during the
strict-alignment trial on qemu-user MIPS (bare-metal.md
§5.2). The trial achieved 13/13 bit-identical after this fix.

`r_things.c:217,223` (sprite-name `*(int*)` string pun): patched with `read_le32`
on both sides of the compare (bare-metal.md §5.2).

**Latent risk — PWAD content:**

The `columnofs[]` accesses at r_data.c:277/345, r_things.c:454-455, and
v_video.c:252/317 read a 32-bit array starting at byte offset 8 from the
patch lump header. The 13/13 trial passed because id Software's IWADs happen to
land patch lumps at 4-byte-aligned file offsets. PWADs offer no such guarantee.
A PWAD that places a patch lump at an odd file offset will fault at one of these
six sites on the R4300i. The mitigation (`read_le32` at each columnofs access)
is documented in bare-metal.md §5.2 Option A; it has not been applied here
because the 0-diff contract prohibits core changes.

### Disposition: capture-not-cure

The IWAD-covering fixes are already in place. The PWAD latent risk is documented
and accepted per the 0-diff contract. The N64 shim is responsible for either
(a) restricting content to IWAD-origin lumps, or (b) applying the `read_le32`
mitigation at shim level by overriding the relevant macro.

### Detection

`bash tools/freestanding/be-check.sh` (MIPS backend) — validates IWAD paths.
PWAD coverage requires a PWAD with misaligned patch lumps; no automated test
exists for this case at present.

---

## Landmine class 3: char signedness (ABI-dependent default)

### Citation

`engine/core/g_game.c:1534–1535`:
```c
cmd->forwardmove = ((signed char)*demo_p++);
cmd->sidemove    = ((signed char)*demo_p++);
```
`engine/core/doomtype.h:39`:
```c
typedef unsigned char byte;
```

Related: `tools/freestanding/BE-NOTES.md §RESOLUTION` — root cause on PPC was
default-unsigned `char` from PowerPC's ABI. `docs/bare-metal.md §5.1` item 6 —
the canonical fix is `-fsigned-char`.

### Why it does not manifest on x86/wasm32

x86 GCC and Emscripten both default `char` to **signed**, matching the engine's
implicit assumption. No divergence is possible.

### MIPS R4300 exposure

ARM and PowerPC GCC default `char` to **unsigned**; this caused 0–25 tic demo
divergence on the PPC bring-up before `-fsigned-char` was added (BE-NOTES.md).

**MIPS GCC traditionally defaults `char` to signed** (matching x86), so this
landmine likely does not activate on a standard `mips64-elf-gcc` toolchain.
However, the N64/libdragon toolchain's exact default has not been confirmed in
this environment (toolchain absent — see BLOCKED section). If libdragon's build
system or a future compiler update changes the default, the engine would silently
desync demos at tics 0–25 exactly as on PPC.

The explicit `(signed char)` casts on the two demo-read sites (g_game.c:1534–
1535) and the `unsigned char byte` typedef (doomtype.h:39) are the existing
safeguards. The unguarded exposure is in any plain `char` variable used for
signed arithmetic — audit shows no such sites in the sim-critical path after the
PPC trial.

### Disposition: capture-not-cure

Add `-fsigned-char` to the N64/libdragon shim Makefile as a precautionary port
flag, matching the precedent set by `tools/freestanding/be-build.sh`. The
TABLES_CRC gate (tables_fix.h:16: `#define TABLES_CRC 0xddc6892cu`, always
defined, checked in tables.c:118–121) provides boot-time detection if the trig
table generation diverges due to libm differences. No engine/core change is
needed.

### Detection

`bash tools/freestanding/be-check.sh` (MIPS backend with and without
`-fsigned-char`) — 13/13 sim-hash identity required. First divergence would
appear at tic 0–25 depending on map.

---

## Landmine class 4: strict-aliasing flag omission

### Citation

`engine/Makefile:21`:
```
-fno-strict-aliasing -Wall -Wno-unused-variable ...
```
`tools/freestanding/Makefile:26`:
```
-fno-strict-aliasing \
```
`engine/core/w_wad.c:177`: `header = (wadinfo_t*)data;`
`engine/core/w_wad.c:187`: `fileinfo = (filelump_t*)(data + LONG(header->infotableofs));`
`engine/core/p_setup.c:139`: `ml = (mapvertex_t*)data;`
`engine/core/p_setup.c:243`: `ms = (mapsector_t*)data;`
`engine/core/p_setup.c:373`: `mld = (maplinedef_t*)data;`

### Why it does not manifest on x86/wasm32

Both the web (`engine/Makefile`) and freestanding (`tools/freestanding/Makefile`)
builds pass `-fno-strict-aliasing`. Under this flag the compiler does not
exploit type-based aliasing rules; the `(struct_t*)raw_byte_ptr` pattern is
compiled literally.

### MIPS R4300 exposure

ISO C99 §6.5 specifies that accessing an object through a pointer of an
incompatible type is undefined behaviour (the strict-aliasing rule). All of the
map-loading casts above take a `byte*` (raw WAD blob) and reinterpret it as a
struct pointer. Without `-fno-strict-aliasing`, a conforming MIPS GCC/LLVM
compiler is permitted to assume the two pointer types cannot alias the same
memory, and may hoist, sink, or eliminate loads relative to the cast. On MIPS
with `-O2` or `-O3` this could silently produce wrong map data or stale cached
values — with no compile-time error.

The risk is not about the alignment of the access (Class 2) but about the
compiler's optimizer reordering memory operations around the type violation.

### Disposition: capture-not-cure

No engine/core change needed. The N64 shim Makefile MUST include
`-fno-strict-aliasing` at the same optimization level as the rest of the build.
Without it the undefined behaviour is latent and may produce intermittent
wrong-geometry bugs that reproduce only at higher optimization levels.

### Detection

Compile with `-O2 -fsanitize=undefined` (if supported by the toolchain) and run
the golden demo suite. `-fno-strict-aliasing` must be present before running any
test at `-O2` or above.

---

## Landmine class 5: `lumpinfo_t::handle` stored as `int` (pointer-integer round-trip)

### Citation

`engine/core/w_wad.h:59`:
```c
int handle;
```
`engine/core/w_wad.c:201`:
```c
lump_p->handle = (int)(data + LONG(fileinfo->filepos));
```
`engine/core/w_wad.c:388`:
```c
memcpy(dest, (byte*)l->handle, l->size);
```

Prior art: `engine/core/r_draw.c:685` already uses `uintptr_t` for the
translationtables alignment mask — a comparable pointer-as-integer pattern
updated in an earlier task.

### Why it does not manifest on x86/wasm32

On the web (wasm32): wasm linear memory addresses are 32-bit; `sizeof(int) ==
sizeof(void*) == 4`. The `(int)` cast discards no bits and the round-trip
through `(byte*)` is safe in practice. Emscripten suppresses the warning.

On x86-64: the freestanding build (`tools/freestanding/`) uses 32-bit mode
(`-m32`), so pointers are 32-bit and again no truncation occurs.

### MIPS R4300 exposure

On MIPS o32 (`mips64-elf-gcc -mabi=32`): `sizeof(int) == sizeof(void*) == 4`.
No bits are truncated in the current N64 ABI — the cast is functionally correct.

The landmine is at the **build level**: libdragon's Makefile may enable
`-Wall -Werror` or specifically `-Wint-to-pointer-cast -Wpointer-to-int-cast`,
which would turn these explicit casts into compile errors even though no data is
lost. The build would fail before any runtime test is possible.

A secondary risk: if a future N64 toolchain version uses 64-bit pointer mode
(e.g., `-mabi=64` or an LP64 configuration), `(int)pointer` would silently
truncate the upper 32 bits and corrupt every lump handle.

### Disposition: capture-not-cure

Engine/core 0-diff contract prohibits changing `lumpinfo_t::handle` to
`uintptr_t`. The N64 shim Makefile must include `-Wno-int-to-pointer-cast
-Wno-pointer-to-int-cast` (or equivalent). If libdragon uses `-Werror` globally,
a targeted `#pragma GCC diagnostic` suppression in a shim-layer wrapper header
is the correct mitigation. Do not change `w_wad.h` or `w_wad.c`.

### Detection

`mips64-elf-gcc -mabi=32 -Wall -Werror engine/core/w_wad.c` — confirms whether
the libdragon toolchain flags this as an error. If it does, the `-Wno-` flags
above must be added to the N64 shim Makefile before the compile error blocks
further testing.

---

## BLOCKED: toolchain absent — compile-time confirmation not possible

**This section replaces the DoD item "confirm engine/core compiles against N64
newlib with 0 source-file changes (shim only)".**

### (a) What is absent

| Component | Status |
|-----------|--------|
| `mips64-elf-gcc` (libdragon cross-compiler) | Not installed |
| `mips-linux-gnu-gcc` (distro MIPS cross-compiler) | Not installed |
| `mips64el-linux-gnu-gcc` | Not installed |
| `N64_INST` environment variable | Unset |
| libdragon SDK (headers, newlib, n64tool) | Not installed |
| ares emulator (`extra/ares-emu`) | Not installed (available via pacman) |

Confirmed via:
```bash
which mips64-elf-gcc mips-linux-gnu-gcc mips64el-linux-gnu-gcc 2>/dev/null
# (no output)
echo "${N64_INST:-UNSET}"
# UNSET
```

### (b) How to install

**Option 1 — libdragon official (recommended):**
```bash
# Prerequisites
sudo pacman -S cmake ninja libpng

# Clone libdragon
git clone https://github.com/DragonMinded/libdragon.git
cd libdragon

# Build the toolchain (places mips64-elf-gcc in /opt/libdragon by default)
bash ./tools/build-toolchain.sh
export N64_INST=/opt/libdragon
export PATH=$N64_INST/bin:$PATH

# Build libdragon itself (newlib, n64 headers)
make install
```

The toolchain build script name is `tools/build-toolchain.sh` (as of libdragon
commit ~2024). Confirm the exact script name against the cloned repo since it
has been renamed across versions.

**Option 2 — AUR package (faster, no source build):**
```bash
# Install via paru/yay
paru -S libdragon-git
# or
yay -S n64chain-git
```

AUR packages for N64 toolchains exist but may lag libdragon's official
toolchain version. Prefer Option 1 for production use.

**Option 3 — ares emulator (for runtime testing):**
```bash
sudo pacman -S ares-emu
```
Needed to run N64 ROMs after compilation.

### (c) Verification commands to run after toolchain installation

Once `mips64-elf-gcc` is available and `N64_INST` is set:

```bash
# 1. Confirm ABI parameters match expectations
mips64-elf-gcc -mabi=32 -march=vr4300 -print-multi-directory
# Expected: .  (root multilib — o32 is the default for -mabi=32)

# 2. Try-compile engine/core against a minimal N64 shim
#    (shim provides i_system.h stubs, web.h stubs, perf.h stubs)
cd /path/to/n64-shim
mips64-elf-gcc -mabi=32 -march=vr4300 -EB -O2 \
  -fno-strict-aliasing -fsigned-char \
  -Wno-int-to-pointer-cast -Wno-pointer-to-int-cast \
  -I engine/core -I n64-shim/ \
  $(ls engine/core/*.c | grep -v 'i_main\|i_net\|i_sound\|i_system\|i_video\|d_net') \
  n64-shim/*.c -o doom.elf

# 3. Verify engine/core produced no source-file diff
git diff master --stat -- engine/
# Expected: (empty)

# 4. If a ROM can be produced, run the golden demo suite
bash tools/freestanding/be-check.sh  # adapt for mips64-elf backend
```

A successful compile with 0 engine/core diff and 13/13 golden demos
bit-identical would complete the DoD item left BLOCKED here.

---

## Engine/core 0-diff summary

All five landmine classes above are resolved at shim level or via compiler
flags, with no engine/core source changes required:

| Landmine | Shim mitigation |
|----------|----------------|
| 1. WAD endianness | `__BIG_ENDIAN__` defined by toolchain; swap path in place |
| 2. Unaligned access | IWAD paths fixed; PWAD risk documented; `-Wno-address-of-packed-member` if needed |
| 3. char signedness | `-fsigned-char` in N64 shim Makefile |
| 4. Strict aliasing | `-fno-strict-aliasing` in N64 shim Makefile |
| 5. `handle` as `int` | `-Wno-int-to-pointer-cast -Wno-pointer-to-int-cast` in N64 shim Makefile |

```bash
# Verification of 0-diff:
git diff master --stat -- engine/
# (empty)
```

---

## References

- `docs/bare-metal.md §5` — endianness, alignment, integer-width contracts
- `tools/freestanding/BE-NOTES.md` — iteration log: PPC + MIPS BE bring-up
- `engine/core/m_swap.h` — SHORT()/LONG() macros and read_le16/read_le32 helpers
- `engine/core/m_swap.c` — SwapSHORT/SwapLONG BE implementations
- `engine/Makefile:21` — `-fno-strict-aliasing` in web build
- `tools/freestanding/Makefile:26` — `-fno-strict-aliasing` in freestanding build
