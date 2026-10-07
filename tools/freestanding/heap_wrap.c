// tools/freestanding/heap_wrap.c — the heap the engine and port ask for,
// counted at the link with no engine/core edit (the RAM floor's heap peak).
//
// fs-doom is linked with --wrap=malloc,calloc,realloc,free (Makefile
// HEAP_WRAP), which rewrites only the calls in fs-doom's own objects: the
// engine (w_wad.c's lumpinfo and lumpcache, d_main.c's file names, m_misc.c's
// config buffer, g_game.c's savegame) and the platform layer.  glibc's calls
// to its own malloc (stdio buffers) are not ours and are not seen.
//
// What is counted is the bytes requested, live at once: a lower bound on what
// a port's allocator needs (no headers, no rounding), the same quantity on
// every host.  tools/cortexm reports newlib's sbrk high-water instead, which
// includes its allocator's overhead (syscalls.c's cm_heap_peak).
//
// Counting starts when the harness sets fs_heap_counting (i_main.c, just
// before D_DoomMain), so the harness's own WAD buffer is not the engine's.
// Each live block's size is kept in a small open-addressed table; a block the
// table never saw (allocated before counting started) is freed uncounted.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stddef.h>
#include <string.h>

void* __real_malloc (size_t n);
void* __real_calloc (size_t n, size_t m);
void* __real_realloc (void* p, size_t n);
void __real_free (void* p);

int fs_heap_counting;
size_t fs_heap_now, fs_heap_peak;
unsigned fs_heap_lost; // blocks the table had no room for: the count is then a floor

#define SLOTS 4096 // a power of two; the engine holds a handful of blocks
static struct
{
    void* p;
    size_t n;
} slot[SLOTS];

static unsigned hash (void* p)
{
    return (unsigned) (((size_t) p >> 3) * 2654435761u) & (SLOTS - 1);
}

// seat p in the table; 0 if the table is full
static int seat (void* p, size_t n)
{
    unsigned i, k;
    for (k = 0, i = hash (p); k < SLOTS; k++, i = (i + 1) & (SLOTS - 1))
        if (!slot[i].p)
        {
            slot[i].p = p;
            slot[i].n = n;
            return 1;
        }
    return 0;
}

static void note (void* p, size_t n)
{
    if (!p || !fs_heap_counting)
        return;
    if (!seat (p, n))
    {
        fs_heap_lost++;
        return;
    }
    fs_heap_now += n;
    if (fs_heap_now > fs_heap_peak)
        fs_heap_peak = fs_heap_now;
}

// forget p; returns its counted size (0 if it was never counted)
static size_t forget (void* p)
{
    unsigned i, k, j;
    size_t n;
    if (!p)
        return 0;
    for (k = 0, i = hash (p); k < SLOTS && slot[i].p; k++, i = (i + 1) & (SLOTS - 1))
        if (slot[i].p == p)
        {
            n = slot[i].n;
            fs_heap_now -= n;
            slot[i].p = 0;
            // re-seat the rest of the probe run, so no later key is cut off
            for (j = (i + 1) & (SLOTS - 1); slot[j].p; j = (j + 1) & (SLOTS - 1))
            {
                void* q = slot[j].p;
                slot[j].p = 0;
                seat (q, slot[j].n);
            }
            return n;
        }
    return 0;
}

void* __wrap_malloc (size_t n)
{
    void* p = __real_malloc (n);
    note (p, n);
    return p;
}

void* __wrap_calloc (size_t n, size_t m)
{
    void* p = __real_calloc (n, m);
    note (p, n * m);
    return p;
}

void* __wrap_realloc (void* p, size_t n)
{
    // the old and new blocks are both live while realloc copies: a port's
    // allocator must hold both, so the peak counts both, then the old goes
    void* q;
    size_t was = forget (p);
    if (was && fs_heap_counting && fs_heap_now + was + n > fs_heap_peak)
        fs_heap_peak = fs_heap_now + was + n;
    q = __real_realloc (p, n);
    if (!q && n)
    {
        if (was)
            note (p, was); // the old block is still there
        return q;
    }
    note (q, n);
    return q;
}

void __wrap_free (void* p)
{
    forget (p);
    __real_free (p);
}
