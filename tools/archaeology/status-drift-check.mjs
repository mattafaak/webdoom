#!/usr/bin/env node
// tools/archaeology/status-drift-check.mjs — a document may not contradict the
// project's own record of what is done.
//
// WHY THIS EXISTS
// ---------------
// The claims machinery verifies NUMBERS against code, and does it very well:
// 154 manifest claims, three ways each, computed counts, dated stamps. Status
// PROSE is outside all of it. Nothing checks a sentence of the form "X is still
// open" or "unblocking Y needs Z" against the project's own record of X, Y and Z.
//
// Four live instances when this landed, and the first two are the reason it is
// worth a gate rather than a fix:
//
//   1. docs/archive/retrospective.md's ARCHIVE banner — added by task 24.4, THE
//      STALE-DOC SWEEP — says "ZONESIZE is still open". The optimization ledger
//      records C3 as "MEASURED (14.2c) — LANDED" and engine/web/web.h has
//      `#define ZONESIZE (4 * 1024 * 1024)` in force. It shipped in July.
//
//   2. Plans.md and docs/feasibility-atlas.md — the latter in a banner dated
//      2026-09-12 — both say unblocking the RP2040 floor measurement "needs the
//      C4–C6 BSS diets". C4, C5 and C6 landed 2026-07-18/19, BEFORE the 20.7a
//      footprint measurement the park verdict rests on. The verdict still holds
//      (the RP2040 build already pins -DMAXSCREENWIDTH=320, so 1,082,104 B is
//      post-diet); what is wrong is that the first item of the stated unblock
//      path is already done, so anyone who went and did it would get nothing.
//
//   3. F4 is recorded OPEN in two places while spec.md's 2026-09-11 fleet
//      amendment took exactly the decision it asks for, and commit 3bf5c6b is
//      titled "closes F4".
//
//   4. Plans.md rows 20.6b and 20.7b read cc:TODO while the same file, in the
//      same commit, records final verdicts for both.
//
// Deliberately narrow. It grades two things and says so, and it FAILS if its own
// discovery finds nothing — a checker that quietly matches zero candidates is
// the shape this whole round is about.
//
// Named `-check.mjs` deliberately: tools/gate-census.mjs discovers gates by a
// NAME heuristic, and `status-drift.mjs` did not match it — so the one check
// built to catch silent drift would itself have been invisible to the orphan
// census. 38 of the tools tree is in that blind spot; a new gate should not be.
//
// usage: node tools/archaeology/status-drift-check.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = f => readFileSync(join(root, f), 'utf8');

let bad = 0;
const fail = (what, detail) => { console.log(`FAIL ${what}`); if (detail) console.log(detail); bad++; };

// ── rule 1: a LANDED ledger candidate is not "still open" somewhere else ─────
//
// Each candidate heading names its subject in identifier form —
// "C3 — ZONESIZE 32 MiB → 4 MiB", "C4 — BSS diet: MAXVISPLANES 1024 → 128" —
// so the subject token is what to look for in other documents. Matching on the
// candidate ID alone would have missed instance 1 entirely: the retrospective
// banner says "ZONESIZE", never "C3".
const ledger = read('docs/optimization-ledger.md');
const landed = [];
const HEADING = /^### (C\d+) — (.+)$/gm;
let h;
while ((h = HEADING.exec(ledger)) !== null) {
    const after = ledger.slice(h.index, h.index + 4000);
    const v = /^\*\*Verdict:(.+)$/m.exec(after);
    if (!v || !/LANDED/.test(v[1])) continue;
    // Identifier-shaped tokens only: ALL_CAPS words of 6+ chars. Prose words
    // would match everywhere and grade nothing useful.
    const tokens = [...new Set((h[2].match(/\b[A-Z][A-Z0-9_]{5,}\b/g) ?? []))];
    if (tokens.length) landed.push({ id: h[1], tokens, title: h[2].trim() });
}

