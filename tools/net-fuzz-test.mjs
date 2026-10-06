#!/usr/bin/env node
// Net fuzz + abuse test suite: throws every adversarial input at the real
// server and verifies it survives (other clients unaffected, offending socket
// dropped, resource caps enforced). TDD: written before the hardening.
// usage: node tools/net-fuzz-test.mjs
import { AsyncLocalStorage } from 'node:async_hooks';
import { startServer } from './lib/server.mjs';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { root } from './lib/util.mjs';

const WebSocket = createRequire(join(root, 'server/game.js'))('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One server per suite (some suites spawn more), on a free port, ready when
// it answers -- never a fixed sleep and never a counter that an orphan from an
// earlier run could collide with.
async function spawnServer(extraEnv = {}) {
    let crashed = false, stderr = '';
    const s = await startServer({ env: extraEnv, onStderr: t => {
        stderr += t;
        // Real crashes produce a stack trace; ignore benign "server started" lines
        if (/Error:|at Object\.|at Module\.|UnhandledPromise/.test(t)) crashed = true;
    } });
    return { srv: s.proc, port: s.port, base: `ws://127.0.0.1:${s.port}`, kill: s.stop,
             didCrash: () => crashed, stderr: () => stderr };
}

const open = ws => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('open timeout')), 4000);
    ws.on('open', () => { clearTimeout(t); res(); });
    ws.on('error', e => { clearTimeout(t); rej(e); });
});
const openOrFail = ws => open(ws).catch(() => null);

// Record frames from the moment the socket exists.
//
// THE RACE THIS FIXES: the server sends `welcome` (or `inprogress`) the instant
// a lobby socket connects, but onceMsg() attached its listener only when it was
// CALLED, one or two microtasks after `await open(ws)` resolved.  A frame that
// arrived in that window was emitted to no listener and dropped forever, so the
// wait timed out against a server that had already answered.
//
// Instrumented 2026-09-11: with a listener attached at construction the probe
// logged `frames: welcome,roster` while onceMsg reported "no welcome within
// 2000ms" in the same run.  That is the whole of finding F1: 1-2 of 30 cases
// red on ~70-85% of runs, with the failing case wandering between lobby-JSON,
// binary-frame, lobby-churn, countdown and rate-flood.  A moving failing
// category looked like a server flake and was a harness bug.
function attachBuf(ws) {
    ws._buf = [];
    ws._waiters = [];
    ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        ws._buf.push(m);
        // Each arriving frame satisfies AT MOST ONE waiter, and a satisfied
        // frame leaves the buffer.  Resolving from the buffer while also
        // leaving it there would let a later wait match the same frame again,
        // which is a false pass in a different direction.
        for (let i = 0; i < ws._waiters.length; i++) {
            const w = ws._waiters[i];
            const j = ws._buf.findIndex(w.pred);
            if (j >= 0) {
                const hit = ws._buf.splice(j, 1)[0];
                ws._waiters.splice(i, 1); i--;
                w.resolve(hit);
            }
        }
    });
    return ws;
}
function lobbyWs(base) { return attachBuf(new WebSocket(base + '/ws/lobby')); }
// /ws/game binds a slot only with that seat's token, from the `launch` frame
// its lobby socket was sent; `token` undefined leaves the parameter out.
const gamePath = (slot, token) =>
    `/ws/game?slot=${slot}${token === undefined ? '' : `&token=${encodeURIComponent(token)}`}`;
function gameWs(base, slot, token) { return attachBuf(new WebSocket(base + gamePath(slot, token))); }

function onceMsg(ws, pred, timeout = 3000) {
    if (!ws._buf) attachBuf(ws);          // any socket, however constructed
    const i = ws._buf.findIndex(pred);
    if (i >= 0) return Promise.resolve(ws._buf.splice(i, 1)[0]);
    return new Promise((res, rej) => {
        const w = { pred, resolve: null };
        const t = setTimeout(() => {
            const k = ws._waiters.indexOf(w);
            if (k >= 0) ws._waiters.splice(k, 1);
            rej(new Error('msg timeout'));
        }, timeout);
        w.resolve = m => { clearTimeout(t); res(m); };
        ws._waiters.push(w);
    });
}

// Starts a minimal 1-player session so there's a "good client" to check
// server health against after each attack. The countdown runs for 3 seconds;
// use a 6s timeout so the 3s event loop never races the default 3s window.
// Returns getTics() which counts sealed tic bundles received from the server —
// used to prove the in-progress game keeps running during each attack surface.
async function startSession(base) {
    const lob = lobbyWs(base);
    await open(lob);
    await onceMsg(lob, m => m.t === 'welcome');
    lob.send(JSON.stringify({ t: 'start' }));
    const launch = await onceMsg(lob, m => m.t === 'launch', 6000);
    const g = gameWs(base, 0, launch.token);
    g.binaryType = 'nodebuffer';
    await open(g);
    let ticsSeen = 0;
    g.on('message', () => ticsSeen++);  // sealed tic bundles sent back by server
    let tic = 0, stopped = false;
    const loop = () => {
        if (stopped) return;
        const b = Buffer.alloc(12); b.writeUInt32LE(tic++, 0);
        if (g.readyState === 1) g.send(b);
        setTimeout(loop, 28);
    };
    loop();
    return {
        lob, g, token: launch.token,
        stop() { stopped = true; try { g.close(); } catch {} try { lob.close(); } catch {} },
        getTics: () => ticsSeen,
    };
}

// An observer of a live game that asks to drop in.  The server answers with
// the reserved slot (welcome) and that seat's token (launch), which is what
// lets a socket onto /ws/game at all -- so an attack on the relay's frame
// handling has to come from a reserved seat, or it only meets the refusal.
async function reserve(base, slot) {
    const lob = lobbyWs(base);
    await open(lob);
    await onceMsg(lob, m => m.t === 'inprogress', 3000);
    lob.send(JSON.stringify({ t: 'join', ...(slot === undefined ? {} : { slot }) }));
    const w = await onceMsg(lob, m => m.t === 'welcome' || m.t === 'full', 3000);
    if (w.t === 'full') throw new Error(`reserve: ${w.reason}`);
    const l = await onceMsg(lob, m => m.t === 'launch', 3000);
    return { lob, slot: w.slot, token: l.token };
}

// One /ws/game socket, watched for `ms`: refused means closed with no frame.
async function probeGame(base, slot, token, ms = 400) {
    const ws = new WebSocket(base + gamePath(slot, token));
    ws.binaryType = 'nodebuffer';
    let frames = 0, closed = false;
    ws.on('message', () => frames++);
    ws.on('close', () => { closed = true; });
    ws.on('error', () => {});
    await open(ws).catch(() => {});
    await sleep(ms);
    return { ws, frames, closed, refused: closed && frames === 0,
             said: `closed=${closed} frames=${frames}` };
}

// Verify server is still accepting new lobby connections (health check).
async function serverAlive(base) {
    try {
        const ws = lobbyWs(base);
        await open(ws);
        await onceMsg(ws, m => m.t === 'welcome' || m.t === 'inprogress' || m.t === 'full', 2000);
        ws.close();
        return true;
    } catch { return false; }
}

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};

// ── SURFACE 1: Malformed lobby JSON ──────────────────────────────────────────

async function fuzzLobbyJSON() {
    const s = await spawnServer();
    const host = await startSession(s.base).catch(() => null);

    const attacks = [
        // non-JSON bytes
        Buffer.from('\xff\xfe\x00\x01'),
        // truncated JSON
        '{"t":"name"',
        // valid JSON wrong shape
        '{"t":42}',
        // huge string in name field (1 MB)
        JSON.stringify({ t: 'name', name: 'x'.repeat(1_000_000) }),
        // deeply nested object
        JSON.stringify({ t: 'params', params: JSON.parse('{"a":'.repeat(200) + '1' + '}'.repeat(200)) }),
        // null in required field
        JSON.stringify({ t: 'name', name: null }),
        // unknown t type
        JSON.stringify({ t: 'EVIL_UNKNOWN_TYPE', payload: 'x'.repeat(50000) }),
        // duplicate slot claim
        JSON.stringify({ t: 'slot', slot: 0 }),
        // negative slot
        JSON.stringify({ t: 'slot', slot: -99 }),
        // OOB slot
        JSON.stringify({ t: 'slot', slot: 9999 }),
        // unicode/control chars in name
        JSON.stringify({ t: 'name', name: ' ￿​' }),
        // start before enough players (solo is ok, but start in wrong state)
        JSON.stringify({ t: 'start' }),
        // params after launch (send start, then params — wrong state)
        // (tested via the host session's websocket below)
    ];

    // Connect an attacker to the lobby
    const ticsBefore = host?.getTics() ?? -1;
    for (const payload of attacks) {
        try {
            const ws = lobbyWs(s.base);
            await open(ws);
            ws.send(payload);
            await sleep(60);
            ws.close();
        } catch { /* attacker socket failure is fine */ }
    }

    // params after launch: connect to the in-progress game lobby as a viewer
    // and send params (should be ignored — game is live)
    try {
        const ws = lobbyWs(s.base);
        await open(ws);
        await onceMsg(ws, m => m.t === 'inprogress' || m.t === 'welcome', 1500);
        ws.send(JSON.stringify({ t: 'params', params: { wad: '../../../etc/passwd', episode: 999 } }));
        await sleep(100);
        ws.close();
    } catch {}

    await sleep(200);
    const ticsAfter = host?.getTics() ?? -1;
    const alive = await serverAlive(s.base);
    const crashed = s.didCrash();
    check('lobby JSON fuzz: server survives', alive && !crashed,
        `alive=${alive} crashed=${crashed}`);
    check('lobby JSON fuzz: in-progress game kept receiving tic bundles',
        !host || ticsAfter > ticsBefore,
        `host ticsSeen: before=${ticsBefore} after=${ticsAfter}`);

    host?.stop(); s.kill();
}

// ── SURFACE 2: Binary tic frame abuse ─────────────────────────────────────────

