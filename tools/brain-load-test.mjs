#!/usr/bin/env node
// The boss shooter's targets after a load (engine/core/p_enemy.c,
// P_BrainTargets, run by G_DoLoadGame).
//
// The Icon of Sin's shooter spits at the target spots A_BrainAwake lists when
// it wakes.  The list is not in a savegame, and vanilla kept it across a load:
// a game loaded in a fresh session spat at no target (A_BrainSpit's modulo by
// 0; an I_Error here), and one loaded in the same session at the previous
// level's freed mobjs.  G_DoLoadGame now rebuilds it from the loaded thinkers,
// so where a save is loaded must not matter.  One save, loaded both ways:
//
//   A  the same session: doom2 MAP30 at ultra-violence, played by play-set's
//      scripted input (tools/floor/play-set.mjs, scriptedDemo) through the
//      shipped replay path (web_play_demo_buf).  The shooter wakes; at tic
//      SAVE_AT the script's own ticcmd asks for a save (BT_SPECIAL |
//      BTS_SAVEGAME, slot 0, as a netgame saves; it replaces that tic's
//      buttons), and at tic LOAD_AT the save is loaded from the menu (F3,
//      Enter), the tics play-set saves and loads at;
//   B  a fresh session: the engine at its title screen, no level ever loaded,
//      loads the same file from the menu the same way.
//
// From the load on, the two are given the same keys at the same tics: IDDQD,
// typed as the loaded game starts, and nothing else.  (Without it the player,
// standing still among what the shooter sends, dies, and a dead player's save
// request reads as BT_USE: P_DeathThink respawns him and the save is lost.)
// A and B must show the same state on every one of the AFTER tics after the
// load (web_demo_state: P_Random's index, player 0, every sector's heights,
// the thinker count; gametic is left out, as it differs), in which the shooter
// spits more often than it has targets, so its cycle comes back to the first.
// A spit is a tic in which DSBOSPIT starts: A_BrainSpit plays it at full
// volume, and the cube it spawns plays it again when the player is near.
// Then each saves from the menu, and the two saves must load, each in a fresh
// engine, to the same states, as save-compat compares saves: their length, and
// the state hashes the loaded game replays to.
//
// Red-proof (2026-10-08): with the P_BrainTargets call taken out of
// G_DoLoadGame, B ends at its first spit after the load with "A_BrainSpit:
// numbraintargets was 0 (vanilla crashes here)", and this test fails.
//
// usage: node tools/brain-load-test.mjs [--build-dir DIR]
// Copyright (C) 2026, GPL-2.0-or-later.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, buildDirArg } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';
import { scriptedDemo, SAVE_AT, LOAD_AT } from './floor/play-set.mjs';

const BUILD = buildDirArg();
// tics compared after the load: at one spit per 150 tics (S_BRAINEYE1) the
// shooter spits at least 16 times, past its 13 targets
const AFTER = 2400;
const TARGETS = 13;     // doom2 MAP30's MT_BOSSTARGET things at UV (its THINGS lump)
const KEY_F2 = 0x80 + 0x3c, KEY_F3 = 0x80 + 0x3d, KEY_ENTER = 13;
const BT_SPECIAL = 0x80, BTS_SAVEGAME = 2;   // d_event.h; slot 0 in bits 2-4
const CHEAT = 'iddqd';

if (!existsSync(join(root, BUILD, 'doom.js'))) fatal(`${BUILD}/doom.js absent (make -C engine)`);
if (!existsSync(join(root, 'wads/lib/doom2.wad'))) fatal('wads/lib/doom2.wad absent (tools/fetch-wads.sh)');
const WAD = loadWad('doom2.wad');

function lump(name) {
    const n = WAD.readUInt32LE(4), dir = WAD.readUInt32LE(8);
    for (let i = 0; i < n; i++) {
        const e = dir + 16 * i;
        if (WAD.toString('latin1', e + 8, e + 16).replace(/\0.*$/, '') === name)
            return WAD.subarray(WAD.readUInt32LE(e), WAD.readUInt32LE(e) + WAD.readUInt32LE(e + 4));
    }
    return fatal(`doom2.wad has no ${name}`);
}
const SOUNDS = { wake: lump('DSBOSSIT'), spit: lump('DSBOSPIT') };

class EngineError extends Error {}

