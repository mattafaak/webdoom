#!/usr/bin/env node
// The two things about the documents that rot silently and matter to a reader:
//
//   1. every relative link in a tracked .md file points at a file that exists;
//   2. every leg spec.md's "What ships" table names as a feature's gate is a
//      leg in tools/run-tests.sh, so the contract cannot cite a gate that was
//      deleted or renamed.
//
// Nothing here reads prose, counts, or figures.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { root } from './lib/util.mjs';

const problems = [];
const md = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
let links = 0;
for (const f of md) {
    const text = readFileSync(join(root, f), 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split('#')[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;      // anchors, http:, mailto:
        links++;
        if (!existsSync(normalize(join(root, dirname(f), decodeURIComponent(target)))))
            problems.push(`${f}: link to ${m[1]} does not resolve`);
    }
}

const legs = new Set([...readFileSync(join(root, 'tools/run-tests.sh'), 'utf8')
    .matchAll(/^\s*leg\s+([a-z0-9-]+)\s/gm)].map(m => m[1]));
const spec = readFileSync(join(root, 'spec.md'), 'utf8');
const ships = spec.split(/^## /m).find(s => s.startsWith('What ships'));
if (!ships) problems.push('spec.md has no "## What ships" section');
let named = 0;
for (const row of (ships ?? '').split('\n').filter(l => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1)) {
    const gate = row.split('|')[2] ?? '';
    for (const m of gate.matchAll(/`([a-z0-9-]+)`/g)) {
        named++;
        if (!legs.has(m[1])) problems.push(`spec.md "What ships" names \`${m[1]}\`, which is not a leg`);
    }
}

if (links < 50 || named < 20 || legs.size < 40)
    problems.push(`saw only ${links} links, ${named} named gates and ${legs.size} legs; the parser is not reading these files`);
for (const p of problems) console.log(`FAIL  ${p}`);
if (problems.length) { console.log(`FAIL check-docs: ${problems.length} problem(s)`); process.exit(1); }
console.log(`PASS check-docs: ${links} links in ${md.length} documents resolve; ${named} gates named by spec.md are legs`);
