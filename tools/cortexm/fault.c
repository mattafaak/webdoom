// tools/cortexm/fault.c — the fault reporter every exception vector reaches.
//
// The deleted ARMv7-A harness ran away silently on its first alignment abort
// (tools/baremetal, 11.1b) until 99db300 gave it vectors.  Here no exception
// is left unhandled: crt0.S points every vector at cm_fault_entry, which hands
// over the stacked frame, and this prints what happened over the UART and
// exits qemu with code 3.  Faults are not resumed.
//
//   FAULT <name> ipsr=N pc=.. lr=.. xpsr=.. r0..r3 r12
//         cfsr=.. hfsr=.. mmfar=.. bfar=.. [sfsr=.. sfar=..] addr=..
//
// `addr` is the faulting data address when CFSR says one is valid (BFARVALID,
// MMARVALID), else none.  `cause` decodes the CFSR bits that fired.
// Copyright (C) 2026, GPL-2.0-or-later.
#include "board.h"
#include "semihost.h"

static const char* const exc_name[16] = {
    "thread",       "reset",    "NMI",        "HardFault",
    "MemManage",    "BusFault", "UsageFault", "SecureFault",
    "rsvd8",        "rsvd9",    "rsvd10",     "SVCall",
    "DebugMonitor", "rsvd13",   "PendSV",     "SysTick",
};

static const struct
{
    unsigned bit;
    const char* name;
} cfsr_bits[] = {
    {1u << 0, "IACCVIOL"},     {1u << 1, "DACCVIOL"},
    {1u << 3, "MUNSTKERR"},    {1u << 4, "MSTKERR"},
    {1u << 5, "MLSPERR"},      {1u << 7, "MMARVALID"},
    {1u << 8, "IBUSERR"},      {1u << 9, "PRECISERR"},
    {1u << 10, "IMPRECISERR"}, {1u << 11, "UNSTKERR"},
    {1u << 12, "STKERR"},      {1u << 13, "LSPERR"},
    {1u << 15, "BFARVALID"},   {1u << 16, "UNDEFINSTR"},
    {1u << 17, "INVSTATE"},    {1u << 18, "INVPC"},
    {1u << 19, "NOCP"},        {1u << 20, "STKOF"},
    {1u << 24, "UNALIGNED"},   {1u << 25, "DIVBYZERO"},
};

static void kv (const char* k, unsigned v)
{
    cm_uart_puts (" ");
    cm_uart_puts (k);
    cm_uart_puts ("=");
    cm_uart_hex (v);
}

void cm_fault (const unsigned* frame, unsigned exc_return)
{
    unsigned ipsr, cfsr = CM_SCB_CFSR, hfsr = CM_SCB_HFSR;
    unsigned i;
    __asm__ volatile ("mrs %0, ipsr" : "=r"(ipsr));
    ipsr &= 0x1FFu;

    cm_uart_puts ("\nFAULT ");
    cm_uart_puts (ipsr < 16 ? exc_name[ipsr] : "IRQ");
    cm_uart_puts (" ipsr=");
    cm_uart_dec (ipsr);
    kv ("pc", frame[6]);
    kv ("lr", frame[5]);
    kv ("xpsr", frame[7]);
    kv ("r0", frame[0]);
    kv ("r1", frame[1]);
    kv ("r2", frame[2]);
    kv ("r3", frame[3]);
    kv ("r12", frame[4]);
    kv ("sp", (unsigned) frame);
    kv ("exc_return", exc_return);
    kv ("cfsr", cfsr);
    kv ("hfsr", hfsr);
    kv ("mmfar", CM_SCB_MMFAR);
    kv ("bfar", CM_SCB_BFAR);
#ifdef CM_ARMV8M
    kv ("sfsr", CM_SCB_SFSR);
    kv ("sfar", CM_SCB_SFAR);
#endif
    cm_uart_puts (" addr=");
    if (cfsr & (1u << 15))
        cm_uart_hex (CM_SCB_BFAR);
    else if (cfsr & (1u << 7))
        cm_uart_hex (CM_SCB_MMFAR);
    else
        cm_uart_puts ("none");
    cm_uart_puts (" cause=");
    for (i = 0; i < sizeof (cfsr_bits) / sizeof (cfsr_bits[0]); i++)
        if (cfsr & cfsr_bits[i].bit)
        {
            cm_uart_puts (cfsr_bits[i].name);
            cm_uart_puts (",");
        }
    if (hfsr & (1u << 30))
        cm_uart_puts ("FORCED,");
    cm_uart_puts ("\n");
    sh_exit (3);
}