async function fuzzBinaryFrames() {
    const s = await spawnServer();
    const host = await startSession(s.base).catch(() => null);
    await sleep(300);

    // Frames on the lobby channel (channel confusion: send binary to /ws/lobby)
    const ticsBefore = host?.getTics() ?? -1;
    try {
        const ws = lobbyWs(s.base);
        await open(ws);
        await onceMsg(ws, m => m.t === 'inprogress' || m.t === 'welcome', 1500);
        ws.send(Buffer.alloc(12));                    // binary on JSON channel
        ws.send(Buffer.alloc(64));                    // oversized binary on JSON channel
        await sleep(100);
        ws.close();
    } catch {}

    // Game channel attacks from a drop-in that reserved slot 1, so every frame
    // below reaches the relay's message handler; a socket with no seat token is
    // refused before it has one.
    let held = false;
    try {
        const seat = await reserve(s.base, 1);
        const ws = gameWs(s.base, 1, seat.token);
        ws.binaryType = 'nodebuffer';
        const first = new Promise(res => { ws.once('message', () => res(true)); setTimeout(() => res(false), 1500); });
        await open(ws);
        held = await first;
        // Truncated frame (< 12 bytes)
        ws.send(Buffer.alloc(4));
        ws.send(Buffer.alloc(8));
        ws.send(Buffer.alloc(11));
        // Oversized frame (> 12 bytes)
        ws.send(Buffer.alloc(64));
        ws.send(Buffer.alloc(65536));
        // Wrong tic number: past
        const past = Buffer.alloc(12); past.writeUInt32LE(0xFFFFFFFF, 0); ws.send(past);
        // Future out-of-window tic (> tic + 512)
        const future = Buffer.alloc(12); future.writeUInt32LE(99999, 0); ws.send(future);
        // u32 overflow
        const overflow = Buffer.alloc(12); overflow.writeUInt32LE(0, 0); ws.send(overflow);
        // JSON on game channel
        ws.send(JSON.stringify({ t: 'start' }));
        // Flood the same tic
        for (let i = 0; i < 200; i++) {
            const b = Buffer.alloc(12); b.writeUInt32LE(5, 0); ws.send(b);
        }
        await sleep(200);
        ws.close();
        seat.lob.close();
    } catch {}
    check('binary frame fuzz: the abusive socket held a seat (its frames reached the relay)', held,
        `served before the attack: ${held}`);

    // Frame before launch (connect before game started — not applicable here
    // since host already launched; test a fresh solo lobby instead)
    {
        const s2 = await spawnServer();
        try {
            const lob = lobbyWs(s2.base);
            await open(lob);
            await onceMsg(lob, m => m.t === 'welcome');
            // Don't start — connect game WS immediately (no session active)
            const g = gameWs(s2.base, 0);
            g.binaryType = 'nodebuffer';
            // Should be immediately closed (no session)
            await sleep(200);
            const open2 = g.readyState === 1;
            // We expect it to be closed (server has no session)
            g.close(); lob.close();
        } catch {}
        await sleep(100);
        const alive2 = await serverAlive(s2.base);
        check('game WS before launch: server survives', alive2, `alive=${alive2}`);
        s2.kill();
    }

    await sleep(300);
    const ticsAfter = host?.getTics() ?? -1;
    const alive = await serverAlive(s.base);
    const crashed = s.didCrash();
    check('binary frame fuzz: server survives', alive && !crashed,
        `alive=${alive} crashed=${crashed}`);
    check('binary frame fuzz: in-progress game kept receiving tic bundles',
        !host || ticsAfter > ticsBefore,
        `host ticsSeen: before=${ticsBefore} after=${ticsAfter}`);

    host?.stop(); s.kill();
}

// ── SURFACE 3: Slot spoofing / identity ───────────────────────────────────────

async function fuzzSlotSpoofing() {
    const s = await spawnServer();
    const host = await startSession(s.base).catch(() => null);
    await sleep(200);

    // Connect to /ws/game with slot that's already occupied (host is slot 0).
    // Server uses terminate() for rejected slots so the client gets an error
    // event nearly immediately instead of waiting for close-frame round-trip.
    // startSession is required for this check: if it failed, the guard never
    // ran and the test is meaningless — hard-fail rather than silently pass.
    if (!host) {
        check('slot spoof (occupied slot): connection rejected', false,
            'FAIL: startSession did not complete — slot-spoof guard never exercised');
    } else {
        // with the seat's own token, so the occupancy guard is what refuses it
        const ws = gameWs(s.base, 0, host.token);
        ws.binaryType = 'nodebuffer';
        let ejected = false;
        ws.on('error', () => { ejected = true; });
        ws.on('close', () => { ejected = true; });
        const connected = await open(ws).then(() => true).catch(() => { ejected = true; return false; });
        // Server terminate() arrives within a few event-loop ticks on loopback
        await sleep(400);
        const stillOpen = ws.readyState === 1;
        try { ws.terminate(); } catch {}
        check('slot spoof (occupied slot): connection rejected', !stillOpen || !connected || ejected,
            `connected=${connected} stillOpen=${stillOpen} ejected=${ejected}`);
    }

    // Out-of-range slot param
    const oobCases = [-1, 4, 99, 'abc', '', 'undefined', '0; DROP TABLE'];
    for (const slot of oobCases) {
        try {
            const ws = attachBuf(new WebSocket(s.base + `/ws/game?slot=${slot}`));
            ws.binaryType = 'nodebuffer';
            await open(ws).catch(() => null);
            await sleep(100);
            ws.close();
        } catch {}
    }

    // Connect to /ws/game without having gone through the lobby: a free slot,
    // no seat token
    {
        const p = await probeGame(s.base, 2, undefined);
        check('slot spoof (no lobby seat): connection refused', p.refused, p.said);
        p.ws.close();
    }

    // Connect during countdown (start a new server, start a game, probe during countdown)
    {
        const s3 = await spawnServer();
        try {
            const lob = lobbyWs(s3.base);
            await open(lob);
            await onceMsg(lob, m => m.t === 'welcome');
            lob.send(JSON.stringify({ t: 'start' }));
            await onceMsg(lob, m => m.t === 'countdown');
            // During countdown, try to connect game ws
            const g = gameWs(s3.base, 0);
            g.binaryType = 'nodebuffer';
            await open(g).catch(() => null);
            await sleep(100);
            g.close(); lob.close();
        } catch {}
        await sleep(200);
        const alive3 = await serverAlive(s3.base);
        check('connect during countdown: server survives', alive3, `alive=${alive3}`);
        s3.kill();
    }

    await sleep(300);
    const slotTicsAfter = host?.getTics() ?? -1;
    const alive = await serverAlive(s.base);
    const crashed = s.didCrash();
    check('slot spoofing: server survives', alive && !crashed,
        `alive=${alive} crashed=${crashed}`);
    check('slot spoofing: in-progress game kept receiving tic bundles',
        !host || slotTicsAfter > 0,
        `host ticsSeen=${slotTicsAfter}`);

    host?.stop(); s.kill();
}

// ── SURFACE 4: Rejoin/drop-in races ──────────────────────────────────────────

async function fuzzRaces() {
    // Double-connect the same slot simultaneously
    {
        const s = await spawnServer();
        const host = await startSession(s.base).catch(() => null);
        await sleep(200);

        // both carry the reservation's token, so only occupancy separates them
        const seat = await reserve(s.base, 1).catch(() => null);
        const [ws1, ws2] = [gameWs(s.base, 1, seat?.token), gameWs(s.base, 1, seat?.token)];
        ws1.binaryType = 'nodebuffer'; ws2.binaryType = 'nodebuffer';
        await Promise.allSettled([open(ws1), open(ws2)]);
        await sleep(150);
        const holding = [ws1, ws2].filter(w => w.readyState === 1).length;
        check('double-connect same slot: exactly one socket holds it', holding === 1,
            `${holding} of 2 open (reserved: ${!!seat})`);
        ws1.close(); ws2.close();

        await sleep(200);
        const alive = await serverAlive(s.base);
        check('double-connect same slot: server survives', alive, `alive=${alive}`);
        seat?.lob.close(); host?.stop(); s.kill();
    }

    // Rapid connect/disconnect churn on lobby
    {
        const s = await spawnServer();
        const tasks = [];
        for (let i = 0; i < 30; i++) {
            tasks.push((async () => {
                try {
                    const ws = lobbyWs(s.base);
                    await open(ws);
                    await sleep(Math.random() * 50);
                    ws.close();
                } catch {}
            })());
        }
        await Promise.allSettled(tasks);
        await sleep(300);
        const alive = await serverAlive(s.base);
        check('rapid lobby churn (30 connect/disconnect): server survives', alive, `alive=${alive}`);
        s.kill();
    }
}

// ── SURFACE 5: Resource exhaustion / caps ─────────────────────────────────────

