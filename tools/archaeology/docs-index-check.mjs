#!/usr/bin/env node
// tools/archaeology/docs-index-check.mjs — no document may be unreachable.
//
// docs/ held 26 markdown files and ~13,700 lines with no index of any kind, and
// README.md linked eight of them. The eighteen that were unreachable from the
// front door included both index documents (claims-index, promises-index), the
// published magic-data writeup, both atlases, the optimization ledger, the suite
// baseline, all three decision records and every hardware bring-up. Nothing was
// missing; nothing could be found either.
//
// docs/README.md is that index, and this makes it stay one: every tracked file
// under docs/ must be linked from it. A document nobody links is a document
// nobody reads, and adding one is exactly the moment it is cheap to say where
// it belongs.
//
// usage: node tools/archaeology/docs-index-check.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root  = join(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = 'docs/README.md';
const text  = readFileSync(join(root, INDEX), 'utf8');

// Every tracked document under docs/, the index itself excepted.
const tracked = execSync('git ls-files docs', { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter(f => /\.(md|TXT)$/.test(f))
    .filter(f => f !== INDEX);

// Links are written relative to docs/, so compare on that.
const linked = new Set(
    [...text.matchAll(/\]\(([^)#\s]+)/g)]
        .map(m => m[1])
        .filter(h => !/^(https?:)?\/\//.test(h))
        .map(h => h.replace(/^\.\//, ''))
);

const missing = tracked.filter(f => !linked.has(relative('docs', f)));

// A discovery that finds nothing is broken, not clean.
if (tracked.length < 15) {
    console.log(`FAIL docs-index-check: discovered only ${tracked.length} tracked document(s) under docs/ ` +
                '— the file listing is broken, not the repo');
    process.exit(1);
}
if (missing.length) {
    console.log(`FAIL docs-index-check: ${missing.length} document(s) under docs/ are not linked from ${INDEX}:`);
    for (const f of missing) console.log(`    ${f}`);
    console.log('  Add a row for each, under the section it belongs to.');
    process.exit(1);
}

// The reverse direction: a link to something that is not there.
const dangling = [...linked]
    .filter(h => !h.startsWith('../'))
    .filter(h => !tracked.includes(join('docs', h).replaceAll('\\', '/')));
if (dangling.length) {
    console.log(`FAIL docs-index-check: ${dangling.length} link(s) in ${INDEX} point at nothing tracked:`);
    for (const h of dangling) console.log(`    ${h}`);
    process.exit(1);
}

console.log(`PASS docs-index-check: all ${tracked.length} documents under docs/ are linked from ${INDEX}, ` +
            'and every link resolves');
