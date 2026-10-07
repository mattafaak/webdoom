// tools/cortexm/selftest.c — the instrument, and the traps, proved on the
// board.
//
// cm-doom's numbers are timer steps times CM_INSN_PER_TICK (board.h).  That is
// only true if qemu's -icount shift=0 makes an instruction exactly 1 ns and the
// timer runs at the SYSCLK board.h says, so it is measured here, on loops whose
// instruction counts are known from their source (loops.S):
//
//   instrument   (loop_1m - empty) must read 1,000,000 and (loop_2m - empty)
//                2,000,000 instructions, each within one timer step, and the
//                second twice the first within two steps.  Exit 0, else 1.
//   wrongloop    grades a 1,499,999-instruction loop as if it were 1e6: the
//                check must FAIL (exit 1).  A check that cannot fail is not
//                one.
//   unaligned    an unaligned word load.  armv6m: must fault (UsageFault,
//                UNALIGNED: CCR.UNALIGN_TRP makes the M3 trap as an M0+ does).
//                armv8m: the M33 services it; exit 0.
//   window       a load from the WAD window: must BusFault at that address.
//   semihost F   the guest instructions one SYS_READ costs, for 1 byte and for
//                64 KiB of file F: equal to within one step (the copy is the
//                host's), reported as semihost_call.
//   memcpy       newlib's memcpy on 64 KiB, aligned and not: instructions per
//                byte, the price of the M bytes an XIP port would copy itself.
//   stack        the painted-stack peak (cm_stack_peak): since reset it must
//                read under 1 KiB (crt0.S's paint is board.h's), then frames
//                of 4 KiB and 16 KiB written in full must each read their size
//                above the caller's SP, within 256 B of frame overhead.
// Copyright (C) 2026, GPL-2.0-or-later.
#include <string.h>

#include "board.h"
#include "semihost.h"

void cm_loop_empty (void);
void cm_loop_1m (void);
void cm_loop_2m (void);
void cm_loop_1m_wrong (void);

static unsigned char buf[65536 + 8]
    __attribute__ ((aligned (8), section (".bss.cm_big.st_buf")));
static unsigned char src[65536 + 8]
    __attribute__ ((aligned (8), section (".bss.cm_big.st_src")));

// touch n bytes of stack, in a frame of its own
static unsigned __attribute__ ((noinline)) use_stack (unsigned n)
{
    volatile unsigned char a[16384];
    unsigned i, sum = 0;
    for (i = 0; i < n; i++)
        a[sizeof (a) - 1 - i] = (unsigned char) i;
    for (i = 0; i < n; i++)
        sum += a[sizeof (a) - 1 - i];
    return sum;
}

static volatile unsigned sizes[2] = {1, 65536};
static unsigned __attribute__ ((noinline)) time_reads (int fd, unsigned n)
{
    unsigned t0 = cm_ticks (), i;
    for (i = 0; i < 256; i++)
    {
        sh_seek (fd, 0);
        sh_read (fd, buf, n);
    }
    return cm_ticks () - t0;
}

static unsigned measure (void (*fn) (void))
{
    unsigned t0 = cm_ticks ();
    fn ();
    return cm_ticks () - t0;
}

static void say (const char* k, unsigned v)
{
    cm_uart_puts (" ");
    cm_uart_puts (k);
    cm_uart_puts ("=");
    cm_uart_dec (v);
}

static unsigned absdiff (unsigned a, unsigned b)
{
    return a > b ? a - b : b - a;
}

static char cmd[256];

