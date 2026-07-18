/* tools/baremetal/abort_handler.c — ARMv7 exception handler (13.4a fault capture)
 *
 * bm_fault_handler is called from crt0.S exception stubs with:
 *   r0 = faulting PC
 *   r1 = DFAR (Data Fault Address Register, meaningful only for data aborts)
 *   r2 = DFSR or IFSR (fault status register)
 *   r3 = exception type: 1=UNDEF, 2=PREFETCH, 3=DATA_ABORT
 *
 * All output goes directly to the PL011 UART at 0x09000000 (no library calls)
 * so the handler is safe even if the zone allocator, newlib, or printf are
 * in an inconsistent state.
 *
 * Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
 */

/* PL011 UART UARTDR at 0x09000000 — writing low 8 bits emits one byte */
static volatile unsigned * const UART_DR = (volatile unsigned *)0x09000000u;

static void ah_putc(char c)
{
    *UART_DR = (unsigned)(unsigned char)c;
}

static void ah_puts(const char *s)
{
    while (*s) ah_putc(*s++);
}

static void ah_puthex32(unsigned v)
{
    static const char hex[] = "0123456789abcdef";
    int i;
    ah_puts("0x");
    for (i = 28; i >= 0; i -= 4)
        ah_putc(hex[(v >> i) & 0xfu]);
}

/*
 * DFSR §B3.18.5 (ARMv7-AR ARM): FS[4:0] = { bit[10], bits[3:0] }.
 * WnR = bit[11] (1 = write that aborted, 0 = read).
 */
static void decode_dfsr(unsigned dfsr)
{
    unsigned fs  = (dfsr & 0xfu) | ((dfsr >> 6u) & 0x10u);
    unsigned wnr = (dfsr >> 11u) & 1u;
    const char *fs_desc;

    ah_puts("  DFSR         = "); ah_puthex32(dfsr); ah_putc('\n');
    ah_puts("  WnR          = "); ah_putc(wnr ? '1' : '0');
    ah_puts("  ("); ah_puts(wnr ? "write fault" : "read fault"); ah_puts(")\n");
    ah_puts("  FS[4:0]      = "); ah_puthex32(fs); ah_puts("  ");

    switch (fs) {
        case 0x01: fs_desc = "Alignment fault"; break;
        case 0x02: fs_desc = "Debug event"; break;
        case 0x03: fs_desc = "Access flag fault (section)"; break;
        case 0x04: fs_desc = "Instruction cache maintenance fault"; break;
        case 0x05: fs_desc = "Translation fault (section)"; break;
        case 0x06: fs_desc = "Access flag fault (page)"; break;
        case 0x07: fs_desc = "Translation fault (page)"; break;
        case 0x08: fs_desc = "Synchronous external abort"; break;
        case 0x09: fs_desc = "Domain fault (section)"; break;
        case 0x0b: fs_desc = "Domain fault (page)"; break;
        case 0x0c: fs_desc = "Permission fault (section)"; break;
        case 0x0d: fs_desc = "Permission fault (page)"; break;
        case 0x0e: fs_desc = "Sync external abort (table walk L1)"; break;
        case 0x0f: fs_desc = "Sync external abort (table walk L2)"; break;
        case 0x10: fs_desc = "TLB conflict abort"; break;
        default:   fs_desc = "Unknown / implementation-defined"; break;
    }
    ah_puts("("); ah_puts(fs_desc); ah_puts(")\n");
}

/*
 * bm_fault_handler — entry from crt0.S ARM exception stubs.
 * Runs on the dedicated abort-mode stack (_abort_stack_top) set up in _start,
 * so it is safe even when the SVC-mode sp has been zeroed by a wild write.
 */
void bm_fault_handler(unsigned pc, unsigned dfar, unsigned dxsr, unsigned type)
{
    ah_puts("\n\n");
    ah_puts("==============================================\n");
    if (type == 3)      ah_puts("  *** EXCEPTION: DATA ABORT ***\n");
    else if (type == 2) ah_puts("  *** EXCEPTION: PREFETCH ABORT ***\n");
    else if (type == 1) ah_puts("  *** EXCEPTION: UNDEFINED INSTRUCTION ***\n");
    else                ah_puts("  *** EXCEPTION: UNKNOWN ***\n");
    ah_puts("==============================================\n");
    ah_puts("  PC (faulting) = "); ah_puthex32(pc); ah_putc('\n');

    if (type == 3) {
        /* Data abort: DFAR is meaningful */
        ah_puts("  DFAR          = "); ah_puthex32(dfar); ah_putc('\n');
        decode_dfsr(dxsr);
    } else if (type == 2) {
        /* Prefetch abort: IFSR instead */
        ah_puts("  IFSR          = "); ah_puthex32(dxsr); ah_putc('\n');
    }

    ah_puts("==============================================\n");
    ah_puts("  HALTED (spin).\n");
    for (;;) {}
}
