#!/usr/bin/env node
// Headless spectator determinism test: 2 players start a game, play a few
// seconds, then a spectator connects via /ws/spectate — catching up by
// replaying the sealed bundle history — and watches live. Proves the
// spectator re-simulates the identical world: per-tic _web_state_hash
// matches the veterans at every common tic after the frontier.
// usage: node tools/spectate-test.mjs
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.on('uncaughtException', e => {
    console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300));
    process.exit(1);
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8673;
const base = `ws://127.0.0.1:${PORT}`;

const { connectLobby, attachRelay, attachSpectate, launchArgs } = await import(join(root, 'client/js/net.js'));
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
const KEYS = [0xad, 0xae];    // fwd, right
vets.forEach((c, i) => c.doom._web_input_event(0, KEYS[i], 0, 0));

// --- spectator joins mid-game via /ws/spectate --------------------------------
// Connect a FRESH lobby observer during the active session to receive the
// 'inprogress' message (includes current frontier). Observers that connected
// pre-session get 'launch' not 'inprogress', so we must connect post-session.
async function joinAsSpectator() {
    // Probe current frontier via a fresh lobby connection (will get 'inprogress')
    const frontier = await new Promise((res, rej) => {
        const obs = connectLobby(base);
        const t = setTimeout(() => { obs.close(); rej(new Error('inprogress timeout')); }, 5000);
        obs.on('inprogress', m => {
            clearTimeout(t);
            obs.close();
            res(m.frontier ?? 0);
        });
    });

    const c = await makeClient('SPEC');
    // Derive slots and names from what veterans used (same session params)
    c.relay = attachSpectate(c.doom, base, {
        numplayers: lm[0].numplayers,
        slots: lm[0].slots,
        names: lm[0].names,
    });
    c.doom.callMain(launchArgs(lm[0].params, false));
    await c.relay.catchUp(frontier, () => {});
    c.frontier = frontier;
    return c;
}

const clients = [...vets];
let spectator = null, specKicked = false;
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
    if (elapsed > 4000 && !specKicked) {
        specKicked = true;
        joinAsSpectator().then(c => {
            spectator = c; c.active = true; clients.push(c);
            console.log(`spectator caught up to gametic ${c.doom._web_gametic()} (frontier was ${c.frontier})`);
        }).catch(e => fail(`spectate failed: ${e?.message ?? e}`));
    }
    if (elapsed > 15000) break;
}

// --- verdicts ----------------------------------------------------------------
if (!spectator) fail('spectator never connected / caught up');

let compared = 0, bad = 0;
// Compare spectator hashes against veteran P0 at every common tic above tic 2
const common = [...vets[0].hashes.keys()].filter(t => spectator.hashes.has(t) && t > 2);
compared = common.length;
bad = common.filter(t => vets[0].hashes.get(t) !== spectator.hashes.get(t)).length;
const afterFrontier = common.filter(t => t >= spectator.frontier).length;

console.log(`tics compared: ${compared}, mismatches: ${bad}; spectator shares ${common.length} tics (${afterFrontier} at/after frontier)`);

if (bad) fail(`DESYNC on ${bad} tics — spectator simulation diverged from veterans`);
if (common.length < 100) fail(`spectator too few shared tics (${common.length}) — did it catch up?`);
if (afterFrontier < 20) fail(`spectator did not watch live long enough after catch-up (${afterFrontier} tics)`);

console.log(`PASS — spectator caught up, per-tic hash matches P0 at all ${common.length} common tics (0 desync)`);
for (const c of clients) { c.relay?.quit(); c.lobby?.close(); }
server.kill();
process.exit(0);
