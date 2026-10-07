/* tools/cortexm/sections.ld — the layout both boards share.
 *
 *   CODE   vectors, text, rodata, data, the small .bss, and the stack at
 *          the top (CM_STACK_SIZE, painted at reset by crt0.S)
 *   ZONE   the zone arena (i_system.c's fs_arena, 4 MiB by default: the
 *          Makefile's ZONE_KB), then .wadtail, the rest of the region
 *   BIG    the screens, the harness's per-tic arrays, newlib's heap: PSRAM
 *          in the default build (an385.ld, an505.ld); CODE in the zero-copy
 *          build (*-zc.ld), whose PSRAM holds the WAD itself, which then
 *          continues in .wadtail if it is longer than 16 MiB (wad_semi.c)
 *
 * qemu loads the ELF at its link addresses, so .data needs no copy.  An input
 * section goes to the FIRST output section whose pattern matches it, which is
 * why .zone and .big come before .bss.
 * Copyright (C) 2026, GPL-2.0-or-later.
 */
ENTRY(cm_reset)
CM_STACK_SIZE = DEFINED(CM_STACK_SIZE) ? CM_STACK_SIZE : 128K;
CM_HEAP_SIZE  = DEFINED(CM_HEAP_SIZE)  ? CM_HEAP_SIZE  : 2M;

SECTIONS
{
  .text : {
    KEEP(*(.vectors))
    *(.text .text.*)
    *(.rodata .rodata.*)
    . = ALIGN(4);
  } > CODE
  .ARM.exidx : {
    __exidx_start = .;
    *(.ARM.exidx* .gnu.linkonce.armexidx.*)
    __exidx_end = .;
  } > CODE
  .data : {
    *(.data .data.*)
    . = ALIGN(4);
  } > CODE

  .zone (NOLOAD) : ALIGN(8) {
    _szone = .;
    *(.bss.fs_arena)
    . = ALIGN(4);
    _ezone = .;
  } > ZONE
  .wadtail (NOLOAD) : ALIGN(8) {
    _swadtail = .;
    . = ORIGIN(ZONE) + LENGTH(ZONE);
    _ewadtail = .;
  } > ZONE

  .big (NOLOAD) : ALIGN(8) {
    _sbig = .;
    *(.bss.fs_screenbufs) *(.bss.fs_screenbuf)
    *(.bss.cm_big.*)
    . = ALIGN(4);
    _ebig = .;
  } > BIG
  .heap (NOLOAD) : ALIGN(8) {
    _heap_start = .;
    . += CM_HEAP_SIZE;
    _heap_end = .;
  } > BIG

  .bss (NOLOAD) : ALIGN(8) {
    _sbss = .;
    *(.bss .bss.*) *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > CODE
  .stack (NOLOAD) : ALIGN(8) {
    _stack_bottom = .;
    . = ORIGIN(CODE) + LENGTH(CODE);
    _stack_top = .;
  } > CODE
  ASSERT(_stack_top - _stack_bottom >= CM_STACK_SIZE, "CODE is full: less than CM_STACK_SIZE left for the stack")

  /DISCARD/ : { *(.ARM.attributes) *(.comment) }
}
