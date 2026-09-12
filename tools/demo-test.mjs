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
//        node tools/demo-test.mjs --render    # verify render goldens (absent golden = FAIL)
//        node tools/demo-test.mjs --render --record  # force re-record render goldens
//        node tools/demo-test.mjs --render-fakeflat --record  # record fakeflat render goldens
//        node tools/demo-test.mjs --render-fakeflat  # verify fakeflat render goldens
//        node tools/demo-test.mjs --render-potato --record  # record potato render goldens
//        node tools/demo-test.mjs --render-potato  # verify potato render goldens
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = process.argv.includes('--record');
const renderMode = process.argv.includes('--render');
const lowDetail = process.argv.includes('--low-detail'); // 14.2b: low-detail render goldens
const fakeFlatRender = process.argv.includes('--render-fakeflat'); // 20.3a: WEBDOOM_FAKEFLAT render goldens
const potatoRender   = process.argv.includes('--render-potato');   // 20.3c: WEBDOOM_POTATO render goldens
const crossIdx = process.argv.indexOf('--cross');
const chocoBin = crossIdx >= 0 ? process.argv[crossIdx + 1] : null;
const buildDirIdx = process.argv.indexOf('--build-dir');
// --render-fakeflat defaults to build-fakeflat/ (built with -DWEBDOOM_FAKEFLAT)
// --render-potato defaults to build-potato/ (built with -DWEBDOOM_POTATO)
const buildDir = buildDirIdx >= 0 ? process.argv[buildDirIdx + 1]
               : fakeFlatRender   ? 'build-fakeflat'
               : potatoRender     ? 'build-potato'
               : 'build';

// ── argv validation (task 21.6) ──────────────────────────────────────────────
// Every flag above is read with process.argv.includes(), which cannot tell a
// typo from an absent flag: `--render-low` (for `--render --low-detail`) ran
// the SIM suite and printed "PASS — all demos bit-identical to golden (13
// demos)".  A reviewer reading that line sees a green render gate over the full
// count.  This is the documented trap in CLAUDE.md and it was still live.
const BOOL_FLAGS = new Set([
    '--record', '--render', '--low-detail',
    '--render-fakeflat', '--render-potato',
]);
const VALUE_FLAGS = new Set(['--cross', '--build-dir', '--record-reason']);
const USAGE = 'usage: demo-test.mjs [--record] [--render [--low-detail] | ' +
              '--render-fakeflat | --render-potato] [--cross BIN] [--build-dir DIR] [--record-reason TEXT]';
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (VALUE_FLAGS.has(a)) {
        if (i + 1 >= process.argv.length) {
            console.error(`FAIL: ${a} needs a value\n${USAGE}`);
            process.exit(2);
        }
        i++;                       // consume the value
        continue;
    }
    if (BOOL_FLAGS.has(a)) continue;
    console.error(`FAIL: unrecognised argument '${a}'\n${USAGE}`);
    process.exit(2);
}
// Provenance for anything this run records (task 21.3).  Recording from a dirty
// tree without a stated reason is refused: a regold asserts the NEW output is
// correct, and the reason belongs in the artifact.
const { provenance, recordReason } = await import('./golden-provenance.mjs');
const RECORD_REASON = record ? recordReason(process.argv) : null;
const PROV = () => provenance('demo-test.mjs', buildDir, RECORD_REASON);

// Selecting two gate families runs only the first and silently skips the rest.
const MODES = { '--render': renderMode,
                '--render-fakeflat': fakeFlatRender, '--render-potato': potatoRender };
const chosen = Object.keys(MODES).filter(k => MODES[k]);
if (chosen.length > 1) {
    console.error(`FAIL: ${chosen.join(' and ')} select different gate families; pick one\n${USAGE}`);
    process.exit(2);
}
// --low-detail is a modifier of --render, not a family of its own: alone it
// would fall through to the sim gate and be silently ignored.
if (lowDetail && !renderMode) {
    console.error(`FAIL: --low-detail only applies to --render (did you mean --render --low-detail?)\n${USAGE}`);
    process.exit(2);
}
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

// Every gate family replays the whole MATRIX.  Derive the expected demo count
// from it rather than hardcoding 13, so adding an IWAD row moves the assertion
// with no other edit (task 21.2).
const EXPECTED_DEMOS = MATRIX.reduce((n, [, , demos]) => n + demos.length, 0);

