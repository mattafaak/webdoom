// tools/cortexm/syscalls.c — what newlib asks of the platform.
//
// Lineage: tools/baremetal/syscalls.c (deleted in 6609b57).  The libc surface
// the core uses (tools/freestanding/IMPORTS.md) comes from full newlib, the
// arm-none-eabi multilib for each -mcpu; these are its system calls:
//
//   _write    fd 1 and 2 to UART0 (the engine's startup prints, I_Error)
//   _sbrk     the heap region in PSRAM (sections.ld): lumpinfo's realloc,
//             lumpcache, newlib's own buffers.  The zone is not on it.
//   _exit     semihosting exit with the code, so qemu's status is the run's
//   _kill     abort() -> raise(SIGABRT) lands here: exit 128+sig
//   clock_gettime / _gettimeofday
//             the board timer (I_GetTime; the demo never depends on it)
//   sysconf   a page of 8 bytes, not libc's 4096, for malloc (see there)
//   the rest  "no such file": a timedemo reads no config and writes no save
// Copyright (C) 2026, GPL-2.0-or-later.
#include <errno.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "board.h"
#include "semihost.h"

extern char _heap_start[], _heap_end[];

int _write (int fd, const char* buf, int n)
{
    int i;
    if (fd != 1 && fd != 2)
    {
        errno = EBADF;
        return -1;
    }
    for (i = 0; i < n; i++)
        cm_uart_putc ((unsigned char) buf[i]);
    return n;
}

static char* brk = _heap_start;
static char* brk_peak = _heap_start;

void* _sbrk (ptrdiff_t incr)
{
    char* prev = brk;
    if (incr > _heap_end - brk || incr < _heap_start - brk)
    {
        errno = ENOMEM;
        return (void*) -1;
    }
    brk += incr;
    if (brk > brk_peak)
        brk_peak = brk;
    return prev;
}

// the most of the heap ever handed out, for the stats file (RAM accounting):
// what newlib's malloc took from _sbrk, its chunk headers and 8-byte
// alignment included, and no page rounding (sysconf below), so the figure
// does not move with where the heap starts
unsigned cm_heap_peak (void)
{
    return (unsigned) (brk_peak - _heap_start);
}

// newlib's malloc (the full one, mallocr.c) asks sysconf(_SC_PAGESIZE) for a
// page: it grows the heap through _sbrk by whole pages, each extension the
// whole request whatever the top chunk already holds, and keeps the break on
// a page boundary in absolute address.  With libc's 4096 the high-water above
// carried pages nothing used, and depended on where the heap starts (in the
// zero-copy builds, after .text: sections.ld): 2 KiB more code moved it by
// about 2 KiB with nothing allocated differently.  A board has no pages; with
// 8, malloc's own alignment, the break moves in 8-byte steps and the figure
// is what the allocator took, wherever the heap starts.  Defined here, this
// replaces libc's (mallocr.o and freer.o leave sysconf undefined); every
// other name is EINVAL, as libc's.
long sysconf (int name)
{
    if (name == _SC_PAGESIZE)
        return 8;
    errno = EINVAL;
    return -1;
}

void _exit (int code)
{
    sh_exit (code);
}

int _kill (int pid, int sig)
{
    (void) pid;
    cm_uart_puts ("\nKILLED by signal ");
    cm_uart_dec ((unsigned) sig);
    cm_uart_puts ("\n");
    sh_exit (128 + sig);
}

int _getpid (void)
{
    return 1;
}

int _read (int fd, char* buf, int n)
{
    (void) fd;
    (void) buf;
    (void) n;
    return 0;
}

int _close (int fd)
{
    (void) fd;
    errno = EBADF;
    return -1;
}

int _lseek (int fd, int off, int whence)
{
    (void) fd;
    (void) off;
    (void) whence;
    errno = ESPIPE;
    return -1;
}

int _fstat (int fd, struct stat* st)
{
    if (fd < 0 || fd > 2)
    {
        errno = EBADF;
        return -1;
    }
    st->st_mode = S_IFCHR;
    return 0;
}

int _isatty (int fd)
{
    return fd >= 0 && fd <= 2;
}

int _open (const char* path, int flags, int mode)
{
    (void) path;
    (void) flags;
    (void) mode;
    errno = ENOENT;
    return -1;
}

int _stat (const char* path, struct stat* st)
{
    (void) path;
    (void) st;
    errno = ENOENT;
    return -1;
}

int _unlink (const char* path)
{
    (void) path;
    errno = ENOENT;
    return -1;
}

int _link (const char* a, const char* b)
{
    (void) a;
    (void) b;
    errno = EMLINK;
    return -1;
}

// d_main.c creates the savegame directory; m_misc.c's screenshot path probes
int mkdir (const char* path, mode_t mode)
{
    (void) path;
    (void) mode;
    errno = ENOSYS;
    return -1;
}

int access (const char* path, int mode)
{
    (void) path;
    (void) mode;
    errno = ENOENT;
    return -1;
}

// The board timer as time: CM_SYSCLK_HZ steps per second.  32-bit arithmetic
// only, so the v6-M build calls no 64-bit helper for it.
int clock_gettime (clockid_t id, struct timespec* ts)
{
    unsigned t = cm_ticks ();
    (void) id;
    ts->tv_sec = (time_t) (t / CM_SYSCLK_HZ);
    ts->tv_nsec = (long) ((t % CM_SYSCLK_HZ) * CM_INSN_PER_TICK);
    return 0;
}

int _gettimeofday (struct timeval* tv, void* tz)
{
    unsigned t = cm_ticks ();
    (void) tz;
    tv->tv_sec = (time_t) (t / CM_SYSCLK_HZ);
    tv->tv_usec =
        (suseconds_t) ((t % CM_SYSCLK_HZ) / (CM_SYSCLK_HZ / 1000000u));
    return 0;
}