void cm_start (void)
{
    const char* mode;
    char* file = 0;
    char* p;
    const unsigned k = CM_INSN_PER_TICK;

    if (sh_cmdline (cmd, sizeof (cmd)) != 0)
        sh_exit (2);
    // argv[0] then the mode, then an optional argument
    for (p = cmd; *p && *p != ' '; p++)
    {
    }
    while (*p == ' ')
        p++;
    mode = p;
    while (*p && *p != ' ')
        p++;
    if (*p)
    {
        *p++ = 0;
        file = p;
    }
    cm_uart_puts ("SELFTEST " CM_BOARD_NAME " ");
    cm_uart_puts (mode);
    cm_uart_puts (" step=");
    cm_uart_dec (k);
    cm_uart_puts (" insn\n");

    if (!strcmp (mode, "instrument") || !strcmp (mode, "wrongloop"))
    {
        int wrong = mode[0] == 'w';
        unsigned e = measure (cm_loop_empty);
        unsigned a = measure (wrong ? cm_loop_1m_wrong : cm_loop_1m);
        unsigned b = measure (cm_loop_2m);
        unsigned i1 = (a - e) * k, i2 = (b - e) * k;
        int ok = absdiff (i1, 1000000u) <= k && absdiff (i2, 2000000u) <= k &&
                 absdiff (i2, 2 * i1) <= 2 * k;
        cm_uart_puts (ok ? "PASS" : "FAIL");
        cm_uart_puts (" instrument:");
        say ("loop_1m", i1);
        say ("loop_2m", i2);
        say ("empty_ticks", e);
        say ("loop_1m_ticks", a);
        say ("loop_2m_ticks", b);
        cm_uart_puts (
            wrong ? " (graded a 1,499,999-instruction loop as 1e6)\n"
                  : " (expect 1000000 and 2000000, each within one step)\n");
        sh_exit (ok ? 0 : 1);
    }
    if (!strcmp (mode, "unaligned"))
    {
        // An explicit LDR: from C, gcc sees the misalignment and splits the
        // load into four LDRBs, which tests nothing (it did, the first time).
        static unsigned w[2] = {0x11223344u, 0x55667788u};
        const char* q = (const char*) w + 1;
        unsigned v;
        __asm__ volatile ("ldr %0, [%1]" : "=r"(v) : "r"(q) : "memory");
        cm_uart_puts ("UNALIGNED read completed, no fault:");
        say ("value", v);
        cm_uart_puts ("\n");
        sh_exit (0);
    }
    if (!strcmp (mode, "window"))
    {
        volatile unsigned* q = (volatile unsigned*) (CM_WAD_WINDOW + 0x1234u);
        unsigned v = *q;
        cm_uart_puts ("FAIL window: a read of the WAD window returned");
        say ("value", v);
        cm_uart_puts (" without a fault\n");
        sh_exit (1);
    }
    if (!strcmp (mode, "semihost") && file)
    {
        // 256 seek+read pairs of each size, so the per-call cost resolves
        // below one timer step.  Both sizes run the same function: two loops
        // with the size as a constant are different code (at -O2 on Thumb-1,
        // 65536 takes one instruction more to form than 1: +256 measured).
        int fd = sh_open (file, 1);
        unsigned small, big, e;
        if (fd < 0 || sh_flen (fd) < 65536)
            sh_exit (2);
        small = time_reads (fd, sizes[0]);
        big = time_reads (fd, sizes[1]);
        sh_close (fd);
        e = absdiff (small, big) <= 1;
        cm_uart_puts (e ? "PASS" : "FAIL");
        cm_uart_puts (" semihost: 256 x (SYS_SEEK + SYS_READ)");
        say ("of_1B_insn", small * k);
        say ("of_64KiB_insn", big * k);
        say ("per_pair_insn", small * k / 256u);
        cm_uart_puts (
            " (the guest's cost does not depend on the bytes moved)\n");
        sh_exit (e ? 0 : 1);
    }
    if (!strcmp (mode, "memcpy"))
    {
        unsigned t0, al, mis, e;
        e = measure (cm_loop_empty);
        t0 = cm_ticks ();
        memcpy (buf, src, 65536);
        al = cm_ticks () - t0;
        t0 = cm_ticks ();
        memcpy (buf, src + 1, 65536);
        mis = cm_ticks () - t0;
        cm_uart_puts ("PASS memcpy:");
        say ("aligned_64KiB_insn", al * k);
        say ("misaligned_64KiB_insn", mis * k);
        say ("aligned_milli_insn_per_byte", (al * k) * 1000u / 65536u);
        say ("misaligned_milli_insn_per_byte", (mis * k) * 1000u / 65536u);
        cm_uart_puts ("\n");
        (void) e;
        sh_exit (0);
    }
    if (!strcmp (mode, "stack"))
    {
        // use_stack's frame is 16 KiB whatever n is; it writes the n bytes
        // nearest its caller, so the peak grows with n, not with the frame
        // the reference is this frame's own SP: a peak read through a call
        // includes that call's frame, so it cannot be the baseline
        unsigned base, p4, p16, ok, reset;
        unsigned* sp;
        // first, crt0.S's paint at reset: only this boot's few frames may be
        // gone from it (a paint value that disagrees with board.h would read
        // the whole region as used)
        reset = cm_stack_peak ();
        cm_stack_repaint ();
        __asm__ volatile ("mov %0, sp" : "=r"(sp));
        base = (unsigned) ((char*) _stack_top - (char*) sp);
        use_stack (4096);
        p4 = cm_stack_peak ();
        use_stack (16384);
        p16 = cm_stack_peak ();
        ok = reset > 0 && reset < 1024 && p4 >= base + 4096 &&
             p4 <= base + 4096 + 256 && p16 >= base + 16384 &&
             p16 <= base + 16384 + 256;
        cm_uart_puts (ok ? "PASS" : "FAIL");
        cm_uart_puts (" stack:");
        say ("since_reset", reset);
        say ("base", base);
        say ("after_4KiB", p4);
        say ("after_16KiB", p16);
        say ("used_4KiB", p4 - base);
        say ("used_16KiB", p16 - base);
        cm_uart_puts (" (each within 256 B of its size)\n");
        sh_exit (ok ? 0 : 1);
    }
    cm_uart_puts ("FAIL selftest: unknown mode\n");
    sh_exit (2);
}
