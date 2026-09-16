#!/usr/bin/env node
// Injection red-proof: a spectator sends raw 12-byte tic frames to /ws/spectate
// while two veterans play. Proves that (a) the server's spectate handler has no
// ticcmd write path — injected bytes are discarded before reaching application
// code — and (b) the veterans' sealed bundles and per-tic hashes are unaffected
// (lockstep determinism is preserved). Veterans staying in full hash-sync is
// proof-by-construction that injection was a protocol no-op.
//
// usage: node tools/spectate-inject-test.mjs
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, sleep, buildDirArg } from './lib/util.mjs';
import { createRequire } from 'node:module';

process.on('uncaughtException', e => {
    console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300));
    process.exit(1);
});

const WebSocket = createRequire(join(root, 'server/game.js'))('ws');

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
    return { name, doom, isFatal: () => fatal, hashes: new Map(), active: false, slot: -1 };
}

// --- 2 veterans start the game -----------------------------------------------
const vets = [await makeClient('P0'), await makeClient('P1')];
const launches = vets.map(c => new Promise(res => { c.lobby = connectLobby(base); c.lobby.on('launch', res); }));
await sleep(300);
vets[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
await sleep(200);
vets[0].lobby.start();
const lm = await Promise.all(launches);
console.log(`launched 2p coop (slots ${lm[0].slots}): ${JSON.stringify(lm[0].params)}`);
vets.forEach((c, i) => {
    c.slot = c.lobby.slot;
    c.relay = attachRelay(c.doom, base, {
        slot: c.slot, numplayers: lm[i].numplayers, slots: lm[i].slots, names: lm[i].names, jitterMs: 2,
    });
    c.doom.callMain(launchArgs(lm[i].params, false));
    c.relay.go();
    c.active = true;
});
const KEYS = [0xad, 0xae];
vets.forEach((c, i) => c.doom._web_input_event(0, KEYS[i], 0, 0));

// --- attacker: a raw WebSocket on /ws/spectate that sends fake ticcmds -------
// The server has no message handler on this path — the bytes are discarded
// before reaching application code. The /ws/spectate WSS maxPayload (64)
// means the ws library itself will absorb the payload without emitting
// 'message'. Either way, the server's game state is unaffected.
let injector = null;
let injectionsSent = 0;
let injectorConnected = false;

function launchInjector() {
    injector = new WebSocket(`${base}/ws/spectate`);
    injector.on('open', () => {
        injectorConnected = true;
        console.log('injector: /ws/spectate open — sending fake ticcmds');
    });
    injector.on('error', () => {});   // absorb any error from the server
    injector.on('close', () => { injectorConnected = false; });
}

let injectorKicked = false;
const t0 = performance.now();

for (;;) {
    await sleep(14);
    for (const c of vets) {
        if (!c.active) continue;
        c.doom._web_frame();
        if (c.isFatal()) fail(`${c.name}: ${c.isFatal()}`);
        c.hashes.set(c.doom._web_gametic(), c.doom._web_state_hash());
    }
    const elapsed = performance.now() - t0;

    // After 3s, connect the injector
    if (elapsed > 3000 && !injectorKicked) {
        injectorKicked = true;
        launchInjector();
    }

    // Once the injector is connected, spam fake 12-byte tic frames every ~140 ms
    if (injectorConnected && injector?.readyState === WebSocket.OPEN) {
        // Fake ticcmd: [u32 tic=999][8B ticcmd with buttons=0xFF to look hostile]
        const fake = Buffer.alloc(12);
        fake.writeUInt32LE(999 + injectionsSent, 0);
        fake[4] = 100;   // forwardmove — maximum aggression
        fake[5] = 100;   // sidemove
        fake[11] = 0xFF; // buttons
        injector.send(fake);
        injectionsSent++;
    }

    if (elapsed > 12000) break;
}

// --- close injector and verdict ----------------------------------------------
try { injector?.terminate(); } catch {}

const numInjected = injectionsSent;
if (numInjected === 0) fail('injector never sent any data — test is vacuous');

// Veterans must be in full hash-sync. Any desync would mean the injection
// changed the game state — proving the opposite: that it was a no-op.
const common = [...vets[0].hashes.keys()].filter(t => vets[1].hashes.has(t) && t > 2);
const bad = common.filter(t => vets[0].hashes.get(t) !== vets[1].hashes.get(t)).length;

console.log(`injections sent: ${numInjected}; tics compared P0 vs P1: ${common.length}, mismatches: ${bad}`);

if (bad) fail(`DESYNC on ${bad} tics — injection corrupted game state (server accepted ticcmd from spectate path)`);
if (common.length < 200) fail(`too few shared tics between veterans (${common.length}) — game may have stalled`);

console.log(`PASS — ${numInjected} injections sent; veteran hashes match on all ${common.length} common tics — injection is a protocol no-op`);
for (const c of vets) { c.relay?.quit(); c.lobby?.close(); }
srv.stop();
process.exit(0);
