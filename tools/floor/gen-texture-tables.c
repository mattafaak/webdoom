// tools/floor/gen-texture-tables.c — the texture tables as const data, for a
// port that keeps them in flash beside its WAD (TEXTURES_CONST and
// COMPOSITES_CONST, engine/core/r_data.c).
//
// Linked into fs-texgen (tools/freestanding/Makefile): the objects of the
// build that will use the tables, with r_data.c compiled -DTEXTURES_GEN, and
// --wrap=R_InitData,--wrap=Z_Malloc.  `fs-texgen <wad>` boots that engine on
// the WAD as fs-doom does; when R_InitData returns, this prints the tables it
// built as C initializers and exits.  So the const tables are the engine's own
// output, and the TEXTURES_CONST build checks them again, against the WAD it
// is given, when it starts.
//   - Every block Z_Malloc hands out is first filled with WD_TEXGEN_POISON (a
//     byte, 0 by default).  The Makefile runs this twice, with 0 and 255, and
//     requires the same output: a table holding a byte the engine never wrote
//     (a column no patch covers, a composite row no patch covers, both left
//     as whatever the zone held) would differ, and is refused.
//   - WD_TEXGEN_COMPOSITES=1 adds every composite texture, each built by
//     R_GenerateComposite as the renderer builds it when first drawn.
//   - A column whose lump is 0 is refused: R_GetColumn would send it to
//     R_GenerateComposite, which cannot write into a const table.
//   - WD_TEXGEN_CORRUPT builds wrong values on purpose, for the red-proofs
//     (tools/floor/textures-const-test.mjs): a comma-separated list of
//       ofs:<wad>:<texture>:<column>   that column's offset one too high
//       def:<wad>:<texture>            its first patch's originy one too high
//       comp:<wad>:<texture>:<byte>    that byte of its composite one higher
//       sprite:<wad>:<lump>            that sprite lump's offset one pixel more
//     with <wad> as WD_TEXGEN_ID names it; another WAD's tables are left alone.
//
// usage (the Makefile's):
//   WD_TEXGEN_OUT=<file> WD_TEXGEN_ID=<c identifier> WD_TEXGEN_WAD=<name>
//   [WD_TEXGEN_POISON=<0..255>] [WD_TEXGEN_COMPOSITES=1]
//   [WD_TEXGEN_CORRUPT=<item>,...] fs-texgen <wad>
// Copyright (C) 2026, GPL-2.0-or-later.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "doomdef.h"
#include "m_swap.h"
#include "w_wad.h"
#include "z_zone.h"
#include "r_data.h"
#include "r_state.h"

extern int numtextures;
extern int* texturecompositesize;
extern byte** texturecomposite;
void R_GenerateComposite (int texnum);
void R_TexGenTexture (int i, char* name, int* width, int* height,
                      int* patchcount);
void R_TexGenPatch (int i, int j, int* originx, int* originy, int* patch);

static int tg_poison;
static FILE* out;
static const char* id;

// what went wrong, and the string or the texture name (8 bytes, maybe
// without a NUL) it went wrong with
static void fail (const char* what, const char* s)
{
    fprintf (stderr, "gen-texture-tables: %s%s%s\n", what, s ? ": " : "",
             s ? s : "");
    exit (1);
}

static void fail_tex (const char* what, const char* name)
{
    char n[9];
    memcpy (n, name, 8);
    n[8] = 0;
    fail (what, n);
}

void* __real_Z_Malloc (int size, int tag, void* user);
void* __wrap_Z_Malloc (int size, int tag, void* user)
{
    void* p = __real_Z_Malloc (size, tag, user);
    memset (p, tg_poison, (size_t) size);
    return p;
}

static int tex_width (int i)
{
    char name[8];
    int w, h, pc;
    R_TexGenTexture (i, name, &w, &h, &pc);
    return w;
}

