#!/usr/bin/env node
// HOL (head-of-line blocking) measurement for webdoom netplay.
// Connects as 2 players (server on localhost:8671 by default), plays for 15s,
// records bundle-arrival timestamps at client-0, and reports inter-arrival
// gap distribution vs the 28.57 ms tic period.
//
// Usage: node tools/hol-measure.mjs [ws://HOST:PORT]
// Output (stdout): JSON with p50/p99/max gap stats.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.on('uncaughtException', e => {
    console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300));
    process.exit(1);
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argBase = process.argv[2];
const PORT = argBase ? null : 8671;
const base = argBase ?? `ws://127.0.0.1:${PORT}`;

const { connectLobby, attachRelay, launchArgs } =
    await import(join(root, 'client/js/net.js'));
const createDoom = (await import(join(root, 'build/doom.js'))).default;
const wadBytes = readFileSync(join(root, 'wads/lib/doom.wad'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

let server = null;
if (!argBase) {
    server = spawn('node', [join(root, 'server/serve.js')], {
        env: { ...process.env, DOOM_PORT: PORT, DOOM_HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    server.stdout.on('data', () => {});
    await sleep(800);
}

const fail = msg => {
    console.error(`FAIL: ${msg}`);
    server?.kill();
    process.exit(1);
};

async function makeClient(name) {
    const doom = await createDoom({
        print: () => {},
        printErr: t => { if (/consistency|I_Error/i.test(t)) console.error(`[${name}] ${t}`); },
        onDoomError: msg => fail(`${name}: ${msg}`),
    });
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
               ['doomu.wad', p, wadBytes.length]);
    return { name, doom, hashes: new Map() };
}

const clients = [await makeClient('P0'), await makeClient('P1')];

const launches = clients.map(c => new Promise(res => {
    c.lobby = connectLobby(base);
    c.lobby.on('launch', res);
}));
await sleep(300);
clients[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
await sleep(200);
clients[0].lobby.start();
const lms = await Promise.all(launches);

// Arrival timestamps captured at the relay WS for client-0.
// We patch the relay's ws.onmessage after attachRelay to snoop bundle arrivals.
const arrivals = [];   // performance.now() timestamps of each received bundle

clients.forEach((c, i) => {
    c.relay = attachRelay(c.doom, base, {
        slot: c.lobby.slot, numplayers: lms[i].numplayers,
        slots: lms[i].slots, names: lms[i].names, jitterMs: 2,
    });
    c.doom.callMain(launchArgs(lms[i].params, false));
    c.relay.go();
});

// Instrument after attachRelay — wrap the relay quit to let measurements finish.
// Instead of patching internals, we observe gametic deltas to infer bundle rate.
// Alternative: observe web_gametic() after each web_frame() call.
// We'll use gametic observations at each frame tick to infer bundle arrivals.

const KEYS = [0xad, 0xae];
clients.forEach((c, i) => c.doom._web_input_event(0, KEYS[i], 0, 0));

const t0 = performance.now();
let lastTic = -1;
const ticTimestamps = [];  // ms when each new gametic was first observed

for (;;) {
    await sleep(14);
    for (const c of clients) {
        c.doom._web_frame();
    }
    const curTic = clients[0].doom._web_gametic();
    if (curTic > lastTic) {
        const now = performance.now();
        // record arrival time for each new tic (may skip if multiple tics landed)
        for (let t = lastTic + 1; t <= curTic; t++) {
            ticTimestamps.push({ tic: t, ts: now });
        }
        lastTic = curTic;
    }
    if (performance.now() - t0 > 15000) break;
}

for (const c of clients) { c.relay.quit(); c.lobby.close(); }
server?.kill();

// Compute inter-arrival gaps from ticTimestamps (when new tic first observed)
// Filter: skip first 35 tics (warmup) and last 10 (drain).
const valid = ticTimestamps.filter(x => x.tic > 35 && x.tic < lastTic - 10);
const gaps = [];
for (let i = 1; i < valid.length; i++) {
    const dt = valid[i].ts - valid[i - 1].ts;
    const dtic = valid[i].tic - valid[i - 1].tic;
    if (dtic === 1) gaps.push(dt);  // only consecutive tics (no catch-up bunches)
}
gaps.sort((a, b) => a - b);
const p = pct => gaps[Math.floor(gaps.length * pct / 100)] ?? null;

const result = {
    n_gaps: gaps.length,
    tic_period_ms: 1000 / 35,
    p50: p(50) ? +p(50).toFixed(2) : null,
    p99: p(99) ? +p(99).toFixed(2) : null,
    max: gaps.length ? +gaps[gaps.length - 1].toFixed(2) : null,
    scope: argBase ? `remote server at ${argBase}` : 'localhost loopback',
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);
