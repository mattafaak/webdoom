/* tools/cortexm/fixed_v8m.S — the divide under cm_fixed.h's FixedDiv, for
 * ARMv8-M Mainline (Cortex-M33: Thumb-2, UDIV, CLZ, UMULL).
 *
 *   unsigned cm_udiv30 (unsigned n, unsigned d)
 *       returns floor(n * 2^16 / d), given 1 <= d < 2^31, n < 2^31 and
 *       n >> 14 < d (so the quotient has at most 30 bits; cm_fixed.h shows
 *       FixedDiv's clamp guarantees all three).  The same contract as
 *       fixed_v6m.S's: cm_fixed.h's FixedDiv is one function on both ISAs.
 *
 * UDIV divides 32 bits by 32; the dividend n * 2^16 has 47.  So it is long
 * division in two digits, the second estimated from the divisor's top 16
 * bits and corrected (Knuth's Algorithm D, one step, base 2^16).  Exact:
 *
 * 1. q1 = floor(n / d) and r = n - q1 d (UDIV, MLS), 0 <= r < d.  Since
 *    floor(n / 2^14) < d, n < 2^14 d and q1 < 2^14.
 * 2. n 2^16 = q1 d 2^16 + r 2^16, so floor(n 2^16 / d) = q1 2^16 + q0 with
 *    q0 = floor(r 2^16 / d), and 0 <= q0 < 2^16 because r < d.
 * 3. s = clz(d), 1 <= s <= 31, and dn = d 2^s: bit 31 set, no bit lost
 *    (d < 2^(32-s)).  vn1 = floor(dn / 2^16), so 2^15 <= vn1 < 2^16, and
 *    vn0 = dn - vn1 2^16 < 2^16.  U = r 2^s < dn < 2^32: no bit lost either.
 *    q0 = floor(U 2^16 / dn) (numerator and denominator times 2^s).
 * 4. qh = floor(U / vn1) (UDIV).  Never too small: dn >= vn1 2^16, so
 *    U 2^16 / dn <= U / vn1, and q0 <= qh.  At most 2 too large:
 *        U / vn1 - U 2^16 / dn = U vn0 / (vn1 dn) < 2^16 / vn1 <= 2
 *    (U < dn, vn0 < 2^16, vn1 >= 2^15), so qh < U 2^16 / dn + 2 < q0 + 3.
 *    When d < 2^16, s >= 16 and vn0 = 0: qh = q0.
 * 5. rem = r 2^16 - qh d, in 64 bits (UMULL; r 2^16 < 2^47, qh d < 2^48):
 *    exact, and -2d <= rem < d.  While rem < 0, qh -= 1 and rem += d.  This
 *    stops at the largest q' <= qh with r 2^16 - q' d >= 0, which is q0 (for
 *    q0: 0 <= rem < d; for any q' > q0 it is negative), after at most two
 *    steps (4).
 * 6. The result q1 2^16 + qh is formed before the corrections (one ADD, below
 *    2^30 + 2^16 + 2: no carry) and decremented with qh.
 * 15 instructions without a correction (BX included), 4 more per
 * correction; libgcc's __aeabi_ldivmod path is ~65 a call.
 * Copyright (C) 2026, GPL-2.0-or-later.
 */
	.syntax unified
	.cpu cortex-m33
	.thumb

	.section .text.cm_udiv30,"ax",%progbits
	.global cm_udiv30
	.type cm_udiv30, %function
	.thumb_func
cm_udiv30:
	udiv	r2, r0, r1		@ q1 = n / d
	mls	r0, r2, r1, r0		@ r = n - q1 d (< d)
	clz	r3, r1			@ s
	lsl	ip, r1, r3		@ dn = d << s
	lsr	ip, ip, #16		@ vn1
	lsl	r3, r0, r3		@ U = r << s
	udiv	r3, r3, ip		@ qh = U / vn1 (q0 <= qh <= q0 + 2)
	add	r2, r3, r2, lsl #16	@ q = q1 2^16 + qh
	umull	r3, ip, r3, r1		@ qh d = ip:r3
	rsbs	r3, r3, r0, lsl #16	@ rem, low word: (r << 16) - lo
	lsr	r0, r0, #16		@ (r 2^16)'s high word (flags kept)
	sbcs	r0, r0, ip		@ rem, high word; N = rem < 0
	bpl	2f
1:	subs	r2, r2, #1		@ q -= 1
	adds	r3, r3, r1		@ rem += d
	adcs	r0, r0, #0
	bmi	1b
2:	mov	r0, r2
	bx	lr
	.size cm_udiv30, . - cm_udiv30