// n bytes as a C string literal, octal escapes for anything not plainly
// printable (three digits each, so a digit after one is never part of it)
static void emit_bytes (const byte* b, int n)
{
    int i;
    for (i = 0; i < n; i++)
    {
        if (i % 64 == 0)
            fputs (i ? "\"\n    \"" : "\"", out);
        if (b[i] >= 0x20 && b[i] < 0x7f && b[i] != '"' && b[i] != '\\' &&
            b[i] != '?')
            fputc (b[i], out);
        else
            fprintf (out, "\\%03o", b[i]);
    }
    fputs (n ? "\"" : "\"\"", out);
}

static void emit_ints (const char* type, const char* name, const int* v, int n)
{
    int i;
    fprintf (out, "static const %s tc_%s_%s[%d] = {", type, id, name,
             n ? n : 1);
    for (i = 0; i < n; i++)
        fprintf (out, "%s%d",
                 i == 0   ? "\n    "
                 : i % 12 ? ", "
                          : ",\n    ",
                 v[i]);
    fprintf (out, "%s\n};\n", n ? "" : "0");
}

// the wrong values WD_TEXGEN_CORRUPT asks of this WAD
#define MAXBAD 8
static struct
{
    char kind; // 'o', 'd', 'c' or 's'
    char name[9];
    int n;
    int tex;
    int done;
} bad[MAXBAD];
static int nbad;

static void parse_corrupt (void)
{
    const char* p = getenv ("WD_TEXGEN_CORRUPT");
    while (p && *p)
    {
        char item[64], kind[8], wad[32], name[9] = {0};
        int n = 0, f = 0;
        size_t len = strcspn (p, ",");
        if (len >= sizeof item || nbad == MAXBAD)
            fail ("WD_TEXGEN_CORRUPT: too long", p);
        memcpy (item, p, len);
        item[len] = 0;
        p += len + (p[len] == ',');
        if (sscanf (item, "sprite:%31[^:]:%d", wad, &n) == 2)
            strcpy (kind, "sprite");
        else if ((f = sscanf (item, "%7[a-z]:%31[^:]:%8[^:]:%d", kind, wad,
                              name, &n)) < 3 ||
                 (strcmp (kind, "def") ? f != 4 || (strcmp (kind, "ofs") &&
                                                    strcmp (kind, "comp"))
                                       : f != 3))
            fail ("WD_TEXGEN_CORRUPT: an item is not ofs:<wad>:<texture>:"
                  "<column>, def:<wad>:<texture>, comp:<wad>:<texture>:<byte>"
                  " or sprite:<wad>:<lump>",
                  item);
        if (strcmp (wad, id))
            continue;
        bad[nbad].kind = kind[0];
        strcpy (bad[nbad].name, name);
        bad[nbad].n = n;
        bad[nbad].tex = -1;
        nbad++;
    }
}

// is (kind, tex, n) one of them; if so it is done
static int is_bad (char kind, int tex, int n)
{
    int k;
    for (k = 0; k < nbad; k++)
        if (bad[k].kind == kind && bad[k].tex == tex && bad[k].n == n)
        {
            bad[k].done = 1;
            return 1;
        }
    return 0;
}