// A run that verified fewer demos than the matrix declares DID NOT RUN IN FULL,
// and must never print the full-count PASS line.  This replaces the old
// `if (!verified)` vacuous guard, which only caught the all-missing case: with
// one WAD absent the render gate printed PASS over 12 of 13, and with one
// GOLDEN absent it silently re-recorded and printed PASS over all 13.
function assertFullCoverage(label, verified) {
    if (verified !== EXPECTED_DEMOS) {
        console.log(`FAIL ${label}: verified ${verified} of ${EXPECTED_DEMOS} demos — ` +
                    `incomplete run (WAD not fetched, or golden absent). A partial run is not a pass.`);
        process.exit(1);
    }
}

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
    let verified = 0;

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
            if (record) {
                writeFileSync(goldenPath, JSON.stringify({ tics: done, trace, provenance: PROV() }));
                console.log(`recorded ${name} ${detailTag}render: ${done} gametics, ${trace.length} hashes`);
                verified++;
                continue;
            }
            // No auto-record: missing golden is a hard error (task 21.2).
            // This branch used to share the `record` arm above AND increment
            // `verified`, so deleting a golden re-created it from the build
            // under test and still printed the full-count PASS line — a silent,
            // self-authorising regold.  The fakeflat/potato families never
            // had this hole; the two oldest and most load-bearing gates did.
            if (!existsSync(goldenPath)) {
                console.log(`FAIL ${name} ${detailTag}render: golden absent ` +
                            `(run --render${lowDetail ? ' --low-detail' : ''} --record first)`);
                failures++;
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
                verified++;
            }
        }
    }

    if (failures) { console.log(`${failures} ${detailTag}render golden(s) failed`); process.exit(1); }
    assertFullCoverage(`${detailTag}render`, verified);
    console.log(record ? `${detailTag}render golden traces written`
                       : `PASS — all ${detailTag}render goldens pixel-identical (${verified} demos)`);
    process.exit(0);
}

// ── fakeflat render mode (20.3a: --render-fakeflat) ─────────────────────────
//
// Records/verifies per-tic FNV-1a 32-bit framebuffer hashes of the build-fakeflat
// wasm (compiled with -DWEBDOOM_FAKEFLAT).  All floor/ceiling spans are filled
// with a single representative colour (unconditional — no distance branch),
// producing different pixel output from the vanilla render path.  These goldens are therefore a separate, dedicated
// set — vanilla render goldens (-render.json) are never modified by this mode.
//
// Golden suffix: -render-fakeflat.json
// Mode tag in PASS/FAIL lines: [fakeflat]
// No auto-record: missing goldens are hard errors.  Use --record for initial recording.

if (fakeFlatRender) {
    function fnv1aFakeflat(heapu8, fbPtr, palVer) {
        let h = 0x811c9dc5;
        const end = fbPtr + 320 * 200;
        for (let i = fbPtr; i < end; i++) {
            h = Math.imul(h ^ heapu8[i], 0x01000193);
        }
        h = Math.imul(h ^ ( palVer        & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 8)  & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 16) & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 24) & 0xff), 0x01000193);
        return h >>> 0;
    }

    let failures = 0;
    let verified = 0;

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
                doom.callMain(['-timedemo', demo]);
                doom._web_set_smooth(0);
                const fbPtr = doom._web_framebuffer();
                let lastTic = -1;
                for (let i = 0; i < 200000 && done === null; i++) {
                    doom._web_wipe_skip();
                    doom._web_frame();
                    const tic = doom._web_gametic();
                    if (tic !== lastTic) {
                        trace.push(fnv1aFakeflat(doom.HEAPU8, fbPtr,
                            doom._web_palette_version()));
                        lastTic = tic;
                    }
                }
            } catch (e) {
                if (done === null) done = `threw: ${String(e).slice(0, 80)}`;
            }

            const name = `${wad.replace('.wad', '')}-${demo}`;
            if (typeof done !== 'number') {
                console.log(`FAIL ${name} [fakeflat] render: ${done ?? 'never finished'}`);
                failures++;
                continue;
            }

            const goldenPath = join(goldenDir, `${name}-render-fakeflat.json`);
            if (record) {
                writeFileSync(goldenPath, JSON.stringify({ tics: done, trace, provenance: PROV() }));
                console.log(`recorded ${name} [fakeflat] render: ${done} gametics, ${trace.length} hashes`);
                verified++;
                continue;
            }
            // No auto-record: missing golden is a hard error.
            if (!existsSync(goldenPath)) {
                console.log(`FAIL ${name} [fakeflat] render: golden absent (run --render-fakeflat --record first)`);
                failures++;
                continue;
            }

            const golden = JSON.parse(readFileSync(goldenPath));
            if (golden.tics !== done) {
                console.log(`FAIL ${name} [fakeflat] render: ran ${done} gametics, golden ${golden.tics}`);
                failures++;
                continue;
            }
            let diverged = -1;
            for (let i = 0; i < golden.trace.length; i++) {
                if (golden.trace[i] !== trace[i]) { diverged = i; break; }
            }
            if (diverged >= 0) {
                console.log(`FAIL ${name} [fakeflat] render: PIXEL DESYNC at tic ${diverged} of ${golden.trace.length}`);
                failures++;
            } else {
                console.log(`PASS ${name} [fakeflat] render: ${done} gametics pixel-identical`);
                verified++;
            }
        }
    }

    if (failures) { console.log(`${failures} [fakeflat] render golden(s) failed`); process.exit(1); }
    assertFullCoverage('[fakeflat] render', verified);
    console.log(record ? `[fakeflat] render golden traces written`
                       : `PASS — all [fakeflat] render goldens pixel-identical (${verified} demos)`);
    process.exit(0);
}

