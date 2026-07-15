// Extract the UI lumps the DOOM-style menu needs (HUD font, skull
// cursor, logo, palette) plus each game's TITLEPIC + palette for the
// box-art game picker. Served as one JSON payload; the client decodes
// the patch format.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FONT = [];
for (let c = 33; c <= 95; c++) FONT.push(`STCFN${String(c).padStart(3, '0')}`);
const WANTED = new Set(['PLAYPAL', 'M_SKULL1', 'M_SKULL2', 'M_DOOM', ...FONT]);

let cached = null;

function lumpsOf(path, wanted) {
    const buf = readFileSync(path);
    const n = buf.readInt32LE(4), dir = buf.readInt32LE(8);
    const out = {};
    for (let i = 0; i < n; i++) {
        const o = dir + 16 * i;
        const name = buf.toString('ascii', o + 8, o + 16).replace(/\0+$/, '');
        if (!wanted.has(name) || out[name]) continue;
        const ofs = buf.readInt32LE(o), len = buf.readInt32LE(o + 4);
        out[name] = buf.subarray(ofs, ofs + len);
    }
    return out;
}

export function uiAssets(wadDir, manifest) {
    if (cached) return cached;
    // doom.wad first: its M_DOOM is the classic logo (doom2's says "II")
    const source = ['doom.wad', 'doom2.wad', 'tnt.wad', 'plutonia.wad']
        .map(f => join(wadDir, f)).find(existsSync);
    if (!source) return null;

    const lumps = {};
    for (const [name, bytes] of Object.entries(lumpsOf(source, WANTED)))
        lumps[name] = bytes.toString('base64');

    // per-game box art: TITLEPIC + that wad's own PLAYPAL (PWADs like
    // SIGIL fall back to their base IWAD's palette / picture)
    const titles = {};
    for (const w of manifest?.wads ?? []) {
        if (w.patch || w.group) continue;
        try {
            const own = lumpsOf(join(wadDir, w.file), new Set(['TITLEPIC', 'PLAYPAL']));
            const base = w.base ? lumpsOf(join(wadDir, w.base), new Set(['TITLEPIC', 'PLAYPAL'])) : {};
            const pic = own.TITLEPIC ?? base.TITLEPIC;
            const pal = own.PLAYPAL ?? base.PLAYPAL;
            if (pic && pal)
                titles[w.file] = { pic: pic.toString('base64'), pal: pal.toString('base64') };
        } catch { /* missing wad: no art, text row still works */ }
    }

    cached = JSON.stringify({ lumps, titles });
    return cached;
}
