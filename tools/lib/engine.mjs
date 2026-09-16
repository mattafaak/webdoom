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
    }
    return doom;
}
