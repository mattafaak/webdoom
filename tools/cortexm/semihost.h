// tools/cortexm/semihost.h — ARM semihosting (bkpt 0xab), qemu -semihosting.
//
// What the guest asks of the host: its command line, the WAD's bytes, the log
// files it writes, and its exit code.  A semihosting call runs on the host,
// outside the guest: under -icount it adds no instructions beyond the few that
// set the call up (measured by selftest.c, reported as `semihost_call`).
// Copyright (C) 2026, GPL-2.0-or-later.
#ifndef CM_SEMIHOST_H
#define CM_SEMIHOST_H

int sh_open (const char* path,
             int mode); /* mode: 0 "r", 1 "rb", 4 "w", 5 "wb" */
int sh_close (int fd);
int sh_write (int fd, const void* buf,
              unsigned n);                   /* returns bytes NOT written */
int sh_read (int fd, void* buf, unsigned n); /* returns bytes NOT read */
int sh_seek (int fd, unsigned pos);          /* 0 on success */
int sh_flen (int fd);
void sh_write0 (const char* s); /* the debug console (qemu's stderr) */
int sh_cmdline (char* buf, unsigned cap); /* 0 on success */
void sh_exit (int code) __attribute__ ((noreturn));

#endif
