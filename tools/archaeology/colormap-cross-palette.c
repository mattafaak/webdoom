/* colormap-cross-palette.c — COLORMAP universality check
 *
 * Verifies three things:
 *   (a) PLAYPAL and COLORMAP are byte-identical across the doom-family WADs
 *       (doom/doom2/plutonia/tnt/chex); prints sha-style first-8-hex digests.
 *   (b) The (32-L)/32 Euclidean nearest-colour recipe gives 3517/8192
 * mismatches on HACX — the only genuinely distinct palette — falsifying
 * universality. (c) A per-level best-fit scale fit to HACX's own colormap
 * recovers the (32-L)/32 darkening curve, confirming the curve is universal
 * even though the index matching is not.
 *
 * Usage: colormap-cross-palette <wad_dir>
 *   wad_dir must contain doom.wad, doom2.wad, plutonia.wad, tnt.wad,
 *                              chex.wad, and hacx.wad
 *
 * Exit: nonzero if HACX mismatches != 3517 or doom-family byte identity fails.
 *
 * CLAIMS_JSON footer:
 *   ea-048  HACX COLORMAP mismatches with (32-L)/32 Euclidean recipe
 *   ea-049  doom-family WADs byte-identical to doom.wad COLORMAP (not counting
 * doom itself)
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Minimal WAD lump reader ─────────────────────────────────────────────── */

typedef struct
{
    uint8_t* data;
    int size;
} Lump;

/* Read 4-byte little-endian uint32 from a byte pointer. */
static uint32_t read_u32le (const uint8_t* p)
{
    return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) |
           ((uint32_t) p[3] << 24);
}

/* Extract a named lump from a WAD file.  Caller must free lump.data. */
static Lump extract_lump (const char* wad_path, const char* lump_name)
{
    Lump result = {NULL, 0};
    FILE* fp = fopen (wad_path, "rb");
    if (!fp)
        return result;

    /* Read header: magic(4) + numlumps(4) + infotableofs(4) */
    uint8_t hdr[12];
    if (fread (hdr, 1, 12, fp) != 12)
    {
        fclose (fp);
        return result;
    }
    uint32_t numlumps = read_u32le (hdr + 4);
    uint32_t infotableofs = read_u32le (hdr + 8);

    /* Read directory */
    fseek (fp, (long) infotableofs, SEEK_SET);
    uint8_t* dir = malloc (numlumps * 16);
    if (!dir)
    {
        fclose (fp);
        return result;
    }
    fread (dir, 16, numlumps, fp);

    /* Search for lump by name */
    char name8[9];
    for (uint32_t i = 0; i < numlumps; i++)
    {
        uint8_t* e = dir + i * 16;
        memcpy (name8, e + 8, 8);
        name8[8] = '\0';
        /* Trim NUL padding */
        for (int k = 0; k < 8; k++)
            if (name8[k] == '\0')
                break;
        if (strcmp (name8, lump_name) == 0)
        {
            uint32_t ofs = read_u32le (e);
            uint32_t sz = read_u32le (e + 4);
            result.data = malloc (sz);
            result.size = (int) sz;
            if (result.data)
            {
                fseek (fp, (long) ofs, SEEK_SET);
                fread (result.data, 1, sz, fp);
            }
            break;
        }
    }
    free (dir);
    fclose (fp);
    return result;
}

/* ── Colour utilities ────────────────────────────────────────────────────── */

static int nearest_euclid (const uint8_t* pal, double r, double g, double b)
{
    int best = 0;
    double bd = 1e30;
    for (int j = 0; j < 256; j++)
    {
        double dr = pal[j * 3] - r, dg = pal[j * 3 + 1] - g,
               db = pal[j * 3 + 2] - b;
        double d = dr * dr + dg * dg + db * db;
        if (d < bd)
        {
            bd = d;
            best = j;
        }
    }
    return best;
}

/* Count mismatches for (32-L)/32 recipe with rounding vs stored colormap. */
static int recipe_mismatches (const uint8_t* pal, const uint8_t* cm, int L)
{
    double s = (32.0 - L) / 32.0;
    int bad = 0;
    for (int i = 0; i < 256; i++)
    {
        double r = floor (pal[i * 3] * s + 0.5);
        double g = floor (pal[i * 3 + 1] * s + 0.5);
        double b = floor (pal[i * 3 + 2] * s + 0.5);
        if (nearest_euclid (pal, r, g, b) != cm[L * 256 + i])
            bad++;
    }
    return bad;
}

