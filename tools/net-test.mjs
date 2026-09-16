#!/usr/bin/env node
// Headless N-player netplay test: spawns the real server, boots N wasm
// clients through the real lobby + relay, plays E1M1 co-op with live
// input, and proves lockstep determinism by comparing gamestate hashes
// at identical gametics. Then kills one client and asserts the rest
// keep running. usage: node tools/net-test.mjs [players=2]
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, sleep, buildDirArg } from './lib/util.mjs';

process.on('uncaughtException', e => {
    console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300));
    process.exit(1);
});

const buildDir = buildDirArg();
const positionalArgs = process.argv.slice(2).filter((a, i, arr) =>
    a !== '--build-dir' && (i === 0 || arr[i - 1] !== '--build-dir'));
const N = Math.min(4, Math.max(1, +(positionalArgs[0] ?? 2)));

const { connectLobby, attachRelay, launchArgs } = await import(join(root, 'client/js/net.js'));
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
    return { name, doom, isFatal: () => fatal, hashes: new Map(), dead: false };
}

const clients = [];
for (let i = 0; i < N; i++) clients.push(await makeClient(`P${i}`));

// --- lobby dance -----------------------------------------------------------
const launches = clients.map(c => new Promise(resolve => {
    c.lobby = connectLobby(base);
    c.lobby.on('launch', m => resolve(m));
}));
await sleep(300);
clients[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
await sleep(200);
clients[0].lobby.start();
const launchMsgs = await Promise.all(launches);
console.log(`launched ${launchMsgs[0].slots.length}p (slots ${launchMsgs[0].slots}): ${JSON.stringify(launchMsgs[0].params)}`);
if (launchMsgs[0].slots.length !== N) fail(`expected ${N} players`);

// --- boot engines into the session -------------------------------------------
clients.forEach((c, i) => {
    c.relay = attachRelay(c.doom, base, {
        slot: c.lobby.slot, numplayers: launchMsgs[i].numplayers,
        slots: launchMsgs[i].slots, names: launchMsgs[i].names, jitterMs: 2,
    });
    c.doom.callMain(launchArgs(launchMsgs[i].params, false));
    c.relay.go();
});

// --- play: distinct input per client ------------------------------------------
const KEYS = [0xad, 0xae, 0xac, 0xaf];      // fwd, right, left, back
clients.forEach((c, i) => c.doom._web_input_event(0, KEYS[i % 4], 0, 0));

const t0 = performance.now();
let dropTic = 0;
let tDrop = 0;   // wall-clock ms when victim dropped
let tFirstAdvance = 0;  // wall-clock ms when survivor first advanced past dropTic
const victim = clients[N - 1];

for (;;) {
    await sleep(14);
    for (const c of clients) {
        if (c.dead) continue;
        c.doom._web_frame();
        if (c.isFatal()) fail(`${c.name}: ${c.isFatal()}`);
        c.hashes.set(c.doom._web_gametic(), c.doom._web_state_hash());
    }
    const elapsed = performance.now() - t0;
    if (N > 1 && elapsed > 10000 && !dropTic) {
        tDrop = performance.now();
        victim.relay.quit(); victim.lobby.close(); victim.dead = true;
        dropTic = clients[0].doom._web_gametic();
        console.log(`${victim.name} dropped at gametic ${dropTic}`);
    }
    if (dropTic && !tFirstAdvance && clients[0].doom._web_gametic() > dropTic) {
        tFirstAdvance = performance.now();
    }
    if (elapsed > 17000) break;
}

// --- verdicts -------------------------------------------------------------------
let compared = 0, bad = 0;
for (const c of clients.slice(1)) {
    const common = [...clients[0].hashes.keys()].filter(t => c.hashes.has(t) && t > 2);
    compared += common.length;
    bad += common.filter(t => clients[0].hashes.get(t) !== c.hashes.get(t)).length;
}
const final = clients[0].doom._web_gametic();
console.log(`tics compared: ${compared}, mismatches: ${bad}`);
if (dropTic) {
    console.log(`survivors advanced ${final - dropTic} tics after drop (final ${final})`);
    const stallMs = tFirstAdvance ? (tFirstAdvance - tDrop).toFixed(1) : 'n/a';
    console.log(`stall_ms: ${stallMs} (graceful-close drop; grace boundary = GRACE_MS 250 ms)`);
}

if (N > 1 && compared < 200 * (N - 1)) fail(`too few comparable tics (${compared})`);
if (bad) fail(`DESYNC on ${bad} tics`);
if (dropTic && final - dropTic < 35 * 3) fail('survivors stalled after drop');
console.log(`PASS — ${N}-player lockstep deterministic${dropTic ? ', drop handled' : ''}`);
for (const c of clients) if (!c.dead) { c.relay.quit(); c.lobby.close(); }
srv.stop();
process.exit(0);