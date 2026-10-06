#!/usr/bin/env node
// Savegames written by an earlier build must load in this one.
//
// p_saveg.c writes mobj_t and player_t as raw memcpy'd structs, so a field
// added to either (webdoom already added oldx/oldy/oldz/oldangle to mobj_t for
// interpolation) silently changes the on-disk format, and every save a player
// holds in IndexedDB stops loading.  No golden notices: demos never touch a
// savegame, and `persist` saves and loads within one build.
//
// For each case, against the committed fixture:
//   1. play a scripted, single-tic session and save through the real menu
//      (F2, slot 0, a name, Enter); the save must be the fixture's length.
//      Not its bytes: a vanilla save stores raw heap pointers (snext, target,
//      ...) that the loader discards, and they move with any layout change;
//   2. boot a fresh engine with the fixture as doomsav0.dsg and `-loadgame 0`,
//      run 105 tics with no input, and compare the state hash at every 35th
//      tic against the hashes the fixture's own build produced;
//   3. the same for this build's own save, which must land on the same state.
//
// Then the biggest levels in the library, at UV: the menu save must not
// outgrow its buffer.  Vanilla built the save at screens[1]+0x4000, 175,616
// bytes from the end of the screen block, and these levels need more at
// their start, so the save wrote past the block and the engine died.  The
// engine that saved must keep running, and the save must put the player back
// where he stood and replay.
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

// ~172-175 KB at their start at UV, against the 175,616 bytes vanilla's
// buffer had; the auditor measured all five past it
const BIG = [
    { name: 'blacktwr-map25', wad: 'doom2.wad', engineName: 'doom2.wad', pwad: 'blacktwr.wad', warp: ['25'] },
    { name: 'nerve-map05',    wad: 'doom2.wad', engineName: 'doom2.wad', pwad: 'nerve.wad',    warp: ['5'] },
    { name: 'sigil-e5m7',     wad: 'doom.wad',  engineName: 'doomu.wad', pwad: 'sigil.wad',    warp: ['5', '7'] },
];

const sha = b => createHash('sha256').update(b).digest('hex');

// An engine error (I_Error) ends the test unless `strict` is off, in which
// case step() throws it for the caller to judge.
class EngineError extends Error {}

async function boot(c, argv, files = new Map(), { strict = true } = {}) {
    let fatalMsg = null;
    const wads = [[c.engineName, loadWad(c.wad)], ...(c.pwad ? [[c.pwad, loadWad(c.pwad)]] : [])];
    const doom = await bootEngine(BUILD, wads, { onDoomError: m => { fatalMsg = m; } });
    doom.fileMap = files;
    doom.callMain([...(c.pwad ? ['-file', c.pwad] : []), ...argv]);
    if (fatalMsg) fatal(`${c.name}: I_Error during init: ${fatalMsg}`);
    doom._web_set_singletics(1);
    // Drawing off: D_Display and the renderer call NetUpdate, which builds a
    // ticcmd and drains input events for every wall-clock tic that passed
    // during the frame, so a slow frame would take a keypress a tic early.
    doom._web_set_nodraw(1);
    // the melt wipe is paced by wall time and holds the sim; it is cosmetic
    const step = n => {
        for (let i = 0; i < n; i++) {
            doom._web_wipe_skip();
            try { doom._web_frame(); }
            catch (e) { if (!fatalMsg) throw e; }    // I_Error unwinds through abort()
            if (fatalMsg && strict) fatal(`${c.name}: I_Error at tic ${doom._web_gametic()}: ${fatalMsg}`);
            if (fatalMsg) throw new EngineError(fatalMsg);
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
    check(`${c.name}: this build's save is the fixture's length (${fixture.length} B)`,
          saved.length === fixture.length, `got ${saved.length} B`);
    // a layout change typically traps inside G_DoLoadGame rather than
    // returning, so a throw is this check failing, not the test giving up
    for (const [what, bytes] of [['the fixture', fixture], [`this build's own save`, saved]]) {
        let got;
        try { got = (await loadAndRun(c, bytes)).join(' '); }
        catch (e) { got = `threw: ${String(e.message ?? e).split('\n')[0]}`; }
        check(`${c.name}: ${what} loads and replays to the recorded state hashes`,
              got === want.afterLoad.join(' '), `got ${got} want ${want.afterLoad.join(' ')}`);
    }
}

// Player 0's x, y, angle and health, as web_demo_state reports them.
function playerTuple(doom) {
    const p = doom._malloc(6 * 4);    // web_demo_state writes six ints
    doom._web_demo_state(p);
    const t = Array.from(doom.HEAP32.subarray(p / 4 + 1, p / 4 + 5));
    doom._free(p);
    return t.join(',');
}

async function bigLevel(c) {
    const { doom, step, tap } = await boot(c, ['-warp', ...c.warp, '-skill', '4', '-nodraw'], new Map(), { strict: false });
    step(5);
    tap(KEY_F2); tap(KEY_ENTER); tap('a'.charCodeAt(0)); tap(KEY_ENTER);
    // the save lands a few tics after the menu closes; read the player the
    // moment it does
    let stood = null;
    for (let i = 0; i < 10 && !doom.fileMap.has('doomsav0.dsg'); i++) step(1);
    const bytes = doom.fileMap.get('doomsav0.dsg');
    if (!bytes) return { error: 'no doomsav0.dsg written' };
    stood = playerTuple(doom);
    step(105);    // the engine that saved keeps running
    const { doom: d2, step: step2 } = await boot(c, ['-loadgame', '0', '-nodraw'],
        new Map([['doomsav0.dsg', new Uint8Array(bytes)]]), { strict: false });
    step2(1);
    const back = playerTuple(d2);
    step2(105);   // and the save replays
    return { bytes: bytes.length, stood, back };
}

if (!RECORD) {
    for (const c of BIG) {
        let r;
        try { r = await bigLevel(c); }
        catch (e) { r = { error: `${e instanceof EngineError ? 'I_Error' : 'trapped'}: ${String(e.message ?? e).split('\n')[0]}` }; }
        if (!check(`${c.name} (UV): the menu save is written and both engines run on`, !r.error, r.error)) continue;
        check(`${c.name} (UV): the ${r.bytes}-byte save puts the player back where he stood`,
              r.back === r.stood, `saved at ${r.stood}, loaded at ${r.back}`);
    }
}

if (RECORD) {
    writeFileSync(EXPECTED, JSON.stringify(recorded, null, 2) + '\n');
    summary(`save-compat fixtures recorded from ${recorded.source} (${CASES.length} cases)`);
} else {
    summary(`savegames from ${expected.source} load in this build (${CASES.length} cases), `
            + `and ${BIG.length} UV big-level saves round-trip`);
}
