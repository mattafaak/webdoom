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
