# fs-doom IMPORTS.md — freestanding rung-1 libc surface

The symbol list below is `nm -u fs-doom | sort` from the built binary; the
dispositions after it are written by hand.  `make imports`
(`gen-imports.sh`) checks the list against the binary and fails, naming
each symbol, when they differ: update this file then.  These are the
symbols that rung-2 (bare-metal) must either eliminate, provide from a
freestanding runtime, or implement as platform primitives.  Last checked
2026-10-08.

**Command used**: `nm -u fs-doom | sort`

## Dynamic libraries linked

```
	linux-gate.so.1 (0xf7f27000)
	libm.so.6 => /usr/lib32/libm.so.6 (0xf7da6000)
	libgcc_s.so.1 => /usr/lib32/libgcc_s.so.1 (0xf7d65000)
	libc.so.6 => /usr/lib32/libc.so.6 (0xf7ac6000)
	/lib/ld-linux.so.2 => /usr/lib/ld-linux.so.2 (0xf7f2a000)
```

## Undefined symbols (nm -u fs-doom | sort)

```
         U abort@GLIBC_2.0
         U access@GLIBC_2.0
         U atan@GLIBC_2.0
         U calloc@GLIBC_2.0
         U clock_gettime@GLIBC_2.17
         U close@GLIBC_2.0
         U __ctype_toupper_loc@GLIBC_2.3
         U __errno_location@GLIBC_2.0
         U _exit@GLIBC_2.0
         U exit@GLIBC_2.0
         U fclose@GLIBC_2.1
         U fopen@GLIBC_2.1
         U fprintf@GLIBC_2.0
         U fputc@GLIBC_2.0
         U fread@GLIBC_2.0
         U free@GLIBC_2.0
         U fstat@GLIBC_2.33
         U fwrite@GLIBC_2.0
         U getenv@GLIBC_2.0
         U ioctl@GLIBC_2.0
         U __isoc99_sscanf@GLIBC_2.7
         U __libc_start_main@GLIBC_2.34
         U log10@GLIBC_2.0
         U longjmp@GLIBC_2.0
         U lseek@GLIBC_2.0
         U malloc@GLIBC_2.0
         U memcpy@GLIBC_2.0
         U memset@GLIBC_2.0
         U mkdir@GLIBC_2.0
         U mmap@GLIBC_2.0
         U mprotect@GLIBC_2.0
         U munmap@GLIBC_2.0
         U open@GLIBC_2.0
         U printf@GLIBC_2.0
         U putchar@GLIBC_2.0
         U puts@GLIBC_2.0
         U qsort@GLIBC_2.0
         U read@GLIBC_2.0
         U realloc@GLIBC_2.0
         U setbuf@GLIBC_2.0
         U _setjmp@GLIBC_2.0
         U setvbuf@GLIBC_2.0
         U sigaction@GLIBC_2.0
         U sin@GLIBC_2.0
         U sprintf@GLIBC_2.0
         U __stack_chk_fail@GLIBC_2.4
         U stderr@GLIBC_2.0
         U stdout@GLIBC_2.0
         U strcasecmp@GLIBC_2.0
         U strchr@GLIBC_2.0
         U strcmp@GLIBC_2.0
         U strcpy@GLIBC_2.0
         U strlen@GLIBC_2.0
         U strncasecmp@GLIBC_2.0
         U strncmp@GLIBC_2.0
         U strncpy@GLIBC_2.0
         U strrchr@GLIBC_2.0
         U strtol@GLIBC_2.0
         U syscall@GLIBC_2.0
         U tan@GLIBC_2.0
         U vsnprintf@GLIBC_2.0
         U write@GLIBC_2.0
         w __gmon_start__
         w _ITM_deregisterTMCloneTable
         w _ITM_registerTMCloneTable
```

## Symbol justifications

Total: 65 symbols (62 strong `U`, 3 weak `w`).

### (a) SHIM — main() WAD load, removed in rung 2

