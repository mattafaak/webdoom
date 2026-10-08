#!/usr/bin/env node
// A player whose page stops running tics: what the relay and the client do
// about it.  Two wasm clients play through the real server and the shipped
// client/js/net.js, each frame driven the way main.js drives one (relay.offer()
// then _web_frame()), and P1 is taken off its frame loop for a while:
//
//   clock 7 s   P1 runs on a 28 ms clock with drawing off, as main.js drives a
//               hidden netplay tab (a Worker posts every 28 ms; step(false)).
//               It must stay in the game, never be lost, agree with P0 on every
//               common tic, and both must run at least 30 tics/s.  P0 is never
//               fabricated: its cmds are always in flight.
//   silent 3 s  P1 runs nothing and sends nothing (a frozen page).  P0 must
//               keep at least 30 tics/s meanwhile, both must agree on every
//               common tic, and P1 must come back into lockstep within 35 tics
//               of P0.  The catch-up time is printed.
//   silent 7 s  past the server's 5 s drop.  P1 must be told why
//               (the close reason, matching /dropped/), and P0 must play on at
//               at least 30 tics/s.
//
// The gate is 30 tics/s against 35 true.  Each case prints the measured rate:
// P0's gametic over the silence, from 0.5 s in (past the 250 ms grace and the
// jitter buffer) to its end.
//
// Measured against the relay before the silent-player rule (master 7349c27,
// alder, 2026-10-08, three runs): with P1 silent 3 s, P0 ran at 20.0, 19.4 and
// 20.0 tics/s, because the relay fabricated P1's cmd once per 50 ms sweep and
// P0 waited for each one; over the 7 s case it read 26.5, 26.2 and 26.3 (20
// until the drop, 35 after), and P1 was told only "the connection to the game
// server was lost".  That is the red the 30 tics/s floor and the /dropped/
// reason were written against.  The clock case passed there too: a page that
// keeps sending needs nothing new from the relay.
//
// usage: node tools/net-hidden-test.mjs [--build-dir DIR]
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, sleep, buildDirArg } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

const BUILD = buildDirArg();
const { connectLobby, attachRelay, launchArgs } = await import(join(root, 'client/js/net.js'));
const wadBytes = loadWad('doom.wad');

const MIN_RATE = 30;            // tics/s; 35 is true time, about 20 the old relay
const LEAD_MS = 3000;           // both play normally before P1 is taken off
const AFTER_MS = 4000;          // both play normally after P1 is back
const CLOCK_MS = 28;            // main.js's hidden-tab clock

