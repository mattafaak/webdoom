#!/usr/bin/env node
// tools/cortexm/dualcore.mjs — a two-core split of one frame that keeps the
// output exact, costed from measured instruction counts.  qemu's boards have
// one core, so this is an accounting model: every count below is measured
// (attrib.mjs's per-tic, per-stage, per-function counts, and its per-call
// split of the drawers by screen half), and the few costs the split adds are
// estimates, named and labelled where they are used.
//
// usage: node tools/cortexm/dualcore.mjs FILE.json [FILE.json]
//        (attrib.mjs --json output; one per ISA)
//
// THE SPLIT ("split-frame"), within one tic, never across tics:
//   core 0: everything outside the renderer (G_Ticker, input, status bar, HUD,
//           sound), frame setup, and the BSP walk, which queues each wall
//           column's drawer arguments instead of drawing it;
//   core 1: draws the queued wall columns while core 0 walks, in queue order;
//   then both, after a barrier: R_DrawPlanes, each core drawing the pixels
//           of x < 160 (core 0) or x >= 160 (core 1) of every span and sky
//           column, every visplane in the engine's order;
//   then both, after a barrier: R_DrawMasked, each core its half of the
//           columns of every sprite, masked mid-texture and player sprite, in
//           the engine's order; a tic that draws a fuzz column runs
//           R_DrawMasked on core 0 alone;
//   a barrier, and core 0 draws the status bar and HUD over the frame.
// WHY IT IS EXACT (the same bytes as one core):
//   - walls: core 1 calls R_DrawColumn with the arguments, and in the order,
//     one core would; core 0 writes no pixel during the walk.  A queued column
//     reads its texture (a patch in the WAD, or a composite in the zone); core
//     0 drains the queue before any zone allocation in the walk, so a purge
//     cannot free what a queued column reads.  (Lumps read in place, the
//     ZC=1 build, allocate nothing else.)
//   - planes: a pixel is written by the same span or sky column as on one
//     core, and on each core in the engine's visplane order.  A span's
//     texture position at its first pixel is computed as on one core, at the
//     span's own x1 (R_MapPlane), and advanced to the core's first pixel by
//     (xstart - x1) steps: xfrac + k * xstep mod 2^32, which is what k
//     additions give.  The sky column at x is a function of x.
//   - masked: every masked draw is per column (R_DrawVisSprite's frac and
//     R_RenderMaskedSegRange's scale advance by a fixed step per column, so a
//     core starts a sprite at its own first column exactly; the clip arrays
//     and maskedtexturecol marks are per column), and each core keeps the
//     engine's sprite order within its columns.  The one state carried from
//     column to column is fuzzpos (R_DrawFuzzColumn), hence the fuzz rule.
//   - every core has its own copy of the drawers' global arguments (dc_*,
//     ds_*), and of R_DrawPlanes' span state (spanstart, the plane globals,
//     the per-row distance cache: a cache of a pure function, so per-core
//     copies hold the same values).
// THE ESTIMATES (instructions, per ISA: ARMv6-M / ARMv8-M):
//   PUSH   core 0's cost to queue one wall column (copy 8 globals): 29 / 22
//   POP    core 1's cost to take one (load the entry, set the 8 globals): 22 / 18
//   BAR    one barrier, either side (SIO FIFO or a flag): 15 / 15, three a tic
//   LAG    the queue's tail: core 1 finishes the last column after core 0
//          queues it: one average wall column of that tic (measured)
//   SETUP  a span crossing x = 160 is drawn as two pieces, one per core: one
//          more span-drawer call than on one core (the port's drawer prologue
//          and epilogue, 62 / 41), half charged to each core, whose pieces
//          share the crossing span's measured instructions evenly
//   overheads of R_DrawPlanes and R_DrawMasked minus their drawers: two
//          bounds.  "split": shared between the cores in the proportion of
//          their drawing (most of it is per column or per span); "dup": both
//          cores pay all of it (each walks every visplane and sprite).
// FOR COMPARISON ONLY, "pipelined": core 0 runs the walk of tic N (queueing
// walls, as above), then the simulation of tic N+1 and the rest of core 0's
// work while core 1 draws tic N's planes and masked (undivided); the period is
// max(walk, walls) + max(sim + other, planes + masked).  NOT the chosen
// design and NOT argued exact: the simulation of N+1 writes state that tic
// N's planes and masked read (flattranslation, texturetranslation, the masked
// mid-textures' sectors' heights and light and their sidedefs' midtexture,
// the player sprites, the HUD's lines, zone purges), and a snapshot of that
// list is only as exact as the list is complete, which this does not prove.
// RP2040 / RP2350: cycles = F x instructions, F (cycles per instruction of
// that ISA's build) 1.2-1.6 for the M0+ and 1.1-1.6 for the M33 (docs/retro.md
// section 5); on the RP2040 each 32-bit divide (libgcc's __aeabi_uidiv /
// __aeabi_idiv, counted per call) is the SIO hardware divider's instead,
// estimated at 24 cycles a call with the SDK's wrapper; budgets 133 MHz / 35
// = 3,800,000 and 150 MHz / 35 = 4,285,714 cycles a tic.
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync } from 'node:fs';

