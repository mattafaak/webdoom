#!/usr/bin/env node
// doc-drift.mjs — three-way drift check: doc figure == manifest.expected == script actual
//
// Each verified claim must satisfy:
//   doc_figure (parsed from docs/*.md) == manifest.expected (claims.json) == script_actual
//
// Disagreements are distinguished:
//   DOC_ERROR:       doc says X, manifest/script say Y  → someone edited the doc
//   MANIFEST_STALE:  manifest says X, script/doc say Y  → claims.json needs updating
//   SCRIPT_FAIL:     script says X, doc/manifest say Y  → source changed or script bug
//
// Usage:
//   node tools/archaeology/doc-drift.mjs [--script-values path.json] [--full] [--json-only]
//
// --script-values: JSON file with {claim_id: actual_value} from running family scripts
// --full:          also check runtime-stat and measurement-stamp families
// --json-only:     suppress soft/pass claim-level output, only print failures + summary
//
// Exits 0 if all hard checks pass; exits 1 if any hard failure.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const docsDir = join(root, 'docs');

// ── Parse CLI args ────────────────────────────────────────────────────────────
let scriptValuesPath = null;
let fullMode = false;
let jsonOnly = false;
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--script-values') { scriptValuesPath = process.argv[++i]; }
    else if (process.argv[i] === '--full') { fullMode = true; }
    else if (process.argv[i] === '--json-only') { jsonOnly = true; }
}

