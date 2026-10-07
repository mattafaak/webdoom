// tools/n64/cart_read_n64.c — cartridge reads for the N64 port.
//
// The N64 PI bus does not reliably service sub-word (byte/halfword) reads of
// cartridge address space; only 32-bit-aligned word reads return correct data.
// Measured: the same lump name read byte-wise gave "PLPAPA*" while
// a word read of the identical address gave "PLAYPAL".
//
// engine/core has no N64-specific changes, and it reads the cartridge-resident WAD with plain
// byte copies in two places:
//     w_wad.c:204  strncpy(lump_p->name, fileinfo->name, 8)   // directory
//     w_wad.c:388  memcpy(dest, (byte*) l->handle, l->size)   // lump data
// The 12.4 MB WAD cannot be copied whole into 4 MB RDRAM, so instead of
// changing the engine we intercept these two libc calls via the linker's
// --wrap mechanism (see tools/n64/Makefile). For a cartridge source we
// copy from cartridge space; for a RAM source we defer to the real libc
// routine, so the common RAM→RAM path is unaffected apart from a single range
// test.
//
// Two ways out of cartridge space:
//
//   word path (cart_read): every byte rebuilt from aligned uncached 32-bit
//   reads, one PI bus transaction per word.  Always used for strncpy (eight
//   bytes of directory name), for short copies and for a copy's unaligned
//   edges.
//
//   PI DMA (cart_dma, N64_CART_DMA=1, the default): the bulk of a lump moves
//   by PI DMA straight into RDRAM.  The DMA engine needs RDRAM 8-byte aligned,
//   ROM 2-byte aligned and an even length, so the head up to the next 8-byte
//   RDRAM boundary and an odd last byte go by the word path.  When the source
//   and destination differ in parity no such split exists, and the lump is
//   DMAed into an aligned bounce buffer and copied from there.
//
//   DMA writes RDRAM behind the data cache, so every line of the destination
//   is written back (the edges hold the caller's neighbouring bytes and the
//   head/tail bytes just copied) and invalidated (a stale clean line would hide
//   the new data) BEFORE the transfer starts, and the CPU touches none of it
//   until dma_wait() returns.  libdragon's dma_read() is not used: for
//   misaligned edges it falls back to 8- and 16-bit PI reads, the exact reads
//   this bus corrupts.
//
// n64_cart_bytes counts every byte memcpy takes out of cartridge space: the
// floor log's M:<bytes> flag, the WAD traffic of a zone cache miss.
//
// Our WAD pointer is KSEG1 (0xB…, uncached), so the word reads need no cache
// management. is_cart() masks to the physical address and matches PI domain 1
// (0x10000000–0x1FBFFFFF), covering both KSEG0 and KSEG1 forms, but the word
// path always dereferences the caller's original pointer so an uncached source
// stays uncached.
//
// engine/core has no N64-specific changes; the port is tools/n64/.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include <stddef.h>
#include <stdint.h>

#include <dma.h>      /* dma_read_raw_async, dma_wait */
#include <n64sys.h>   /* data_cache_hit_writeback_invalidate, data_cache_hit_invalidate */

#ifndef N64_CART_DMA
#define N64_CART_DMA 1
#endif

extern void*  __real_memcpy(void* dest, const void* src, size_t n);
extern char*  __real_strncpy(char* dest, const char* src, size_t n);

volatile unsigned n64_cart_bytes;

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

#if N64_CART_DMA
/* Below this many bytes the word path is used whole: a DMA costs a cache
   sweep, four PI register writes and a poll, which a handful of word reads
   beats.  Lumps are mostly kilobytes, so the value barely matters. */
#define CART_DMA_MIN    64u
/* Bounce buffer for parity-mismatched copies.  The CPU only ever reads it, so
   none of its lines is ever dirty and an invalidate alone is enough. */
#define CART_BOUNCE     4096u
static uint8_t cart_bounce[CART_BOUNCE + 16] __attribute__((aligned(16)));
/* The PI bus address of a cartridge pointer: its physical address (KSEG0/1
   stripped), 0x10000000 + offset for domain 1. */
#define CART_PI_ADDR(a) ((unsigned long)(a) & 0x1FFFFFFFu)

static void cart_dma(void* dest, const void* src, size_t n)
{
    uint8_t*  d = (uint8_t*)dest;
    uintptr_t s = (uintptr_t)src;
    size_t    head = (size_t)((8u - ((uintptr_t)d & 7u)) & 7u);

    if (((s + head) & 1u) == 0) {
        /* RDRAM d+head is 8-aligned and ROM s+head is even: DMA the middle. */
        size_t mid  = (n - head) & ~(size_t)1;
        size_t tail = n - head - mid;                 /* 0 or 1 */
        if (head)
            cart_read(d, (const void*)s, head);
        if (tail)
            cart_read(d + head + mid, (const void*)(s + head + mid), tail);
        data_cache_hit_writeback_invalidate(d, n);
        dma_read_raw_async(d + head, CART_PI_ADDR(s + head), mid);
        dma_wait();
        return;
    }
    /* Parities differ: DMA from the even address at or below s into the
       (8-aligned) bounce buffer, then copy out from the source's offset. */
    while (n) {
        size_t    chunk = n < CART_BOUNCE ? n : CART_BOUNCE;
        size_t    off   = (size_t)(s & 1u);
        uintptr_t s0    = s - off;
        size_t    len   = (chunk + off + 1u) & ~(size_t)1; /* even, covers s..s+chunk */
        data_cache_hit_invalidate(cart_bounce, (len + 15u) & ~(size_t)15);
        dma_read_raw_async(cart_bounce, CART_PI_ADDR(s0), len);
        dma_wait();
        __real_memcpy(d, cart_bounce + off, chunk);
        d += chunk;
        s += chunk;
        n -= chunk;
    }
}
#endif

#ifdef N64_XPROF
/* The two paths by name, for the XPROF build's copy benchmark (n64_floor.c). */
void n64_cart_copy_words(void* dest, const void* src, size_t n) { cart_read(dest, src, n); }
#if N64_CART_DMA
void n64_cart_copy_dma(void* dest, const void* src, size_t n)   { cart_dma(dest, src, n); }
#endif
#endif

void* __wrap_memcpy(void* dest, const void* src, size_t n)
{
    if (is_cart(src)) {
        n64_cart_bytes += (unsigned)n;
#if N64_CART_DMA
        if (n >= CART_DMA_MIN) {
            cart_dma(dest, src, n);
            return dest;
        }
#endif
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
