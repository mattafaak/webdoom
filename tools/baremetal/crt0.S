/* tools/baremetal/crt0.S — startup + ARMv7 exception vectors (rung 2, 13.4a)
 *
 * Layout in RAM (0x40010000+):
 *   [0x000] .text.vectors — 8-entry vector table (8 x 4 bytes = 32 bytes)
 *   [0x020] .text._start  — exception stubs + _start code
 *   ...
 *
 * VBAR is set to _vectors so CP15 routes all exceptions there.
 * Each mode gets its own SP; ABT mode uses _abort_stack_top (4 KiB
 * below the main SVC stack) so the handler can run even when sp is
 * trashed (the observed 11.1b symptom: sp=0x0).
 */

/* ── Exception vector table ────────────────────────────────────────────────── */
/* Placed in its own section so doom.ld can put it at the very start of .text  */
/* and VBAR can point to it.  Each slot is one ARM branch instruction (4 B).   */
.section .text.vectors, "ax"
.global _vectors
_vectors:
    b    _start                    /* 0x00  Reset                       */
    b    undef_handler             /* 0x04  Undefined instruction        */
    b    svc_handler               /* 0x08  SVC / SWI                   */
    b    prefetch_abort_asm        /* 0x0C  Prefetch Abort               */
    b    data_abort_asm            /* 0x10  Data Abort                   */
    b    .                         /* 0x14  Reserved (Hypervisor trap)   */
    b    irq_handler               /* 0x18  IRQ                          */
    b    fiq_handler               /* 0x1C  FIQ                          */

/* ── Exception stubs and fault handlers ────────────────────────────────────── */
.section .text._start, "ax"

/* Spin stubs for exceptions we never expect */
svc_handler:
    b    .

irq_handler:
    b    .

fiq_handler:
    b    .

/* Undefined instruction: faulting PC = LR_und - 4 */
undef_handler:
    sub  r0, lr, #4                /* PC of offending instruction */
    mov  r1, #0                    /* dfar n/a */
    mov  r2, #0                    /* dfsr n/a */
    mov  r3, #1                    /* type=1 UNDEF */
    bl   bm_fault_handler
1:  b    1b

/* Prefetch Abort: faulting PC = LR_abt - 4, IFSR in CP15 c5 c0 1 */
prefetch_abort_asm:
    sub  r0, lr, #4                /* PC of offending fetch */
    mov  r1, #0                    /* dfar n/a */
    mrc  p15, 0, r2, c5, c0, 1    /* IFSR (Instruction Fault Status Register) */
    mov  r3, #2                    /* type=2 PREFETCH */
    bl   bm_fault_handler
1:  b    1b

/* Data Abort: faulting PC = LR_abt - 8
 * DFAR (CP15 c6,c0,0) = faulting address
 * DFSR (CP15 c5,c0,0) = fault status + WnR bit
 */
data_abort_asm:
    sub  r0, lr, #8                /* PC of the instruction that faulted */
    mrc  p15, 0, r1, c6, c0, 0    /* DFAR: Data Fault Address Register */
    mrc  p15, 0, r2, c5, c0, 0    /* DFSR: Data Fault Status Register  */
    mov  r3, #3                    /* type=3 DATA_ABORT */
    bl   bm_fault_handler
1:  b    1b

/* ── _start ──────────────────────────────────────────────────────────────── */
.global _start
_start:
    /* 1. Point VBAR (CP15 c12,c0,0) at our vector table.
     *    Cortex-A7 in QEMU-virt boots in SVC mode; MCR to VBAR is legal.
     *    VBAR must be 32-byte aligned — _vectors is at the ELF load address
     *    (0x40010000) which satisfies that constraint.                     */
    ldr  r0, =_vectors
    mcr  p15, 0, r0, c12, c0, 0

    /* 2. Switch to Abort mode (CPSR M[4:0] = 0b10111 = 0x17) and load the
     *    dedicated abort-mode stack pointer.  When a data/prefetch abort
     *    fires, the CPU switches to ABT mode and uses SP_abt, so the handler
     *    can run even when the SVC-mode sp is 0 (the 11.1b "wild write"
     *    symptom).                                                          */
    mrs  r0, cpsr
    bic  r0, r0, #0x1f
    orr  r0, r0, #0x17
    msr  cpsr_c, r0
    ldr  sp, =_abort_stack_top     /* SP_abt */

    /* 3. Return to SVC mode (CPSR M[4:0] = 0b10011 = 0x13). */
    mrs  r0, cpsr
    bic  r0, r0, #0x1f
    orr  r0, r0, #0x13
    msr  cpsr_c, r0

    /* 4. Set up main (SVC) stack and jump to C entry point. */
    ldr  sp, =_stack_top
    bl   bm_main
1:  b    1b
