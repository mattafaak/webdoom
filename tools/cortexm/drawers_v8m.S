/* tools/cortexm/drawers_v8m.S — R_DrawColumn and R_DrawSpan for ARMv8-M
 * mainline (Cortex-M33, Thumb-2), pixel-for-pixel engine/core/r_draw.c's.
 *
 * Linked as drawers_v6m.S is (--wrap; every case not taken here goes to the
 * engine's own function, which also raises RANGECHECK's I_Error), and the
 * arithmetic is the same; see that file for why each index is exact.  Thumb-2
 * adds what makes the pixels cheaper: an AND or ORR with a shifted operand
 * (one instruction for "(frac >> 16) & mask", "(yfrac >> 10) & 4032", and for
 * or-ing in "xfrac's bits 16..21" from xfrac << 10), STRB with offsets up to
 * 4095 (four span pixels, 200 bytes apart, per pointer step), IT blocks for
 * the non-power-of-two wrap.
 *   column: 5.75 instructions a pixel with the loop, for every height (gcc's
 *           loop for r_draw.c is the same: the gain is the call's setup and
 *           the non-power-of-two columns).  A column whose frac would wrap
 *           takes the engine's loop only if its step is negative or 2^23 or
 *           more, else an eight-instruction loop here that wraps as r_draw.c
 *           does (h < 2^14 and step < 2^23 keep every frac in [0, 2^31): no
 *           overflow, and the logical shift is the arithmetic one).
 *   span:   7.75 instructions a pixel with the loop; r_draw.c compiles to
 *           about 12.5.
 *
 * CM_REDPROOF_COLUMN / CM_REDPROOF_SPAN: as in drawers_v6m.S.
 * Copyright (C) 2026, GPL-2.0-or-later.
 */
	.syntax unified
	.cpu cortex-m33
	.thumb

