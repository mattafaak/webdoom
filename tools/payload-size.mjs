#!/usr/bin/env node
// payload-size.mjs — what a page load actually costs on the wire (prf-002/003).
//
// perf.md published "177.7 KB gzip" total and "35 KB gzip" for the JS+CSS+HTML
// surface, both marked *(not machine-verified: no current CI script)*, and
// perf-015/perf-016 sat "unverifiable" in claims.json. Nothing recomputed them
// for months and the app grew: the per-file table still listed
// client/js/settings.js, which round 7 DELETED, and omitted wad-import, demo,
// scrubber, mus2mid, sf2-library, idb, wad-library, ui and wad-cache. Measured
// here, the surface is ~2.6x the published figure.
//
// The file set is DERIVED from sw.js's SHELL_FILES -- the same list
// check-sw-precache already gates both ways -- so a file added to the app shell
// joins this measurement with no edit here. A typed list is what went stale.
//
// usage: node tools/payload-size.mjs [--record]
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(root, 'tools/archaeology/claims.json');
const record = process.argv.includes('--record');

const sw = readFileSync(join(root, 'client/sw.js'), 'utf8');
const m = sw.match(/const SHELL_FILES = \[([\s\S]*?)\];/);
if (!m) { console.log('FAIL payload-size: could not find SHELL_FILES in client/sw.js'); process.exit(1); }
const shell = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);

// The server maps two shell URLs outside client/: the engine is built, not
// checked in, and "/" is the index document.
const resolve = url =>
      url === '/'                 ? join(root, 'client/index.html')
    : url.startsWith('/engine/')  ? join(root, 'build', url.slice('/engine/'.length))
    :                               join(root, 'client', url.replace(/^\//, ''));

const rows = [];
const missing = [];
for (const url of shell) {
    const p = resolve(url);
    if (!existsSync(p) || !statSync(p).isFile()) { missing.push(url); continue; }
    const buf = readFileSync(p);
    rows.push({ url, raw: buf.length, gz: gzipSync(buf, { level: 9 }).length,
                engine: url.startsWith('/engine/') });
}
if (missing.length) {
    console.log(`FAIL payload-size: ${missing.length} shell entr(ies) do not resolve to a file: ${missing.join(', ')}`);
    console.log('    (build the engine first: source tools/emsdk-env.sh && make -C engine)');
    process.exit(1);
}
// A run over a nearly-empty shell must not read as a small payload.
if (rows.length < 15) {
    console.log(`FAIL payload-size: only ${rows.length} shell file(s) resolved; the app shell is larger than that`);
    process.exit(1);
}

const sum = (f, pick = () => true) => rows.filter(pick).reduce((n, r) => n + r[f], 0);
const totalGz   = sum('gz');
const surfaceGz = sum('gz', r => !r.engine);          // JS + CSS + HTML, no wasm/glue
const totalKB   = Math.round(totalGz / 1024 * 10) / 10;
const surfaceKB = Math.round(surfaceGz / 1024 * 10) / 10;

rows.sort((a, b) => b.gz - a.gz);
for (const r of rows) console.log(`  ${String(r.gz).padStart(7)}  ${String(r.raw).padStart(8)}  ${r.url}`);
console.log(`  total ${rows.length} files: ${totalGz} B gzip (${totalKB} KB); ` +
            `surface ${surfaceGz} B (${surfaceKB} KB)`);

const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (record) {
    for (const [id, val, note] of [
        ['perf-015', String(totalKB),   'total wire payload per page load, KB gzip -9'],
        ['perf-016', String(surfaceKB), 'JS+CSS+HTML surface only (no wasm, no glue), KB gzip -9'],
    ]) {
        doc.claims[id] = { family: 'size-ledger', command: 'node tools/payload-size.mjs',
            expected: val, status: 'verified',
            notes: `${note}. Derived from sw.js SHELL_FILES, so the app shell defines the set. ` +
                   `Was "unverifiable" until round 8 (prf-002/003); the published figures had gone ` +
                   `badly stale -- the surface was 2.6x its documented 35.1 KB.` };
    }
    writeFileSync(MANIFEST, JSON.stringify(doc, null, 2) + '\n');
    console.log(`recorded perf-015=${totalKB} perf-016=${surfaceKB} into claims.json`);
    process.exit(0);
}

// A budget, not a pin: these move with every commit, so grade a CEILING.
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) bad++; };
for (const [id, actual, label] of [
    ['perf-015', totalKB,   'total wire payload'],
    ['perf-016', surfaceKB, 'JS+CSS+HTML surface'],
]) {
    const want = Number(doc.claims[id]?.expected);
    if (!Number.isFinite(want)) { check(false, `${id}: no expected value in claims.json`); continue; }
    const ceiling = Math.round(want * 1.1 * 10) / 10;     // 10% headroom
    check(actual <= ceiling, `${id} ${label}: ${actual} KB within ${ceiling} KB (10% over the ${want} KB stamp)`);
}
// verify-all.sh scrapes this footer to make doc-drift a THREE-way check. Without
// it perf-015/016 are compared doc-vs-manifest only, and --require-script-values
// calls that a defect rather than a skip -- which is how this omission was caught.
console.log(`CLAIMS_JSON ${JSON.stringify({ 'perf-015': String(totalKB), 'perf-016': String(surfaceKB) })}`);
if (bad) { console.log(`payload-size: ${bad} budget(s) exceeded — re-measure and restamp deliberately`); process.exit(1); }
console.log(`PASS — payload-size: ${rows.length} shell files, total ${totalKB} KB gzip, ` +
            `surface ${surfaceKB} KB (2 budgets)`);
