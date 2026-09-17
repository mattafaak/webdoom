#!/usr/bin/env node
// tools/archaeology/prose-check.mjs — the documentation's readability, graded.
//
// WHY THIS EXISTS.  Round 12 rewrote the front-door documents and there was
// nothing to stop them drifting back.  Every other number in this repository is
// gated; the reason the line counts in docs/README.md, the promise totals and
// the claim totals all rotted is that nobody could see them rot.  Prose is the
// same shape of problem.
//
// ── WHAT IT MEASURES, AND WHY THE DEFINITION IS LOAD-BEARING ────────────────
//
// PARAGRAPH PROSE ONLY: no tables, no list items, no headings, no fenced code,
// no block quotes -- and split into sentences WITHIN each paragraph, never
// across them.  That definition was arrived at by getting it wrong three times,
// and it is stated here because a different definition gives a different answer
// and a reader deserves to know which one produced the number.
//
//   1. Splitting sentences naively read a 1,405-word "sentence" in playsim.md
//      and a 202-word one in README.md.  Both were bullet lists with no
//      terminal periods.  Verdict: "170 sentences over 40 words".
//   2. Made list-aware, the same corpus read 51 -- so sentence length was never
//      the problem.  But em-dashes inside list LABELS were still counted, which
//      made playsim.md look like the worst document in the repo at 30.3 per
//      thousand words.
//   3. Restricted to running prose, playsim.md reads 6.0 and is one of the
//      BETTER documents.  Its em-dashes were table-of-contents separators of
//      the form `Movement and collision — p_map.c`, which are correct.
//   4. And it was STILL wrong: it joined the paragraphs before splitting them,
//      so a paragraph ending in ':' before a list was glued to the next and
//      counted as one enormous sentence.  152 reported against 96 real -- 37%
//      of every long-sentence figure this tool printed in its first day.  See
//      the comment in measure(); the fix is to segment before aggregating.
//
// Four passes, one lesson each time: the instrument reports the shape of its
// own preprocessing at least as loudly as the shape of the prose.
//
// So: an em-dash separating a label from its target is not a defect, and this
// tool must not see one.  What it is looking for is the em-dash used instead of
// a full stop, three or four to a sentence, which is the actual house style
// problem.
//
// ── WHAT IT GRADES ─────────────────────────────────────────────────────────
//
// Per document, against a recorded ceiling in prose-budget.json:
//   * sentences over 40 words          (absolute count)
//   * em-dashes per 1,000 prose words  (a RATE, and only above a word floor)
//
// A RATE NEEDS A SAMPLE.  docs/README.md's 17.3 was four em-dashes in 231
// words; one sentence either way moves it by four points.  Grading that would
// fire on ordinary editing, which is the "alarming on correct behaviour is a
// defect too" rule this project already wrote down.  Below PROSE_FLOOR words a
// document is graded on an absolute count instead, and both numbers are printed
// for every document either way, so a reader can see which rule applied.
//
// The ceilings RATCHET: improve a document, re-record, and it cannot go back.
// SLACK below is deliberately small -- enough that adding a sentence is not a
// red, not enough to let a document slide back to where it started.
//
// It also REPORTS, without grading, how many glossary terms each document uses
// before linking to the glossary.  That was jwhit's call: a first-use rule is
// the kind of check that false-positives forever, so this prints the number and
// never fails on it.
//
// usage: node tools/archaeology/prose-check.mjs [--record] [--verbose]
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../lib/util.mjs';

const BUDGET = join(root, 'tools/archaeology/prose-budget.json');
const record = process.argv.includes('--record');
const verbose = process.argv.includes('--verbose');
for (const a of process.argv.slice(2))
    if (!['--record', '--verbose'].includes(a)) {
        console.error(`FAIL prose-check: unrecognised argument '${a}'`);
        process.exit(2);
    }

const LONG_SENTENCE = 40;    // words
const PROSE_FLOOR = 400;     // below this, grade the count not the rate
const SLACK_RATE = 1.5;      // em-dashes per 1,000 words
const SLACK_LONG = 2;        // sentences
const SLACK_COUNT = 3;       // em-dashes, for short documents

