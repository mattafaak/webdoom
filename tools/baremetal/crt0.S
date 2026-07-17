.section .text._start
.global _start
_start:
    ldr  sp, =_stack_top          /* set up the stack (virt RAM: 0x40000000+) */
    bl   bm_main
1:  b    1b