async function fuzzResourceCaps() {
    // Connection cap: open many connections and verify server enforces a limit.
    // The server terminates excess connections after the WebSocket handshake,
    // so open() may resolve (handshake done) before terminate() fires. We
    // check readyState after a brief settle period rather than counting open()
    // failures — readyState 3 (CLOSED) means the server terminated the socket.
    {
        const s = await spawnServer();
        const conns = [];
        for (let i = 0; i < 60; i++) {
            const ws = lobbyWs(s.base);
            await open(ws).catch(() => {});
            conns.push(ws);
        }
        // Allow server to process all accept/terminate decisions + close events
        await sleep(500);
        const openCount = conns.filter(w => w.readyState === 1).length;
        // Server must still be alive (excess connections were terminated, not crashed)
        const alive = await serverAlive(s.base);
        check('connection flood: server survives', alive,
            `alive=${alive} openCount=${openCount}`);
        // With MAX_CONNS=50, at most 50 connections stay open (excess are terminated)
        check('connection cap: excess connections terminated',
            openCount <= 50,
            `openCount=${openCount} (cap=50)`);
        conns.forEach(w => { try { w.terminate(); } catch {} });
        s.kill();
    }

    // Message rate flood on lobby: single client sends 5000 messages rapidly
    {
        const s = await spawnServer();
        try {
            const ws = lobbyWs(s.base);
            await open(ws);
            await onceMsg(ws, m => m.t === 'welcome' || m.t === 'inprogress', 2000);
            // Flood 5000 messages
            for (let i = 0; i < 5000; i++) {
                ws.send(JSON.stringify({ t: 'ping', t0: i }));
            }
            await sleep(300);
            ws.close();
        } catch {}
        await sleep(300);
        const alive = await serverAlive(s.base);
        const crashed = s.didCrash();
        check('msg rate flood (5000 msg burst): server survives', alive && !crashed,
            `alive=${alive} crashed=${crashed}`);
        s.kill();
    }

    // Oversized single lobby message (should be rejected by maxPayload)
    {
        const s = await spawnServer();
        let disconnected = false;
        try {
            const ws = lobbyWs(s.base);
            await open(ws);
            await onceMsg(ws, m => m.t === 'welcome' || m.t === 'inprogress', 2000);
            ws.on('close', () => { disconnected = true; });
            // Send 2 MB message — exceeds maxPayload: 1024
            ws.send(Buffer.alloc(2 * 1024 * 1024));
            await sleep(400);
        } catch { disconnected = true; }
        const alive = await serverAlive(s.base);
        check('oversized lobby msg (2MB): attacker socket closed', disconnected,
            `disconnected=${disconnected}`);
        check('oversized lobby msg: server stays alive', alive, `alive=${alive}`);
        s.kill();
    }

    // Slowloris on game channel: connect game ws, send partial frame, never complete
    {
        const s = await spawnServer();
        const host = await startSession(s.base).catch(() => null);
        await sleep(200);
        // Don't use game WS — connect a raw socket that never sends anything
        // (the ws library handles this at TCP level; server shouldn't hang)
        let seat = null;
        try {
            seat = await reserve(s.base, 1);
            const ws = gameWs(s.base, 1, seat.token);
            ws.binaryType = 'nodebuffer';
            await open(ws).catch(() => null);
            // Intentionally never send anything — idle slowloris
            await sleep(800);
            ws.close();
        } catch {}
        seat?.lob.close();
        await sleep(200);
        const alive = await serverAlive(s.base);
        check('game WS idle (slowloris-style): server survives', alive, `alive=${alive}`);
        host?.stop(); s.kill();
    }

    // maxPayload on game channel: send oversized binary to /ws/game
    {
        const s = await spawnServer();
        const host = await startSession(s.base).catch(() => null);
        await sleep(200);
        let disconnected = false, held = false, seat = null;
        try {
            // a reserved seat, so it is maxPayload that closes it and not the
            // seat-token refusal
            seat = await reserve(s.base, 1);
            const ws = gameWs(s.base, 1, seat.token);
            ws.binaryType = 'nodebuffer';
            const first = new Promise(res => { ws.once('message', () => res(true)); setTimeout(() => res(false), 1500); });
            await open(ws).catch(() => null);
            held = await first && ws.readyState === 1;
            ws.on('close', () => { disconnected = true; });
            // Send 1 MB on game channel — exceeds maxPayload: 64
            ws.send(Buffer.alloc(1024 * 1024));
            await sleep(400);
        } catch { disconnected = true; }
        seat?.lob.close();
        const alive = await serverAlive(s.base);
        check('oversized game frame (1MB): attacker socket closed', disconnected && held,
            `disconnected=${disconnected}, held a seat first: ${held}`);
        check('oversized game frame: server stays alive', alive, `alive=${alive}`);
        host?.stop(); s.kill();
    }
}

// ── SURFACE 6: Malformed HTTP upgrade URL ────────────────────────────────────
//
// Pre-fix crash vector: upgrade() called `new URL(req.url, 'http://x')` with no
// try/catch. If req.url contains characters the WHATWG URL constructor rejects
// (raw control chars that some versions of llhttp pass through), the constructor
// throws TypeError → uncaught exception → process crash. We send these via a
// raw TCP socket because the ws library sanitises URLs before connecting.

