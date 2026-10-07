// tools/cortexm/wad_semi.c — the WAD, read on demand through semihosting.
//
// The IWADs (doom 12.4 MB, doom2 14.6, plutonia 17.4, tnt 18.2) do not fit in
// either board's RAM beside the engine, so the WAD stays on the host and its
// bytes reach the guest only when the engine copies a lump.
//
// HOW.  The core reads a WAD in exactly two ways (engine/core/w_wad.c):
//   - W_AddFile walks the header and the lump directory with plain loads;
//   - W_ReadLump copies a lump with memcpy (dest, handle, size), where
//     handle = data + filepos.
// So the guest gets a RAM copy of the header and directory, byte for byte as
// in the file except two fields: infotableofs points just past the header, and
// each filepos is rebased so that handle lands at CM_WAD_WINDOW + its true
// file offset.  The window is address space no device decodes (board.h).
// tools/freestanding/floor_wrap.c's --wrap=memcpy already tests every memcpy
// source against the WAD's range to count the bytes (the M flag); with
// FS_WAD_READ=cm_wad_read a copy out of the window is served here, by
// SYS_SEEK + SYS_READ at the lump's true offset.  The lumps, their names,
// sizes and order are the file's; only where they live differs, as for a port
// that maps its WAD at a fixed flash address (XIP), where it would be in place.
//
// WHAT IT COSTS.  The copy runs on the host: it adds no guest instructions
// beyond the call setup (selftest: `semihost_call`, independent of size), where
// an XIP board would execute a memcpy from flash.  So the per-tic counts
// exclude lump copies, and every tic carries the bytes it copied (M:<bytes>)
// for the reader to price.  Any read of WAD bytes that bypasses memcpy is a
// BusFault at an address inside the window, reported by fault.c: nothing reads
// zeros in silence (selftest `window` proves the fault fires).
//
// The zero-copy build (Makefile ZC=1) reads lumps in place, so it cannot use
// the window: cm_wad_load, at the end of this file, puts the WAD's bytes in
// guest memory instead.
// Copyright (C) 2026, GPL-2.0-or-later.
#include <stdlib.h>
#include <string.h>

#include "board.h"
#include "semihost.h"
#include "doomtype.h"
#include "fs_platform.h"

extern const unsigned char* fs_floor_blob;
extern size_t fs_floor_blob_len;

static int wad_fd = -1;
static unsigned wad_pos; // the host file's position after the last read
static unsigned wad_len;
unsigned cm_wad_reads; // semihosted lump copies, for the stats

static void wad_fail (const char* why, const char* path)
{
    cm_uart_puts ("FAIL cm_wad: ");
    cm_uart_puts (why);
    cm_uart_puts (": ");
    cm_uart_puts (path);
    cm_uart_puts ("\n");
    sh_exit (4);
}

static unsigned le32 (const unsigned char* p)
{
    return p[0] | (p[1] << 8) | (p[2] << 16) | ((unsigned) p[3] << 24);
}

static void put_le32 (unsigned char* p, unsigned v)
{
    p[0] = (unsigned char) v;
    p[1] = (unsigned char) (v >> 8);
    p[2] = (unsigned char) (v >> 16);
    p[3] = (unsigned char) (v >> 24);
}

// Open `path` on the host and read its header and directory into a heap copy:
// the header, with infotableofs pointing just past it, then the directory.
// Returns the copy; *np is the lump count.  Every lump is checked to lie
// inside the file.
static unsigned char* wad_directory (const char* path, unsigned* np)
{
    unsigned char head[12];
    unsigned n, dirofs, i;
    unsigned char* dir;

    wad_fd = sh_open (path, 1 /* "rb" */);
    if (wad_fd < 0)
        wad_fail ("cannot open", path);
    wad_len = (unsigned) sh_flen (wad_fd);
    if (sh_read (wad_fd, head, 12) != 0 || memcmp (head + 1, "WAD", 3) ||
        (head[0] != 'I' && head[0] != 'P'))
        wad_fail ("not a WAD", path);
    n = le32 (head + 4);
    dirofs = le32 (head + 8);
    if (n == 0 || n > 65536 || dirofs > wad_len || n * 16 > wad_len - dirofs)
        wad_fail ("directory out of range", path);

    dir = malloc (12 + n * 16);
    if (!dir)
        wad_fail ("no heap for the directory", path);
    memcpy (dir, head, 12);
    put_le32 (dir + 8, 12); // the directory follows the header in this copy
    if (sh_seek (wad_fd, dirofs) != 0 ||
        sh_read (wad_fd, dir + 12, n * 16) != 0)
        wad_fail ("short directory read", path);
    wad_pos = dirofs + n * 16;
    for (i = 0; i < n; i++)
    {
        unsigned pos = le32 (dir + 12 + i * 16),
                 size = le32 (dir + 16 + i * 16);
        if (pos > wad_len || size > wad_len - pos)
            wad_fail ("a lump runs past the end of the file", path);
    }
    *np = n;
    return dir;
}

// Open `path` on the host and register it with files.c as `present_as`.
// Returns the directory's lump count.
unsigned cm_wad_open (const char* path, const char* present_as)
{
    unsigned n, i;
    unsigned char* dir;
    unsigned rebase;

    dir = wad_directory (path, &n);

    // handle = dir + filepos' must equal CM_WAD_WINDOW + filepos (mod 2^32)
    rebase = CM_WAD_WINDOW - (unsigned) dir;
    for (i = 0; i < n; i++)
    {
        unsigned char* e = dir + 12 + i * 16;
        put_le32 (e, le32 (e) + rebase);
    }

    fs_register_wad (present_as, dir, (int) wad_len);
    fs_floor_blob = (const unsigned char*) CM_WAD_WINDOW;
    fs_floor_blob_len = wad_len;
    return n;
}

