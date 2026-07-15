#!/usr/bin/env node
// Demo-compatibility harness: plays each IWAD's built-in attract demos
// (recorded on real 1993/1996 executables — perfect oracles, since any
// simulation divergence snowballs through the RNG) and fingerprints the
// gamestate every tic. Traces are pinned against golden files: a change
// that shifts the sim by even one P_Random call fails with the exact
// tic where it diverged.
//
// usage: node tools/demo-test.mjs           # verify against golden
//        node tools/demo-test.mjs --record  # (re)write golden traces
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = process.argv.includes('--record');
const crossIdx = process.argv.indexOf('--cross');
const chocoBin = crossIdx >= 0 ? process.argv[crossIdx + 1] : null;
const goldenDir = join(root, 'tools/golden');
mkdirSync(goldenDir, { recursive: true });

const createDoom = (await import(join(root, 'build/doom.js'))).default;

// engine filename → demos (doom.wad is retail: it also carries DEMO4)
const MATRIX = [
    ['doom.wad', 'doomu.wad', ['demo1', 'demo2', 'demo3', 'demo4']],
    ['doom2.wad', 'doom2.wad', ['demo1', 'demo2', 'demo3']],
    ['tnt.wad', 'tnt.wad', ['demo1', 'demo2', 'demo3']],
    ['plutonia.wad', 'plutonia.wad', ['demo1', 'demo2', 'demo3']],
];

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