async function fuzzUpgradeURL() {
    const s = await spawnServer();

    // Sends a crafted HTTP upgrade request at the TCP level and waits for any
    // server response (or a 600ms timeout). The important thing is the server
    // doesn't crash regardless of how it handles the bad input.
    const rawUpgrade = (port, urlPath) => new Promise(resolve => {
        const sock = createConnection(port, '127.0.0.1');
        const timer = setTimeout(() => { try { sock.destroy(); } catch {} resolve(); }, 600);
        sock.on('connect', () => {
            // Embed the path bytes verbatim so null bytes / control chars
            // reach the server's HTTP parser exactly as sent.
            const req = Buffer.from(
                `GET ${urlPath} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${port}\r\n` +
                `Upgrade: websocket\r\n` +
                `Connection: Upgrade\r\n` +
                `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
                `Sec-WebSocket-Version: 13\r\n\r\n`
            );
            sock.write(req);
        });
        sock.on('data', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.on('error', () => { clearTimeout(timer); resolve(); });
        sock.on('close', () => { clearTimeout(timer); resolve(); });
    });

    const malformedPaths = [
        `/ws/lobby\x00null-byte`,          // null byte — WHATWG URL ctor throws pre-fix
        `/ws/lobby\x07bel-char`,           // ASCII BEL (control char)
        `/ws/game?slot=\x00evil`,          // null byte in query param
        `\x00\x01\x02\x03`,              // raw control bytes as entire path
        `/ws/lobby\x1F\x7F`,              // unit-separator + DEL
        `/ws/game\x0Ainjected-newline`,   // LF injection attempt
    ];

    for (const path of malformedPaths) {
        await rawUpgrade(s.port, path);
    }

    await sleep(300);
    const alive = await serverAlive(s.base);
    const crashed = s.didCrash();
    check('malformed upgrade URL: server survives (not crashed by URL ctor throw)',
        alive && !crashed,
        `alive=${alive} crashed=${crashed}`);
    s.kill();
}

// ── SURFACE 7: Demo store endpoint ────────────────────────────────────────────
// Fuzz the new POST /api/demos and GET /api/demos/:id endpoints while a live
// game session is running, to verify the server survives adversarial HTTP.

async function fuzzDemoEndpoint() {
    const { PER_DEMO_CAP } = await import(join(root, 'server/demo-store.js'));

    const s = await spawnServer();
    const host = await startSession(s.base).catch(() => null);

    // Helper: raw HTTP request through node:http
    const { request: httpReq } = await import('node:http');
    function rawHttp(method, path, body) {
        return new Promise((resolve, reject) => {
            const opts = {
                method, hostname: '127.0.0.1', port: s.port, path,
                headers: body ? { 'content-length': body.length } : {},
            };
            const r = httpReq(opts, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode,
                    body: Buffer.concat(chunks), headers: res.headers }));
            });
            r.on('error', reject);
            if (body) r.write(body);
            r.end();
        });
    }

    // (a) Oversize upload → 413  (caps red proof)
    const oversize = Buffer.alloc(PER_DEMO_CAP + 1, 0xab);
    const r413 = await rawHttp('POST', '/api/demos', oversize).catch(() => ({ status: 0 }));
    check(`demo POST cap+1 byte → 413 (cap=${PER_DEMO_CAP})`, r413.status === 413,
        `status=${r413.status}`);

    // (b) Exactly PER_DEMO_CAP bytes → 201
    const atCap = Buffer.alloc(PER_DEMO_CAP, 0x00);
    atCap[0] = 110;  // version byte (makes it look like a plausible demo)
    const r201 = await rawHttp('POST', '/api/demos', atCap).catch(() => ({ status: 0 }));
    check(`demo POST exactly cap → 201`, r201.status === 201, `status=${r201.status}`);

    // (c) Path traversal in id → 400
    for (const bad of [
        '/api/demos/../../../etc/passwd',
        '/api/demos/not-hex',
        '/api/demos/' + 'Z'.repeat(64),          // uppercase (invalid hex)
        '/api/demos/' + 'a'.repeat(63),           // too short
    ]) {
        const rb = await rawHttp('GET', bad).catch(() => ({ status: 0 }));
        check(`demo GET bad id "${bad.slice(0, 35)}…" → 400 or 404`,
            rb.status === 400 || rb.status === 404,
            `status=${rb.status}`);
    }

    // (d) Happy path: small upload + download while game is live
    const small = Buffer.from([110, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0x80]);
    const rUp = await rawHttp('POST', '/api/demos?wad=doom.wad', small).catch(() => ({ status: 0 }));
    check('demo POST small demo while game live → 201', rUp.status === 201, `status=${rUp.status}`);
    if (rUp.status === 201) {
        let j; try { j = JSON.parse(rUp.body); } catch { j = {}; }
        if (/^[0-9a-f]{64}$/.test(j.id)) {
            const rDl = await rawHttp('GET', `/api/demos/${j.id}`).catch(() => ({ status: 0 }));
            check('demo GET by id while game live → 200', rDl.status === 200, `status=${rDl.status}`);
            check('demo GET x-demo-wad header', rDl.headers?.['x-demo-wad'] === 'doom.wad',
                `header=${rDl.headers?.['x-demo-wad']}`);
        }
    }

    // (e) Server and in-progress game survive all attacks
    await sleep(200);
    const alive = await serverAlive(s.base);
    const crashed = s.didCrash();
    check('demo fuzz: server survives', alive && !crashed, `alive=${alive} crashed=${crashed}`);
    host?.stop(); s.kill();
}

// ── SURFACE 8: Session history cap ───────────────────────────────────────────
// session.history holds one sealed bundle per tic for the life of the session,
// because drop-in and spectator catch-up replay it FROM TIC 0.  Dropping the
// head would hand a joiner a prefix-less stream and desync it with nothing to
// notice, so the cap stops the history growing and the two features that read
// it refuse past that point.
//
// Every refusal arm here carries a CONTROL taken on the same server, below the
// cap.  Without one, a spectate endpoint that was simply broken -- or a slot
// rejected for some unrelated reason -- would look exactly like "correctly
// refused", and this whole surface would pass by not working.  Sessions are
// always MAXPLAYERS wide (game.js:230), so slots 1 and 2 are both valid and
// unoccupied; the arms use one each so neither can answer for the other.
async function fuzzHistoryCap() {
    const CAP = 40;
    const s = await spawnServer({ WEBDOOM_MAX_HISTORY_TICS: String(CAP) });
    const host = await startSession(s.base).catch(() => null);
    if (!host) { check('history cap: session started', false, 'startSession failed'); s.kill(); return; }

    const raw = url => { const w = new WebSocket(s.base + url); w.binaryType = 'nodebuffer'; return w; };
    const frames = w => { let n = 0; w.on('message', () => n++); return () => n; };

    // CONTROLS, below the cap: both features work at all.  Each drop-in has a
    // reservation, so a refusal can only be the cap's.
    const r1 = await reserve(s.base, 1).catch(() => null);
    const cSpec = raw('/ws/spectate'), cSpecN = frames(cSpec);
    const cJoin = raw(gamePath(1, r1?.token)), cJoinN = frames(cJoin);
    await open(cSpec).catch(() => {});
    await open(cJoin).catch(() => {});
    await sleep(400);
    check('history cap CONTROL: spectate below the cap is served', cSpecN() > 0, `frames=${cSpecN()}`);
    check('history cap CONTROL: drop-in below the cap is served', cJoinN() > 0, `frames=${cJoinN()}`);
    try { cSpec.terminate(); } catch {}
    try { cJoin.terminate(); } catch {}

    // Drive past the cap.
    let waited = 0;
    while (host.getTics() < CAP + 15 && waited < 8000) { await sleep(100); waited += 100; }
    const tics = host.getTics();
    check('history cap: session ran past the cap', tics > CAP, `tics=${tics} cap=${CAP}`);

    const r2 = await reserve(s.base, 2).catch(() => null);
    check('history cap: drop-in past the cap still gets a reservation (the relay is what refuses)', !!r2?.token,
        `token=${r2?.token}`);
    const lSpec = raw('/ws/spectate'), lSpecN = frames(lSpec);
    const lJoin = raw(gamePath(2, r2?.token)), lJoinN = frames(lJoin);
    await open(lSpec).catch(() => {});
    await open(lJoin).catch(() => {});
    await sleep(600);
    check('history cap: spectate past the cap is refused, not served a prefix',
        lSpecN() === 0 && lSpec.readyState === 3,
        `frames=${lSpecN()} readyState=${lSpec.readyState}`);
    check('history cap: drop-in past the cap is refused, not served a prefix',
        lJoinN() === 0 && lJoin.readyState === 3,
        `frames=${lJoinN()} readyState=${lJoin.readyState}`);
    try { lSpec.terminate(); } catch {}
    try { lJoin.terminate(); } catch {}

    // The cap closes catch-up, not the game: the host keeps receiving bundles.
    const before = host.getTics();
    await sleep(500);
    check('history cap: live play continues past the cap', host.getTics() > before,
        `${before} -> ${host.getTics()} tics`);

    const alive = await serverAlive(s.base);
    check('history cap: server survives', alive && !s.didCrash(),
        `alive=${alive} crashed=${s.didCrash()}`);
    r1?.lob.close(); r2?.lob.close();
    host.stop(); s.kill();
}

// ── SURFACE 9: the lobby's `wad` param vs the library this server serves ─────
// params.wad was character-sanitised and never checked against the manifest,
// and the accepted value is cast to every client in the `launch` frame -- so
// one lobby member could steer the whole table into a WAD nobody has, which
// each client then hit as a TypeError inside bootDoom.  CONTROL first: a WAD
// this server DOES serve must still be accepted, or "refused" would just mean
// "the param path is broken".
async function fuzzWadParam() {
    const s = await spawnServer();
    const ws = lobbyWs(s.base);
    await open(ws);
    await onceMsg(ws, m => m.t === 'welcome' || m.t === 'inprogress', 2000);

    // The lobby casts a roster on JOIN.  Consume it before asking anything, or
    // every read is one frame behind -- which showed up as the control failing
    // while the arms it exists to validate passed, and an off-by-one in a test
    // reads exactly like a defect in the thing under test.
    await onceMsg(ws, m => m.t === 'roster', 2000).catch(() => null);
    const setWad = async wad => {
        ws._buf.length = 0;
        ws.send(JSON.stringify({ t: 'params', params: { wad } }));
        const r = await onceMsg(ws, m => m.t === 'roster', 2000).catch(() => null);
        return r?.params?.wad ?? null;
    };

    // ASK THE SERVER what it serves, rather than reading the manifest this test
    // happens to sit next to.  /api/wads is the same source createGame
    // validates against, so the two cannot disagree -- and it makes the
    // no-library case a REAL state to test rather than a reason to bail.
    const SERVED = await (async () => {
        try {
            const r = await fetch(`http://127.0.0.1:${new URL(s.base).port}/api/wads`,
                                  { signal: AbortSignal.timeout(4000) });
            if (!r.ok) return [];
            return ((await r.json()).wads ?? []).map(w => w.file).filter(Boolean);
        } catch { return []; }
    })();

    const HOSTILE = ['nope.wad', '../../etc/passwd', 'doom.wad\u0000', 'DOOM.WAD', '', '.', '..'];

    if (SERVED.length < 2) {
        // A HOST WITH NO WAD LIBRARY IS AN EXPECTED STATE, not a broken one:
        // game data is not distributable, so CI's public runner has none and
        // ci.yml says so.  This used to FAIL here, which turned a documented
        // condition into a red on every CI run.
        //
        // It is not a skip either.  With an unreadable or empty library
        // servedWads() returns [] and the lobby must refuse EVERY wad change,
        // keeping defaultParams().wad -- the fail-closed default this round
        // deliberately chose over "accept anything when we cannot tell".  That
        // is testable with no WADs at all, and it is the arm most worth having,
        // because it is the branch a host with a library never takes.
        const base = await setWad('doom2.wad');
        check('no library: even a plausible WAD name is refused (fail-closed default)',
            base === 'doom.wad', `params.wad = ${JSON.stringify(base)} (expected the default)`);
        for (const bad of HOSTILE) {
            const got = await setWad(bad);
            check(`no library: params.wad holds the default after ${JSON.stringify(bad)}`,
                got === 'doom.wad', `params.wad = ${JSON.stringify(got)}`);
        }
        console.log(`  note: /api/wads served ${SERVED.length} wad(s) on this host, so the `
                  + 'ACCEPT half (a served name is honoured) was NOT checked here');
        const aliveNoLib = await serverAlive(s.base);
        check('wad param: server survives', aliveNoLib && !s.didCrash(),
            `alive=${aliveNoLib} crashed=${s.didCrash()}`);
        try { ws.close(); } catch {}
        s.kill();
        return;
    }

    const first = SERVED.includes('doom2.wad') ? 'doom2.wad' : SERVED.find(w => w !== 'doom.wad');
    const second = SERVED.includes('tnt.wad') ? 'tnt.wad'
                 : SERVED.find(w => w !== first && w !== 'doom.wad');
    check('CONTROL: a WAD this server serves is accepted',
        await setWad(first) === first, `library has ${SERVED.length} wads; used ${first}`);

    // The invariant, stated as one: whatever lands in params.wad is a WAD this
    // server actually serves.  That is what the clients are handed in `launch`.
    // ('doom.wad\u0000' sanitises to a REAL name and is correctly accepted --
    //  asserting "refused" there would have graded the sanitiser, not this.)
    for (const bad of HOSTILE) {
        const got = await setWad(bad);
        check(`params.wad stays a served WAD after ${JSON.stringify(bad)}`,
            SERVED.includes(got), `params.wad = ${JSON.stringify(got)}`);
    }

    check('CONTROL: the lobby still works afterwards',
        await setWad(second) === second, String(second));
    try { ws.close(); } catch {}
    const alive = await serverAlive(s.base);
    check('wad param: server survives', alive && !s.didCrash(), `alive=${alive} crashed=${s.didCrash()}`);
    s.kill();
}

// ── SURFACE 10: an IN-GAME peer cannot stall the seal ────────────────────────
//
// Every other suite in this file attacks from a socket that is not ingame, so
// the laggard set in sealSweep never contains the attacker and the grace/drop
// logic is never exercised by an attack.  That is exactly the hole this suite
// closes, and it is why nine green suites sat on top of a total-denial bug.
//
// The bug: server/game.js refreshed `p.lastSeen` BEFORE validating the tic, so
// a player sending 12-byte frames with an out-of-range tic was permanently a
// laggard (it never populated p.cmds) while never being past GRACE_MS or
// DROP_MS.  sealSweep returned at the grace check on every 50 ms pass and
// session.tic stopped advancing for every player, with no drop and no log line.
//
// Red-proof: revert `p.lastSeen = Date.now()` to above the range check and the
// first case reads 0 bundles instead of dozens.
//
// An in-range frame is no better if it leaves the current tic empty.  The
// other two variants play honestly, then skip the tic they owe and send one
// further ahead, forever: the one just past it, and the far edge of the
// 512-tic window.  Each frame is accepted and stored, and the seal waits on
// the one tic that never comes -- so lastSeen has to follow the cmd the seal
// needs, not any accepted frame.
const STALL_VARIANTS = {
    'out-of-range tic': { honestMs: 0,    evilTic: () => 0xFFFFFFFF },
    'owed tic + 1':     { honestMs: 1500, evilTic: owed => owed + 1 },
    'owed tic + 512':   { honestMs: 1500, evilTic: owed => owed + 512 },
};
async function fuzzIngameStall(variant) {
    const { honestMs, evilTic } = STALL_VARIANTS[variant];
    const s = await spawnServer();

    // Two lobby seats, so the hostile peer is a real in-game player rather than
    // a bystander.  Slots come from the server's own welcome frames.
    const lobA = lobbyWs(s.base); await open(lobA);
    const wa = await onceMsg(lobA, m => m.t === 'welcome');
    const lobB = lobbyWs(s.base); await open(lobB);
    const wb = await onceMsg(lobB, m => m.t === 'welcome');
    const slotA = wa.slot ?? 0, slotB = wb.slot ?? 1;
    check(`ingame stall (${variant}): two distinct seats`, slotA !== slotB, `slots ${slotA} and ${slotB}`);

    lobA.send(JSON.stringify({ t: 'start' }));
    const la = await onceMsg(lobA, m => m.t === 'launch', 6000);
    const lb = await onceMsg(lobB, m => m.t === 'launch', 6000);

    const good = gameWs(s.base, slotA, la.token); good.binaryType = 'nodebuffer';
    const evil = gameWs(s.base, slotB, lb.token); evil.binaryType = 'nodebuffer';
    await open(good); await open(evil);

    let bundles = 0;
    good.on('message', () => bundles++);

    let stopped = false, tic = 0;
    const goodLoop = () => {
        if (stopped) return;
        const b = Buffer.alloc(12); b.writeUInt32LE(tic++, 0);
        if (good.readyState === 1) good.send(b);
        setTimeout(goodLoop, 28);
    };
    // Well-formed length, well under the 300/s rate cap.  Nothing here is
    // malformed; only the tic is useless.  Honest first (sequential tics at
    // 35 Hz, as the engine sends them), then the attack tic every 100 ms.
    let evilNext = 0, attackTic = null;
    const attackAt = Date.now() + honestMs;
    const evilLoop = () => {
        if (stopped) return;
        const b = Buffer.alloc(12);
        if (Date.now() < attackAt) b.writeUInt32LE(evilNext++, 0);
        else b.writeUInt32LE(attackTic ??= evilTic(evilNext), 0);
        if (evil.readyState === 1) evil.send(b);
        setTimeout(evilLoop, Date.now() < attackAt ? 28 : 100);
    };
    goodLoop(); evilLoop();

    await sleep(honestMs + 1000);       // the attack is past GRACE_MS
    const from = bundles;
    await sleep(2500);
    const seen = bundles - from;
    check(`ingame stall (${variant}): seal keeps advancing for the honest player`, seen >= 10,
          `${seen} sealed bundles in 2.5 s under attack (want >= 10; frozen reads 0)`);

    // The other half of the file header's promise: past the drop window, out.
    await sleep(3000);
    const closed = evil.readyState === 2 || evil.readyState === 3;
    check(`ingame stall (${variant}): the useless peer is dropped, not tolerated forever`, closed,
          `hostile socket readyState=${evil.readyState} ~6.5 s into the attack (DROP_MS is 5 s)`);

    const after = bundles;
    check(`ingame stall (${variant}): the game outlived the attack`, after > from + seen,
          `${from + seen} -> ${after} bundles`);

    stopped = true;
    try { good.close(); } catch {}
    try { evil.close(); } catch {}
    try { lobA.close(); } catch {}
    try { lobB.close(); } catch {}
    const alive = await serverAlive(s.base);
    check(`ingame stall (${variant}): server survives`, alive && !s.didCrash(), `alive=${alive} crashed=${s.didCrash()}`);
    s.kill();
}

// ── SURFACE 13: a lobby frame that throws in the handler ─────────────────────
//
// JSON that parses into the wrong shape -- `null`, or an object where the
// handler coerces a primitive -- must be ignored, not thrown on.  The process
// would survive a throw (serve.js's last-resort handler), which is why "server
// survives" cannot grade this: the throw unwinds through ws's receiver, that
// socket never delivers another frame, never closes server-side, and keeps its
// lobby seat.  So each hostile frame gets its own server and seated socket,
// and the assertions are that THE SAME socket still answers a ping, that its
// seat is free once it leaves, and that the server logged no stack.
async function fuzzLobbyShapes() {
    const bad = (k, v) => JSON.stringify({ t: 'params', params: { [k]: v } });
    const obj = { toString: 1 };      // ToPrimitive finds no callable: TypeError
    const CASES = [
        ['null', 'null'],
        ['params.wad object', bad('wad', obj)],
        ['params.episode object', bad('episode', obj)],
        ['params.map object', bad('map', obj)],
        ['params.skill object', bad('skill', obj)],
        ['params.timer object', bad('timer', obj)],
        ['slot object', JSON.stringify({ t: 'slot', slot: obj })],
        ['name object', JSON.stringify({ t: 'name', name: obj })],
        // the observer path coerces a name too, on `join` into a live game
        ['observer join name object', JSON.stringify({ t: 'join', name: obj }), 'observer'],
    ];
    const pongAfter = async (ws, frame) => {
        ws.send(frame);
        ws.send(JSON.stringify({ t: 'ping', t0: 7 }));
        return onceMsg(ws, m => m.t === 'pong' && m.t0 === 7, 1500).then(() => true, () => false);
    };

    // Every case owns its server, so the attacks run at once and the checks
    // print in order.  The servers start one at a time: freePort() releases
    // its probe before the server binds, so concurrent starts can be handed
    // the same port.
    const one = async ([label, frame, role = 'seated'], s) => {
        const out = [];
        const host = role === 'observer' ? await startSession(s.base).catch(() => null) : null;
        if (role === 'observer' && !host) {
            s.kill();
            return [[`lobby shape (${label}): session started`, false, 'startSession failed']];
        }
        const ws = lobbyWs(s.base);
        await open(ws);
        const hello = await onceMsg(ws, m => m.t === (host ? 'inprogress' : 'welcome'), 2000);
        const ok = await pongAfter(ws, frame);
        out.push([`lobby shape (${label}): the same socket still answers`, ok,
                  ok ? 'pong received' : 'no pong — the throw killed this socket']);
        ws.terminate();
        await sleep(150);
        if (!host) {
            const v = lobbyWs(s.base);
            await open(v);
            const w = await onceMsg(v, m => m.t === 'welcome', 2000).catch(() => null);
            out.push([`lobby shape (${label}): its seat is released when it leaves`, w?.slot === hello.slot,
                      `next client seated at ${w?.slot ?? 'nothing'}, the hostile one held ${hello.slot}`]);
            v.close();
        }
        host?.stop();
        await sleep(100);
        const stack = /^\s+at /m.exec(s.stderr());
        out.push([`lobby shape (${label}): no stack trace in the server log`, !stack,
                  stack ? s.stderr().split('\n').find(l => /Error/.test(l)) ?? stack[0] : 'clean']);
        s.kill();
        return out;
    };
    const servers = [];
    for (const _ of CASES) servers.push(await spawnServer());
    for (const rows of await Promise.all(CASES.map((c, k) => one(c, servers[k]))))
        for (const row of rows) check(...row);
}

// ── SURFACE 14: a countdown a stranger tries to abort and restart ───────────
//
// A countdown is a chain of 1 s ticks, and it must stay ONE chain: two cast two
// `launch` frames and start two seal sweeps on one session -- visible as a
// silent player's tics being fabricated at twice the rate -- and endSession
// clears only the sweep it holds a handle to.  The other then runs during the
// NEXT session's countdown, where `launched` is still 0, and drops every seat
// as "never joined" before it can launch.
//
// The way to a second chain is to end the session inside its countdown and
// start again inside the same second.  Binding a seat's relay slot and
// leaving ends a session ("all players left"), and no seat token exists until
// the launch, so a stranger's relay socket is refused and the countdown runs
// on: one chain, and the `start` sent inside it is ignored.
async function fuzzCountdownRestart() {
    const s = await spawnServer();
    const lob = lobbyWs(s.base);
    await open(lob);
    const w = await onceMsg(lob, m => m.t === 'welcome');
    const frames = [];
    lob.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'countdown') frames.push(`countdown ${m.n}`);
        else if (m.t !== 'roster') frames.push(m.t);
    });
    const start = () => lob.send(JSON.stringify({ t: 'start' }));

    start();
    await onceMsg(lob, m => m.t === 'countdown', 3000);
    await sleep(300);
    const stranger = gameWs(s.base, w.slot);    // tries the seat's relay slot, and leaves
    await open(stranger).catch(() => {});
    stranger.close();
    await sleep(100);
    start();                                    // inside the chain's second
    const launch = await onceMsg(lob, m => m.t === 'launch', 6000);
    await sleep(1500);                          // room for a stale chain's launch
    const launches = frames.filter(f => f === 'launch').length;
    check('countdown restart: exactly one launch', launches === 1, `frames: ${frames.join(', ')}`);
    const want = 'countdown 3, countdown 2, countdown 1, launch';
    check('countdown restart: the countdown runs 3, 2, 1 once',
          frames.join(', ') === want, `got "${frames.join(', ')}"`);

    // play in it, then go silent: past GRACE_MS each sweep fabricates one tic
    const g = gameWs(s.base, w.slot, launch.token);
    g.binaryType = 'nodebuffer';
    await open(g);
    let bundles = 0;
    g.on('message', () => bundles++);
    for (let tic = 0; tic < 10; tic++) {
        const b = Buffer.alloc(12); b.writeUInt32LE(tic, 0); g.send(b);
        await sleep(28);
    }
    await sleep(600);
    const b0 = bundles;
    await sleep(1000);
    const rate = bundles - b0;
    check('countdown restart: one seal sweep in the restarted session', rate > 0 && rate <= 30,
          `${rate} fabricated tics in 1 s (one 50 ms sweep is 20/s; two are 40/s)`);

    // leaving ends it; a sweep that outlived it would kill the next countdown
    lob._buf.length = 0;
    g.close();
    await onceMsg(lob, m => m.t === 'roster' && !m.inGame, 3000);
    lob._buf.length = 0;
    start();
    const next = await onceMsg(lob, m => m.t === 'launch' || (m.t === 'roster' && !m.inGame), 6000)
        .catch(() => null);
    check('countdown restart: the next session still launches', next?.t === 'launch',
          next?.t === 'launch' ? 'launched' : `got ${next ? 'a roster with no game' : 'nothing'} instead`);

    try { lob.close(); } catch {}
    const alive = await serverAlive(s.base);
    check('countdown restart: server survives', alive && !s.didCrash(), `alive=${alive} crashed=${s.didCrash()}`);
    s.kill();
}

