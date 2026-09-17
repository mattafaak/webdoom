#!/usr/bin/env node
// smoke-pwad-test.mjs — boot every WAD the server carries that no demo gate covers.
//
// promises rme-008: README claims the server carries Ultimate Doom, Doom II,
// Final Doom, SIGIL, Master Levels, NRFTL and Chex Quest. The demo goldens
// cover exactly the four demo-bearing IWADs; the other twenty-four entries in
// wads/manifest.json had NO automated test of any kind -- a shipped WAD that
// failed to load would have been found by a player, not by CI.
//
// The target list is DERIVED from the manifest minus the demo-gated IWADs, so
// adding a WAD to the library adds it to this gate with no edit here. A typed
// list would have gone stale the first time the library grew.
//
// usage: node tools/smoke-pwad-test.mjs [frames]
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const FRAMES = Number(process.argv[2] ?? 105);          // paced at 70 fps -> ~1.5 s

// The engine identifies games by 1993 filenames (client/js/main.js ENGINE_NAME).
// Ultimate Doom must be doomu.wad, and the standalone TCs take the filename of
// the game mode they are shaped like -- without this IdentifyVersion finds
// nothing and the engine aborts "W_InitFiles: no files found", which is exactly
// how chex.wad failed the first run of this gate.
const ENGINE_NAME = { 'doom.wad': 'doomu.wad', 'chex.wad': 'doomu.wad' };

// The four IWADs tools/demo-test.mjs replays (its MATRIX). Everything else in
// the library is what this gate exists for.
const DEMO_GATED = new Set(['doom.wad', 'doom2.wad', 'tnt.wad', 'plutonia.wad']);

const manifest = JSON.parse(readFileSync(join(root, 'wads/manifest.json'), 'utf8'));
const targets = manifest.wads.filter(w => !DEMO_GATED.has(w.file));

// A run over an empty or tiny target set must not read as a pass. The library
// had 28 entries when this was written; 20 is the floor for "the manifest was
// really read", well below that and well above a stub.
if (targets.length < 20) {
    console.log(`FAIL smoke-pwad: manifest yielded only ${targets.length} ungated WAD(s) — ` +
                `the target list is derived from wads/manifest.json and that looks wrong`);
    process.exit(1);
}

const createDoom = (await import(join(root, 'build/doom.js'))).default;

// E1M1-style wads take `-warp E M`; MAP01-style take `-warp N`.
const warpArgs = maps => {
    const first = [...maps].sort()[0];
    const e = /^E(\d)M(\d)$/.exec(first);
    if (e) return ['-warp', e[1], e[2]];
    const m = /^MAP(\d+)$/.exec(first);
    if (m) return ['-warp', String(Number(m[1]))];
    return [];
};

