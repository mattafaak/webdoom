// Extract the UI lumps the DOOM-style menu needs (HUD font, skull
// cursor, logo, palette), served as one JSON payload the client decodes.
// Box art is NOT in it: /api/ui-assets names the games that have art and
// /api/thumb/<file> serves each one lazily as an 80x60 index thumb with its
// palette (5,568 bytes) -- until round 10 the payload carried seven full
// base64 TITLEPICs (730 KB) to draw 80x60 thumbnails.
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

    // the games that have box art (own TITLEPIC + PLAYPAL, or the base
    // IWAD's for a PWAD like SIGIL); the art itself comes from titleThumb()
    const titles = [];
    for (const w of manifest?.wads ?? []) {
        if (w.patch || w.group) continue;
        const art = titleLumps(wadDir, w);
        if (art) titles.push(w.file);
    }

    cached = { key, body: JSON.stringify({ lumps, titles }) };
    return cached.body;
}

function titleLumps(wadDir, w) {
    try {
        const own = lumpsOf(join(wadDir, w.file), new Set(['TITLEPIC', 'PLAYPAL']));
        const base = w.base ? lumpsOf(join(wadDir, w.base), new Set(['TITLEPIC', 'PLAYPAL'])) : {};
        const pic = own.TITLEPIC ?? base.TITLEPIC;
        const pal = own.PLAYPAL ?? base.PLAYPAL;
        return pic && pal ? { pic, pal } : null;
    } catch { return null; }            // missing or corrupt wad: no art, text row still works
}

// A DOOM patch to palette indices, the same bounds as the client decoder
// (client/js/doomfont.js decodePatch): an unvalidated column offset past the
// lump must stop the column, never loop; a bogus post row is skipped.
function patchIndices(bytes) {
    if (bytes.length < 8) return null;
    const w = bytes.readUInt16LE(0), h = bytes.readUInt16LE(2);
    if (!w || !h || w > 320 || h > 200 || 8 + 4 * w > bytes.length) return null;
    const idx = Buffer.alloc(w * h);
    for (let x = 0; x < w; x++) {
        let o = bytes.readUInt32LE(8 + 4 * x);
        for (;;) {
            if (o < 0 || o >= bytes.length) break;
            const top = bytes[o];
            if (top === 0xff) break;
            if (o + 1 >= bytes.length) break;
            const len = bytes[o + 1];
            if (o + 3 + len > bytes.length) break;
            for (let i = 0; i < len; i++) {
                const y = top + i;
                if (y < h) idx[y * w + x] = bytes[o + 3 + i];
            }
            o += len + 4;
        }
    }
    return { w, h, idx };
}

export const THUMB_W = 80, THUMB_H = 60;
const thumbs = new Map();           // file -> { key, body }

// 768 bytes of PLAYPAL followed by THUMB_W x THUMB_H palette indices
// (nearest sampling), memoised per file on the wads it was built from.
// Refuses any name that is not a manifest entry: the route takes a path
// segment from the network and this is where it becomes a file.
export function titleThumb(wadDir, manifest, file) {
    const w = (manifest?.wads ?? []).find(e => e.file === file && !e.patch && !e.group);
    if (!w) return null;
    const key = cacheKey(wadDir, { wads: [w] });
    const hit = thumbs.get(file);
    if (hit && hit.key === key) return hit.body;
    const art = titleLumps(wadDir, w);
    const pic = art && patchIndices(art.pic);
    let body = null;
    if (pic && art.pal.length >= 768) {
        body = Buffer.alloc(768 + THUMB_W * THUMB_H);
        art.pal.copy(body, 0, 0, 768);
        for (let y = 0; y < THUMB_H; y++) {
            const sy = Math.floor(y * pic.h / THUMB_H);
            for (let x = 0; x < THUMB_W; x++)
                body[768 + y * THUMB_W + x] = pic.idx[sy * pic.w + Math.floor(x * pic.w / THUMB_W)];
        }
    }
    thumbs.set(file, { key, body });
    return body;
}
