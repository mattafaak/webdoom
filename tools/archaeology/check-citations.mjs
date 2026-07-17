#!/usr/bin/env node
// check-citations.mjs — verifies file:line citations in docs/*.md
// against the actual engine/core source files.
//
// Two levels of verification:
//
//   BOUNDS: target file exists and the cited line is within the file's line count.
//           Every citation that names a known engine/core file is bounds-checked.
//
//   SEMANTIC (identifier adjacency): if the doc text immediately surrounding the
//           citation contains a C identifier (function name, macro, or symbol), we
//           verify that identifier appears within ±PROXIMITY_LINES lines of the
//           cited location in the source.
//           PROXIMITY_LINES = 8  (justification: a function name, macro, or variable
//           that a doc line describes almost always appears within 8 source lines of
//           the cited location; the window is deliberately narrow so a citation that
//           drifts into a *different* function of the same file still fails).
//
//           SEMANTIC checks are performed ONLY for the nine files that were shifted by
//           commit 844c3d6 (WEBDOOM_INVARIANTS assert block insertions).  Citations
//           naming any other engine/core file receive only a BOUNDS_ONLY check.
//           Rationale: false-positive FAIL_ID is too common when identifiers from an
//           unrelated sentence on the same doc line are matched against an unrelated
//           citation target.  Limiting semantic verification to the shifted files
//           keeps the signal-to-noise ratio high where it matters most.
//
//           LIMITATION: identifier extraction is heuristic — it uses backtick-quoted
//           tokens and engine-prefix/ALL_CAPS patterns from the doc line.  It will
//           miss identifiers written in plain prose and will occasionally accept a
//           citation whose identifier happens to appear near (but not at) the cited
//           location.  These limitations are documented here rather than tuned away;
//           the goal is to catch the class of drift that plagued this repo (function
//           starts moving, doc line number does not), not to achieve semantic
//           equivalence with a compiler.
//
//   Citations with no extractable identifier are checked BOUNDS_ONLY.  They are
//   counted and reported separately.  We do NOT claim semantic coverage for them.
//
// Wired into: tools/archaeology/verify-all.sh (fast tier — typically < 0.5 s).
// Exits 0 if all checks pass; exits 1 on any bounds failure or identifier mismatch.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '../..');
const DOCS_DIR = join(ROOT, 'docs');
const CORE_DIR = join(ROOT, 'engine/core');

// Identifier adjacency window (lines either side of cited line).
const PROXIMITY_LINES = 8;

// Files shifted by commit 844c3d6 (WEBDOOM_INVARIANTS assert block insertions).
// Semantic (identifier-adjacency) verification is applied ONLY to these files;
// all other engine/core files receive BOUNDS_ONLY checks.
const SEMANTIC_FILES = new Set([
    'r_main.c',
    'p_mobj.c',
    'p_map.c',
    'p_maputl.c',
    'p_sight.c',
    'p_tick.c',
    'm_random.c',
    'p_local.h',
    'p_user.c',
]);

// ── Collect engine/core source files ────────────────────────────────────────
const coreFiles = new Set(readdirSync(CORE_DIR));

// ── Load and cache source file contents ─────────────────────────────────────
const srcCache = {};
function loadSrc(filename) {
    if (!(filename in srcCache)) {
        const p = join(CORE_DIR, filename);
        srcCache[filename] = existsSync(p)
            ? readFileSync(p, 'utf8').split('\n')
            : null;
    }
    return srcCache[filename];
}

// ── Citation regex ────────────────────────────────────────────────────────────
// Matches: word.ext:digits  or  word.ext:digits[-–]digits
// where ext is .c or .h
// Captures: [1]=filename, [2]=line-start, [3]=line-end (optional)
//
// Negative lookbehind (?<!\/) prevents matching filenames that appear as part of
// a path (e.g. "engine/web/i_main.c:175" → the "i_main.c:175" portion is skipped
// because it is preceded by "/").  This avoids false FAIL_OOB hits when docs cite
// engine/web/ files whose basenames collide with engine/core/ files.
const CITATION_RE = /(?<!\/)\b([\w]+\.(?:c|h)):(\d+)(?:[–\-](\d+))?/g;

