// tools/baremetal/syscalls.c — newlib syscall stubs for bare-metal ARM.
//
// newlib needs these to link -lc.  We provide:
//   _write   → PL011 UART (fd 1) or ignore
//   _sbrk    → static 512 KiB bump heap for malloc/realloc stragglers
//   _exit    → infinite halt loop
//   _read/_close/_lseek/_fstat/_isatty/_kill/_getpid → errno stubs
//
// DOOM primarily uses the zone allocator (I_ZoneBase static arena) so the
// _sbrk heap is only for rare newlib-internal or sprintf mallocs.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <errno.h>
#include <sys/stat.h>

// ── PL011 UART at 0x09000000 (QEMU virt) ────────────────────────────────────
static volatile unsigned* const UART_DR = (volatile unsigned*)0x09000000u;

// ── _write ───────────────────────────────────────────────────────────────────
int _write(int fd, char* buf, int count)
{
    int i;
    (void)fd;
    for (i = 0; i < count; i++)
        *UART_DR = (unsigned)(unsigned char)buf[i];
    return count;
}

// ── _sbrk — 512 KiB static heap ─────────────────────────────────────────────
// 8-byte aligned so malloc/realloc sub-allocations are properly aligned on ARM.
#define HEAP_SIZE (512 * 1024)
static char   heap_mem[HEAP_SIZE] __attribute__((aligned(8)));
static char*  heap_ptr = heap_mem;

void* _sbrk(int incr)
{
    char* prev = heap_ptr;
    if (heap_ptr + incr > heap_mem + HEAP_SIZE) {
        errno = ENOMEM;
        return (void*)-1;
    }
    heap_ptr += incr;
    return (void*)prev;
}

// ── _exit ────────────────────────────────────────────────────────────────────
void _exit(int status)
{
    (void)status;
    for (;;) {}
}

// ── errno stubs ──────────────────────────────────────────────────────────────
int _read(int fd, char* buf, int count)
{
    (void)fd; (void)buf; (void)count;
    errno = EBADF;
    return -1;
}

int _close(int fd)
{
    (void)fd;
    errno = EBADF;
    return -1;
}

int _lseek(int fd, int offset, int whence)
{
    (void)fd; (void)offset; (void)whence;
    errno = EBADF;
    return -1;
}

int _fstat(int fd, struct stat* st)
{
    (void)fd; (void)st;
    errno = EBADF;
    return -1;
}

int _isatty(int fd)
{
    return (fd == 1) ? 1 : 0;
}

int _kill(int pid, int sig)
{
    (void)pid; (void)sig;
    errno = EINVAL;
    return -1;
}

int _getpid(void)
{
    return 1;
}

int _open(const char* path, int flags, int mode)
{
    (void)path; (void)flags; (void)mode;
    errno = ENOENT;
    return -1;
}

int _stat(const char* path, struct stat* st)
{
    (void)path; (void)st;
    errno = ENOENT;
    return -1;
}

/* d_main.c calls mkdir() to create the savegame directory.
   On bare-metal there is no filesystem; return ENOSYS.
   _mkdir is the newlib internal name; both are needed. */
#include <sys/types.h>
int _mkdir(const char* path, mode_t mode)
{
    (void)path; (void)mode;
    errno = ENOSYS;
    return -1;
}
int mkdir(const char* path, mode_t mode)
{
    return _mkdir(path, mode);
}