These cross the "shim line" in `i_main.c:main()` only.  In rung 2 the WAD is
delivered as a ROM constant or linker symbol; these disappear entirely.

| Symbol | Source | Rung-2 action |
|--------|--------|---------------|
| `open` | `i_main.c:load_wad()` | Remove: WAD → linker symbol or embedded blob |
| `read` | `i_main.c:load_wad()` | Remove: same |
| `close` | `i_main.c:load_wad()` | Remove: same |
| `lseek` | `i_main.c:load_wad()` | Remove: same |
| `malloc` | `i_main.c:load_wad()` — WAD buffer | Remove: static WAD array or XIP flash pointer |
| `free` | `i_main.c` — not actually called; pulled in by libc startup | Remove: unused once malloc gone |

### (b) SHIM — optional -sim file output, removed in rung 2

`fopen/fclose/fwrite/fputc` are only used in `i_main.c:main()` when `-sim <file>`
is requested.  The primary JSON output already goes via `fs_putc` (the
byte-out).  These symbols vanish once the `-sim` flag is dropped.

| Symbol | Source | Rung-2 action |
|--------|--------|---------------|
| `fopen` | `i_main.c` `-sim` write | Remove: drop `-sim` path |
| `fclose` | same | Remove |
| `fwrite` | same + `m_misc.c` config saves | Remove: saves no-op in headless |
| `fputc` | same | Remove |
| `fread` | `m_misc.c` config read (Web_FileCopy stub ignores it) | Remove: config no-op |
| `fstat` | `m_misc.c` file checks | Remove: same |

### (c) STRAGGLER — stdio from core (m_misc.c, d_main.c)

These come from `engine/core` code that the platform layer does not own.
They are honest surface calls into libc that rung 2 must provide or stub.

| Symbol | Source | Rung-2 action |
|--------|--------|---------------|
| `fprintf` | `i_system.c:I_Error` stderr summary + `m_misc.c` | Route through fs_putc / UART |
| `printf` | `m_argv.c` debug path | Route through fs_putc / UART |
| `putchar` | `m_argv.c` help output | Route through fs_putc / UART |
| `puts` | `m_argv.c` help output | Route through fs_putc / UART |
| `setbuf` | `d_main.c` stdout buffering | No-op on freestanding |
| `sprintf` | `i_sound.c:I_GetSfxLumpNum` + core | Provide from newlib/musl |
| `vsnprintf` | `i_system.c:I_Error` | Provide from newlib/musl |
| `__isoc99_sscanf` | `i_system.c:I_Error` demo-end detection | Provide from newlib/musl |

### (d) STRAGGLER — heap from core (m_misc.c, p_*.c)

Heap calls from `engine/core` that the platform layer cannot eliminate directly.
These are the "vanilla has a few mallocs in i_/d_ layers" the brief mentioned.
These appear in `m_misc.c` (config parsing) and possibly `p_saveg.c`.

| Symbol | Source | Rung-2 action |
|--------|--------|---------------|
| `realloc` | `m_misc.c` config-file token parser | Stub: return NULL (config not needed for headless) OR replace with zone alloc |
| `access` | `m_misc.c` file-existence check | Stub: always return -1 (file not found) |
| `mkdir` | `m_misc.c` savegame directory creation | No-op stub |

### (e) Platform primitives — must survive into rung 2 (replaced, not eliminated)

| Symbol | Source | Rung-2 action |
|--------|--------|---------------|
| `write` | `i_system.c:fs_putc` (the byte-out) | Replace with UART/SWO write |
| `clock_gettime` | `i_system.c:I_GetTime`, `d_net.c` | Replace with hardware 35 Hz timer counter |
| `_setjmp` / `longjmp` | `i_main.c` timedemo exit | Replace with flag-and-poll pattern in main loop |
| `abort` | `i_system.c:I_Error` fatal path | Replace with spin-loop or hardware reset |
| `exit` | `i_system.c:I_Quit` | Replace with hardware reset or power-off |
| `__stack_chk_fail` | compiler-generated stack guard | Provide from libgcc / compiler-rt, or disable `-fno-stack-protector` |

