#!/usr/bin/env node
// tools/fuzz/run-map-fuzz.mjs — map-mutation differential fuzzer.
//
// For each seed, gen-map.mjs produces a PWAD that replaces E1M1 in doom.wad
// with a procedurally mutated copy (non-geometry fields only — see gen-map.mjs
// for the mutation policy).  The mutated map is then exercised in:
//
//   nat-doom (ASan/UBSan, -m32)  — map loader + 35 idle tics; any OOB read
//                                   causes a sanitizer crash (exit ≠ 0).
//   webdoom (wasm)               — same PWAD + idle timedemo; errors surface
//                                   as wasm exit or onDoomError callback.
//
// Tier reached:
//   (a) Full per-tic wasm-vs-native diff — if nat-doom binary exists and
//       both engines complete the 35-tic idle demo without error.
//   (c) ASan-load-only — if only nat-doom is checked (no per-tic wasm diff).
//
// Since nat-doom is now built (tools/native-sanitize/nat-doom), this run
// performs tier (a): per-tic hash comparison wasm-vs-native on every seed.
//
// Two runs: benign (--seeds-benign, default 75) + adversarial (--seeds-adversarial, default 30).
//
// Usage:
//   node tools/fuzz/run-map-fuzz.mjs [--seeds-benign N] [--seeds-adversarial N]
//                                     [--parallel J] [--build-dir DIR]
//
// Exit: 0 = no divergences/crashes; 1 = any finding found.

import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir, cpus } from 'node:os';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── args ──────────────────────────────────────────────────────────────────────
let seedsBenign = 75;
let seedsAdversarial = 30;
let buildDir = 'build';
let parallelism = Math.min(4, Math.max(1, Math.ceil(cpus().length / 4)));
// --adversarial-gate: run adversarial seeds only, exit 0 iff ALL results are
// clean or I_Error exits (fail-soft); exit 1 if ANY ASan/UBSan report.
// This is the re-runnable yes/no check wired into the CI gate (task 12.3).
let adversarialGate = false;
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--seeds-benign' && process.argv[i + 1]) {
        seedsBenign = Number(process.argv[++i]);
    } else if (process.argv[i] === '--seeds-adversarial' && process.argv[i + 1]) {
        seedsAdversarial = Number(process.argv[++i]);
    } else if (process.argv[i] === '--parallel' && process.argv[i + 1]) {
        parallelism = Number(process.argv[++i]);
    } else if (process.argv[i] === '--build-dir' && process.argv[i + 1]) {
        buildDir = process.argv[++i];
    } else if (process.argv[i] === '--adversarial-gate') {
        adversarialGate = true;
    } else {
        console.error(`FATAL: unknown argument '${process.argv[i]}'`);
        console.error('usage: run-map-fuzz.mjs [--seeds-benign N] [--seeds-adversarial N] [--parallel J] [--build-dir DIR] [--adversarial-gate]');
        process.exit(2);
    }
}

// In --adversarial-gate mode: run adversarial seeds only; skip benign.
if (adversarialGate) {
    seedsBenign = 0;
}

// Gate mode REQUIRES the native sanitizer build: without nat-doom the run
// silently downgrades to tier (c) wasm-only detection, no sanitizer can fire,
// and the gate would pass vacuously (the 9.1b weak-oracle failure mode).
if (adversarialGate && !existsSync(join(root, 'tools/native-sanitize/nat-doom'))) {
    console.error('GATE FAIL: --adversarial-gate requires the nat-doom ASan build (the sanitizer IS the gate).');
    console.error('Build it: make -C tools/native-sanitize');
    process.exit(1);
}

const { genMutatedMap } = await import('./gen-map.mjs');
const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;

// ── paths ─────────────────────────────────────────────────────────────────────
const NAT_DOOM = join(root, 'tools/native-sanitize/nat-doom');
const IWAD_PATH = join(root, 'wads/lib/doom.wad');  // doom.wad for E1M1
const IWAD_NAME = 'doom.wad';
const PWAD_NAME = 'mapfuzz.wad';
const DEMO_LUMP = 'FUZZDEMO';

if (!existsSync(IWAD_PATH)) {
    console.error(`FATAL: ${IWAD_PATH} not found`);
    process.exit(1);
}

const natAvailable = existsSync(NAT_DOOM);
if (!natAvailable) {
    console.warn('WARNING: nat-doom not found — running tier (c) wasm-only crash detection.');
    console.warn('Build nat-doom: make -C tools/native-sanitize');
}
const tierLabel = natAvailable ? 'a (per-tic wasm-vs-native diff)' : 'c (wasm-load-only + crash check)';

