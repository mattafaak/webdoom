/* rndtable-stats.c — computes statistical properties of Doom's 256-byte
 * rndtable to verify engine-archaeology.md claims ea-007..ea-009.
 *
 * Claims verified:
 *   ea-007: rndtable mean value = 128.85
 *   ea-008: rndtable distinct values = 166 / 256
 *   ea-009: rndtable values that never appear = 90
 *
 * Build: gcc -O2 rndtable-stats.c -o rndtable-stats && ./rndtable-stats
 * Exits 0 on all-pass, 1 on mismatch.
 */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

/* The canonical rndtable from rndtable.h */
#include "rndtable.h"

int main (void)
{
    int failures = 0;

    /* Compute mean */
    double sum = 0.0;
    for (int i = 0; i < 256; i++)
        sum += canon_rnd[i];
    double mean = sum / 256.0;

    /* Compute distinct values and values never appearing */
    int seen[256];
    memset (seen, 0, sizeof seen);
    for (int i = 0; i < 256; i++)
        seen[canon_rnd[i]] = 1;
    int distinct = 0, never = 0;
    for (int v = 0; v < 256; v++)
    {
        if (seen[v])
            distinct++;
        else
            never++;
    }

    /* ea-007: mean = 128.85 */
    {
        double expected = 128.85;
        int pass = fabs (mean - expected) < 0.01;
        printf ("%s  ea-007  rndtable mean = %.2f (expected 128.85)\n",
                pass ? "PASS" : "FAIL", mean);
        if (!pass)
            failures++;
    }

    /* ea-008: distinct values = 166 */
    {
        int pass = (distinct == 166);
        printf (
            "%s  ea-008  rndtable distinct values = %d / 256 (expected 166)\n",
            pass ? "PASS" : "FAIL", distinct);
        if (!pass)
            failures++;
    }

    /* ea-009: values never appearing = 90 */
    {
        int pass = (never == 90);
        printf (
            "%s  ea-009  rndtable never-appearing values = %d (expected 90)\n",
            pass ? "PASS" : "FAIL", never);
        if (!pass)
            failures++;
    }

    printf ("\nrndtable-stats: %d/3 passed\n", 3 - failures);
    printf ("CLAIMS_JSON "
            "{\"ea-007\":\"%.2f\",\"ea-008\":\"%d\",\"ea-009\":\"%d\"}\n",
            mean, distinct, never);
    return failures > 0 ? 1 : 0;
}
