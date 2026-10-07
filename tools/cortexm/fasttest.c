// tools/cortexm/fasttest.c — the port's fixed-point, held to the engine's on
// the board, input by input.
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
//           replaces), against m_fixed.h's (__aeabi_ldivmod)
// Exit 0 and a PASS line, or exit 1 and a FAIL line naming the case; a build
// without FIXED is not built.
// Copyright (C) 2026, GPL-2.0-or-later.
#include "board.h"
#include "semihost.h"
#include "m_fixed.h"

fixed_t ft_ref_mul (fixed_t a, fixed_t b); /* fasttest_ref.c */
fixed_t ft_ref_div (fixed_t a, fixed_t b);

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
            check_pair (x, y, 1);
        }
        cm_uart_puts ("  div:");
        say ("edge_pairs", NEDGE * NEDGE);
        say ("random_pairs", n);
        say ("past_the_clamp", divpath);
        cm_uart_puts ("\n");
    }

    cm_uart_puts (
        "PASS fasttest: the port's results equal the engine's on every case\n");
    sh_exit (0);
}
