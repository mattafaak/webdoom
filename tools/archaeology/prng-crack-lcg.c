// Crack the 1992 rndtable: which classic PRNG + seed emits these 256 bytes?
#include <stdio.h>
#include <stdint.h>
#include "rndtable.h"

typedef struct
{
    const char* name;
    uint32_t mul, add;
    int shift;
    uint32_t mask;
    int mod256;
} lcg_t;

static const lcg_t GENS[] = {
    {"ansi (s>>16 &7fff) %256", 1103515245u, 12345u, 16, 0x7fff, 1},
    {"ansi (s>>16 &7fff) &255", 1103515245u, 12345u, 16, 0x7fff, 0},
    {"borland (s>>16 &7fff) %256", 22695477u, 1u, 16, 0x7fff, 1},
    {"v7 (s &7fff) %256", 1103515245u, 12345u, 0, 0x7fff, 1},
    {"msvc (s>>16 &7fff) %256", 214013u, 2531011u, 16, 0x7fff, 1},
    {"randu-ish (s>>16) &255", 65539u, 0u, 16, 0xffff, 0},
};

int main (void)
{
    for (unsigned g = 0; g < sizeof (GENS) / sizeof (GENS[0]); g++)
    {
        const lcg_t* G = &GENS[g];
        uint32_t found = 0;
        int hits = 0;
        for (uint64_t seed64 = 0; seed64 < 0x100000000ull; seed64++)
        {
            uint32_t s = (uint32_t) seed64;
            // first four outputs must be 0, 8, 109, 220
            uint32_t t = s;
            int ok = 1;
            for (int i = 0; i < 4 && ok; i++)
            {
                t = t * G->mul + G->add;
                uint32_t out = (t >> G->shift) & G->mask;
                uint8_t b =
                    G->mod256 ? (uint8_t) (out % 256) : (uint8_t) (out & 255);
                if (b != canon_rnd[i])
                    ok = 0;
            }
            if (!ok)
                continue;
            // full verify
            t = s;
            ok = 1;
            for (int i = 0; i < 256 && ok; i++)
            {
                t = t * G->mul + G->add;
                uint32_t out = (t >> G->shift) & G->mask;
                uint8_t b =
                    G->mod256 ? (uint8_t) (out % 256) : (uint8_t) (out & 255);
                if (b != canon_rnd[i])
                    ok = 0;
            }
            if (ok)
            {
                found = s;
                hits++;
                printf ("*** MATCH %s seed=%u (0x%x)\n", G->name, s, s);
            }
        }
        if (!hits)
            printf ("no match: %s\n", G->name);
    }
    return 0;
}
