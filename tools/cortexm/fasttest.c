// tools/cortexm/fasttest.c — the port's drawers and fixed-point, held to the
// engine's on the board, input by input.
//
//   cm-fasttest [seed [scale]]
//
// The 13-demo floor gate is the contract; this adds the inputs the demos never
// produce.  Every case runs the engine's function and the port's on the same
// input and compares the results:
//   mul     FixedMul: every pair of 40 boundary values, then random pairs,
//           uniform and log-uniform in magnitude, against fasttest_ref.c's
//           m_fixed.h (libgcc's __aeabi_lmul on ARMv6-M)
//   div     FixedDiv: the same boundary pairs, then random log-uniform pairs,
//           most of them past the clamp (the divide is what the port
//           replaces), then "near" pairs, all past the clamp: a divisor of
//           every magnitude and a dividend q1*d + r with r uniform or within 4
//           of d, where a digit-estimating divide is most often off; against
//           m_fixed.h's (__aeabi_ldivmod).  On ARMv8-M the counts also say how
//           many pairs had fixed_v8m.S's estimated digit off by 1 and by 2
//           (computed here from the pair, not read from the port), so a pass
//           is evidence of both corrections; none must be off by 3
//   column  R_DrawColumn (DRAWERS=1): random columns into two screens, one
//           by r_draw.c's function, one by __wrap_R_DrawColumn, compared on
//           the column and both neighbours every case and whole every 1,024:
//           heights 128, 64, other powers of two, non-powers (with and
//           without a wrap), and odd ones (0, 2^15, 2^16, non-powers at and
//           past 2^14); steps typical, tiny, huge and negative; any texturemid
//   span    R_DrawSpan (DRAWERS=1): random spans, every frac and step
// The port hands back what it does not take (__real_R_DrawColumn is
// ft_real_column here, the Makefile's --defsym), and the counts say how many
// cases each of its own paths drew, so a pass is evidence of the fast paths,
// not of the fallback.  Exit 0 and a PASS line, or exit 1 and a FAIL line
// naming the case; a build with neither DRAWERS nor FIXED is not built.
// Copyright (C) 2026, GPL-2.0-or-later.
#include <string.h>

#include "board.h"
#include "semihost.h"
#include "m_fixed.h"

#ifndef CM_FT_DRAWERS
#define CM_FT_DRAWERS 0
#endif

fixed_t ft_ref_mul (fixed_t a, fixed_t b); /* fasttest_ref.c */
fixed_t ft_ref_div (fixed_t a, fixed_t b);

// ── the engine's drawer state (r_draw.c, linked unmodified) ──────────────────
typedef unsigned char byte;
extern byte* dc_colormap;
extern int dc_x, dc_yl, dc_yh, dc_iscale, dc_texturemid, dc_texheight;
extern byte* dc_source;
extern int ds_y, ds_x1, ds_x2, ds_xfrac, ds_yfrac, ds_xstep, ds_ystep;
extern byte *ds_colormap, *ds_source;
extern byte* ylookup[];
extern int columnofs[];
int centery; /* r_main.c's, which the test does not link */
void R_DrawColumn (void);
void R_DrawSpan (void);
void __wrap_R_DrawColumn (void);
void __wrap_R_DrawSpan (void);

void I_Error (const char* fmt, ...);
void I_Error (const char* fmt, ...)
{
    cm_uart_puts ("FAIL fasttest: I_Error: ");
    cm_uart_puts (fmt);
    cm_uart_puts ("\n");
    sh_exit (1);
}

static unsigned real_columns, real_spans;
void ft_real_column (void);
void ft_real_span (void);
void ft_real_column (void)
{
    real_columns++;
    R_DrawColumn ();
}
void ft_real_span (void)
{
    real_spans++;
    R_DrawSpan ();
}

// ── a small generator (xorshift128), seeded from the command line ────────────
static unsigned s0 = 0x9e3779b9u, s1 = 0x243f6a88u, s2 = 0xb7e15162u,
                s3 = 0x7f4a7c15u;
