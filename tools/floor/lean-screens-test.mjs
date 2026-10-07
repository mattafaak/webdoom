#!/usr/bin/env node
// The lean-screens differential: tools/freestanding's lean build with
// LEAN_SCREENS (engine/core/v_video.h) against the same build without it,
// frame by frame, on the paths the 13 demo goldens never reach.
//
// The goldens cut every melt wipe short and no demo reaches an intermission,
// so they cannot see the screens LEAN_SCREENS moves into the zone.  This drives
// them, in fs-doom's -frames mode (tools/freestanding/i_main.c):
//   - wipes run to their end on a wipe clock (WD_WIPES=1): one tic per frame
//     while a wipe is active, since the virtual clock stands still in a wipe;
//   - a level exit is injected at a chosen tic of a demo (WD_EXIT_AT, G_ExitLevel,
//     the same tic in both builds): the intermission, its wipes, and the next
//     level, driven by the rest of the demo's input;
//   - view sizes are scheduled (WD_VIEW, WD_VIEW_AT): a narrowed view and its
//     border, low detail, the status bar coming and going, the view widening;
//   - after every frame every free zone block is filled with 0xA5 (WD_POISON=1),
//     so memory read after it was freed changes the pixels.
// Every frame's render hash (fs_render_hash, the goldens' hash) and sim hash
// must be equal in the two builds, wipe frames included, and the lean build's
// record must show it released what it borrowed.  Both builds run every
// scenario twice, at 8 MiB and at LEAN_ZONE_MIN_KB, the lean build's minimum
// with a level change, and are compared at the same zone: the borrowed
// screens are shown to fit there through the level change.
//
// Then three red-proofs, each a wrong lean path that must fail naming its frame:
//   stride     the status bar strip's stride one row short (V_SBARSTRIDE=31)
//   wipe-free  the wipe's end screen released at frame 5, mid-melt
//   back-free  the back screen released during the intermission
//
// usage: node tools/floor/lean-screens-test.mjs [--keep DIR] [--no-redproof]
//                                               [--zone-kb N]  (another zone)
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from '../lib/util.mjs';

// The lean build's smallest zone with a level change, measured (4 KiB steps):
//   the 13 demos (zone-min.mjs, FS_DOOM=tools/freestanding/fs-doom-lean):
//     1196 KiB, and 1192 fails; the same build without LEAN_SCREENS: 1232,
//     and 1228 fails.  The 13 demos never change level.
//   tnt-map12 below (exit, intermission, MAP13 to the demo's end): 1232 KiB,
//     and 1228 fails; without LEAN_SCREENS: 1228, and 1224 fails.
// So 1232 KiB: the 13 demos' minimum without LEAN_SCREENS, and with it the
// minimum once a level changes.
const args = process.argv.slice(2);
const LEAN_ZONE_MIN_KB = args.includes('--zone-kb') ? Number(args[args.indexOf('--zone-kb') + 1]) : 1232;
const KEEP = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : null;
const REDPROOF = !args.includes('--no-redproof');
const FS = join(root, 'tools/freestanding');
const fail = msg => { console.log(`FAIL lean-screens: ${msg}`); process.exit(1); };

// ── the builds: one OBJDIR each, so no object is shared between configurations
const BUILDS = {
    lean: ['LEAN=1', 'OBJDIR=obj-lean', 'OUT=fs-doom-lean'],
    ref: ['LEAN=1', 'LEAN_SCREENS=0', 'OBJDIR=obj-lean-ref', 'OUT=fs-doom-lean-ref'],
    stride: ['LEAN=1', 'OBJDIR=obj-lean-rp-stride', 'OUT=fs-doom-lean-rp-stride', 'EXTRA_CFLAGS=-DV_SBARSTRIDE=31'],
};
const tmp = KEEP ?? mkdtempSync(join(tmpdir(), 'webdoom-leanscreens-'));
mkdirSync(tmp, { recursive: true });
if (!KEEP) process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
for (const [id, mk] of Object.entries(BUILDS)) {
    if (id === 'stride' && !REDPROOF) continue;
    const out = mk.find(a => a.startsWith('OUT=')).slice(4);
    const r = spawnSync('make', ['-C', FS, '-j8', ...mk, out], { encoding: 'utf8' });
    writeFileSync(join(tmp, `build-${id}.log`), (r.stdout ?? '') + (r.stderr ?? ''));
    if (r.status !== 0) fail(`make ${mk.join(' ')} failed:\n${(r.stderr ?? '').trim().split('\n').slice(-8).join('\n')}`);
}
const BIN = { lean: join(FS, 'fs-doom-lean'), ref: join(FS, 'fs-doom-lean-ref'), stride: join(FS, 'fs-doom-lean-rp-stride') };

