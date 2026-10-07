/* tools/cortexm/loops.S — loops of a known instruction count, the instrument's
 * red-proof (selftest.c).  ARMv6-M instructions, so both builds run the same
 * bytes.  Counted from the source, and checked against the disassembly by
 * selftest.sh (it greps these functions out of `objdump -d`):
 *
 *   cm_loop_empty   bx lr                                   1
 *   cm_loop_1m      ldr, nop, 499,999 x (subs, bne), bx lr  1+1+999,998+1
 *   cm_loop_2m      ldr, nop, 999,999 x (subs, bne), bx lr  1+1+1,999,998+1
 *
 * A caller's `bl` is common to all three, so (loop - empty) is exactly
 * 1,000,000 and 2,000,000 instructions.  A not-taken final bne still counts
 * as one instruction: an instruction count is retired instructions, taken or
 * not.
 * Copyright (C) 2026, GPL-2.0-or-later.
 */
    .syntax unified
    .thumb
    .text

    .thumb_func
    .global cm_loop_empty
cm_loop_empty:
    bx   lr

    .thumb_func
    .global cm_loop_1m
cm_loop_1m:
    ldr  r0, =499999
    nop
1:  subs r0, #1
    bne  1b
    bx   lr

    .thumb_func
    .global cm_loop_2m
cm_loop_2m:
    ldr  r0, =999999
    nop
1:  subs r0, #1
    bne  1b
    bx   lr

    /* The 1e6 loop with one extra instruction per iteration: 499,999 more,
     * 1,499,999 in all.  The selftest's red-proof grades it against 1e6 and
     * requires that check to FAIL, so a check that cannot fail is caught. */
    .thumb_func
    .global cm_loop_1m_wrong
cm_loop_1m_wrong:
    ldr  r0, =499999
    nop
1:  subs r0, #1
    nop
    bne  1b
    bx   lr
    .ltorg
