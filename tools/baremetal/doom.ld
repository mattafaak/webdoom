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
  . = . + 0x10000;        /* 64 KiB stack */
  _stack_top = .;
}