const fmt = v => Math.round(v).toLocaleString('en-US');
const pct = v => `${(v * 100).toFixed(0)}%`;
const sum = o => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const COL = ['R_DrawColumn', 'R_DrawFuzzColumn', 'R_DrawTranslatedColumn'];
const EST = {
    armv6m: { PUSH: 29, POP: 22, BAR: 15, SETUP: 62 },
    armv8m: { PUSH: 22, POP: 18, BAR: 15, SETUP: 41 },
};
const BOARD = {
    armv6m: { name: 'RP2040 (2x M0+, 133 MHz)', budget: 3800000, F: [1.2, 1.6], hwdiv: 24 },
    armv8m: { name: 'RP2350 (2x M33, 150 MHz)', budget: 4285714, F: [1.1, 1.6], hwdiv: null },
};

// a tic's stage totals, in a unit: instructions, or cycles for (F, hwdiv)
function stages(t, F = 1, hwdiv = null) {
    const S = {};
    for (const s of ['other', 'sim', 'frame', 'bsp', 'planes', 'masked']) {
        const st = t.st[['other', 'sim', 'frame', 'bsp', 'planes', 'masked'].indexOf(s)];
        let v = sum(st) * F;
        if (hwdiv !== null) {
            const calls = (t.calls.__aeabi_uidiv?.[s] ?? 0) + (t.calls.__aeabi_idiv?.[s] ?? 0);
            v += -(st.div32 ?? 0) * F + calls * hwdiv;
        }
        S[s] = { tot: v, st, F };
    }
    return S;
}
const hv = (t, f, s) => t.half?.[f]?.[s] ?? { insn: [0, 0, 0], calls: [0, 0, 0] };

// the model for one tic, in the unit stages() gave
function model(t, isa, F, hwdiv) {
    const e = EST[isa], S = stages(t, F, hwdiv);
    const single = Object.values(S).reduce((a, s) => a + s.tot, 0);
    const serial0 = S.other.tot + S.sim.tot + S.frame.tot;
    // walls
    const wh = hv(t, 'R_DrawColumn', 'bsp');
    const W = (S.bsp.st.R_DrawColumn ?? 0) * F, nW = wh.calls[0] + wh.calls[1];
    const c0b = S.bsp.tot - W + nW * e.PUSH * F, c1b = W + nW * e.POP * F;
    const tb = Math.max(c0b, c1b + (nW ? W / nW : 0));
    // planes: spans and sky by half; crossing spans drawn as two pieces
    const sp = hv(t, 'R_DrawSpan', 'planes'), sk = hv(t, 'R_DrawColumn', 'planes');
    const SP = (S.planes.st.R_DrawSpan ?? 0) * F, SK = (S.planes.st.R_DrawColumn ?? 0) * F;
    const PO = S.planes.tot - SP - SK;
    const spT = sp.insn[0] + sp.insn[1] + sp.insn[2] || 1, skT = sk.insn[0] + sk.insn[1] || 1;
    const draw = k => SP * (sp.insn[k] + sp.insn[2] / 2) / spT + sp.calls[2] * e.SETUP * F / 2 + SK * sk.insn[k] / skT;
    const d0 = draw(0), d1 = draw(1), dT = d0 + d1 || 1;
    // masked: columns by half; fuzz runs on core 0 alone
    const MC = COL.reduce((a, f) => a + (S.masked.st[f] ?? 0), 0) * F, MO = S.masked.tot - MC;
    const fuzz = (S.masked.st.R_DrawFuzzColumn ?? 0) > 0;
    const mh = COL.map(f => hv(t, f, 'masked')), mL = mh.reduce((a, h) => a + h.insn[0], 0), mR = mh.reduce((a, h) => a + h.insn[1], 0);
    const m0 = MC * (mL / ((mL + mR) || 1)), m1 = MC - m0;
    const out = {};
    for (const bound of ['split', 'dup']) {
        const p0 = d0 + (bound === 'dup' ? PO : PO * d0 / dT), p1 = d1 + (bound === 'dup' ? PO : PO * d1 / dT);
        const k0 = fuzz ? S.masked.tot : m0 + (bound === 'dup' ? MO : MO * (mL + mR ? mL / (mL + mR) : 0.5));
        const k1 = fuzz ? 0 : m1 + (bound === 'dup' ? MO : MO * (mL + mR ? mR / (mL + mR) : 0.5));
        const bar = 3 * e.BAR * F;
        const core0 = serial0 + tb + Math.max(p0, p1) + Math.max(k0, k1) + bar; // core 0's elapsed: the tic
        const busy1 = c1b + p1 + k1 + bar;
        out[bound] = { core0, busy1 };
    }
    // the comparison: walk vs walls, then sim + other vs planes + masked
    const pipe = tb + Math.max(serial0 + 3 * e.BAR * F, S.planes.tot + S.masked.tot + 3 * e.BAR * F);
    return { single, ...out, fuzz, pipe };
}

