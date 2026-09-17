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
//        node tools/demo-test.mjs --sim-drawn --smooth --pitch 40  # sim invariance with the renderer running
//        node tools/demo-test.mjs --sim-drawn --build-dir build-invariants  # same, on the armed build
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { packTrace, readGolden } from './lib/golden.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = process.argv.includes('--record');
const renderMode = process.argv.includes('--render');
const lowDetail = process.argv.includes('--low-detail'); // 14.2b: low-detail render goldens
const simDrawn       = process.argv.includes('--sim-drawn');        // round 8 T2: sim hashes with the render path RUNNING
const smoothMod      = process.argv.includes('--smooth');            // round 8 T2: pass T enables frame interpolation
const pitchIdx       = process.argv.indexOf('--pitch');
const pitchPixels    = pitchIdx >= 0 ? Number(process.argv[pitchIdx + 1]) : 0;
const fracticIdx     = process.argv.indexOf('--fractic');
const fracticPin     = fracticIdx >= 0 ? Number(process.argv[fracticIdx + 1]) : -1;
const crossIdx = process.argv.indexOf('--cross');
const chocoBin = crossIdx >= 0 ? process.argv[crossIdx + 1] : null;
const buildDirIdx = process.argv.indexOf('--build-dir');
const buildDir = buildDirIdx >= 0 ? process.argv[buildDirIdx + 1] : 'build';

