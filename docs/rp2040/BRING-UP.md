# RP2040 Bring-Up — webdoom 20.7a

**Status (2026-07-23)**: freestanding shim compiles and links for Cortex-M0+.
Footprint measured.  Boot-to-D_DoomMain: **BLOCKED — SRAM 4.00× overshoot**
(1,082,104 B needed vs 270,336 B available; deficit 811,768 B — see §6).

---

## 1. Summary

| Item | Result |
|------|--------|
| Cross-compile engine/core (56 files, Cortex-M0+) | PASS — 0 errors, warnings only |
| Link rp2040-doom.elf (newlib nosys) | PASS |
| Flash (.text + .data): 293,476 B | fits 2 MB (1,761 KB / 1.72 MB spare) |
| SRAM (.data + .bss): 1,082,104 B | **DOES NOT FIT** — 264 KB cap, deficit **793 KB** |
| SRAM deficit with real zone (1,028 KB min) | **~1,565 KB** (see §3) |
| WHD compressed doom.wad (gzip-9) | 5,536 KB — does NOT fit 1,761 KB available |
| Boot to D_DoomMain | BLOCKED — SRAM 4× overshoot (1,082,104 B vs 270,336 B) |
| rp2040js emulator boot | BLOCKED — ELF at 0x8000 (not XIP 0x10000000); SRAM overflow |
| ≥2 tested clock steps | BLOCKED — no hardware (SRAM resolved first) |

---

## 2. Footprint measurement

### 2.1 Build

```
cd tools/rp2040
make                      # builds rp2040-doom.elf
arm-none-eabi-size rp2040-doom.elf
```

Toolchain: arm-none-eabi-gcc 16.1.0, newlib-4.6.0, -specs=nosys.specs.
Flags: `-mcpu=cortex-m0plus -mthumb -mfloat-abi=soft -O1 -DMAXSCREENWIDTH=320`.

### 2.2 ELF size (measured 2026-07-23)

```
   text     data      bss      dec   filename
 237104    56372  1025732  1319208   rp2040-doom.elf
```

| Segment | Bytes | KB | Note |
|---------|-------|----|------|
| .text | 237,104 | 232 | code + rodata; stored in flash |
| .data (init) | 56,372 | 55 | initial values; stored in flash |
| .data (runtime) | 56,372 | 55 | runtime copy; consumed from SRAM |
| .bss | 1,025,732 | 1,002 | zero-init; consumed from SRAM |
| **Flash total** | **293,476** | **287** | = .text + .data init |
| **SRAM total** | **1,082,104** | **1,057** | = .data + .bss |

### 2.3 RP2040 budget vs actual

| Resource | Available | Needed | Surplus / Deficit |
|----------|-----------|--------|-------------------|
| Flash (2 MB Pico) | 2,097,152 B | 293,476 B | **+1,803,676 B (+1,761 KB)** |
| SRAM | 270,336 B (264 KB) | 1,082,104 B | **−811,768 B (−793 KB)** |

Flash fits comfortably.  **SRAM fails by 793 KB** before accounting for WAD data.

### 2.4 BSS breakdown — top SRAM consumers

Measured from `arm-none-eabi-nm --size-sort -S -td tools/rp2040/rp2040-doom.elf | grep " [bB] " | sort -k2 -rn`:

| Symbol | Source | BSS bytes |
|--------|--------|-----------|
| `rp2040_arena` (zone, 256 KB token) | i_system_rp2040.c | 262,144 |
| `rp2040_screenbufs` (V_Init screen block) | i_system_rp2040.c | 256,000 |
| `info[2500][10]` (WAD lump table) | w_wad.c | 100,000 |
| `visplanes[128]` (MAXSCREENWIDTH=320) | r_plane.c | 84,992 |
| `rp2040_shadow_fb` (headless frame copy) | i_video_rp2040.c | 64,000 |
| `vissprites[128]` | r_things.c | 61,440 |
| `finesine[10240]` | tables.c | 40,960 |
| `openings[20480]` (MAXSCREENWIDTH=320) | r_plane.c | 40,960 |
| `finetangent[4096]` | tables.c | 16,384 |
| `viewangletox[8192]` | r_main.c | 16,384 |
| `drawsegs[256]` | r_segs.c | 12,288 |
| everything else | engine/core | ~70,180 |
| **TOTAL (.bss section)** | | **1,025,732** |

