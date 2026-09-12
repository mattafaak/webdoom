#!/usr/bin/env node
// tools/check-cdp-ports.mjs — no two legs may claim the same port.
//
// Found by inspection, not by a failure: four CDP debugging ports were declared
// twice each —
//   9224  browser-resilience-test, browser-net-test
//   9230  browser-ierror-test,     persist-test
//   9241  browser-fire-test,       browser-music-fallback-test
//   9268  browser-mp-gating-test,  browser-teardown-test
// — and three HTTP ports likewise (8669, 8671, 8672, 8677).
//
// The suite runs legs sequentially, so a collision is usually harmless and
// therefore invisible. What it is NOT harmless for is the failure this repo has
// already had: an orphaned Chrome or serve.js from one leg is a wedged port for
// the next, which is the shape README records behind the browser-lobby T07
// flake. A duplicate port turns one leg's leak into another leg's red, and the
// red lands on the innocent leg.
//
// Reports, and grades, only DECLARATIONS of the form
//     const CDP_PORT = 9223;   const PORT = 8670;   const CDP = 9236;
// at the top level of a tools/*.mjs file. A port computed at runtime
// (PORT_BASE++ in demo-store-fuzz-test.mjs) is deliberately out of scope: it
// allocates its own range and cannot collide with a literal by construction.
//
// usage: node tools/check-cdp-ports.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = execSync('git ls-files tools/*.mjs tools/*.sh', { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);

// The name pattern needs the leading segment OPTIONAL.  Written as
// /[A-Z][A-Z0-9_]*(?:PORT|CDP).../ it required at least one character before
// "PORT", so it matched CDP_PORT, DOOM_PORT and SPAWN_PORT and silently missed
// the plainest spelling of all -- `const PORT = 8671;` -- which is exactly how
// four of the seven collisions were written.  The first run of this check
// reported "22 declarations, all distinct" over a repo with three files sharing
// 8671, i.e. it passed by not looking, which is the defect it exists to catch.
const NAME = '(?:[A-Z][A-Z0-9_]*_)?(?:PORT|CDP)[A-Z0-9_]*';
const DECL = new RegExp(`^(?:const|let|var)\\s+(${NAME})\\s*=\\s*(\\d{4,5})\\s*;`, 'gm');
const SH   = new RegExp(`^(${NAME})=(\\d{4,5})\\b`, 'gm');

const claims = new Map();   // port -> [{file, name}]
for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const re of [DECL, SH]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const port = +m[2];
            if (port < 1024 || port > 65535) continue;
            if (!claims.has(port)) claims.set(port, []);
            claims.get(port).push({ file: basename(f), name: m[1] });
        }
    }
}

// Discovery that finds almost nothing is a broken check, not a clean repo.
const MIN_EXPECTED = 30;
if (claims.size < MIN_EXPECTED) {
    console.log(`FAIL check-cdp-ports: discovered only ${claims.size} port declarations across `
              + `${files.length} files — the matcher is broken, not the repo`);
    process.exit(1);
}

const dupes = [...claims.entries()].filter(([, who]) => who.length > 1).sort((a, b) => a[0] - b[0]);
for (const [port, who] of dupes) {
    console.log(`FAIL port ${port} is claimed by ${who.length}: `
              + who.map(w => `${w.file} (${w.name})`).join(', '));
}
if (dupes.length) {
    console.log(`check-cdp-ports: ${dupes.length} duplicated port(s) of ${claims.size} declared`);
    process.exit(1);
}
console.log(`PASS — check-cdp-ports: ${claims.size} port declarations across ${files.length} files, all distinct`);
