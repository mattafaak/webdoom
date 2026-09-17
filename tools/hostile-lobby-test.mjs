#!/usr/bin/env node
// tools/hostile-lobby-test.mjs — a hostile SERVER against the lobby client.
//
// tools/hostile-server-test.mjs fuzzes a hostile server into the ENGINE (task
// 23.8, 13 cases). Nothing fuzzed one into the LOBBY JSON path, and that was
// the asymmetry worth closing:
//
//   server/game.js:  let m; try { m = JSON.parse(raw); } catch { return; }
//   client/js/net.js: const m = JSON.parse(ev.data);
//
// The server treats the client as hostile on both its receive paths. The client
// trusted the server completely -- a bare parse inside a WebSocket event
// handler, so one malformed frame threw unhandled, and neither 'error' nor
// 'closed' fires for a throw, which means lobby.js never learned the connection
// was unusable. It simply stopped.
//
// spec.md's own threat model is a plain-HTTP LAN ("Deployment reality: insecure
// origins"), where anything on the network can answer ws://host:8666/ws/lobby.
//
// The other half is the hang: ping() had no timeout and no reject path, so
// lobby.js's `for (let i = 0; i < 12; i++) await lobby.ping().catch(() => 50)`
// -- which runs between `launch` and bootDoom -- waited FOREVER if 'pong'
// stopped arriving, with a "GO" countdown on screen and no way out.
//
// usage: node tools/hostile-lobby-test.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
// ws is CommonJS, so it has no named ESM exports — take the default and
// destructure, the same shape tools/join-client.mjs uses.
import ws from '../server/node_modules/ws/index.js';
const { WebSocketServer, WebSocket: NodeWS } = ws;
import { connectLobby } from '../client/js/net.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passes = 0, failures = 0;
const ok = (label, cond, detail = '') => {
    if (cond) { passes++; console.log(`  PASS  ${label}`); }
    else { failures++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

// performance.now() and a global WebSocket are browser globals net.js expects.
globalThis.performance ??= { now: () => Date.now() };

// Anything thrown out of a ws 'message' handler lands here, which is the
// browser equivalent of the unhandled throw this test exists to prevent.
const uncaught = [];
process.on('uncaughtException', e => uncaught.push(String(e?.message ?? e)));

// REGISTERING THAT HANDLER MADE THIS TEST ABLE TO PASS VACUOUSLY, and it did.
//
// With a handler installed, an uncaught exception no longer kills the process:
// module evaluation aborts where it threw, the event loop drains, and node
// exits 0. Run against the pre-fix client, this file printed 14 FAIL lines, then
// died at wss.close() before its own summary, and exited ZERO. A test that
// cannot report its failures is worse than no test.
//
// So the summary is the only sanctioned way out, and anything else is a red.
let summaryPrinted = false;
process.on('exit', () => {
    if (summaryPrinted) return;
    console.log('FAIL — hostile-lobby-test: ended before printing its summary ' +
                `(${passes} passed, ${failures} failed so far` +
                `${uncaught.length ? `, ${uncaught.length} uncaught: ${uncaught[uncaught.length - 1]}` : ''})`);
    process.exitCode = 1;
});

const wss = new WebSocketServer({ host: '127.0.0.1', port: 9301 });
let onConnect = null;
wss.on('connection', ws => { onConnect?.(ws); });
await new Promise(r => wss.on('listening', r));

// EACH CASE GETS A FRESH CONNECTION, and that is not tidiness.
//
// The first draft of this test reused one socket, and against the pre-fix
// client it read 24 PASS and 1 FAIL -- which looked like "only the first frame
// is a problem". It was not: the first malformed frame throws out of
// ws.onmessage, after which that socket delivers nothing more, so every
// assertion after it passed by observing NOTHING. A test whose later cases are
// disarmed by its earlier ones reports the opposite of what it found.
async function withClient(fn) {
    let server = null;
    onConnect = ws => { server = ws; };
    const api = connectLobby('ws://127.0.0.1:9301', NodeWS);
    for (let i = 0; i < 60 && !server; i++) await sleep(25);
    if (!server) throw new Error('client never connected — nothing was measured');
    await sleep(40);
    try { return await fn(api, server); }
    finally { try { api.close(); } catch { /* already gone */ } onConnect = null; }
}

console.log('\n── hostile frames from the server ───────────────────────────────');

// 1. Frames that are not messages at all. The probe after each one is what
//    proves the client is still ALIVE rather than merely quiet: a valid welcome
//    must still be accepted on the same socket.
const GARBAGE = [
    ['not JSON at all',        'this is not json {{{'],
    ['a bare string',          '"hello"'],
    ['a bare number',          '42'],
    ['JSON null',              'null'],
    ['an array',               '[1,2,3]'],
    ['an object with no t',    '{"slot":1}'],
    ['t is not a string',      '{"t":7}'],
    ['deeply nested junk',     JSON.stringify({ t: { t: { t: 'welcome' } } })],
    ['a huge frame',           JSON.stringify({ t: 'welcome', slot: 0, pad: 'x'.repeat(200000) })],
];
for (const [label, frame] of GARBAGE) {
    const before = uncaught.length;
    const stillWorks = await withClient(async (api, server) => {
        server.send(frame);
        await sleep(60);
        // The socket must still be usable afterwards.
        server.send(JSON.stringify({ t: 'welcome', slot: 3, color: 'Red' }));
        await sleep(60);
        return api.slot === 3;
    });
    const threw = uncaught.slice(before);
    ok(`${label}: no unhandled throw, socket still live`,
       threw.length === 0 && stillWorks,
       threw.length ? `threw: ${threw.join('; ')}` : 'the socket stopped delivering afterwards');
}

console.log('\n── a hostile welcome ────────────────────────────────────────────');

// 2. api.slot indexes COLORS[] and the roster arrays in lobby.js.
const BAD_SLOTS = [99, -1, 4, 1.5, '2', null, undefined, NaN];
for (const slot of BAD_SLOTS) {
    const got = await withClient(async (api, server) => {
        server.send(JSON.stringify({ t: 'welcome', slot, color: 'Green' }));
        await sleep(60);
        return api.slot;
    });
    ok(`welcome slot=${JSON.stringify(slot)} rejected (slot stays -1)`, got === -1,
        `api.slot became ${got}`);
}

const good = await withClient(async (api, server) => {
    server.send(JSON.stringify({ t: 'welcome', slot: 2, color: 'Brown' }));
    await sleep(60);
    return { slot: api.slot, color: api.color };
});
ok('a valid welcome is still accepted (slot 2, Brown)', good.slot === 2 && good.color === 'Brown',
    `slot=${good.slot} color=${good.color}`);

const badColor = await withClient(async (api, server) => {
    server.send(JSON.stringify({ t: 'welcome', slot: 1, color: { evil: true } }));
    await sleep(60);
    return api.color;
});
ok('welcome with a non-string color rejected', badColor === null, `color=${JSON.stringify(badColor)}`);

console.log('\n── the ping that could hang forever ─────────────────────────────');

// 3. The server never answers. This is the exact shape lobby.js awaits twelve
//    times between `launch` and bootDoom.
const pingResult = await withClient(async (api) => {
    const t0 = Date.now();
    const rtt = await Promise.race([api.ping(), sleep(5000).then(() => 'HUNG')]);
    return { rtt, waited: Date.now() - t0 };
});
ok(`an unanswered ping resolves instead of hanging (${pingResult.waited} ms)`, pingResult.rtt !== 'HUNG',
    'it never resolved — this is the wedge that leaves a "GO" countdown on screen forever');
ok('an unanswered ping resolves null, not a fabricated latency', pingResult.rtt === null,
    `got ${pingResult.rtt}`);
ok('it resolves promptly, not at some outer timeout', pingResult.waited < 4500,
    `waited ${pingResult.waited} ms`);

// 4. A ping the server DOES answer still measures.
const answered = await withClient(async (api, server) => {
    server.on('message', raw => {
        try { const m = JSON.parse(raw); if (m.t === 'ping') server.send(JSON.stringify({ t: 'pong', t0: m.t0 })); }
        catch { /* not our frame */ }
    });
    return await Promise.race([api.ping(), sleep(5000).then(() => 'HUNG')]);
});
ok('an answered ping still returns a latency', typeof answered === 'number' && answered >= 0,
    `got ${answered}`);

console.log('\n── sending on a dead socket ─────────────────────────────────────');

// 5. ws.send throws InvalidStateError after close; net.js's relay half already
//    checked readyState and the lobby half did not.
const beforeClose = uncaught.length;
const closeResult = await withClient(async (api) => {
    api.close();
    await sleep(150);
    // The pre-fix send() throws here, synchronously. A red that hangs is a
    // worse red than a red that reports, so name it rather than let it escape.
    try { return { value: api.send({ t: 'ping', t0: 0 }), threw: null }; }
    catch (e) { return { value: undefined, threw: String(e?.message ?? e) }; }
});
await sleep(60);
ok('send after close returns false instead of throwing',
    closeResult.threw === null && closeResult.value === false,
    closeResult.threw ? `it threw: ${closeResult.threw}` : `returned ${closeResult.value}`);
ok('send after close raised no unhandled error', uncaught.length === beforeClose,
    uncaught.slice(beforeClose).join('; '));

console.log('\n── roster / inprogress frames, read the way lobby.js reads them ──');

// THE GAP THIS CLOSES.  Everything above hardens net.js and stops there, so
// this file could report a clean bill of health while lobby.js's screen
// builders threw on the very next line.  They guarded the CONTAINER and not
// the MEMBER -- `roster?.players.find(...)` throws on `{"t":"roster"}` -- and
// that throw comes out of ws.onmessage, wedging the UI on CONNECTING with an
// empty status line.  Hardening one layer and testing that layer is how a
// dedicated hostile-input gate passes over a hostile-input bug.
//
// lobby.js cannot be imported here: it has no exports and runs a DOM IIFE at
// import.  So this replays its ACCESS PATTERNS against whatever net.js
// actually delivered -- which is the thing that has to hold.
//
// RED-PROOF: remove the roster/inprogress normalisation from net.js's
// onmessage and every case below reports the TypeError it threw.
const SHAPES = [
    ['no fields at all',        { t: 'roster' }],
    ['players missing',         { t: 'roster', freeSlots: [1], params: {} }],
    ['players is a string',     { t: 'roster', players: 'nope' }],
    ['players is an object',    { t: 'roster', players: { 0: { slot: 0 } } }],
    ['players holds nulls',     { t: 'roster', players: [null, 3, 'x'] }],
    ['params missing',          { t: 'roster', players: [] }],
    ['params is a string',      { t: 'roster', players: [], params: 'wad' }],
    ['freeSlots is a number',   { t: 'roster', players: [], freeSlots: 4 }],
    ['inprogress, no fields',   { t: 'inprogress' }],
    ['inprogress, params null', { t: 'inprogress', players: [], params: null }],
];
for (const [label, frame] of SHAPES) {
    const before = uncaught.length;
    let threwInBuilder = null;
    const got = await withClient(async (api, server) => {
        let seen = null;
        api.on('roster', m => { seen = m; }).on('inprogress', m => { seen = m; });
        server.send(JSON.stringify(frame));
        await sleep(60);
        if (!seen) return null;
        // Exactly what lobbyScreen() and inProgressScreen() do with it.
        try {
            void seen.players.find(pl => pl.slot === 0);
            void seen.players.map(pl => pl.name ?? pl.color);
            void seen.freeSlots.length;
            void [['coop', 'COOPERATIVE']].find(x => x[0] === seen.params.mode)?.[1];
            void seen.params.wad;
        } catch (e) { threwInBuilder = e; }
        return seen;
    });
    const threw = uncaught.slice(before);
    ok(`${label}: lobby.js's own reads do not throw`,
       got !== null && !threwInBuilder && threw.length === 0,
       got === null ? 'the frame was never delivered'
       : threwInBuilder ? `builder threw: ${threwInBuilder.message}`
       : `unhandled: ${threw.join('; ')}`);
}

// Anti-vacuity: a normaliser that dropped every frame would pass all ten above
// by never delivering one, and one that emptied every field would pass them by
// delivering nothing useful.  A well-formed frame must arrive intact.
{
    const good = { t: 'roster', players: [{ slot: 2, color: 'Brown', name: 'ZED' }],
                   freeSlots: [0, 1, 3], params: { wad: 'doom2.wad', mode: 'coop' } };
    const seen = await withClient(async (api, server) => {
        let got = null;
        api.on('roster', m => { got = m; });
        server.send(JSON.stringify(good));
        await sleep(60);
        return got;
    });
    ok('a well-formed roster survives normalisation intact',
       seen?.players?.[0]?.name === 'ZED' && seen.players.length === 1
       && seen.freeSlots.length === 3 && seen.params.wad === 'doom2.wad',
       `got ${JSON.stringify(seen)?.slice(0, 120)}`);
}

try { wss.close(); } catch { /* sockets already torn down */ }

// The two loops, plus the eight named assertions after them: a valid welcome, a
// non-string colour, three about the unanswered ping, an answered ping, and two
// about send-after-close. A floor, so a section that stops running is a red
// rather than a shorter list.
const NAMED_AFTER_LOOPS = 8 + 1;   // +1: the well-formed-roster anti-vacuity case
const EXPECTED = GARBAGE.length + BAD_SLOTS.length + SHAPES.length + NAMED_AFTER_LOOPS;
summaryPrinted = true;
console.log(`\n  ${passes} passed, ${failures} failed`);
if (passes + failures !== EXPECTED) {
    console.log(`FAIL — hostile-lobby-test: ${passes + failures} assertions ran, expected ${EXPECTED}`);
    process.exit(1);
}
if (failures) { console.log(`hostile-lobby-test: ${failures} failure(s)`); process.exit(1); }
console.log(`PASS — hostile-lobby-test: ${passes} assertions — ${GARBAGE.length} malformed frames, ` +
            `${BAD_SLOTS.length} hostile welcome slots, ${SHAPES.length} malformed rosters read as lobby.js reads them, ` +
            `the unanswered-ping wedge, and send-after-close`);
process.exit(0);