static unsigned rnd (void)
{
    unsigned t = s0 ^ (s0 << 11);
    s0 = s1;
    s1 = s2;
    s2 = s3;
    s3 = s3 ^ (s3 >> 19) ^ t ^ (t >> 8);
    return s3;
}
static unsigned below (unsigned n)
{
    return rnd () % n;
}
// a value whose magnitude is uniform in bits: |v| < 2^(0..31), either sign
static int logrnd (void)
{
    unsigned bits = below (33),
             v = bits >= 32 ? rnd () : rnd () & ((1u << bits) - 1);
    return (rnd () & 1) ? -(int) v : (int) v;
}

static void say (const char* k, unsigned v)
{
    cm_uart_puts (" ");
    cm_uart_puts (k);
    cm_uart_puts ("=");
    cm_uart_dec (v);
}
static void sayx (const char* k, unsigned v)
{
    cm_uart_puts (" ");
    cm_uart_puts (k);
    cm_uart_puts ("=");
    cm_uart_hex (v);
}
static void fail (const char* what)
{
    cm_uart_puts ("\nFAIL fasttest: ");
    cm_uart_puts (what);
    cm_uart_puts ("\n");
    sh_exit (1);
}

static fixed_t __attribute__ ((noinline)) port_mul (fixed_t a, fixed_t b)
{
    return FixedMul (a, b);
}
static fixed_t __attribute__ ((noinline)) port_div (fixed_t a, fixed_t b)
{
    return FixedDiv (a, b);
}

static const int edge[] = {0,
                           1,
                           -1,
                           2,
                           -2,
                           3,
                           0x7fff,
                           0x8000,
                           0xffff,
                           0x10000,
                           0x10001,
                           0x18000,
                           -0x7fff,
                           -0x8000,
                           -0xffff,
                           -0x10000,
                           -0x10001,
                           -0x18000,
                           0x7fffffff,
                           -0x7fffffff,
                           (int) 0x80000000u,
                           0x7ffffffe,
                           0x3fffffff,
                           0x40000000,
                           -0x40000000,
                           0x12345678,
                           -0x12345678,
                           0x0000c000,
                           0x00004000,
                           0x00003fff,
                           0x00040000,
                           0x0003ffff,
                           -0x00040000,
                           0x7fff0000,
                           (int) 0x80010000u,
                           0x00ff00ff,
                           (int) 0xff00ff00u,
                           0x55555555,
                           (int) 0xaaaaaaaau,
                           0x01000000};
#define NEDGE ((int) (sizeof (edge) / sizeof (edge[0])))

// fixed_v8m.S's second-digit estimate for a pair past the clamp, minus the
// true digit: 0, 1 or 2 by its proof (step 4).  The test's own arithmetic.
#ifdef CM_ARMV8M
static unsigned est_off[4];
static void estimate_class (int a, int b)
{
    unsigned n = a < 0 ? 0u - (unsigned) a : (unsigned) a,
             d = b < 0 ? 0u - (unsigned) b : (unsigned) b, r, s, qh, q0;
    if (a == (int) 0x80000000u || b == (int) 0x80000000u || (n >> 14) >= d)
        return;
    r = n % d;
    s = (unsigned) __builtin_clz (d);
    qh = (r << s) / ((d << s) >> 16);
    q0 = (unsigned) (((unsigned long long) r << 16) / d);
    est_off[qh - q0 > 3 ? 3 : qh - q0]++;
}
#endif

static void check_pair (int a, int b, int which)
{
    fixed_t r, p;
    // FixedDiv (MININT, 0) divides by zero inside m_fixed.h's own expression
    // (abs(MININT) is negative, so the clamp lets it by): undefined there,
    // so there is no value to match.  Every other pair is defined.
    if (which && a == (int) 0x80000000u && b == 0)
        return;
    r = which ? ft_ref_div (a, b) : ft_ref_mul (a, b);
    p = which ? port_div (a, b) : port_mul (a, b);
    if (r != p)
    {
        cm_uart_puts ("\nFAIL fasttest: ");
        cm_uart_puts (which ? "FixedDiv" : "FixedMul");
        sayx ("a", (unsigned) a);
        sayx ("b", (unsigned) b);
        sayx ("engine", (unsigned) r);
        sayx ("port", (unsigned) p);
        cm_uart_puts ("\n");
        sh_exit (1);
    }
}