/* ── Simple 32-bit FNV-1a hash for byte identity check ──────────────────── */

static uint32_t fnv32 (const uint8_t* data, int len)
{
    uint32_t h = 2166136261u;
    for (int i = 0; i < len; i++)
        h = (h ^ data[i]) * 16777619u;
    return h;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

int main (int argc, char** argv)
{
    if (argc < 2)
    {
        fprintf (stderr, "usage: colormap-cross-palette <wad_dir>\n");
        return 1;
    }

    const char* wad_dir = argv[1];
    char path[1024];

    /* doom-family WADs: doom is reference; the rest must be identical */
    const char* family_names[] = {"doom", "doom2", "plutonia", "tnt", "chex"};
    const int family_count = 5;

    /* ── (a) Byte identity check ─────────────────────────────────────────── */
    printf ("=== (a) PLAYPAL + COLORMAP byte identity ===\n");

    /* Load reference (doom.wad) */
    snprintf (path, sizeof path, "%s/doom.wad", wad_dir);
    Lump ref_pp = extract_lump (path, "PLAYPAL");
    Lump ref_cm = extract_lump (path, "COLORMAP");
    if (!ref_pp.data || !ref_cm.data)
    {
        fprintf (stderr,
                 "ERROR: could not extract doom.wad PLAYPAL/COLORMAP from %s\n",
                 path);
        return 1;
    }

    uint32_t ref_pp_hash = fnv32 (ref_pp.data, ref_pp.size);
    uint32_t ref_cm_hash = fnv32 (ref_cm.data, ref_cm.size);
    printf ("doom:     PLAYPAL fnv32=%08x  COLORMAP fnv32=%08x  [reference]\n",
            ref_pp_hash, ref_cm_hash);

    int identical_count = 0;
    int identity_fail = 0;
    for (int wi = 1; wi < family_count; wi++)
    {
        snprintf (path, sizeof path, "%s/%s.wad", wad_dir, family_names[wi]);
        Lump pp = extract_lump (path, "PLAYPAL");
        Lump cm = extract_lump (path, "COLORMAP");
        int pp_eq = pp.data && pp.size == ref_pp.size &&
                    memcmp (pp.data, ref_pp.data, ref_pp.size) == 0;
        int cm_eq = cm.data && cm.size == ref_cm.size &&
                    memcmp (cm.data, ref_cm.data, ref_cm.size) == 0;
        int both_eq = pp_eq && cm_eq;
        uint32_t pp_h = pp.data ? fnv32 (pp.data, pp.size) : 0;
        uint32_t cm_h = cm.data ? fnv32 (cm.data, cm.size) : 0;
        printf ("%-9s PLAYPAL fnv32=%08x  COLORMAP fnv32=%08x  %s\n",
                family_names[wi], pp_h, cm_h,
                both_eq ? "IDENTICAL" : "DIFFERS");
        if (both_eq)
            identical_count++;
        else
            identity_fail = 1;
        free (pp.data);
        free (cm.data);
    }
    if (identity_fail)
    {
        printf ("FAIL  doom-family WADs are not byte-identical\n");
    }
    else
    {
        printf ("PASS  doom2/plutonia/tnt/chex are byte-identical to doom "
                "(ea-049 = %d)\n",
                identical_count);
    }

    /* ── (b) Recipe vs HACX ──────────────────────────────────────────────── */
    printf ("\n=== (b) (32-L)/32 Euclidean recipe on HACX ===\n");

    snprintf (path, sizeof path, "%s/hacx.wad", wad_dir);
    Lump hx_pp = extract_lump (path, "PLAYPAL");
    Lump hx_cm = extract_lump (path, "COLORMAP");
    if (!hx_pp.data || !hx_cm.data)
    {
        fprintf (stderr,
                 "ERROR: could not extract hacx.wad PLAYPAL/COLORMAP from %s\n",
                 path);
        free (ref_pp.data);
        free (ref_cm.data);
        return 1;
    }

    /* Use first palette entry (768 bytes) */
    uint8_t* hx_pal = hx_pp.data;
    uint8_t* hx_colmap = hx_cm.data;

    /* Count palette byte differences vs doom */
    int pal_diff = 0;
    for (int i = 0; i < 768; i++)
        if (hx_pal[i] != ref_pp.data[i])
            pal_diff++;
    printf ("HACX palette bytes differ from doom: %d/768\n", pal_diff);

    int hacx_total = 0;
    int hacx_exact_levels = 0;
    for (int L = 0; L < 32; L++)
    {
        int bad = recipe_mismatches (hx_pal, hx_colmap, L);
        hacx_total += bad;
        if (!bad)
            hacx_exact_levels++;
    }
    printf ("HACX recipe (euclid, round, (32-L)/32): %d/8192 mismatches, "
            "%d/32 exact levels\n",
            hacx_total, hacx_exact_levels);

    const int EXPECTED_HACX = 3517;
    if (hacx_total != EXPECTED_HACX)
    {
        printf ("FAIL  expected %d, got %d (ea-048)\n", EXPECTED_HACX,
                hacx_total);
    }
    else
    {
        printf ("PASS  ea-048 = %d\n", hacx_total);
    }

    /* Also show doom result for reference */
    int doom_total = 0;
    uint8_t* doom_pal = ref_pp.data;
    uint8_t* doom_cm = ref_cm.data;
    for (int L = 0; L < 32; L++)
        doom_total += recipe_mismatches (doom_pal, doom_cm, L);
    printf ("doom  recipe (euclid, round, (32-L)/32): %d/8192 mismatches "
            "[reference]\n",
            doom_total);

    /* ── (c) Per-level best-fit curve corroboration ──────────────────────── */
    printf ("\n=== (c) Per-level best-fit scale — curve corroboration ===\n");
    printf ("L    best_s  recipe_s  delta    mismatches\n");
    printf ("---- ------- --------- -------- ----------\n");

    double max_delta = 0.0;
    int curve_fail = 0;
    const double CURVE_TOLERANCE = 0.02; /* allow up to 2/100 deviation */
    for (int L = 0; L < 32; L++)
    {
        double recipe_s = (32.0 - L) / 32.0;
        double best_s = 0.0;
        int best_bad = 100000;

        /* Brute-force s in [0.0, 1.0] at 0.001 resolution */
        for (int si = 0; si <= 1000; si++)
        {
            double s = si / 1000.0;
            int bad = 0;
            for (int i = 0; i < 256; i++)
            {
                double r = floor (hx_pal[i * 3] * s + 0.5);
                double g = floor (hx_pal[i * 3 + 1] * s + 0.5);
                double b = floor (hx_pal[i * 3 + 2] * s + 0.5);
                if (nearest_euclid (hx_pal, r, g, b) != hx_colmap[L * 256 + i])
                    bad++;
            }
            if (bad < best_bad)
            {
                best_bad = bad;
                best_s = s;
            }
        }

        double delta = fabs (best_s - recipe_s);
        if (delta > max_delta)
            max_delta = delta;
        if (delta > CURVE_TOLERANCE)
            curve_fail = 1;

        /* Print every 4th level for the summary table, plus L=0 and L=31 */
        if (L == 0 || L == 31 || L % 4 == 0)
        {
            printf ("L=%-2d  %.3f   %.3f     %+.3f   %d/256\n", L, best_s,
                    recipe_s, best_s - recipe_s, best_bad);
        }
    }
    printf ("Max |delta| across 32 levels: %.3f (tolerance: %.3f)\n", max_delta,
            CURVE_TOLERANCE);
    if (curve_fail)
        printf ("FAIL  best-fit scale deviates from (32-L)/32 by more than "
                "tolerance\n");
    else
        printf (
            "PASS  curve corroboration: (32-L)/32 confirmed to within %.3f\n",
            CURVE_TOLERANCE);

    /* ── Result summary ──────────────────────────────────────────────────── */
    int overall_fail =
        identity_fail || (hacx_total != EXPECTED_HACX) || curve_fail;
    printf ("\n");
    printf ("ea-048  HACX mismatches: %d/8192\n", hacx_total);
    printf ("ea-049  doom-family identical: %d/%d\n", identical_count,
            family_count - 1);
    printf ("CLAIMS_JSON {\"ea-048\":%d,\"ea-049\":%d}\n", hacx_total,
            identical_count);

    free (ref_pp.data);
    free (ref_cm.data);
    free (hx_pp.data);
    free (hx_cm.data);

    return overall_fail ? 1 : 0;
}