// ── argv validation (task 21.6) ──────────────────────────────────────────────
// Every flag above is read with process.argv.includes(), which cannot tell a
// typo from an absent flag: `--render-low` (for `--render --low-detail`) ran
// the SIM suite and printed "PASS — all demos bit-identical to golden (13
// demos)".  A reviewer reading that line sees a green render gate over the full
// count.  This is the documented trap in CLAUDE.md and it was still live.
const BOOL_FLAGS = new Set([
    '--record', '--render', '--low-detail', '--sim-drawn', '--smooth',
]);
const VALUE_FLAGS = new Set(['--cross', '--build-dir', '--record-reason', '--pitch', '--fractic']);
const USAGE = 'usage: demo-test.mjs [--record] [--render [--low-detail] | ' +
              '--sim-drawn [--smooth --fractic N] [--pitch N]] ' +
              '[--cross BIN] [--build-dir DIR] [--record-reason TEXT]';
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
const MODES = { '--render': renderMode, '--sim-drawn': simDrawn };
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
// --smooth and --pitch are modifiers of --sim-drawn for the same reason: alone
// they would fall through to the sim gate, which passes -nodraw and cannot read
// either of them, and the run would print the full-count sim PASS line.
if ((smoothMod || pitchIdx >= 0 || fracticIdx >= 0) && !simDrawn) {
    console.error(`FAIL: --smooth/--pitch/--fractic only apply to --sim-drawn\n${USAGE}`);
    process.exit(2);
}
if (pitchIdx >= 0 && !Number.isFinite(pitchPixels)) {
    console.error(`FAIL: --pitch needs a number, got '${process.argv[pitchIdx + 1]}'\n${USAGE}`);
    process.exit(2);
}
// --sim-drawn verifies against the EXISTING sim goldens and must never write one.
// Interpolation is INERT under -timedemo without a fractic pin: that path sets
// singletics, whose branch never calls run_tic(), and run_tic() is the only
// writer of web_lastticms -- so I_GetTimeFrac() saturates at FRACUNIT and the
// lerp is a no-op.  Measured: --smooth alone changed 0 of 1710 frames.  Refuse
// the arm rather than run it and let A4 report the vacuity after the fact.
if (smoothMod && fracticIdx < 0) {
    console.error(`FAIL: --smooth needs --fractic N (0..65536): interpolation is inert under ` +
                  `-timedemo without it (fractic saturates at FRACUNIT)\n${USAGE}`);
    process.exit(2);
}
if (fracticIdx >= 0 && !(Number.isFinite(fracticPin) && fracticPin >= 0 && fracticPin <= 65536)) {
    console.error(`FAIL: --fractic needs 0..65536, got '${process.argv[fracticIdx + 1]}'\n${USAGE}`);
    process.exit(2);
}
if (fracticIdx >= 0 && !smoothMod) {
    console.error(`FAIL: --fractic only means anything with --smooth\n${USAGE}`);
    process.exit(2);
}
if (simDrawn && record) {
    console.error(`FAIL: --sim-drawn never records; it verifies against the sim goldens ` +
                  `that --record (sim mode) owns\n${USAGE}`);
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
//   screens[0] — 64000 indexed bytes (column-major storage, visited in visual
//   row-major order) capturing all renderer output including
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
    // screens[0] is column-major (x*200 + y); the goldens were recorded from
    // a row-major copy, so visit it row-major: same bytes, same sequence.
    function fnv1aRender(heapu8, fbPtr, palVer) {
        let h = 0x811c9dc5;
        for (let y = 0; y < 200; y++)
            for (let x = 0; x < 320; x++)
                h = Math.imul(h ^ heapu8[fbPtr + x * 200 + y], 0x01000193);
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
                writeFileSync(goldenPath, JSON.stringify({ tics: done, trace: packTrace(trace), provenance: PROV() }));
                console.log(`recorded ${name} ${detailTag}render: ${done} gametics, ${trace.length} hashes`);
                verified++;
                continue;
            }
            // No auto-record: missing golden is a hard error (task 21.2).
            // This branch used to share the `record` arm above AND increment
            // `verified`, so deleting a golden re-created it from the build
            // under test and still printed the full-count PASS line — a silent,
            // self-authorising regold, in the two oldest and most load-bearing
            // gates.
            if (!existsSync(goldenPath)) {
                console.log(`FAIL ${name} ${detailTag}render: golden absent ` +
                            `(run --render${lowDetail ? ' --low-detail' : ''} --record first)`);
                failures++;
                continue;
            }

            const golden = readGolden(goldenPath);
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

// ── sim-drawn mode (round 8 T2: --sim-drawn) ────────────────────────────────
//
// The sim-invariance gate for render-side options and compile-time render
// variants: per-tic web_state_hash() with the FULL RENDER PATH EXECUTING,
// compared byte-exact against the EXISTING sim goldens (<name>.json).  It
// records nothing and owns no golden files of its own.
//
// Why this family exists.  The sim family passes -nodraw, and
// engine/core/d_main.c:234 is `if (nodrawers) return;` as the first statement
// of D_Display -- so R_SetupFrame, R_ShearView, R_InterpolateSectors, ST_Drawer
// and I_FinishUpdate never execute.  Every leg claiming a render-side option
// "leaves the playsim untouched" was asserting over code that did not run.
// MEASURED (round 8 T1): with `prndindex++` poisoned into two render-side
// blocks (the since-removed status-bar-skip and differential-blit variants),
// the -nodraw sim gate printed "PASS -- all demos bit-identical to golden
// (13 demos)" for both, while the same two binaries failed the render gate 13/13.
//
// The deleted sim-wide leg had that hole and one more: its vacuity arm
// (web_screenwidth() > 320) asserted that a SETTER had written a variable, not
// that anything downstream of it had run.  This family asserts at the
// consumption site instead -- see A4.
//
// ONE PASS PER MODIFIER, and that is not incidental.  The first cut of this
// family ran a single combined pass and compared it to the control.  With
// --smooth --pitch 40 it reported "1710/1710 frames changed" and looked
// excellent; run alone, --smooth changed 0 of 1710.  An active pitch was
// vouching for an inert smooth -- the "one case disarms the next" trap in
// CLAUDE.md.  Each modifier now gets its own pass and its own arm.
//
// Modifiers:
//   --pitch N     freelook y-shear, N screen pixels (lookdir)
//   --smooth      frame interpolation (smoothrender)
//   --fractic N   pin the interpolation fraction, 0..65536.  REQUIRED with
//                 --smooth, because interpolation is otherwise inert here:
//                 -timedemo sets singletics, that branch never calls run_tic(),
//                 run_tic() is the only writer of web_lastticms, so
//                 I_GetTimeFrac() saturates at FRACUNIT and the lerp is a no-op.
//                 The pin exists only in WEBDOOM_INVARIANTS builds; asking for
//                 it elsewhere is a hard failure, never a skip.
//
// Assertions, per demo:
//   A1  simTrace byte-exact against tools/golden/<name>.json, on EVERY pass
//   A2  the control pass is one of those passes            [render path alone]
//   A3  fbTrace(control) equals tools/golden/<name>-render.json  [instrument]
//   A4  fbTrace(modifier) differs from fbTrace(control) in >= MIN_CHANGED,
//       asserted SEPARATELY for each modifier                    [vacuity]
//   A5  web_perf_frames() >= tics/2 on every pass           [the path ran]
//
// A4 is measured at the CONSUMPTION SITE'S OUTPUT.  If a modifier is written
// but nothing downstream reads it -- or -nodraw elides the path -- that pass is
// bit-identical to the control and the leg is RED.  A3 is what makes A4 signal
// rather than noise: an inequality assertion with no equality control is
// exactly the sim-wide shape, and a broken framebuffer hash satisfies A4
// trivially.  A5 is what stops -nodraw coming back: web_perf_frame_count is
// incremented at engine/core/r_main.c:1038, INSIDE R_RenderPlayerView, so it is
// exactly 0 when D_Display returns early.

if (simDrawn) {
    // Same hash as the render family, so A3 can compare against -render.json.
    function fnv1aRender(heapu8, fbPtr, palVer) {   // row-major visit of column-major screens[0]
        let h = 0x811c9dc5;
        for (let y = 0; y < 200; y++)
            for (let x = 0; x < 320; x++)
                h = Math.imul(h ^ heapu8[fbPtr + x * 200 + y], 0x01000193);
        h = Math.imul(h ^ ( palVer         & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 8)  & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 16) & 0xff), 0x01000193);
        h = Math.imul(h ^ ((palVer >>> 24) & 0xff), 0x01000193);
        return h >>> 0;
    }

    // Each entry is one pass: a label and the render-option state it applies.
    const PASSES = [{ label: 'control', smooth: false, pitch: 0, fractic: -1 }];
    if (pitchIdx >= 0)  PASSES.push({ label: `pitch=${pitchPixels}`, smooth: false, pitch: pitchPixels, fractic: -1 });
    if (smoothMod)      PASSES.push({ label: `smooth fractic=${fracticPin}`, smooth: true, pitch: 0, fractic: fracticPin });
    const modeTag = `[sim-drawn ${PASSES.slice(1).map(p => p.label).join(' ') || 'render-path-only'}]`;

    async function runPass(engineName, demo, wadBytes, cfg) {
        let done = null;
        const doom = await createDoom({
            print: () => {},
            printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
            onDoomError: msg => { if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`; },
        });
        if (cfg.fractic >= 0 && typeof doom._web_set_fractic !== 'function') {
            console.log(`FAIL: --fractic needs a WEBDOOM_INVARIANTS build; ${buildDir}/doom.js ` +
                        `does not export _web_set_fractic. Not skipping: the run would be vacuous.`);
            process.exit(1);
        }
        {
            const p = doom._malloc(wadBytes.length);
            doom.HEAPU8.set(wadBytes, p);
            doom.ccall('web_register_file', null, ['string', 'number', 'number'],
                [engineName, p, wadBytes.length]);
        }
        const simTrace = [], fbTrace = [];
        try {
            // NO -nodraw: that is the entire point of this family.
            doom.callMain(['-timedemo', demo]);
            // Setters must run AFTER callMain (the engine must be initialised).
            doom._web_set_smooth(cfg.smooth ? 1 : 0);
            doom._web_set_pitch(cfg.pitch);
            if (cfg.fractic >= 0) doom._web_set_fractic(cfg.fractic);
            const fbPtr = doom._web_framebuffer();
            let lastTic = -1;
            for (let i = 0; i < 200000 && done === null; i++) {
                doom._web_wipe_skip();
                doom._web_frame();
                const tic = doom._web_gametic();
                if (tic !== lastTic) {
                    simTrace.push(doom._web_state_hash() >>> 0);
                    fbTrace.push(fnv1aRender(doom.HEAPU8, fbPtr, doom._web_palette_version()));
                    lastTic = tic;
                }
            }
        } catch (e) {
            if (done === null) done = `threw: ${String(e).slice(0, 80)}`;
        }
        return { done, simTrace, fbTrace, rendered: doom._web_perf_frames() };
    }

    let failures = 0, verified = 0;
    const changedBy = Object.create(null);

    for (const [wad, engineName, demos] of MATRIX) {
        const path = join(root, 'wads/lib', wad);
        if (!existsSync(path)) { console.log(`skip ${wad}: not fetched`); continue; }
        const wadBytes = readFileSync(path);

        for (const demo of demos) {
            const name = `${wad.replace('.wad', '')}-${demo}`;
            const fail = m => { console.log(`FAIL ${name} ${modeTag}: ${m}`); failures++; };

            const goldenPath = join(goldenDir, `${name}.json`);
            if (!existsSync(goldenPath)) { fail('sim golden absent (the sim gate owns it)'); continue; }
            const golden = readGolden(goldenPath);
            const minRendered = Math.floor(golden.tics / 2);
            const MIN_CHANGED = Math.max(8, Math.floor(golden.tics / 20));

            const runs = [];
            let bad = false;
            for (const cfg of PASSES) {
                const r = await runPass(engineName, demo, wadBytes, cfg);
                if (typeof r.done !== 'number') { fail(`${cfg.label} pass: ${r.done ?? 'never finished'}`); bad = true; break; }
                if (r.done !== golden.tics) { fail(`${cfg.label} pass ran ${r.done} gametics, golden ${golden.tics}`); bad = true; break; }
                // A5 — the render path ran.  Exactly 0 under -nodraw.
                if (!(r.rendered >= minRendered)) {
                    fail(`${cfg.label} pass rendered ${r.rendered} frames over ${golden.tics} tics — ` +
                         `the render path did not run (-nodraw?); this run proved nothing`);
                    bad = true; break;
                }
                // A1 — the claim, on every pass.
                let d = -1;
                for (let i = 0; i < golden.trace.length; i++)
                    if (golden.trace[i] !== r.simTrace[i]) { d = i; break; }
                if (d >= 0) {
                    fail(`${cfg.label} pass: DESYNC at tic ${d} of ${golden.trace.length} — ` +
                         `a render-side option reached the playsim`);
                    bad = true; break;
                }
                runs.push({ cfg, r });
            }
            if (bad) continue;

            const control = runs[0].r;

            // A3 — instrument check: the control pass IS the render-goldens
            // configuration, so its framebuffer trace must equal that golden.
            // Without this, A4's inequality could be satisfied by a broken hash.
            const rPath = join(goldenDir, `${name}-render.json`);
            if (!existsSync(rPath)) { fail(`render golden absent: ${name}-render.json (A3 cannot run)`); continue; }
            const rGolden = readGolden(rPath);
            let rdiv = -1;
            for (let i = 0; i < rGolden.trace.length; i++)
                if (rGolden.trace[i] !== control.fbTrace[i]) { rdiv = i; break; }
            if (rdiv >= 0) {
                fail(`control framebuffer differs from ${name}-render.json at tic ${rdiv} — ` +
                     `the instrument is not trustworthy, so A4 below would mean nothing`);
                continue;
            }

            // A4 — the vacuity arm, per modifier, read at the consumption site.
            const parts = [];
            for (const { cfg, r } of runs.slice(1)) {
                let changed = 0;
                for (let i = 0; i < r.fbTrace.length; i++)
                    if (r.fbTrace[i] !== control.fbTrace[i]) changed++;
                if (changed < MIN_CHANGED) {
                    fail(`${cfg.label} changed ${changed} of ${r.fbTrace.length} frames ` +
                         `(need ${MIN_CHANGED}) — the mode was not active; this run proved nothing`);
                    bad = true; break;
                }
                changedBy[cfg.label] = (changedBy[cfg.label] ?? 0) + changed;
                parts.push(`${cfg.label} ${changed}/${r.fbTrace.length}`);
            }
            if (bad) continue;

            console.log(`PASS ${name} ${modeTag}: ${golden.tics} gametics bit-identical` +
                        (parts.length ? ` (${parts.join(', ')})` : ''));
            verified++;
        }
    }

    if (failures) { console.log(`${failures} ${modeTag} demo(s) failed`); process.exit(1); }
    assertFullCoverage(modeTag, verified);
    const summary = Object.entries(changedBy).map(([k, v]) => `${k}: ${v} frames changed`).join('; ');
    console.log(`PASS — sim invariant with the render path running ${modeTag} ` +
                `(${verified} demos${summary ? `; ${summary}` : ''})`);
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
            writeFileSync(goldenPath, JSON.stringify({ tics: done, trace: packTrace(trace), provenance: PROV() }));
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

        const golden = readGolden(goldenPath);
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
