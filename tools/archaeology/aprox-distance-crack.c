/* aprox-distance-crack.c — verifies P_AproxDistance relative error claims.
 *
 * P_AproxDistance: dist = max(|dx|,|dy|) + min(|dx|,|dy|)/2
 * This is the "alpha-max-plus-beta-min" approximation.
 *
 * Claims verified:
 *   ea-015: max relative error = +11.8% at angle 26.6° (arctan(0.5))
 *   ea-016: relative error at 45° = +6.1%
 *   ea-017: relative error on cardinal axes (0° and 90°) = 0%
 *
 * Build: gcc -O2 -lm aprox-distance-crack.c -o aprox-dist && ./aprox-dist
 * Exits 0 on all-pass, 1 on mismatch.
 */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

/* P_AproxDistance: identical to engine/core/p_maputl.c */
static double aprox_distance (double dx, double dy)
{
    if (dx < 0)
        dx = -dx;
    if (dy < 0)
        dy = -dy;
    if (dx < dy)
        return dx + dy - dx * 0.5;
    return dx + dy - dy * 0.5;
}

static double relative_error (double angle_rad)
{
    double dx = cos (angle_rad);
    double dy = sin (angle_rad);
    double exact = sqrt (dx * dx + dy * dy); /* = 1.0 always for unit vector */
    double approx = aprox_distance (dx, dy);
    return (approx - exact) / exact;
}

int main (void)
{
    int failures = 0;

    /* Sweep all angles to find the maximum error */
    double max_err = 0.0;
    double max_angle = 0.0;
    int N = 10000000;
    for (int i = 0; i <= N; i++)
    {
        double angle = (M_PI / 2.0) * i / N; /* 0 .. 90 degrees */
        double err = relative_error (angle);
        if (err > max_err)
        {
            max_err = err;
            max_angle = angle * 180.0 / M_PI;
        }
    }

    /* ea-015: max error = +11.8% at ~26.6° */
    {
        /* arctan(0.5) = 26.565° */
        double expected_angle = atan (0.5) * 180.0 / M_PI; /* ~26.565 */
        double expected_max = 0.118;                       /* 11.8% */
        int pass_err = fabs (max_err - expected_max) < 0.001;
        int pass_angle = fabs (max_angle - expected_angle) < 1.0;
        printf ("%s  ea-015  P_AproxDistance max relative error = +%.1f%% "
                "(expected +11.8%%)\n",
                (pass_err && pass_angle) ? "PASS" : "FAIL", max_err * 100.0);
        printf (
            "          worst angle = %.2f° (expected ~26.6° = arctan 0.5)\n",
            max_angle);
        if (!pass_err || !pass_angle)
            failures++;
    }

    /* ea-016: error at exactly 45° = +6.1% */
    {
        double err45 = relative_error (M_PI / 4.0);
        int pass = fabs (err45 - 0.061) < 0.001;
        printf ("%s  ea-016  P_AproxDistance error at 45° = +%.1f%% (expected "
                "+6.1%%)\n",
                pass ? "PASS" : "FAIL", err45 * 100.0);
        if (!pass)
            failures++;
    }

    /* ea-017: error on cardinal axes = 0% */
    {
        double err0 = relative_error (0.0);
        double err90 = relative_error (M_PI / 2.0);
        int pass0 = fabs (err0) < 1e-10;
        int pass90 = fabs (err90) < 1e-10;
        printf (
            "%s  ea-017  P_AproxDistance error at 0° = %.1f%% (expected 0%%)\n",
            pass0 ? "PASS" : "FAIL", err0 * 100.0);
        printf ("%s          P_AproxDistance error at 90° = %.1f%% (expected "
                "0%%)\n",
                pass90 ? "PASS" : "FAIL", err90 * 100.0);
        if (!pass0 || !pass90)
            failures++;
    }

    printf ("\naprox-distance-crack: %d/3 passed\n", 3 - failures);
    printf ("CLAIMS_JSON "
            "{\"ea-015\":\"+%.1f%%\",\"ea-016\":\"+%.1f%%\",\"ea-017\":\"%.1f%%"
            "\"}\n",
            max_err * 100.0, relative_error (M_PI / 4.0) * 100.0,
            relative_error (0.0) * 100.0);
    return failures > 0 ? 1 : 0;
}