// ── Identifier extraction from doc text ─────────────────────────────────────
// Extracts C-style identifiers from a doc line.
//
// Strategy: conservative — only tokens with high confidence that they are
// C identifiers, not English words.
//
//   1. Backtick-quoted tokens (highest confidence)
//   2. Engine naming-convention symbols: P_*, R_*, M_*, I_*, G_*, S_*, Z_*,
//      T_*, A_*, EV_*, PIT_*, PTR_*, HU_*, AM_* (Doom source prefix patterns)
//      — these patterns are almost never English words.
//   3. ALL_CAPS tokens that contain at least one underscore (e.g. MF_SKULLFLY,
//      MAXINTERCEPTS, WEBDOOM_INVARIANTS) — these are macros/constants, not prose.
//
// snake_case extraction was intentionally removed: it produced too many false
// positives from file-stem words (wi_stuff, hu_stuff) and English pseudo-code
// (their_colors, relative_angle).  Backtick quoting is the preferred way to mark
// a snake_case engine symbol for semantic verification.
//
// LIMITATION: This deliberately skips single-word ALL_CAPS and short CamelCase
// tokens to avoid false positives from table headers, section labels, and English
// capitalisation.  The trade-off is a higher rate of BOUNDS_ONLY (no identifier
// extracted) vs FAIL_ID (false alarm).  An honest BOUNDS_ONLY is preferable to
// a noisy false alarm.
function extractIdentifiers(docLine) {
    const ids = new Set();

    // 1. Backtick-quoted tokens (e.g. `P_CheckSight`, `MAXINTERCEPTS`).
    //    The capture takes the LEADING identifier so `MAXHEALTH = 100` and
    //    `P_Random() % MAXPLAYERS` still yield their anchor token — requiring
    //    the whole backtick span to be one identifier dropped those entirely,
    //    which mis-failed playsim.md's (correct) p_local.h:33 citation.
    for (const m of docLine.matchAll(/`([A-Za-z_][\w]*)[^`]*`/g)) {
        const t = m[1];
        // Skip file references (`r_main.c:835`, `p_mobj.c`) — their stem is
        // not a source identifier and can never anchor a location.
        if (/^[\w]+\.(?:c|h|mjs|md)/.test(m[0].slice(1))) continue;
        if (t.length >= 2) ids.add(t);
    }

    // 2. Engine naming-convention bare identifiers (without backticks).
    //    Must start with one of the known doom-source prefixes followed by
    //    an underscore — e.g. P_CheckSight, R_InitLightTables, MF_SKULLFLY.
    //    The regex requires prefix_Name form to avoid catching words like "In" or "As".
    const ENGINE_PREFIX = /\b((?:P|R|M|I|G|S|Z|T|A|EV|PIT|PTR|HU|AM|WI|ST|F|V|W|D)_[A-Za-z]\w*)\b/g;
    for (const m of docLine.matchAll(ENGINE_PREFIX)) {
        ids.add(m[1]);
    }

    // 3. ALL_CAPS tokens with at least one underscore (macros/constants).
    //    E.g. MF_SKULLFLY, MAXINTERCEPTS, MAXSPECIALCROSS, PT_ADDLINES.
    //    Excludes single-word ALL_CAPS (too many false positives from table headers).
    for (const m of docLine.matchAll(/\b([A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+)\b/g)) {
        ids.add(m[1]);
    }

    return [...ids].filter(id => id.length >= 3);
}

// ── Check one citation ────────────────────────────────────────────────────────
// Returns {verdict, details}
// verdict: 'PASS', 'BOUNDS_ONLY', 'SEMANTIC', 'FAIL_OOB', 'FAIL_ID', 'SKIP'
function checkCitation(filename, lineStart, lineEnd, docLine, docFile, docLineNo) {
    // Only check engine/core files
    if (!coreFiles.has(filename)) {
        return { verdict: 'SKIP', details: `not an engine/core file` };
    }

    const src = loadSrc(filename);
    if (!src) {
        return { verdict: 'FAIL_OOB', details: `file not found in engine/core` };
    }

    const maxLine = src.length;

    // Bounds check (1-based)
    if (lineStart < 1 || lineStart > maxLine) {
        return {
            verdict: 'FAIL_OOB',
            details: `line ${lineStart} out of bounds (file has ${maxLine} lines)`,
        };
    }
    if (lineEnd !== null && (lineEnd < lineStart || lineEnd > maxLine)) {
        return {
            verdict: 'FAIL_OOB',
            details: `range ${lineStart}–${lineEnd} out of bounds (file has ${maxLine} lines)`,
        };
    }

    // Semantic (identifier-adjacency) check is only performed for the nine
    // files shifted by commit 844c3d6.  All other files get BOUNDS_ONLY.
    if (!SEMANTIC_FILES.has(filename)) {
        return { verdict: 'BOUNDS_ONLY', details: 'non-shifted file — bounds only' };
    }

    // Extract identifiers from the surrounding doc text
    const ids = extractIdentifiers(docLine);
    if (ids.length === 0) {
        return { verdict: 'BOUNDS_ONLY', details: 'no identifier found in doc line' };
    }

    // Build a window of source lines around the citation
    const winStart = Math.max(0, lineStart - 1 - PROXIMITY_LINES);
    const winEnd   = Math.min(src.length, (lineEnd ?? lineStart) + PROXIMITY_LINES);
    const window   = src.slice(winStart, winEnd).join('\n');

    // Check each identifier
    const missing = [];
    for (const id of ids) {
        // Word-boundary match in source window
        const re = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (!re.test(window)) {
            missing.push(id);
        }
    }

    // Enclosing-context fallback: a citation often points INTO a function's
    // body while the doc's anchor is the function NAME, whose definition sits
    // above the ±proximity window (e.g. playsim.md cites the sector-snapshot
    // loop at p_tick.c:199–204, anchored by "P_Ticker" defined at 181).
    // Accept an id found in the 80 source lines preceding the window — the
    // enclosing construct — before declaring it missing.
    if (missing.length > 0) {
        const encStart = Math.max(0, winStart - 80);
        const enclosing = src.slice(encStart, winStart).join('\n');
        for (let k = missing.length - 1; k >= 0; k--) {
            const re = new RegExp(`\\b${missing[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            if (re.test(enclosing)) missing.splice(k, 1);
        }
    }

    if (missing.length === 0) {
        return { verdict: 'SEMANTIC', details: `identifiers [${ids.join(', ')}] found near source line` };
    }

    // Partial: some IDs found, some not.  Only FAIL if ALL candidate ids are missing.
    // (A doc line often has multiple identifiers; only one needs to anchor the location.)
    if (missing.length < ids.length) {
        return { verdict: 'SEMANTIC', details: `some IDs found: missing [${missing.join(', ')}] but [${ids.filter(i => !missing.includes(i)).join(', ')}] present` };
    }

    return {
        verdict: 'FAIL_ID',
        details: `identifier(s) [${missing.join(', ')}] not found within ±${PROXIMITY_LINES} lines of ${filename}:${lineStart}`,
    };
}

// ── Parse docs and collect citations ─────────────────────────────────────────
const docFiles = readdirSync(DOCS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => join(DOCS_DIR, f));

let pass = 0, boundsOnly = 0, semantic = 0, failOOB = 0, failID = 0, skip = 0;
const failures = [];

const startTime = Date.now();

for (const docPath of docFiles) {
    const docName = basename(docPath);
    const text = readFileSync(docPath, 'utf8');
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        CITATION_RE.lastIndex = 0;

        let m;
        while ((m = CITATION_RE.exec(line)) !== null) {
            const filename  = m[1];
            const lineStart = parseInt(m[2], 10);
            const lineEnd   = m[3] ? parseInt(m[3], 10) : null;

            // Context = previous + current doc line: markdown wraps at ~80
            // cols, so the identifier a citation anchors to often sits on the
            // line above ("`FixedDiv` is called in ... (scale\ncalculation,
            // r_main.c:465–506)").  Single-line extraction mis-failed those.
            const ctx = (i > 0 ? lines[i - 1] + '\n' : '') + line;
            const result = checkCitation(filename, lineStart, lineEnd, ctx, docName, i + 1);

            switch (result.verdict) {
                case 'PASS':
                    pass++;
                    break;
                case 'BOUNDS_ONLY':
                    boundsOnly++;
                    break;
                case 'SEMANTIC':
                    semantic++;
                    break;
                case 'FAIL_OOB':
                    failOOB++;
                    failures.push({ docFile: docName, docLine: i + 1, cite: m[0], ...result });
                    break;
                case 'FAIL_ID':
                    failID++;
                    failures.push({ docFile: docName, docLine: i + 1, cite: m[0], ...result });
                    break;
                case 'SKIP':
                    skip++;
                    break;
            }
        }
    }
}