// ── the screens: two copies, column-major (x * 200 + y), with slack ─────────
#define SW 320
#define SH 200
static byte scr_a[SW * SH + 512] __attribute__ ((section (".bss.cm_big.ft_a")));
static byte scr_b[SW * SH + 512] __attribute__ ((section (".bss.cm_big.ft_b")));
static byte texels[196608] __attribute__ ((section (".bss.cm_big.ft_tex")));
static byte cmaps[8192] __attribute__ ((section (".bss.cm_big.ft_cmap")));

static void same (const byte* a, const byte* b, unsigned n, const char* what)
{
    if (memcmp (a, b, n))
    {
        unsigned i = 0;
        while (a[i] == b[i])
            i++;
        cm_uart_puts ("\nFAIL fasttest: ");
        cm_uart_puts (what);
        say ("at_byte", (unsigned) (a + i - scr_a));
        say ("engine", a[i]);
        say ("port", b[i]);
        cm_uart_puts ("\n");
        sh_exit (1);
    }
}

static void column_case (unsigned n)
{
    static const int odd_h[] = {0, 65536, 16387, 32768, 16384, 3, 16383};
    unsigned pick = below (100);
    int h, x, xl, xr;
    if (pick < 40)
        h = 128;
    else if (pick < 55)
        h = 64;
    else if (pick < 70)
        h = 1 << below (16);
    else if (pick < 95)
        h = 1 + (int) below (300);
    else
        h = odd_h[below (sizeof (odd_h) / sizeof (odd_h[0]))];
    x = (int) below (SW);
    dc_x = x;
    dc_yl = (int) below (SH);
    dc_yh = below (16) ? dc_yl + (int) below ((unsigned) (SH - dc_yl))
                       : dc_yl - 1 - (int) below (3);
    pick = below (10);
    dc_iscale = pick < 6   ? (int) (rnd () & 0xfffff)
                : pick < 7 ? (int) (rnd () & 0xfff)
                : pick < 8 ? (int) (0x100000 + (rnd () & 0x1ffffff))
                : pick < 9 ? -(int) (rnd () & 0xffffff)
                           : (int) (below (3) == 0 ? 0
                                    : below (2)    ? 1
                                                   : 65536);
    dc_texturemid = below (2) ? (int) rnd () : logrnd ();
    centery = (int) (below (2) ? 100 : below (SH));
    dc_texheight = h;
    dc_source = texels + 65536 + below (1024);
    dc_colormap = cmaps + below (8192 - 256);

    ylookup[dc_yl] = scr_a + dc_yl;
    R_DrawColumn ();
    ylookup[dc_yl] = scr_b + dc_yl;
    __wrap_R_DrawColumn ();

    xl = x > 0 ? x - 1 : x;
    xr = x < SW - 1 ? x + 1 : x;
    if (memcmp (scr_a + xl * SH, scr_b + xl * SH,
                (unsigned) (xr - xl + 1) * SH))
    {
        cm_uart_puts ("\nFAIL fasttest: R_DrawColumn case");
        say ("n", n);
        say ("x", (unsigned) dc_x);
        say ("yl", (unsigned) dc_yl);
        say ("yh", (unsigned) dc_yh);
        sayx ("iscale", (unsigned) dc_iscale);
        sayx ("texturemid", (unsigned) dc_texturemid);
        say ("centery", (unsigned) centery);
        sayx ("texheight", (unsigned) dc_texheight);
        {
            const byte *a = scr_a + xl * SH, *b = scr_b + xl * SH;
            unsigned k = 0;
            while (a[k] == b[k])
                k++;
            say ("at_x", (unsigned) xl + k / SH);
            say ("at_y", k % SH);
            say ("engine", a[k]);
            say ("port", b[k]);
        }
        cm_uart_puts ("\n");
        sh_exit (1);
    }
    if ((n & 1023) == 1023)
        same (scr_a, scr_b, sizeof (scr_a), "R_DrawColumn: the whole screen");
}

