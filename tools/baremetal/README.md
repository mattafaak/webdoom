# tools/baremetal — rung 2: DOOM's sim on OS-less ARM under QEMU

Task 11.1b. Extends the rung-1 freestanding core (tools/freestanding/, task
11.1a — 13/13 golden demos bit-identical on a hosted-freestanding build) to a
genuine **no-OS** ARM target: a bare ELF booted by `qemu-system-arm -M virt`
with no operating system, streaming per-tic state hashes over a UART.

## Proven foundation (de-risked before integration)
- Target: `qemu-system-arm -M virt -cpu cortex-a7 -m 32M -nographic -kernel <elf>`
- Boot: `crt0.S` sets the stack pointer (RAM is at 0x40000000; the ELF is
  linked at 0x40010000) then branches to C. No OS, no bootloader beyond QEMU's
  ELF loader jumping to the entry point.
- Byte-out: the PL011 UART0 at physical 0x09000000 — writing a byte to UARTDR
  (offset 0) emits it; `-nographic` routes UART0 to stdout. This is the
  "UART byte-out" bare-metal.md predicts, realised as ~2 instructions.
- A minimal crt0 + UART smoke build printed "BARE-METAL-UART-OK" — the risky
  unknowns (does it boot, is there a byte-out, is there enough RAM) are retired.

## What rung 2 adds over rung 1
Rung 1 was hosted-freestanding (Linux -m32, glibc, a process). Rung 2 removes
the OS entirely: no process, no glibc, no host — just a CPU, RAM, and a UART,
exactly the platform bare-metal.md claims DOOM needs. The libc surface
IMPORTS.md enumerated (memcpy/memset/str*/sin/tan/atan/…) comes from newlib
(arm-none-eabi's default C library); the I/O syscall stubs (_write→UART,
_sbrk→arena, _exit→halt) are the platform primitives.

## Rung-2 status (task 11.1b)
**Achieved & committed:** the ELF boots with NO OS under `qemu-system-arm -M
virt`, streams the full DOOM startup over the PL011 UART, and generates the
finesine/finetangent tables on ARM newlib's libm that PASS tables.c's FNV-1a
canon checksum (outcome A — the archaeology 1 robustness claim validated on a
different architecture). `engine/core` is unmodified.

**Documented gap (per-tic demo hash comparison):** startup reaches `R_Init`,
then `R_InitData` (texture composition over the full 11.8 MiB commercial WAD)
never progresses. **Classified via the QEMU gdbstub (`qemu -s` + system `gdb`,
arch arm):** it is a **runaway fault, not slowness** — the CPU is parked at
PC ~0x800000 (far below the 0x40000000 code region), `sp = 0x0`, executing
zero-filled memory (`andeq r0,r0,r0`), PC climbing monotonically. Something in
texture composition smashed the stack (SP zeroed) and a return jumped into the
weeds; with no exception vectors installed, the abort runs away silently
instead of trapping.
Ruled out: **stack depth/collision** — relocating the stack from a 64 KiB slot
above `.bss` to the top of RAM (~7 MiB headroom, the current layout) did NOT
help, so it is not a gradual stack overflow. `sp = 0` is therefore an
*overwrite*, pointing to a **wild-pointer write** during `R_InitTextures` /
`R_GenerateComposite` — a bare-metal/ARM-specific memory bug (candidate causes:
the baked-WAD pointer/offset handling in files.c, or an unaligned WAD-structure
access that x86 tolerates and this ARMv7-A config does not).
Fully pinning the write needs breakpoint-level debugging (break in
R_InitTextures, watchpoint the stack canary, single-step to the faulting
access) + installing an exception vector table so the abort reports over UART
instead of running away. That is the rung-2 completion path; left as future
work. The boot + canon trig validation is the load-bearing rung-2 result and
stands independently.

## Fault capture (13.4a)

### What was done

ARMv7 exception vectors were installed in `crt0.S` (VBAR set via MCR p15,
Data/Prefetch/Undef handlers in assembly stubs, abort-mode stack in `doom.ld`).
`abort_handler.c` prints exception type, faulting PC, DFAR, and DFSR decode
over the PL011 UART before halting. `bm-doom.elf` was rebuilt and run under:

```
qemu-system-arm -M virt -cpu cortex-a7 -m 32M -nographic -kernel bm-doom.elf
```

### UART fault dump (verbatim)

```
==============================================
  *** EXCEPTION: DATA ABORT ***
==============================================
  PC (faulting) = 0x4002beb8
  DFAR          = 0x40da85f2
  DFSR         = 0x00000001
  WnR          = 0  (read fault)
  FS[4:0]      = 0x00000001  (Alignment fault)
==============================================
  HALTED (spin).
```

### Three facts

**1. Faulting PC: 0x4002beb8 — R_InitTextures, engine/core/r_data.c:533**

```
$ arm-none-eabi-addr2line -e bm-doom.elf -f 0x4002beb8
R_InitTextures
/…/engine/core/r_data.c:533
```