// ── wasm per-tic trace ────────────────────────────────────────────────────────
async function runWasm(pwadBytes) {
    const iwadBytes = readFileSync(IWAD_PATH);
    let done = null;
    let errorMsg = null;

    const doom = await createDoom({
        print: () => {},
        printErr: (t) => {
            const m = /timed (\d+) gametics/.exec(t);
            if (m) done = +m[1];
        },
        onDoomError: (msg) => {
            if (!/timed \d+ gametics/.test(msg)) {
                errorMsg = msg;
                done = `error: ${msg}`;
            }
        },
    });

    // Register IWAD
    {
        const p = doom._malloc(iwadBytes.length);
        doom.HEAPU8.set(iwadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'],
            [IWAD_NAME, p, iwadBytes.length]);
    }

    // Register PWAD
    {
        const p = doom._malloc(pwadBytes.length);
        doom.HEAPU8.set(pwadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'],
            [PWAD_NAME, p, pwadBytes.length]);
    }

    const trace = [];
    try {
        doom.callMain(['-file', PWAD_NAME, '-timedemo', DEMO_LUMP, '-nodraw']);
        let lastTic = -1;
        for (let i = 0; i < 50000 && done === null; i++) {
            doom._web_frame();
            const tic = doom._web_gametic();
            if (tic !== lastTic) {
                trace.push(doom._web_state_hash() >>> 0);
                lastTic = tic;
            }
        }
    } catch (_e) {
        // I_Error throws after writing "timed N gametics"; done is set.
    }

    if (typeof done !== 'number') {
        const reason = errorMsg ?? (done ?? 'timeout');
        throw new Error(`wasm load/play failed: ${reason}`);
    }
    return { tics: done, trace };
}

// ── nat-doom per-tic trace ────────────────────────────────────────────────────
function runNative(pwadBytes, seed) {
    return new Promise((resolve, reject) => {
        const tmpDir = join(tmpdir(), `webdoom-mapfuzz-${process.pid}-${seed}`);
        mkdirSync(tmpDir, { recursive: true });

        const cleanup = () => {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        };

        try {
            symlinkSync(IWAD_PATH, join(tmpDir, IWAD_NAME));
            writeFileSync(join(tmpDir, PWAD_NAME), pwadBytes);
        } catch (e) {
            cleanup();
            return reject(e);
        }

        const simOut = join(tmpDir, 'sim.json');
        const child = spawn(
            NAT_DOOM,
            // -nodraw so the comparison is SYMMETRIC with the wasm side (which
            // also runs -nodraw). Without it, nat-doom renders and wasm does
            // not, so an ASan hit in the render path (e.g. R_DrawMaskedColumn)
            // reads as a false "nat crashes, wasm OK divergence" when it is
            // really "wasm never executed that code". 9.3 is a map-LOAD + sim
            // differential; render-path fuzzing is out of scope (the render
            // goldens + the 9.1 demo fuzzer already cover the render path for
            // valid inputs). ASan still catches map-load OOB (P_SetupLevel,
            // P_GroupLines) — those run before D_Display regardless of -nodraw.
            ['-waddir', tmpDir, '-file', PWAD_NAME, '-timedemo', DEMO_LUMP, '-nodraw', '-sim', simOut],
            {
                env: {
                    ...process.env,
                    ASAN_OPTIONS: 'halt_on_error=1:print_stats=0',
                    UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
                },
            }
        );

        const stderrChunks = [];
        child.stderr.on('data', (d) => stderrChunks.push(d));

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            cleanup();
            reject(new Error('nat-doom timed out (60s)'));
        }, 60000);

        child.on('close', (code) => {
            clearTimeout(timer);
            const stderr = Buffer.concat(stderrChunks).toString();
            try {
                if (code !== 0) {
                    // Exit ≠ 0 may mean ASan/UBSan caught a sanitizer error, or I_Error.
                    // Preserve first 500 chars of stderr for the finding report.
                    const trace = stderr.slice(0, 500).replace(/\n/g, ' | ');
                    return reject(new Error(`nat-doom crashed (exit ${code}): ${trace}`));
                }
                if (!existsSync(simOut)) {
                    return reject(new Error('nat-doom did not write sim.json'));
                }
                const sim = JSON.parse(readFileSync(simOut, 'utf8'));
                resolve({ tics: sim.tics, trace: sim.trace });
            } catch (e) {
                reject(e);
            } finally {
                cleanup();
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            cleanup();
            reject(err);
        });
    });
}

