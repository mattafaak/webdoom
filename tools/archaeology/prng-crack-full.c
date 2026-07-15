#include <stdio.h>
#include <stdint.h>
#include <omp.h>
#include "rndtable.h"

int main (void)
{
    // drand48 family: X' = X*0x5DEECE66D + 0xB (mod 2^48), srand48 X0 =
    // seed<<16 | 0x330E
    int hits48a = 0, hits48b = 0, hitsr = 0;
#pragma omp parallel for reduction(+ : hits48a, hits48b, hitsr)                \
    schedule(dynamic, 1 << 20)
    for (int64_t seed = 0; seed < 0x100000000ll; seed++)
    {
        const uint64_t M = (1ull << 48) - 1, A = 0x5DEECE66Dull, C = 0xB;
        uint64_t x = (((uint64_t) (uint32_t) seed) << 16) | 0x330E;
        // variant a: floor(drand48()*256) = bits 47..40 ; variant b:
        // lrand48()%256
        int oka = 1, okb = 1;
        uint64_t xa = x;
        for (int i = 0; i < 4 && (oka | okb); i++)
        {
            xa = (xa * A + C) & M;
            if ((uint8_t) (xa >> 40) != canon_rnd[i])
                oka = 0;
            if ((uint8_t) ((xa >> 17) % 256) != canon_rnd[i])
                okb = 0;
        }
        if (oka)
        {
            xa = x;
            oka = 1;
            for (int i = 0; i < 256 && oka; i++)
            {
                xa = (xa * A + C) & M;
                if ((uint8_t) (xa >> 40) != canon_rnd[i])
                    oka = 0;
            }
            if (oka)
            {
                printf ("*** drand48 top-byte seed=%lld\n", (long long) seed);
                hits48a++;
            }
        }
        if (okb)
        {
            xa = x;
            okb = 1;
            for (int i = 0; i < 256 && okb; i++)
            {
                xa = (xa * A + C) & M;
                if ((uint8_t) ((xa >> 17) % 256) != canon_rnd[i])
                    okb = 0;
            }
            if (okb)
            {
                printf ("*** lrand48 %%256 seed=%lld\n", (long long) seed);
                hits48b++;
            }
        }
        // BSD random(), bsd init, offsets 0 and 310
        uint32_t st[31];
        st[0] = (uint32_t) seed;
        for (int i = 1; i < 31; i++)
            st[i] = 1103515245u * st[i - 1] + 12345u;
        int f = 3, r = 0;
        int match0 = 1, match310 = 1;
        for (int k = 0; k < 310 + 256; k++)
        {
            st[f] += st[r];
            uint8_t b = (uint8_t) (((st[f] & 0x7fffffffu) >> 1) % 256);
            if (k < 256 && match0 && b != canon_rnd[k])
                match0 = 0;
            if (k >= 310 && match310 && b != canon_rnd[k - 310])
                match310 = 0;
            if (++f == 31)
                f = 0;
            if (++r == 31)
                r = 0;
            if (k >= 256 && !match310 && !match0)
                break;
            if (k >= 4 && !match0 && k < 310 && !match310)
            { /* keep going for 310 */
            }
            if (k == 4 && !match0)
            {
                // cheap bail: check first-4 of the 310 window later only
                // (can't skip; continue)
            }
        }
        if (match0)
        {
            printf ("*** random() offset0 seed=%lld\n", (long long) seed);
            hitsr++;
        }
        if (match310)
        {
            printf ("*** random() offset310 seed=%lld\n", (long long) seed);
            hitsr++;
        }
    }
    if (!hits48a && !hits48b && !hitsr)
        printf ("no match: drand48/lrand48/random over full 2^32\n");
    return 0;
}
