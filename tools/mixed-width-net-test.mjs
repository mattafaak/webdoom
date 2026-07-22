#!/usr/bin/env node
// mixed-width-net-test.mjs — per-tic equality in a mixed-width netgame.
//
// PURPOSE
//   Proves that wide mode (854 px) is purely a render concern and does NOT
//   perturb the simulation.  Two clients join the same 2p coop session:
//     P0 — default 320-px width
//     P1 — 854-px wide (web_set_wide(854) called before frame loop)
//   Both-fail and disagree are distinguished:
//     - If both clients crash/stall:  "BOTH-FAIL" (test infra problem)
//     - If P0.hash(t) ≠ P1.hash(t):  "DESYNC"    (wide perturbs sim)
//     - If all hashes equal:          "PASS"
//
// usage: node tools/mixed-width-net-test.mjs
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.on('uncaughtException', e => {
    console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300));
    process.exit(1);
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8672; // dedicated port for this test (avoids stale-server confusion)

const { connectLobby, attachRelay, launchArgs } = await import(join(root, 'client/js/net.js'));
const createDoom = (await import(join(root, 'build', 'doom.js'))).default;
const wadBytes = readFileSync(join(root, 'wads/lib/doom.wad'));

const server = spawn('node', [join(root, 'server/serve.js')], {
    env: { ...process.env, DOOM_PORT: PORT, DOOM_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(800);

const fail = (code, msg) => {
    console.error(`${code}: ${msg}`);
    server.kill();
    process.exit(1);
};

async function makeClient(name, wideWidth) {
    let fatal = null;
    const doom = await createDoom({
        print: () => {},
        printErr: t => { if (/consistency|I_Error/i.test(t)) { fatal = t; console.error(`  [${name}] ${t}`); } },
        onDoomError: msg => { fatal = msg; },
    });
    {
        const p = doom._malloc(wadBytes.length);
        doom.HEAPU8.set(wadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'], ['doomu.wad', p, wadBytes.length]);
    }
    // Tag wide mode: called before frame loop, applied on first web_frame().
    if (wideWidth) doom._web_set_wide(wideWidth);
    return { name, doom, wideWidth, isFatal: () => fatal, hashes: new Map() };
}

const WIDE = 854;
const clients = [
    await makeClient('P0-narrow', 0),     // 320-px standard
    await makeClient('P1-wide',  WIDE),   // 854-px wide
];
console.log(`mixed-width netgame: P0=320px, P1=${WIDE}px`);

// --- lobby dance ---
const launches = clients.map(c => new Promise(resolve => {
    c.lobby = connectLobby(`ws://127.0.0.1:${PORT}`);
    c.lobby.on('launch', m => resolve(m));
}));
await sleep(300);
clients[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
await sleep(200);
clients[0].lobby.start();
const launchMsgs = await Promise.all(launches);
console.log(`launched ${launchMsgs[0].slots.length}p (slots ${launchMsgs[0].slots})`);
if (launchMsgs[0].slots.length !== 2)
    fail('BOTH-FAIL', `expected 2 players, got ${launchMsgs[0].slots.length}`);

// --- boot engines ---
clients.forEach((c, i) => {
    c.relay = attachRelay(c.doom, `ws://127.0.0.1:${PORT}`, {
        slot: c.lobby.slot, numplayers: launchMsgs[i].numplayers,
        slots: launchMsgs[i].slots, names: launchMsgs[i].names, jitterMs: 2,
    });
    c.doom.callMain(launchArgs(launchMsgs[i].params, false));
    c.relay.go();
});

// P0 moves forward; P1 moves right — different inputs, same sim state?
// Inputs perturb the player but the server enforces consistent tic delivery.
clients[0].doom._web_input_event(0, 0xad, 0, 0); // fwd
clients[1].doom._web_input_event(0, 0xae, 0, 0); // right

const t0 = performance.now();
for (;;) {
    await sleep(14);
    let eitherDead = true;
    for (const c of clients) {
        if (c.isFatal()) continue;
        c.doom._web_frame();
        c.hashes.set(c.doom._web_gametic(), c.doom._web_state_hash());
        eitherDead = false;
    }
    if (eitherDead) fail('BOTH-FAIL', 'all clients crashed before test completed');
    if (performance.now() - t0 > 12000) break;
}

// --- verdicts ---
const [c0, c1] = clients;
if (c0.isFatal() && c1.isFatal())
    fail('BOTH-FAIL', 'both clients crashed (test infra issue, not wide bug)');
if (c0.isFatal())
    fail('BOTH-FAIL', `P0 (narrow) crashed: ${c0.isFatal()}`);
if (c1.isFatal())
    fail('BOTH-FAIL', `P1 (wide) crashed: ${c1.isFatal()}`);

const common = [...c0.hashes.keys()].filter(t => c1.hashes.has(t) && t > 2);
let mismatches = 0;
let firstMismatch = -1;
for (const t of common) {
    if (c0.hashes.get(t) !== c1.hashes.get(t)) {
        if (firstMismatch < 0) firstMismatch = t;
        mismatches++;
    }
}

console.log(`tics compared: ${common.length}, mismatches: ${mismatches}`);
if (common.length < 200)
    fail('BOTH-FAIL', `too few comparable tics (${common.length}); test did not run long enough`);
if (mismatches)
    fail('DESYNC', `P0(320) vs P1(854) desync on ${mismatches} tics (first at tic ${firstMismatch}) — wide perturbs sim!`);

console.log(`PASS — mixed-width (P0=320 vs P1=854): ${common.length} tics, 0 mismatches (wide is render-only)`);

for (const c of clients) { try { c.relay.quit(); c.lobby.close(); } catch (_) {} }
server.kill();
process.exit(0);
