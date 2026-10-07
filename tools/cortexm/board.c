// tools/cortexm/board.c — UART, timer and fault configuration (board.h).
// Copyright (C) 2026, GPL-2.0-or-later.
#include "board.h"

// CMSDK APB UART
#define UART_DATA (*(volatile unsigned*) (CM_UART0 + 0x00))
#define UART_STATE (*(volatile unsigned*) (CM_UART0 + 0x04))
#define UART_CTRL (*(volatile unsigned*) (CM_UART0 + 0x08))
#define UART_BAUDDIV (*(volatile unsigned*) (CM_UART0 + 0x10))
// CMSDK APB timer: a 32-bit down-counter on SYSCLK
#define TIMER_CTRL (*(volatile unsigned*) (CM_TIMER0 + 0x00))
#define TIMER_VALUE (*(volatile unsigned*) (CM_TIMER0 + 0x04))
#define TIMER_RELOAD (*(volatile unsigned*) (CM_TIMER0 + 0x08))

void cm_board_init (void)
{
#ifdef CM_ARMV6M
    // The armv6m build runs on an M3, which would otherwise service an
    // unaligned LDR/STR/LDRH/STRH in hardware; an M0+ faults on all of them.
    CM_SCB_CCR |= CM_CCR_UNALIGN_TRP;
#endif
    // MemManage, BusFault and UsageFault (and SecureFault on v8-M) get their
    // own vectors instead of escalating, so CFSR names the cause directly.
    CM_SCB_SHCSR |= (1u << 16) | (1u << 17) | (1u << 18)
#ifdef CM_ARMV8M
                    | (1u << 19)
#endif
        ;
    UART_BAUDDIV = 16;
    UART_CTRL = 1; // TX enable, no interrupts
    TIMER_CTRL = 0;
    TIMER_RELOAD = 0xFFFFFFFFu;
    TIMER_VALUE = 0xFFFFFFFFu;
    TIMER_CTRL = 1; // enable; no interrupt, internal clock
}

void cm_uart_putc (int c)
{
    while (UART_STATE & 1u)
    {
    }
    UART_DATA = (unsigned) (unsigned char) c;
}

void cm_uart_puts (const char* s)
{
    while (*s)
        cm_uart_putc ((unsigned char) *s++);
}

void cm_uart_hex (unsigned v)
{
    int i;
    cm_uart_puts ("0x");
    for (i = 28; i >= 0; i -= 4)
    {
        unsigned d = (v >> i) & 0xFu;
        cm_uart_putc ((int) (d < 10 ? '0' + d : 'a' + d - 10));
    }
}

void cm_uart_dec (unsigned v)
{
    char b[12];
    int n = 0;
    do
    {
        // v/10 by reciprocal multiply would also do; this path is never timed
        b[n++] = (char) ('0' + v % 10);
        v /= 10;
    } while (v);
    while (n--)
        cm_uart_putc (b[n]);
}

unsigned cm_ticks (void)
{
    return ~TIMER_VALUE; // counts up from 0 at cm_board_init
}

// I_GetTime (tools/freestanding/i_system.c's FS_GET_TIME): 35 Hz tics from the
// timer, one 32-bit divide.  SYSCLK/35 is not whole (714,285.7 at 25 MHz), so
// this clock runs 35.00002 Hz; nothing a timedemo computes depends on it.
int cm_get_time (void)
{
    return (int) (cm_ticks () / (CM_SYSCLK_HZ / 35u));
}

// The peak stack: crt0.S paints the region with CM_STACK_PAINT at reset; the
// deepest word no longer holding it is the deepest the stack has reached.
// Bytes from the top of the region.  selftest.c `stack` proves it on frames of
// known size.
unsigned cm_stack_peak (void)
{
    const unsigned* p = _stack_bottom;
    while (p < _stack_top && *p == CM_STACK_PAINT)
        p++;
    return (unsigned) ((const char*) _stack_top - (const char*) p);
}

// Repaint everything below the caller's frame, so a later cm_stack_peak
// measures only what ran after this call (the demo loop, not init).
void __attribute__ ((noinline)) cm_stack_repaint (void)
{
    unsigned* sp;
    unsigned* p = _stack_bottom;
    __asm__ volatile ("mov %0, sp" : "=r"(sp));
    sp -= 16; // below this function's own frame
    while (p < sp)
        *p++ = CM_STACK_PAINT;
}
