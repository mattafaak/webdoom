#!/usr/bin/env node
// Identify WAD files and emit the server manifest.
// usage: node tools/wad-identify.mjs <wad-dir> <out.json>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: wad-identify.mjs <dir> <out.json>'); process.exit(1); }

// Known titles by canonical filename; base = IWAD a PWAD loads on top of.
const KNOWN = {
    'doom.wad':     { title: 'The Ultimate Doom' },
    'doomu.wad':    { title: 'The Ultimate Doom', rename: 'doom.wad' },
    'doom2.wad':    { title: 'Doom II: Hell on Earth' },
    'tnt.wad':      { title: 'Final Doom: TNT — Evilution' },
    'plutonia.wad': { title: 'Final Doom: The Plutonia Experiment' },
    'nerve.wad':    { title: 'No Rest for the Living', base: 'doom2.wad' },
    'chex.wad':     { title: 'Chex Quest', standalone: true },
    // HACX v2.0-r61 is the GZDoom-era remaster (ACS scripts, no vanilla
    // data) — not runnable on a vanilla engine. v1.2 (doom2 PWAD) would be.
    'hacx.wad':     { skip: true },
    'sigil.wad':        { title: 'SIGIL', base: 'doom.wad' },
    'sigil_v1_21.wad':  { title: 'SIGIL', base: 'doom.wad', rename: 'sigil.wad' },
    'tnt31.wad':    { title: 'TNT: Evilution — MAP31 fix', base: 'tnt.wad', patch: true },
};
const MASTER_TITLES = { // Master Levels PWADs, all on doom2
    'attack.wad': 'Attack', 'blacktwr.wad': 'Black Tower', 'bloodsea.wad': 'Bloodsea Keep',
    'canyon.wad': 'Canyon', 'catwalk.wad': 'The Catwalk', 'combine.wad': 'The Combine',
    'fistula.wad': 'The Fistula', 'garrison.wad': 'The Garrison', 'geryon.wad': 'Geryon',
    'manor.wad': 'Titan Manor', 'mephisto.wad': 'Mephisto’s Maosoleum',
    'minos.wad': 'Minos’ Judgement', 'nessus.wad': 'Nessus', 'paradox.wad': 'Paradox',
    'subspace.wad': 'Subspace', 'subterra.wad': 'Subterra', 'teeth.wad': 'The Express Elevator to Hell',
    'ttrap.wad': 'Trapped on Titan', 'vesperas.wad': 'Vesperas', 'virgil.wad': 'Virgil’s Lead',
};

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
