#include <stdio.h>
#include <stdint.h>
#include "rndtable.h"

static void scan_bsd_rand (void)
{
    int hits = 0;
    for (uint64_t seed64 = 0; seed64 < 0x100000000ull; seed64++)
    {
        uint32_t t = (uint32_t) seed64;
        int ok = 1;
        for (int i = 0; i < 4 && ok; i++)
        {
            t = t * 1103515245u + 12345u;
            if ((uint8_t) ((t & 0x7fffffff) % 256) != canon_rnd[i])
                ok = 0;
        }
        if (!ok)
            continue;
        t = (uint32_t) seed64;
        ok = 1;
        for (int i = 0; i < 256 && ok; i++)
        {
            t = t * 1103515245u + 12345u;
            if ((uint8_t) ((t & 0x7fffffff) % 256) != canon_rnd[i])
                ok = 0;
        }
        if (ok)
        {
            printf ("*** MATCH bsd-rand seed=%u\n", (uint32_t) seed64);
            hits++;
        }
    }
    if (!hits)
        printf ("no match: 4.3BSD rand low-byte (full 2^32)\n");
}

// BSD random(): 31-int additive ring, warmup 310, out = (v>>1)
static int try_random (uint32_t seed, int glibc_init, int warmup)
{
    uint32_t st[31];
    if (glibc_init)
    {
        int32_t prev = (int32_t) seed;
        st[0] = seed;
        for (int i = 1; i < 31; i++)
        {
            int64_t hi = prev / 127773, lo = prev % 127773;
            int64_t w = 16807 * lo - 2836 * hi;
            if (w < 0)
                w += 2147483647;
            st[i] = (uint32_t) w;
            prev = (int32_t) w;
        }
    }
    else
    {
        st[0] = seed;
        for (int i = 1; i < 31; i++)
            st[i] = 1103515245u * st[i - 1] + 12345u;
    }
    int f = 3 % 31, r = 0; // front starts at index 3, rear at 0
    for (int k = 0; k < warmup + 256; k++)
    {
        st[f] += st[r];
        uint32_t out = (st[f] & 0x7fffffffu) >> 1;
        f = (f + 1) % 31;
        r = (r + 1) % 31;
        if (k >= warmup)
            if ((uint8_t) (out % 256) != canon_rnd[k - warmup])
                return 0;
    }
    return 1;
}

int main (void)
{
    scan_bsd_rand ();
    // seed ranges: 0..2^24 and unix time 1992-1994
    struct
    {
        uint32_t lo, hi;
        const char* what;
    } R[] = {
        {0, 1u << 24, "small"},
        {662688000u, 788918400u, "1991-01..1995-01 timestamps"},
    };
    for (int g = 0; g < 2; g++)
        for (int w = 0; w < 2; w++) // warmup 310 (classic) or 0
            for (unsigned ri = 0; ri < 2; ri++)
            {
                int hits = 0;
                for (uint64_t s = R[ri].lo; s < R[ri].hi; s++)
                    if (try_random ((uint32_t) s, g, w ? 310 : 0))
                    {
                        printf ("*** MATCH random() %s init, warmup %d, "
                                "seed=%llu\n",
                                g ? "glibc" : "bsd", w ? 310 : 0,
                                (unsigned long long) s);
                        hits++;
                    }
                if (!hits)
                    printf ("no match: random() %s init warmup=%d range=%s\n",
                            g ? "glibc" : "bsd", w ? 310 : 0, R[ri].what);
            }
    return 0;
}
