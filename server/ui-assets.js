// Extract the UI lumps the DOOM-style menu needs (HUD font, skull
// cursor, logo, palette) from the first available IWAD and serve them
// as one small JSON payload. The client decodes the patch format.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FONT = [];
for (let c = 33; c <= 95; c++) FONT.push(`STCFN${String(c).padStart(3, '0')}`);
const WANTED = new Set(['PLAYPAL', 'M_SKULL1', 'M_SKULL2', 'M_DOOM', ...FONT]);

let cached = null;

export function uiAssets(wadDir) {
    if (cached) return cached;
    const source = ['doom2.wad', 'doom.wad', 'tnt.wad', 'plutonia.wad']
        .map(f => join(wadDir, f)).find(existsSync);
    if (!source) return null;

    const buf = readFileSync(source);
    const n = buf.readInt32LE(4), dir = buf.readInt32LE(8);
    const lumps = {};
    for (let i = 0; i < n; i++) {
        const o = dir + 16 * i;
        const name = buf.toString('ascii', o + 8, o + 16).replace(/\0+$/, '');
        if (!WANTED.has(name) || lumps[name]) continue;
        const ofs = buf.readInt32LE(o), len = buf.readInt32LE(o + 4);
        lumps[name] = buf.subarray(ofs, ofs + len).toString('base64');
    }
    cached = JSON.stringify({ lumps });
    return cached;
}
