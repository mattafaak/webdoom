ENTRY(_start)
/* 26 MiB covers: ~2 MB code/rodata + 12.4 MB baked WAD (.data) + 6 MB arena (.bss) + 64 KB stack */
MEMORY { RAM (rwx) : ORIGIN = 0x40010000, LENGTH = 26M }
SECTIONS {
  .text : { *(.text._start) *(.text*) } > RAM
  /* ARM exception index table — needed by libgcc unwind even in C bare-metal */
  .ARM.exidx : {
    __exidx_start = .;
    *(.ARM.exidx*)
    *(.gnu.linkonce.armexidx.*)
    __exidx_end = .;
  } > RAM
  .rodata : { *(.rodata*) } > RAM
  .data : { *(.data*) } > RAM   /* objcopy WAD lands here (~12 MB) */
  .bss : {
    *(.bss*)
    *(COMMON)
  } > RAM
  . = ALIGN(8);
  _heap_end = .;          /* end of .bss — everything above here to stack_top is free */
  /* Stack at the TOP of RAM, far from .bss, growing down. Megabytes of slack
     between _heap_end and _stack_top, so a deep stack cannot collide with the
     zone arena / heap in .bss (the rung-1 layout put a 64 KiB stack directly
     above .bss; a stack smash there zeroed SP and ran the CPU off into low
     memory — the R_InitData fault this classifies). */
  _stack_top = ORIGIN(RAM) + LENGTH(RAM);
}