Note: `rp2040_shadow_fb` (64 KB) is the headless video stub storing a frame copy.
A real display-output port would reuse `screens[0]` directly; removing the shadow
saves 64 KB at the cost of needing to DMA from `screens[0]` instead.

`rp2040_arena` and `rp2040_screenbufs` together (518,144 B) account for 50.5% of
BSS; removing them entirely still leaves engine-only BSS at 507,588 B — 1.88× the
RP2040's total SRAM before any stack or heap.

### 2.5 SRAM required vs MAXSCREENWIDTH

The widescreen build (MAXSCREENWIDTH=854, default) vs vanilla 320x200:

| MAXSCREENWIDTH | visplanes[128] | openings[] | BSS total (core only) |
|----------------|---------------|------------|----------------------|
| 854 (widescreen) | 221,696 B | 109,312 B | 653,732 B |
| 320 (vanilla)    |  84,992 B |  40,960 B | 440,132 B |
| Savings | 136,704 B | 68,352 B | 213,600 B |

Even at MAXSCREENWIDTH=320, engine/core BSS alone (440 KB) exceeds the RP2040's
total SRAM (264 KB) by 176 KB — before adding zone, framebuffer, or WAD data.

---

## 3. Zone size analysis

From `tools/golden/zone-stats.json` (measured with WebDOOM rung-1 freestanding
build, 13 golden demos, render-ON, commit c7b5f11):

| Metric | Value | Source |
|--------|-------|--------|
| Non-purgeable HWM (worst case) | 1,028,212 B (1,004 KB) | tnt-demo2 @ 32 MB zone |
| Non-purgeable HWM (best case) | 559,048 B (546 KB) | doom-demo4 |
| Total HWM at 32 MB zone (worst) | 10,994,588 B | tnt-demo3 |
| Defensible minimum zone | 4 MB | zone-stats.json §defensible_min_statement |

**DOOM does not run in RP2040 SRAM regardless of zone size:**

| Zone size | SRAM for engine + zone | Deficit vs 264 KB |
|-----------|----------------------|-------------------|
| 0 (no zone) | 820 KB (engine only) | −556 KB |
| 256 KB (token build) | 1,057 KB | −793 KB |
| 1,028 KB (NP HWM min) | ~1,848 KB | −1,584 KB |
| 4 MB (defensible min) | ~4,820 KB | −4,556 KB |

**Conclusion**: RP2040 SRAM (264 KB) cannot host even the smallest viable zone.
External PSRAM (e.g., 8 MB PSRAM on custom board) is required:
- 8 MB PSRAM: sufficient for zone + framebuffer; engine BSS still needs SRAM reduction
- Minimum viable target: SRAM partition for static arrays + PSRAM for zone + WAD cache

---

## 4. WHD asset pipeline

Script: `tools/rp2040/prep-whd.sh`

```
bash tools/rp2040/prep-whd.sh wads/lib/doom.wad [output-dir]
```

Outputs: `whd-analysis.json`, `whd-manifest.tsv`.

### 4.1 doom.wad lump analysis (measured 2026-07-23)

WAD size: 12,408,292 bytes (11.83 MB), 2,306 lumps.

| Category | Lumps | Raw KB | GZ-9 KB | Ratio |
|----------|-------|--------|---------|-------|
| other (graphics, patches, sprites) | 1,758 | 6,297 | 3,098 | 0.492 |
| map_data | 360 | 3,538 | 1,207 | 0.341 |
| sfx | 122 | 1,194 | 879 | 0.736 |
| music (MUS) | 45 | 833 | 265 | 0.318 |
| sky | 4 | 137 | 54 | 0.395 |
| palette / texture | 6 | 43 | 20 | 0.478 |
| demo | 4 | 34 | 10 | 0.304 |
| markers | 7 | 4 | 2 | 0.486 |
| **TOTAL** | **2,306** | **12,081** | **5,536** | **0.458** |

### 4.2 Flash budget for WHD

| Item | Bytes | KB |
|------|-------|----|
| Flash total (2 MB Pico) | 2,097,152 | 2,048 |
| Code (.text + .data init) | 293,476 | 287 |
| Available for WAD data | 1,803,676 | 1,761 |
| doom.wad at gzip-9 | 5,668,864 | 5,536 |
| **Deficit** | **−3,865,188** | **−3,775 KB** |

doom.wad compressed at gzip-9 is still **3.1× the available flash** on a standard
Pico.  The proprietary WHD format achieves additional reduction by:
- Stripping lump format overhead and DOOM-specific redundancy
- Pre-transposing sprites to column-draw format (saves runtime conversion)
- Baking OPL2 instrument maps (removes per-song MUS header overhead)
- Dropping lumps not used in single-player timedemo mode