// ── SURFACE 15: a timed-out joiner whose socket is still closing ────────────
//
// A drop-in that never goes live is timed out after JOIN_TIMEOUT_MS: the slot
// is freed and the socket is sent a close frame.  A peer that never answers
// keeps that socket in CLOSING for up to ws's 30 s close timeout, and the slot
// may be bound by a second joiner long before it ends.  The old socket's late
// events must then speak for nobody: its 'close' must not unbind the new
// joiner, and the ticcmds it can still send must not be sealed into the slot.
// The first joiner is a raw socket that completes the handshake and never
// answers a close frame, as a stalled or hostile client would.
async function rawJoin(port, path) {
    const sock = createConnection(port, '127.0.0.1');
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.on('error', () => {});
    sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
               'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    const head = await new Promise(res => sock.once('data', d => res(String(d).split('\r\n')[0])));
    if (!/ 101 /.test(head)) throw new Error(`raw upgrade to ${path}: ${head}`);
    return sock;
}
// a client frame must be masked; mask 0 sends the payload as-is
const rawFrame = payload => Buffer.concat([Buffer.from([0x82, 0x80 | payload.length, 0, 0, 0, 0]), payload]);

async function fuzzStaleJoiner(variant) {
    const s = await spawnServer({ WEBDOOM_JOIN_TIMEOUT: '1000' });
    const host = await startSession(s.base).catch(() => null);
    if (!host) { check(`stale joiner (${variant}): session started`, false, 'startSession failed'); s.kill(); return; }
    // what the host is sealed: slot 1's live bit, fabricated bit and cmd
    let frontier = 0, injected = 0;
    host.g.on('message', b => {
        frontier = b.readUInt32LE(0) + 1;
        if ((b[4] & 2) && !(b[5] & 2) && b.subarray(14, 22).every(x => x === 0x55)) injected++;
    });

    const r1 = await reserve(s.base, 1);
    const j1 = await rawJoin(s.port, gamePath(1, r1.token));
    await sleep(1600);                          // timed out: slot 1 is free again
    const r2 = await reserve(s.base, 1);
    check(`stale joiner (${variant}): the freed slot is reserved again`, r2.slot === 1, `got slot ${r2.slot}`);
    const j2 = gameWs(s.base, 1, r2.token);
    j2.binaryType = 'nodebuffer';
    let got = 0, lastTic = -1, lastMask = 0;
    j2.on('message', b => { got++; lastTic = b.readUInt32LE(0); lastMask = b[4]; });
    await open(j2);

    if (variant === 'close') {
        // the second joiner plays honestly and goes live
        let jt = 0, stopped = false;
        (function loop() {
            if (stopped) return;
            jt = Math.max(jt, lastTic + 1);
            const b = Buffer.alloc(12); b.writeUInt32LE(jt++, 0);
            if (j2.readyState === 1) j2.send(b);
            setTimeout(loop, 28);
        })();
        for (let t = 0; t < 40 && !(lastMask & 2); t++) await sleep(100);
        check('stale joiner (close): the second joiner goes live', !!(lastMask & 2), `ingame mask ${lastMask}`);
        j1.destroy();                           // the first socket's close lands now
        await sleep(500);
        const g0 = got;
        await sleep(1500);
        check('stale joiner (close): the second joiner is still served after the first closes',
              got - g0 >= 20 && !!(lastMask & 2) && j2.readyState === 1,
              `${got - g0} bundles in 1.5 s, ingame mask ${lastMask}, readyState ${j2.readyState}`);
        stopped = true;
    } else {
        // the second joiner stays silent; the first keeps sending cmds
        const until = Date.now() + 2000;
        while (Date.now() < until) {
            for (let t = frontier; t < frontier + 3; t++) {
                const pl = Buffer.alloc(12, 0x55); pl.writeUInt32LE(t, 0);
                j1.write(rawFrame(pl));
            }
            await sleep(50);
        }
        check('stale joiner (message): a timed-out socket\'s cmds are never sealed into the slot',
              injected === 0, `${injected} bundles carried its 0x55 cmd for slot 1 as live and not fabricated`);
        j1.destroy();
    }
    check(`stale joiner (${variant}): the host kept receiving bundles`, host.getTics() > 0 && frontier > 0,
          `${host.getTics()} bundles`);
    try { j2.close(); } catch {}
    r1.lob.close(); r2.lob.close();
    host.stop();
    const alive = await serverAlive(s.base);
    check(`stale joiner (${variant}): server survives`, alive && !s.didCrash(), `alive=${alive} crashed=${s.didCrash()}`);
    s.kill();
}

