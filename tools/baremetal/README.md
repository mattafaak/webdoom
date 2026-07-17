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
then `R_InitData` (texture/flat/sprite composition over the full 11.8 MiB
commercial WAD) does not progress under QEMU's TCG interpreter — 300 s with
zero progress dots. It is NOT zone-starvation: raising the arena 6 to 16 MiB
did not help (over-large BSS instead regressed the boot). Likely a silent
bare-metal fault in texture composition (no exception vectors installed, so a
data abort loops silently) or intractable TCG slowness. Distinguishing needs a
GDB stub (`qemu -s -S` + `arm-none-eabi-gdb`) — future work. The boot + canon
trig validation is the load-bearing rung-2 result and stands independently.
