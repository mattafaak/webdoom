#!/usr/bin/env node
// A hidden tab stops requestAnimationFrame, so its engine stops running tics,
// but its WebSocket keeps delivering the sealed bundles the relay goes on
// producing (it fabricates the hidden player's commands after 250 ms).  This
// drives two clients through the real server and the shipped client/js/net.js
// the way main.js does -- relay.offer() then _web_frame() per frame -- and
// stops one client's frames:
//
//   3 s  the bundles exceed the engine's 35-tic ring.  The client must come
//        back with no consistency failure, agree with the other client on
//        every tic both ran, and still be in the game afterwards;
//   7 s  past the server's 5 s drop.  The client must be told the session is
//        over (relay.onLost) instead of freezing, and the other must play on.
//
// usage: node tools/net-hidden-test.mjs [--build-dir DIR]
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, sleep, buildDirArg } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const BUILD = buildDirArg();
const { connectLobby, attachRelay, launchArgs } = await import(join(root, 'client/js/net.js'));
const wadBytes = loadWad('doom.wad');

async function session(hideMs) {
    const srv = await startServer({});
    const clients = [];
    for (let i = 0; i < 2; i++) {
        const c = { name: `P${i}`, error: null, lost: null, hashes: new Map() };
        c.doom = await bootEngine(BUILD, [['doomu.wad', wadBytes]], {
            printErr: t => { if (/consistency|I_Error/i.test(t)) c.error ??= t; },
            onDoomError: m => { c.error ??= m; },
        });
        clients.push(c);
    }
    const launches = clients.map(c => new Promise(res => { c.lobby = connectLobby(srv.ws); c.lobby.on('launch', res); }));
    await sleep(300);
    clients[0].lobby.setParams({ episode: 1, map: 1, skill: 3, mode: 'coop' });
    await sleep(200);
    clients[0].lobby.start();
    const msgs = await Promise.all(launches);
    clients.forEach((c, i) => {
        c.relay = attachRelay(c.doom, srv.ws, { slot: c.lobby.slot, token: msgs[i].token, numplayers: msgs[i].numplayers,
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
    const t0 = performance.now();
    let resumedAt = 0;
    for (;;) {
        await sleep(14);
        const t = performance.now() - t0;
        const hidden = t > 3000 && t < 3000 + hideMs;
        frame(p0);
        if (!hidden) { if (!resumedAt && t >= 3000 + hideMs) resumedAt = p1.doom._web_gametic(); frame(p1); }
        if (t > 3000 + hideMs + 4000) break;
    }
    const common = [...p0.hashes.keys()].filter(t => p1.hashes.has(t) && t > 2);
    const mismatched = common.filter(t => p0.hashes.get(t) !== p1.hashes.get(t)).length;
    const out = { p0, p1, common: common.length, mismatched, resumedAt,
                  gap: p0.doom._web_gametic() - p1.doom._web_gametic() };
    for (const c of clients) { try { c.relay.quit(); } catch { /* closed */ } c.lobby.close(); }
    srv.stop();
    return out;
}

{
    const r = await session(3000);
    check('hidden 3 s: no engine error on return', !r.p1.error && !r.p0.error, r.p1.error ?? r.p0.error);
    check(`hidden 3 s: both clients agree on every common tic (${r.common} compared)`, r.common > 200 && r.mismatched === 0,
          `${r.mismatched} of ${r.common} differ`);
    check('hidden 3 s: the returning client is still in the game and caught up', !r.p1.lost && r.gap >= 0 && r.gap < 35,
          `lost: ${r.p1.lost}, ${r.gap} tics behind`);
}
{
    const r = await session(7000);
    check('hidden 7 s: the dropped client is told the session is over', !!r.p1.lost, `error: ${r.p1.error}`);
    check('hidden 7 s: the other client played on with no error', !r.p0.error && !r.p0.lost, r.p0.error ?? r.p0.lost);
}
summary('a hidden client survives a 3 s gap in lockstep and is told when the server drops it');
