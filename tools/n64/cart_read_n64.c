// tools/n64/cart_read_n64.c — word-safe cartridge reads for the N64 port.
//
// The N64 PI bus does not reliably service sub-word (byte/halfword) reads of
// cartridge address space; only 32-bit-aligned word reads return correct data.
// Proven in task 20.4c: the same lump name read byte-wise gave "PLPAPA*" while
// a word read of the identical address gave "PLAYPAL".
//
// engine/core is 0-diff, and it reads the cartridge-resident WAD with plain
// byte copies in two places:
//     w_wad.c:204  strncpy(lump_p->name, fileinfo->name, 8)   // directory
//     w_wad.c:388  memcpy(dest, (byte*) l->handle, l->size)   // lump data
// The 12.4 MB WAD cannot be copied whole into 4 MB RDRAM, so instead of
// changing the engine we intercept these two libc calls via the linker's
// --wrap mechanism (see tools/n64/Makefile). For a cartridge source we
// reconstruct each byte from aligned word reads; for a RAM source we defer to
// the real libc routine, so the common RAM→RAM path is unaffected apart from a
// single range test.
//
// Correctness note: our WAD pointer is KSEG1 (0xB…, uncached), so the aligned
// word reads here need no cache management. is_cart() masks to the physical
// address and matches PI domain 1 (0x10000000–0x1FBFFFFF), covering both KSEG0
// and KSEG1 forms, but we always dereference the caller's original pointer so
// an uncached source stays uncached.
//
// Engine/core: 0-diff. Only tools/n64/ is new.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stddef.h>
#include <stdint.h>

extern void*  __real_memcpy(void* dest, const void* src, size_t n);
extern char*  __real_strncpy(char* dest, const char* src, size_t n);

/* PI cartridge domain 1, physical. */
#define CART_PHYS_LO 0x10000000u
#define CART_PHYS_HI 0x1FBFFFFFu

static int is_cart(const void* p)
{
    uint32_t phys = (uint32_t)(uintptr_t)p & 0x1FFFFFFFu;  /* strip KSEG0/1 */
    return phys >= CART_PHYS_LO && phys <= CART_PHYS_HI;
}

/* Copy n bytes from a cartridge source using ONLY aligned 32-bit reads.
   Bytes are extracted big-endian (byte 0 of a word is its most-significant
   byte on this CPU), which reconstructs the true byte order the PI bus mangles
   on sub-word reads. Handles arbitrary source alignment and length. */
static void cart_read(void* dest, const void* src, size_t n)
{
    uint8_t*  d = (uint8_t*)dest;
    uintptr_t s = (uintptr_t)src;

    while (n) {
        const volatile uint32_t* w = (const volatile uint32_t*)(s & ~(uintptr_t)3);
        uint32_t word = *w;                     /* aligned word read — reliable */
        unsigned lane = (unsigned)(s & 3u);     /* 0..3 within the word */
        unsigned avail = 4u - lane;             /* bytes left in this word */
        unsigned take  = (n < avail) ? (unsigned)n : avail;
        unsigned i;
        for (i = 0; i < take; i++) {
            unsigned shift = 24u - 8u * (lane + i);   /* big-endian byte select */
            *d++ = (uint8_t)(word >> shift);
        }
        s += take;
        n -= take;
    }
}

void* __wrap_memcpy(void* dest, const void* src, size_t n)
{
    if (is_cart(src)) {
        cart_read(dest, src, n);
        return dest;
    }
    return __real_memcpy(dest, src, n);
}

char* __wrap_strncpy(char* dest, const char* src, size_t n)
{
    if (is_cart(src)) {
        /* strncpy semantics: copy up to n bytes, stop after a NUL, then pad
           the remainder with NUL. If no NUL appears within n bytes, exactly n
           bytes are copied and the result is not NUL-terminated. */
        size_t i;
        for (i = 0; i < n; i++) {
            char c;
            cart_read(&c, src + i, 1);
            dest[i] = c;
            if (c == '\0') { i++; break; }
        }
        for (; i < n; i++) dest[i] = '\0';
        return dest;
    }
    return __real_strncpy(dest, src, n);
}
