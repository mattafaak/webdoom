#!/usr/bin/env node
// tools/check-menu-reachable.mjs — the launcher may not offer a game that can
// never load.
//
// `hacx.wad` sat in lobby.js's GAME_ORDER, absent from the 28-entry server
// manifest -- the only one of the eight that was -- and explicitly refused by
// wad-import.js:
//
//     'hacx.wad': { skip: true, skipReason: 'HACX v2 is not vanilla-engine
//                    compatible (use HACX v1.2 as a doom2.wad PWAD instead)' }
//
// So it could not be served and it could not be imported. It was a menu row
// with no reachable destination, and README.md advertised HACX as part of the
// shipped library on the strength of it. docs/promises-index.md flags rme-008
// as a COVERAGE gap -- "no automated smoke test" -- which is true and beside
// the point: the promise was not untested, it was false.
//
// Two questions, asked separately because only one of them can be answered on a
// clone (wads/ is gitignored, so a fresh checkout has no manifest):
//
//   1. Is any GAME_ORDER entry explicitly refused by the importer?  Always
//      checkable, and this is the one that catches hacx.
//   2. Is every GAME_ORDER entry either in the server manifest or importable?
//      Needs the manifest; reported as (INCOMPLETE) when it is absent, never
//      silently skipped.
//
// usage: node tools/check-menu-reachable.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const read = f => readFileSync(join(root, f), 'utf8');

// GAME_ORDER is a flat array literal of quoted filenames.
const lobby = read('client/js/lobby.js');
const go = /const GAME_ORDER = \[([\s\S]*?)\];/.exec(lobby);
if (!go) {
    console.log('FAIL check-menu-reachable: no GAME_ORDER array found in client/js/lobby.js');
    process.exit(1);
}
const order = [...go[1].matchAll(/'([^']+\.wad)'/g)].map(m => m[1]);

// The importer's refusal list: entries carrying `skip: true`.
const importer = read('client/js/wad-import.js');
const refused = new Map();
for (const m of importer.matchAll(/'([^']+\.wad)':\s*\{([^}]*skip:\s*true[^}]*)\}/g)) {
    const why = /skipReason:\s*'([^']*)'/.exec(m[2]);
    refused.set(m[1], why ? why[1] : '(no reason given)');
}
// Everything the importer knows how to accept.
const importable = new Set(
    [...importer.matchAll(/'([^']+\.wad)':\s*\{/g)].map(m => m[1]).filter(f => !refused.has(f))
);

// A discovery that finds nothing is broken, not clean.
if (order.length < 4 || importable.size < 4) {
    console.log(`FAIL check-menu-reachable: discovered ${order.length} menu entries and ` +
                `${importable.size} importable WADs — the literals moved and this check is grading nothing`);
    process.exit(1);
}

let bad = 0;

// 1. refused by the importer
for (const f of order) {
    if (refused.has(f)) {
        console.log(`FAIL ${f} is offered in GAME_ORDER but the importer refuses it: ${refused.get(f)}`);
        bad++;
    }
}

// 2. present in the manifest, or importable
const manifestPath = join(root, 'wads/manifest.json');
let manifestNote = '';
let incomplete = false;
if (existsSync(manifestPath)) {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const wads = raw.wads ?? raw;
    const served = new Set((Array.isArray(wads) ? wads.map(w => w.file) : Object.keys(wads)));
    for (const f of order) {
        if (refused.has(f)) continue;          // already reported
        if (served.has(f) || importable.has(f)) continue;
        console.log(`FAIL ${f} is offered in GAME_ORDER but is neither in wads/manifest.json ` +
                    `(${served.size} entries) nor importable`);
        bad++;
    }
    manifestNote = `, all reachable via the ${served.size}-entry manifest or the importer`;
} else {
    // The marker goes at the FRONT of the verdict, not the end.
    // run-tests.sh's summary table truncates a headline to the column width, so
    // a qualifier at the end is invisible exactly where a reader looks: CI's
    // table showed this leg as a plain "PASS — check-menu-reachable: 7
    // GAME_ORDER entries..." while the full line said the served-WAD half had
    // not been checked at all. Same family as "a failing check must not wear a
    // passing headline", one step milder.
    incomplete = true;
    manifestNote = ' — no wads/manifest.json on this host, so the served-WAD half was NOT checked';
}

if (bad) {
    console.log(`\ncheck-menu-reachable: ${bad} unreachable menu entr(ies) — a row the player can ` +
                'select and never load is worse than one that is absent');
    process.exit(1);
}
console.log(`PASS${incomplete ? ' (INCOMPLETE)' : ''} — check-menu-reachable: ${order.length} ` +
            `GAME_ORDER entries, ${refused.size} importer refusal(s), none of them offered${manifestNote}`);
