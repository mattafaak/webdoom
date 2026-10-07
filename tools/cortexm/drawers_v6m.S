/* tools/cortexm/drawers_v6m.S — R_DrawColumn and R_DrawSpan for ARMv6-M
 * (Cortex-M0+, Thumb-1), pixel-for-pixel engine/core/r_draw.c's.
 *
 * The Makefile's DRAWERS=1 links these with --wrap=R_DrawColumn and
 * --wrap=R_DrawSpan, so every engine reference (r_main.c's colfunc, basecolfunc
 * and spanfunc) reaches __wrap_R_DrawColumn / __wrap_R_DrawSpan, and the
 * engine's own functions stay linked as __real_R_DrawColumn / __real_R_DrawSpan.
 * engine/core is not edited.  Every case the fast paths below do not take is
 * handed to the engine's function, untouched, which also raises RANGECHECK's
 * I_Error with its own message.
 *
 * R_DrawColumn.  r_draw.c draws n = dc_yh - dc_yl + 1 pixels down a column
 * (the framebuffer is column-major, so +1 byte a pixel) from
 *     frac = dc_texturemid + (dc_yl - centery) * dc_iscale, stepping dc_iscale,
 * pixel = dc_colormap[dc_source[i]] with
 *   power-of-two dc_texheight:  i = (frac >> 16) & (dc_texheight - 1)
 *       For a mask under 2^15 that is bits 16.. of frac whatever its sign, so
 *       a logical shift serves.  For the 128- and 64-texel heights frac is
 *       kept shifted left by 32 - 16 - k (k = 7, 6), where one LSRS #(32 - k)
 *       is the index: the shifted value and its step are the originals times
 *       2^(16-k) mod 2^32, so their sums agree in the bits that are kept.
 *   any other dc_texheight:  frac is first brought into [0, h << 16) and wraps
 *       by one subtraction of h << 16 whenever it reaches it.  Fast here only
 *       when no pixel of this column can wrap: 0 < h < 2^14, 0 <= dc_iscale
 *       < 2^23 and frac + (n - 1) * dc_iscale < h << 16 (no overflow: n <= 200).
 *       Then every frac is the plain sum, non-negative, and i = frac >> 16.
 *       A column that would wrap goes to the engine's loop.
 * Four pixels an iteration: 5.75 instructions a pixel with the loop (6.75 for
 * the other power-of-two heights); r_draw.c compiles to 7.75.
 *
 * R_DrawSpan.  n = ds_x2 - ds_x1 + 1 pixels along a row, +SCREENHEIGHT (200)
 * bytes apart, pixel = ds_colormap[ds_source[((yfrac >> 10) & 4032) |
 * ((xfrac >> 16) & 63)]], both fracs stepping by ds_xstep and ds_ystep.  The
 * two accumulators stay separate (the vanilla packed position is not exact);
 * xfrac is kept shifted left by 10 so that LSRS #26 is its six index bits.
 * 10.5 instructions a pixel with the loop; r_draw.c compiles to about 23, its
 * loop reloading the globals because a byte store may alias them.
 *
 * CM_REDPROOF_COLUMN / CM_REDPROOF_SPAN (red-proof builds only) put one
 * column a row low and one span a column right: the wrong drawers the tests
 * must fail.
 * Copyright (C) 2026, GPL-2.0-or-later.
 */
	.syntax unified
	.cpu cortex-m0plus
	.thumb