/* one column pixel: r0 frac, r1 source, r3 colormap, r4 dest, r6 step,
 * r7 mask (mask=1) */
	.macro CPIX off, mask
	.if \mask
	and	r5, r7, r0, lsr #16
	.else
	lsr	r5, r0, #16
	.endif
	ldrb	r5, [r1, r5]
	ldrb	r5, [r3, r5]
	strb	r5, [r4, #\off]
	add	r0, r0, r6
	.endm

	.macro CLOOP mask
	subs	r2, r2, #4
	blt	2f
1:	CPIX	0, \mask
	CPIX	1, \mask
	CPIX	2, \mask
	CPIX	3, \mask
	adds	r4, r4, #4
	subs	r2, r2, #4
	bge	1b
2:	adds	r2, r2, #4
	beq	4f
3:	CPIX	0, \mask
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
	it	mi
	bxmi	lr			@ count < 0: nothing (as r_draw.c, before RANGECHECK)
	ldr	r3, =dc_x
	ldr	r3, [r3]
	cmp	r0, #0			@ RANGECHECK's three conditions: the engine
	blt	.Lc_real		@ raises its I_Error
	cmp	r1, #200
	bge	.Lc_real
	cmp	r3, #320
	bhs	.Lc_real
	push	{r4-r7, lr}
	ldr	r4, =ylookup
	ldr	r4, [r4, r0, lsl #2]
	ldr	r5, =columnofs
	ldr	r5, [r5, r3, lsl #2]
	add	r4, r4, r5		@ dest
#ifdef CM_REDPROOF_COLUMN
	ldr	r5, =dc_x		@ red-proof builds only: the column at
	ldr	r5, [r5]		@ x = 100 drawn one row low
	cmp	r5, #100
	it	eq
	addeq	r4, r4, #1
#endif
	ldr	r5, =centery
	ldr	r5, [r5]
	sub	r0, r0, r5
	ldr	r6, =dc_iscale
	ldr	r6, [r6]		@ step
	ldr	r5, =dc_texturemid
	ldr	r5, [r5]
	mla	r0, r0, r6, r5		@ frac = (dc_yl - centery) * step + dc_texturemid
	ldr	r1, =dc_source
	ldr	r1, [r1]
	ldr	r3, =dc_colormap
	ldr	r3, [r3]
	adds	r2, r2, #1		@ n
	ldr	r5, =dc_texheight
	ldr	r5, [r5]
	subs	r7, r5, #1		@ mask
	tst	r5, r7
	bne	.Lc_npow2
	lsrs	r5, r7, #15
	bne	.Lc_pop_real		@ h = 0 (mask -1) or h >= 2^16: the engine's
	CLOOP	1
.Lc_npow2:
	lsrs	r7, r5, #14
	bne	.Lc_pop_real		@ h < 0 or h >= 2^14
	lsls	r7, r5, #16		@ heightmask
	cmp	r0, #0
	bge	2f
1:	adds	r0, r0, r7		@ while ((frac += heightmask) < 0);
	bmi	1b
	b	3f
2:	cmp	r0, r7			@ while (frac >= heightmask) frac -= heightmask;
	itt	ge
	subge	r0, r0, r7
	bge	2b
3:	lsrs	r5, r6, #23
	bne	.Lc_pop_real		@ step < 0 or >= 2^23
	sub	r5, r2, #1
	mla	r5, r5, r6, r0		@ the last pixel's frac, < 2^32
	cmp	r5, r7
	bhs	.Lc_wrap		@ a pixel wraps
	CLOOP	0
.Lc_wrap:				@ r_draw.c's loop: frac in [0, hm), step >= 0
	lsr	r5, r0, #16
	ldrb	r5, [r1, r5]
	ldrb	r5, [r3, r5]
	strb	r5, [r4], #1
	add	r0, r0, r6
	cmp	r0, r7
	it	ge
	subge	r0, r0, r7
	subs	r2, r2, #1
	bne	.Lc_wrap
	pop	{r4-r7, pc}
.Lc_pop_real:
	pop	{r4-r7, lr}
.Lc_real:
	b.w	__real_R_DrawColumn
	.ltorg
	.size __wrap_R_DrawColumn, . - __wrap_R_DrawColumn

/* one span pixel: r0 X = xfrac << 10, r1 Y = yfrac, r2 dest, r3 source,
 * r4 colormap, r5 = 4032, r8 xstep << 10, r9 ystep */
	.macro SPIX off
	and	r6, r5, r1, lsr #10
	orr	r6, r6, r0, lsr #26
	ldrb	r6, [r3, r6]
	ldrb	r6, [r4, r6]
	strb	r6, [r2, #\off]
	add	r0, r0, r8
	add	r1, r1, r9
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
	cmp	r1, #320
	bge	.Ls_real
	ldr	r2, =ds_y
	ldr	r2, [r2]
	cmp	r2, #200
	bhi	.Ls_real		@ (unsigned) ds_y > 200
	push	{r4-r9, lr}
	sub	r7, r1, r0
	add	r7, r7, #1		@ n = ds_x2 - ds_x1 + 1
	ldr	r4, =ylookup
	ldr	r2, [r4, r2, lsl #2]
	ldr	r4, =columnofs
	ldr	r4, [r4, r0, lsl #2]
	add	r2, r2, r4		@ dest
#ifdef CM_REDPROOF_SPAN
	ldr	r4, =ds_y		@ red-proof builds only: the span on
	ldr	r4, [r4]		@ row 100 drawn one column right
	cmp	r4, #100
	it	eq
	addeq	r2, r2, #200
#endif
	ldr	r4, =ds_xstep
	ldr	r4, [r4]
	lsl	r8, r4, #10
	ldr	r4, =ds_ystep
	ldr	r9, [r4]
	ldr	r0, =ds_xfrac
	ldr	r0, [r0]
	lsl	r0, r0, #10
	ldr	r1, =ds_yfrac
	ldr	r1, [r1]
	ldr	r3, =ds_source
	ldr	r3, [r3]
	ldr	r4, =ds_colormap
	ldr	r4, [r4]
	mov	r5, #4032
	subs	r7, r7, #4
	blt	2f
1:	SPIX	0
	SPIX	200
	SPIX	400
	SPIX	600
	add	r2, r2, #800
	subs	r7, r7, #4
	bge	1b
2:	adds	r7, r7, #4
	beq	4f
3:	SPIX	0
	add	r2, r2, #200
	subs	r7, r7, #1
	bne	3b
4:	pop	{r4-r9, pc}
.Ls_real:
	b.w	__real_R_DrawSpan
	.ltorg
	.size __wrap_R_DrawSpan, . - __wrap_R_DrawSpan
