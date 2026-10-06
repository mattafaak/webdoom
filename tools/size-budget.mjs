#!/usr/bin/env node
// The shipped artifact against its ceilings (tools/size-budget.json): doom.wasm,
// synth.wasm, __heap_base, and the gzip cost of a cold page load.
//
// __heap_base is the one a byte count of doom.wasm cannot see: BSS takes no
// space in the file, but it sits below the heap, and the heap is where the WADs
// go inside a fixed 32 MB.
//
// usage: node tools/size-budget.mjs   (prints every figure; fails past a ceiling)
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const budget = JSON.parse(readFileSync(join(root, 'tools/size-budget.json'), 'utf8'));
// gzip -9 from the real path: gzip stores the file name in its header, so the
// same bytes compressed under another name are a different size.  A failure is
// null, never a number.
const gzipSize = path => { try { return execFileSync('gzip', ['-9kc', path], { maxBuffer: 1 << 28 }).length; } catch { return null; } };
const fail = msg => { console.log(`FAIL size-budget: ${msg}`); process.exit(1); };

function leb(buf, off) {
    let v = 0, shift = 0, b;
    do { b = buf[off++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return { v: v >>> 0, off };
}
// __heap_base: emscripten's first global, an immutable i32.const
function heapBase(wasm) {
    let off = 8;
    while (off < wasm.length) {
        const id = wasm[off++];
        const size = leb(wasm, off);
        if (id === 6) {
            let p = size.off;
            const count = leb(wasm, p); p = count.off;
            if (count.v > 0 && wasm[p + 2] === 0x41) return leb(wasm, p + 3).v;
            return null;
        }
        off = size.off + size.v;
    }
    return null;
}

for (const f of ['build/doom.wasm', 'build/synth.wasm'])
    if (!existsSync(join(root, f))) fail(`${f} absent (source tools/emsdk-env.sh && make -C engine)`);
const doomWasm = readFileSync(join(root, 'build/doom.wasm'));
const hb = heapBase(doomWasm);
if (hb === null) fail('could not read __heap_base from the GLOBAL section of build/doom.wasm');

// the cold page load is exactly what the service worker precaches
const sw = readFileSync(join(root, 'client/sw.js'), 'utf8');
const shell = [...(sw.match(/const SHELL_FILES = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(x => x[1]);
if (shell.length < 15) fail(`found ${shell.length} SHELL_FILES entries in client/sw.js; the app shell is larger than that`);
let payload = 0, surface = 0;
for (const url of shell) {
    const p = url === '/' ? join(root, 'client/index.html')
            : url.startsWith('/engine/') ? join(root, 'build', url.slice(8))
            : join(root, 'client', url.slice(1));
    if (!existsSync(p) || !statSync(p).isFile()) fail(`shell entry ${url} does not resolve to a file`);
    const gz = gzipSize(p);
    if (gz === null) fail(`gzip failed on ${p}`);
    payload += gz;
    if (!url.startsWith('/engine/')) surface += gz;
}

const measured = {
    doom_wasm_bytes: doomWasm.length,
    synth_wasm_bytes: statSync(join(root, 'build/synth.wasm')).size,
    heap_base_bytes: hb,
    payload_gzip_bytes: payload,
    surface_gzip_bytes: surface,
};
let over = 0;
for (const [k, v] of Object.entries(measured)) {
    const max = budget[k]?.max;
    if (!max) fail(`no ceiling for ${k} in tools/size-budget.json`);
    const ok = v <= max;
    if (!ok) over++;
    console.log(`  ${ok ? 'ok  ' : 'OVER'}  ${k.padEnd(20)} ${v.toLocaleString('en-US').padStart(10)}  ceiling ${max.toLocaleString('en-US')}`);
}
if (over) fail(`${over} of ${Object.keys(measured).length} figures over their ceiling`);
console.log(`PASS size-budget: ${Object.keys(measured).length} figures under their ceilings ` +
            `(doom.wasm ${(doomWasm.length / 1024).toFixed(1)} KiB, ${shell.length} shell files)`);
