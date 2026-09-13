#!/usr/bin/env node
// check-heredoc-lang.mjs — lint the code that lives inside shell heredocs.
//
// tools/lint.sh runs `node --check` over .mjs/.js and clang-format over C, and
// shellcheck covers the shell. NONE of them can see inside a heredoc, so a
// tracked shell script may carry hundreds of lines of another language that no
// gate has ever parsed. This repo has three: tools/fleet-bench.sh (232 lines of
// Python), tools/freestanding/be-check.sh and run-check.sh (10 each).
//
// py_compile is the floor, not the ceiling, and the difference matters: it
// catches a syntax error but NOT a name that is never defined, because the
// module compiles and the name resolves at runtime or not at all. So this also
// flags a bare `os.`/`sys.`/`re.`/`json.` use with no matching import -- the
// exact shape that once let a heredoc die NameError after restarting a service.
//
// usage: node tools/check-heredoc-lang.mjs [FILE...]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = process.argv.length > 2
    ? process.argv.slice(2)
    : execSync("git ls-files '*.sh'", { encoding: 'utf8' }).split('\n').filter(Boolean);

// `cmd <<'TAG'` ... `TAG`. Quoted tag only: an unquoted one interpolates shell
// variables, so what is on disk is not what the interpreter sees and parsing it
// would report errors that do not exist at run time.
const OPEN = /<<-?'([A-Z][A-Z0-9_]*)'\s*$/;
const MODULES = ['os', 'sys', 're', 'json', 'math', 'subprocess', 'statistics', 'time', 'collections', 'pathlib'];

const blocks = [];
for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    let tag = null, start = 0, body = [];
    for (let i = 0; i < lines.length; i++) {
        if (tag === null) {
            const m = OPEN.exec(lines[i]);
            // The interpreter is not always on the same line: fleet-bench.sh
            // opens its heredoc four backslash-continuations below `python3 -`.
            // Walk back over the whole logical command before deciding.
            if (m) {
                let j = i, span = lines[i];
                while (j > 0 && /\\\s*$/.test(lines[j - 1])) { j--; span = lines[j] + '\n' + span; }
                if (/\bpython3?\b/.test(span)) { tag = m[1]; start = i + 1; body = []; }
            }
            continue;
        }
        if (lines[i].trim() === tag) { blocks.push({ f, tag, line: start + 1, src: body.join('\n') }); tag = null; continue; }
        body.push(lines[i]);
    }
}

// A discovery that finds nothing is broken, not clean: this repo has three.
if (blocks.length < 3) {
    console.log(`FAIL heredoc-lang: discovered only ${blocks.length} python heredoc(s) across ` +
                `${files.length} shell script(s); there are at least 3. The scanner or the scripts changed.`);
    process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'heredoc-'));
let bad = 0, checked = 0;
for (const b of blocks) {
    const p = join(dir, `${b.f.replace(/\W/g, '_')}_${b.line}.py`);
    writeFileSync(p, b.src);
    checked++;
    try {
        execSync(`python3 -m py_compile ${JSON.stringify(p)}`, { stdio: 'pipe' });
    } catch (e) {
        bad++;
        console.log(`FAIL ${b.f}:${b.line} (<<'${b.tag}'): python syntax error`);
        console.log('    ' + String(e.stderr ?? e).trim().split('\n').slice(-2).join('\n    '));
        continue;
    }
    // py_compile cannot catch this: the module compiles and the name is only
    // resolved when that line runs.
    for (const mod of MODULES) {
        const used = new RegExp(`(^|[^\\w.])${mod}\\.`, 'm').test(b.src);
        const imported = new RegExp(`^\\s*(import\\s+${mod}\\b|from\\s+${mod}\\b|import\\s+[^#\\n]*\\b${mod}\\b)`, 'm').test(b.src);
        if (used && !imported) {
            bad++;
            console.log(`FAIL ${b.f}:${b.line} (<<'${b.tag}'): uses ${mod}. with no import ${mod} — ` +
                        `this compiles and dies NameError at run time`);
        }
    }
}
rmSync(dir, { recursive: true, force: true });

if (bad) { console.log(`heredoc-lang: ${bad} problem(s) in ${checked} block(s)`); process.exit(1); }
const lines = blocks.reduce((n, b) => n + b.src.split('\n').length, 0);
console.log(`PASS heredoc-lang: ${checked} python heredoc(s), ${lines} lines, compile clean and import what they use ` +
            `(${blocks.map(b => `${b.f}:${b.line}`).join(', ')})`);