// "this is not done yet" phrasings, as they are actually written here.
const OPEN_PHRASE =
    /(still open|remains open|is open\b|not (?:yet )?landed|unblocking needs|would unblock|needs the|requires the)/i;

const docs = execSync('git ls-files "*.md"', { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    // The ledger states these verdicts; it is the record, not a reader of it.
    .filter(f => f !== 'docs/optimization-ledger.md');

let scanned = 0;
// The two-line window slides, so one contradiction matches twice (once as the
// first line, once as the second).  Report each file/candidate pair once.
const reported = new Set();

// A document that declares itself an archive is a statement about ITS date, and
// grading it would mean rewriting history to satisfy a checker -- the opposite
// of what this repo does with its records.  docs/archive/retrospective.md carries
// exactly such a banner and its body still describes ZONESIZE as it stood in
// July, correctly.
//
// The exemption is whole-file, banner included.  Telling a banner from a body
// reliably is more machinery than this is worth, and the honest cost is that an
// archive's BANNER can go stale without this gate noticing -- which is exactly
// what happened: task 24.4's banner on that file asserted "ZONESIZE is still
// open" about the present, and a human found it, not a check.  So archives are
// LISTED by name in the verdict rather than passed over in silence: an
// exemption a reader cannot see is the same defect as no check at all.
const ARCHIVE = /^>?\s*\*\*ARCHIVE\b|not maintained\b/im;
const archives = [];
for (const f of docs) {
    const head = read(f).split('\n').slice(0, 25).join('\n');
    if (ARCHIVE.test(head)) archives.push(f);
}

for (const f of docs) {
    if (archives.includes(f)) continue;
    const lines = read(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
        // A two-line window, because markdown wraps and the phrase and its
        // subject land on different lines as often as not: Plans.md reads
        // "What would unblock it, in order: the BSS diets already sitting in /
        // `docs/optimization-ledger.md` as C4–C6 (...)" -- "would unblock" on
        // one line, "C4–C6" on the next. Line-at-a-time missed it.
        const line = lines[i] + ' ' + (lines[i + 1] ?? '');
        if (!OPEN_PHRASE.test(line)) continue;
        scanned++;
        for (const c of landed) {
            // An explicitly historical or dated sentence is a statement about
            // then, which is what the ledger's own "at landing" convention marks.
            if (/at landing|historical|superseded|used to|no longer/i.test(line)) continue;
            const hit = c.tokens.find(t => line.includes(t)) ?? (line.includes(c.id) ? c.id : null);
            if (!hit) continue;
            const key = `${f}:${c.id}`;
            if (reported.has(key)) continue;
            reported.add(key);
            fail(`${f}:${i + 1} describes ${c.id} (${hit}) as outstanding, but the ledger records it LANDED`,
                 `    ${line.trim().slice(0, 160)}\n    ledger: ### ${c.id} — ${c.title}`);
        }
    }
}

// ── rule 2: a cc:TODO task has no verdict written for it ─────────────────────
//
// Plans.md carries both the status table and, below it, the verdicts. 20.6b and
// 20.7b were decided by task 25.5 and their status cells never moved, so the
// file said TODO and PARKED about the same task at the same time.
const plans = read('Plans.md');
const todos = [...plans.matchAll(/^\|\s*(\d+\.\d+[a-z]?)\s*\|.*\bcc:TODO\b/gm)].map(m => m[1]);
// The verdict word may carry qualifiers inside the bold -- "**PARKED on
// arithmetic**" -- so match the word, not the whole emphasis run.
const verdicts = [...plans.matchAll(/^#+ .*?\b(\d+\.\d+[a-z]?)\b.*?\*\*(PARKED|PURSUABLE|REJECTED|CLOSED)\b/gm)]
    .map(m => ({ id: m[1], state: m[2] }));
for (const v of verdicts) {
    if (todos.includes(v.id))
        fail(`Plans.md: task ${v.id} is cc:TODO in the table and **${v.state}** in a verdict below it`,
             '    A decided task with an undecided status cell is two answers to one question.');
}

// ── rule 5: a ledger verdict may not name a task that is already closed ─────
//
// Rule 1 catches a LANDED candidate still described as open. This is its mirror
// and nothing checked it: NC2, NC3 and NC4 all read "SURVIVES -> task 20.2b"
// while 20.2b is `cc:完了`. A survivor pointed at a finished task reads as live
// work with an owner and has neither -- the same shape as the promises index's
// "flagged by future task" table, every entry of which named a closed task.
//
// "no live owner" is the accepted alternative, deliberately: a survivor with
// nobody to do it should SAY so rather than borrow a closed task's name.
{
    const closed = new Set(
        [...plans.matchAll(/^\|\s*(\d+\.\d+[a-z]?)\s*\|.*\bcc:完了/gm)].map(m => m[1]));
    if (closed.size === 0)
        fail('status-drift: found no cc:完了 tasks in Plans.md — rule 5 is grading nothing');
    const ledgerSrc = read('docs/optimization-ledger.md');
    const pointers = [...ledgerSrc.matchAll(/SURVIVES\s*(?:→|->)\s*(?:task\s*)?([0-9]+\.[0-9]+[a-z]?|no live owner)/g)];
    if (pointers.length === 0)
        fail('status-drift: no "SURVIVES -> ..." verdicts found — rule 5 is grading nothing');
    const stale = pointers.map(m => m[1]).filter(t => closed.has(t));
    if (stale.length)
        fail(`status-drift: ${stale.length} ledger verdict(s) point at a CLOSED task: ` +
             `${[...new Set(stale)].join(', ')}`,
             '    A survivor owned by a finished task has no owner. Re-point it, or write "no live owner".');
}

// ── rule 3: the ledger's Totals line must equal its own table ───────────────
//
// "Totals: 21 candidates, 12 survivors (8 landed, 4 surviving), 10 killed" sat
// under a table whose rows say 8 landed, 10 killed and THREE surviving. Two of
// the four figures were wrong, in the over-reporting direction, and the file
// that states the project's optimisation record was the one stating them. The
// rule is D3 again: compute it from the rows rather than trust the sentence.
const ROW = /^\|\s*((?:C|K|NC)\d+)\s*\|.*\|\s*(LANDED|KILLED|SURVIVES)\b/gm;
const rows = [...ledger.matchAll(ROW)];
const tally = { LANDED: 0, KILLED: 0, SURVIVES: 0 };
for (const r of rows) tally[r[2]]++;
const totalsLine = /\*\*Totals:\s*(\d+)\s*candidates,\s*(\d+)\s*survivors\s*\((\d+)\s*landed,\s*(\d+)\s*surviving\),\s*(\d+)\s*killed\.?\*\*/.exec(ledger);

if (rows.length < 10)
    fail(`status-drift: only ${rows.length} candidate rows parsed from the ledger table `
       + '— the row format changed and rule 3 is counting nothing');
else if (!totalsLine)
    fail('status-drift: the ledger has candidate rows but no **Totals:** line in the expected shape'
       + ' — either it was removed or its wording drifted past this check');
else {
    const [, cand, surv, landedN, survivingN, killedN] = totalsLine.map(Number);
    const want = {
        cand: rows.length,
        landed: tally.LANDED,
        killed: tally.KILLED,
        surviving: tally.SURVIVES,
        surv: tally.LANDED + tally.SURVIVES,
    };
    const got = { cand, landed: landedN, killed: killedN, surviving: survivingN, surv };
    for (const k of Object.keys(want))
        if (want[k] !== got[k])
            fail(`docs/optimization-ledger.md Totals: says ${k}=${got[k]}, the rows say ${k}=${want[k]}`,
                 `    LANDED ${tally.LANDED}, KILLED ${tally.KILLED}, SURVIVES ${tally.SURVIVES} `
               + `over ${rows.length} rows (${rows.map(r => r[1]).join(', ')})`);
}

// ── rule 4: a decision record's handoff list vs its own addendum ────────────
//
// decision-18.1 §9 listed four deferred items and read as four outstanding
// ones for seven weeks after three of them landed.  The addendum BELOW the
// list said two of them were fixed, and the list above it said nothing — so
// the document contradicted itself, in the over-reporting direction, and the
// claims machinery cannot see prose like that at all.
//
// The rule is narrow on purpose: where a decision record SAYS "items N and M
// above were fixed", the items it names must carry a resolution marker
// (~~strikethrough~~, RESOLVED, or CLOSED).  It grades only what the document
// itself asserts, so it cannot invent a verdict about work it does not
// understand.
const decisionDocs = docs.filter(f => /docs\/(?:archive\/)?decision-[^/]+\.md$/.test(f));
let handoffClaims = 0;
for (const f of decisionDocs) {
    const text = read(f);
    if (!text) continue;
    // "Items 1 and 2 above were fixed in 18.2b" / "Item 3 above was fixed"
    for (const m of text.matchAll(/Items?\s+([\d]+(?:\s*(?:,|and)\s*\d+)*)\s+above\s+(?:was|were)\s+fixed/gi)) {
        const ids = m[1].split(/\s*(?:,|and)\s*/).map(Number).filter(Number.isFinite);
        for (const n of ids) {
            handoffClaims++;
            // The numbered item as the document writes it: "N. ..." at a line
            // start, up to the next numbered item or a blank-line boundary.
            const item = new RegExp(`^${n}\\.\\s[\\s\\S]*?(?=^\\d+\\.\\s|^#|^\\s*$)`, 'm').exec(text);
            if (!item) {
                fail(`${f}: says item ${n} above was fixed, and there is no item ${n} in a numbered list`,
                     '    The addendum and the list have drifted apart entirely.');
                continue;
            }
            if (!/~~|RESOLVED|CLOSED/i.test(item[0]))
                fail(`${f}: item ${n} is claimed fixed by an addendum and still reads as open`,
                     `    ${item[0].split('\n')[0].slice(0, 90)}`);
        }
    }
}

// ── the check must be able to find its own inputs ────────────────────────────
if (landed.length < 3)
    fail(`status-drift: found only ${landed.length} LANDED ledger candidate(s) with an identifier-shaped `
       + 'subject — the heading or verdict format changed and this check is grading nothing');
if (!todos.length && !verdicts.length)
    fail('status-drift: found no cc:TODO rows AND no verdict headings in Plans.md — the marker format changed');
if (!existsSync(join(root, 'docs/optimization-ledger.md')))
    fail('status-drift: the optimization ledger is missing');
if (!decisionDocs.length)
    fail('status-drift: no docs/decision-*.md found — rule 4 is grading nothing');

if (bad) {
    console.log(`\nstatus-drift: ${bad} contradiction(s)`);
    process.exit(1);
}
console.log(`PASS status-drift: ${decisionDocs.length} decision record(s), ${handoffClaims} handoff item(s) `
          + 'claimed fixed by an addendum and marked as such in the list above it;');
console.log(`PASS status-drift: ledger totals recomputed from ${rows.length} candidate rows `
          + `(${tally.LANDED} landed, ${tally.KILLED} killed, ${tally.SURVIVES} surviving) and they match the Totals line; `);
console.log(`PASS status-drift: ${landed.length} landed ledger candidates (${landed.map(c => c.id).join(', ')}) `
          + `checked against ${scanned} open-state sentence(s) across ${docs.length - archives.length} documents `
          + `(${archives.length} self-declared archive(s) exempt: ${archives.join(', ') || 'none'}); `
          + `${todos.length} cc:TODO task(s) vs ${verdicts.length} written verdict(s) — no contradictions`);
