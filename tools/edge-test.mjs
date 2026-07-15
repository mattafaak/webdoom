#!/usr/bin/env node
// Drop-in edge-case probe: exercises the relay's slot/session bookkeeping
// (reservations, simultaneous joins, full-lobby, join+drop) at the protocol
// level with raw WebSockets and a lightweight fake host — no wasm needed, so
// it's fast and targets the race/leak/timeout logic directly.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = createRequire(join(root, 'server/game.js'))('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let PORT = 8670;
function spawnServer(extraEnv = {}) {
    const port = PORT++;
    const srv = spawn('node', [join(root, 'server/serve.js')],
        { env: { ...process.env, DOOM_PORT: port, DOOM_HOST: '127.0.0.1', ...extraEnv }, stdio: ['ignore', 'ignore', 'ignore'] });
    return { srv, base: `ws://127.0.0.1:${port}`, kill: () => srv.kill() };
}

const open = ws => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
function onceMsg(ws, pred) {
    return new Promise(res => {
        const h = raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (pred(m)) { ws.off('message', h); res(m); } };
        ws.on('message', h);
    });
}
const lobbyJoin = base => { const w = new WebSocket(base + '/ws/lobby'); return w; };

// A fake host: 1 real player that starts a session and keeps sealing tics so
// history accumulates and the session stays alive.
async function startSession(base, wad = 'doom.wad') {
    const lob = lobbyJoin(base);
    await open(lob);
    await onceMsg(lob, m => m.t === 'welcome');
    lob.send(JSON.stringify({ t: 'params', params: { wad, episode: 1, map: 1, skill: 3, mode: 'coop' } }));
    lob.send(JSON.stringify({ t: 'start' }));
    await onceMsg(lob, m => m.t === 'launch');
    const g = new WebSocket(base + '/ws/game?slot=0');
    g.binaryType = 'nodebuffer';
    await open(g);
    let tic = 0, stopped = false;
    const loop = () => {
        if (stopped) return;
        const b = Buffer.alloc(12); b.writeUInt32LE(tic++, 0);
        if (g.readyState === 1) g.send(b);
        setTimeout(loop, 28);
    };
    loop();
    return { lob, g, stop() { stopped = true; try { g.close(); } catch {} try { lob.close(); } catch {} } };
}

