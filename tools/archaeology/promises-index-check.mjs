#!/usr/bin/env node
// tools/archaeology/promises-index-check.mjs — the promises index must not go
// stale, because it is the thing that enforces tenet 6 for everything else.
//
// spec.md: "every quantitative or behavioral claim in README.md and this spec
// maps to a gate, committed evidence, or an explicit FLAGGED entry — a promise
// without a gate is doc drift."  docs/promises-index.md is where that mapping
// lives, and nothing checked IT.  At task 24.1 it was six changes behind:
//
//   * it quoted README as "351 KB of wasm"; README said 349
//   * rme-002 said Firefox was untested in CI; a firefox-smoke leg had existed
//     since 15.2
//   * rme-003 said "no test flips F8"; browser-qol-test presses it and asserts
//     the panel opens
//   * rme-005 flagged a sw.js precache bug that had been fixed
//   * rme-010 tracked a T07 flake fixed in 9ed9671
//   * its header said "5 gated, 8 evidenced, 15 flagged" while its own summary
//     said "5 gated, 10 evidenced, 13 flagged"
//
// A stale index is worse than none: it makes a covered promise look uncovered
// and an uncovered one look handled.  Re-checking every row by hand is what
// 24.1 did; this keeps the mechanical parts from drifting again.
//
// usage: node tools/archaeology/promises-index-check.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root  = join(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = join(root, 'docs/promises-index.md');
const text  = readFileSync(INDEX, 'utf8');
const runTests = readFileSync(join(root, 'tools/run-tests.sh'), 'utf8');

const cells = l => l.split(/(?<!\\)\|/).map(c => c.trim());
// Parts A, B and D are five-column tables; Part C (the perf.md figures) has a
// sixth column for the inline reason.  `c.length === 6` therefore matched A, B
// and D and dropped ALL TEN Part C rows -- silently, so this check reported
// "34 promises" over a table of 44 and the document's own summary counted the
// same section two different ways.  Take the disposition from the last cell and
// the section shape stops mattering.
const rows = [];
let part = '?';
for (const line of text.split('\n')) {
    const pm = /^## Part ([A-D])\b/.exec(line);
    if (pm) { part = pm[1]; continue; }
    if (!/^\|\s*[a-z]+-\d+\s*\|/.test(line)) continue;
    const c = cells(line);
    if (c.length < 6) continue;
    rows.push({ id: c[1], source: c[2], promise: c[3], disp: c[c.length - 2], part });
}

let bad = 0;
const fail = (w, d) => { console.log(`FAIL ${w}`); if (d) console.log(d); bad++; };

if (rows.length < 20) {
    console.log(`FAIL promises-index: parsed only ${rows.length} rows — the parser or the table changed.`);
    process.exit(1);
}

// 1. Every disposition must open with a word from the vocabulary.  "it depends"
//    written four different ways is how the counts drifted apart.
const VOCAB = ['GATED', 'PARTIAL', 'FLAGGED', 'EVIDENCED', 'RESOLVED', 'UNGATEABLE'];
const odd = rows.filter(r => !VOCAB.some(v => r.disp.startsWith(`**${v}`)));
if (odd.length) fail(`promises-index: ${odd.length} row(s) do not open with a known disposition`,
    odd.map(r => `    ${r.id}: ${r.disp.slice(0, 60)}`).join('\n') +
    `\n  vocabulary: ${VOCAB.join(', ')}`);

// 2. The README size figure this index quotes must be the one README states.
const quoted = /\|\s*rme-001\s*\|[^|]*\|\s*"(\d+) KB of wasm"/.exec(text);
const actual = /(\d+) KB of wasm/.exec(readFileSync(join(root, 'README.md'), 'utf8'));
if (!quoted) fail('promises-index: rme-001 no longer quotes a "N KB of wasm" figure to check');
else if (!actual) fail('promises-index: README.md no longer states "N KB of wasm"');
else if (quoted[1] !== actual[1])
    fail(`promises-index: rme-001 quotes "${quoted[1]} KB of wasm"; README.md says "${actual[1]} KB"`);

// 3. A disposition that names a suite leg must name one that exists.  This is
//    the drift that made rme-002 and rme-003 wrong: the gate arrived, the row
//    did not hear about it.
const legs = new Set([...runTests.matchAll(/^\s*leg\s+([a-z0-9-]+)\s/gm)].map(m => m[1]));
const missingLegs = new Map();
for (const r of rows)
    for (const m of r.disp.matchAll(/`([a-z0-9-]+)`\s+leg/g))
        if (!legs.has(m[1])) (missingLegs.get(m[1]) ?? missingLegs.set(m[1], []).get(m[1])).push(r.id);
if (missingLegs.size) fail(`promises-index: ${missingLegs.size} named leg(s) are not in the suite`,
    [...missingLegs].map(([l, who]) => `    ${l}  (cited by ${who.join(', ')})`).join('\n'));

// 4. A disposition that names a tool must name one that exists.
const missingTools = new Map();
for (const r of rows)
    for (const m of r.disp.matchAll(/`([\w-]+\.(?:mjs|sh|js))(?::\d+)?`/g))
        if (!['', 'tools/', 'tools/archaeology/', 'client/js/', 'server/']
                .some(p => existsSync(join(root, p + m[1]))))
            (missingTools.get(m[1]) ?? missingTools.set(m[1], []).get(m[1])).push(r.id);
if (missingTools.size) fail(`promises-index: ${missingTools.size} named tool(s) do not exist`,
    [...missingTools].map(([f, who]) => `    ${f}  (cited by ${who.join(', ')})`).join('\n'));

// 5. Any count the document states about itself must be the count.
for (const m of text.matchAll(/\*\*(\d+) promises[^*]*\*\*/g))
    if (Number(m[1]) !== rows.length)
        fail(`promises-index: the document says "${m[1]} promises" but the table has ${rows.length} rows`);

if (bad) { console.log(`\npromises-index-check: ${bad} problem(s)`); process.exit(1); }
const by = {};
for (const r of rows) by[VOCAB.find(v => r.disp.startsWith(`**${v}`))] = (by[VOCAB.find(v => r.disp.startsWith(`**${v}`))] ?? 0) + 1;
const byPart = {};
for (const r of rows) byPart[r.part] = (byPart[r.part] ?? 0) + 1;
console.log(`PASS promises-index-check: ${rows.length} promises — ` +
            Object.entries(by).sort().map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') +
            `; parts ` + Object.entries(byPart).sort().map(([k, v]) => `${k}=${v}`).join(' ') +
            '; every named leg and tool exists, README figure agrees');
