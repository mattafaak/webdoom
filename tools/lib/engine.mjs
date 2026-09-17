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
        // dangling pointer.  opl-mode-test.mjs did exactly that for three
        // instances (round 13); it happened to be the last use of each module
        // every time, so nothing read freed memory, which is the kind of luck
        // that stops holding the moment someone adds a line.
    }
    return doom;
}