// ── the corpus ───────────────────────────────────────────────────────────────
// Everything a reader is expected to read: the root documents and docs/,
// including the hardware bring-ups.  NOT docs/archive/ -- those are closed
// records whose value is being a contemporary account, and rewriting one
// destroys the thing it is for.  NOT id Software's .TXT originals.
function corpus() {
    const files = [];
    for (const f of readdirSync(root))
        if (f.endsWith('.md')) files.push(f);
    const docs = join(root, 'docs');
    for (const f of readdirSync(docs))
        if (f.endsWith('.md')) files.push(`docs/${f}`);
    for (const sub of ['n64', 'rp2040', '386']) {
        const d = join(docs, sub);
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) if (f.endsWith('.md')) files.push(`docs/${sub}/${f}`);
    }
    // ...and the markdown under tools/, which BOTH documentation gates missed:
    // docs-index-check scopes to docs/, and this file used to as well, leaving
    // ~1,900 lines ungated.  One of them, tools/archaeology/README.md, carries
    // a registry of measurement tools that nothing enforced.
    const walk = (rel) => {
        const abs = join(root, rel);
        if (!existsSync(abs)) return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            if (e.isDirectory()) walk(`${rel}/${e.name}`);
            else if (e.name.endsWith('.md')) files.push(`${rel}/${e.name}`);
        }
    };
    walk('tools');
    return files.sort();
}

// ── the instrument ───────────────────────────────────────────────────────────
const wc = s => s.split(/\s+/).filter(Boolean).length;

