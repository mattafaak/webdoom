// tools/n64/n64_platform.h — N64 (MIPS R4300i) libdragon platform shim header.
//
// PURPOSE: minimum definitions for compiling engine/core against the N64
// libdragon platform shim.  Mirrors the role of tools/freestanding/fs_platform.h
// in the RP2040 bring-up, adapted for MIPS/libdragon bare-metal.
//
// SCOPE: software rasterizer only; no RDP renderer.
//   WAD: none in a footprint build; read in place from ROM otherwise.
//   UART: libdragon debug_init_emulog() → ares ISViewer channel.
//   engine/core has no N64-specific changes; the port is tools/n64/.
//
// ABI NOTE (docs/retro.md, "MIPS landmines"):
//   libdragon uses -mabi=o64 -march=vr4300 (ILP32, big-endian).
//   mips64-elf-gcc defines __BYTE_ORDER__ and __MIPSEB__ but NOT the legacy
//   __BIG_ENDIAN__ that m_swap.h tests, so the Makefile passes
//   -D__BIG_ENDIAN__; without it SHORT()/LONG() are identity and every WAD
//   field is read byte-reversed.
//
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __N64_PLATFORM_H__
#define __N64_PLATFORM_H__

#include "doomtype.h"

// ── Zone pool size ────────────────────────────────────────────────────────────
// N64 has 4 MB RDRAM (8 MB with Expansion Pak).  Zone sits in RDRAM.
// The Makefile sets N64_ZONE_KB (2,560 by default: 512 KB runs out during the
// attract demo, whose non-purgeable peak alone is 1,081,972 B; retro.md, §2).
// This fallback applies only to a build outside that Makefile.
// Override: make N64_ZONE_KB=2048
#ifndef N64_ZONE_KB
#define N64_ZONE_KB 512
#endif
#define N64_ZONE_SIZE ((N64_ZONE_KB) * 1024)

// ── Screen buffer size ────────────────────────────────────────────────────────
// Software rasterizer: 320×200 palette-index framebuffer.
// There is no RDP output path.
#define N64_ALLOCLOW_SIZE (320 * 200 * 4)

// ── UART byte-out primitive ───────────────────────────────────────────────────
// Uses libdragon's ISViewer channel (visible in ares UART pane).
// After n64_debug_init(), all fprintf(stderr,...) routes to ISViewer.
// Call n64_putc only for direct byte writes (e.g., I_Error).
void n64_putc(int c);
void n64_debug_init(void);

// ── WAD blob registry ─────────────────────────────────────────────────────────
// On real hardware, the WAD lives in ROM and is DMA-read via libdragon DFS.
// For the footprint build, pass NULL / len 0 to suppress WAD access.
void n64_register_wad(const byte* data, int len);

// ── Timedemo exit mechanism ───────────────────────────────────────────────────
// I_Error("timed %i gametics...") longjmps here on demo completion.
#include <setjmp.h>
extern volatile int n64_timedemo_active;
extern volatile int n64_timedemo_gametics;
extern jmp_buf      n64_demo_jmp;

// ── Smooth-render / wipe suppressors (demo-mode) ─────────────────────────────
extern boolean smoothrender;
extern boolean wipeactive;

// ── Sim-hash trace ────────────────────────────────────────────────────
// n64_record_hash(): append fs_state_hash()-equivalent for the current gametic.
// n64_demo_complete_halt(): named GDB breakpoint target; fires when trace done.
// n64_trace[] / n64_trace_len: the accumulated hash array.
extern int n64_trace[];
extern int n64_trace_len;
void n64_record_hash(void);
void n64_demo_complete_halt(void);
// n64_dump_trace(): print the whole trace over the debug log channel, so the
// harness can read it out of ares's captured stdout without a debugger.
void n64_dump_trace(void);

#endif /* __N64_PLATFORM_H__ */
