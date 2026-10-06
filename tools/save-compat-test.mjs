#!/usr/bin/env node
// Savegames written by an earlier build must load in this one.
//
// p_saveg.c writes mobj_t and player_t as raw memcpy'd structs, so a field
// added to either (webdoom already added oldx/oldy/oldz/oldangle to mobj_t for
// interpolation) silently changes the on-disk format, and every save a player
// holds in IndexedDB stops loading.  No golden notices: demos never touch a
// savegame, and `persist` saves and loads within one build.
//
// For each case this does two things against the committed fixture:
//   1. play a scripted, single-tic session and save through the real menu
//      (F2, slot 0, a name, Enter) -- the bytes must equal the fixture, so the
//      format and the simulation that produced it are both unchanged;
//   2. boot a fresh engine with the fixture as doomsav0.dsg and `-loadgame 0`,
//      run 105 tics with no input, and compare the state hash at every 35th
//      tic against the hashes the fixture's own build produced.
//
// usage: node tools/save-compat-test.mjs [--build-dir DIR]
//        node tools/save-compat-test.mjs --record   (writes the fixtures; only
//          from the build whose saves are being frozen, never to make a red go away)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, buildDirArg } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const RECORD = process.argv.includes('--record');
const BUILD = buildDirArg();
const EXPECTED = join(root, 'tools/golden/save-compat.json');

const KEY_F2 = 0x80 + 0x3c, KEY_ENTER = 13, KEY_UP = 0xad, KEY_RIGHT = 0xae, KEY_RCTRL = 0x80 + 0x1d;
const CASES = [
    { name: 'doom-e1m1',   wad: 'doom.wad',  engineName: 'doomu.wad', warp: ['1', '1'] },
    { name: 'doom2-map01', wad: 'doom2.wad', engineName: 'doom2.wad', warp: ['1'] },
];

const sha = b => createHash('sha256').update(b).digest('hex');

async function boot(c, argv, files = new Map()) {
    let fatalMsg = null;
    const doom = await bootEngine(BUILD, [[c.engineName, loadWad(c.wad)]],
                                  { onDoomError: m => { fatalMsg = m; } });
    doom.fileMap = files;
    doom.callMain(argv);
    if (fatalMsg) fatal(`${c.name}: I_Error during init: ${fatalMsg}`);
    doom._web_set_singletics(1);
    // the melt wipe is paced by wall time and holds the sim; it is cosmetic
    const step = n => {
        for (let i = 0; i < n; i++) {
            doom._web_wipe_skip();
            doom._web_frame();
            if (fatalMsg) fatal(`${c.name}: I_Error at tic ${doom._web_gametic()}: ${fatalMsg}`);
        }
    };
    const tap = (key, held = 1) => {
        doom._web_input_event(0, key, 0, 0); step(held);
        doom._web_input_event(1, key, 0, 0); step(1);
    };
    return { doom, step, tap };
}

// A short session that moves the world: walk, turn, fire, walk on.
async function playAndSave(c) {
    const { doom, step, tap } = await boot(c, ['-warp', ...c.warp, '-skill', '3', '-nodraw']);
    step(10);
    tap(KEY_UP, 40);
    tap(KEY_RIGHT, 12);
    for (let i = 0; i < 3; i++) { tap(KEY_RCTRL, 2); step(10); }
    tap(KEY_UP, 25);
    // the save menu, slot 0, name "a"
    tap(KEY_F2); tap(KEY_ENTER); tap('a'.charCodeAt(0)); tap(KEY_ENTER);
    step(3);    // sendsave → ga_savegame → G_DoSaveGame on the next tics
    const bytes = doom.fileMap.get('doomsav0.dsg');
    return bytes ? Buffer.from(bytes) : null;
}

async function loadAndRun(c, fixture) {
    const files = new Map([['doomsav0.dsg', new Uint8Array(fixture)]]);
    const { doom, step } = await boot(c, ['-loadgame', '0', '-nodraw'], files);
    // The load runs inside the first tic.  web_state_hash walks the thinker
    // list, which does not exist before a level is set up, so never hash first.
    const hashes = [];
    for (let k = 0; k < 4; k++) {
        step(k ? 35 : 1);
        hashes.push(`${doom._web_gametic()}:${(doom._web_state_hash() >>> 0).toString(16)}`);
    }
    return hashes;
}

const expected = existsSync(EXPECTED) ? JSON.parse(readFileSync(EXPECTED, 'utf8')) : null;
if (!RECORD && !expected) fatal('no tools/golden/save-compat.json; record it from the build whose saves are being frozen');
const recorded = { source: RECORD ? process.env.SAVE_COMPAT_SOURCE ?? null : undefined, cases: {} };
if (RECORD && !recorded.source)
    fatal('--record needs SAVE_COMPAT_SOURCE=<commit the fixtures come from>, so the provenance is in the file');

for (const c of CASES) {
    const fixturePath = join(root, `tools/golden/save-${c.name}.dsg`);
    const saved = await playAndSave(c);
    if (!saved) { check(`${c.name}: the menu save produced doomsav0.dsg`, false, 'no file written'); continue; }

    if (RECORD) {
        writeFileSync(fixturePath, saved);
        recorded.cases[c.name] = { bytes: saved.length, sha256: sha(saved), afterLoad: await loadAndRun(c, saved) };
        console.log(`  recorded ${c.name}: ${saved.length} bytes, ${recorded.cases[c.name].afterLoad.join(' ')}`);
        continue;
    }

    const want = expected.cases[c.name];
    if (!check(`${c.name}: fixture present`, existsSync(fixturePath) && want, fixturePath)) continue;
    const fixture = readFileSync(fixturePath);
    check(`${c.name}: fixture matches its recorded sha256`, sha(fixture) === want.sha256);
    check(`${c.name}: this build's save is byte-identical to the fixture (${fixture.length} B)`,
          saved.equals(fixture), `got ${saved.length} B, sha ${sha(saved).slice(0, 12)}`);
    // a layout change typically traps inside G_DoLoadGame rather than
    // returning, so a throw is this check failing, not the test giving up
    let got;
    try { got = (await loadAndRun(c, fixture)).join(' '); }
    catch (e) { got = `threw: ${String(e.message ?? e).split('\n')[0]}`; }
    check(`${c.name}: the fixture loads and replays to the recorded state hashes`,
          got === want.afterLoad.join(' '), `got ${got} want ${want.afterLoad.join(' ')}`);
}

if (RECORD) {
    writeFileSync(EXPECTED, JSON.stringify(recorded, null, 2) + '\n');
    summary(`save-compat fixtures recorded from ${recorded.source} (${CASES.length} cases)`);
} else {
    summary(`savegames from ${expected.source} load in this build (${CASES.length} cases)`);
}