// One engine on doom2.wad: drawing off, one tic per frame, the melt wipe
// skipped (it is paced by wall time).  Records the gametic of every start of
// the shooter's sounds, found by the bytes I_StartSound hands to JS.
async function boot(label, argv, files = new Map()) {
    let err = null;
    const doom = await bootEngine(BUILD, [['doom2.wad', WAD]], { onDoomError: m => { err = m; } });
    doom.fileMap = files;
    const heard = { wake: [], spit: [] };
    doom.sfxStart = (handle, id, data, len) => {
        for (const [k, b] of Object.entries(SOUNDS))
            if (len === b.length && Buffer.compare(doom.HEAPU8.subarray(data, data + len), b) === 0)
                heard[k].push(doom._web_gametic());
    };
    doom.callMain([...argv, '-nodraw']);
    if (err) fatal(`${label}: I_Error during init: ${err}`);
    doom._web_set_singletics(1);
    doom._web_set_nodraw(1);
    const frame = () => {
        doom._web_wipe_skip();
        try { doom._web_frame(); }
        catch (e) { err ??= `trapped: ${String(e.message ?? e).split('\n')[0]}`; }
        if (err) throw new EngineError(`${label}: ${err} (gametic ${doom._web_gametic()})`);
    };
    const key = code => {
        doom._web_input_event(0, code, 0, 0); frame();
        doom._web_input_event(1, code, 0, 0); frame();
    };
    // a tic's state without gametic: web_demo_state's six ints
    const buf = doom._malloc(6 * 4);
    const state = () => { doom._web_demo_state(buf); return Array.from(doom.HEAP32.subarray(buf / 4, buf / 4 + 6)).join(' '); };
    return { doom, frame, key, state, heard, label };
}

const spitTics = (e, from = 0) => new Set(e.heard.spit.filter(t => t >= from)).size;

// The menu load of slot 0 (F3, Enter on the first slot), IDDQD, and AFTER
// tics: the state after the load's own tic and after each of the others.
function loadAndPlay(e) {
    e.key(KEY_F3);
    if (!check(`${e.label}: F3 opens the load menu`, e.doom._web_menu_active() === 1)) return null;
    e.doom._web_input_event(0, KEY_ENTER, 0, 0);
    e.frame();              // the load, and the loaded level's first tic
    if (!check(`${e.label}: Enter on slot 0 loads the game (the menu closed, a level, no demo)`,
               e.doom._web_ui_mode() === 0 && e.doom._web_demo_playing() === 0)) return null;
    const t0 = e.doom._web_gametic();
    const states = [e.state()];
    for (let i = 0; i < AFTER; i++) {
        // Enter's release, then the cheat, one key a tic: down, up
        if (i === 0) e.doom._web_input_event(1, KEY_ENTER, 0, 0);
        else if (i <= 2 * CHEAT.length) e.doom._web_input_event((i - 1) & 1, CHEAT.charCodeAt((i - 1) >> 1), 0, 0);
        e.frame();
        states.push(e.state());
    }
    return { states, tics: e.doom._web_gametic() - t0, spits: spitTics(e, t0), health: +states.at(-1).split(' ')[4] };
}

// The menu save into an empty slot 0 (F2, Enter, a name, Enter), as
// save-compat saves; the save lands a few tics after the menu closes.
function saveFromMenu(e) {
    e.doom.fileMap.delete('doomsav0.dsg');
    e.key(KEY_F2); e.key(KEY_ENTER); e.key('a'.charCodeAt(0)); e.key(KEY_ENTER);
    for (let i = 0; i < 10 && !e.doom.fileMap.has('doomsav0.dsg'); i++) e.frame();
    const b = e.doom.fileMap.get('doomsav0.dsg');
    return b ? Buffer.from(b) : null;
}

// A save loaded at boot in a fresh engine (-loadgame), and the state hash at
// every 35th tic for 105 tics: save-compat's loadAndRun.
async function replayed(bytes, label) {
    const e = await boot(label, ['-loadgame', '0'], new Map([['doomsav0.dsg', new Uint8Array(bytes)]]));
    const hashes = [];
    for (let k = 0; k < 4; k++) {
        for (let i = 0; i < (k ? 35 : 1); i++) e.frame();
        hashes.push(`${e.doom._web_gametic()}:${(e.doom._web_state_hash() >>> 0).toString(16)}`);
    }
    return hashes.join(' ');
}

