// tools/cortexm/semihost.c — see semihost.h.  Operation numbers are the Arm
// semihosting specification's (v2.0).
// Copyright (C) 2026, GPL-2.0-or-later.
#include "semihost.h"

#define SYS_OPEN 0x01
#define SYS_CLOSE 0x02
#define SYS_WRITE0 0x04
#define SYS_WRITE 0x05
#define SYS_READ 0x06
#define SYS_SEEK 0x0A
#define SYS_FLEN 0x0C
#define SYS_GET_CMDLINE 0x15
#define SYS_EXIT 0x18
#define SYS_EXIT_EXTENDED 0x20
#define ADP_Stopped_ApplicationExit 0x20026

static int sh_call (int op, const void* arg)
{
    register int r0 __asm__ ("r0") = op;
    register const void* r1 __asm__ ("r1") = arg;
    __asm__ volatile ("bkpt 0xab" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

static unsigned sh_strlen (const char* s)
{
    unsigned n = 0;
    while (s[n])
        n++;
    return n;
}

int sh_open (const char* path, int mode)
{
    unsigned a[3];
    a[0] = (unsigned) path;
    a[1] = (unsigned) mode;
    a[2] = sh_strlen (path);
    return sh_call (SYS_OPEN, a);
}

int sh_close (int fd)
{
    unsigned a[1];
    a[0] = (unsigned) fd;
    return sh_call (SYS_CLOSE, a);
}

int sh_write (int fd, const void* buf, unsigned n)
{
    unsigned a[3];
    a[0] = (unsigned) fd;
    a[1] = (unsigned) buf;
    a[2] = n;
    return sh_call (SYS_WRITE, a);
}

int sh_read (int fd, void* buf, unsigned n)
{
    unsigned a[3];
    a[0] = (unsigned) fd;
    a[1] = (unsigned) buf;
    a[2] = n;
    return sh_call (SYS_READ, a);
}

int sh_seek (int fd, unsigned pos)
{
    unsigned a[2];
    a[0] = (unsigned) fd;
    a[1] = pos;
    return sh_call (SYS_SEEK, a);
}

int sh_flen (int fd)
{
    unsigned a[1];
    a[0] = (unsigned) fd;
    return sh_call (SYS_FLEN, a);
}

void sh_write0 (const char* s)
{
    sh_call (SYS_WRITE0, s);
}

int sh_cmdline (char* buf, unsigned cap)
{
    unsigned a[2];
    a[0] = (unsigned) buf;
    a[1] = cap;
    if (sh_call (SYS_GET_CMDLINE, a) != 0)
        return -1;
    buf[a[1] < cap ? a[1] : cap - 1] = 0;
    return 0;
}

void sh_exit (int code)
{
    unsigned a[2];
    a[0] = ADP_Stopped_ApplicationExit;
    a[1] = (unsigned) code;
    sh_call (SYS_EXIT_EXTENDED, a);
    // a host without the extended call: the plain one cannot carry a code
    sh_call (SYS_EXIT, (const void*) (code ? 0x20023 /* RunTimeErrorUnknown */
                                           : ADP_Stopped_ApplicationExit));
    for (;;)
    {
    }
}
