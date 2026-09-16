#!/usr/bin/env node
// Drop-in edge-case probe: the relay's slot/session bookkeeping (reservations,
// simultaneous joins, full lobby, join+drop) at the protocol level with raw
// WebSockets and a lightweight fake host — no wasm, so it is fast and targets
// the race/leak/timeout logic directly.
import { startServer } from './lib/server.mjs';
import { WebSocket, open, attachBuf, onceMsg, lobbyJoin } from './lib/ws.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

// A fake host: one real player that starts a session and keeps sealing tics
// so history accumulates and the session stays alive.
async function startSession(base, wad = 'doom.wad') {
    const lob = lobbyJoin(base);
    await open(lob);
    await onceMsg(lob, m => m.t === 'welcome');
    lob.send(JSON.stringify({ t: 'params', params: { wad, episode: 1, map: 1, skill: 3, mode: 'coop' } }));
    lob.send(JSON.stringify({ t: 'start' }));
    await onceMsg(lob, m => m.t === 'launch');
    const g = attachBuf(new WebSocket(base + '/ws/game?slot=0'));
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
    return { lob, g, stop() { stopped = true; try { g.close(); } catch { /* gone */ } try { lob.close(); } catch { /* gone */ } } };
}

// A relay socket for a joined slot that keeps sending cmds.
async function playSlot(base, slot) {
    const g = attachBuf(new WebSocket(base + '/ws/game?slot=' + slot));
    g.binaryType = 'nodebuffer';
    await open(g);
    let tic = 0, alive = true;
    const loop = () => { if (!alive) return; const b = Buffer.alloc(12); b.writeUInt32LE(tic++, 0); if (g.readyState === 1) g.send(b); setTimeout(loop, 28); };
    loop();
    return { g, close() { alive = false; g.close(); } };
}

// connect a lobby client during a live game: the server sends 'inprogress'
// first (no reservation); optionally request a drop-in, which reserves a
// slot (welcome carries it) and answers 'launch' or 'full'.
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

// ── scenario 1: fifth player rejected ────────────────────────────────────
async function fifthPlayer() {
    const s = await startServer();
    const host = await startSession(s.ws);
    await sleep(300);
    const fillers = [];
    for (let i = 1; i <= 3; i++) {
        const p = await probeJoin(s.ws);
        fillers.push({ p, play: await playSlot(s.ws, p.slot) });
    }
    await sleep(600);   // let them promote
    const fifth = await probeJoin(s.ws);
    check(`5th player rejected — got '${fifth.offered}' (${fifth.reason ?? ''})`, fifth.offered === 'full');
    host.stop(); fillers.forEach(f => { f.play.close(); f.p.w.close(); }); fifth.w.close(); s.stop();
}

// ── scenario 2: two simultaneous joins get distinct slots ────────────────
async function simultaneousJoins() {
    const s = await startServer();
    const host = await startSession(s.ws);
    await sleep(300);
    const [a, b] = await Promise.all([probeJoin(s.ws), probeJoin(s.ws)]);
    check(`2 simultaneous joins → distinct slots ${a.slot} & ${b.slot} (offers ${a.offered}/${b.offered})`,
          a.offered === 'launch' && b.offered === 'launch' && a.slot !== b.slot);
    host.stop(); a.w.close(); b.w.close(); s.stop();
}

// ── scenario 3: viewing never reserves; stalled reservations time out ────
async function reservations() {
    const s = await startServer({ env: { WEBDOOM_JOIN_TIMEOUT: '2000' } });
    const host = await startSession(s.ws);
    await sleep(300);
    const viewers = [];
    for (let i = 0; i < 3; i++) viewers.push(await probeJoin(s.ws, { requestJoin: false }));
    const allViewing = viewers.every(v => v.offered === 'inprogress');
    const stillFree = viewers[2].summary?.freeSlots?.length === 3;
    check(`viewing the game reserves no slot — freeSlots=${JSON.stringify(viewers[2].summary?.freeSlots)}`, allViewing && stillFree);
    const stalled = [];
    for (let i = 0; i < 3; i++) stalled.push(await probeJoin(s.ws, { requestJoin: true }));
    const reserved = stalled.filter(x => x.offered === 'launch').length;
    const fourth = await probeJoin(s.ws, { requestJoin: true });
    const blocked = fourth.offered === 'full';
    stalled.forEach(x => x.w.close());       // abandon the reservations
    await sleep(2600);                       // past the 2 s timeout + a sweep
    const after = await probeJoin(s.ws, { requestJoin: true });
    check(`stalled reservations reclaimed after timeout — reserved ${reserved}/3, 4th='${fourth.offered}', after='${after.offered}'`,
          reserved === 3 && blocked && after.offered === 'launch');
    host.stop(); viewers.forEach(v => v.w.close()); fourth.w.close(); after.w?.close(); s.stop();
}

// ── scenario 4: join + drop simultaneously ───────────────────────────────
async function joinAndDrop() {
    const s = await startServer();
    const host = await startSession(s.ws);
    const p1 = await probeJoin(s.ws);
    const play1 = await playSlot(s.ws, p1.slot);
    await sleep(800);
    const [, j] = await Promise.all([
        (async () => { play1.close(); p1.w.close(); })(),
        probeJoin(s.ws),
    ]);
    await sleep(500);
    check(`join + drop simultaneously — new joiner got '${j.offered}' slot ${j.slot}`, j.offered === 'launch');
    const after = await probeJoin(s.ws).catch(() => ({ offered: 'ERROR' }));
    check(`server responsive after join+drop — follow-up probe='${after.offered}'`,
          after.offered === 'launch' || after.offered === 'full');
    host.stop(); j.w.close(); after.w?.close(); s.stop();
}

console.log('drop-in edge cases:');
await fifthPlayer();
await simultaneousJoins();
await joinAndDrop();
await reservations();
summary('all 6 edge cases handled');