static void dump (void)
{
    const char* wad = getenv ("WD_TEXGEN_WAD") ? getenv ("WD_TEXGEN_WAD") : id;
    int composites = getenv ("WD_TEXGEN_COMPOSITES") &&
                     getenv ("WD_TEXGEN_COMPOSITES")[0] == '1';
    int nummappatches = LUMP_LONG ((int*) W_CacheLumpName ("PNAMES", PU_CACHE));
    int i, j, x, ncols = 0, ncomp = 0, compbytes = 0;
    int* v;

    parse_corrupt ();
    for (i = 0; i < numtextures; i++)
    {
        char name[8];
        int w, h, pc, k;
        R_TexGenTexture (i, name, &w, &h, &pc);
        for (k = 0; k < nbad; k++)
            if (bad[k].kind != 's' && !strncasecmp (name, bad[k].name, 8))
            {
                bad[k].tex = i;
                if (bad[k].kind == 'o' ? bad[k].n >= w
                    : bad[k].kind == 'c'
                        ? !composites || bad[k].n >= texturecompositesize[i]
                        : 0)
                    fail ("WD_TEXGEN_CORRUPT: past the texture's columns or "
                          "composite",
                          bad[k].name);
            }
        if (pc < 1)
            fail_tex ("a texture without patches", name);
        for (x = 0; x < w; x++)
            if (texturecolumnlump[i][x] == 0)
                fail_tex ("a column whose lump is 0 (R_GetColumn would build "
                          "a composite of it)",
                          name);
        ncols += w;
        if (texturecompositesize[i])
        {
            ncomp++;
            compbytes += texturecompositesize[i];
        }
    }
    for (i = 0; i < nbad; i++)
        if (bad[i].kind == 's' ? bad[i].n >= numspritelumps : bad[i].tex < 0)
            fail ("WD_TEXGEN_CORRUPT names no texture or sprite lump of this "
                  "WAD",
                  bad[i].name);

    fprintf (out,
             "// %s: %d textures, %d columns, %d composites (%d B%s), %d "
             "sprite lumps\n",
             wad, numtextures, ncols, ncomp, compbytes,
             composites ? "" : ", not included", numspritelumps);
    for (i = 0; i < nbad; i++)
        fprintf (out, "// CORRUPTED (WD_TEXGEN_CORRUPT): %c %.8s %d\n",
                 bad[i].kind, bad[i].name, bad[i].n);

    // each texture's definition, with its patches
    for (i = 0; i < numtextures; i++)
    {
        char name[8];
        int w, h, pc, ox, oy, lump;
        R_TexGenTexture (i, name, &w, &h, &pc);
        if (pc > 1)
            fprintf (out, "static const TC_PATCHES(%d) tc_%s_t%d = {{", pc - 1,
                     id, i);
        else
            fprintf (out, "static const texture_t tc_%s_t%d = {", id, i);
        emit_bytes ((const byte*) name, 8);
        fprintf (out, ", %d, %d, %d, {", w, h, pc);
        for (j = 0; j < pc; j++)
        {
            R_TexGenPatch (i, j, &ox, &oy, &lump);
            if (j == 0 && is_bad ('d', i, 0))
                oy++;
            fprintf (out, "%s{%d, %d, %d}%s",
                     j == 1 ? "}}, {"
                     : j    ? ", "
                            : "",
                     ox, oy, lump, j == pc - 1 ? "}" : "");
        }
        fputs ("};\n", out);
    }
    fprintf (out, "static texture_t* const tc_%s_textures[%d] = {", id,
             numtextures);
    for (i = 0; i < numtextures; i++)
        fprintf (out, "%s(texture_t*) &tc_%s_t%d",
                 i == 0  ? "\n    "
                 : i % 6 ? ", "
                         : ",\n    ",
                 id, i);
    fprintf (out, "\n};\n");

    // the columns, every texture's after the one before
    v = malloc (sizeof (int) * (size_t) (ncols ? ncols : 1));
    for (i = x = 0; i < numtextures; i++)
        for (j = 0; j < tex_width (i); j++)
            v[x++] = texturecolumnlump[i][j];
    emit_ints ("short", "lump", v, ncols);
    for (i = x = 0; i < numtextures; i++)
        for (j = 0; j < tex_width (i); j++)
        {
            v[x] = texturecolumnofs[i][j] + is_bad ('o', i, j);
            x++;
        }
    emit_ints ("unsigned short", "ofs", v, ncols);
    free (v);
    fprintf (out, "static short* const tc_%s_columnlump[%d] = {", id,
             numtextures);
    for (i = x = 0; i < numtextures; x += tex_width (i), i++)
        fprintf (out, "%s(short*) tc_%s_lump + %d",
                 i == 0  ? "\n    "
                 : i % 6 ? ", "
                         : ",\n    ",
                 id, x);
    fprintf (out, "\n};\nstatic unsigned short* const tc_%s_columnofs[%d] = {",
             id, numtextures);
    for (i = x = 0; i < numtextures; x += tex_width (i), i++)
        fprintf (out, "%s(unsigned short*) tc_%s_ofs + %d",
                 i == 0  ? "\n    "
                 : i % 4 ? ", "
                         : ",\n    ",
                 id, x);
    fprintf (out, "\n};\n");
    emit_ints ("int", "widthmask", texturewidthmask, numtextures);
    emit_ints ("fixed_t", "height", textureheight, numtextures);
    emit_ints ("int", "compositesize", texturecompositesize, numtextures);

    // the composites, each built as the renderer builds it, into a block the
    // poison filled first, then freed
    if (composites)
    {
        fprintf (out, "static const byte tc_%s_comp[%d] =\n    ", id,
                 compbytes ? compbytes : 1);
        if (!compbytes)
            fputs ("{0}", out);
        for (i = 0, j = 0; i < numtextures; i++)
        {
            if (!texturecompositesize[i])
                continue;
            R_GenerateComposite (i);
            for (x = 0; x < nbad; x++)
                if (bad[x].kind == 'c' && bad[x].tex == i &&
                    is_bad ('c', i, bad[x].n))
                    texturecomposite[i][bad[x].n]++;
            if (j++)
                fputs ("\n    ", out);
            emit_bytes (texturecomposite[i], texturecompositesize[i]);
            Z_Free (texturecomposite[i]);
        }
        fprintf (out, ";\nstatic byte* const tc_%s_composite[%d] = {", id,
                 numtextures);
        for (i = x = 0; i < numtextures; x += texturecompositesize[i], i++)
        {
            fputs (i == 0 ? "\n    " : i % 6 ? ", " : ",\n    ", out);
            if (texturecompositesize[i])
                fprintf (out, "(byte*) tc_%s_comp + %d", id, x);
            else
                fputs ("0", out);
        }
        fprintf (out, "\n};\n");
    }

    emit_ints ("fixed_t", "spritewidth", spritewidth, numspritelumps);
    for (i = 0; i < nbad; i++)
        if (bad[i].kind == 's')
        {
            bad[i].done = 1;
            spriteoffset[bad[i].n] += FRACUNIT; // its own copy: it exits next
        }
    emit_ints ("fixed_t", "spriteoffset", spriteoffset, numspritelumps);
    emit_ints ("fixed_t", "spritetopoffset", spritetopoffset, numspritelumps);

    fprintf (
        out,
        "static const texconst_t tc_%s = {\n    \"%s\", %d, %d, %d, %d, %d,\n"
        "    tc_%s_textures, tc_%s_columnlump, tc_%s_columnofs,\n"
        "    tc_%s_widthmask, tc_%s_height, tc_%s_compositesize,\n",
        id, wad, numtextures, nummappatches, numspritelumps, ncols, ncomp, id,
        id, id, id, id, id);
    if (composites)
        fprintf (out, "    tc_%s_composite,\n", id);
    else
        fputs ("    0,\n", out);
    fprintf (out,
             "    tc_%s_spritewidth, tc_%s_spriteoffset, "
             "tc_%s_spritetopoffset\n};\n",
             id, id, id);
    for (i = 0; i < nbad; i++)
        if (!bad[i].done)
            fail ("WD_TEXGEN_CORRUPT: an item was never applied", bad[i].name);
}

void __real_R_InitData (void);
void __wrap_R_InitData (void)
{
    const char* path = getenv ("WD_TEXGEN_OUT");
    __real_R_InitData ();
    id = getenv ("WD_TEXGEN_ID");
    if (!path || !id || !*id)
        fail ("WD_TEXGEN_OUT and WD_TEXGEN_ID are required", NULL);
    out = fopen (path, "w");
    if (!out)
        fail ("cannot write", path);
    dump ();
    if (fclose (out) != 0)
        fail ("cannot write", path);
    exit (0);
}

// before Z_Init's first block: the poison
__attribute__ ((constructor)) static void tg_init (void)
{
    if (getenv ("WD_TEXGEN_POISON"))
        tg_poison = atoi (getenv ("WD_TEXGEN_POISON")) & 0xff;
}