// ── SURFACE 17: a peer that stops reading ───────────────────────────────────
//
// ws.send() queues in the Node heap once the kernel buffers are full, so a
// peer that never reads would pull every bundle or roster sent to it into
// server memory.  SEND_BACKLOG_CAP bounds that at EVERY send site: live
// bundles to a spectator and to a player, and lobby casts.  Each case runs the
// real door with a raw socket that completes the handshake and pauses, a cap
// pinned low (64 KiB), and the per-connection rate cap raised so an honest
// peer can drive traffic fast enough to fill the kernel buffers in seconds
// rather than minutes.  The victim must keep being served.
//
// How much the kernel absorbs before anything queues in Node is the host's
// (tcp_rmem/tcp_wmem): a paused player socket took ~30 MB and 5 s here, a
// spectator ~2 MB.  So the wait is long and ends at the refusal, and the RSS
// bound is loose: RSS also counts uncollected garbage, which grows with the
// traffic needed to fill those buffers (~90 MiB measured), while the
// unbounded case passes 256 MiB within seconds and is stopped at 512.
const rssOf = pid => { try { return +/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1] * 1024; } catch { return NaN; } };
async function pausedPeer(port, path) {
    const sock = await rawJoin(port, path);
    sock.pause();                               // never read again
    // no Nagle: its own writes must not wait on ACKs from a server that
    // cannot send to it, or the seal stalls on this player's cmds instead
    sock.setNoDelay(true);
    return sock;
}
async function fuzzSendBacklog(path) {
    const s = await spawnServer({ WEBDOOM_SEND_BACKLOG: '65536', WEBDOOM_RATE_CAP: '1000000' });
    const status = async () => (await fetch(`http://127.0.0.1:${s.port}/api/status`)).json();
    const lob = lobbyWs(s.base);
    await open(lob);
    const w = await onceMsg(lob, m => m.t === 'welcome');
    const what = { '/ws/spectate': 'spectators', '/ws/game': 'players', '/ws/lobby': 'lobby' }[path];
    let stopped = false, paused = null, frontier = 0, sent = 0, host = null;

    if (path === '/ws/lobby') {
        paused = await pausedPeer(s.port, path);
        // the honest member renames itself as fast as it can: every rename
        // casts a roster to both members
        (async () => {
            let k = 0;
            while (!stopped) {
                if (lob.bufferedAmount < 1 << 16)
                    for (let j = 0; j < 500; j++) lob.send(JSON.stringify({ t: 'name', name: `n${k++ % 1000}` }));
                await new Promise(r => setImmediate(r));
            }
        })();
    } else {
        // a second seat for the paused player, so it is in the game from tic 0
        const lobB = path === '/ws/game' ? lobbyWs(s.base) : null;
        const wb = lobB && (await open(lobB), await onceMsg(lobB, m => m.t === 'welcome'));
        lob.send(JSON.stringify({ t: 'start' }));
        const la = await onceMsg(lob, m => m.t === 'launch', 6000);
        const lb = lobB && await onceMsg(lobB, m => m.t === 'launch', 6000);
        host = gameWs(s.base, w.slot, la.token);
        host.binaryType = 'nodebuffer';
        await open(host);
        host.on('message', b => { frontier = b.readUInt32LE(0) + 1; });
        paused = await pausedPeer(s.port, path === '/ws/game' ? gamePath(wb.slot, lb.token) : path);
        // the honest player blasts cmds as far ahead as the window allows; a
        // paused player still WRITES its cmds (it only stops reading), so the
        // seal runs as fast as the host does.  The relay ignores a cmd more
        // than 512 tics ahead of the seal, so a batch of 256 starts only when
        // the lead is under 256: past 512 the host would leave a gap it never
        // fills, and be fabricated for and dropped like a stalled player.
        (async () => {
            while (!stopped) {
                if (sent - frontier < 256)
                    for (let j = 0; j < 256; j++, sent++) {
                        const c = Buffer.alloc(12); c.writeUInt32LE(sent, 0);
                        host.send(c);
                        if (path === '/ws/game') paused.write(rawFrame(c));
                    }
                await new Promise(r => setImmediate(r));
            }
        })();
    }

    const before = await status();
    const rss0 = rssOf(s.srv.pid);
    let after = before, peak = 0;
    for (let t = 0; t < 150; t++) {             // up to 15 s
        await sleep(100);
        after = await status();
        peak = Math.max(peak, rssOf(s.srv.pid) - rss0);
        if (after[what] < before[what]) break;
        if (peak > 512 * 2 ** 20) break;        // the unbounded case: stop well short of harm
    }
    check(`send backlog (${path}): the peer that stopped reading is refused`, after[what] < before[what],
          `${what} ${before[what]} -> ${after[what]}`);
    check(`send backlog (${path}): server memory stays bounded`, peak < 256 * 2 ** 20,
          `RSS grew ${(peak / 2 ** 20).toFixed(1)} MiB`);
    if (host) {
        const f0 = frontier;
        await sleep(300);
        check(`send backlog (${path}): the honest player is still served`, frontier > f0, `frontier ${f0} -> ${frontier}`);
    } else {
        const ok = await (async () => {
            lob._buf.length = 0;
            lob.send(JSON.stringify({ t: 'ping', t0: 9 }));
            return onceMsg(lob, m => m.t === 'pong', 2000).then(() => true, () => false);
        })();
        check('send backlog (/ws/lobby): the honest member is still served', ok, ok ? 'pong' : 'no pong');
    }
    stopped = true;
    paused.destroy();
    try { host?.close(); } catch {}
    try { lob.close(); } catch {}
    s.kill();
}

