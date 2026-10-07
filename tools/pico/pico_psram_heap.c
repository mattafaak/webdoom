// tools/pico/pico_psram_heap.c — newlib's _sbrk for tools/pico's "psram-heap"
// variants, whose heap is in PSRAM (ld/psram-heap/section_heap.incl).
//
// pico-sdk's own _sbrk (pico_clib_interface/newlib_interface.c) is weak, and
// grows the heap from `end` up to __StackLimit, the end of SRAM: right for a
// heap in SRAM, and no bound at all for one at 0x11xxxxxx, below it.  This one
// grows from `end` to __HeapLimit, which the override sets to the end of the
// heap's reservation (HEAP_KB), and refuses past it as newlib expects (ENOMEM,
// (void*) -1).
//
// The heap is usable once runtime_init_setup_psram (hardware_psram,
// PICO_RUNTIME_INIT_PSRAM) has brought PSRAM up, before main; the engine's
// first malloc is in D_DoomMain.  That nothing in pico-sdk's earlier runtime
// init mallocs is not checked here.
// Copyright (C) 2026, GPL-2.0-or-later.
#include <errno.h>

extern char end, __HeapLimit; // the linker's: ld/psram-heap/section_heap.incl

void* _sbrk (int incr)
{
    static char* brk;
    char* prev;
    if (!brk)
        brk = &end;
    if (incr > &__HeapLimit - brk || incr < &end - brk)
    {
        errno = ENOMEM;
        return (void*) -1;
    }
    prev = brk;
    brk += incr;
    return prev;
}
