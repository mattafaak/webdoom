#!/usr/bin/env node
// Demo-compatibility harness: plays each IWAD's built-in attract demos
// (recorded on real 1993/1996 executables — perfect oracles, since any
// simulation divergence snowballs through the RNG) and fingerprints the
// gamestate every tic. Traces are pinned against golden files: a change
// that shifts the sim by even one P_Random call fails with the exact
// tic where it diverged.
//
// usage: node tools/demo-test.mjs             # verify sim traces against golden
//        node tools/demo-test.mjs --record    # (re)write sim golden traces
//        node tools/demo-test.mjs --render    # verify render goldens (auto-record if absent)
//        node tools/demo-test.mjs --render --record  # force re-record render goldens
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = process.argv.includes('--record');
const renderMode = process.argv.includes('--render');
const lowDetail = process.argv.includes('--low-detail'); // 14.2b: low-detail render goldens
const crossIdx = process.argv.indexOf('--cross');
const chocoBin = crossIdx >= 0 ? process.argv[crossIdx + 1] : null;
const buildDirIdx = process.argv.indexOf('--build-dir');
const buildDir = buildDirIdx >= 0 ? process.argv[buildDirIdx + 1] : 'build';
const goldenDir = join(root, 'tools/golden');
mkdirSync(goldenDir, { recursive: true });

const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;

// engine filename → demos (doom.wad is retail: it also carries DEMO4)
const MATRIX = [
    ['doom.wad', 'doomu.wad', ['demo1', 'demo2', 'demo3', 'demo4']],
    ['doom2.wad', 'doom2.wad', ['demo1', 'demo2', 'demo3']],
    ['tnt.wad', 'tnt.wad', ['demo1', 'demo2', 'demo3']],
    ['plutonia.wad', 'plutonia.wad', ['demo1', 'demo2', 'demo3']],
];

// ── render mode ─────────────────────────────────────────────────────────────
//
// Per-tic FNV-1a 32-bit hash of the palette-indexed engine framebuffer
// (screens[0], 320*200=64000 bytes) plus the current palette version counter,
// stored in tools/golden/<wad>-<demo>-render.json as {"tics":N,"trace":[u32...]}.
//
// Determinism design:
//   - NO -nodraw: the full render path (R_RenderPlayerView → D_Display) runs.
//   - web_set_smooth(0): sets smoothrender=false in r_main.c, pinning fractic
//     to FRACUNIT.  Every render is the canonical end-of-tic snapshot with no
//     contribution from emscripten_get_now() (wall-clock time).  Without this,
//     I_GetTimeFrac() introduces wall-clock dependency into the interpolated
//     positions of all moving objects, making renders non-deterministic.
//   - web_wipe_skip() before every frame: melt wipes are wall-clock driven
//     (non-deterministic) and purely cosmetic.  Clearing wipeactive=0 before
//     D_DoomFrame prevents it from entering D_WipeFrame and returning early,
//     ensuring the sim always advances and we capture rendered game frames only.
//
// What is hashed:
//   screens[0] — 64000 indexed bytes capturing all renderer output including
//   colormap effects: light levels, berserk green tint (fixedcolormap),
//   invulnerability sphere — any change in which color-indices the renderer
//   writes is detected here.
//
//   paletteversion (4-byte little-endian fold) — a monotonically increasing
//   counter bumped on every I_SetPalette call.  Damage/pickup palette flashes
//   (blood-red tint, etc.) change webpalette (the RGB mapping) but NOT the
//   indexed pixel values in screens[0].  Folding paletteversion catches those
//   regressions too.  The call sequence is game-logic driven and therefore
//   deterministic across runs.