// mode: 'clock' (P1 on a 28 ms clock, drawing off) or 'silent' (P1 runs nothing)
async function session(mode, offMs) {
    const srv = await startServer({});
    const clients = [];
    for (let i = 0; i < 2; i++) {
        const c = { name: `P${i}`, error: null, lost: null, hashes: new Map(), samples: [], stored: [] };
        c.doom = await bootEngine(BUILD, [['doomu.wad', wadBytes]], {
            printErr: t => { if (/consistency|I_Error/i.test(t)) c.error ??= t; },
            onDoomError: m => { c.error ??= m; },
        });
        // every bundle the engine stores, when, and which slots the relay
        // fabricated in it; a 0 from the engine is offered again later and is
        // not counted.  Phantom slots are always fabricated, so it is per slot.
        const orig = c.doom._web_net_bundle;
        c.doom._web_net_bundle = (tic, cmds, ingame, fabmask) => {
            const rc = orig(tic, cmds, ingame, fabmask);
            if (rc === 1) c.stored.push({ at: performance.now(), fabmask });
            return rc;
        };
        clients.push(c);
    }
    const launches = clients.map(c => new Promise(res => { c.lobby = connectLobby(srv.ws); c.lobby.on('launch', res); }));
    await sleep(300);
    clients[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
    await sleep(200);
    clients[0].lobby.start();
    const msgs = await Promise.all(launches);
    clients.forEach((c, i) => {
        c.slot = c.lobby.slot;
        c.relay = attachRelay(c.doom, srv.ws, { slot: c.slot, token: msgs[i].token, numplayers: msgs[i].numplayers,
                                               slots: msgs[i].slots, names: msgs[i].names, jitterMs: 2 });
        c.relay.onLost = reason => { c.lost ??= reason; };
        c.doom.callMain(launchArgs(msgs[i].params, false));
        c.relay.go();
        c.doom._web_input_event(0, i ? 0xae : 0xad, 0, 0);       // P0 walks, P1 turns
    });

    const frame = (c) => {
        if (c.lost || c.error) return;
        try { c.relay.offer?.(); c.doom._web_frame(); } catch (e) { c.error ??= String(e.message ?? e); }
        c.hashes.set(c.doom._web_gametic(), c.doom._web_state_hash() >>> 0);
    };
    const [p0, p1] = clients;
    const offAt = LEAD_MS, backAt = LEAD_MS + offMs;
    const t0 = performance.now();
    let lastClock = -Infinity, nodraw = false, caughtUpMs = null;
    for (;;) {
        await sleep(14);
        const t = performance.now() - t0;
        const off = t > offAt && t < backAt;
        frame(p0);
        if (off && mode === 'clock') {
            if (!nodraw) { p1.doom._web_set_nodraw(1); nodraw = true; }
            if (t - lastClock >= CLOCK_MS) { lastClock = t; frame(p1); }
        } else if (!off) {
            if (nodraw) { p1.doom._web_set_nodraw(0); nodraw = false; }
            frame(p1);
        }
        for (const c of clients) c.samples.push({ t, g: c.doom._web_gametic() });
        if (t >= backAt && caughtUpMs === null && !p1.lost &&
            Math.abs(p0.doom._web_gametic() - p1.doom._web_gametic()) <= 4)
            caughtUpMs = Math.round(t - backAt);
        if (t > backAt + AFTER_MS) break;
    }
    // tics per second over [a, b] ms of the run, from the samples
    const rate = (c, a, b) => {
        const at = ms => c.samples.find(s => s.t >= ms) ?? c.samples[c.samples.length - 1];
        const s0 = at(a), s1 = at(b);
        return (s1.g - s0.g) / ((s1.t - s0.t) / 1000);
    };
    // Fabrication is counted while P1 is off its frame loop only.  Every
    // session opens with both players fabricated for about 19 tics: both
    // engines sit in the opening melt at gametic 0 for about a second, send
    // nothing, and the sweep seals one tic per 50 ms for the pair (measured
    // 2026-10-08, before and after the server rule alike).
    const inWindow = p0.stored.filter(b => b.at - t0 >= offAt && b.at - t0 < backAt);
    const fabOf = slot => inWindow.filter(b => (b.fabmask >> slot) & 1).length;
    const common = [...p0.hashes.keys()].filter(t => p1.hashes.has(t) && t > 2);
    const mismatched = common.filter(t => p0.hashes.get(t) !== p1.hashes.get(t)).length;
    const out = {
        p0, p1, common: common.length, mismatched, caughtUpMs,
        rate0: rate(p0, offAt + 500, backAt), rate1: rate(p1, offAt + 500, backAt),
        gap: p0.doom._web_gametic() - p1.doom._web_gametic(),
        // what the relay fabricated while P1 was off, as P0's engine received it
        fab0: fabOf(p0.slot), fab1: fabOf(p1.slot), bundles: inWindow.length,
    };
    for (const c of clients) { try { c.relay.quit(); } catch { /* closed */ } c.lobby.close(); }
    srv.stop();
    return out;
}

const r1 = n => n.toFixed(1);
{
    const r = await session('clock', 7000);
    console.log(`  clock 7 s: P0 ${r1(r.rate0)} tics/s, P1 ${r1(r.rate1)} tics/s; fabricated on the clock: ` +
                `P0 ${r.fab0}, P1 ${r.fab1} of ${r.bundles} bundles`);
    check('clock 7 s: no engine error', !r.p1.error && !r.p0.error, r.p1.error ?? r.p0.error);
    check('clock 7 s: neither client is lost', !r.p1.lost && !r.p0.lost, r.p1.lost ?? r.p0.lost);
    check(`clock 7 s: both clients agree on every common tic (${r.common} compared)`, r.common > 300 && r.mismatched === 0,
          `${r.mismatched} of ${r.common} differ`);
    check(`clock 7 s: P1 on the clock runs at least ${MIN_RATE} tics/s`, r.rate1 >= MIN_RATE, `${r1(r.rate1)} tics/s`);
    check(`clock 7 s: P0 runs at least ${MIN_RATE} tics/s`, r.rate0 >= MIN_RATE, `${r1(r.rate0)} tics/s`);
    check(`clock 7 s: P0 is never fabricated while P1 is on the clock (${r.bundles} bundles)`,
          r.bundles > 200 && r.fab0 === 0, `${r.fab0} of ${r.bundles} bundles`);
    check('clock 7 s: P1 is fabricated on at most 2% of tics', r.fab1 <= r.bundles * 0.02,
          `${r.fab1} of ${r.bundles} bundles`);
}
{
    const r = await session('silent', 3000);
    console.log(`  silent 3 s: P0 ${r1(r.rate0)} tics/s while P1 was silent; P1 back in lockstep ` +
                `${r.caughtUpMs ?? 'never'} ms after it resumed`);
    check('silent 3 s: no engine error on return', !r.p1.error && !r.p0.error, r.p1.error ?? r.p0.error);
    check(`silent 3 s: P0 runs at least ${MIN_RATE} tics/s while P1 is silent`, r.rate0 >= MIN_RATE,
          `${r1(r.rate0)} tics/s`);
    check(`silent 3 s: both clients agree on every common tic (${r.common} compared)`, r.common > 200 && r.mismatched === 0,
          `${r.mismatched} of ${r.common} differ`);
    check('silent 3 s: P1 is still in the game and within 35 tics of P0', !r.p1.lost && r.gap >= 0 && r.gap < 35,
          `lost: ${r.p1.lost}, ${r.gap} tics behind`);
    check('silent 3 s: P1 came back into lockstep', r.caughtUpMs !== null, 'never within 4 tics of P0');
}
{
    const r = await session('silent', 7000);
    console.log(`  silent 7 s: P0 ${r1(r.rate0)} tics/s; P1 told: ${JSON.stringify(r.p1.lost)}`);
    check('silent 7 s: the dropped client is told why', /dropped/.test(r.p1.lost ?? ''),
          `lost: ${JSON.stringify(r.p1.lost)}, error: ${r.p1.error}`);
    check('silent 7 s: the other client played on with no error', !r.p0.error && !r.p0.lost, r.p0.error ?? r.p0.lost);
    check(`silent 7 s: P0 runs at least ${MIN_RATE} tics/s throughout`, r.rate0 >= MIN_RATE, `${r1(r.rate0)} tics/s`);
}
summary('a player off its frame loop: on the clock it plays on, silent it costs the others nothing, dropped it is told why',
        { min: 15 });
