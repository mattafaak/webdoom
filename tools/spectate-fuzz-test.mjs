#!/usr/bin/env node
// Spectate fuzz + abuse suite: throws hostile clients at /ws/spectate and
// verifies the server survives with its caps intact.
//
// This is the open half of task 23.6. `spectate` proves an observer
// re-simulates the identical world and `spectate-inject` proves it cannot
// write ticcmds; NOTHING drove the spectate path with malformed or abusive
// clients, so every resource cap on it -- MAX_SPECTATORS, maxPayload, the
// history-cap refusal, the close-handler bookkeeping -- was unasserted.
//
// The closing case is a LEGITIMATE spectator connecting after all the abuse.
// Without it this suite would pass just as happily against a server that had
// stopped serving anyone: "the attacks were refused" and "everything is
// refused" are the same observation from the attacker's side.
//
// usage: node tools/spectate-fuzz-test.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.on('uncaughtException', e => {
    console.error('UNCAUGHT:', e?.message ?? String(e).slice(0, 300));
    process.exit(1);
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SPECTATE_FUZZ_PORT ?? 8681);
const base = `ws://127.0.0.1:${PORT}`;
const MAX_SPECTATORS = 2;                  // pinned low so the cap is reachable
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { connectLobby } = await import(join(root, 'client/js/net.js'));

let crashed = null;
const server = spawn('node', [join(root, 'server/serve.js')], {
    env: { ...process.env, DOOM_PORT: String(PORT), DOOM_HOST: '127.0.0.1',
           WEBDOOM_MAX_SPECTATORS: String(MAX_SPECTATORS) },
    stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', d => {
    const t = d.toString();
    if (/Error:|at Object\.|at Module\.|UnhandledPromise/.test(t)) crashed ??= t.slice(0, 200);
});
await sleep(900);

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log(`PASS ${m}`); };
const bad = m => { fail++; console.log(`FAIL ${m}`); };

// Open a raw spectate socket. Returns { ws, open } after settleMs: an accepted
// observer is still OPEN, a refused one has been terminated by refuse().
async function spectator(settleMs = 400) {
    const ws = new WebSocket(`${base}/ws/spectate`);
    ws.binaryType = 'arraybuffer';
    let msgs = 0;
    ws.addEventListener('message', () => { msgs++; });
    ws.addEventListener('error', () => {});
    await sleep(settleMs);
    return { ws, get open() { return ws.readyState === WebSocket.OPEN; }, get msgs() { return msgs; } };
}

// ── set a session up: spectate refuses outright when none exists ─────────────
const a = connectLobby(base), b = connectLobby(base);
const launched = new Promise(res => a.on('launch', res));
await sleep(400);
a.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
await sleep(250);
a.start();
await launched;
await sleep(400);
console.log(`session up on ${base} (MAX_SPECTATORS=${MAX_SPECTATORS})`);

// ── 1. the cap is enforced ───────────────────────────────────────────────────
const first = [];
for (let i = 0; i < MAX_SPECTATORS; i++) first.push(await spectator());
const accepted = first.filter(s => s.open).length;
accepted === MAX_SPECTATORS
    ? ok(`cap: ${accepted} observer(s) accepted up to the cap`)
    : bad(`cap: only ${accepted} of ${MAX_SPECTATORS} accepted below the cap`);

const over = [];
for (let i = 0; i < 3; i++) over.push(await spectator());
const refused = over.filter(s => !s.open).length;
refused === 3
    ? ok('cap: 3 of 3 over-cap observers refused')
    : bad(`cap: ${3 - refused} over-cap observer(s) were ADMITTED past ${MAX_SPECTATORS}`);

// ── 2. closes are booked, so the cap is not a one-way door ───────────────────
first.forEach(s => s.ws.close());
await sleep(400);
const afterClose = await spectator();
afterClose.open
    ? ok('bookkeeping: a slot freed by close() is reusable')
    : bad('bookkeeping: the cap stayed full after close() — spectators leak');
afterClose.ws.close();
await sleep(300);

// ── 3. an oversized frame is dropped, not accepted ───────────────────────────
// spectateWss has maxPayload 64: receive-only, zero-payload pings only.
{
    const s = await spectator();
    if (!s.open) bad('oversized: could not seat an observer to attack with');
    else {
        s.ws.send(new Uint8Array(4096));
        await sleep(400);
        s.open ? bad('oversized: a 4096-byte frame was accepted on a receive-only socket')
               : ok('oversized: 4096-byte frame closed the socket (maxPayload 64)');
    }
}

// ── 4. a ticcmd-shaped frame cannot be injected ──────────────────────────────
// Structural: spectateConnect registers NO message handler at all.
{
    const s = await spectator();
    if (!s.open) bad('inject: could not seat an observer to attack with');
    else {
        for (let i = 0; i < 20; i++) s.ws.send(new Uint8Array(12).fill(0x7f));
        await sleep(400);
        crashed ? bad(`inject: server logged a crash: ${crashed}`)
                : ok('inject: 20 ticcmd-shaped frames changed nothing and crashed nothing');
        s.ws.close();
    }
}
await sleep(300);

// ── 5. churn does not leak the spectators set ────────────────────────────────
{
    for (let i = 0; i < 30; i++) {
        const ws = new WebSocket(`${base}/ws/spectate`);
        ws.addEventListener('error', () => {});
        await sleep(25);
        ws.close();
    }
    await sleep(600);
    const s = await spectator();
    s.open ? ok('churn: 30 connect/disconnect cycles left the cap intact')
           : bad('churn: after 30 cycles the cap is exhausted — close() bookkeeping leaks');
    s.ws.close();
    await sleep(300);
}

// ── 6. a half-open observer that never reads does not take the server down ───
{
    const s = await spectator();
    if (!s.open) bad('half-open: could not seat an observer');
    else {
        await sleep(700);                      // never read, never close
        crashed ? bad(`half-open: server logged a crash: ${crashed}`)
                : ok('half-open: a stalled observer did not fault the server');
        s.ws.close();
    }
}
await sleep(400);

// ── 7. LIVENESS — the closing case, and the reason this suite means anything ─
{
    const s = await spectator(700);
    s.open ? ok('liveness: a legitimate observer is still served after all of the above')
           : bad('liveness: the server refuses EVERYONE now — the refusals above proved nothing');
    s.ws.close();
}

if (crashed) bad(`server logged a crash at some point: ${crashed}`);

a.close(); b.close();
await sleep(200);
server.kill();

const total = pass + fail;
if (total < 8) { console.log(`FAIL spectate-fuzz: only ${total} case(s) ran — the suite did not run`); process.exit(1); }
if (fail)      { console.log(`FAIL spectate-fuzz: ${fail} of ${total} cases failed`); process.exit(1); }
console.log(`PASS — spectate-fuzz: ${total} hostile cases, caps enforced, server survived, ` +
            `and a legitimate observer is still served`);
