#!/usr/bin/env node
// Headless drop-in determinism test: 2 players start a game, play a few
// seconds, then a 3rd client JOINS IN PROGRESS — catching up by replaying
// the sealed cmd history — and is promoted live mid-game. Proves the joiner
// re-simulates the identical world (state hashes match the veterans at every
// common tic, including after it spawns). Runs co-op by default; `dm` for
// deathmatch. usage: node tools/join-test.mjs [dm]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.on('uncaughtException', e => {
    console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300));
    process.exit(1);
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'dm' ? 'deathmatch' : 'coop';
const PORT = 8669;
const base = `ws://127.0.0.1:${PORT}`;

const { connectLobby, attachRelay, launchArgs } = await import(join(root, 'client/js/net.js'));
const createDoom = (await import(join(root, 'build/doom.js'))).default;
const wadBytes = readFileSync(join(root, 'wads/lib/doom.wad'));

const server = spawn('node', [join(root, 'server/serve.js')], {
    env: { ...process.env, DOOM_PORT: PORT, DOOM_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(800);

const fail = msg => { console.error(`FAIL: ${msg}`); server.kill(); process.exit(1); };

async function makeClient(name) {
    let fatal = null;
    const doom = await createDoom({
        print: () => {},
        printErr: t => { if (/consistency|I_Error/i.test(t)) { fatal = t; console.error(`  [${name}] ${t}`); } },
        onDoomError: msg => { fatal = msg; },
    });
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'], ['doomu.wad', p, wadBytes.length]);
    return { name, doom, isFatal: () => fatal, hashes: new Map(), active: false, slot: -1 };
}

// --- 2 veterans start the game ------------------------------------------------
const vets = [await makeClient('P0'), await makeClient('P1')];
const launches = vets.map(c => new Promise(res => { c.lobby = connectLobby(base); c.lobby.on('launch', res); }));
await sleep(300);
vets[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode });
await sleep(200);
vets[0].lobby.start();
const lm = await Promise.all(launches);
console.log(`launched 2p ${mode} (slots ${lm[0].slots}): ${JSON.stringify(lm[0].params)}`);
vets.forEach((c, i) => {
    c.slot = c.lobby.slot;
    c.relay = attachRelay(c.doom, base, {
        slot: c.slot, numplayers: lm[i].numplayers, slots: lm[i].slots, names: lm[i].names, jitterMs: 2,
    });
    c.doom.callMain(launchArgs(lm[i].params, false));
    c.relay.go();
    c.active = true;
});
const KEYS = [0xad, 0xae, 0xac];    // fwd, right, left
vets.forEach((c, i) => c.doom._web_input_event(0, KEYS[i], 0, 0));

// --- a 3rd client drops in mid-game -------------------------------------------
async function joinInProgress() {
    const c = await makeClient('J');
    const m = await new Promise(res => { c.lobby = connectLobby(base); c.lobby.on('launch', res); });
    if (!m.join) fail('joiner did not receive a join launch');
    c.slot = c.lobby.slot;
    c.relay = attachRelay(c.doom, base, {
        slot: c.slot, numplayers: m.numplayers, slots: m.slots, names: m.names, jitterMs: 2,
        join: true, frontier: m.frontier,
    });
    c.doom.callMain(launchArgs(m.params, false));
    c.doom._web_input_event(0, KEYS[2], 0, 0);
    await c.relay.catchUp(m.frontier, () => {});
    const anchor = c.doom._web_first_ingame();
    if (anchor >= 0 && anchor !== c.slot) c.doom._web_set_console(anchor);
    c.frontier = m.frontier;
    return c;
}

const clients = [...vets];
let joiner = null, joinKicked = false;
const t0 = performance.now();

for (;;) {
    await sleep(14);
    for (const c of clients) {
        if (!c.active) continue;
        c.doom._web_frame();
        if (c.isFatal()) fail(`${c.name}: ${c.isFatal()}`);
        c.hashes.set(c.doom._web_gametic(), c.doom._web_state_hash());
    }
    const elapsed = performance.now() - t0;
    if (elapsed > 4000 && !joinKicked) {
        joinKicked = true;
        joinInProgress().then(c => {
            joiner = c; c.active = true; clients.push(c);
            console.log(`joiner (slot ${c.slot}) caught up to gametic ${c.doom._web_gametic()} (frontier was ${c.frontier})`);
        }).catch(e => fail(`join failed: ${e?.message ?? e}`));
    }
    if (elapsed > 15000) break;
}

// --- verdicts -----------------------------------------------------------------
if (!joiner) fail('joiner never caught up / went live');
const mask = joiner.doom._web_ingame_mask();
if (!(mask & (1 << joiner.slot))) fail(`joiner (slot ${joiner.slot}) never spawned (ingame mask ${mask})`);

let compared = 0, bad = 0;
for (const c of clients.slice(1)) {
    const common = [...vets[0].hashes.keys()].filter(t => c.hashes.has(t) && t > 2);
    compared += common.length;
    bad += common.filter(t => vets[0].hashes.get(t) !== c.hashes.get(t)).length;
}
const jCommon = [...vets[0].hashes.keys()].filter(t => joiner.hashes.has(t) && t > 2);
const jAfter = jCommon.filter(t => t >= joiner.frontier).length;
console.log(`tics compared: ${compared}, mismatches: ${bad}; joiner shares ${jCommon.length} tics (${jAfter} at/after frontier), final ingame mask ${mask}`);

if (bad) fail(`DESYNC on ${bad} tics`);
if (jCommon.length < 200) fail(`joiner too few shared tics (${jCommon.length}) — did it catch up?`);
if (jAfter < 35) fail(`joiner did not play live long enough after joining (${jAfter} tics)`);
console.log(`PASS — drop-in ${mode}: slot ${joiner.slot} caught up, spawned, and stayed in lockstep (0 desync)`);
for (const c of clients) { c.relay?.quit(); c.lobby?.close(); }
server.kill();
process.exit(0);
