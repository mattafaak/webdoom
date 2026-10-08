// tools/pico/pico_main.c — the full-diet engine's entry on a Raspberry Pi
// RP2350 or RP2040, built only to be linked (tools/pico/link-check.sh): it is
// what a port must supply once the measuring harness (tools/freestanding
// i_main.c, perf.c, floor_wrap.c, tools/floor/floor_log.c) is left out.
//
//   main           stdio, the WAD, D_DoomMain, then D_DoomFrame for ever
//   the WAD        flashed on its own at __wad_start, a fixed XIP-flash
//                  address the linker defines (ld/all/section_extra_post_end
//                  .incl); never copied: files.c hands its bytes to w_wad.c,
//                  which reads every lump in place (WEB_LUMPS_IN_PLACE), so
//                  W_WebFileInPlace's contract holds: one blob, registered
//                  before D_DoomMain, that never moves and is never written
//   pico_get_time  FS_GET_TIME: I_GetTime's 35 Hz clock, from the 1 MHz timer
//   clock_gettime  d_net.c's tic clock (newlib has none to offer)
//   _stat, mkdir   no file system: m_misc.c's access() (newlib's, through
//                  stat) finds nothing, and d_main.c's -cdrom mkdir fails;
//                  pico-sdk's newlib_interface.c has the other system calls
//   sysconf        a page of 8 bytes for newlib's malloc (the full one,
//                  mallocr.c, which pico-sdk links under pico_malloc's
//                  wrapper), not libc's 4096: the boards' (tools/cortexm/
//                  syscalls.c says why), so the heap the floor measured there,
//                  HEAP_KB, is what this heap needs, with no page on top
//   web_perf_*     the stage brackets' accumulators (perf.h); no counter, so
//                  web_perf_now() reads 0
// Display, input and the DAC are the platform layer's no-ops already
// (I_FinishUpdate, I_StartTic, I_SubmitSound).
// Copyright (C) 2026, GPL-2.0-or-later.
#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "pico/stdlib.h"

#ifndef PICO_WAD_NAME
#define PICO_WAD_NAME "doom.wad"
#endif

// the engine's side, declared here so this file needs no engine header
void fs_register_wad (const char* name, unsigned char* data, int len);
void D_DoomMain (void);
void D_DoomFrame (void);
extern int myargc;
extern char** myargv;

// the linker's: ld/all/section_extra_post_end.incl
extern const unsigned char __wad_start[], __wad_end[];

// perf.h's surface, which perf.c defines in the measuring build
double web_perf_sim_us, web_perf_frame_us, web_perf_bsp_us;
double web_perf_planes_us, web_perf_masked_us;
long web_perf_frame_count, web_perf_tic_count;
long web_perf_visplane_peak, web_perf_drawseg_peak, web_perf_opening_peak;
int fs_perf_instr_fd = -1;

double web_perf_now (void)
{
    return 0.0;
}

int pico_get_time (void)
{
    return (int) (time_us_64 () * 35 / 1000000);
}

int clock_gettime (clockid_t clock_id, struct timespec* tp)
{
    uint64_t us = time_us_64 ();
    (void) clock_id;
    tp->tv_sec = (time_t) (us / 1000000);
    tp->tv_nsec = (long) (us % 1000000) * 1000;
    return 0;
}

int _stat (const char* path, struct stat* st)
{
    (void) path;
    (void) st;
    errno = ENOENT;
    return -1;
}

int mkdir (const char* path, mode_t mode)
{
    (void) path;
    (void) mode;
    errno = ENOSYS;
    return -1;
}

// replaces libc's (mallocr.o and freer.o leave sysconf undefined); every
// other name is EINVAL, as libc's
long sysconf (int name)
{
    if (name == _SC_PAGESIZE)
        return 8;
    errno = EINVAL;
    return -1;
}

static uint32_t le32 (const unsigned char* p)
{
    return (uint32_t) p[0] | (uint32_t) p[1] << 8 | (uint32_t) p[2] << 16 |
           (uint32_t) p[3] << 24;
}

int main (void)
{
    static char* argv[] = {"doom", NULL};
    const unsigned char* wad = __wad_start;
    uint32_t room = (uint32_t) (__wad_end - __wad_start), len;

    stdio_init_all ();
    // the header: "IWAD" or "PWAD", the lump count, the directory's offset.
    // id's IWADs end with their directory, so it gives the file's length.
    if (memcmp (wad, "IWAD", 4) != 0 && memcmp (wad, "PWAD", 4) != 0)
        panic ("no WAD in flash at %p", wad);
    len = le32 (wad + 8) + 16 * le32 (wad + 4);
    if (len > room)
        panic ("the WAD's %u bytes overrun flash (%u after %p)", len, room,
               wad);
    fs_register_wad (PICO_WAD_NAME, (unsigned char*) wad, (int) len);

    myargc = 1;
    myargv = argv;
    D_DoomMain ();
    for (;;)
        D_DoomFrame ();
}