if (renderMode) {
    // FNV-1a 32-bit: offset_basis=0x811c9dc5, prime=0x01000193
    function fnv1aRender(heapu8, fbPtr, palVer) {
        let h = 0x811c9dc5;
        const end = fbPtr + 320 * 200;
        for (let i = fbPtr; i < end; i++) {
            h = Math.imul(h ^ heapu8[i], 0x01000193);
        }
        // Fold palette version as 4 little-endian bytes.
        h = Math.imul(h ^ ( palVer        & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 8)  & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 16) & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 24) & 0xff), 0x01000193);
        return h >>> 0;
    }

    // 14.2b: --low-detail records/verifies separate -render-low.json goldens.
    // High-detail goldens (-render.json) are never touched by --low-detail runs.
    const goldenSuffix = lowDetail ? '-render-low' : '-render';
    const detailTag    = lowDetail ? '[low-detail] ' : '';

    let failures = 0;

    for (const [wad, engineName, demos] of MATRIX) {
        const path = join(root, 'wads/lib', wad);
        if (!existsSync(path)) { console.log(`skip ${wad}: not fetched`); continue; }
        const wadBytes = readFileSync(path);

        for (const demo of demos) {
            let done = null;
            const doom = await createDoom({
                print: () => {},
                printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
                onDoomError: msg => { if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`; },
            });
            {
                const p = doom._malloc(wadBytes.length);
                doom.HEAPU8.set(wadBytes, p);
                doom.ccall('web_register_file', null, ['string', 'number', 'number'],
                    [engineName, p, wadBytes.length]);
            }

            const trace = [];
            try {
                // No -nodraw: the full render path must run.
                doom.callMain(['-timedemo', demo]);
                // Pin fractic=FRACUNIT so renders are deterministic end-of-tic
                // snapshots with no wall-clock (emscripten_get_now) contribution.
                doom._web_set_smooth(0);
                // 14.2b: opt-in low-detail mode — routes through R_SetViewSize so
                // R_ExecuteSetViewSize rebuilds view tables with detailshift=1.
                // Must be called AFTER callMain (engine must be initialised).
                // Detail is render-only; sim hashes are unaffected.
                if (lowDetail) doom._web_set_detail(1);
                // Stable pointer into wasm memory for screens[0]; valid for this
                // doom instance's lifetime and does not move between frames.
                const fbPtr = doom._web_framebuffer();
                let lastTic = -1;
                for (let i = 0; i < 200000 && done === null; i++) {
                    // Skip any active melt wipe before stepping: wipes are
                    // wall-clock driven and would cause D_DoomFrame to return
                    // early (via D_WipeFrame) without advancing the sim or
                    // rendering, and their frames are non-deterministic.
                    doom._web_wipe_skip();
                    doom._web_frame();
                    const tic = doom._web_gametic();
                    if (tic !== lastTic) {
                        trace.push(fnv1aRender(doom.HEAPU8, fbPtr,
                            doom._web_palette_version()));
                        lastTic = tic;
                    }
                }
            } catch (e) {
                // timedemo I_Error unwinds here; done is already set
                if (done === null) done = `threw: ${String(e).slice(0, 80)}`;
            }

            const name = `${wad.replace('.wad', '')}-${demo}`;
            if (typeof done !== 'number') {
                console.log(`FAIL ${name} ${detailTag}render: ${done ?? 'never finished'}`);
                failures++;
                continue;
            }

            const goldenPath = join(goldenDir, `${name}${goldenSuffix}.json`);
            if (record || !existsSync(goldenPath)) {
                writeFileSync(goldenPath, JSON.stringify({ tics: done, trace }));
                console.log(`recorded ${name} ${detailTag}render: ${done} gametics, ${trace.length} hashes`);
                continue;
            }

            const golden = JSON.parse(readFileSync(goldenPath));
            if (golden.tics !== done) {
                console.log(`FAIL ${name} ${detailTag}render: ran ${done} gametics, golden ${golden.tics}`);
                failures++;
                continue;
            }
            let diverged = -1;
            for (let i = 0; i < golden.trace.length; i++) {
                if (golden.trace[i] !== trace[i]) { diverged = i; break; }
            }
            if (diverged >= 0) {
                console.log(`FAIL ${name} ${detailTag}render: PIXEL DESYNC at tic ${diverged} of ${golden.trace.length} (wad=${wad} demo=${demo})`);
                failures++;
            } else {
                console.log(`PASS ${name} ${detailTag}render: ${done} gametics pixel-identical`);
            }
        }
    }

    if (failures) { console.log(`${failures} ${detailTag}render golden(s) failed`); process.exit(1); }
    console.log(record ? `${detailTag}render golden traces written`
                       : `PASS — all ${detailTag}render goldens pixel-identical`);
    process.exit(0);
}

// ── sim mode (original code, unchanged) ─────────────────────────────────────

let failures = 0;

for (const [wad, engineName, demos] of MATRIX) {
    const path = join(root, 'wads/lib', wad);
    if (!existsSync(path)) { console.log(`skip ${wad}: not fetched`); continue; }
    const wadBytes = readFileSync(path);

    for (const demo of demos) {
        let done = null;
        const doom = await createDoom({
            print: () => {},
            printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
            onDoomError: msg => { if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`; },
        });
        {
            const p = doom._malloc(wadBytes.length);
            doom.HEAPU8.set(wadBytes, p);
            doom.ccall('web_register_file', null, ['string', 'number', 'number'], [engineName, p, wadBytes.length]);
        }

        const trace = [];
        const raw = [];
        const rawBuf = chocoBin ? doom._malloc(20) : 0;
        try {
            doom.callMain(['-timedemo', demo, '-nodraw']);
            let lastTic = -1;
            for (let i = 0; i < 200000 && done === null; i++) {
                doom._web_frame();
                const tic = doom._web_gametic();
                if (tic !== lastTic) {
                    trace.push(doom._web_state_hash() >>> 0);
                    if (chocoBin) {
                        doom._web_demo_state(rawBuf);
                        const v = doom.HEAP32.subarray(rawBuf >> 2, (rawBuf >> 2) + 5);
                        raw.push(`${v[0]} ${v[1]} ${v[2]} ${v[3] >>> 0} ${v[4]}`);
                    }
                    lastTic = tic;
                }
            }
        } catch (e) {
            // the timedemo I_Error unwinds through here; done is already set
            if (done === null) done = `threw: ${String(e).slice(0, 80)}`;
        }

        const name = `${wad.replace('.wad', '')}-${demo}`;
        if (typeof done !== 'number') {
            console.log(`FAIL ${name}: ${done ?? 'never finished'}`);
            failures++;
            continue;
        }

        const goldenPath = join(goldenDir, `${name}.json`);
        if (record || !existsSync(goldenPath)) {
            writeFileSync(goldenPath, JSON.stringify({ tics: done, trace }));
            console.log(`recorded ${name}: ${done} gametics, ${trace.length} samples`);
            continue;
        }

        const golden = JSON.parse(readFileSync(goldenPath));
        if (golden.tics !== done) {
            console.log(`FAIL ${name}: ran ${done} gametics, golden ${golden.tics}`);
            failures++;
            continue;
        }
        let diverged = -1;
        for (let i = 0; i < golden.trace.length; i++)
            if (golden.trace[i] !== trace[i]) { diverged = i; break; }
        if (diverged >= 0) {
            console.log(`FAIL ${name}: DESYNC at tic ${diverged} of ${golden.trace.length}`);
            failures++;
        } else {
            console.log(`PASS ${name}: ${done} gametics bit-identical`);
        }

        if (chocoBin) {
            const { spawnSync } = await import('node:child_process');
            const r = spawnSync(chocoBin,
                ['-iwad', path, '-timedemo', demo, '-nodraw'],
                { env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', HOME: '/tmp/claude-1000/chocohome' },
                  maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
            const choco = (r.stderr?.toString() ?? '').split('\n')
                .filter(l => l.startsWith('T ')).map(l => l.slice(2));
            let bad = -1;
            const n = Math.min(choco.length, raw.length);
            for (let i = 0; i < n; i++)
                if (choco[i] !== raw[i]) { bad = i; break; }
            if (bad >= 0 || choco.length !== raw.length) {
                console.log(`  CROSS FAIL vs chocolate: ${bad >= 0
                    ? `tic ${bad}: ours [${raw[bad]}] choco [${choco[bad]}]`
                    : `length ${raw.length} vs ${choco.length}`}`);
                failures++;
            } else {
                console.log(`  cross-validated vs chocolate: ${n} tics identical`);
            }
        }
    }
}

if (failures) { console.log(`${failures} demo(s) failed`); process.exit(1); }
console.log(record ? 'golden traces written' : 'PASS — all demos bit-identical to golden');