const reg = (doom, name, bytes) => {
    const p = doom._malloc(bytes.length);
    if (!p) throw new Error(`out of memory registering ${name}`);
    doom.HEAPU8.set(bytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'], [name, p, bytes.length]);
};

let failures = 0, verified = 0, skipped = 0;

// One boot. Returns everything the assertions need, including a fingerprint of
// the final frame so two boots can be compared.
async function boot(files, args) {
    let fatal = null;
    const doom = await createDoom({
        print: () => {}, printErr: () => {},
        onDoomError: msg => { fatal ??= msg; },
    });
    try {
        for (const [name, path] of files) reg(doom, name, readFileSync(path));
        doom.callMain(args);
    } catch (e) { fatal ??= `threw: ${String(e).slice(0, 100)}`; }
    if (fatal) return { fatal };

    const fb = doom._web_framebuffer();
    if (!fb) return { fatal: 'no framebuffer' };

    // The loop MUST be wall-clock paced. Outside -timedemo the engine runs
    // TryRunTics, which advances the sim from real elapsed time -- so an
    // unpaced loop returns whatever tic count the process's age happens to
    // give. The first cut of this gate did exactly that and read 1, 2, 3, 4,
    // 5 ... tics down the target list: a number that measured the harness's
    // position in its own run, not the WAD.
    const hashes = new Set();
    const start = performance.now();
    for (let i = 0; i < FRAMES && !fatal; i++) {
        const target = start + i * (1000 / 70);   // pace like a 70 fps display
        while (performance.now() < target) { /* spin */ }
        doom._web_wipe_skip();
        doom._web_frame();
        hashes.add(createHash('sha1')
            .update(doom.HEAPU8.subarray(fb, fb + 320 * 200)).digest('hex'));
    }
    if (fatal) return { fatal };

    const px = doom.HEAPU8.subarray(fb, fb + 320 * 200);
    return {
        fatal: null,
        tic: doom._web_gametic(),
        distinct: hashes.size,
        nonzero: px.reduce((n, v) => n + (v !== 0), 0),
        frame0: createHash('sha1').update(px).digest('hex'),
    };
}

// 35 Hz sim against a 70 fps frame pace: about half the frames advance a tic,
// so a quarter is a generous floor that still catches a dead sim.
const MIN_TICS = Math.floor(FRAMES / 4);
const controlCache = new Map();

for (const w of targets) {
    const label = `${w.file} (${w.title})`;
    const isPwad = w.kind === 'PWAD';
    const basePath = isPwad ? join(root, 'wads/lib', w.base) : null;
    const ownPath  = join(root, 'wads/lib', w.file);
    if (!existsSync(ownPath) || (isPwad && !existsSync(basePath))) {
        console.log(`skip ${label}: not fetched`);
        skipped++;
        continue;
    }
    const warp = warpArgs(w.maps);
    const files = isPwad
        ? [[ENGINE_NAME[w.base] ?? w.base, basePath], [w.file, ownPath]]
        : [[ENGINE_NAME[w.file] ?? w.file, ownPath]];
    const args = isPwad ? ['-file', w.file, ...warp] : warp;

    const r = await boot(files, args);
    if (r.fatal)                 { console.log(`FAIL ${label}: ${r.fatal}`); failures++; continue; }
    if (r.tic < MIN_TICS)        { console.log(`FAIL ${label}: sim advanced ${r.tic} tics over ${FRAMES} paced frames (need ${MIN_TICS})`); failures++; continue; }
    if (r.nonzero < 10000)       { console.log(`FAIL ${label}: framebuffer mostly empty (${r.nonzero}/64000)`); failures++; continue; }
    if (r.distinct < 2)          { console.log(`FAIL ${label}: framebuffer never changed over ${FRAMES} frames`); failures++; continue; }

    // Did the PWAD actually contribute? Booting the BASE IWAD at the same map
    // renders something perfectly valid, so "it booted and drew a level" does
    // not prove the PWAD loaded at all. Measured: truncating tnt31.wad to 40 KB
    // still passed the three assertions above, because the engine fell back to
    // tnt.wad's own MAP31. The control settles it -- and a control that ERRORS
    // is itself proof, because that map exists only in the PWAD (sigil's E5).
    let contributed = 'n/a (IWAD)';
    if (isPwad) {
        const key = `${w.base}|${warp.join(' ')}`;
        if (!controlCache.has(key))
            controlCache.set(key, await boot([[ENGINE_NAME[w.base] ?? w.base, basePath]], warp));
        const c = controlCache.get(key);
        if (c.fatal) contributed = 'base cannot reach this map';
        else if (c.frame0 === r.frame0) {
            console.log(`FAIL ${label}: identical to ${w.base} at the same map — ` +
                        `the PWAD contributed nothing (did it load?)`);
            failures++; continue;
        } else contributed = 'differs from base';
    }

    console.log(`PASS ${label}: ${r.tic} tics, ${r.distinct} distinct frames, ` +
                `${r.nonzero}/64000 non-black, ${contributed}`);
    verified++;
}

if (failures) { console.log(`${failures} WAD(s) failed to boot`); process.exit(1); }
// A skip is a legitimate state on a partial library, but "checked one of
// twenty-four" must not read the same as "checked them all". Same floor as the
// target-discovery guard above, applied to what was actually BOOTED.
if (verified < 20) {
    console.log(`FAIL smoke-pwad: verified only ${verified} of ${targets.length} ` +
                `(${skipped} not fetched) — a partial library is not a pass`);
    process.exit(1);
}
console.log(`PASS — smoke-pwad: ${verified} of ${targets.length} ungated library WADs boot and render ` +
            `(${skipped} not fetched; 4 assertions each, incl. a base-IWAD control)`);
