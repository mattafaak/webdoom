#!/usr/bin/env node
// tools/browser-pipeline-compare.mjs — compare a fresh browser-pipeline.mjs run
// against a committed per-host baseline golden.
//
// Usage:
//   node tools/browser-pipeline-compare.mjs --baseline <golden.json> --current <run.json>
//
// Exits 0 on PASS, 1 on FAIL, 2 on usage error.
//
// Baseline format (tools/golden/browser-pipeline-<host>.json):
//   stages.<name>.run1  — first collection run stats
//   stages.<name>.run2  — second collection run stats
//   (two runs were collected; their spread drives the tolerance band)
//
// Current run format (browser-pipeline.mjs --json output):
//   stages.<name>.<stat>  — single-run stats
//
// Tolerance band derivation:
//   For each stage / stat:
//     observed_spread = |run2_stat - run1_stat|
//     tolerance      = max(observed_spread, MIN_FLOOR) * SAFETY_FACTOR
//     threshold      = max(run1_stat, run2_stat) + tolerance
//   A current value above threshold is a regression → FAIL.
//
// Stages and stats checked (regression direction only):
//   palette       p99   floor=0.1ms factor=3  → threshold 0.4ms
//   upload        p99   floor=0.1ms factor=3  → threshold 0.5ms
//   raf_duration  p99   floor=0.1ms factor=3  → threshold 1.2ms (baseline run1=0.8 run2=0.9)
//   raf_interval  p50   floor=1.0ms factor=3  → threshold ~19.7ms (env-dependent, generous)
//   input_latency p50   floor=0.5ms factor=3  → threshold ~9ms
//   input_latency p99   SKIP — small n (n=35); baseline itself notes high run-to-run variance
//   worklet             SKIP — n=0 in headless; no meaningful comparison
//
// Parameters (constants):
//   MIN_FLOOR_DEFAULT = 0.1  ms — minimum spread floor for stable stages
//   SAFETY_FACTOR     = 3       — multiply spread by 3 for CI tolerance

import { readFileSync } from 'node:fs';

const MIN_FLOOR_DEFAULT = 0.1; // ms
const SAFETY_FACTOR = 3;

// Stages to check: [stage_key, stat_key, min_floor]
// input_latency p99 is intentionally excluded: baseline variance note
// explicitly flags it as unreliable at n=35 due to OS scheduling spikes.
const CHECKS = [
    ['palette',       'p99', 0.1],
    ['upload',        'p99', 0.1],
    ['raf_duration',  'p99', 0.1],
    ['raf_interval',  'p50', 1.0],  // env rAF rate; generous floor
    ['input_latency', 'p50', 0.5],
];

// ── CLI ────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const baselineIdx = args.indexOf('--baseline');
const currentIdx  = args.indexOf('--current');
if (baselineIdx < 0 || currentIdx < 0) {
    console.error('usage: browser-pipeline-compare.mjs --baseline <golden.json> --current <run.json>');
    process.exit(2);
}
const baselinePath = args[baselineIdx + 1];
const currentPath  = args[currentIdx  + 1];

let baseline, current;
try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); }
catch (e) { console.error(`cannot read baseline: ${baselinePath}: ${e.message}`); process.exit(2); }
try { current  = JSON.parse(readFileSync(currentPath,  'utf8')); }
catch (e) { console.error(`cannot read current: ${currentPath}: ${e.message}`);  process.exit(2); }

const bStages = baseline.stages;
const cStages = current.stages;

if (!bStages || !cStages) {
    console.error('FAIL: missing .stages in baseline or current run JSON');
    process.exit(1);
}

// ── Comparison ────────────────────────────────────────────────────────────────
let pass = true;
const rows = [];