// ── the scenarios ────────────────────────────────────────────────────────────
// tnt MAP12 (DEMO2) exits into MAP13 (DEMO3's level, inside the 13-demo zone
// minimum): the commercial intermission, and in MAP13 the player dies and the
// level reloads (a fourth wipe).  doom E1M5 (DEMO1) exits into E1M6: Doom's
// intermission, with its animations and the next-location screen.
const SCENARIOS = [
    {
        id: 'tnt-map12-narrowed', wad: 'tnt.wad', demo: 'demo2', env: {
            WD_VIEW: '7',                                    // narrowed from the first frame
            WD_VIEW_AT: '300:10,450:11,600:10,750:5:1,950:9,2200:10,2400:8,2600:6',
            WD_EXIT_AT: '1200',                              // MAP12 -> MAP13 in a narrowed view
        },
    },
    { id: 'tnt-map12', wad: 'tnt.wad', demo: 'demo2', env: { WD_EXIT_AT: '1200' } },
    // and a screenshot (M_ScreenShot's buffer is a borrowed one too): the PCX
    // it writes is compared by its hash
    { id: 'doom-e1m5', wad: 'doom.wad', demo: 'demo1', env: { WD_EXIT_AT: '600', WD_SHOT_AT: '300' } },
];
for (const s of SCENARIOS) {
    if (!existsSync(join(root, 'wads/lib', s.wad))) fail(`wads/lib/${s.wad} absent (tools/fetch-wads.sh)`);
    if (!existsSync(join(tmp, s.wad))) symlinkSync(join(root, 'wads/lib', s.wad), join(tmp, s.wad));
}

// One run: the frame record, how it ended, and the last of its stderr.
function run(bin, s, extraEnv, label) {
    const out = join(tmp, `${label}.frames`);
    return new Promise(res => {
        const p = spawn(bin, [join(tmp, s.wad), '-timedemo', s.demo, '-frames', out], {
            cwd: tmp, stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, WD_WIPES: '1', WD_POISON: '1', ...s.env, ...extraEnv },
        });
        // fs-doom's I_Error writes to stdout (fs_putc, the byte-out)
        let out_ = '';
        p.stdout.on('data', d => { out_ += d; });
        p.on('exit', (code, signal) => {
            const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
            const frames = [];
            let head = null, end = null;
            for (const l of text.split('\n')) {
                const f = l.split(' ');
                if (f[0] === 'F') frames.push({
                    n: +f[1], gametic: +f[2], gs: +f[3], wipe: +f[4], render: f[5], sim: f[6],
                    held: +f[7], sw: +f[8], vh: +f[9], detail: +f[10], writes: +f[11], whash: f[12],
                });
                else if (f[0] === 'FRAMES') head = l;
                else if (f[0] === 'END') end = l;
            }
            res({ label, frames, head, end, code, signal, err: out_.match(/I_Error: [^\n]*/)?.[0] ?? '' });
        });
    });
}

// The first frame at which two records disagree, or null.  A run that ended
// early disagrees at the frame it never recorded.
function firstDiff(a, b) {
    const n = Math.min(a.frames.length, b.frames.length);
    for (let i = 0; i < n; i++) {
        const x = a.frames[i], y = b.frames[i];
        for (const k of ['n', 'gametic', 'gs', 'wipe', 'render', 'sim', 'writes', 'whash'])
            if (x[k] !== y[k]) return { frame: i, what: k, ref: x, got: y };
    }
    if (a.frames.length !== b.frames.length || !a.end || !b.end)
        return { frame: n, what: 'end', ref: a.frames[n], got: b.frames[n] };
    return null;
}
const GS = ['level', 'intermission', 'finale', 'demoscreen'];
const where = f => f ? `gametic ${f.gametic}, ${GS[f.gs] ?? f.gs}${f.wipe ? ', wipe' : ''}` : 'past the end';
const ended = r => r.end ? 'ran to the demo end' : `died (${r.signal ?? `exit ${r.code}`}${r.err ? `: ${r.err}` : ''})`;