// connect a lobby client during a live game. The server sends 'inprogress'
// first (no reservation); we optionally request a drop-in, which reserves a
// slot (welcome carries it) and returns 'launch'/'full'.
async function probeJoin(base, { requestJoin = true, slot, name } = {}) {
    const w = lobbyJoin(base);
    await open(w);
    let mySlot = -1;
    w.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.t === 'welcome') mySlot = m.slot; });
    const ip = await onceMsg(w, m => m.t === 'inprogress' || m.t === 'full');
    if (ip.t === 'full') return { w, offered: 'full', reason: ip.reason };
    if (!requestJoin) return { w, offered: 'inprogress', summary: ip };
    w.send(JSON.stringify({ t: 'join', ...(Number.isInteger(slot) ? { slot } : {}), ...(name ? { name } : {}) }));
    const m = await onceMsg(w, m => m.t === 'launch' || m.t === 'full');
    return { w, offered: m.t, join: !!m.join, slot: mySlot, reason: m.reason };
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`); };

// ── scenario 1: fifth player rejected ────────────────────────────────────
async function fifthPlayer() {
    const s = spawnServer(); await sleep(700);
    const host = await startSession(s.base);
    await sleep(300);
    // fill the other 3 slots with real joiners (lobby + game ws + cmds)
    const fillers = [];
    for (let i = 1; i <= 3; i++) {
        const p = await probeJoin(s.base);
        const g = new WebSocket(s.base + '/ws/game?slot=' + p.slot); g.binaryType = 'nodebuffer';
        await open(g);
        let tic = 0; const loop = () => { const b = Buffer.alloc(12); b.writeUInt32LE(tic++, 0); if (g.readyState === 1) { g.send(b); setTimeout(loop, 28); } }; loop();
        fillers.push({ p, g });
    }
    await sleep(600);   // let them promote
    const fifth = await probeJoin(s.base);
    check('5th player rejected', fifth.offered === 'full', `5th got '${fifth.offered}' (${fifth.reason ?? ''})`);
    host.stop(); fillers.forEach(f => { f.g.close(); f.p.w.close(); }); fifth.w.close(); s.kill();
}

// ── scenario 2: two simultaneous joins get distinct slots ────────────────
async function simultaneousJoins() {
    const s = spawnServer(); await sleep(700);
    const host = await startSession(s.base);
    await sleep(300);
    const [a, b] = await Promise.all([probeJoin(s.base), probeJoin(s.base)]);
    const distinct = a.offered === 'launch' && b.offered === 'launch' && a.slot !== b.slot;
    check('2 simultaneous joins → distinct slots', distinct, `slots ${a.slot} & ${b.slot} (offers ${a.offered}/${b.offered})`);
    host.stop(); a.w.close(); b.w.close(); s.kill();
}

// ── scenario 3: viewing never reserves; stalled reservations time out ────
async function reservations() {
    const s = spawnServer({ WEBDOOM_JOIN_TIMEOUT: '2000' }); await sleep(700);
    const host = await startSession(s.base);
    await sleep(300);
    // three clients just LOOK (inprogress, no join request) — must hold no slot
    const viewers = [];
    for (let i = 0; i < 3; i++) viewers.push(await probeJoin(s.base, { requestJoin: false }));
    const allViewing = viewers.every(v => v.offered === 'inprogress');
    const stillFree = viewers[2].summary?.freeSlots?.length === 3;
    check('viewing the game reserves no slot', allViewing && stillFree,
        `3 viewers all got 'inprogress', freeSlots=${JSON.stringify(viewers[2].summary?.freeSlots)}`);
    // three clients REQUEST join (reserve 1,2,3) then vanish without a game-ws
    const stalled = [];
    for (let i = 0; i < 3; i++) stalled.push(await probeJoin(s.base, { requestJoin: true }));
    const reserved = stalled.filter(x => x.offered === 'launch').length;
    const fourth = await probeJoin(s.base, { requestJoin: true });
    const blocked = fourth.offered === 'full';
    stalled.forEach(x => x.w.close());       // abandon the reservations
    await sleep(2600);                       // past the 2s timeout + a sweep
    const after = await probeJoin(s.base, { requestJoin: true });
    check('stalled reservations reclaimed after timeout', reserved === 3 && blocked && after.offered === 'launch',
        `reserved ${reserved}/3, 4th='${fourth.offered}', after timeout='${after.offered}'`);
    host.stop(); viewers.forEach(v => v.w.close()); fourth.w.close(); after.w?.close(); s.kill();
}

// ── scenario 4: join + drop simultaneously ───────────────────────────────
async function joinAndDrop() {
    const s = spawnServer(); await sleep(700);
    // 2-player session
    const host = await startSession(s.base);
    const p1 = await probeJoin(s.base);
    const g1 = new WebSocket(s.base + '/ws/game?slot=' + p1.slot); g1.binaryType = 'nodebuffer';
    await open(g1);
    let t1 = 0, alive = true; const loop1 = () => { if (!alive) return; const b = Buffer.alloc(12); b.writeUInt32LE(t1++, 0); if (g1.readyState === 1) g1.send(b); setTimeout(loop1, 28); }; loop1();
    await sleep(800);
    // simultaneously: p1 drops, a new joiner arrives
    let crashed = false;
    const [_, j] = await Promise.all([
        (async () => { alive = false; g1.close(); p1.w.close(); })(),
        probeJoin(s.base),
    ]);
    await sleep(500);
    check('join + drop simultaneously', j.offered === 'launch' && !crashed, `new joiner got '${j.offered}' slot ${j.slot}, server alive`);
    // server still responsive?
    const after = await probeJoin(s.base).catch(() => ({ offered: 'ERROR' }));
    check('server responsive after join+drop', after.offered === 'launch' || after.offered === 'full', `follow-up probe='${after.offered}'`);
    host.stop(); j.w.close(); after.w?.close(); s.kill();
}

console.log('drop-in edge cases:');
await fifthPlayer();
await simultaneousJoins();
await joinAndDrop();
await reservations();

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\nEDGE FAILURES: ${failed.length}` : `\nPASS — all ${results.length} edge cases handled`);
process.exit(failed.length ? 1 : 0);
