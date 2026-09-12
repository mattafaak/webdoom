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
//   * rme-003 said "no test flips F8"; browser-qol-test pressed it and asserted
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

// 6. The suite's own size, wherever it is published.  README said "81 legs"
//    and "the 19 browser legs" and ci.yml said 81, against a registry of 88
//    and 21 -- numbers a reader uses to decide whether a green run means
//    anything.  Tenet 6 calls a published figure without a gate doc drift, and
//    this one is derivable from `--list`, so derive it.
const legRows = [...runTests.matchAll(/^\s*leg\s+([a-z0-9-]+)\s+(\S+)/gm)];
const browserLegs = legRows.filter(m => m[2].split(',').includes('browser'));
if (legRows.length < 20)
    fail(`promises-index: only ${legRows.length} leg rows parsed from tools/run-tests.sh `
       + '— the registry format changed and rule 6 is checking nothing');
else {
    const ci = existsSync(join(root, '.github/workflows/ci.yml'))
        ? readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8') : '';
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    // Anchored to the exact phrasings that state the WHOLE registry.  A bare
    // /(\d+) legs/ also matches ci.yml's "this job is 12 legs run and 1
    // skipped", which is a true statement about the quick tier -- the first
    // draft of this rule failed on it, which is the difference between a check
    // and a grep.
    for (const [label, text2, re, want, what] of [
        ['README.md', readme, /everything: (\d+) legs/g,     legRows.length,     'suite legs'],
        ['ci.yml',    ci,     /full suite \((\d+) legs/g,    legRows.length,     'suite legs'],
        ['README.md', readme, /the (\d+) browser legs/g,     browserLegs.length, 'browser legs'],
        ['ci.yml',    ci,     /the (\d+) browser legs/g,     browserLegs.length, 'browser legs'],
    ]) {
        const hits = [...text2.matchAll(re)];
        // An anchor that stops matching is a figure that stops being checked.
        if (!hits.length)
            fail(`promises-index: ${label} no longer states its ${what} in the expected phrasing`,
                 `    re-anchor ${re} or restore the sentence`);
        for (const m of hits)
            if (Number(m[1]) !== want)
                fail(`promises-index: ${label} says "${m[0]}"; the registry has ${want} ${what}`,
                     '    Read it from tools/run-tests.sh --list rather than writing it down.');
    }
}

// 7. spec.md's "What ships" table names a gate for every shipped surface, and
//    a table of gate names is only worth having if the names are real.  Each
//    backticked token in the gate column must be a registered leg or a file
//    that exists — the same rule as 3, applied to the contract rather than to
//    this index.
const spec = readFileSync(join(root, 'spec.md'), 'utf8');
const shipsSection = /## What ships[\s\S]*?(?=\n## )/.exec(spec);
let shipRows = 0, shipGates = 0;
if (!shipsSection) {
    fail('promises-index: spec.md has no "## What ships" section',
         '    It was added in round 6 so the contract states what the product IS; '
       + 'if it was removed, remove this rule deliberately rather than by deletion.');
} else {
    for (const row of shipsSection[0].split('\n')) {
        const cells = row.split('|').map(c => c.trim());
        // | what | gate |  -> 4 cells with the leading/trailing empties
        if (cells.length !== 4 || !cells[2] || /^-+$/.test(cells[1]) || cells[1] === 'what') continue;
        shipRows++;
        for (const m of cells[2].matchAll(/`([^`]+)`/g)) {
            const tok = m[1];
            shipGates++;
            if (legs.has(tok)) continue;
            if (existsSync(join(root, tok))) continue;
            fail(`promises-index: spec.md "What ships" names \`${tok}\`, which is neither a suite leg nor a file`,
                 '    Every gate in that table has to be one or the other.');
        }
    }
    if (shipRows < 10)
        fail(`promises-index: only ${shipRows} row(s) parsed from spec.md's "What ships" table `
           + '— the table shape changed and rule 7 is checking nothing');
}

if (bad) { console.log(`\npromises-index-check: ${bad} problem(s)`); process.exit(1); }
const by = {};
for (const r of rows) by[VOCAB.find(v => r.disp.startsWith(`**${v}`))] = (by[VOCAB.find(v => r.disp.startsWith(`**${v}`))] ?? 0) + 1;
const byPart = {};
for (const r of rows) byPart[r.part] = (byPart[r.part] ?? 0) + 1;
console.log(`PASS promises-index-check: ${rows.length} promises — ` +
            Object.entries(by).sort().map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') +
            `; parts ` + Object.entries(byPart).sort().map(([k, v]) => `${k}=${v}`).join(' ') +
            `; every named leg and tool exists, README figure agrees, `
          + `${legRows.length} legs (${browserLegs.length} browser) agree with README.md and ci.yml, `
          + `${shipGates} gate(s) across ${shipRows} "What ships" rows all resolve`);