// ── trace comparison ──────────────────────────────────────────────────────────
function compareTraces(wasm, native) {
    const minLen = Math.min(wasm.trace.length, native.trace.length);
    for (let i = 0; i < minLen; i++) {
        if ((wasm.trace[i] >>> 0) !== (native.trace[i] >>> 0)) {
            return {
                diverged: true,
                tic: i,
                wasm: (wasm.trace[i] >>> 0).toString(16).padStart(8, '0'),
                native: (native.trace[i] >>> 0).toString(16).padStart(8, '0'),
            };
        }
    }
    if (wasm.trace.length !== native.trace.length) {
        return {
            diverged: true,
            tic: minLen,
            wasm: `length ${wasm.trace.length}`,
            native: `length ${native.trace.length}`,
        };
    }
    return { diverged: false };
}

// ── reproducibility check ─────────────────────────────────────────────────────
function checkReproducibility(seed, adversarial) {
    const a = genMutatedMap(seed, { adversarial }).pwad;
    const b = genMutatedMap(seed, { adversarial }).pwad;
    const ha = createHash('sha256').update(a).digest('hex');
    const hb = createHash('sha256').update(b).digest('hex');
    if (ha !== hb) throw new Error(`seed ${seed} not reproducible: ${ha} vs ${hb}`);
    return ha;
}

// ── classify crash message ────────────────────────────────────────────────────
function classifyCrash(errMsg) {
    if (errMsg.includes('AddressSanitizer') || errMsg.includes('SUMMARY: Address') ||
        errMsg.includes('heap-buffer-overflow') || errMsg.includes('stack-buffer-overflow') ||
        errMsg.includes('global-buffer-overflow')) {
        return 'ASan';
    }
    if (errMsg.includes('runtime error') || errMsg.includes('UBSan') ||
        errMsg.includes('undefined behavior')) {
        return 'UBSan';
    }
    // I_Error + abort() via P_GroupLines or other engine checks
    const ierrMatch = errMsg.match(/I_Error: ([^\|]+)/);
    if (ierrMatch) return `I_Error(${ierrMatch[1].trim()})`;
    return 'crash';
}