static void span_case (unsigned n)
{
    unsigned pick = below (10), y;
    ds_y = below (64) ? (int) below (SH)
                      : SH; /* r_draw.c's RANGECHECK lets 200 by */
    ds_x1 = (int) below (SW);
    ds_x2 = below (4)
                ? ds_x1 + (int) below ((unsigned) (SW - ds_x1))
                : ds_x1 + (int) below (
                              8 < SW - ds_x1 ? 8 : (unsigned) (SW - ds_x1));
    ds_xfrac = (int) rnd ();
    ds_yfrac = (int) rnd ();
    ds_xstep = pick < 5 ? logrnd () : (int) rnd ();
    ds_ystep = pick < 3   ? logrnd ()
               : pick < 6 ? (int) rnd ()
                          : (int) (rnd () & 0x3ffff) - 0x20000;
    ds_source = texels + below (65536 - 4096);
    ds_colormap = cmaps + below (8192 - 256);

    ylookup[ds_y] = scr_a + ds_y;
    R_DrawSpan ();
    ylookup[ds_y] = scr_b + ds_y;
    __wrap_R_DrawSpan ();

    for (y = 0; y < (unsigned) SW; y++) /* the span's row, every column */
        if (scr_a[y * SH + (unsigned) ds_y] != scr_b[y * SH + (unsigned) ds_y])
        {
            cm_uart_puts ("\nFAIL fasttest: R_DrawSpan case");
            say ("n", n);
            say ("y", (unsigned) ds_y);
            say ("x1", (unsigned) ds_x1);
            say ("x2", (unsigned) ds_x2);
            sayx ("xfrac", (unsigned) ds_xfrac);
            sayx ("yfrac", (unsigned) ds_yfrac);
            sayx ("xstep", (unsigned) ds_xstep);
            sayx ("ystep", (unsigned) ds_ystep);
            say ("at_x", y);
            cm_uart_puts ("\n");
            sh_exit (1);
        }
    if ((n & 1023) == 1023)
        same (scr_a, scr_b, sizeof (scr_a), "R_DrawSpan: the whole screen");
}

