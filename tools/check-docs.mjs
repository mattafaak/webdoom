#!/usr/bin/env node
// The two things about the documents that rot silently and matter to a reader:
//
//   1. every relative link in a tracked .md file points at a file that exists;
//   2. every leg spec.md's "What ships" table names as a feature's gate is a
//      leg in tools/run-tests.sh, so the contract cannot cite a gate that was
//      deleted or renamed;
//   3. every commit a tracked text file cites is in HEAD's history.  Work
//      landed by cherry-pick gets new hashes, and the old ones stay in the
//      local object store until gc, so a citation of a worker branch's
//      commit resolves here and nowhere else (2026-10-08: three such, after
//      four in retro.md before).  A token that names no object is not
//      judged: it may be a content hash, an upstream project's commit, or a
//      commit a shallow clone did not fetch.
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

// 3. cited commits: hex tokens in tracked text files that name a commit object
const git = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 << 20 });
const cites = new Map();        // token -> first "file:line" citing it
for (const l of git(['grep', '-nIoE', '\\b[0-9a-f]{7,40}\\b']).split('\n').filter(Boolean)) {
    const [file, line, token] = l.split(':');
    if (!cites.has(token)) cites.set(token, `${file}:${line}`);
}
const tokens = [...cites.keys()];
const kinds = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], tokens.join('\n') + '\n').split('\n');
const history = new Set(git(['rev-list', 'HEAD']).split('\n').filter(Boolean));
let commits = 0;
tokens.forEach((t, i) => {
    const [full, type] = (kinds[i] ?? '').split(' ');
    if (type !== 'commit') return;          // missing, ambiguous, or not a commit
    commits++;
    if (!history.has(full)) problems.push(`${cites.get(t)}: cites commit ${t}, which is not in HEAD's history (re-hashed by a cherry-pick or rebase?)`);
});
const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';

if (links < 50 || named < 20 || legs.size < 40 || (!shallow && commits < 20))
    problems.push(`saw only ${links} links, ${named} named gates, ${legs.size} legs and ${commits} cited commits; the parser is not reading these files`);
for (const p of problems) console.log(`FAIL  ${p}`);
if (problems.length) { console.log(`FAIL check-docs: ${problems.length} problem(s)`); process.exit(1); }
console.log(`PASS check-docs: ${links} links in ${md.length} documents resolve; ${named} gates named by spec.md are legs; ${commits} cited commits are in HEAD's history${shallow ? ' (shallow clone: only fetched commits judged)' : ''}`);
