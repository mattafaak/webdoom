ENTRY(_start)
MEMORY { RAM (rwx) : ORIGIN = 0x40010000, LENGTH = 14M }
SECTIONS {
  .text : { *(.text._start) *(.text*) } > RAM
  .rodata : { *(.rodata*) } > RAM
  .data : { *(.data*) } > RAM
  .bss : { *(.bss*) *(COMMON) } > RAM
  . = ALIGN(8);
  . = . + 0x10000;        /* 64 KiB stack */
  _stack_top = .;
}