static char cmd[256];
void cm_start (void)
{
    unsigned seed = 1, scale = 1, i, n, divpath = 0;
    char* p;
    if (sh_cmdline (cmd, sizeof (cmd)) != 0)
        sh_exit (2);
    for (p = cmd; *p && *p != ' '; p++)
    {
    }
    while (*p == ' ')
        p++;
    if (*p)
    {
        seed = 0;
        while (*p >= '0' && *p <= '9')
            seed = seed * 10 + (unsigned) (*p++ - '0');
        while (*p == ' ')
            p++;
        if (*p)
        {
            scale = 0;
            while (*p >= '0' && *p <= '9')
                scale = scale * 10 + (unsigned) (*p++ - '0');
        }
    }
    if (!scale)
        fail ("scale must be at least 1");
    s0 ^= seed * 0x85ebca6bu;
    s1 ^= seed * 0xc2b2ae35u;
    for (i = 0; i < 64; i++)
        rnd ();
    cm_uart_puts ("FASTTEST " CM_BOARD_NAME);
    say ("seed", seed);
    say ("scale", scale);
    say ("drawers", CM_FT_DRAWERS);
    cm_uart_puts ("\n");

    // FixedMul and FixedDiv: the boundary pairs, then random ones
    {
        int a, b;
        for (a = 0; a < NEDGE; a++)
            for (b = 0; b < NEDGE; b++)
            {
                check_pair (edge[a], edge[b], 0);
                check_pair (edge[a], edge[b], 1);
            }
        n = 2000000 * scale;
        for (i = 0; i < n; i++)
        {
            check_pair ((int) rnd (), (int) rnd (), 0);
            check_pair (logrnd (), logrnd (), 0);
        }
        cm_uart_puts ("  mul:");
        say ("edge_pairs", NEDGE * NEDGE);
        say ("random_pairs", 2 * n);
        cm_uart_puts ("\n");
        n = 1000000 * scale;
        for (i = 0; i < n; i++)
        {
            int x = logrnd (), y = logrnd ();
            if ((abs (x) >> 14) < abs (y))
                divpath++;
#ifdef CM_ARMV8M
            estimate_class (x, y);
#endif
            check_pair (x, y, 1);
        }
        cm_uart_puts ("  div:");
        say ("edge_pairs", NEDGE * NEDGE);
        say ("random_pairs", n);
        say ("past_the_clamp", divpath);
        // the near pairs draw from a copy of the generator, so the drawers'
        // cases below are the ones they always were
        {
            unsigned keep[4];
            keep[0] = s0, keep[1] = s1, keep[2] = s2, keep[3] = s3;
            n = 200000 * scale;
            for (i = 0; i < n; i++)
            {
                unsigned bits, d, qmax, q1, r;
                int x, y;
                bits = 1 + below (31); // d in [2^(bits-1), 2^bits)
                d = (1u << (bits - 1)) | (rnd () & ((1u << (bits - 1)) - 1));
                qmax = 0x7fffffffu / d;
                if (qmax > 16383)
                    qmax = 16383;
                q1 = below (qmax + 1);
                r = (rnd () & 1) ? d - 1 - below (d < 4 ? d : 4) : below (d);
                if (q1 * d > 0x7fffffffu - r) // n < 2^31
                    q1--;
                x = (int) (q1 * d + r), y = (int) d;
                if (rnd () & 1)
                    x = -x;
                if (rnd () & 1)
                    y = -y;
#ifdef CM_ARMV8M
                estimate_class (x, y);
#endif
                check_pair (x, y, 1);
            }
            s0 = keep[0], s1 = keep[1], s2 = keep[2], s3 = keep[3];
        }
        say ("near_pairs", n);
#ifdef CM_ARMV8M
        say ("estimate_off_by_1", est_off[1]);
        say ("by_2", est_off[2]);
#endif
        cm_uart_puts ("\n");
#ifdef CM_ARMV8M
        if (est_off[3])
            fail ("FixedDiv: fixed_v8m.S's estimated digit was below the true "
                  "one or 3 or more above it (its proof says 0 to 2 above)");
        if (!est_off[1] || !est_off[2])
            fail ("FixedDiv: no pair needed fixed_v8m.S's second correction: "
                  "the pass is not evidence of it");
#endif
    }

#if CM_FT_DRAWERS
    for (i = 0; i < sizeof (texels); i++)
        texels[i] = (byte) rnd ();
    for (i = 0; i < sizeof (cmaps); i++)
        cmaps[i] = (byte) rnd ();
    for (i = 0; i < sizeof (scr_a); i++)
        scr_a[i] = scr_b[i] = (byte) rnd ();
    for (i = 0; i < SW; i++)
        columnofs[i] = (int) (i * SH);
    n = 100000 * scale;
    for (i = 0; i < n; i++)
        column_case (i);
    same (scr_a, scr_b, sizeof (scr_a), "R_DrawColumn: the whole screen");
    cm_uart_puts ("  column:");
    say ("cases", n);
    say ("engine_handed_back", real_columns);
    say ("port_drew", n - real_columns);
    cm_uart_puts ("\n");
    if (real_columns * 2 > n)
        fail ("R_DrawColumn: the port drew fewer than half the cases itself");
    n = 100000 * scale;
    for (i = 0; i < n; i++)
        span_case (i);
    same (scr_a, scr_b, sizeof (scr_a), "R_DrawSpan: the whole screen");
    cm_uart_puts ("  span:");
    say ("cases", n);
    say ("engine_handed_back", real_spans);
    cm_uart_puts ("\n");
    if (real_spans * 100 > n)
        fail ("R_DrawSpan: the port handed back more than 1 in 100 cases");
#endif
    cm_uart_puts (
        "PASS fasttest: the port's results equal the engine's on every case\n");
    sh_exit (0);
}
