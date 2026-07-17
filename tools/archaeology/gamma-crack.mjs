#!/usr/bin/env node
// gamma-crack.mjs — verifies gamma table mismatch counts from engine/core/v_video.c.
//
// Doom's gamma table is a hand-authored 5×256 byte lookup.
// engine-archaeology.md §4 claims specific residual mismatch counts when each
// level is fit to  round(255 · ((i+0.5)/256) ^ (1/γ))  at 0.001-step best-fit γ.
//
// FINDING-3 (ea-014): level-4 actual minimum is 34 mismatches (γ≈2.011),
// not 51 as claimed. All other levels verify correctly (ea-010..ea-013).
//
// Usage: node tools/archaeology/gamma-crack.mjs
// Exits 0 if ea-010..ea-013 pass (ea-014 is a known finding, reported but not fatal).
// Exits 1 if ea-010..ea-013 disagree with the formula.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// ── Parse gamma table from v_video.c ────────────────────────────────────────

const src = readFileSync(join(root, 'engine/core/v_video.c'), 'utf8');
const m = src.match(/byte\s+gammatable\[5\]\[256\]\s*=\s*\{([\s\S]*?)\};/);
if (!m) { console.error('Could not find gammatable in v_video.c'); process.exit(2); }

const nums = m[1].match(/\d+/g).map(Number);
if (nums.length !== 5 * 256) {
    console.error(`Expected 1280 entries, got ${nums.length}`);
    process.exit(2);
}

const table = [];
for (let lv = 0; lv < 5; lv++) {
    table.push(nums.slice(lv * 256, (lv + 1) * 256));
}

// ── Best-fit γ sweep (0.001 step, matching doc methodology) ──────────────────

function sweepBestFit(lv) {
    let best = 256, bg = 1.0;
    for (let dg = 500; dg <= 5000; dg++) {
        const g = dg / 1000;
        let c = 0;
        for (let i = 0; i < 256; i++) {
            const pred = Math.round(255.0 * Math.pow((i + 0.5) / 256.0, 1.0 / g));
            if (table[lv][i] !== pred) c++;
        }
        if (c < best) { best = c; bg = g; }
    }
    return { gamma: bg, mismatches: best };
}

// ── Expected mismatch counts (engine-archaeology.md §4) ───────────────────────
// All five levels are the true minima of a 0.001-step γ sweep.
// FINDING-3 (RESOLVED, task 6.2): the doc's level-4 row claimed γ~2.01 → 51,
// which matches no γ near 2.01 (2.010→42, 2.011→34, 2.015→50 — the fit is a
// sharp cliff). Levels 0-3's counts already matched their true minima, so only
// the level-4 row was wrong; the doc is now corrected to γ≈2.011 → 34/256 and
// every level is checked here as a first-class assertion (no exemptions).

const claimIds  = ['ea-010', 'ea-011', 'ea-012', 'ea-013', 'ea-014'];
const claimedMM = [       5,       34,       36,       41,       34];

let failures = 0;
const claimActuals = {};
for (let lv = 0; lv < 5; lv++) {
    const { gamma, mismatches } = sweepBestFit(lv);
    const exp  = claimedMM[lv];
    const pass = (mismatches === exp);
    if (!pass) failures++;
    claimActuals[claimIds[lv]] = String(mismatches);

    console.log(`${pass ? 'PASS' : 'FAIL'}  ${claimIds[lv]}  gamma level-${lv} γ≈${gamma.toFixed(3)} residual mismatches=${mismatches}/256 expected=${exp}`);
    if (!pass) {
        console.log(`      actual best-fit γ=${gamma.toFixed(4)} gives ${mismatches}, doc claims ${exp}`);
    }
}

console.log(`\ngamma-crack: ${5 - failures}/5 passed (failures=${failures})`);
console.log(`CLAIMS_JSON ${JSON.stringify(claimActuals)}`);
if (failures > 0) {
    console.log('ERROR: gamma table fit disagrees with engine-archaeology.md §4');
    process.exit(1);
}
