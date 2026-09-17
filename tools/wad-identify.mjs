#!/usr/bin/env node
// Identify WAD files and emit the server manifest.
// usage: node tools/wad-identify.mjs <wad-dir> <out.json>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: wad-identify.mjs <dir> <out.json>'); process.exit(1); }

// The known-WAD tables come from client/js/wad-import.js, which is the source.
//
// They were transcribed here, under a comment in each file saying they mirrored
// each other, and nothing compared them.  They drifted: this copy read
// "Mephisto’s Maosoleum" against the client's "Mephisto's Mausoleum" -- a
// misspelling and a curly apostrophe -- so the same WAD got a different title
// depending on whether it came from the served library or a local import.
// `minos.wad` and `virgil.wad` differed by apostrophe, and `hacx.wad`'s
// skipReason existed only client-side, which check-menu-reachable reads.
//
// wad-import.js is browser code but its top level touches no DOM, so node can
// import it; verified by this file doing so.
import { KNOWN, MASTER_TITLES } from '../client/js/wad-import.js';


function lumps(buf) {
    const n = buf.readInt32LE(4), dirOfs = buf.readInt32LE(8), names = [];
    for (let i = 0; i < n; i++) {
        const o = dirOfs + 16 * i;
        if (o + 16 > buf.length) break;
        names.push(buf.toString('ascii', o + 8, o + 16).replace(/\0+$/, ''));
    }
    return names;
}

const wads = [];
for (const f of readdirSync(dir).filter(f => f.toLowerCase().endsWith('.wad')).sort()) {
    const path = join(dir, f);
    const buf = readFileSync(path);
    const magic = buf.toString('ascii', 0, 4);
    if (magic !== 'IWAD' && magic !== 'PWAD') { console.error(`skip ${f}: not a WAD`); continue; }
    const name = basename(f).toLowerCase();
    const known = KNOWN[name];
    if (known?.skip) { console.error(`skip ${f}: not vanilla-engine compatible`); continue; }
    const canonical = known?.rename ?? name;
    const lumpNames = lumps(buf);
    const maps = lumpNames.filter(l => /^(E\d+M\d+|MAP\d\d)$/.test(l));
    // Self-contained TCs (Chex, HACX) ship with PWAD magic but load standalone.
    const kind = (magic === 'IWAD' || known?.standalone) ? 'IWAD' : 'PWAD';
    const entry = {
        file: canonical,
        title: known?.title ?? MASTER_TITLES[name] ?? name.replace(/\.wad$/, ''),
        kind,
        base: known?.base ?? (kind === 'PWAD' ? (MASTER_TITLES[name] ? 'doom2.wad' : maps[0]?.startsWith('MAP') ? 'doom2.wad' : 'doom.wad') : null),
        patch: known?.patch || undefined,
        group: MASTER_TITLES[name] ? 'Master Levels' : null,
        sha256: createHash('sha256').update(buf).digest('hex'),
        size: statSync(path).size,
        maps: maps.length ? maps : undefined,
    };
    if (kind === 'IWAD') delete entry.base;
    if (!entry.group) delete entry.group;
    wads.push(entry);
    console.log(`${magic}  ${canonical.padEnd(14)} ${String(entry.size).padStart(9)}  ${maps.length} maps  ${entry.title}`);
}

writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), wads }, null, 2));
console.log(`wrote ${out}: ${wads.length} wads`);