for (const [stage, stat, floor] of CHECKS) {
    const bStage = bStages[stage];
    const cStage = cStages[stage];

    if (!bStage?.run1 || !bStage?.run2) {
        rows.push({ stage, stat, status: 'SKIP', reason: 'no run1/run2 in baseline' });
        continue;
    }

    const r1 = bStage.run1[stat];
    const r2 = bStage.run2[stat];

    if (r1 == null || r2 == null) {
        rows.push({ stage, stat, status: 'SKIP', reason: `${stat} null in baseline` });
        continue;
    }

    // If baseline n=0 for this stage, skip (e.g., worklet)
    if (bStage.run1.n === 0) {
        rows.push({ stage, stat, status: 'SKIP', reason: 'n=0 in baseline (headless limitation)' });
        continue;
    }

    const cVal = cStage?.[stat];
    if (cVal == null) {
        rows.push({ stage, stat, status: 'FAIL', reason: `${stat} missing in current run` });
        pass = false;
        continue;
    }

    // Current stage n=0 is a failure only for stages that should have data
    if (cStage?.n === 0 && ['palette', 'upload', 'raf_interval', 'raf_duration', 'input_latency'].includes(stage)) {
        rows.push({ stage, stat, status: 'FAIL',
            reason: `n=0 in current run (stage produced no data)`,
            current: cVal, baseline_r1: r1, baseline_r2: r2 });
        pass = false;
        continue;
    }

    const spread    = Math.abs(r2 - r1);
    const tolerance = Math.max(spread, floor) * SAFETY_FACTOR;
    const threshold = Math.max(r1, r2) + tolerance;

    const ok = cVal <= threshold;
    if (!ok) pass = false;

    rows.push({
        stage, stat,
        status: ok ? 'PASS' : 'FAIL',
        current:   +cVal.toFixed(4),
        baseline_r1: +r1.toFixed(4),
        baseline_r2: +r2.toFixed(4),
        spread:    +spread.toFixed(4),
        tolerance: +tolerance.toFixed(4),
        threshold: +threshold.toFixed(4),
    });
}

// ── Report ─────────────────────────────────────────────────────────────────────
const host    = current.host ?? '(unknown)';
const commit  = current.commit ?? '(unknown)';
const bHost   = baseline.host ?? '(unknown)';

console.log('');
console.log(`browser-pipeline-compare: ${host} vs baseline[${bHost}]  commit=${commit}`);
console.log('');
console.log(`  ${'stage+stat'.padEnd(26)} ${'status'.padEnd(7)} ${'current'.padEnd(10)} ${'thr'.padEnd(10)} ${'baseline_r1'.padEnd(12)} ${'baseline_r2'.padEnd(12)} note`);
console.log(`  ${'-'.repeat(26)} ${'-'.repeat(7)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(12)} ${'-'.repeat(12)} ----`);

for (const r of rows) {
    const key  = `${r.stage}/${r.stat}`;
    if (r.status === 'SKIP') {
        console.log(`  ${key.padEnd(26)} ${'SKIP'.padEnd(7)} ${('—').padEnd(10)} ${('—').padEnd(10)} ${('—').padEnd(12)} ${('—').padEnd(12)} ${r.reason}`);
    } else if (r.status === 'FAIL' && r.current == null) {
        console.log(`  ${key.padEnd(26)} ${'FAIL'.padEnd(7)} ${('missing').padEnd(10)} ${('—').padEnd(10)} ${String(r.baseline_r1).padEnd(12)} ${String(r.baseline_r2).padEnd(12)} ${r.reason ?? ''}`);
    } else {
        const mark = r.status === 'FAIL' ? '  *** REGRESSION ***' : '';
        console.log(`  ${key.padEnd(26)} ${r.status.padEnd(7)} ${String(r.current).padEnd(10)} ${String(r.threshold).padEnd(10)} ${String(r.baseline_r1).padEnd(12)} ${String(r.baseline_r2).padEnd(12)}${mark}`);
    }
}

console.log('');
console.log(`  Tolerance band: max(|run2-run1|, floor) × ${SAFETY_FACTOR}  (floor per stage: palette/upload/raf_duration=0.1ms, raf_interval/p50=1.0ms, input_lat/p50=0.5ms)`);
console.log(`  Skipped: worklet (n=0 headless), input_latency/p99 (small-n; baseline notes 35–61ms run-to-run spread)`);
console.log('');

if (pass) {
    console.log('browser-pipeline-compare: PASS');
    process.exit(0);
} else {
    console.log('browser-pipeline-compare: FAIL — regression detected (see *** above)');
    process.exit(1);
}