function paragraphs(text) {
    const lines = text.split('\n');
    let fence = false;
    const out = [];
    let cur = [];
    const flush = () => { if (cur.length) out.push(cur.join(' ')); cur = []; };
    for (const l of lines) {
        if (/^\s*```/.test(l)) { fence = !fence; flush(); continue; }
        if (fence) continue;
        if (/^\s*$/.test(l)) { flush(); continue; }
        if (/^\s*\|/.test(l)) { flush(); continue; }            // table row
        if (/^\s*#{1,6}\s/.test(l)) { flush(); continue; }      // heading
        if (/^\s*([-*+]\s|\d+[.)]\s|>)/.test(l)) { flush(); continue; }  // list, quote
        if (/^\s*<!--/.test(l)) { flush(); continue; }          // html comment
        cur.push(l);
    }
    flush();
    return out;
}

function measure(rel) {
    const text = readFileSync(join(root, rel), 'utf8');
    const paras = paragraphs(text);
    const joined = paras.join(' ');
    // SPLIT PER PARAGRAPH.  This joined them first and then split on sentence
    // punctuation, so a paragraph ending WITHOUT terminal punctuation -- almost
    // always one ending in ':' before a list or a table -- was glued to the next
    // one and counted as a single enormous sentence.  Measured over this repo:
    // 152 reported against 96 real, so 37% of every long-sentence figure this
    // tool has ever printed was an artifact, and web-scrutiny.md ranked sixth
    // worst on a number that was 6x wrong about it (12 reported, 2 real).
    //
    // That is the THIRD instance of the error this file's own header documents
    // fixing twice, which is the point worth keeping: an instrument that
    // aggregates before it segments will invent whatever it aggregated across.
    // `joined` survives only for the word and em-dash counts, which are totals
    // over the same text either way and are unaffected.
    const sentences = paras.flatMap(par => par.split(/(?<=[.!?])\s+/))
        .map(s => s.trim()).filter(s => wc(s) > 4);
    const words = wc(joined);
    return {
        rel,
        words,
        sentences: sentences.length,
        long: sentences.filter(s => wc(s) > LONG_SENTENCE).length,
        longest: sentences.reduce((m, s) => Math.max(m, wc(s)), 0),
        emdash: (joined.match(/—/g) ?? []).length,
        rate: words ? (1000 * (joined.match(/—/g) ?? []).length) / words : 0,
    };
}

const files = corpus();
// A discovery that finds nothing is a broken tool, not a clean corpus.  This
// repo has been bitten by vacuous discovery twice, both times in a checker that
// reported success over an empty set.
if (files.length < 15) {
    console.log(`FAIL prose-check: discovered only ${files.length} documents; the corpus is larger than that`);
    process.exit(1);
}
const measured = files.map(measure);
const noProse = measured.filter(m => m.words === 0 && readFileSync(join(root, m.rel), 'utf8').length > 400);
if (noProse.length > files.length / 2) {
    console.log(`FAIL prose-check: ${noProse.length} of ${files.length} documents parsed to ZERO prose words`);
    console.log('    The paragraph parser is broken; every assertion below would pass by observing nothing.');
    process.exit(1);
}

// ── glossary first-use, reported only ────────────────────────────────────────
let glossaryNote = 'no docs/glossary.md';
const gpath = join(root, 'docs/glossary.md');
if (existsSync(gpath)) {
    const terms = [...readFileSync(gpath, 'utf8').matchAll(/^\| \*\*([^*|]+)\*\*/gm)]
        .map(m => m[1].trim()).filter(t => /^[A-Za-z_][\w ]*$/.test(t) && t.length > 3);
    let unlinked = 0, docsWith = 0;
    for (const m of measured) {
        if (m.rel === 'docs/glossary.md') continue;
        const t = readFileSync(join(root, m.rel), 'utf8');
        if (t.includes('glossary.md')) continue;   // links to it: not our business
        const used = terms.filter(term => new RegExp(`\\b${term}\\b`).test(t));
        if (used.length) { docsWith++; unlinked += used.length; }
    }
    glossaryNote = `${terms.length} glossary terms; ${unlinked} use(s) across ${docsWith} document(s) `
                 + 'that do not link the glossary (reported, never graded)';
}

// ── grade ────────────────────────────────────────────────────────────────────
const budget = existsSync(BUDGET) ? JSON.parse(readFileSync(BUDGET, 'utf8')) : { files: {} };

if (record) {
    const out = { _comment:
        'Ceilings for tools/archaeology/prose-check.mjs.  A document may not get '
      + 'DENSER than its entry: sentences over 40 words, and em-dashes per 1,000 '
      + 'words of paragraph prose (an absolute em-dash count below the tool\'s '
      + 'PROSE_FLOOR, where a rate would be noise).  Improve a document and '
      + 're-record; the ceiling tightens and cannot slide back.  Regenerate with '
      + '`node tools/archaeology/prose-check.mjs --record`.',
        files: {} };
    for (const m of measured)
        out.files[m.rel] = m.words >= PROSE_FLOOR
            ? { words: m.words, long: m.long, rate: +m.rate.toFixed(1) }
            : { words: m.words, long: m.long, emdash: m.emdash };
    writeFileSync(BUDGET, JSON.stringify(out, null, 2) + '\n');
    console.log(`recorded ceilings for ${measured.length} documents into ${BUDGET.replace(root + '/', '')}`);
    process.exit(0);
}

let bad = 0, graded = 0;
const rows = [];
for (const m of measured) {
    const b = budget.files?.[m.rel];
    if (!b) {
        // a NEW document is not a failure, but it must be recorded before the
        // next run, or it is an ungraded hole that grows
        rows.push([m, 'NEW', '— not in prose-budget.json; run --record']);
        continue;
    }
    graded++;
    const problems = [];
    if (m.long > b.long + SLACK_LONG)
        problems.push(`${m.long} sentences over ${LONG_SENTENCE} words, ceiling ${b.long} (+${SLACK_LONG})`);
    if (m.words >= PROSE_FLOOR && b.rate !== undefined) {
        if (m.rate > b.rate + SLACK_RATE)
            problems.push(`${m.rate.toFixed(1)} em-dashes/1k, ceiling ${b.rate} (+${SLACK_RATE})`);
    } else if (b.emdash !== undefined && m.emdash > b.emdash + SLACK_COUNT) {
        problems.push(`${m.emdash} em-dashes in ${m.words} prose words, ceiling ${b.emdash} (+${SLACK_COUNT})`);
    }
    if (problems.length) { bad++; rows.push([m, 'FAIL', problems.join('; ')]); }
    else if (verbose) rows.push([m, 'ok', '']);
}

for (const [m, verdict, why] of rows) {
    const how = m.words >= PROSE_FLOOR ? `${m.rate.toFixed(1)}/1k` : `${m.emdash} em-dash`;
    console.log(`  ${verdict.padEnd(4)} ${m.rel.padEnd(34)} ${String(m.words).padStart(5)}w  `
              + `${String(m.long).padStart(3)} long  ${how.padStart(9)}  ${why}`);
}

const tot = measured.reduce((a, m) => ({
    words: a.words + m.words, long: a.long + m.long, emdash: a.emdash + m.emdash,
}), { words: 0, long: 0, emdash: 0 });

console.log(`\nprose-check: ${graded} of ${measured.length} documents graded; `
          + `corpus ${tot.long} sentences over ${LONG_SENTENCE} words, `
          + `${tot.emdash} em-dashes in ${tot.words} paragraph words `
          + `(${(1000 * tot.emdash / tot.words).toFixed(1)}/1k)`);
console.log(`  glossary: ${glossaryNote}`);

if (graded < 15) {
    console.log(`FAIL prose-check: only ${graded} document(s) had a ceiling — the budget is not covering the corpus`);
    process.exit(1);
}
if (bad) {
    console.log(`FAIL prose-check: ${bad} document(s) got denser than their recorded ceiling`);
    console.log('    Prose is the one thing here nothing else can measure for you.  Either tighten');
    console.log('    the writing, or re-record with --record and say in the commit why it grew.');
    process.exit(1);
}
console.log(`PASS — prose-check: all ${graded} documents at or under their prose ceiling`);
