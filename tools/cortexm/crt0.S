/* tools/cortexm/crt0.S — vectors and reset for the Cortex-M builds.
 *
 * Lineage: tools/baremetal/crt0.S (deleted in 6609b57) booted the core on
 * `-M virt -cpu cortex-a7` and died silently on an alignment abort until
 * 99db300 installed vectors.  This is its Cortex-M successor: every exception
 * has a real vector, and every fault lands in cm_fault (fault.c), which
 * prints it over the UART and exits qemu non-zero.  Nothing runs away.
 *
 * ARMv6-M instructions only, so the one file serves both builds.
 *
 * Reset:
 *   1. paint the whole stack region with CM_STACK_PAINT (board.h): the deepest
 *      word found overwritten after a run is the peak stack;
 *   2. zero every NOLOAD region the C code treats as .bss;
 *   3. cm_board_init (board.c): CCR, fault enables, UART, timer;
 *   4. cm_start (cm_main.c or selftest.c), which never returns.
 * Copyright (C) 2026, GPL-2.0-or-later.
 */
    .syntax unified
    .thumb

    .section .vectors, "a", %progbits
    .align 9                    /* VTOR needs >= 512-byte alignment here */
    .global cm_vectors
cm_vectors:
    .word _stack_top
    .word cm_reset
    .word cm_fault_entry        /*  2 NMI */
    .word cm_fault_entry        /*  3 HardFault */
    .word cm_fault_entry        /*  4 MemManage */
    .word cm_fault_entry        /*  5 BusFault */
    .word cm_fault_entry        /*  6 UsageFault */
    .word cm_fault_entry        /*  7 SecureFault (v8-M) */
    .word 0, 0, 0               /*  8-10 reserved */
    .word cm_fault_entry        /* 11 SVCall */
    .word cm_fault_entry        /* 12 DebugMonitor */
    .word 0                     /* 13 reserved */
    .word cm_fault_entry        /* 14 PendSV */
    .word cm_fault_entry        /* 15 SysTick */
    .rept 96
    .word cm_fault_entry        /* external interrupts: none is enabled */
    .endr

    .text
    .thumb_func
    .global cm_reset
cm_reset:
    ldr  r0, =_stack_top
    mov  sp, r0
    /* 1. paint the stack, bottom to top (nothing is on it yet) */
    ldr  r0, =_stack_bottom
    ldr  r1, =_stack_top
    ldr  r2, =0xC0DEFACE        /* CM_STACK_PAINT */
1:  cmp  r0, r1
    bhs  2f
    str  r2, [r0]
    adds r0, #4
    b    1b
2:  /* 2. zero the .bss-like regions listed in sections.ld */
    ldr  r3, =cm_zero_table
3:  ldr  r0, [r3]
    ldr  r1, [r3, #4]
    cmp  r0, #0
    beq  6f
    movs r2, #0
4:  cmp  r0, r1
    bhs  5f
    str  r2, [r0]
    adds r0, #4
    b    4b
5:  adds r3, #8
    b    3b
6:  bl   cm_board_init
    bl   cm_start
7:  b    7b

    /* Every exception: hand cm_fault the stacked frame and EXC_RETURN. */
    .thumb_func
    .global cm_fault_entry
cm_fault_entry:
    mov  r1, lr
    movs r0, #4
    tst  r0, r1
    bne  1f
    mrs  r0, msp
    b    2f
1:  mrs  r0, psp
2:  ldr  r2, =cm_fault
    bx   r2

    .section .rodata.cm_zero_table, "a", %progbits
    .align 2
cm_zero_table:
    .word _sbss, _ebss
    .word _sbig, _ebig
    .word _szone, _ezone
    .word 0, 0
