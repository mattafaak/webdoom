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
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
let locatorReport = '', derivedReport = '';
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


// 8. The doc:line locator must point at the claim's value.
//
// The locator column is not decoration: doc-drift.mjs builds a +/-35-line
// SEARCH WINDOW from it, and when a figure drifts out of that window the only
// consequence is that doc-drift falls back to scanning the whole document --
// so the claim still passes while its locator points at unrelated prose.
// Nothing graded the column itself.  Plans.md carried "37 of 129 locators sit
// beyond 60% of the window" as a known-open item for weeks: a number produced
// by a one-off script that was never committed, so nobody could recompute it.
// This recomputes it on every run.
//
// Two outcomes, deliberately different:
//   DRIFTED     the value IS in the document, just far from the locator.
//               Unambiguous, mechanically fixable -- `--reanchor` -- so it FAILS.
//   UNANCHORED  the value is nowhere in the document.  Reported by name and
//               counted, never silently skipped, but NOT failed: a source-constant
//               claim ({640,1280,320}, 4 x FRACUNIT) is verified against the C
//               source and may appear in prose only symbolically, and a
//               commit-pinned size legitimately differs from what the doc shows
//               for the current build.  This list is worth reading anyway -- it
//               is how perf-012 and perf-013 were found carrying a heap base two
//               revisions stale, and perf-060 a headroom against a 64 MB
//               INITIAL_MEMORY that task 14.2c changed to 32 MB in July.
const REANCHOR = process.argv.includes('--reanchor');
// doc-drift declares, for most of these claims, the NEEDLE its extractor looks
// for -- and the needle is usually not the value.  perf-008's value is the byte
// count 4,194,304 while its needle is the prose "Zone pool" 76 lines away;
// anchoring that locator on the value moved doc-drift's window off its own
// needle and broke the check.  So a locator is good when the window holds ANY
// declared needle for that claim OR the value itself.
//
// "Any" is load-bearing: doc-drift keeps four hint tables (DOC_HINTS,
// PUBLIC_HINTS, README_HINTS, SPEC_HINTS) keyed by the same ids, so one claim
// legitimately has several needles in several documents -- readme-001 is
// "KB of wasm" in the root README and something else under docs/.  A first cut
// that kept one needle per id silently took whichever table came last and
// reported eighteen present anchors as missing.  The hints are read out of
// doc-drift.mjs rather than copied here: one definition, and a parse that
// finds too few fails instead of passing quietly.
function docDriftNeedles() {
    const src = readFileSync(join(root, 'tools/archaeology/doc-drift.mjs'), 'utf8').split('\n');
    const out = new Map();
    let id = null, block = [];
    const flush = () => {
        if (id) {
            const text = block.join('\n');
            const set = out.get(id) ?? out.set(id, new Set()).get(id);
            for (const m of text.matchAll(/needle:\s*'((?:[^'\\]|\\.)*)'/g))
                set.add(m[1].replace(/\\'/g, "'"));
        }
        id = null; block = [];
    };
    for (const line of src) {
        const m = /^\s*'([a-z][a-z0-9-]*-\d+[a-z]?)':\s*\{/.exec(line);
        if (m) { flush(); id = m[1]; }
        if (id) block.push(line);
    }
    flush();
    return out;
}
const NEEDLES = docDriftNeedles();
{
    const withNeedle = [...NEEDLES.values()].filter(v => v.size).length;
    if (withNeedle < 50)
        fail(`claims-index: parsed only ${withNeedle} doc-drift needle(s) — the DOC_HINTS shape changed and rule 8 would anchor on the wrong thing`);
}
const docCache = new Map();
// `README.md` in the locator column means the ROOT readme; `docs/README.md` is
// a different document and both exist.  Rather than guess from the name, load
// every candidate and let the caller take the one the anchor is actually in --
// guessing docs/ first reported present anchors as missing.
const docCandidates = f => {
    if (!docCache.has(f)) {
        const tries = f.startsWith('../') ? [join(root, f.slice(3))]
                                          : [join(root, 'docs', f), join(root, f)];
        docCache.set(f, tries.filter(existsSync).map(a => readFileSync(a, 'utf8').split('\n')));
    }
    return docCache.get(f);
};
// Every spelling a document might use for the value the index prints: with and
// without thousands separators, ASCII hyphen-minus and U+2212, and the trailing
// unit when it is part of the figure ("-3.5%", "5.46x").  The first version of
// this check used the raw cell and reported 29 values as missing that were all
// present, spelled differently -- a broken instrument telling a defect story
// about the documents.
function valueVariants(cell) {
    let t = cell.replace(/\([^)]*\)/g, ' ').trim();
    t = t.split(/\s+(?:\/|or|vs)\s+/)[0].trim();
    t = t.replace(/^[{~≈]+/, '').replace(/[.,;:]$/, '').trim();
    const out = new Set();
    const add = v => { if (v && v.length >= 4) out.add(v); };
    const m = /^[−-]?\d[\d,]*(?:\.\d+)?/.exec(t);
    if (m) {
        const n = m[0];
        for (const form of [n, n.replace(/,/g, '')])
            for (const sign of [form, form.replace('−', '-'), form.replace('-', '−')]) {
                add(sign);
                const unit = t.slice(n.length).match(/^[%×x]/);
                if (unit) add(sign + unit[0]);
            }
    }
    return [...out];
}
{
    let graded = 0, anchored = 0, weak = 0, noline = 0, nofile = 0, byNeedle = 0;
    const drifted = [], unanchored = [], rewrites = [];
    const WINDOW = 35;
    for (const r of rows) {
        const [file, lineStr] = r.docline.split(':');
        if (!/^\d+$/.test(lineStr ?? '')) { noline++; continue; }   // "§2"-style locators
        const candidates = docCandidates(file);
        if (!candidates.length) { nofile++; continue; }
        const needles = [...(NEEDLES.get(r.id) ?? [])].filter(n => n.length >= 4);
        const vs = [...new Set([...needles, ...valueVariants(r.value)])];
        if (!vs.length) { weak++; continue; }                        // "8", "33": everywhere, grades nothing
        graded++;
        if (needles.length) byNeedle++;
        let at = [];
        for (const lines of candidates) {
            const hits = [];
            lines.forEach((L, i) => { if (vs.some(v => L.includes(v))) hits.push(i + 1); });
            if (hits.length) { at = hits; break; }        // the file the anchor is in
        }
        if (!at.length) { unanchored.push(`${r.id} -> ${r.docline} (tried ${vs.map(v => JSON.stringify(v)).join(', ')})`); continue; }
        const target = Number(lineStr);
        const near = at.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
        if (Math.abs(near - target) <= WINDOW) { anchored++; continue; }
        drifted.push(`${r.id} ${r.docline} -> nearest occurrence line ${near} (off by ${Math.abs(near - target)}` +
                     `${at.length > 1 ? `, ${at.length} occurrences` : ''})`);
        rewrites.push({ id: r.id, from: r.docline, to: `${file}:${near}`, occ: at.length });
    }
    if (graded < 50)
        fail(`claims-index: only ${graded} locator(s) could be graded — the value or locator column changed shape`);
    if (REANCHOR) {
        let text = readFileSync(INDEX, 'utf8');
        for (const w of rewrites) {
            const re = new RegExp(`^(\\|\\s*${w.id}\\s*\\|\\s*)${w.from.replace('.', '\\.')}(\\s*\\|)`, 'm');
            if (!re.test(text)) { console.log(`  SKIP ${w.id}: row not matched for rewrite`); continue; }
            text = text.replace(re, `$1${w.to}$2`);
            console.log(`  ${w.id}: ${w.from} -> ${w.to}${w.occ > 1 ? `   (${w.occ} occurrences; nearest chosen — check this one)` : ''}`);
        }
        writeFileSync(INDEX, text);
        console.log(`\n--reanchor: rewrote ${rewrites.length} locator(s). ${rewrites.filter(w => w.occ > 1).length} had ` +
                    'more than one occurrence and took the nearest — read those lines before committing.');
        process.exit(0);
    }
    if (drifted.length)
        fail(`claims-index: ${drifted.length} of ${graded} locator(s) point more than ${WINDOW} lines from their value`,
             drifted.map(d => `    ${d}`).join('\n') +
             '\n    Fix: node tools/archaeology/claims-index-check.mjs --reanchor');
    locatorReport = `${anchored} of ${graded} locators within ${WINDOW} lines of their anchor ` +
        `(${byNeedle} of them also carry a doc-drift needle) ` +
        `(${weak} values too short to locate, ${noline} section-style, ${nofile} outside docs/` +
        (unanchored.length ? `, ${unanchored.length} not found in their document: ${unanchored.map(u => u.split(' ')[0]).join(', ')}` : '') + ')';
}

// 9. A derived row's arithmetic must compute what the row claims.
//
// 24 rows carry status `derived-from-gated`, and NONE of them is in
// claims.json -- so verify-all never computes them and doc-drift never sees
// them.  The arithmetic is written out in the reproducer cell; this evaluates
// it.  Not every row can be: eight state the derivation in prose ("sum of
// perf-017/021/022/023"), and those are counted and named rather than passed
// over.  A rule that INPUTS must each be some gated claim's current value was
// tried and dropped: it fires on round constants (33,554,432 for 32 MiB) and
// on chained derivations, so it would have cost more in false alarms than the
// one real hit it found.
{
    let parsed = 0; const prose = [], wrong = [];
    for (const r of rows) {
        if (r.status !== 'derived-from-gated') continue;
        const m = /(.+?)\s*(?:=|≈)\s*([\d,]+(?:\.\d+)?)/.exec(r.repro.replace(/^arithmetic:\s*/, ''));
        if (!m) { prose.push(r.id); continue; }
        const expr = m[1].replace(/,/g, '').replace(/[×x]/g, '*').replace(/÷/g, '/')
                         .replace(/−/g, '-').replace(/\^/g, '**')
                         .replace(/\s*(?:MB|KB|B|bytes|tics|ms|Hz|s)\b/g, '');
        if (!/^[\d\s.+\-*/()]+$/.test(expr)) { prose.push(r.id); continue; }
        let got = null;
        try { got = Function('"use strict";return (' + expr + ')')(); } catch { /* prose after all */ }
        if (got === null || !Number.isFinite(got)) { prose.push(r.id); continue; }
        parsed++;
        const want = Number(m[2].replace(/,/g, ''));
        if (Math.abs(got - want) > Math.max(Math.abs(want) * 0.005, 0.005))
            wrong.push(`${r.id}: ${m[1].trim()} computes ${got}, the row says ${m[2]}`);
    }
    if (parsed < 10)
        fail(`claims-index: only ${parsed} derived row(s) had evaluable arithmetic — rule 9 is grading nothing`);
    if (wrong.length)
        fail(`claims-index: ${wrong.length} derived row(s) state arithmetic that does not compute their own value`,
             wrong.map(w => `    ${w}`).join('\n'));
    derivedReport = `${parsed} derived row(s) recomputed from their stated arithmetic` +
        (prose.length ? `, ${prose.length} stated in prose (${prose.join(', ')})` : '');
}

if (bad) { console.log(`\nclaims-index-check: ${bad} problem(s)`); process.exit(1); }

const by = {};
for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1;
console.log(`PASS claims-index-check: ${rows.length} rows — ` +
            Object.entries(by).sort().map(([k, v]) => `${v} ${k}`).join(', ') +
            `; all ${Object.keys(claims).length} manifest ids listed, all reproducer paths resolve, ` +
            `header counts (${nFast} fast, ${nUnverifiable} unverifiable) computed, ` +
            `${valueCompared} values agree with the manifest` +
            (locatorReport ? `;\n  ${locatorReport}` : '') +
            (derivedReport ? `;\n  ${derivedReport}` : '') +
            (valueSkipped.length ? ` (${valueSkipped.length} boolean: ${valueSkipped.join(', ')})` : ''));