// ── SURFACE 20: a ping flood from a peer that never reads ───────────────────
//
// ws answers every ping frame with a pong unless told not to, and a pong to a
// peer that never reads queues in the Node heap like any other send.  So pings
// count against the same rate cap as messages, or a control-frame flood is
// invisible to it, and their pongs go through the same backlog cap.  Each endpoint gets its own server, a live
// session with an honest player, and a raw socket that pauses after the
// handshake and writes pings as fast as the server drains them -- 60-byte
// ones, under the game and spectate endpoints' 64-byte maxPayload, which would
// otherwise close the socket before any pong was queued.  The CONTROL: an
// ordinary ping still gets its pong.
async function fuzzPingFlood(path) {
    const s = await spawnServer();
    const host = await startSession(s.base).catch(() => null);
    if (!host) { check(`ping flood (${path}): session started`, false, 'startSession failed'); s.kill(); return; }

    const ctl = lobbyWs(s.base);
    await open(ctl);
    const ponged = await new Promise(res => { ctl.once('pong', () => res(true)); ctl.ping(); setTimeout(() => res(false), 1500); });
    check(`ping flood (${path}) CONTROL: an ordinary ping is answered`, ponged, ponged ? 'pong' : 'no pong');

    // the game socket holds a reservation: one with no seat token is refused at
    // once, and its close would read as the flood being stopped
    const seat = path === '/ws/game' ? await reserve(s.base, 1).catch(() => null) : null;
    const sock = await rawJoin(s.port, path === '/ws/game' ? gamePath(1, seat?.token) : path);
    sock.pause();
    let closed = false;
    sock.on('close', () => { closed = true; });
    await sleep(150);
    check(`ping flood (${path}): the flooding socket was accepted before the flood`, !closed,
          closed ? 'already closed' : 'open');
    const ping = Buffer.concat([Buffer.from([0x89, 0x80 | 60, 0, 0, 0, 0]), Buffer.alloc(60, 0x41)]);
    const batch = Buffer.concat(Array(512).fill(ping));
    const rss0 = rssOf(s.srv.pid);
    let peak = 0, stop = false;
    const drained = () => new Promise(r => {
        const done = () => { sock.off('drain', done); sock.off('close', done); r(); };
        sock.on('drain', done); sock.on('close', done);
    });
    (async () => {
        while (!stop && !closed)
            if (!sock.write(batch)) await drained();
    })();
    const t0 = Date.now();
    while (!closed && Date.now() - t0 < 3000) {
        await sleep(100);
        peak = Math.max(peak, rssOf(s.srv.pid) - rss0);
        if (peak > 256 * 2 ** 20) break;        // the unbounded case: stop well short of harm
    }
    stop = true;
    check(`ping flood (${path}): the flooding socket is terminated`, closed,
          closed ? `closed after ${Date.now() - t0} ms` : 'still open');
    // a refused flood costs the server a few MiB; unanswered pongs cost ~65 MiB
    // even where a live bundle's backlog check catches them, and grow without
    // bound where nothing else is sent (the lobby)
    check(`ping flood (${path}): server memory stays bounded`, peak < 24 * 2 ** 20,
          `RSS grew ${(peak / 2 ** 20).toFixed(1)} MiB`);
    sock.destroy();

    const t1 = host.getTics();
    await sleep(300);
    check(`ping flood (${path}): the honest player is still served`, host.getTics() > t1, `${t1} -> ${host.getTics()} bundles`);
    ctl._buf.length = 0;
    ctl.send(JSON.stringify({ t: 'ping', t0: 5 }));
    const pong = await onceMsg(ctl, m => m.t === 'pong', 2000).then(() => true, () => false);
    check(`ping flood (${path}): another lobby client still gets a pong`, pong, pong ? 'pong' : 'no pong');
    try { ctl.close(); } catch {}
    seat?.lob.close();
    host.stop();
    s.kill();
}

// ── SURFACES 23-26: a seat belongs to the lobby socket it was given to ─────
//
// /ws/game?slot=N binds the slot to whoever connects, so it takes the seat's
// token, sent only to the lobby socket holding that seat (or to the observer
// whose `join` reserved it).  Each case enters through the real door with
// real sockets and pairs the refusal with the owner being served, so a door
// that refused everyone would fail here too.

// A launched seat, between its countdown and its real client's relay: a
// stranger at that slot is refused, and the real client, holding the token
// from its own launch frame, is served.  Each arm owns its server.
const THIEF_ARMS = [
    ['no token, in the countdown',        'countdown', undefined],
    ['a wrong token, in the countdown',   'countdown', 'f'.repeat(32)],
    ['no token, after the launch',        'launch',    undefined],
    ['an empty token, after the launch',  'launch',    ''],
];
async function seatThiefArm([label, when, token], s) {
    const rows = [];
    const lob = lobbyWs(s.base);
    await open(lob);
    const w = await onceMsg(lob, m => m.t === 'welcome');
    lob.send(JSON.stringify({ t: 'start' }));
    await onceMsg(lob, m => m.t === 'countdown', 3000);
    let thief = when === 'countdown' ? await probeGame(s.base, w.slot, token) : null;
    const launch = await onceMsg(lob, m => m.t === 'launch', 6000).catch(() => null);
    if (when === 'launch') thief = await probeGame(s.base, w.slot, token);
    rows.push([`seat thief (${label}): the stranger is refused`, thief.refused, thief.said]);

    // the real client, as the shipped client connects: slot and its own token
    let bundles = 0, stopped = false;
    const real = launch && gameWs(s.base, w.slot, launch.token ?? '');
    if (real) {
        real.binaryType = 'nodebuffer';
        real.on('error', () => {});
        real.on('message', () => bundles++);
        await open(real).catch(() => {});
        let tic = 0;
        (function loop() {
            if (stopped) return;
            const b = Buffer.alloc(12); b.writeUInt32LE(tic++, 0);
            if (real.readyState === 1) real.send(b);
            setTimeout(loop, 28);
        })();
        await sleep(1200);
    }
    rows.push([`seat thief (${label}): the real client, with its token, is served`,
               bundles >= 10 && real?.readyState === 1,
               launch ? `${bundles} bundles in 1.2 s, readyState ${real.readyState}` : 'no launch frame']);
    stopped = true;
    try { thief.ws.close(); } catch {}
    try { real?.close(); } catch {}
    lob.close();
    await sleep(100);
    rows.push([`seat thief (${label}): server survives`, !s.didCrash() && await serverAlive(s.base),
               `crashed=${s.didCrash()}`]);
    s.kill();
    return rows;
}
async function fuzzSeatThief() {
    const servers = [];
    for (const _ of THIEF_ARMS) servers.push(await spawnServer());
    for (const rows of await Promise.all(THIEF_ARMS.map((a, k) => seatThiefArm(a, servers[k]))))
        for (const row of rows) check(...row);
}

// A stranger that connects to a counting-down seat's slot and closes again
// must not end the session ("all players left") and so abort the launch.
async function countdownAbortArm(label, token, s) {
    const rows = [];
    const lob = lobbyWs(s.base);
    await open(lob);
    const w = await onceMsg(lob, m => m.t === 'welcome');
    lob.send(JSON.stringify({ t: 'start' }));
    await onceMsg(lob, m => m.t === 'countdown', 3000);
    lob._buf.length = 0;
    const p = await probeGame(s.base, w.slot, token, 100);
    p.ws.close();
    const next = await onceMsg(lob, m => m.t === 'launch' || (m.t === 'roster' && !m.inGame), 6000).catch(() => null);
    rows.push([`countdown abort (${label}): the launch still comes`, next?.t === 'launch',
               next?.t === 'launch' ? 'launched' : `got ${next ? 'a roster with no game (aborted)' : 'nothing'}`]);
    let bundles = 0;
    if (next?.t === 'launch') {
        const real = gameWs(s.base, w.slot, next.token ?? '');
        real.binaryType = 'nodebuffer';
        real.on('error', () => {});
        real.on('message', () => bundles++);
        await open(real).catch(() => {});
        for (let tic = 0; tic < 30; tic++) {
            const b = Buffer.alloc(12); b.writeUInt32LE(tic, 0);
            if (real.readyState === 1) real.send(b);
            await sleep(28);
        }
        real.close();
    }
    rows.push([`countdown abort (${label}): the seat's own client is served`, bundles >= 10, `${bundles} bundles`]);
    lob.close();
    rows.push([`countdown abort (${label}): server survives`, !s.didCrash() && await serverAlive(s.base),
               `crashed=${s.didCrash()}`]);
    s.kill();
    return rows;
}
async function fuzzCountdownAbort() {
    const arms = [['no token', undefined], ['a wrong token', '0'.repeat(32)]];
    const servers = [];
    for (const _ of arms) servers.push(await spawnServer());
    for (const rows of await Promise.all(arms.map(([l, t], k) => countdownAbortArm(l, t, servers[k]))))
        for (const row of rows) check(...row);
}

// Drop-in: a free slot of a live game binds only for the observer whose `join`
// reserved it, with the token that join was answered with.  Every refused
// probe closes before the next arm, so no arm can be refused for occupancy.
async function fuzzDropInUnreserved() {
    const s = await spawnServer();
    const host = await startSession(s.base).catch(() => null);
    if (!host) { check('drop-in: session started', false, 'startSession failed'); s.kill(); return; }
    const watcher = lobbyWs(s.base);           // looks, never asks to join
    await open(watcher);
    await onceMsg(watcher, m => m.t === 'inprogress', 3000);

    const arm = async (label, slot, token) => {
        const p = await probeGame(s.base, slot, token);
        check(`drop-in: ${label} is refused`, p.refused, p.said);
        p.ws.close();
        await sleep(100);
    };
    await arm('an observer with no reservation (no token)', 1, undefined);
    await arm('an observer with no reservation (a guessed token)', 1, 'a'.repeat(32));
    const b = await reserve(s.base, 2);
    await arm(`another slot's reservation token (slot ${b.slot}'s, at slot 1)`, 1, b.token);

    // the observer who reserved slot 1 binds it, catches up and goes live
    const c = await reserve(s.base, 1);
    const g = gameWs(s.base, c.slot, c.token);
    g.binaryType = 'nodebuffer';
    let got = 0, lastTic = -1, lastMask = 0;
    g.on('message', buf => { got++; lastTic = buf.readUInt32LE(0); lastMask = buf[4]; });
    await open(g).catch(() => {});
    let jt = 0, stopped = false;
    (function loop() {
        if (stopped) return;
        jt = Math.max(jt, lastTic + 1);
        const buf = Buffer.alloc(12); buf.writeUInt32LE(jt++, 0);
        if (g.readyState === 1) g.send(buf);
        setTimeout(loop, 28);
    })();
    for (let t = 0; t < 30 && !(lastMask & (1 << c.slot)); t++) await sleep(100);
    check(`drop-in: the observer who reserved slot ${c.slot} binds it and goes live`,
          c.slot === 1 && got > 0 && !!(lastMask & (1 << c.slot)) && g.readyState === 1,
          `slot ${c.slot}, ${got} frames, ingame mask ${lastMask}, readyState ${g.readyState}`);
    // CONTROL for the cross-slot arm: that token is valid where it was issued
    const own = await probeGame(s.base, b.slot, b.token);
    check(`drop-in: slot ${b.slot}'s token binds slot ${b.slot}`, !own.closed && own.frames > 0, own.said);

    const t0 = host.getTics();
    await sleep(300);
    check('drop-in: the host kept receiving bundles', host.getTics() > t0, `${t0} -> ${host.getTics()}`);
    stopped = true;
    for (const x of [g, own.ws, watcher, b.lob, c.lob]) try { x.close(); } catch {}
    host.stop();
    const alive = await serverAlive(s.base);
    check('drop-in: server survives', alive && !s.didCrash(), `alive=${alive} crashed=${s.didCrash()}`);
    s.kill();
}