// ── what each record must contain, so a pass is a pass about something ──────
function coverage(r, s) {
    const f = r.frames, c = { frames: f.length, wipes: 0, wipeFrames: 0, inter: 0, after: 0, narrow: 0,
                              low: 0, nobar: 0, barBack: 0, widen: 0, reload: 0 };
    let seenInter = false;
    for (let i = 0; i < f.length; i++) {
        const x = f[i], p = f[i - 1];
        if (x.wipe) { c.wipeFrames++; if (!p || !p.wipe) c.wipes++; }
        // a level reloaded in place (the player died) in a narrowed view: the
        // load frees the back screen and nothing in D_Display draws it again
        if (x.wipe && p && !p.wipe && p.gs === 0 && x.gs === 0 && x.sw < 320) c.reload++;
        if (x.gs === 1) { c.inter++; seenInter = true; }
        if (x.gs === 0 && seenInter) c.after++;
        if (x.gs === 0 && x.sw < 320) c.narrow++;
        if (x.gs === 0 && x.detail) c.low++;
        if (x.gs === 0 && x.vh === 200) c.nobar++;
        if (p && p.gs === 0 && x.gs === 0 && p.vh === 200 && x.vh < 200) c.barBack++;
        if (p && p.gs === 0 && x.gs === 0 && p.sw < 320 && x.sw === 320) c.widen++;
    }
    const need = { wipes: 3, inter: 50, after: 200 };
    if (s.env.WD_SHOT_AT) need.writes = 1;
    c.writes = f.at(-1)?.writes ?? 0;
    if (s.env.WD_VIEW) Object.assign(need, { narrow: 500, low: 50, nobar: 50, barBack: 1, widen: 2, reload: 1 });
    for (const [k, v] of Object.entries(need))
        if (c[k] < v) fail(`${s.id}: the reference record has ${c[k]} ${k} (at least ${v} expected): the scenario no longer reaches what it tests`);
    return c;
}

// The held mask (bit n: screens[n] allocated at the end of the frame).  The
// reference holds all four always; the lean build holds the wipe's screens on
// exactly the wipe frames, the back screen only in an intermission or a
// narrowed level and never during a melt (the wipe has its memory then), and
// the status bar strip always.
function holdings(r, lean, s) {
    let back = 0;
    for (const x of r.frames) {
        const bad = lean
            ? !(x.held & 16) || !!(x.held & 12) !== !!x.wipe || (x.held & 4) !== (x.held & 8) >> 1
              || ((x.held & 2) && (x.wipe || !(x.gs === 1 || (x.gs === 0 && x.sw < 320))))
            : x.held !== 30;
        if (bad) fail(`${s.id} ${r.label}: frame ${x.n} (${where(x)}) holds screens mask ${x.held}: ` +
                      (lean ? 'a borrowed screen is held when nothing needs it' : 'the reference must hold all four'));
        if (lean && (x.held & 2)) back++;
    }
    return { back };
}

// ── the runs ─────────────────────────────────────────────────────────────────
if (!(LEAN_ZONE_MIN_KB > 0)) fail('LEAN_ZONE_MIN_KB is not set');
const jobs = [];
const MIN = { WD_ZONE_KB: String(LEAN_ZONE_MIN_KB) };
for (const s of SCENARIOS) {
    jobs.push(run(BIN.ref, s, {}, `${s.id}.ref`));
    jobs.push(run(BIN.lean, s, {}, `${s.id}.lean`));
    jobs.push(run(BIN.ref, s, MIN, `${s.id}.ref-min`));
    jobs.push(run(BIN.lean, s, MIN, `${s.id}.lean-min`));
}
const RP = SCENARIOS.find(s => s.id === 'doom-e1m5');
if (REDPROOF) {
    jobs.push(run(BIN.stride, RP, {}, 'redproof.stride'));
    jobs.push(run(BIN.lean, RP, { WD_FREE_AT: '5:3' }, 'redproof.wipe-free'));
    jobs.push(run(BIN.lean, RP, { WD_FREE_AT: '700:1' }, 'redproof.back-free'));
}
const R = Object.fromEntries((await Promise.all(jobs)).map(r => [r.label, r]));