// ── per-seed runner ───────────────────────────────────────────────────────────
async function runSeed(seed, adversarial) {
    const label = adversarial ? `adv-${seed}` : `${seed}`;
    const { pwad, mutations } = genMutatedMap(seed, { adversarial });
    const mutStr = mutations.join('; ') || '(none)';

    if (!natAvailable) {
        // Tier (c): wasm-only crash detection
        try {
            const wasmResult = await runWasm(pwad);
            return { label, ok: true, msg: `seed ${label}: wasm OK, ${wasmResult.tics} tics [${mutStr}]` };
        } catch (e) {
            return { label, ok: false, crash: true,
                     msg: `seed ${label}: WASM CRASH — ${e.message} [${mutStr}]`,
                     finding: { seed: label, field: mutStr, trace_or_hashes: e.message,
                                root_cause: 'wasm load/play failed — possible map-load UB or I_Error' } };
        }
    }

    // Tier (a): full per-tic wasm-vs-native differential

    // Run nat-doom first (ASan/UBSan catches loader UB immediately)
    let nativeResult;
    let natCrashed = false;
    let natErrMsg = '';
    try {
        nativeResult = await runNative(pwad, `${seed}-${adversarial ? 'adv' : 'ben'}`);
    } catch (e) {
        natCrashed = true;
        natErrMsg = e.message;
    }

    // Always run wasm too, even if nat-doom crashed (to detect divergences in failure mode)
    let wasmResult;
    let wasmCrashed = false;
    let wasmErrMsg = '';
    try {
        wasmResult = await runWasm(pwad);
    } catch (e) {
        wasmCrashed = true;
        wasmErrMsg = e.message;
    }

    if (natCrashed && wasmCrashed) {
        // Both crash — consistent failure, categorize the nat-doom crash type
        const crashType = classifyCrash(natErrMsg);
        return { label, ok: false, crash: true,
                 msg: `seed ${label}: BOTH CRASH (${crashType}) — nat=${natErrMsg.slice(0, 80)} [${mutStr}]`,
                 finding: { seed: label, field: mutStr,
                            trace_or_hashes: natErrMsg.slice(0, 400),
                            root_cause: crashType.startsWith('ASan') || crashType.startsWith('UBSan')
                                ? `${crashType} sanitizer triggered during map load — OOB memory access`
                                : `Both engines crash: ${crashType}. OOB sidedef sector index corrupts bookkeeping → engine I_Error → abort(). ASan silent because access stays within Z_Zone pool.` } };
    }

    if (natCrashed && !wasmCrashed) {
        // nat-doom crashes, wasm survives — interesting divergence in failure mode
        const crashType = classifyCrash(natErrMsg);
        return { label, ok: false, diverged: true,
                 msg: `seed ${label}: DIVERGENCE IN FAILURE — nat-doom ${crashType}, wasm OK ${wasmResult.tics} tics [${mutStr}]`,
                 finding: { seed: label, field: mutStr,
                            trace_or_hashes: `nat: ${natErrMsg.slice(0, 200)} | wasm: ${wasmResult.tics} tics`,
                            root_cause: `nat-doom's sanitizer (${crashType}) traps on an OOB/UB read from this deliberately-malformed map; wasm (no sanitizer, linear memory has no trap page) reads garbage and continues. This is the expected sanitizer-vs-release difference on INVALID input, not a valid-map sim divergence — see the unguarded-index surface in divergence-atlas.md F5c.` } };
    }

    if (!natCrashed && wasmCrashed) {
        // wasm crashes, nat-doom survives — interesting divergence
        return { label, ok: false, diverged: true,
                 msg: `seed ${label}: DIVERGENCE IN FAILURE — wasm crash, nat-doom OK ${nativeResult.tics} tics [${mutStr}]`,
                 finding: { seed: label, field: mutStr,
                            trace_or_hashes: `wasm: ${wasmErrMsg.slice(0, 200)} | nat: ${nativeResult.tics} tics`,
                            root_cause: 'wasm crashes but nat-doom survives — emscripten stricter than ASan on this mutation' } };
    }

    // Both completed — compare per-tic hashes
    const cmp = compareTraces(wasmResult, nativeResult);
    if (cmp.diverged) {
        const hashes = typeof cmp.wasm === 'string' && cmp.wasm.startsWith('length')
            ? `trace length mismatch: wasm=${cmp.wasm} native=${cmp.native}`
            : `tic ${cmp.tic}: wasm=0x${cmp.wasm} native=0x${cmp.native}`;
        return { label, ok: false, diverged: true,
                 msg: `seed ${label}: DIVERGED at ${hashes} [${mutStr}]`,
                 finding: { seed: label, field: mutStr,
                            trace_or_hashes: hashes,
                            root_cause: 'per-tic hash mismatch between wasm and nat-doom — investigate web_state_hash vs nat_state_hash inputs' } };
    }

    return { label, ok: true, msg: `seed ${label}: ${wasmResult.tics} tics OK, hashes identical [${mutStr}]` };
}

// ── parallel pool runner ──────────────────────────────────────────────────────
async function runPool(seeds, adversarial) {
    const results = new Array(seeds.length);
    let next = 0;

    async function worker() {
        while (true) {
            const idx = next++;
            if (idx >= seeds.length) break;
            const r = await runSeed(seeds[idx], adversarial);
            console.log(' ', r.msg);
            results[idx] = r;
        }
    }

    const workers = Array.from({ length: Math.min(parallelism, seeds.length) }, worker);
    await Promise.all(workers);
    return results;
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`webdoom map-mutation fuzzer`);
console.log(`  tier: ${tierLabel}`);
console.log(`  IWAD: ${IWAD_NAME} (doom.wad, E1M1)`);
console.log(`  demo: 35 tics idle at E1M1 spawn`);
console.log(`  benign seeds: ${seedsBenign}, adversarial seeds: ${seedsAdversarial}`);
console.log(`  parallel: ${parallelism}`);
console.log(`  geometry excluded: VERTEXES/SEGS/SSECTORS/NODES/BLOCKMAP (no node rebuild needed)`);
console.log();

// Reproducibility check
const reproHashBenign = checkReproducibility(0, false);
const reproHashAdv = checkReproducibility(0, true);
console.log(`reproducibility (benign  seed 0): sha256=${reproHashBenign.slice(0, 16)}... ✓`);
console.log(`reproducibility (adversarial 0):  sha256=${reproHashAdv.slice(0, 16)}... ✓`);
console.log();

const findings = [];