// A reservation that times out goes back to the pool and may be given to
// another observer; the first observer's lobby socket closing afterwards
// must not release the second one's, which would welcome a third observer
// into the same slot, and the first one's token no longer binds.  Until the
// slot is taken again it still does: a client whose boot outlasted the
// timeout gets the seat nobody else asked for.
async function fuzzReservationOwnership() {
    const s = await spawnServer({ WEBDOOM_JOIN_TIMEOUT: '1500' });
    const host = await startSession(s.base).catch(() => null);
    if (!host) { check('reservation owner: session started', false, 'startSession failed'); s.kill(); return; }
    const a = await reserve(s.base, 1);
    const slow = await reserve(s.base, 2);
    await sleep(2000);                          // both reservations time out
    const late = await probeGame(s.base, slow.slot, slow.token, 300);
    check('reservation owner: a timed-out token binds while nobody has taken the slot since',
          slow.slot === 2 && !late.closed && late.frames > 0, `slot ${slow.slot}, ${late.said}`);
    late.ws.close();
    slow.lob.close();
    const b = await reserve(s.base, 1);
    check('reservation owner: the timed-out slot is reserved again (by b)', a.slot === 1 && b.slot === 1,
          `a got ${a.slot}, b got ${b.slot}`);
    a.lob.close();                              // the old owner leaves
    await sleep(200);
    const c = await reserve(s.base, 1).catch(e => ({ slot: null, why: e.message }));
    check("reservation owner: the old owner leaving does not free the new owner's slot",
          c.slot !== 1, `a third observer asking for slot 1 got ${c.slot ?? c.why}`);
    const stale = await probeGame(s.base, 1, a.token, 300);
    check('reservation owner: the timed-out token no longer binds', stale.refused, stale.said);
    stale.ws.close();
    await sleep(50);
    const mine = await probeGame(s.base, 1, b.token, 300);
    check('reservation owner: the new owner binds with its token', !mine.closed && mine.frames > 0, mine.said);
    for (const x of [mine.ws, b.lob, c.lob]) try { x?.close(); } catch {}
    host.stop();
    const alive = await serverAlive(s.base);
    check('reservation owner: server survives', alive && !s.didCrash(), `alive=${alive} crashed=${s.didCrash()}`);
    s.kill();
}

// ── Run all suites, eight at a time ───────────────────────────────────────────
//
// Every suite owns its servers and its sockets, so nothing shares state but
// `results`.  Serially this file was 46 of CI's 59 s.  Output is buffered per
// suite through AsyncLocalStorage and printed when the suite completes, so a
// FAIL line still sits under its own heading.
// ── SURFACE 27: the last player holding up a tic leaves ─────────────────────
//
// An honest client runs at most BACKUPTICS/2-1 tics past the last bundle it
// has seen (engine/web/d_net.c NetUpdate), then goes silent waiting for the
// seal.  When the only player missing the current tic leaves -- its socket
// closes inside the grace window, or it never connected at all -- the tics
// the others have already filled must seal without waiting for a frame that
// is not coming.
const LEAD = 16;    // an honest client's cmds stay below frontier + LEAD
async function fuzzLaggardLeaves(variant) {
    const s = await spawnServer();
    const seats = variant === 'never' ? 3 : 2;
    const lobs = [], wel = [];
    for (let i = 0; i < seats; i++) {
        const l = lobbyWs(s.base); await open(l);
        wel.push(await onceMsg(l, m => m.t === 'welcome'));
        lobs.push(l);
    }
    lobs[0].send(JSON.stringify({ t: 'start' }));
    const launches = await Promise.all(lobs.map(l => onceMsg(l, m => m.t === 'launch', 6000)));
    const t0 = Date.now();
    // seats 0 and 1 connect; in 'never' the third seat does not
    const [a, b] = [0, 1].map(i => {
        const w = gameWs(s.base, wel[i].slot, launches[i].token);
        w.binaryType = 'nodebuffer';
        return w;
    });
    await open(a); await open(b);
    let frontier = 0;           // one past the newest sealed tic a has seen
    a.on('message', d => { if (Buffer.isBuffer(d)) frontier = Math.max(frontier, d.readUInt32LE(0) + 1); });
    const sent = new Map([[a, 0], [b, 0]]);
    const send = (w, upto) => {
        for (let t = sent.get(w); t < upto; t++) { const c = Buffer.alloc(12); c.writeUInt32LE(t, 0); w.send(c); }
        sent.set(w, Math.max(sent.get(w), upto));
    };
    // 35 Hz, never past frontier + LEAD: the engine's own pacing
    const pace = w => setInterval(() => { if (w.readyState === 1) send(w, Math.min(sent.get(w) + 1, frontier + LEAD)); }, 28);
    const timers = [];

    let filled;
    if (variant === 'close') {
        // b fills 8 tics and leaves at once; a has already sent its full lead
        // over the frontier b leaves behind, so a is silent when b goes
        send(a, LEAD / 2 + LEAD);
        await sleep(200);
        send(b, LEAD / 2);
        b.close();
        timers.push(pace(a));           // and a plays on as an engine would
        filled = LEAD / 2 + LEAD;
        await sleep(1500);              // GRACE_MS is 250; the sweep runs every 50 ms
    } else {
        timers.push(pace(a), pace(b));  // both run into their lead and wait
        filled = LEAD;
        await sleep(Math.max(0, 10000 + 1500 - (Date.now() - t0)));   // NEVER_JOINED_MS is 10 s
    }
    check(`laggard leaves (${variant}): every tic the rest filled is sealed`, frontier >= filled,
          `frontier ${frontier}, ${filled} tics filled by everyone still playing`);

    const f0 = frontier;
    await sleep(1000);
    check(`laggard leaves (${variant}): the game goes on for the players left`,
          frontier - f0 >= 20 && a.readyState === 1, `frontier ${f0} -> ${frontier} in 1 s, a readyState ${a.readyState}`);

    timers.forEach(clearInterval);
    for (const w of [a, b, ...lobs]) try { w.close(); } catch {}
    const alive = await serverAlive(s.base);
    check(`laggard leaves (${variant}): server survives`, alive && !s.didCrash(), `alive=${alive} crashed=${s.didCrash()}`);
    s.kill();
}

const SUITES = [
    ['[1] Malformed lobby JSON',                fuzzLobbyJSON],
    ['[2] Binary tic frame abuse',              fuzzBinaryFrames],
    ['[3] Slot spoofing / identity',            fuzzSlotSpoofing],
    ['[4] Rejoin/drop-in races',                fuzzRaces],
    ['[5] Resource exhaustion / caps',          fuzzResourceCaps],
    ['[6] Malformed HTTP upgrade URL',          fuzzUpgradeURL],
    ['[7] Demo store endpoint',                 fuzzDemoEndpoint],
    ['[8] Session history cap',                 fuzzHistoryCap],
    ['[9] Lobby wad param vs the served library', fuzzWadParam],
    ['[10] In-game peer stalling the seal',      () => fuzzIngameStall('out-of-range tic')],
    ['[11] In-game peer skipping its owed tic',  () => fuzzIngameStall('owed tic + 1')],
    ['[12] In-game peer at the window edge',     () => fuzzIngameStall('owed tic + 512')],
    ['[13] Lobby frames of the wrong shape',     fuzzLobbyShapes],
    ['[14] Countdown aborted and restarted',     fuzzCountdownRestart],
    ['[15] Stale joiner socket: late close',     () => fuzzStaleJoiner('close')],
    ['[16] Stale joiner socket: late cmds',      () => fuzzStaleJoiner('message')],
    ['[17] Send backlog: spectator',             () => fuzzSendBacklog('/ws/spectate')],
    ['[18] Send backlog: player',                () => fuzzSendBacklog('/ws/game')],
    ['[19] Send backlog: lobby member',          () => fuzzSendBacklog('/ws/lobby')],
    ['[20] Ping flood: lobby',                   () => fuzzPingFlood('/ws/lobby')],
    ['[21] Ping flood: game',                    () => fuzzPingFlood('/ws/game')],
    ['[22] Ping flood: spectate',                () => fuzzPingFlood('/ws/spectate')],
    ['[23] Seat thief at a launched seat',       fuzzSeatThief],
    ['[24] Stranger aborting a countdown',       fuzzCountdownAbort],
    ['[25] Drop-in without a reservation',       fuzzDropInUnreserved],
    ['[26] A stale reservation\'s owner leaving', fuzzReservationOwnership],
    ['[27] Laggard leaves: closes in the grace window', () => fuzzLaggardLeaves('close')],
    ['[27] Laggard leaves: never connected',     () => fuzzLaggardLeaves('never')],
];
const POOL = Math.max(1, +(process.env.NET_FUZZ_JOBS ?? 8));
const als = new AsyncLocalStorage();
const rawLog = console.log.bind(console);
console.log = (...a) => { const b = als.getStore(); if (b) b.push(a.join(' ')); else rawLog(...a); };

rawLog(`net fuzz test — attacking the real server (${SUITES.length} suites, ${POOL} at a time):`);
let next = 0;
const worker = async () => {
    while (next < SUITES.length) {
        const [title, fn] = SUITES[next++];
        const lines = [];
        const t0 = Date.now();
        try { await als.run(lines, fn); }
        catch (e) { lines.push(`  FAIL ${title}: suite threw ${e?.stack ?? e}`); results.push({ name: title, ok: false, detail: String(e) }); }
        rawLog(`\n${title}  (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${lines.join('\n')}`);
    }
};
await Promise.all(Array.from({ length: Math.min(POOL, SUITES.length) }, worker));

const failed = results.filter(r => !r.ok);
const total = results.length;
rawLog(`\n${failed.length ? `FUZZ FAILURES: ${failed.length}/${total}` : `PASS — all ${total} fuzz cases: server survived all attacks, caps enforced`}`);
process.exit(failed.length ? 1 : 0);