// ── A: the same session ──────────────────────────────────────────────────────
const demo = scriptedDemo('doom2.wad:MAP30', 1, 30);
if (demo.length < 13 + 4 * (LOAD_AT + 1)) fatal(`play-set's script is shorter than LOAD_AT (${LOAD_AT} tics)`);
demo[13 + 4 * SAVE_AT + 3] = BT_SPECIAL | BTS_SAVEGAME;
let save = null, a = null, b = null, A = null, B = null;
try {
    a = await boot('A (same session)', []);
    const p = a.doom._malloc(demo.length);
    a.doom.HEAPU8.set(demo, p);
    const rc = a.doom._web_play_demo_buf(p, demo.length);
    a.doom._free(p);
    if (!check("A: the replay path accepts play-set's doom2 MAP30 script", rc === 0, `web_play_demo_buf returned ${rc}`))
        throw new EngineError('no replay');
    const start = a.doom._web_gametic();
    let savedAt = -1, woke = 0, spat = 0;
    while (a.doom._web_gametic() - start < LOAD_AT && a.doom._web_demo_playing()) {
        a.frame();
        if (savedAt < 0 && a.doom.fileMap.has('doomsav0.dsg')) {
            savedAt = a.doom._web_gametic() - start;
            save = Buffer.from(a.doom.fileMap.get('doomsav0.dsg'));
            woke = a.heard.wake.length;
            spat = spitTics(a);
        }
    }
    check(`A: the script plays to tic ${LOAD_AT}`, a.doom._web_gametic() - start === LOAD_AT,
          `stopped at ${a.doom._web_gametic() - start}`);
    check(`A: the save request in the script's tic ${SAVE_AT} writes doomsav0.dsg (${save?.length ?? 0} B, after tic ${savedAt})`,
          save && savedAt >= SAVE_AT && savedAt <= SAVE_AT + 2, save ? '' : 'no save written');
    // what makes the load a test: the shooter's list was built before the save
    check(`A: the shooter woke and spat before the save (woke ${woke} time(s), ${spat} spits)`, woke >= 1 && spat >= 1);
    A = loadAndPlay(a);
} catch (e) {
    if (!(e instanceof EngineError)) throw e;
    check('A: the same-session load plays on without an engine error', false, e.message);
}

// ── B: a fresh session ───────────────────────────────────────────────────────
if (save) {
    try {
        b = await boot('B (fresh session)', [], new Map([['doomsav0.dsg', new Uint8Array(save)]]));
        for (let i = 0; i < 5; i++) b.frame();
        check('B: at the title screen, no level loaded, no demo', b.doom._web_ui_mode() === 1 && b.doom._web_demo_playing() === 0);
        B = loadAndPlay(b);
    } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        check('B: the fresh-session load plays on without an engine error', false, e.message);
    }
}

// ── the comparisons ──────────────────────────────────────────────────────────
let same = 0, ends = 'not compared';
if (A && B) {
    check(`A and B each ran ${AFTER} tics after the load`, A.tics === AFTER && B.tics === AFTER, `A ${A.tics}, B ${B.tics}`);
    let d = -1;
    for (let i = 0; i < Math.max(A.states.length, B.states.length) && d < 0; i++)
        if (A.states[i] !== B.states[i]) d = i;
    same = d < 0 ? A.states.length : d;
    check(`A and B: the same state on every tic from the load on (${A.states.length} states)`, d < 0,
          `first difference ${d} tics after the load: A [${A.states[d]}], B [${B.states[d]}]`);
    check(`the shooter spat more often than it has targets after the load (A ${A.spits}, B ${B.spits}; ${TARGETS} targets)`,
          A.spits > TARGETS && B.spits === A.spits);
    check(`the player is alive at the end, to save (health A ${A.health}, B ${B.health})`, A.health > 0 && B.health > 0);
    try {
        const endA = saveFromMenu(a), endB = saveFromMenu(b);
        if (check('each session saves from the menu at the end', endA && endB, `A ${endA?.length ?? 'none'}, B ${endB?.length ?? 'none'}`)) {
            check(`the two end saves are the same length (${endA.length} B)`, endA.length === endB.length,
                  `A ${endA.length} B, B ${endB.length} B`);
            const ra = await replayed(endA, "A's end save"), rb = await replayed(endB, "B's end save");
            if (check(`the two end saves load in fresh engines and replay to the same state hashes (${ra})`, ra === rb,
                      `A ${ra}; B ${rb}`) && endA.length === endB.length) ends = 'load alike';
            else ends = 'differ';
        }
    } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        check('the end saves are written and load without an engine error', false, e.message);
    }
}

summary(`one doom2 MAP30 save loaded in the session that wrote it and in a fresh one: ${same} of ${AFTER + 1} states `
        + `identical from the load on, ${A?.spits ?? '-'} and ${B?.spits ?? '-'} spits at ${TARGETS} targets; the end saves ${ends}`,
        { min: 15 });