// ── benign run ────────────────────────────────────────────────────────────────
if (seedsBenign > 0) {
    const benignSeeds = Array.from({ length: seedsBenign }, (_, i) => i);
    console.log(`── benign seeds (${seedsBenign}) ──────────────────────────────────────────────`);
    const benignResults = await runPool(benignSeeds, false);
    console.log();

    for (const r of benignResults) {
        if (!r.ok && r.finding) findings.push(r.finding);
    }

    const benignFails = benignResults.filter(r => !r.ok).length;
    console.log(`benign summary: ${seedsBenign - benignFails}/${seedsBenign} OK, ${benignFails} finding(s)`);
    console.log();
}

// ── adversarial run ───────────────────────────────────────────────────────────
if (seedsAdversarial > 0) {
    // Use seed offset 10000 to separate from benign seeds
    const advSeeds = Array.from({ length: seedsAdversarial }, (_, i) => 10000 + i);
    console.log(`── adversarial seeds (${seedsAdversarial}) ─────────────────────────────────────`);
    const advResults = await runPool(advSeeds, true);
    console.log();

    for (const r of advResults) {
        if (!r.ok && r.finding) findings.push(r.finding);
    }

    const advFails = advResults.filter(r => !r.ok).length;
    console.log(`adversarial summary: ${seedsAdversarial - advFails}/${seedsAdversarial} OK, ${advFails} finding(s)`);
    console.log();
}

// ── overall summary ───────────────────────────────────────────────────────────
const totalSeeds = seedsBenign + seedsAdversarial;
console.log('─────────────────────────────────────────────────────────────────');

if (adversarialGate) {
    // Gate mode: distinguish sanitizer findings (fail) from I_Error (pass).
    // The rule: I_Error exits are fail-soft (allowed); ASan/UBSan memory
    // corruption reports are NOT allowed and exit 1.
    //
    // Discrimination: real sanitizer root_cause strings contain the literal
    // phrases "sanitizer triggered", "sanitizer traps", or "sanitizer (ASan)"
    // (generated by the classifyCrash path and the DIVERGENCE IN FAILURE case).
    // I_Error root_cause strings say "Both engines crash: I_Error(...)" and may
    // mention "ASan silent" (meaning NO ASan report fired) — do NOT match those.
    const isSanitizerHit = rc =>
        rc.includes('sanitizer triggered') ||
        rc.includes('sanitizer traps') ||
        rc.includes('sanitizer (ASan)') ||
        rc.includes('sanitizer (UBSan)');
    const sanitizerFindings = findings.filter(f => isSanitizerHit(f.root_cause ?? ''));
    const ierrFindings = findings.filter(f => !isSanitizerHit(f.root_cause ?? ''));

    if (sanitizerFindings.length > 0) {
        console.log(`\nGATE FAIL: ${sanitizerFindings.length} sanitizer report(s) — memory corruption on adversarial input`);
        for (const f of sanitizerFindings) {
            console.log(`  seed=${f.seed} field=${f.field}`);
            console.log(`  trace/hashes: ${f.trace_or_hashes.slice(0, 200)}`);
            console.log(`  root_cause: ${f.root_cause}`);
            console.log();
        }
        if (ierrFindings.length > 0)
            console.log(`  (${ierrFindings.length} I_Error result(s) are pass — fail-soft as expected)`);
        process.exit(1);
    } else {
        const clean = seedsAdversarial - findings.length;
        const ierr = ierrFindings.length;
        console.log(`\nGATE PASS: adversarial corpus = ${clean} clean + ${ierr} I_Error, 0 sanitizer reports`);
        console.log(`  Command: node tools/fuzz/run-map-fuzz.mjs --adversarial-gate [--build-dir DIR]`);
        console.log('  Rule: I_Error exits are fail-soft (allowed); ASan/UBSan reports are not.');
        process.exit(0);
    }
}

if (findings.length === 0) {
    console.log(`\nPASS: map-load behavior matches vanilla under ${totalSeeds} mutations`);
    console.log(`  (${seedsBenign} benign + ${seedsAdversarial} adversarial seeds, tier ${tierLabel})`);
    console.log('  geometry excluded: VERTEXES/SEGS/SSECTORS/NODES/BLOCKMAP (no node rebuild)');
    process.exit(0);
} else {
    console.log(`\nFINDING(S): ${findings.length} divergence(s)/crash(es) detected`);
    for (const f of findings) {
        console.log(`  seed=${f.seed} field=${f.field}`);
        console.log(`  trace/hashes: ${f.trace_or_hashes.slice(0, 200)}`);
        console.log(`  root_cause: ${f.root_cause}`);
        console.log();
    }
    process.exit(1);
}
