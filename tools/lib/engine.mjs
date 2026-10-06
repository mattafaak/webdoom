// Boot the wasm engine in node with a WAD stack registered, the way every
// headless harness did by hand.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './util.mjs';

export const loadWad = name => readFileSync(join(root, 'wads/lib', name));

// wads: [[engineName, bytes], ...] -- the IWAD first, under the 1993 name the
// engine identifies it by (doom.wad registers as doomu.wad).
export async function bootEngine(buildDir, wads, { print = () => {}, printErr = () => {}, onDoomError = null } = {}) {
    const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;
    const doom = await createDoom({ print, printErr, ...(onDoomError ? { onDoomError } : {}) });
    for (const [name, bytes] of wads) {
        const p = doom._malloc(bytes.length);
        if (!p) throw new Error(`out of memory registering ${name}`);
        doom.HEAPU8.set(bytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'], [name, p, bytes.length]);
        // The pointer is deliberately not returned, and must not be freed.
        // web_register_file RETAINS it -- engine/web/files.c does
        // `webfiles[n].data = data`, it does not copy -- so the registry points
        // at this block for the module's whole life and every W_WebFile() hit
        // reads through it.  A harness that frees it has handed the engine a
        // dangling pointer, even when it happens to be the last use of the
        // module: the luck stops holding the moment someone adds a line.
    }
    return doom;
}

// The static data region of a build, [0, staticEnd): DATA and BSS, which sit
// below the 1 MB shadow stack (engine/Makefile -sSTACK_SIZE).  Read from
// __heap_base, emscripten's first global, in the wasm file.
export function staticEnd(buildDir) {
    const wasm = readFileSync(join(root, buildDir, 'doom.wasm'));
    const leb = off => { let v = 0, s = 0, b; do { b = wasm[off++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return { v: v >>> 0, off }; };
    for (let off = 8; off < wasm.length;) {
        const id = wasm[off++], size = leb(off);
        if (id === 6) {
            const count = leb(size.off);
            if (count.v > 0 && wasm[count.off + 2] === 0x41) return leb(count.off + 3).v - (1 << 20);
            break;
        }
        off = size.off + size.v;
    }
    throw new Error(`no __heap_base in ${buildDir}/doom.wasm`);
}
