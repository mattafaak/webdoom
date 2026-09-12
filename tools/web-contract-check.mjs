#!/usr/bin/env node
// tools/web-contract-check.mjs — engine/web/web.h is the core<->platform
// contract, so it has to be true (task 25.2).
//
// spec.md tenet 5: a future no-OS port "starts from this repo's documentation,
// not from folklore", and web.h is that documentation.  It described 5 of 73
// exports, none of them the ones a port can get fatally wrong, and it declared
// web_net_setup with TWO parameters against a three-parameter definition.  That
// survived because no translation unit both included the header and called the
// function — an unused declaration is checked by nothing.
//
// Two invariants, both of which caught a real error the day they were written:
//   1. every declaration in web.h that names a function defined in engine/web
//      must match its definition (arity and return type).  Writing the section
//      by hand produced `void web_seek_demo(...)` against an `int` definition;
//      the compiler caught that one only because the header is included.
//   2. every export taking a POINTER must be declared.  Those are the calls
//      whose bound the callee cannot derive, and every one of them has already
//      been the site of a defect (task 23).
//
// usage: node tools/web-contract-check.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB  = join(root, 'engine/web');
const header = readFileSync(join(WEB, 'web.h'), 'utf8');

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
const norm  = p => p.trim().replace(/\s+/g, ' ').replace(/\s*\*\s*/g, '* ');
const arity = p => (norm(p) === '' || norm(p) === 'void') ? 0 : norm(p).split(',').length;

// ── definitions in engine/web/*.c ────────────────────────────────────────────
const defs = new Map();
for (const f of readdirSync(WEB).filter(n => n.endsWith('.c'))) {
    const src = strip(readFileSync(join(WEB, f), 'utf8'));
    for (const m of src.matchAll(/EMSCRIPTEN_KEEPALIVE\s+([A-Za-z_][\w ]*?[\w*])\s+(\w+)\s*\(([^)]*)\)/g))
        defs.set(m[2], { ret: norm(m[1]), params: norm(m[3]), file: f });
}

// ── declarations in web.h ────────────────────────────────────────────────────
const decls = new Map();
for (const m of strip(header).matchAll(/^\s*([A-Za-z_][\w ]*?[\w*])\s+(\w+)\s*\(([^)]*)\)\s*;/gm))
    decls.set(m[2], { ret: norm(m[1]), params: norm(m[3]) });

let bad = 0;
const fail = (w, d) => { console.log(`FAIL ${w}`); if (d) console.log(d); bad++; };

if (defs.size < 40) { console.log(`FAIL web-contract: parsed only ${defs.size} exports — the scan is broken.`); process.exit(1); }
if (decls.size < 5) { console.log(`FAIL web-contract: parsed only ${decls.size} declarations — the scan is broken.`); process.exit(1); }

// 1. declaration must match definition
const mismatched = [];
for (const [name, d] of decls) {
    const def = defs.get(name);
    if (!def) continue;                      // declared elsewhere (core, or not an export)
    if (arity(d.params) !== arity(def.params))
        mismatched.push(`    ${name}: web.h declares ${arity(d.params)} param(s), ${def.file} defines ${arity(def.params)}`);
    else if (d.ret.replace(/\s/g, '') !== def.ret.replace(/\s/g, ''))
        mismatched.push(`    ${name}: web.h returns '${d.ret}', ${def.file} returns '${def.ret}'`);
}
if (mismatched.length) fail(`web-contract: ${mismatched.length} declaration(s) disagree with their definition`, mismatched.join('\n'));

// 2. every pointer-taking export must be in the contract
const ptrExports = [...defs].filter(([, d]) => d.params.includes('*')).map(([n]) => n);
const undeclared = ptrExports.filter(n => !decls.has(n));
if (undeclared.length) fail(
    `web-contract: ${undeclared.length} export(s) take a pointer but are not declared in web.h`,
    undeclared.map(n => `    ${n} (${defs.get(n).params})  [${defs.get(n).file}]`).join('\n') +
    '\n  These are the calls whose bound the callee cannot derive. Declare them with the bound stated.');

if (bad) { console.log(`\nweb-contract-check: ${bad} problem(s)`); process.exit(1); }
console.log(`PASS web-contract-check: ${defs.size} exports, ${decls.size} declarations — ` +
            `all ${ptrExports.length} pointer-taking exports are in the contract, ` +
            'and every declaration matches its definition');