const files = process.argv.slice(2);
if (!files.length) { console.log('usage: node tools/cortexm/dualcore.mjs FILE.json [FILE.json]'); process.exit(2); }
for (const f of files) {
    const J = JSON.parse(readFileSync(f, 'utf8'));
    const isa = J.isa, b = BOARD[isa];
    const tics = [];
    for (const [name, d] of Object.entries(J.demos))
        d.tics.forEach((t, i) => { if (!d.load[i]) tics.push({ name, i, t }); });
    for (const x of tics) x.m = model(x.t, isa, 1, null);
    const bySingle = [...tics].sort((a, c) => a.m.single - c.m.single);
    const worst = bySingle[bySingle.length - 1], p99 = bySingle[Math.floor(0.99 * (bySingle.length - 1))];
    const byModel = [...tics].sort((a, c) => a.m.dup.core0 - c.m.dup.core0);
    const mworst = byModel[byModel.length - 1];
    const fuzzN = tics.filter(x => x.m.fuzz).length;
    console.log(`DUAL-CORE MODEL ${isa}-O1${J.suffix} — split-frame, ${tics.length} graded tics (${fuzzN} with fuzz: masked on core 0 alone)`);
    console.log('  instructions per tic: single core (measured) | core 0 = the tic, core 1 busy (modelled: measured counts + the estimates above)');
    const row = (label, x) => {
        const m = x.m;
        console.log(`  ${label.padEnd(30)} single ${fmt(m.single).padStart(10)} | split: core0 ${fmt(m.split.core0).padStart(10)} (${pct(m.split.core0 / m.single)}) core1 ${fmt(m.split.busy1).padStart(10)}` +
                    ` | dup: core0 ${fmt(m.dup.core0).padStart(10)} (${pct(m.dup.core0 / m.single)}) core1 ${fmt(m.dup.busy1).padStart(10)}`);
    };
    row(`worst: ${worst.name} ${worst.i}`, worst);
    row(`p99:   ${p99.name} ${p99.i}`, p99);
    row(`model's worst (dup): ${mworst.name} ${mworst.i}`, mworst);
    console.log(`  comparison only, "pipelined" (not argued exact): worst tic ${fmt(worst.m.pipe)} (${pct(worst.m.pipe / worst.m.single)}), p99 tic ${fmt(p99.m.pipe)} (${pct(p99.m.pipe / p99.m.single)}), max over tics ${fmt(Math.max(...tics.map(x => x.m.pipe)))}`);
    // the boards: cycles at both ends of F, the RP2040 with its divider
    for (const F of b.F) {
        const at = x => model(x.t, isa, F, b.hwdiv);
        const tw = at(worst), tp = at(p99);
        const all = tics.map(at);
        const mx = k => Math.max(...all.map(m => k(m)));
        const L = v => (v / b.budget).toFixed(2);
        console.log(`  ${b.name}, F=${F}${b.hwdiv !== null ? `, divides on the SIO divider (${b.hwdiv} cycles a call, estimated)` : ''}: load per core (1.00 = the 35 Hz budget, ${fmt(b.budget)} cycles)`);
        console.log(`    one core: worst ${L(tw.single)}, p99 ${L(tp.single)}, max ${L(mx(m => m.single))}`);
        console.log(`    split-frame "split": worst tic core0 ${L(tw.split.core0)} core1 ${L(tw.split.busy1)}; p99 tic core0 ${L(tp.split.core0)} core1 ${L(tp.split.busy1)}; max over tics core0 ${L(mx(m => m.split.core0))}`);
        console.log(`    split-frame "dup":   worst tic core0 ${L(tw.dup.core0)} core1 ${L(tw.dup.busy1)}; p99 tic core0 ${L(tp.dup.core0)} core1 ${L(tp.dup.busy1)}; max over tics core0 ${L(mx(m => m.dup.core0))}`);
        console.log(`    comparison, "pipelined" (not argued exact): worst tic ${L(tw.pipe)}, p99 tic ${L(tp.pipe)}, max over tics ${L(mx(m => m.pipe))}`);
    }
}
