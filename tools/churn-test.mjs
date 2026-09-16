#!/usr/bin/env node
// Frequent drop-in/drop-out stress: two veterans play continuously while a
// third slot churns — a client joins (catch-up), plays, drops, and another
// joins the freed slot, repeatedly. Asserts every joiner re-simulates the
// identical world (its hashes match the veterans during its live window) and
// nothing crashes/deadlocks across the churn. usage: node tools/churn-test.mjs [cycles=3]
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, sleep, buildDirArg } from './lib/util.mjs';

process.on('uncaughtException', e => { console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300)); process.exit(1); });

const CYCLES = Math.max(1, +(process.argv[2] ?? 3));

const { connectLobby, attachRelay, launchArgs } = await import(join(root, 'client/js/net.js'));
const buildDir = buildDirArg();
const wadBytes = loadWad('doom.wad');

const srv = await startServer({ onStdout: d => process.stdout.write(`  [srv] ${d}`) });
const base = srv.ws;
const fail = msg => { console.error(`FAIL: ${msg}`); srv.stop(); process.exit(1); };

async function makeClient(name) {
    let fatal = null;
    const doom = await bootEngine(buildDir, [['doomu.wad', wadBytes]], {
        printErr: t => { if (/consistency|I_Error/i.test(t)) { fatal = t; console.error(`  [${name}] ${t}`); } },
        onDoomError: msg => { fatal = msg; },
    });
    return { name, doom, isFatal: () => fatal, hashes: new Map(), active: false };
}

// --- two veterans start and keep playing --------------------------------------
const vets = [await makeClient('P0'), await makeClient('P1')];
const launches = vets.map(c => new Promise(res => { c.lobby = connectLobby(base); c.lobby.on('launch', res); }));
await sleep(300);
vets[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
await sleep(200);
vets[0].lobby.start();
const lm = await Promise.all(launches);
vets.forEach((c, i) => {
    c.relay = attachRelay(c.doom, base, { slot: c.lobby.slot, numplayers: lm[i].numplayers, slots: lm[i].slots, names: lm[i].names, jitterMs: 2 });
    c.doom.callMain(launchArgs(lm[i].params, false));
    c.relay.go();
    c.active = true;
    c.doom._web_input_event(0, i ? 0xae : 0xad, 0, 0);   // fwd / right
});
console.log(`2 veterans playing ${lm[0].params.mode}; churning a 3rd slot ${CYCLES}x`);

// Boot + catch up a drop-in client (blocking bits happen in this promise; the
// single main loop keeps driving everyone during its awaits).
async function joinCatchup(tag) {
    const c = await makeClient(tag);
    const m = await new Promise(res => {
        c.lobby = connectLobby(base);
        c.lobby.on('inprogress', () => c.lobby.send({ t: 'join' }));
        c.lobby.on('launch', res);
    });
    if (!m.join) fail(`${tag}: no join launch`);
    c.slot = c.lobby.slot;
    c.relay = attachRelay(c.doom, base, { slot: c.slot, numplayers: m.numplayers, slots: m.slots, names: m.names, jitterMs: 2, join: true, frontier: m.frontier });
    c.doom.callMain(launchArgs(m.params, false));
    c.doom._web_input_event(0, 0xac, 0, 0);
    await c.relay.catchUp(m.frontier, () => {});
    const anchor = c.doom._web_first_ingame();
    if (anchor >= 0 && anchor !== c.slot) c.doom._web_set_console(anchor);
    return c;
}

// One drive-loop over the active set (same frame boundaries → dense shared
// gametics). A scheduler joins/drops the 3rd slot between phases.
const clients = [...vets];
const results = [];
let cycle = 0, joiner = null, booting = false, phaseAt = Date.now() + 3500;   // warmup first
for (;;) {
    await sleep(14);
    for (const c of clients) {
        if (!c.active) continue;
        c.doom._web_frame();
        if (c.isFatal()) fail(`${c.name}: ${c.isFatal()}`);
        c.hashes.set(c.doom._web_gametic(), c.doom._web_state_hash());
    }
    if (Date.now() < phaseAt || booting) continue;
    if (!joiner && cycle < CYCLES) {                 // time to join
        booting = true;
        joinCatchup(`J${cycle}`).then(c => {
            c.startTic = c.doom._web_gametic();
            c.active = true; clients.push(c); joiner = c; booting = false;
            phaseAt = Date.now() + 3500;             // play in lockstep, then drop
        });
    } else if (joiner) {                             // time to drop
        const c = joiner;
        const common = [...vets[0].hashes.keys()].filter(t => c.hashes.has(t) && t > c.startTic);
        const bad = common.filter(t => vets[0].hashes.get(t) !== c.hashes.get(t)).length;
        results.push({ tag: c.name, slot: c.slot, spawned: !!(c.doom._web_ingame_mask() & (1 << c.slot)), common: common.length, bad });
        c.active = false; c.relay.quit(); c.lobby.close(); clients.splice(clients.indexOf(c), 1);
        joiner = null; cycle++; phaseAt = Date.now() + 600;   // gap, then reuse the slot
    } else break;                                    // all cycles done
}

let totalCommon = 0;
for (const r of results) {
    console.log(`  cycle: ${r.tag} slot ${r.slot} spawned=${r.spawned} shared=${r.common} desync=${r.bad}`);
    if (!r.spawned) fail(`${r.tag} never spawned`);
    if (r.bad) fail(`${r.tag} DESYNC on ${r.bad} tics`);
    if (r.common < 20) fail(`${r.tag} too few shared tics (${r.common})`);
    totalCommon += r.common;
}

const vetAdvance = vets[0].doom._web_gametic();
if (vetAdvance < 35 * 8) fail(`veterans stalled during churn (only ${vetAdvance} tics)`);
for (const c of vets) if (c.isFatal()) fail(`${c.name}: ${c.isFatal()}`);
console.log(`PASS — ${CYCLES} join/drop cycles, ${totalCommon} joiner tics in lockstep (0 desync), veterans ran ${vetAdvance} tics`);
for (const c of vets) { c.relay.quit(); c.lobby.close(); }
srv.stop();
process.exit(0);
