// tools/cortexm/board.h — the two qemu Cortex-M boards this harness runs on.
//
//   BOARD_AN385  mps2-an385, a Cortex-M3.  The armv6m build runs on it: an M3
//                executes ARMv6-M code unchanged, so its instruction counts are
//                a Cortex-M0+'s.  CCR.UNALIGN_TRP is set at reset, so an
//                unaligned access faults as it would on an M0+.
//   BOARD_AN505  mps2-an505, a Cortex-M33 (ARMv8-M mainline, Secure state).
//                The armv8m build runs on it.
//
// Memory maps, read from qemu 11.1.1's `info mtree` (the CPU's view) and
// checked against the QEMU MPS2 documentation:
//
//                  an385 (M3)                     an505 (M33, Secure aliases)
//   CODE   4 MiB   ssram1   0x00000000            ssram1    0x10000000
//   ZONE   4 MiB   ssram2/3 0x20000000            ssram2+3  0x38000000
//   PSRAM 16 MiB   psram    0x21000000            psram     0x80000000
//   UART0          0x40004000                     0x40200000
//   TIMER0         0x40000000 (CMSDK APB timer)   0x40000000
//   unmapped       0x60000000 (the WAD window)    0x60000000
//
// Instruction counting: qemu runs with -icount shift=0, so one guest
// instruction is exactly 1 ns of virtual time, and the CMSDK timer counts the
// board's SYSCLK in virtual time.  One timer step is therefore 1e9/SYSCLK
// instructions: 40 on the an385 (25 MHz), 50 on the an505 (20 MHz).  The
// selftest (selftest.c) proves the constant on loops of exactly 1e6 and 2e6
// instructions; it is not taken on trust.
// Copyright (C) 2026, GPL-2.0-or-later.
#ifndef CM_BOARD_H
#define CM_BOARD_H

#if defined(BOARD_AN385)
#define CM_BOARD_NAME "mps2-an385"
#define CM_UART0 0x40004000u
#define CM_TIMER0 0x40000000u
#define CM_SYSCLK_HZ 25000000u
#elif defined(BOARD_AN505)
#define CM_BOARD_NAME "mps2-an505"
#define CM_UART0 0x40200000u
#define CM_TIMER0 0x40000000u
#define CM_SYSCLK_HZ 20000000u
#else
#error "define BOARD_AN385 or BOARD_AN505"
#endif

// instructions per timer step under -icount shift=0
#define CM_INSN_PER_TICK (1000000000u / CM_SYSCLK_HZ)

// The WAD is not in the address space: lumps are read on demand through
// semihosting (wad_semi.c).  Its handles point into this window, which no
// device decodes on either board, so a read of WAD bytes that bypasses the
// memcpy hook is a BusFault naming the address, never a silent zero.
#define CM_WAD_WINDOW 0x60000000u

// System control block (both boards; the M3 runs ARMv6-M code but its SCB is
// the v7-M one, which is what reports a fault).
#define CM_SCB_VTOR (*(volatile unsigned*) 0xE000ED08u)
#define CM_SCB_CCR (*(volatile unsigned*) 0xE000ED14u)
#define CM_SCB_SHCSR (*(volatile unsigned*) 0xE000ED24u)
#define CM_SCB_CFSR (*(volatile unsigned*) 0xE000ED28u)
#define CM_SCB_HFSR (*(volatile unsigned*) 0xE000ED2Cu)
#define CM_SCB_MMFAR (*(volatile unsigned*) 0xE000ED34u)
#define CM_SCB_BFAR (*(volatile unsigned*) 0xE000ED38u)
#define CM_SCB_SFSR (*(volatile unsigned*) 0xE000EDE4u) /* v8-M Security */
#define CM_SCB_SFAR (*(volatile unsigned*) 0xE000EDE8u)
#define CM_CCR_UNALIGN_TRP (1u << 3)

void cm_board_init (void);
void cm_uart_putc (int c);
void cm_uart_puts (const char* s);
void cm_uart_hex (unsigned v);
void cm_uart_dec (unsigned v);

// The timer, as a count of steps since cm_board_init (wraps at 2^32 steps,
// 172 s of virtual time on the an385, far beyond any one run's tic).
unsigned cm_ticks (void);
int cm_get_time (void); // 35 Hz tics, for I_GetTime

// Linker-script symbols (sections.ld)
extern unsigned _stack_bottom[], _stack_top[];
#define CM_STACK_PAINT 0xC0DEFACEu
unsigned cm_stack_peak (void); // deepest byte used, from the top
void cm_stack_repaint (void);  // repaint below the caller's frame

#endif
