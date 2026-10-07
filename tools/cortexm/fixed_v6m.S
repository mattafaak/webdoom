/* tools/cortexm/fixed_v6m.S — the divide under cm_fixed.h's FixedDiv, for
 * ARMv6-M (Thumb-1: no divide instruction, no conditional execution).
 *
 *   unsigned cm_udiv30 (unsigned n, unsigned d)
 *       returns floor(n * 2^16 / d), given d < 2^31 and n >> 14 < d (so the
 *       quotient has at most 30 bits; cm_fixed.h shows FixedDiv's clamp
 *       guarantees both).
 *
 * Restoring division, one quotient bit a step, over bits 29..0 of the 47-bit
 * dividend n * 2^16; bits 46..30 of it are n >> 14, already less than d, so
 * they would give zero quotient bits and are the starting remainder.  The
 * invariant r < d holds before every step, so 2r + 1 < 2d < 2^32 never
 * carries out.  A step: shift the next dividend bit into r (bits 13..0 of n,
 * then sixteen zeros), compare, subtract if r >= d; the compare's carry
 * (set iff r >= d, and left set by the subtraction) is the quotient bit,
 * shifted into q by ADCS.
 * 4.5 to 6 instructions a step, ~154 a call; libgcc's __aeabi_ldivmod is
 * ~380 plus a 64-bit multiply for the remainder FixedDiv throws away.
 * Copyright (C) 2026, GPL-2.0-or-later.
 */
	.syntax unified
	.cpu cortex-m0plus
	.thumb

	.section .text.cm_udiv30,"ax",%progbits
	.global cm_udiv30
	.type cm_udiv30, %function
	.thumb_func
cm_udiv30:
	lsrs	r2, r0, #14		@ r = n >> 14 (< d)
	lsls	r0, r0, #18		@ n's bits 13..0, from bit 31 down
	movs	r3, #0			@ q
	.rept	14
	lsls	r0, r0, #1		@ C = the next bit of n
	adcs	r2, r2			@ r = 2r + C
	cmp	r2, r1
	bcc	1f
	subs	r2, r2, r1		@ (leaves C set)
1:	adcs	r3, r3			@ q = 2q + (r >= d)
	.endr
	.rept	16
	adds	r2, r2, r2		@ r = 2r (the dividend's low 16 bits are 0)
	cmp	r2, r1
	bcc	1f
	subs	r2, r2, r1
1:	adcs	r3, r3
	.endr
	movs	r0, r3
	bx	lr
	.size cm_udiv30, . - cm_udiv30