### (f) String / memory (newlib or hand-rolled in rung 2)

| Symbol | Source |
|--------|--------|
| `memcpy`, `memset` | core renderer, zone, wad loading |
| `strcpy`, `strncpy`, `strcmp`, `strncmp`, `strcasecmp`, `strncasecmp` | core throughout |
| `strlen`, `strchr`, `strrchr`, `strtol` | core throughout |

All standard; provide from newlib, musl, or compiler built-ins on bare-metal.

### (g) Math (libm)

| Symbol | Source | Rung-2 action |
|--------|--------|---------------|
| `sin` | `tables.c:T_GenerateTables()` trig table boot-generation (`R_InitTables` in r_main.c is an `#if 0` shell — see coverage NEGATIVE-SPACE.md) | Provide libm OR pre-generate and ship as const (bare-metal.md §4.1) |
| `tan` | same | same |
| `atan` | same | same |
| `log10` | `engine/web/mus_opl.c` (through `fs_mus.c`): the OPL volume curve, `-40·log10(v/127)` | Provide libm, or tabulate its 128 values; needed only with music |

`sin`, `tan` and `atan` are called ONCE at startup to fill the trig tables
(14,336 entries). In ROM-tight rung 3+, ship pre-generated tables instead
(`TABLES_CONST`, `bare-metal.md §4.1`).

### (i) The measuring harness — fs-doom's instruments, not the port

`i_main.c`'s counters and checks and `heap_wrap.c`'s heap peak, which a port
does not carry:

| Symbol | Source |
|--------|--------|
| `syscall`, `ioctl` | `perf_event_open` and its counter controls (`WD_CYCLES`) |
| `getenv` | the `WD_*` knobs (`i_main.c`, `i_system.c`, `fs_audio.c`) |
| `mmap`, `mprotect`, `munmap` | the read-only WAD blob (`WD_RO_WAD`, the `ro-wad` legs) |
| `sigaction`, `_exit` | the fault reporter that names a write into the WAD |
| `qsort` | per-tic statistics (p50, p99) |
| `setvbuf` | unbuffered output for the logs |
| `__errno_location` | `errno` after those calls |
| `calloc` | `heap_wrap.c`'s `--wrap` heap-peak counter |

### (h) Libc / dynamic linker infrastructure

| Symbol | Note |
|--------|------|
| `__libc_start_main` | C runtime entry; replaced by bare-metal crt0 |
| `__ctype_toupper_loc` | toupper() in `m_misc.c` config token; provide from newlib |
| `__gmon_start__` (weak) | gprof profiling hook; absent in release builds |
| `_ITM_*` (weak) | Intel TM library hook; not used |

## Rung-2 elimination summary

| Category | Count | Action |
|----------|-------|--------|
| Shim (WAD load) | open, read, close, lseek, malloc, free | 6 → eliminated |
| Shim (-sim output) | fopen, fclose, fwrite, fputc, fread, fstat | 6 → eliminated |
| Platform primitives | write, clock_gettime, setjmp, longjmp, abort, exit | 6 → replaced |
| Core stdio stragglers | fprintf, printf, putchar, puts, setbuf, sprintf, vsnprintf, sscanf | 8 → route through fs_putc / newlib |
| Core heap stragglers | realloc, access, mkdir | 3 → stub or zone-backed |
| String/memory | memcpy, memset, str* (10) | 12 → newlib / compiler built-ins |
| Math | sin, tan, atan (one-shot boot), log10 (music volume) | 4 → libm or pre-generated tables |
| Measuring harness | syscall, ioctl, getenv, mmap, mprotect, munmap, sigaction, _exit, qsort, setvbuf, __errno_location, calloc | 12 → not part of a port |
| Infra (weak/linker) | __libc_start_main, __ctype_toupper_loc, __gmon_start__, _ITM_* | 6 → crt0 / newlib |

---
*Check the list against the binary with: `make -C tools/freestanding imports`*
