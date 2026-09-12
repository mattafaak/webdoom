// DOOM UI assets, straight from the server's IWAD (/api/ui-assets):
// the STCFN HUD font (red), the menu skull cursor, the M_DOOM logo,
// PLAYPAL. Decodes the patch format to canvases and renders text with
// optional player-color translation (same index-range remap the engine
// uses for player sprites).

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// palette index ranges, as in r_draw.c translation tables
const COLOR_BASE = { Green: 0x70, Indigo: 0x60, Brown: 0x40, Red: 0xb0 };
const FONT_RANGE = [0xb0, 0xbf];        // STCFN glyphs live in the red run

export async function loadDoomFont() {
    // The server answers 404 with PLAIN TEXT when it has no IWAD in wads/lib --
    // an ordinary, documented state, not a failure.  Without a res.ok check,
    // .json() threw a SyntaxError, which lobby.js's one catch reported as
    // "cannot reach server": the server was up and answering, and the operator
    // was sent to look at the network.
    const res = await fetch('/api/ui-assets');
    if (!res.ok)
        throw new Error(res.status === 404
            ? 'the server has no IWAD in wads/lib — run tools/fetch-wads.sh there'
            : `the server declined /api/ui-assets (HTTP ${res.status})`);
    let payload;
    try { payload = await res.json(); }
    catch { throw new Error('/api/ui-assets did not answer with JSON'); }
    const { lumps, titles = {} } = payload ?? {};
    if (!lumps || typeof lumps !== 'object' || !lumps.PLAYPAL)
        throw new Error('/api/ui-assets carried no palette — the IWAD it read is not usable');
    const playpal = b64(lumps.PLAYPAL);

    function decodePatch(bytes, remapBase = null, pal = playpal) {
        const v = new DataView(bytes.buffer, bytes.byteOffset);
        const w = v.getUint16(0, true), h = v.getUint16(2, true);
        if (!w || !h || w > 320 || h > 200) return null;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        // patch vertical/horizontal offsets — punctuation glyphs use these
        // to sit at the right height (comma low, apostrophe high, etc.)
        canvas.topoff = v.getInt16(6, true);
        canvas.leftoff = v.getInt16(4, true);
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(w, h);
        // Bounds are load-bearing here, not defensive dressing.  `o` is an
        // unvalidated u32 straight out of the lump, and past the end of the
        // array `bytes[o]` is undefined -- so `top === 0xff` is never true,
        // `len` is undefined, `o += len + 4` makes o NaN, and `for (;;)` NEVER
        // TERMINATES.  Reproduced 2026-09-11 with a 64-byte patch whose
        // columnofs point past the end: 5,000,000 iterations and still going.
        // This runs on the main thread while the launcher builds the menu
        // font, so the symptom is a frozen tab before anything renders, with
        // no error and no way back.
        let truncated = false;
        for (let x = 0; x < w; x++) {
            let o = v.getUint32(8 + 4 * x, true);
            for (;;) {
                // The terminator is ONE byte.  This demanded two before
                // reading it, so a column whose 0xff is the last byte of the
                // lump was called truncated -- and it is the last byte in 24
                // of doom.wad's 63 STCFN glyphs, measured.  No pixels were
                // lost (the flag fires after the column's posts are drawn),
                // but the flag was wrong on every boot and nothing read it,
                // so nobody found out for the life of the project.  Making it
                // loud (round 6) surfaced it on the first run.
                if (o < 0 || o >= bytes.length) { truncated = true; break; }
                const top = bytes[o];
                if (top === 0xff) break;
                // A post needs its length byte; only now is o+1 required.
                if (o + 1 >= bytes.length) { truncated = true; break; }
                const len = bytes[o + 1];
                if (o + 3 + len > bytes.length) { truncated = true; break; }
                for (let i = 0; i < len; i++) {
                    let idx = bytes[o + 3 + i];
                    if (remapBase !== null && idx >= FONT_RANGE[0] && idx <= FONT_RANGE[1])
                        idx = remapBase + (idx - FONT_RANGE[0]);
                    const p = ((top + i) * w + x) * 4;
                    if (p < 0 || p + 3 >= img.data.length) continue;   // bogus top
                    const q = idx * 3;
                    if (q + 2 >= pal.length) continue;                 // bogus palette index
                    img.data[p]     = pal[q];
                    img.data[p + 1] = pal[q + 1];
                    img.data[p + 2] = pal[q + 2];
                    img.data[p + 3] = 255;
                }
                o += len + 4;
            }
        }
        // Degrade loudly, per the insecure-origin contract: a half-drawn glyph
        // is better than a frozen tab, but it should not be silent.  It WAS
        // silent: this set canvas.truncated and nothing anywhere read it.
        if (truncated) console.warn('webdoom: a UI patch is truncated — the IWAD lump ended mid-column; drawing what there is');
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    // glyph cache: color → char code → canvas
    const glyphs = new Map();
    const glyph = (c, color) => {
        const key = color ?? 'Red';
        if (!glyphs.has(key)) glyphs.set(key, new Map());
        const cache = glyphs.get(key);
        if (!cache.has(c)) {
            const lump = lumps[`STCFN${String(c).padStart(3, '0')}`];
            cache.set(c, lump ? decodePatch(b64(lump),
                color && color !== 'Red' ? COLOR_BASE[color] : null) : null);
        }
        return cache.get(c);
    };

    // charset is ASCII 33–95, uppercase only
    const normalize = s => s.toUpperCase()
        .replace(/[—–]/g, '-').replace(/[’']/g, "'").replace(/[^\x20-\x5f]/g, '');

    function text(str, { scale = 2, color = null } = {}) {
        const chars = [...normalize(str)];
        const SPACE = 4, LH = 9;
        let w = 0;
        const parts = chars.map(ch => {
            const c = ch.charCodeAt(0);
            const g = c === 32 ? null : glyph(c, color);
            const adv = g ? g.width : SPACE;
            const part = { g, x: w };
            w += adv;
            return part;
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w * scale);
        canvas.height = LH * scale;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        // draw each glyph at its patch offset (V_DrawPatch: top = -topoffset)
        // so punctuation lands at the correct height within the line
        for (const p of parts)
            if (p.g) ctx.drawImage(p.g, p.x * scale, -p.g.topoff * scale,
                p.g.width * scale, p.g.height * scale);
        return canvas;
    }

    function patch(name, scale = 2) {
        // A lump the IWAD does not carry: b64(undefined) is a TypeError out of
        // menu.js's constructor, which is not a place with a recovery path.
        if (typeof lumps[name] !== 'string') return null;
        const c = decodePatch(b64(lumps[name]));
        if (!c) return null;
        const out = document.createElement('canvas');
        out.width = c.width * scale;
        out.height = c.height * scale;
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(c, 0, 0, out.width, out.height);
        return out;
    }

    // box art: each game's TITLEPIC, decoded with its own palette
    const thumbCache = new Map();
    function titleThumb(file, height = 60) {
        if (thumbCache.has(file)) return thumbCache.get(file);
        let out = null;
        const t = titles[file];
        if (t) {
            const c = decodePatch(b64(t.pic), null, b64(t.pal));
            if (c) {
                out = document.createElement('canvas');
                out.height = height;
                out.width = Math.round(height * 4 / 3);   // aspect-corrected 4:3
                const ctx = out.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(c, 0, 0, out.width, out.height);
            }
        }
        thumbCache.set(file, out);
        return out;
    }

    return { text, patch, titleThumb };
}