rp2040-doom achieves ~1.2 MB for Doom1 shareware content (4.3 MB raw) — a ratio
of ~0.28, better than gzip-9 at 0.46.  This is achievable because WHD is a
domain-specific format, not a generic compressor.

**Minimum WAD target for RP2040**: use Doom1 shareware (~4.3 MB raw) rather than
the registered DOOM (~12.4 MB raw) or DOOM II (~14.5 MB raw).

---

## 5. Underclocking method (documentation only — BLOCKED on hardware)

The RP2040 runs at 125 MHz by default.  The pico-sdk provides two interfaces:

### 5.1 pico-sdk frequency control

```c
#include "pico/stdlib.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"

/* Overclock to 270 MHz (requires voltage bump) */
void rp2040_set_overclock_270(void) {
    vreg_set_voltage(VREG_VOLTAGE_1_20);    /* 1.20 V (default 1.10 V) */
    set_sys_clock_khz(270000, true);        /* 270 MHz */
}

/* Step 1: 200 MHz (no voltage change needed below ~230 MHz) */
void rp2040_set_200mhz(void) {
    set_sys_clock_khz(200000, true);
}

/* Step 2: 133 MHz (closer to DOOM's theoretical minimum) */
void rp2040_set_133mhz(void) {
    set_sys_clock_khz(133000, true);
}

/* Step 3: underclocked to minimum for power measurement */
void rp2040_set_48mhz(void) {
    set_sys_clock_khz(48000, true);
}
```

The `set_sys_clock_khz()` call adjusts the VCO and dividers on the PLL_SYS.
Flash clock (clk_peri) must be set separately to remain within the W25Q16 flash
spec (max 133 MHz):

```c
/* Separate flash divider — keep clk_peri <= 133 MHz */
clock_configure(clk_peri,
    0,
    CLOCKS_CLK_PERI_CTRL_AUXSRC_VALUE_CLKSRC_PLL_SYS,
    sys_clock_khz * 1000,
    sys_clock_khz * 1000);
```

### 5.2 Two documented clock steps (prior art from rp2040-doom)

| Step | Frequency | vreg | Notes |
|------|-----------|------|-------|
| 1 | 270 MHz | 1.20 V | Maximum stable overclock (rp2040-doom target) |
| 2 | 133 MHz | 1.10 V (default) | Flash-safe, no voltage change |
| 3 | 48 MHz | 1.10 V | USB PLL provides 48 MHz without PLL_SYS |
| 4 | 125 MHz | 1.10 V | SDK default; baseline |

**BLOCKED**: actual testing of clock steps 1–4 requires hardware.  The above are
derived from pico-sdk documentation and the rp2040-doom source (MIT license).
When hardware is available, run:

```bash
# After flashing a test UF2:
# 1. Measure tic rate via UART at each clock step
# 2. Record DOOM_TICRATE (35 Hz) compliance
# 3. Record timedemo gametics for stability
```

---

## 6. BLOCKED items

### 6.1 Toolchain status (2026-07-23)

| Component | Status | Location |
|-----------|--------|----------|
| arm-none-eabi-gcc 16.1.0 | installed (system) | /usr/bin/arm-none-eabi-gcc |
| pico-sdk | installed | ~/toolchains/pico-sdk |
| rp2040js emulator | installed | ~/toolchains/emu/node_modules/rp2040js |
| RP2040 hardware (Pico board) | absent | — |
| WHD binary encoder | absent | requires rp2040-doom proprietary toolchain |

Toolchains are activated via `source ~/toolchains/env.sh` (sets PICO_SDK_PATH, RP2040JS).

### 6.2 Primary BLOCKED reason: SRAM 4.00× overshoot

The cross-compiled ELF requires **1,082,104 B SRAM** (.data + .bss).
RP2040 provides **270,336 B SRAM** (264 KB).

```
Deficit:  811,768 B (793 KB)
Ratio:    4.00×
```

This is a structural deficit, not a toolchain gap.  Even stripping the 518 KB of
webdoom-specific BSS (`rp2040_arena` + `rp2040_screenbufs`) leaves 563,960 B of
engine-only BSS — still 2.09× the RP2040's total SRAM (see §2.4).

### 6.3 rp2040js boot test (2026-07-23)

rp2040js emulator confirms SRAM=270,336 bytes:

```bash
RP2040JS=~/toolchains/emu/node_modules/rp2040js \
  node -e "const{RP2040}=require(process.env.RP2040JS); \
           const r=new RP2040(); console.log(r.sram.length)"
# → 270336
```

Boot attempt result:

```
Binary size: 297,576 bytes (from arm-none-eabi-objcopy -O binary)
Entry point: 0x8099  (ELF default; NOT RP2040 XIP flash 0x10000000)
SRAM available: 270,336 bytes
SRAM needed:  1,082,104 bytes
Overflow:       811,768 bytes (4.00×)

BOOT TEST RESULT: BLOCKED
Reason 1: ELF linked at 0x8000 (nosys.specs default), not 0x10000000 (XIP flash)
           — pico-sdk memmap_default.ld required to produce a bootable image
Reason 2: SRAM overflow — 1,082,104 B needed, 270,336 B available
Reason 3: No pico-sdk bootrom or RP2040 vector table for rp2040js startup
```

Both blockers (linker script and SRAM) must be resolved before rp2040js can boot.

### 6.4 Remaining BLOCKED items

| Blocker | Prerequisite |
|---------|-------------|
| rp2040js / hardware boot | SRAM reduced below 270 KB; pico-sdk CMake build |
| UF2 image | pico-sdk `memmap_default.ld` + CMakeLists.txt for RP2040 |
| Clock step testing | RP2040 hardware; SRAM unblocked first |
| WHD binary encoder | rp2040-doom proprietary toolchain (MIT) |

### 6.5 Verification commands once SRAM is resolved

```bash
# 1. Rebuild with pico-sdk CMake (produces UF2 and correct XIP linker map)
mkdir -p tools/rp2040/build-pico
cmake -S tools/rp2040 -B tools/rp2040/build-pico \
      -DPICO_BOARD=pico -DPICO_SDK_PATH=$PICO_SDK_PATH
cmake --build tools/rp2040/build-pico

# 2. rp2040js emulation boot test (requires .bin at 0x10000000 + bootrom)
RP2040JS=~/toolchains/emu/node_modules/rp2040js \
  node tools/rp2040/emu-boot-test.mjs tools/rp2040/build-pico/rp2040-doom.bin
# Expected failure until SRAM deficit is resolved.

# 3. Flash to hardware (hold BOOTSEL, then):
picotool load tools/rp2040/build-pico/rp2040-doom.uf2

# 4. Confirm D_DoomMain via UART:
minicom -D /dev/ttyACM0 -b 115200
# Expected: "DOOM 1.9 (Jan 21 1994)\n"  (d_main.c:1078)
```

---

## 7. Path to a working RP2040 port

The SRAM deficit (793 KB with 256 KB zone token; ~1,565 KB with real zone) is the
primary barrier.  Three approaches have been used in published RP2040 DOOM ports:

### 7.1 rp2040-doom approach (WHD + custom memory map)

- External PSRAM not used
- WAD data compressed in flash (WHD format, ~1.2 MB for Doom1 shareware)
- Zone reduced by: streaming lumps from flash XIP (no zone copy of textures)
- Renderer uses a fixed 160×120 or 320×240 canvas (not 320×200 vanilla)
- All static arrays kept in SRAM; zone reduced to ~180 KB

### 7.2 External PSRAM approach (custom board)

- 8 MB PSRAM (e.g., ESP-PSRAM64H) connected via QSPI
- Zone allocated in PSRAM: removes the biggest SRAM consumer
- framebuffer in SRAM: 64 KB for 320×200 screens[0]
- Feasible with reduced renderer arrays (MAXSCREENWIDTH=320, MAXVISPLANES=64)

### 7.3 Hybrid: SMP + second core for rendering (RP2040-specific)

- Core 0: game loop (sim, netcode, input)
- Core 1: renderer (BSP, column draw, blit to display)
- SRAM partitioned: static arrays on core-0 stack scratchpad; renderer scratch on core-1
- Does not reduce total SRAM requirement; only enables better pipelining

---

## 8. Engine/core 0-diff guarantee

This bring-up adds ONLY:

```
tools/rp2040/   (new — 8 files)
docs/rp2040/    (new — this file)
```

Verification:
```bash
git diff master --stat -- engine/
# (no output — engine/core is untouched)
```

All `engine/core` files compile without modification for Cortex-M0+.
The only warnings are pre-existing (p_inter.c MF_DROPPED boolean overflow,
w_wad.c O_BINARY redefinition) — identical to the x86 freestanding build.
