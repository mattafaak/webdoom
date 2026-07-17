#include <stdio.h>
#include <stdint.h>
static uint8_t pal[768], cm[34 * 256];
static int nearest_gray (int gray)
{
    int best = 0;
    long bd = 1L << 62;
    for (int j = 0; j < 256; j++)
    {
        long dr = pal[j * 3] - gray, dg = pal[j * 3 + 1] - gray,
             db = pal[j * 3 + 2] - gray, d = dr * dr + dg * dg + db * db;
        if (d < bd)
        {
            bd = d;
            best = j;
        }
    }
    return best;
}
int main (int argc, char** argv)
{
    FILE* fp = fopen (argv[1], "rb");
    fread (pal, 1, 768, fp);
    fclose (fp);
    fp = fopen (argv[2], "rb");
    fread (cm, 1, 34 * 256, fp);
    fclose (fp);
    const uint8_t* iv = cm + 32 * 256;
    int bestbad = 9999, bA = 0, bwr = 0, bwg = 0, bwb = 0;
    // gray = A - ((wr*r+wg*g+wb*b) >> 8), weights near 77/151/28, A near 250
    for (int A = 240; A <= 256; A++)
        for (int wr = 70; wr <= 85; wr++)
            for (int wg = 145; wg <= 160; wg++)
                for (int wb = 22; wb <= 34; wb++)
                {
                    int bad = 0;
                    for (int i = 0; i < 256 && bad < bestbad; i++)
                    {
                        int r = pal[i * 3], g = pal[i * 3 + 1],
                            b = pal[i * 3 + 2];
                        int gray = A - ((wr * r + wg * g + wb * b) >> 8);
                        if (gray < 0)
                            gray = 0;
                        if (gray > 255)
                            gray = 255;
                        if (nearest_gray (gray) != iv[i])
                            bad++;
                    }
                    if (bad < bestbad)
                    {
                        bestbad = bad;
                        bA = A;
                        bwr = wr;
                        bwg = wg;
                        bwb = wb;
                    }
                }
    printf ("best: gray = %d - ((%d*r+%d*g+%d*b)>>8)  → %d/256 mismatches "
            "(wsum=%d)\n",
            bA, bwr, bwg, bwb, bestbad, bwr + bwg + bwb);

    // ea-026: the doc's "standard luma missed by 92" — the textbook ITU BT.601
    // weights (77/150/29, summing to 256) scored against the same best A, to
    // show WHY the 262-sum weights are the interesting finding.
    int bad_itu = 0;
    for (int i = 0; i < 256; i++)
    {
        int r = pal[i * 3], g = pal[i * 3 + 1], b = pal[i * 3 + 2];
        int gray = bA - ((77 * r + 150 * g + 29 * b) >> 8);
        if (gray < 0)
            gray = 0;
        if (gray > 255)
            gray = 255;
        if (nearest_gray (gray) != iv[i])
            bad_itu++;
    }
    printf ("standard ITU luma (77/150/29): %d/256 mismatches\n", bad_itu);

    // CLAIMS_JSON footer (task 6.3) — engine-archaeology.md §6 invuln map:
    //   ea-023 matching entries = 256 - mismatches  (the doc claimed 242 until
    //          task 6.1's inventory caught it: 242 + 15 = 257 > 256. Now 241.)
    //   ea-024 tie-break count   = the mismatches themselves (15)
    //   ea-025 luma weight sum   = wr + wg + wb (262, not the textbook ITU set)
    //   ea-026 entries the standard ITU weights miss (91 — see FINDING-4)
    printf ("CLAIMS_JSON "
            "{\"ea-023\":\"%d\",\"ea-024\":\"%d\",\"ea-025\":\"%d\",\"ea-026\":"
            "\"%d\"}\n",
            256 - bestbad, bestbad, bwr + bwg + bwb, bad_itu);
    return 0;
}
