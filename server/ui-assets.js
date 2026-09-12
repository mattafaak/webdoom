// Extract the UI lumps the DOOM-style menu needs (HUD font, skull
// cursor, logo, palette) plus each game's TITLEPIC + palette for the
// box-art game picker. Served as one JSON payload; the client decodes
// the patch format.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FONT = [];
for (let c = 33; c <= 95; c++) FONT.push(`STCFN${String(c).padStart(3, '0')}`);
const WANTED = new Set(['PLAYPAL', 'M_SKULL1', 'M_SKULL2', 'M_DOOM', ...FONT]);

// Cached forever, keyed on nothing.  An operator who drops a WAD into wads/lib
// -- the documented way to add a game -- got the launcher's old box art until
// the server was restarted, with no hint that a restart was what was missing.
// serve.js:44-51 already keys wads/manifest.json on its mtime; this does the
// same for every file this payload is actually built from.  Both the IWAD
// candidates and the manifest's own entries are stamped, so a WAD REPLACED in
// place (same name, new bytes) invalidates too -- a directory mtime alone would
// not see that.
let cached = null;          // { key, body }

const SOURCES = ['doom.wad', 'doom2.wad', 'tnt.wad', 'plutonia.wad'];

function cacheKey(wadDir, manifest) {
    const parts = [];
    const stamp = p => {
        try { const st = statSync(p); parts.push(`${p}:${st.mtimeMs}:${st.size}`); }
        catch { parts.push(`${p}:-`); }     // absent is a state too, and it changes
    };
    stamp(wadDir);
    for (const f of SOURCES) stamp(join(wadDir, f));
    for (const w of manifest?.wads ?? []) {
        if (w.patch || w.group) continue;
        stamp(join(wadDir, w.file));
        if (w.base) stamp(join(wadDir, w.base));
    }
    return parts.join('|');
}

// The WAD header and directory were read with no validation at all.  This is
// the OPERATOR's own wads/lib, not network input -- so the realistic cause is a
// truncated download or a wrong file, not an attacker -- but the consequences
// were out of proportion to that (task 23.3), and both were reproduced:
//
//   * a file shorter than the 12-byte header threw RangeError out of
//     lumpsOf(), through uiAssets(), and out of the /api/ui-assets request
//     handler -- which is an uncaught exception in a Node request listener, so
//     the SERVER PROCESS EXITS.  One corrupt WAD takes the game down for
//     everyone on the LAN.
//   * numlumps = 0x7FFFFFFF sent the loop spinning; still running when killed
//     at 20 s.  The event loop is blocked throughout, so the server answers
//     nobody.
//
// A corrupt WAD should cost its own box art, not the server.
function lumpsOf(path, wanted) {
    const buf = readFileSync(path);
    if (buf.length < 12) throw new Error(`WAD too short (${buf.length} bytes)`);
    const n = buf.readInt32LE(4), dir = buf.readInt32LE(8);
    // A WAD directory entry is 16 bytes and must lie inside the file; that
    // bounds n far more tightly than any invented cap would.
    if (n < 0 || dir < 12 || dir + 16 * n > buf.length || 16 * n < 0)
        throw new Error(`WAD directory out of range (numlumps ${n}, dirofs ${dir}, file ${buf.length})`);
    const out = {};
    for (let i = 0; i < n; i++) {
        const o = dir + 16 * i;
        const name = buf.toString('ascii', o + 8, o + 16).replace(/\0+$/, '');
        if (!wanted.has(name) || out[name]) continue;
        const ofs = buf.readInt32LE(o), len = buf.readInt32LE(o + 4);
        if (ofs < 0 || len < 0 || ofs + len > buf.length) continue;   // skip the bad lump, keep the rest
        out[name] = buf.subarray(ofs, ofs + len);
    }
    return out;
}

export function uiAssets(wadDir, manifest) {
    const key = cacheKey(wadDir, manifest);
    if (cached && cached.key === key) return cached.body;
    // doom.wad first: its M_DOOM is the classic logo (doom2's says "II")
    const source = SOURCES.map(f => join(wadDir, f)).find(existsSync);
    if (!source) return null;

    // The per-PWAD loop below has always been wrapped; the IWAD call was the
    // one that was not, and it is the one whose failure kills the process.
    const lumps = {};
    try {
        for (const [name, bytes] of Object.entries(lumpsOf(source, WANTED)))
            lumps[name] = bytes.toString('base64');
    } catch (e) {
        console.error(`ui-assets: cannot read ${source}: ${e.message}`);
        console.error('ui-assets: serving no UI assets; the text menu still works.');
        return null;            // -> 404, which serve.js already handles
    }

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

    cached = { key, body: JSON.stringify({ lumps, titles }) };
    return cached.body;
}
