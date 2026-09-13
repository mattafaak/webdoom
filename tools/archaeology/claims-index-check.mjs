#!/usr/bin/env node
// tools/archaeology/claims-index-check.mjs — the index must not overclaim.
//
// WHY THIS EXISTS
// ---------------
// docs/claims-index.md is BOTH the human inventory of every quantitative claim
// AND the locator table doc-drift.mjs builds its checks from.  Nothing checked
// the inventory itself, and it had drifted badly (task 24.2):
//
//   * 50 of its rows said `verified` while being absent from claims.json, so
//     nothing anywhere checked them.  "verified" meant "a human read a JSON
//     file once" for a quarter of the table.
//   * 11 manifest ids had no row at all, including every published-promise
//     claim (readme-001, spec-001..003, md-tic-001) — the ones tenet 6 exists
//     for were the ones missing from the tenet-6 inventory.
//   * 8 rows pointed at tools/bench-baseline.json, which does not exist.
//   * size-004 and readme-001 are THE SAME FACT (the README KB figure) and had
//     drifted to 348 vs 349 with nothing comparing them.
//   * three different totals were stated in one document: 193, 172 and 188.
//
// The status vocabulary now means something, and this asserts it:
//   verified            in claims.json; verify-all checks it
//   dated-measurement   a measurement taken once, on a stated host/date
//   derived-from-gated  arithmetic over gated inputs, stated in the row
//   unverifiable        declared so in claims.json, with a reason
//
// usage: node tools/archaeology/claims-index-check.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeSummary } from './claims-summary.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = join(root, 'docs/claims-index.md');
const claims = JSON.parse(readFileSync(join(root, 'tools/archaeology/claims.json'), 'utf8')).claims;

// Ids carry more than one hyphen (md-tic-001), which a narrower pattern silently
// drops — that is how the first version of this check "found" a missing row that
// was there all along.
const ROW = /^\|\s*([a-z][a-z0-9-]*-\d+[a-z]?)\s*\|/;
const cells = l => l.split(/(?<!\\)\|/).map(c => c.trim());

const rows = [];
for (const line of readFileSync(INDEX, 'utf8').split('\n')) {
    const m = ROW.exec(line);
    if (!m) continue;
    const c = cells(line);
    if (c.length !== 9) continue;          // escaped-pipe rows are handled by the split
    rows.push({ id: c[1], docline: c[2], claim: c[3], value: c[4], type: c[5], repro: c[6], status: c[7] });
}

let bad = 0;
const fail = (what, detail) => { console.log(`FAIL ${what}`); if (detail) console.log(detail); bad++; };

// A parse that found almost nothing is broken, not clean.
if (rows.length < 150) {
    console.log(`FAIL claims-index: parsed only ${rows.length} rows; the table is far larger. The parser or the table changed.`);
    process.exit(1);
}

// 1. No row may say `verified` unless the manifest actually gates it.
const over = rows.filter(r => r.status === 'verified' && !(r.id in claims));
if (over.length) fail(`claims-index: ${over.length} row(s) say "verified" but are not in claims.json`,
    '    ' + over.slice(0, 8).map(r => r.id).join(', ') + (over.length > 8 ? ' …' : ''));

// 2. Every gated claim must appear in the inventory.
const ids = new Set(rows.map(r => r.id));
const unlisted = Object.keys(claims).filter(i => !ids.has(i));
if (unlisted.length) fail(`claims-index: ${unlisted.length} manifest id(s) have no row`, '    ' + unlisted.join(', '));

// 3. `unverifiable` in the manifest must read `unverifiable` in the index.
const mismatched = rows.filter(r => claims[r.id]?.status === 'unverifiable' && r.status !== 'unverifiable');
if (mismatched.length) fail(`claims-index: ${mismatched.length} row(s) contradict the manifest's unverifiable status`,
    '    ' + mismatched.map(r => `${r.id} (index: ${r.status})`).join(', '));

// 3b. `commit-pinned` in the manifest must read `dated-measurement` in the index.
// Round 8: perf-002/perf-003 said "verified" while being checkSoft, so nothing
// they reported could ever fail a gate -- and both had in fact drifted from
// their 6de6256 pins while wasm-stamp's summary line read "3/3 passed".
// "Verified" meaning "a script printed INFO about it" is the 24.2 overclaim the
// status vocabulary exists to stop, so the STATUS moved rather than the check.
const pinned = rows.filter(r => claims[r.id]?.status === 'commit-pinned' && r.status !== 'dated-measurement');
if (pinned.length) fail(`claims-index: ${pinned.length} row(s) contradict the manifest's commit-pinned status ` +
    `(a commit-pinned claim is a dated-measurement in the index, never "verified")`,
    '    ' + pinned.map(r => `${r.id} (index: ${r.status})`).join(', '));

