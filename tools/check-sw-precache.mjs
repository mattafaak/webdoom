#!/usr/bin/env node
// Build-time precache integrity check (ws-003 drift prevention).
// Parses sw.js's SHELL precache list and the actual app-shell import graph
// (index.html script tags + static import statements in client/js/*.js) and
// fails if any app-shell file is missing from the precache, or if any
// precached path no longer exists on disk.
//
// usage: node tools/check-sw-precache.mjs
// exit 0 = all good; exit 1 = drift detected (prints missing/stale entries)
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'client');
const buildDir = join(root, 'build');

// ── 1. Parse sw.js SHELL precache list ───────────────────────────────────────
const swSrc = readFileSync(join(clientDir, 'sw.js'), 'utf8');
const addAllMatch = swSrc.match(/c\.addAll\(\[([\s\S]*?)\]\)/);
if (!addAllMatch) {
    console.error('FAIL: could not find c.addAll([...]) in sw.js');
    process.exit(1);
}
const shellList = new Set(
    addAllMatch[1]
        .split(',')
        .map(s => s.replace(/\/\/.*$/m, '').trim().replace(/^['"]|['"]$/g, ''))
        .filter(s => s.length > 0),
);

// ── 2. Build import graph from client/js/*.js + index.html ───────────────────
// We collect all paths that should be reachable offline as part of the shell.
// Rules:
//   index.html  → <script src="js/X"> → /js/X, <link href="css/X"> → /css/X
//   client/js/*.js → static `import ... from './X'` → /js/X
//   audio.js    → ctx.audioWorklet.addModule('js/music-worklet.js') → /js/music-worklet.js
//   main.js     → dynamic import('/engine/doom.js') → /engine/doom.js
//   implicit    → /engine/doom.wasm (loaded by doom.js at runtime)
//   implicit    → / (index.html via '/' route)

function extractJsImports(src, prefix) {
    const imports = new Set();
    // static: import ... from './foo.js'  or import './foo.js'
    for (const m of src.matchAll(/import\s+(?:.*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
        const rel = m[1].replace(/^\.\//, '');
        imports.add(`${prefix}${rel}`);
    }
    // audioWorklet.addModule('js/music-worklet.js')
    for (const m of src.matchAll(/addModule\(['"]([^'"]+)['"]\)/g)) {
        imports.add('/' + m[1]);
    }
    // dynamic import('/engine/doom.js')
    for (const m of src.matchAll(/import\(['"]([^'"]+)['"]\)/g)) {
        const p = m[1].startsWith('/') ? m[1] : '/' + m[1];
        imports.add(p);
    }
    return imports;
}

const appShell = new Set(['/']);

// index.html
const htmlSrc = readFileSync(join(clientDir, 'index.html'), 'utf8');
for (const m of htmlSrc.matchAll(/<script[^>]+src=["']([^"']+)["']/g))
    appShell.add(m[1].startsWith('/') ? m[1] : '/' + m[1]);
for (const m of htmlSrc.matchAll(/<link[^>]+href=["']([^"']+)["']/g))
    if (m[1].match(/\.css$/)) appShell.add(m[1].startsWith('/') ? m[1] : '/' + m[1]);

// Walk JS files in client/js/
const jsDir = join(clientDir, 'js');
const jsFiles = readdirSync(jsDir).filter(f => f.endsWith('.js'));
for (const f of jsFiles) {
    const src = readFileSync(join(jsDir, f), 'utf8');
    for (const p of extractJsImports(src, '/js/'))
        appShell.add(p);
}

// Always require doom.wasm (implicitly loaded by doom.js at runtime)
appShell.add('/engine/doom.wasm');

// ── 3. Path → disk file mapping ───────────────────────────────────────────────
function diskPath(urlPath) {
    if (urlPath === '/') return join(clientDir, 'index.html');
    if (urlPath.startsWith('/engine/')) return join(buildDir, urlPath.slice('/engine/'.length));
    return join(clientDir, urlPath.slice(1));
}

// ── 4. Check A: precached files that no longer exist on disk ─────────────────
const stale = [];
for (const p of shellList) {
    const disk = diskPath(p);
    if (!existsSync(disk)) stale.push({ url: p, disk });
}

// ── 5. Check B: app-shell files not in the precache ──────────────────────────
const missing = [];
for (const p of appShell) {
    if (!shellList.has(p)) missing.push(p);
}

// ── 6. Report ─────────────────────────────────────────────────────────────────
let fail = false;
if (stale.length) {
    console.error('FAIL: precached paths that no longer exist on disk:');
    for (const { url, disk } of stale) console.error(`  ${url}  (checked: ${disk})`);
    fail = true;
}
if (missing.length) {
    console.error('FAIL: app-shell files missing from sw.js precache:');
    for (const p of missing) console.error(`  ${p}`);
    fail = true;
}
if (fail) process.exit(1);
console.log(`ok  sw.js precache integrity: ${shellList.size} entries, import graph ${appShell.size} paths — no drift`);