// ── potato render mode (20.3c: --render-potato) ─────────────────────────────
//
// Records/verifies per-tic FNV-1a 32-bit framebuffer hashes of the build-potato
// wasm (compiled with -DWEBDOOM_POTATO).  Only even dc_x columns are rendered;
// adjacent odd columns are copies of the preceding even column (column-major
// memcpy, 1 per even column).  This visually doubles every wall/sprite column
// horizontally and halves texture reads/colormap lookups.  The output is visually
// different from vanilla, so a separate dedicated golden set is required.
//
// Golden suffix: -render-potato.json
// Mode tag in PASS/FAIL lines: [potato]
// No auto-record: missing goldens are hard errors.  Use --record for initial recording.

if (potatoRender) {
    function fnv1aPotato(heapu8, fbPtr, palVer) {
        let h = 0x811c9dc5;
        const end = fbPtr + 320 * 200;
        for (let i = fbPtr; i < end; i++) {
            h = Math.imul(h ^ heapu8[i], 0x01000193);
        }
        h = Math.imul(h ^ ( palVer        & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 8)  & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 16) & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 24) & 0xff), 0x01000193);
        return h >>> 0;
    }

    let failures = 0;
    let verified = 0;

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
                doom.callMain(['-timedemo', demo]);
                doom._web_set_smooth(0);
                const fbPtr = doom._web_framebuffer();
                let lastTic = -1;
                for (let i = 0; i < 200000 && done === null; i++) {
                    doom._web_wipe_skip();
                    doom._web_frame();
                    const tic = doom._web_gametic();
                    if (tic !== lastTic) {
                        trace.push(fnv1aPotato(doom.HEAPU8, fbPtr,
                            doom._web_palette_version()));
                        lastTic = tic;
                    }
                }
            } catch (e) {
                if (done === null) done = `threw: ${String(e).slice(0, 80)}`;
            }

            const name = `${wad.replace('.wad', '')}-${demo}`;
            if (typeof done !== 'number') {
                console.log(`FAIL ${name} [potato] render: ${done ?? 'never finished'}`);
                failures++;
                continue;
            }

            const goldenPath = join(goldenDir, `${name}-render-potato.json`);
            if (record) {
                writeFileSync(goldenPath, JSON.stringify({ tics: done, trace, provenance: PROV() }));
                console.log(`recorded ${name} [potato] render: ${done} gametics, ${trace.length} hashes`);
                verified++;
                continue;
            }
            // No auto-record: missing golden is a hard error.
            if (!existsSync(goldenPath)) {
                console.log(`FAIL ${name} [potato] render: golden absent (run --render-potato --record first)`);
                failures++;
                continue;
            }

            const golden = JSON.parse(readFileSync(goldenPath));
            if (golden.tics !== done) {
                console.log(`FAIL ${name} [potato] render: ran ${done} gametics, golden ${golden.tics}`);
                failures++;
                continue;
            }
            let diverged = -1;
            for (let i = 0; i < golden.trace.length; i++) {
                if (golden.trace[i] !== trace[i]) { diverged = i; break; }
            }
            if (diverged >= 0) {
                console.log(`FAIL ${name} [potato] render: PIXEL DESYNC at tic ${diverged} of ${golden.trace.length}`);
                failures++;
            } else {
                console.log(`PASS ${name} [potato] render: ${done} gametics pixel-identical`);
                verified++;
            }
        }
    }

    if (failures) { console.log(`${failures} [potato] render golden(s) failed`); process.exit(1); }
    assertFullCoverage('[potato] render', verified);
    console.log(record ? `[potato] render golden traces written`
                       : `PASS — all [potato] render goldens pixel-identical (${verified} demos)`);
    process.exit(0);
}

// ── sim mode (original code, unchanged) ─────────────────────────────────────

let failures = 0;
let verified = 0;

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
        if (record) {
            writeFileSync(goldenPath, JSON.stringify({ tics: done, trace, provenance: PROV() }));
            console.log(`recorded ${name}: ${done} gametics, ${trace.length} samples`);
            verified++;   // without this, --record ended at the 0-verified guard
            continue;
        }
        // No auto-record: missing golden is a hard error (task 21.2).
        if (!existsSync(goldenPath)) {
            console.log(`FAIL ${name}: golden absent (run --record first)`);
            failures++;
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
            verified++;
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
assertFullCoverage('sim', verified);
console.log(record ? 'golden traces written' : `PASS — all demos bit-identical to golden (${verified} demos)`);