// 3c. The VALUE column must agree with the manifest.  Rules 1-3 checked status,
// presence and the unverifiable vocabulary; NOTHING compared the number a reader
// actually reads.  Round 8 found eleven disagreements, seven of them stale by a
// lot: perf-009 said 5,461,072 against 4,722,048, perf-059 54.83 MB against
// 26.13, rdr-006 1,024 against 128, rdr-008 2,048 against 256, readme-001 and
// size-004 349 against 348, ea-026 92 against 91.
//
// CONTAINS, not equals, after stripping separators and normalising U+2212: the
// index legitimately writes units and gloss around the figure ("4,194,304 B
// (32 MB)"), and a checker that parsed units would be a second source of bugs.
// The four rows that could not normalise were RESTATED to carry their number
// rather than exempted -- an exemption list is one edit away from exempting the
// stale ones, which is the whole failure this rule exists to stop.
//
// The one skip is defined, not ad hoc: a boolean `expected` ("true") is an
// assertion, not a figure, so the index carries prose describing it.  Skips are
// counted and named in the PASS line.
const vnorm = v => String(v).replace(/[,\s]/g, '').replace(/\u2212/g, '-');
const valueMismatch = [];
const valueSkipped = [];
let valueCompared = 0;
for (const r of rows) {
    const exp = claims[r.id]?.expected;
    if (exp === undefined || exp === null) continue;
    if (exp === 'true' || exp === 'false') { valueSkipped.push(r.id); continue; }
    valueCompared++;
    if (!vnorm(r.value).includes(vnorm(exp)))
        valueMismatch.push(`${r.id}: index "${r.value}" vs manifest "${exp}"`);
}
// A rule that compared almost nothing is broken, not clean -- the same shape as
// the rows.length guard above.  144 rows carried a manifest value when written.
if (valueCompared < 130)
    fail(`claims-index: the value rule compared only ${valueCompared} rows; ` +
         `it should reach ~144. The parser or the manifest changed.`);
if (valueMismatch.length)
    fail(`claims-index: ${valueMismatch.length} row(s) quote a value the manifest contradicts`,
         '    ' + valueMismatch.join('\n    '));

// 4. Reproducer paths must resolve.  Prose in parentheses is not a path.
const ROOTS = ['', 'tools/', 'tools/archaeology/', 'tools/golden/', 'tools/freestanding/', 'tools/fuzz/'];
const unresolved = new Map();
for (const r of rows) {
    const prose = r.repro.replace(/\([^)]*\)/g, ' ');
    for (const m of prose.matchAll(/[\w./-]+\.(?:mjs|json|sh|c|md)\b/g)) {
        if (!ROOTS.some(p => existsSync(join(root, p + m[0])))) {
            (unresolved.get(m[0]) ?? unresolved.set(m[0], []).get(m[0])).push(r.id);
        }
    }
}
if (unresolved.size) fail(`claims-index: ${unresolved.size} reproducer path(s) do not exist`,
    [...unresolved].map(([f, who]) => `    ${f}  (${who.length} row(s): ${who.slice(0, 4).join(', ')})`).join('\n'));

// 5. readme-001 and size-004 are the same fact; they must not drift apart.
if (claims['readme-001'] && claims['size-004'] &&
    claims['readme-001'].expected !== claims['size-004'].expected) {
    fail('claims-index: readme-001 and size-004 state the same fact and disagree',
         `    readme-001 = ${claims['readme-001'].expected}, size-004 = ${claims['size-004'].expected}`);
}

// 6. The document's own total must be the number of rows.
const stated = /\*\*Total claims:\s*(\d+)\*\*/.exec(readFileSync(INDEX, 'utf8'));
if (!stated) fail('claims-index: no "**Total claims: N**" line to check against');
else if (Number(stated[1]) !== rows.length)
    fail(`claims-index: the document says "Total claims: ${stated[1]}" but the table has ${rows.length} rows`);

// 7. The document's OTHER two counts, which nothing checked.
//
// Invariant 6 above computes "Total claims: N" from the table and was added by
// task 21.9 under the doctrine that a count is computed, never typed.  Two more
// counts in the same file's header were typed and stayed typed: the fast-tier
// size and the number of unverifiable claims.  Both had drifted -- the header
// said 105 and 16 where the manifest says 107 and 17 -- inside the very
// document that exists to be the claims inventory.
// The tier split is computed by claims-summary.mjs, which is the file task 21.9
// created to be the one computer of these numbers.  Re-deriving it here would
// make a SECOND definition of "fast tier" -- and a second definition is how the
// first draft of this check got 111 where the manifest says 107, by forgetting
// that size-ledger rides in the full tier.  Ask the computer.
const text7 = readFileSync(INDEX, 'utf8');
const summary = computeSummary();
const nFast = summary.fast;
const nUnverifiable = summary.unverifiable;

for (const [label, re, want] of [
    ['fast tier',   /fast tier \((\d+) claims/,                       nFast],
    ['unverifiable', /markers for the (\d+) unverifiable claims/,      nUnverifiable],
]) {
    const m = re.exec(text7);
    if (!m) fail(`claims-index: no "${label}" count in the header to check against`);
    else if (Number(m[1]) !== want)
        fail(`claims-index: header says ${m[1]} ${label} claims, the manifest has ${want}`);
}

if (bad) { console.log(`\nclaims-index-check: ${bad} problem(s)`); process.exit(1); }

const by = {};
for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1;
console.log(`PASS claims-index-check: ${rows.length} rows — ` +
            Object.entries(by).sort().map(([k, v]) => `${v} ${k}`).join(', ') +
            `; all ${Object.keys(claims).length} manifest ids listed, all reproducer paths resolve, ` +
            `header counts (${nFast} fast, ${nUnverifiable} unverifiable) computed, ` +
            `${valueCompared} values agree with the manifest` +
            (valueSkipped.length ? ` (${valueSkipped.length} boolean: ${valueSkipped.join(', ')})` : ''));
