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

// Open `path` on the host and register it with files.c as `present_as`.
// Returns the directory's lump count.
unsigned cm_wad_open (const char* path, const char* present_as)
{
    unsigned char head[12];
    unsigned n, dirofs, i;
    unsigned char* dir;
    unsigned rebase;

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

    // handle = dir + filepos' must equal CM_WAD_WINDOW + filepos (mod 2^32)
    rebase = CM_WAD_WINDOW - (unsigned) dir;
    for (i = 0; i < n; i++)
    {
        unsigned char* e = dir + 12 + i * 16;
        unsigned pos = le32 (e), size = le32 (e + 4);
        if (pos > wad_len || size > wad_len - pos)
            wad_fail ("a lump runs past the end of the file", path);
        put_le32 (e, pos + rebase);
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