// ── Load manifest ─────────────────────────────────────────────────────────────
const manifestPath = join(root, 'tools/archaeology/claims.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// ── Load script actual values (if provided) ───────────────────────────────────
const scriptValues = scriptValuesPath && existsSync(scriptValuesPath)
    ? JSON.parse(readFileSync(scriptValuesPath, 'utf8'))
    : {};

// ── Load and parse claims-index.md for doc locators ──────────────────────────
const indexPath = join(docsDir, 'claims-index.md');
const indexText = readFileSync(indexPath, 'utf8');

// Parse table rows: | id | doc:line | claim | value | type | reproducer | status |
const docIndex = {};
for (const line of indexText.split('\n')) {
    const m = line.match(/^\|\s*(\w+-\d+)\s*\|\s*(\S+):(\d+)\s*\|/);
    if (m) {
        const [, id, docFile, lineStr] = m;
        docIndex[id] = { doc_file: docFile, doc_line: parseInt(lineStr, 10) };
    }
}

// ── Doc file cache ────────────────────────────────────────────────────────────
const docCache = {};
function loadDoc(filename) {
    if (!docCache[filename]) {
        const p = join(docsDir, filename);
        docCache[filename] = existsSync(p) ? readFileSync(p, 'utf8').split('\n') : null;
    }
    return docCache[filename];
}

// ── Normalize a value for comparison ─────────────────────────────────────────
// Removes commas, converts hex to decimal, normalizes C-literal array syntax,
// strips trailing ".0" from floats, and trims whitespace.
function normalize(v) {
    if (v === null || v === undefined) return null;
    let s = String(v).replace(/,/g, '').trim();
    // Convert hex strings to decimal
    const hexM = s.match(/^(0x[0-9a-fA-F]+)$/i);
    if (hexM) return String(parseInt(hexM[1], 16));
    // Normalize C array literal {a b c} → [a b c] for comparison with JSON arrays
    if (s.startsWith('{') && s.endsWith('}')) {
        s = '[' + s.slice(1, -1) + ']';
    }
    // Strip trailing ".0" from floating-point numbers: "0.0%" → "0%"
    s = s.replace(/(\d+)\.0(\D|$)/g, '$1$2');
    return s;
}

// ── Generate search patterns for simple value lookup ─────────────────────────
// Returns strings to search for in doc text.
function searchPatterns(expected) {
    const s = String(expected);
    const pats = new Set([s, normalize(s)].filter(Boolean));
    // Add comma-formatted version for large integers
    const intM = s.match(/^-?(\d+)$/);
    if (intM) {
        const n = parseInt(s, 10);
        if (Math.abs(n) >= 1000) {
            pats.add(Math.abs(n).toLocaleString('en-US'));
        }
    }
    return [...pats];
}

// ── Per-claim doc patterns ────────────────────────────────────────────────────
// Each entry has:
//   doc_file (optional, overrides docIndex)
//   needle: a string that must appear in the doc window for context validation
//   extract_re: regex with ONE capture group returning the raw value
//   transform(raw): optional function to convert raw capture → final value string
//   soft: true to skip hard doc check (explain in reason)
//   reason: explanation for soft claims
//
// For the three-way check, the extracted value is normalized and compared to
// normalize(manifest.expected). Both hex → decimal conversions are handled by normalize().
const DOC_HINTS = {
    // ── engine-archaeology.md ────────────────────────────────────────────────
    'ea-001': { doc_file: 'engine-archaeology.md',
                needle: 'finesine entries differ',
                extract_re: /([\d,]+) of 10,240 finesine entries differ/ },

    'ea-002': { doc_file: 'engine-archaeology.md',
                needle: 'leaves **',
                extract_re: /leaves\s+\*\*([\d]+)\s+finesine/ },

    'ea-003': { doc_file: 'engine-archaeology.md',
                needle: 'FNV over all',
                extract_re: /FNV over all ([\d,]+) entries/ },

    // ea-004: the doc states '2^37', not the literal integer 137438953472.
    // Two-way (manifest vs script) check is sufficient for the analytic threshold.
    'ea-004': { soft: true,
                reason: "doc states '2^37' (mathematical expression), not the literal 137438953472; two-way manifest/script check sufficient" },

    // ea-005/006: guard-edge sweep corroboration figures.
    // "Corroboration: **8,388,608** guard-edge\npairs checked ... → **0**\nmismatches."
    'ea-005': { doc_file: 'engine-archaeology.md',
                needle: 'guard-edge',
                extract_re: /\*\*([\d,]+)\*\*\s+guard-edge/ },

    'ea-006': { doc_file: 'engine-archaeology.md',
                needle: 'could occur)',
                extract_re: /could occur\)\s+→\s+\*\*(\d+)\*\*/ },

    'ea-007': { doc_file: 'engine-archaeology.md',
                needle: '128.85',
                extract_re: /mean\s+([\d.]+)\s*\(not/ },

    // ── COLORMAP §6 (task 6.3): the flagship claims. ea-018 is the headline
    //    result quoted in the public docs/magic-data.md writeup; ea-023 is the
    //    figure that shipped WRONG (242→241) until 6.1's inventory caught it.
    //    These are exactly the numbers that most need drift protection.
    'ea-018': { doc_file: 'engine-archaeology.md',
                needle: 'mismatches on doom.wad',
                extract_re: /\*\*([\d,]+)\s*\/\s*8,192\s+mismatches\s+on\s+doom\.wad/ },

    'ea-019': { doc_file: 'engine-archaeology.md',
                needle: 'truncation instead of rounding',
                extract_re: /truncation instead of rounding misses by ([\d,]+)/ },

    'ea-020': { doc_file: 'engine-archaeology.md',
                needle: 'scale misses by',
                extract_re: /scale misses by ([\d,]+)/ },

    // ea-021: the doc states "Manhattan ... miss by 1,200+" — a LOWER BOUND, not
    // an exact figure, so there is nothing to extract and compare. The script's
    // actual (1208) is still checked against the manifest two-way; only the doc
    // parse is skipped. Tightening the doc to an exact number would over-claim
    // precision the original sentence deliberately didn't assert.
    'ea-021': { soft: true,
                reason: "doc states '1,200+' (a lower bound), not an exact figure" },

    // ea-023: anchored on "matching **N/256**" so it can't accidentally bind to
    // another N/256 figure in the window (e.g. the "15/256 mismatches" clause
    // in the same sentence). This is the claim that shipped wrong (242→241).
    'ea-023': { doc_file: 'engine-archaeology.md',
                needle: 'then nearest gray — matching',
                extract_re: /matching\s*\*\*([\d]+)\/256\*\*/ },

    // ea-026: FINDING-4 (task 6.3) — the doc originally said "standard luma
    // missed by 92" without pinning the weight set; nearby ITU roundings score
    // 88 (77/151/28), 91 (77/150/29) and 93 (76/150/30), so 92 matched none of
    // them and the claim was not reproducible. The doc now pins 77/150/29 @
    // A=254 → 91, which the cracker reproduces exactly.
    'ea-026': { doc_file: 'engine-archaeology.md',
                needle: 'standard luma missed by',
                extract_re: /standard luma missed by\s*([\d]+)/ },

    'ea-024': { doc_file: 'engine-archaeology.md',
                needle: 'residual 15 are nearest-colour',
                extract_re: /residual ([\d]+) are nearest-colour/ },

    'ea-025': { doc_file: 'engine-archaeology.md',
                needle: 'Weights sum to',
                extract_re: /Weights sum to ([\d]+)/ },

    'ea-027': { doc_file: 'engine-archaeology.md',
                needle: 'ALL 9 CASES',
                extract_re: /ALL ([\d]+) CASES/ },

    'ea-029': { doc_file: 'engine-archaeology.md',
                needle: 'Total ledger rows',
                extract_re: /Total ledger rows:\s*\*?\*?([\d]+)/ },

    'ea-008': { doc_file: 'engine-archaeology.md',
                needle: '166 of 256 values distinct',
                extract_re: /only\s+([\d]+)\s+of\s+256\s+values\s+distinct/ },

    'ea-009': { doc_file: 'engine-archaeology.md',
                needle: '90 values of 0',
                extract_re: /,\s*([\d]+)\s+values\s+of\s+0/ },

    // gamma table: each level is a separate table row  "|  N  | ~γ  |  MM  |"
    'ea-010': { doc_file: 'engine-archaeology.md',
                needle: '| 0 | ~',
                extract_re: /\|\s*0\s*\|\s*~[\d.]+\s*\|\s*([\d]+)\s*\/?\s*256?\s*\|/ },
    'ea-011': { doc_file: 'engine-archaeology.md',
                needle: '| 1 | ~1.15',
                extract_re: /\|\s*1\s*\|\s*~[\d.]+\s*\|\s*([\d]+)\s*\|/ },
    'ea-012': { doc_file: 'engine-archaeology.md',
                needle: '| 2 | ~1.34',
                extract_re: /\|\s*2\s*\|\s*~[\d.]+\s*\|\s*([\d]+)\s*\|/ },
    'ea-013': { doc_file: 'engine-archaeology.md',
                needle: '| 3 | ~1.61',
                extract_re: /\|\s*3\s*\|\s*~[\d.]+\s*\|\s*([\d]+)\s*\|/ },
    'ea-014': { doc_file: 'engine-archaeology.md',
                needle: '| 4 | ~2.011',
                extract_re: /\|\s*4\s*\|\s*~[\d.]+\s*\|\s*([\d]+)\s*\|/ },

    'ea-015': { doc_file: 'engine-archaeology.md',
                needle: '+11.8% at 26.6°',
                extract_re: /\*\*([\+\d.]+%)\s+at\s+26/,
                transform: v => v.startsWith('+') ? v : '+' + v },
    'ea-016': { doc_file: 'engine-archaeology.md',
                needle: 'only +6.1%',
                extract_re: /only\s+\+([\d.]+)%/,
                transform: v => '+' + v + '%' },
    'ea-017': { doc_file: 'engine-archaeology.md',
                needle: 'never underestimates',
                extract_re: /\((\d+)%\s+error\s+on\s+the\s+axes\)/,
                transform: v => v + '%' },

    'ea-022': { doc_file: 'engine-archaeology.md',
                needle: '249/256',
                extract_re: /\(([\d]+)\/256\)\s*—\s*a handful/ },

    // ── renderer.md ──────────────────────────────────────────────────────────
    'rdr-001': { doc_file: 'renderer.md',
                 needle: 'MAXSEGS  64',
                 // "MAXSEGS  64    // webdoom: was 32" → capture "32"
                 extract_re: /MAXSEGS\s+\d+\s+\/\/[^:]+:\s+was\s+(\d+)/ },

    'rdr-002': { doc_file: 'renderer.md',
                 needle: '#define MAXSEGS  64',
                 extract_re: /#define\s+MAXSEGS\s+(\d+)/ },

    'rdr-003': { doc_file: 'renderer.md',
                 // "was *64" means vanilla MAXOPENINGS was SCREENWIDTH*64 = 20480
                 needle: 'was *64',
                 extract_re: /was\s+\*(\d+)/,
                 transform: v => String(320 * parseInt(v, 10)) },

    'rdr-004': { doc_file: 'renderer.md',
                 needle: 'SCREENWIDTH*256',
                 extract_re: /SCREENWIDTH\*(\d+)/,
                 transform: v => String(320 * parseInt(v, 10)) },

    'rdr-005': { doc_file: 'renderer.md',
                 // Table: "| MAXVISPLANES | 128 | 1024 | ..."
                 needle: '| MAXVISPLANES |',
                 extract_re: /\|\s*`MAXVISPLANES`\s*\|\s*([\d,]+)\s*\|/ },

    'rdr-006': { doc_file: 'renderer.md',
                 // Same table row, second numeric column
                 needle: '| MAXVISPLANES |',
                 extract_re: /\|\s*`MAXVISPLANES`\s*\|\s*[\d,]+\s*\|\s*([\d,]+)\s*\|/ },

    'rdr-007': { doc_file: 'renderer.md',
                 needle: '| `MAXDRAWSEGS` |',
                 extract_re: /\|\s*`MAXDRAWSEGS`\s*\|\s*([\d,]+)\s*\|/ },

    'rdr-008': { doc_file: 'renderer.md',
                 needle: '| `MAXDRAWSEGS` |',
                 extract_re: /\|\s*`MAXDRAWSEGS`\s*\|\s*[\d,]+\s*\|\s*([\d,]+)\s*\|/ },

    'rdr-009': { doc_file: 'renderer.md',
                 needle: '| `MAXVISSPRITES` |',
                 extract_re: /\|\s*`MAXVISSPRITES`\s*\|\s*([\d,]+)\s*\|/ },

    'rdr-010': { doc_file: 'renderer.md',
                 needle: '| `MAXVISSPRITES` |',
                 extract_re: /\|\s*`MAXVISSPRITES`\s*\|\s*[\d,]+\s*\|\s*([\d,]+)\s*\|/ },

    'rdr-011': { doc_file: 'renderer.md',
                 needle: 'ANGLETOSKYSHIFT = 22',
                 extract_re: /ANGLETOSKYSHIFT\s*=\s*(\d+)/ },

    // ── playsim.md ───────────────────────────────────────────────────────────
    'ps-001': { doc_file: 'playsim.md',
                // "#define MAXSPECIALCROSS  64   // webdoom: was 8"
                needle: 'was 8; big PWAD',
                extract_re: /was\s+(\d+);\s+big\s+PWAD/ },

    'ps-002': { doc_file: 'playsim.md',
                needle: '#define MAXSPECIALCROSS  64',
                extract_re: /#define\s+MAXSPECIALCROSS\s+(\d+)/ },

    'ps-004': { doc_file: 'playsim.md',
                needle: '#define MAXINTERCEPTS  128',
                extract_re: /#define\s+MAXINTERCEPTS\s+(\d+)/ },

    'ps-006': { doc_file: 'playsim.md',
                needle: 'BACKUPTICS = 35',
                extract_re: /BACKUPTICS\s*=\s*(\d+)/ },

    'ps-007': { doc_file: 'playsim.md',
                // "was 0x2c000; big maps overran"
                needle: 'was 0x2c000',
                extract_re: /was\s+(0x2c000)/i,
                transform: v => String(parseInt(v, 16)) },

    'ps-008': { doc_file: 'playsim.md',
                needle: '#define SAVEGAMESIZE  0x80000',
                extract_re: /#define\s+SAVEGAMESIZE\s+(0x[\dA-Fa-f]+)/,
                transform: v => String(parseInt(v, 16)) },

    'ps-009': { doc_file: 'playsim.md',
                needle: 'MAX_DEATHMATCH_STARTS = 10',
                extract_re: /MAX_DEATHMATCH_STARTS\s*=\s*(\d+)/ },

    'ps-010': { doc_file: 'playsim.md',
                needle: 'MAXHEALTH = 100',
                extract_re: /MAXHEALTH\s*=\s*(\d+)/ },

    'ps-011': { doc_file: 'playsim.md',
                // "`player->bonuscount += BONUSADD` (= 6, defined at p_inter.c:51)"
                needle: 'BONUSADD` (= 6',
                extract_re: /BONUSADD`\s*\(=\s*(\d+)/ },

    'ps-012': { doc_file: 'playsim.md',
                // "FLOATSPEED = 4*FRACUNIT per tic" → 4*65536 = 262144
                needle: 'FLOATSPEED = 4*FRACUNIT',
                extract_re: /FLOATSPEED\s*=\s*(\d+)\*FRACUNIT/,
                transform: v => String(parseInt(v, 10) * 65536) },

    'ps-013': { soft: true, reason: 'forwardmove array literal not in playsim.md prose' },
    'ps-014': { soft: true, reason: 'sidemove array literal not in playsim.md prose' },
    'ps-015': { soft: true, reason: 'angleturn array literal not in playsim.md prose' },

    'ps-016': { doc_file: 'playsim.md',
                needle: '#define STOPSPEED   0x1000',
                // doc: "#define STOPSPEED   0x1000   // ~0.0625 map units/tic"
                extract_re: /#define\s+STOPSPEED\s+(0x[\dA-Fa-f]+)/i },
    // normalize() converts 0x1000→4096; manifest.expected "0x1000"→normalize→"4096" → match

    'ps-017': { doc_file: 'playsim.md',
                needle: '#define FRICTION    0xe800',
                extract_re: /#define\s+FRICTION\s+(0x[eE][\dA-Fa-f]+)/i },
    // normalize() converts 0xe800→59392; manifest.expected "0xE800"→normalize→"59392" → match

    'ps-018': { doc_file: 'playsim.md',
                needle: 'diagonal speed of 47000',
                extract_re: /diagonal speed of\s*([\d,]+)/ },

    'ps-019': { doc_file: 'playsim.md',
                // "`c++ == 2` guard at p_enemy.c:520"
                needle: 'c++ == 2',
                extract_re: /c\+\+\s*==\s*(\d+)/ },

    'ps-020': { doc_file: 'playsim.md',
                needle: 'GLOWSPEED   = 8',
                extract_re: /GLOWSPEED\s*=\s*(\d+)/ },

    'ps-021': { doc_file: 'playsim.md',
                needle: 'STROBEBRIGHT = 5',
                extract_re: /STROBEBRIGHT\s*=\s*(\d+)/ },

    'ps-022': { doc_file: 'playsim.md',
                needle: 'FASTDARK    = 15',
                extract_re: /FASTDARK\s*=\s*(\d+)(?:\s+\(tics at min brightness, fast strobe\)|$|\n)/ },

    'ps-023': { doc_file: 'playsim.md',
                needle: 'SLOWDARK    = 35',
                extract_re: /SLOWDARK\s*=\s*(\d+)(?:\s+\(tics at min brightness, slow strobe\)|$|\n)/ },

    'ps-025': { doc_file: 'playsim.md',
                // "activeplats[MAXPLATS=30]"
                needle: 'MAXPLATS=30',
                extract_re: /MAXPLATS\s*=\s*(\d+)/ },

    'ps-026': { doc_file: 'playsim.md',
                needle: 'MAXBUTTONS=16',
                extract_re: /MAXBUTTONS\s*=\s*(\d+)/ },

    'ps-027': { doc_file: 'playsim.md',
                // "chatchars[QUEUESIZE=128]"
                needle: 'QUEUESIZE=128',
                extract_re: /QUEUESIZE\s*=\s*(\d+)/ },

    'ps-028': { doc_file: 'playsim.md',
                // "HU_MAXLINELENGTH+1=81"
                needle: 'HU_MAXLINELENGTH+1=81',
                extract_re: /HU_MAXLINELENGTH\+1\s*=\s*(\d+)/ },

    'ps-029': { soft: true, reason: 'runtime-stat: instrumented demo teleport count' },
    'ps-030': { soft: true, reason: 'runtime-stat: instrumented demo teleport count' },
    'ps-031': { soft: true, reason: 'runtime-stat: instrumented demo teleport count' },
    'ps-032': { soft: true, reason: 'runtime-stat: instrumented demo teleport count' },

    'ps-033': { doc_file: 'playsim.md',
                needle: '1,710',
                extract_re: /([\d,]+)\s+tics.*E1M5|E1M5.*?([\d,]+)\s+tics/,
                transform: (_v, m) => normalize(m[1] || m[2]) },

    'ps-034': { doc_file: 'playsim.md',
                needle: '818',
                extract_re: /([\d,]+)\s+tics.*E4M2|E4M2.*?([\d,]+)\s+tics/,
                transform: (_v, m) => normalize(m[1] || m[2]) },

    'ps-035': { doc_file: 'playsim.md',
                // "32 teleport events across those 4 demos"
                needle: '32 teleport events',
                extract_re: /\b(\d+)\s+teleport\s+events/ },

    // ── formats.md ───────────────────────────────────────────────────────────
    'fmt-001': { doc_file: 'formats.md',
                 needle: 'numlumps=2306',
                 extract_re: /numlumps\s*=\s*([\d,]+)/ },

    'fmt-002': { doc_file: 'formats.md',
                 needle: 'E1M1 has 88 sectors',
                 extract_re: /E1M1 has\s+([\d]+)\s+sectors/ },

    'fmt-004': { doc_file: 'formats.md',
                 needle: 'orgx=-776',
                 extract_re: /orgx\s*=\s*(-?[\d]+)/ },

    'fmt-005': { doc_file: 'formats.md',
                 needle: 'orgy=-4872',
                 extract_re: /orgy\s*=\s*(-?[\d,]+)/,
                 transform: v => normalize(v) },

    'fmt-006': { doc_file: 'formats.md',
                 // "E1M1 orgx=-776, orgy=-4872, width=36, height=23; 828 offset-table entries"
                 needle: 'width=36',
                 extract_re: /width\s*=\s*(\d+)[,;]/ },

    'fmt-007': { doc_file: 'formats.md',
                 needle: 'height=23',
                 extract_re: /height\s*=\s*(\d+)/ },

    'fmt-008': { doc_file: 'formats.md',
                 needle: '828 offset-table',
                 extract_re: /([\d]+)\s+offset-table/ },

    'fmt-009': { doc_file: 'formats.md',
                 needle: '238 nodes',
                 extract_re: /E1M1 has\s+([\d]+)\s+nodes/ },

    'fmt-010': { doc_file: 'formats.md',
                 // "239 of 476 child references point to subsectors."
                 needle: '239 of 476 child references',
                 extract_re: /([\d]+)\s+of\s+[\d]+\s+child\s+references\s+point\s+to\s+subsectors/ },

    'fmt-011': { doc_file: 'formats.md',
                 // "format=3, rate=11025, ..."
                 needle: 'format=3',
                 extract_re: /format\s*=\s*(\d+),\s*rate/ },

    'fmt-012': { doc_file: 'formats.md',
                 needle: 'rate=11025',
                 extract_re: /\brate\s*=\s*([\d,]+)/ },

    'fmt-013': { doc_file: 'formats.md',
                 needle: 'num_samples=5661',
                 extract_re: /num_samples\s*=\s*([\d,]+)/ },

    'fmt-016': { doc_file: 'formats.md',
                 needle: 'scorelen=17237',
                 extract_re: /scorelen\s*=\s*([\d,]+)/ },

    'fmt-017': { doc_file: 'formats.md',
                 needle: 'scorestart=46',
                 extract_re: /scorestart\s*=\s*(\d+)/ },

    'fmt-018': { doc_file: 'formats.md',
                 // "channels=3, sec_channels=0, instrcount=15"
                 needle: 'channels=3, sec_channels=0',
                 extract_re: /\bchannels\s*=\s*(\d+),\s*sec_channels/ },

    'fmt-019': { doc_file: 'formats.md',
                 needle: 'instrcount=15',
                 extract_re: /instrcount\s*=\s*(\d+)/ },

    'fmt-021': { doc_file: 'formats.md',
                 needle: 'MUS_RATE = 140 Hz',
                 extract_re: /MUS_RATE\s*=\s*(\d+)\s*Hz/ },

    'fmt-022': { doc_file: 'formats.md',
                 // "GENMIDI): size=11908" or "Total: 11908 bytes"
                 needle: 'size=11908',
                 extract_re: /Total:\s*([\d,]+)\s+bytes/ },

    'fmt-023': { doc_file: 'formats.md',
                 needle: '175 OPL2 instruments',
                 extract_re: /(\d+)\s+OPL2\s+instruments/ },

    'fmt-024': { doc_file: 'formats.md',
                 // "175 × genmidi_instr_t (36 bytes each)"
                 needle: 'genmidi_instr_t (36 bytes',
                 extract_re: /genmidi_instr_t\s*\((\d+)\s+bytes/ },

    'fmt-028': { doc_file: 'formats.md',
                 // "PNAMES**: 351 entries"
                 needle: '351 entries',
                 extract_re: /PNAMES.*?([\d]+)\s+entries/s },

    'fmt-030': { doc_file: 'formats.md',
                 // "TEXTURE1**: 125 textures"
                 needle: '125 textures',
                 extract_re: /TEXTURE1.*?(\d+)\s+textures/s },

    'fmt-031': { soft: true, reason: 'demo header size is derived (9+MAXPLAYERS), not a standalone number in the doc' },

    'fmt-032': { doc_file: 'formats.md',
                 needle: '6 slots',
                 extract_re: /\((\d+)\s+slots/ },

    'fmt-033': { soft: true, reason: 'boolean check (lead-in pad = 16 bytes each) not a numeric doc figure' },

    'fmt-034': { doc_file: 'formats.md',
                 needle: 'PERCUSSION_CH = 15',
                 extract_re: /PERCUSSION_CH\s*=\s*(\d+)/ },

    // ── perf.md ──────────────────────────────────────────────────────────────
    'perf-008': { doc_file: 'perf.md',
                  // "Zone pool: **32 MB** (hardcoded `ZONESIZE`...)"
                  needle: 'Zone pool',
                  extract_re: /Zone\s+pool[^|]*\*\*([\d]+)\s*MB\*\*/,
                  transform: v => String(parseInt(v, 10) * 1024 * 1024) },

    'perf-009': { doc_file: 'perf.md',
                  needle: '__heap_base',
                  extract_re: /__heap_base.*?([\d,]+)\s*bytes|^\|\s*`__heap_base`.*?\|\s*([\d,]+)/m,
                  transform: (_v, m) => normalize(m[1] || m[2]) },

    // Commit-pinned measurements: soft (they legitimately drift across commits)
    'perf-001': { soft: true, reason: 'commit-pinned size (6de6256), drift is expected' },
    'perf-002': { soft: true, reason: 'commit-pinned size (6de6256), drift is expected' },
    'perf-003': { soft: true, reason: 'commit-pinned size (6de6256), drift is expected' },
    'perf-004': { soft: true, reason: 'commit-pinned size (6de6256), drift is expected' },
    'perf-005': { soft: true, reason: 'commit-pinned size (6de6256), drift is expected' },

    'perf-011': { doc_file: 'perf.md',
                  needle: 'plutonia.wad',
                  extract_re: /plutonia\.wad[^\d]+([\d,]+)\s+bytes/ },

    'perf-059': { doc_file: 'perf.md',
                  needle: '54.83 MB',
                  extract_re: /([\d.]+)\s*MB.*?worst.*?PWAD|worst.*?PWAD[^|]*?([\d.]+)\s*MB/s,
                  transform: (_v, m) => m[1] || m[2] },

    // Derived (doc has table with values)
    'perf-036': { doc_file: 'perf.md',
                  needle: 'R_DrawColumn',
                  extract_re: /\|\s*R_DrawColumn[^\|]*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*([\d,]+)\s*\|/ },

    'perf-039': { doc_file: 'perf.md',
                  needle: 'R_DrawSpan',
                  extract_re: /\|\s*R_DrawSpan\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*([\d,]+)\s*\|/ },

    // Runtime-stat: soft for doc check (values are from instrumented build)
    'ps-003':   { soft: true, reason: 'runtime-stat: peak numspechit from instrumented build' },
    'perf-034': { soft: true, reason: 'runtime-stat: R_DrawColumn stats from instrumented build' },
    'perf-035': { soft: true, reason: 'runtime-stat: R_DrawColumn stats from instrumented build' },
    'perf-037': { soft: true, reason: 'runtime-stat: R_DrawSpan stats from instrumented build' },
    'perf-038': { soft: true, reason: 'runtime-stat: R_DrawSpan stats from instrumented build' },
    'perf-045': { soft: true, reason: 'runtime-stat: R_FindPlane stats from instrumented build' },
    'perf-046': { soft: true, reason: 'runtime-stat: R_FindPlane stats from instrumented build' },
    'perf-047': { soft: true, reason: 'runtime-stat: visplane peak from instrumented build' },
    'perf-048': { soft: true, reason: 'runtime-stat: R_FindPlane stats from instrumented build' },
    'perf-049': { soft: true, reason: 'runtime-stat: R_FindPlane stats from instrumented build' },
    'perf-050': { soft: true, reason: 'runtime-stat: visplane peak from instrumented build' },
};

// ── Extract doc figure for a claim ───────────────────────────────────────────
function extractDocFigure(claimId, expected) {
    const hint = DOC_HINTS[claimId] || {};

    if (hint.soft) return { soft: true, reason: hint.reason || 'no doc pattern' };

    const docInfo = docIndex[claimId];
    const docFile = hint.doc_file || (docInfo && docInfo.doc_file);
    if (!docFile) return { soft: true, reason: 'claim not in claims-index.md' };

    const lines = loadDoc(docFile);
    if (!lines) return { error: `doc file not found: ${docFile}` };

    // Search window: ±35 lines around the line-number hint (or full doc if no hint)
    const lineHint = docInfo ? docInfo.doc_line : null;
    const winStart = lineHint ? Math.max(0, lineHint - 36) : 0;
    const winEnd   = lineHint ? Math.min(lines.length, lineHint + 36) : lines.length;
    const window   = lines.slice(winStart, winEnd).join('\n');

    // For claims with extract_re: search in window first, then full doc
    if (hint.extract_re) {
        const needle = hint.needle;
        // If needle exists, confirm context is present (use window or expand to full doc)
        const searchIn = (needle && !window.includes(needle))
            ? lines.join('\n')   // expand to full doc if needle not in window
            : window;

        const m = searchIn.match(hint.extract_re);
        if (!m) {
            // Not found anywhere
            return { found: false, searched: docFile };
        }
        const raw = m[1] !== undefined ? m[1] : m[0];
        const val = hint.transform ? hint.transform(raw, m) : normalize(raw);
        return { found: true, raw, normalized: val };
    }

    // No extract_re: search for the expected value (in various formats)
    const pats = searchPatterns(expected);
    const fullText = lines.join('\n');
    for (const pat of pats) {
        if (window.includes(pat) || fullText.includes(pat)) {
            return { found: true, raw: pat, normalized: normalize(pat) };
        }
    }

    return { found: false, searched: docFile };
}

// ── Three-way comparison ──────────────────────────────────────────────────────
function threeWayCheck(claimId, manifestExpected, docResult, scriptActual) {
    const mn = normalize(manifestExpected);
    const sn = scriptActual !== undefined && scriptActual !== null
        ? normalize(String(scriptActual)) : null;

    if (docResult.soft) {
        // Two-way: manifest vs script only
        if (sn !== null && sn !== mn) {
            return {
                verdict: 'FAIL',
                type: 'MANIFEST_STALE',
                message: `manifest says '${mn}', script says '${sn}' [doc-soft: ${docResult.reason}]`,
            };
        }
        return { verdict: 'SOFT', message: docResult.reason };
    }

    if (docResult.error) {
        return { verdict: 'FAIL', type: 'DOC_MISSING', message: docResult.error };
    }

    if (!docResult.found) {
        const scriptStatus = sn !== null ? `, script='${sn}'` : '';
        return {
            verdict: 'FAIL',
            type: 'DOC_NOT_FOUND',
            message: `doc figure for '${mn}' not found in ${docResult.searched}; manifest='${mn}'${scriptStatus}`,
        };
    }

    const dn = docResult.normalized;

    // Full three-way logic
    if (dn === mn && (sn === null || sn === mn)) {
        return { verdict: 'PASS' };
    }
    if (dn !== mn && (sn === null || sn === dn)) {
        return { verdict: 'FAIL', type: 'MANIFEST_STALE',
                 message: `manifest says '${mn}', doc${sn !== null ? '/script' : ''} say '${dn}'` };
    }
    if (dn !== mn && sn === mn) {
        return { verdict: 'FAIL', type: 'DOC_ERROR',
                 message: `doc says '${dn}', manifest/script say '${mn}'` };
    }
    if (dn === mn && sn !== null && sn !== mn) {
        return { verdict: 'FAIL', type: 'SCRIPT_FAIL',
                 message: `script says '${sn}', doc/manifest say '${mn}' — source may have changed` };
    }
    // All three differ
    return { verdict: 'FAIL', type: 'THREE_WAY_MISMATCH',
             message: `doc='${dn}', manifest='${mn}', script='${sn ?? '(not run)'}'` };
}

// ── Main check loop ───────────────────────────────────────────────────────────
const fastFamilies = new Set(['source-constant', 'wad-data', 'recipe-crack', 'derived-check']);
const fullFamilies = new Set([...fastFamilies, 'runtime-stat', 'measurement-stamp']);
const activeFamilies = fullMode ? fullFamilies : fastFamilies;

let pass = 0, fail = 0, soft = 0;
const failDetails = [];
const softDetails = [];

for (const [id, entry] of Object.entries(manifest.claims)) {
    if (entry.status === 'unverifiable') continue;
    if (!activeFamilies.has(entry.family)) continue;
    const expected = entry.expected;
    if (expected === null || expected === undefined) continue;

    const scriptActual = id in scriptValues ? scriptValues[id] : undefined;
    const docResult = extractDocFigure(id, expected);
    const result = threeWayCheck(id, expected, docResult, scriptActual);

    if (result.verdict === 'PASS') {
        pass++;
        if (!jsonOnly) console.log(`PASS  ${id}`);
    } else if (result.verdict === 'SOFT') {
        soft++;
        softDetails.push({ id, msg: result.message });
        if (!jsonOnly) console.log(`SOFT  ${id}  [${result.message}]`);
    } else {
        fail++;
        failDetails.push({ id, type: result.type, msg: result.message });
        console.log(`FAIL  ${id}  [${result.type}] ${result.message}`);
    }
}

const total = pass + fail + soft;
console.log(`\ndoc-drift: ${pass} pass, ${fail} fail, ${soft} soft (of ${total} checked)`);
if (failDetails.length > 0) {
    console.log('\nFailed claims:');
    for (const f of failDetails) {
        console.log(`  ${f.id}: [${f.type}] ${f.msg}`);
    }
}
if (softDetails.length > 0 && !jsonOnly) {
    console.log('\nSoft (doc-parse skipped — two-way manifest/script check only):');
    for (const s of softDetails) {
        console.log(`  ${s.id}: ${s.msg}`);
    }
}

if (fail > 0) process.exit(1);