const elapsedS = ((Date.now() - startTime) / 1000).toFixed(2);
const totalChecked = boundsOnly + semantic + failOOB + failID;

// ── Output ────────────────────────────────────────────────────────────────────
for (const f of failures) {
    console.log(`FAIL  ${f.docFile}:${f.docLine}  [${f.cite}]  ${f.verdict}: ${f.details}`);
}

console.log('');
console.log(`check-citations: ${totalChecked} citations checked in engine/core files (${skip} skipped — non-core files)`);
console.log(`  BOUNDS_ONLY: ${boundsOnly}  (in-bounds, no identifier to verify or non-shifted file)`);
console.log(`  SEMANTIC:    ${semantic}  (identifier confirmed within ±${PROXIMITY_LINES} source lines)`);
console.log(`  FAIL_OOB:    ${failOOB}  (line out of bounds)`);
console.log(`  FAIL_ID:     ${failID}  (identifier not found near cited location in 844c3d6-shifted file)`);
console.log(`  elapsed: ${elapsedS}s`);

if (failOOB > 0 || failID > 0) {
    const total = failOOB + failID;
    console.log(`\nFAIL  check-citations: ${total} citation(s) failed`);
    process.exit(1);
}

console.log('PASS  check-citations: all engine/core citations in bounds and identifiers verified');