The instruction at 0x4002beb8 is `ldr r1, [r2, r1]` — a word-wide load from
`r2+r1 = 0x40da85f2`. This is the compiler's inline expansion of the 8-byte
`memcpy(texture->name, mtexture->name, sizeof(texture->name))` at r_data.c:533.
The source pointer `mtexture->name` is at the misaligned address 0x40da85f2
(offset 2 from a word boundary), which faults under ARMv7 strongly-ordered
memory semantics (MMU disabled).

**2. DFAR: 0x40da85f2 — zone arena (.bss), zone-cached TEXTURE1 lump**

ELF section layout (from `arm-none-eabi-objdump -h`):

| section | start      | size       | content                        |
|---------|-----------|-----------|-------------------------------|
| .text   | 0x40010000 | 0x0003b018 | code + vectors                 |
| .rodata | 0x4004b0a8 | 0x0000a1e8 | read-only data                 |
| .data   | 0x40055290 | 0x00be2cf8 | baked WAD blob (~12.4 MiB)     |
| .bss    | 0x40c37f88 | 0x008005ec | zone arena + screen bufs + heap |

DFAR = 0x40da85f2 is in `.bss`, at offset 0x170A6A (≈1.44 MiB) from .bss base.
The zone arena (`bm_arena[6MiB]` in `i_system.c`) is in `.bss`. The TEXTURE1
lump is loaded from the baked WAD blob (`.data`) into the zone via
`W_CacheLumpNum(texture1lump, PU_STATIC)`, then `R_InitTextures` iterates its
directory with `mtexture = (maptexture_t*)((byte*)maptex + offset)`. When
`offset` is odd (as it is here), `mtexture` lands at an odd address, and the
first word-wide access (`memcpy` of `name[8]`) faults. DFAR is NOT the raw
WAD blob — it is the zone-cached copy.

**3. Candidate site: r_data.c:522 — bare-metal.md §5.2 entry #7 (IN list)**

```c
/* r_data.c:522 */
mtexture = (maptexture_t *) ( (byte *)maptex + offset);
/* ...  */
/* r_data.c:533  ← ACTUAL FAULT LINE (first word-wide dereference) */
memcpy (texture->name, mtexture->name, sizeof(texture->name));
```

`r_data.c:522` is explicitly listed in `bare-metal.md §5.2` as a known
alignment-risk site (7th entry: "offset into TEXTURE1/2 lump may be
misaligned"). The fault fires at line 533 because line 522 is a pointer cast
(no memory access); 533 is the first load from `mtexture`. The instruction is
an ARM word load (`LDR`) generated by the compiler's `memcpy` optimisation.

**DFSR decode:**

| field   | value       | meaning                          |
|---------|-------------|----------------------------------|
| FS[4:0] | 0x01        | Alignment fault                  |
| WnR     | 0 (bit 11)  | Read fault (the LDR that faulted)|
| DFSR    | 0x00000001  | Full register value              |

### Lead's hypothesis: HELD (with one nuance)

The hypothesis stated: "that signature is exactly an unhandled data abort with
no vector table installed … with the MMU OFF on ARMv7, memory is
Strongly-Ordered and ANY unaligned access data-aborts … DFAR will point into
the baked WAD region at an odd offset and the PC will map to one of those
[§5.2] sites."

**What held:**
- Unhandled data abort (DFSR FS=0x01, alignment) → confirmed.
- MMU-off Strongly-Ordered semantics causing alignment fault on unaligned LDR → confirmed.
- PC maps to R_InitTextures, one of the predicted §5.2 sites → confirmed.
- The silence before (runaway CPU at 0x800000) was exactly the absent-vector-table symptom → confirmed.

**One nuance (minor):**
- DFAR points into the **zone arena (.bss)**, not directly to the raw WAD
  blob (.data). This is because `W_CacheLumpNum` copies WAD lump data into
  zone memory before use; the alignment hazard travels with the copy.
- The §5.2 site that fired is `r_data.c:522/533` (site #7), not the
  `columnofs[]` reads at lines 277/345 (sites #4). Both are in the list, but
  the `maptexture_t` cast trips first in program order.

**Hypothesis verdict: held** (alignment fault, R_InitTextures, §5.2 site, MMU-off).

### 13.4b carry-forwards

1. **Fix policy**: implement a byte-by-byte `read_le32()` helper (bare-metal.md
   §5.2 Option A) or ensure zone allocations are always word-aligned and the
   maptex offset arithmetic preserves alignment (Option B). At minimum patch
   r_data.c:522 and the other 6 §5.2 sites before per-tic demo hashes can
   run.
2. **`-fsigned-char`** (bare-metal.md §5.1 item 6, confirmed by task 13.3a):
   ARM defaults `char` to unsigned; the engine inherits x86's signed-char
   assumption. Add `-fsigned-char` to `CFLAGS` before demo hashes can match
   the golden corpus.
