#!/usr/bin/env node
// tools/archaeology/claims-summary.mjs — the claim counts, computed.
//
// WHY THIS EXISTS
// ---------------
// verify-all.sh printed "Coverage: 107 claims checked" from three hand-typed
// constants, and claims.json carried a `_summary` block whose own note reads
// "computed from claims … do not hand-edit".  On 2026-09-11 all four had
// drifted from the manifest they summarise:
//
//     verify-all FULL_CLAIMS  = 29   manifest: runtime-stat 15 + stamp 11 + size 4 = 30
//     verify-all UNVERIFIABLE = 13   manifest: 17   (its header comment said 16)
//     _summary  verified      = 136  manifest: 137
//     an inline comment broke recipe-crack down as 38; the manifest says 40
//
// Nobody gates the gate's own numbers.  This is failure mode #2 — a value that
// reports itself is not the value in force — sitting in the coverage line of
// the instrument built to catch exactly that.
//
// The fast/full tier split is policy, so it lives here, once.  A family with no
// tier is a hard error rather than a silent omission from the coverage line.
//
// usage:
//   node tools/archaeology/claims-summary.mjs --counts  # shell-eval'able vars
//   node tools/archaeology/claims-summary.mjs --check   # _summary == computed
//   node tools/archaeology/claims-summary.mjs --regen   # rewrite _summary
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = join(root, 'tools/archaeology/claims.json');

// Which tier actually runs each family.  Mirrors verify-all.sh's structure:
// the default tier needs only gcc + node + a WAD; the full tier additionally
// needs an instrumented build and a built wasm.
const TIER = {
    'source-constant':   'fast',
    'wad-data':          'fast',
    'recipe-crack':      'fast',
    'derived-check':     'fast',
    'runtime-stat':      'full',
    'measurement-stamp': 'full',
    'size-ledger':       'full',
    'unverifiable':      'none',
};

export function computeSummary() {
    const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const claims = doc.claims;
    const by_family = {}, by_status = {};
    const untiered = new Set();
    for (const id of Object.keys(claims)) {
        const fam = claims[id].family ?? '(none)';
        const st  = claims[id].status ?? '(none)';
        by_family[fam] = (by_family[fam] ?? 0) + 1;
        by_status[st]  = (by_status[st] ?? 0) + 1;
        if (!(fam in TIER)) untiered.add(fam);
    }
    const tierTotal = t => Object.entries(by_family)
        .filter(([f]) => TIER[f] === t)
        .reduce((n, [, c]) => n + c, 0);
    return {
        doc, claims,
        total: Object.keys(claims).length,
        by_family, by_status,
        untiered: [...untiered],
        fast: tierTotal('fast'),
        full: tierTotal('full'),
        unverifiable: tierTotal('none'),
    };
}

const args = process.argv.slice(2);
const mode = args.find(a => a.startsWith('--'));
// computeSummary() is this repo's ONE definition of the tier split, so other
// checks should import it rather than re-derive it -- and one that did got 111
// where the manifest says 107, by forgetting that size-ledger rides in the full
// tier.  Importing was impossible until this guard: the CLI ran at module load,
// so `import { computeSummary }` exited 2 with a usage message.
const RUN_AS_CLI = import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_CLI && (args.length !== 1 || !['--counts', '--check', '--regen'].includes(mode))) {
    console.error('usage: claims-summary.mjs --counts | --check | --regen');
    process.exit(2);
}
if (!RUN_AS_CLI) {
    // imported for computeSummary(); nothing below this point should run
}

const r = RUN_AS_CLI ? computeSummary() : null;
if (RUN_AS_CLI) {

// A family the tier map does not know would vanish from the coverage line
// without changing any number — the silent shape this file exists to prevent.
if (r.untiered.length) {
    console.error(`FAIL claims-summary: family with no tier: ${r.untiered.join(', ')} — add it to TIER`);
    process.exit(1);
}
if (r.total === 0) {
    console.error('FAIL claims-summary: manifest holds 0 claims — vacuous run');
    process.exit(1);
}

if (mode === '--counts') {
    // Consumed by verify-all.sh via eval; keep it strictly assignments.
    console.log(`FAST_CLAIMS=${r.fast}`);
    console.log(`FULL_CLAIMS=${r.full}`);
    console.log(`UNVERIFIABLE=${r.unverifiable}`);
    console.log(`TOTAL_CLAIMS=${r.total}`);
    process.exit(0);
}

const stored = r.doc._summary ?? {};
const computed = {
    total_in_manifest: r.total,
    by_status: r.by_status,
    by_family: r.by_family,
};

if (mode === '--regen') {
    r.doc._summary = { _note: stored._note ?? '', ...computed };
    writeFileSync(MANIFEST, JSON.stringify(r.doc, null, 2) + '\n');
    console.log(`regenerated _summary: ${r.total} claims, ` +
                Object.entries(r.by_status).map(([k, v]) => `${k}=${v}`).join(' '));
    process.exit(0);
}

// --check
const diffs = [];
// Order-insensitive: these are count maps, not sequences.  Comparing raw
// JSON.stringify would report a key-insertion difference as drift and train the
// reader to ignore the check — the way to kill a gate is to make it cry wolf.
const norm = v => (v && typeof v === 'object' && !Array.isArray(v))
    ? JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)))
    : JSON.stringify(v);
const show = v => norm(v);
const cmp = (label, a, b) => {
    if (norm(a) !== norm(b))
        diffs.push(`  ${label}: _summary says ${show(a)}, manifest computes ${show(b)}`);
};
cmp('total_in_manifest', stored.total_in_manifest, computed.total_in_manifest);
cmp('by_status', stored.by_status, computed.by_status);
cmp('by_family', stored.by_family, computed.by_family);
if (diffs.length) {
    console.log('FAIL claims.json _summary has drifted from the claims it summarises:');
    console.log(diffs.join('\n'));
    console.log('  Regenerate: node tools/archaeology/claims-summary.mjs --regen');
    process.exit(1);
}
console.log(`PASS claims _summary matches the manifest (${r.total} claims: ` +
            `fast ${r.fast}, full ${r.full}, unverifiable ${r.unverifiable})`);

}   // RUN_AS_CLI