// floor_wrap.c's FS_WAD_READ: a memcpy whose source is inside the window
void cm_wad_read (void* dest, size_t offset, size_t n)
{
    if (offset + n > wad_len)
        wad_fail ("a copy runs past the end of the WAD", "(window)");
    if (offset != wad_pos && sh_seek (wad_fd, (unsigned) offset) != 0)
        wad_fail ("seek failed", "(window)");
    if (sh_read (wad_fd, dest, (unsigned) n) != 0)
        wad_fail ("short read", "(window)");
    wad_pos = (unsigned) (offset + n);
    cm_wad_reads++;
}

#ifdef CM_ZERO_COPY
// ── the zero-copy build (Makefile ZC=1) ─────────────────────────────────────
// The engine reads its lumps in place (WEB_LUMPS_IN_PLACE,
// engine/core/w_wad.h), so the WAD's bytes must be in the address space.
// cm_wad_load puts them there once, before the engine starts, by semihosting (a
// host-side copy, so no guest instructions): PSRAM is the WAD's image, as a
// board's flash would be (the zc linker scripts keep everything else out of
// it).  It is 16 MiB:
//   - a WAD that fits (doom.wad, doom2.wad) is loaded as the file is, and
//     files.c is handed PSRAM itself: header, directory and lumps all read in
//     place;
//   - a longer one (plutonia.wad, tnt.wad) keeps its first 16 MiB in PSRAM,
//     and every lump that does not end inside it is served from .wadtail
//     (sections.ld, the ZONE SSRAM above the zone), which holds the file from
//     the first such lump onward.  Each lump is still one run of the file's
//     own bytes; the engine reads a heap copy of the directory whose entries
//     point at them (the rebasing cm_wad_open does for the window).
// Nothing is read through the window afterwards: cm_wad_reads stays 0.
extern unsigned char _swad[], _ewad[], _swadtail[], _ewadtail[];
unsigned cm_wad_tail;  // bytes of the file served from .wadtail, for the stats
unsigned cm_wad_image; // bytes of the file in PSRAM

static void wad_load (unsigned char* dest, unsigned from, unsigned n,
                      const char* path)
{
    if (sh_seek (wad_fd, from) != 0)
        wad_fail ("seek failed", path);
    wad_pos = from + n;
    while (n)
    {
        unsigned k = n > (1u << 20) ? (1u << 20) : n;
        if (sh_read (wad_fd, dest, k) != 0)
            wad_fail ("short read", path);
        dest += k;
        n -= k;
    }
}

unsigned cm_wad_load (const char* path, const char* present_as)
{
    unsigned n, i, split;
    unsigned char* dir;
    unsigned cap = (unsigned) (_ewad - _swad);
    unsigned tailcap = (unsigned) (_ewadtail - _swadtail);
    const unsigned char *lo, *hi;

    dir = wad_directory (path, &n);
    if (wad_len <= cap)
    {
        free (dir);
        wad_load (_swad, 0, wad_len, path);
        cm_wad_image = wad_len;
        cm_wad_tail = 0;
        fs_register_wad (present_as, _swad, (int) wad_len);
        fs_floor_blob = _swad;
        fs_floor_blob_len = wad_len;
        return n;
    }

    // the first byte of the file that .wadtail holds
    split = wad_len;
    for (i = 0; i < n; i++)
    {
        unsigned pos = le32 (dir + 12 + i * 16),
                 size = le32 (dir + 16 + i * 16);
        if (pos + size > cap && pos < split)
            split = pos;
    }
    if (wad_len - split > tailcap)
    {
        cm_uart_puts ("FAIL cm_wad: the WAD needs ");
        cm_uart_dec (wad_len - split);
        cm_uart_puts (" B past PSRAM and .wadtail has ");
        cm_uart_dec (tailcap);
        cm_uart_puts (" (a smaller ZONE_KB leaves it more)\n");
        sh_exit (4);
    }
    wad_load (_swad, 0, cap, path);
    wad_load (_swadtail, split, wad_len - split, path);
    cm_wad_image = cap;
    cm_wad_tail = wad_len - split;

    // handle = dir + filepos' must be the lump's address (mod 2^32)
    for (i = 0; i < n; i++)
    {
        unsigned char* e = dir + 12 + i * 16;
        unsigned pos = le32 (e), size = le32 (e + 4);
        unsigned char* at =
            pos + size <= cap ? _swad + pos : _swadtail + (pos - split);
        put_le32 (e, (unsigned) at - (unsigned) dir);
    }
    fs_register_wad (present_as, dir, (int) wad_len);
    // the memcpy hook's range (floor_wrap.c): both runs, and what lies between
    // them, which is no other data (sections.ld: .wadtail ends the ZONE
    // region, below PSRAM on both boards)
    lo = _swadtail < _swad ? _swadtail : _swad;
    hi = _swadtail + cm_wad_tail > _swad + cap ? _swadtail + cm_wad_tail
                                               : _swad + cap;
    fs_floor_blob = lo;
    fs_floor_blob_len = (size_t) (hi - lo);
    return n;
}
#endif