let total = 0;
const lines = [];
for (const s of SCENARIOS) {
  for (const zone of ['', '-min']) {
    const ref = R[`${s.id}.ref${zone}`];
    if (!ref.end || ref.code !== 0) fail(`${s.id}: the reference (${ref.head?.match(/zone=\d+/)}) ${ended(ref)}`);
    if (!/lean_screens=0/.test(ref.head) || !/poison=1/.test(ref.head) || !/wipes=1/.test(ref.head))
        fail(`${s.id}: the reference's header is ${ref.head}`);
    const c = coverage(ref, s);
    holdings(ref, false, s);
    for (const tag of [`lean${zone}`]) {
        const r = R[`${s.id}.${tag}`];
        if (!/lean_screens=1/.test(r.head ?? '')) fail(`${s.id} ${tag}: header ${r.head}: not a LEAN_SCREENS build`);
        const d = firstDiff(ref, r);
        if (d) fail(`${s.id} ${tag} (${r.head.match(/zone=\d+/)}) differs from the reference at frame ${d.frame} ` +
                    `(${where(d.ref)}): ${d.what} ${d.ref?.[d.what]} vs ${d.got?.[d.what]}; the lean run ${ended(r)}`);
        const h = holdings(r, true, s);
        const want = zone ? LEAN_ZONE_MIN_KB * 1024 : 8 << 20;
        if (!r.head.includes(`zone=${want} `) || !ref.head.includes(`zone=${want} `))
            fail(`${s.id}: the runs had ${ref.head} and ${r.head}, not a ${want}-byte zone each`);
        lines.push(`  ${s.id} at ${zone ? `${LEAN_ZONE_MIN_KB} KiB` : '8 MiB'}: ${c.frames} frames (${c.wipes} wipes, ${c.wipeFrames} wipe frames; ` +
            `${c.inter} intermission frames, ${c.after} level frames after it` +
            (c.writes ? `; ${c.writes} screenshot written, its PCX hashed` : '') +
            (s.env.WD_VIEW ? `; ${c.narrow} narrowed, ${c.low} low detail, ${c.nobar} without the status bar, it came back ${c.barBack}x, ` +
                             `the view widened ${c.widen}x, the level reloaded narrowed ${c.reload}x` : '') +
            `); lean held the back screen on ${h.back} of them`);
    }
    total += c.frames;
  }
}

let rp = '';
if (REDPROOF) {
    const ref = R[`${RP.id}.ref`];
    const firstWipeEnd = ref.frames.findIndex(x => !x.wipe);
    const proofs = [
        ['stride', R['redproof.stride'], d => d.frame < firstWipeEnd],
        ['wipe-free', R['redproof.wipe-free'], d => d.frame === 6],
        ['back-free', R['redproof.back-free'], d => d.frame === 701],
    ];
    const caught = [];
    for (const [id, r, expect] of proofs) {
        const d = firstDiff(ref, r);
        if (!d) fail(`red-proof ${id}: a wrong lean path matched the reference on every frame: this gate cannot see it`);
        if (!expect(d)) fail(`red-proof ${id}: failed, but at frame ${d.frame} (${where(d.ref)}), not where its fault is`);
        caught.push(`${id} at frame ${d.frame} (${where(d.ref)}${d.what === 'end' ? `: ${ended(r)}` : `: ${d.what}`})`);
    }
    rp = `; red-proofs: ${caught.join('; ')}`;
}

for (const l of lines) console.log(l);
console.log(`PASS lean-screens: ${SCENARIOS.length} scenarios at 8 MiB and at ${LEAN_ZONE_MIN_KB} KiB, ` +
            `${total} frames identical to the reference${rp}`);