/* one column pixel: index from r0 (frac or its shifted form), r1 source,
 * r3 colormap, store at r4 + off, step r6; r7 the mask when mask=1 */
	.macro CPIX shr, off, mask
	lsrs	r5, r0, #\shr
	.if \mask
	ands	r5, r7
	.endif
	ldrb	r5, [r1, r5]
	ldrb	r5, [r3, r5]
	strb	r5, [r4, #\off]
	adds	r0, r0, r6
	.endm

/* the column loop over r2 = n pixels, then return */
	.macro CLOOP shr, mask
	subs	r2, r2, #4
	blt	2f
1:	CPIX	\shr, 0, \mask
	CPIX	\shr, 1, \mask
	CPIX	\shr, 2, \mask
	CPIX	\shr, 3, \mask
	adds	r4, r4, #4
	subs	r2, r2, #4
	bge	1b
2:	adds	r2, r2, #4
	beq	4f
3:	CPIX	\shr, 0, \mask
	adds	r4, r4, #1
	subs	r2, r2, #1
	bne	3b
4:	pop	{r4-r7, pc}
	.endm

	.section .text.__wrap_R_DrawColumn,"ax",%progbits
	.global __wrap_R_DrawColumn
	.type __wrap_R_DrawColumn, %function
	.thumb_func
__wrap_R_DrawColumn:
	ldr	r0, =dc_yl
	ldr	r0, [r0]
	ldr	r1, =dc_yh
	ldr	r1, [r1]
	subs	r2, r1, r0		@ count = dc_yh - dc_yl
	bpl	0f
	bx	lr			@ count < 0: nothing (as r_draw.c, before RANGECHECK)
0:
	ldr	r3, =dc_x
	ldr	r3, [r3]
	cmp	r0, #0			@ RANGECHECK's three conditions: the engine
	blt	.Lc_real		@ raises its I_Error
	cmp	r1, #200
	bge	.Lc_real
	movs	r1, #160
	lsls	r1, r1, #1
	cmp	r3, r1
	bhs	.Lc_real		@ (unsigned) dc_x >= 320
	push	{r4-r7, lr}
	ldr	r4, =ylookup
	lsls	r1, r0, #2
	ldr	r4, [r4, r1]
	ldr	r5, =columnofs
	lsls	r3, r3, #2
	ldr	r5, [r5, r3]
	adds	r4, r4, r5		@ dest = ylookup[dc_yl] + columnofs[dc_x]
#ifdef CM_REDPROOF_COLUMN
	ldr	r5, =dc_x		@ red-proof builds only: the column at
	ldr	r5, [r5]		@ x = 100 drawn one row low
	cmp	r5, #100
	bne	9f
	adds	r4, r4, #1
9:
#endif
	ldr	r5, =centery
	ldr	r5, [r5]
	subs	r0, r0, r5
	ldr	r6, =dc_iscale
	ldr	r6, [r6]		@ step
	muls	r0, r6, r0
	ldr	r5, =dc_texturemid
	ldr	r5, [r5]
	adds	r0, r0, r5		@ frac = dc_texturemid + (dc_yl - centery) * step
	ldr	r1, =dc_source
	ldr	r1, [r1]
	ldr	r3, =dc_colormap
	ldr	r3, [r3]
	adds	r2, r2, #1		@ n
	ldr	r5, =dc_texheight
	ldr	r5, [r5]
	subs	r7, r5, #1		@ mask
	tst	r5, r7
	beq	.Lc_pow2
	lsrs	r7, r5, #14		@ not a power of two:
	bne	.Lc_pop_real		@ h < 0 or h >= 2^14: the engine's
	lsls	r7, r5, #16		@ heightmask
	cmp	r0, #0
	bge	2f
1:	adds	r0, r0, r7		@ while ((frac += heightmask) < 0);
	bmi	1b
	b	3f
2:	cmp	r0, r7			@ while (frac >= heightmask) frac -= heightmask;
	blt	3f
	subs	r0, r0, r7
	b	2b
3:	lsrs	r5, r6, #23
	bne	.Lc_pop_real		@ step < 0 or >= 2^23
	subs	r5, r2, #1
	muls	r5, r6, r5
	adds	r5, r5, r0		@ the last pixel's frac, < 2^32
	cmp	r5, r7
	bhs	.Lc_pop_real		@ a pixel would wrap: the engine's loop
	CLOOP	16, 0
.Lc_pop_real:
	pop	{r4-r7}
	pop	{r0}
	mov	lr, r0
.Lc_real:
	ldr	r0, =__real_R_DrawColumn
	bx	r0
.Lc_pow2:
	cmp	r5, #128
	bne	5f
	lsls	r0, r0, #9
	lsls	r6, r6, #9
	CLOOP	25, 0
5:	cmp	r5, #64
	bne	6f
	lsls	r0, r0, #10
	lsls	r6, r6, #10
	CLOOP	26, 0
6:	lsrs	r5, r7, #15
	beq	7f
	b	.Lc_pop_real		@ h = 0 (mask -1) or h >= 2^16: the engine's
7:	CLOOP	16, 1
	.ltorg
	.size __wrap_R_DrawColumn, . - __wrap_R_DrawColumn

/* one span pixel: r0 X = xfrac << 10, r1 Y = yfrac, r2 dest, r3 source,
 * r4 colormap, r5 = 0xfc0, r8 xstep << 10, r9 ystep */
	.macro SPIX
	lsrs	r6, r1, #10
	ands	r6, r5
	lsrs	r7, r0, #26
	orrs	r6, r7
	ldrb	r6, [r3, r6]
	ldrb	r6, [r4, r6]
	strb	r6, [r2]
	adds	r2, r2, #200
	add	r0, r8
	add	r1, r9
	.endm

	.section .text.__wrap_R_DrawSpan,"ax",%progbits
	.global __wrap_R_DrawSpan
	.type __wrap_R_DrawSpan, %function
	.thumb_func
__wrap_R_DrawSpan:
	ldr	r0, =ds_x1
	ldr	r0, [r0]
	ldr	r1, =ds_x2
	ldr	r1, [r1]
	cmp	r1, r0			@ RANGECHECK's four conditions: the engine
	blt	.Ls_real		@ raises its I_Error
	cmp	r0, #0
	blt	.Ls_real
	movs	r2, #160
	lsls	r2, r2, #1
	cmp	r1, r2
	bge	.Ls_real		@ ds_x2 >= 320
	ldr	r2, =ds_y
	ldr	r2, [r2]
	cmp	r2, #200
	bhi	.Ls_real		@ (unsigned) ds_y > 200
	push	{r4-r7, lr}
	mov	r4, r8
	mov	r5, r9
	mov	r6, r10
	mov	r7, r11
	push	{r4-r7}
	subs	r1, r1, r0
	adds	r1, r1, #1		@ n = ds_x2 - ds_x1 + 1
	ldr	r4, =ylookup
	lsls	r2, r2, #2
	ldr	r4, [r4, r2]
	ldr	r5, =columnofs
	lsls	r0, r0, #2
	ldr	r5, [r5, r0]
	adds	r2, r4, r5		@ dest = ylookup[ds_y] + columnofs[ds_x1]
#ifdef CM_REDPROOF_SPAN
	ldr	r4, =ds_y		@ red-proof builds only: the span on
	ldr	r4, [r4]		@ row 100 drawn one column right
	cmp	r4, #100
	bne	9f
	adds	r2, r2, #200
9:
#endif
	movs	r4, #200
	muls	r4, r1, r4
	adds	r4, r2, r4
	mov	r11, r4			@ the end: dest + n * 200
	lsrs	r5, r1, #2
	movs	r4, #200
	lsls	r4, r4, #2
	muls	r4, r5, r4
	adds	r4, r2, r4
	mov	r10, r4			@ the end of the whole quads
	ldr	r4, =ds_xstep
	ldr	r4, [r4]
	lsls	r4, r4, #10
	mov	r8, r4
	ldr	r4, =ds_ystep
	ldr	r4, [r4]
	mov	r9, r4
	ldr	r0, =ds_xfrac
	ldr	r0, [r0]
	lsls	r0, r0, #10
	ldr	r1, =ds_yfrac
	ldr	r1, [r1]
	ldr	r3, =ds_source
	ldr	r3, [r3]
	ldr	r4, =ds_colormap
	ldr	r4, [r4]
	movs	r5, #63
	lsls	r5, r5, #6		@ 4032
	cmp	r2, r10
	beq	2f
1:	SPIX
	SPIX
	SPIX
	SPIX
	cmp	r2, r10
	bne	1b
2:	cmp	r2, r11
	beq	4f
3:	SPIX
	cmp	r2, r11
	bne	3b
4:	pop	{r4-r7}
	mov	r8, r4
	mov	r9, r5
	mov	r10, r6
	mov	r11, r7
	pop	{r4-r7, pc}
.Ls_real:
	ldr	r0, =__real_R_DrawSpan
	bx	r0
	.ltorg
	.size __wrap_R_DrawSpan, . - __wrap_R_DrawSpan
