// webdoom lobby + tic relay. One lobby (LAN-party model), arcade slots:
// join order = slot = color. Any player sets params or hits start.
//
// Relay: clients send [u32 tic][8B ticcmd]; when every live player's
// cmd for tic T is in, the server broadcasts a sealed bundle
// [u32 tic][u8 ingameMask][u8 fabricatedMask][ticcmd × numplayers].
// WebSocket (TCP) makes delivery ordered+reliable — no resend protocol exists
// or is needed. A player silent past the grace window gets their last cmd
// duplicated (bounded stall for others); past the drop window they're out.
import { WebSocketServer } from 'ws';
import { envInt } from './env.js';

const COLORS = ['Green', 'Indigo', 'Brown', 'Red'];
const MAXPLAYERS = 4;
const CMD_SIZE = 8;
const GRACE_MS = 250;           // fabricate a missing cmd after this
const DROP_MS = 5000;           // remove the player after this
const NEVER_JOINED_MS = 10000;  // a launched player that never connected is dropped
const JOIN_MARGIN = 12;         // tics between a drop-in going live and spawning
const JOIN_TIMEOUT_MS = envInt('WEBDOOM_JOIN_TIMEOUT', 30000);   // reclaim a stalled reservation

// Resource caps, all well above legitimate 4-player LAN play at 35 Hz.
// 4 players × 2 sockets + observers = ~18 legit connections.
const MAX_CONNS = envInt('WEBDOOM_MAX_CONNS', 50);
// spectators need no slot and no credential, so they get their own cap
const MAX_SPECTATORS = envInt('WEBDOOM_MAX_SPECTATORS', 8);
// a peer with more than this queued is not keeping up and is dropped
const SEND_BACKLOG_CAP = envInt('WEBDOOM_SEND_BACKLOG', 4 * 1024 * 1024);
// The sealed history -- one 38-byte bundle per tic -- is kept from tic 0
// because drop-in and spectator catch-up replay it whole; a ring would hand
// a joiner a prefix and desync it silently.  So it stops growing at the cap
// and those two features refuse past it; live play continues.  It lives in
// 1,024-tic slabs (round 10): one Buffer object per tic cost ~460 B of RSS
// each (28.8 MB for the 63,000-tic cap, measured after GC); the slabs hold
// the same bundles in 8.1 MB, and a view is made only while one is sent.
const MAX_HISTORY_TICS = envInt('WEBDOOM_MAX_HISTORY_TICS', 35 * 60 * 30);
const SLAB_TICS = 1024;
// 4 players × 35 Hz = 140 msg/s aggregate; 300 per connection is 2× that
const RATE_CAP_PER_SEC = envInt('WEBDOOM_RATE_CAP', 300);
const RATE_WINDOW_MS = 1000;

// player names arrive from the network
const cleanName = n => String(n ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 10);

const defaultParams = () => ({
    wad: 'doom.wad', episode: 1, map: 1, skill: 3, mode: 'coop',
    nomonsters: false, fast: false, respawn: false, timer: 0,
});

// The one way to refuse a socket.  A frame racing in between the handshake
// and terminate() emits 'error', and an unhandled 'error' ends the process,
// so a no-op listener goes on first (once: rateOk() refuses on every message
// of a flood).  safeWs() sockets already carry a listener.
function refuse(ws, log = null, why = '') {
    if (ws._refused) return;
    ws._refused = true;
    if (why) (log ?? console.log)(why);
    if (!ws.listenerCount('error')) ws.on('error', () => {});
    try { ws.terminate(); } catch { /* already gone */ }
}

function safeWs(ws, log, tag) {
    ws.on('error', err => {
        log(`ws error [${tag}]: ${err?.message ?? err}`);
        try { ws.terminate(); } catch { /* already gone */ }
    });
    return ws;
}

// Per-connection rate guard over a tumbling window (a burst may straddle a
// boundary and reach 2× the cap; legitimate play never approaches it).
// Refuses the socket on a flood and returns false.
function rateOk(ws) {
    const now = Date.now();
    if (!ws._rateTs || now - ws._rateTs >= RATE_WINDOW_MS) {
        ws._rateTs = now;
        ws._rateCount = 0;
    }
    ws._rateCount++;
    if (ws._rateCount > RATE_CAP_PER_SEC) { refuse(ws); return false; }
    return true;
}

// servedWads: () => the WAD filenames this server serves.  The lobby's `wad`
// is cast to every client in the `launch` frame, so a name not in the
// library is refused rather than handed out.  The default names nothing,
// which refuses every change -- the safe direction.
export function createGame(log = console.log, servedWads = () => []) {
    // --- lobby state -------------------------------------------------------
    const lobby = new Map();        // slot → {ws, name} (name null = color default)
    let params = defaultParams();
    let session = null;             // active relay session or null
    let connCount = 0;              // open sockets across all three endpoints

    const displayName = slot => lobby.get(slot)?.name ?? COLORS[slot];
    const roster = () => ({
        t: 'roster',
        players: [...lobby.keys()].sort().map(s =>
            ({ slot: s, color: COLORS[s], name: displayName(s) })),
        freeSlots: [0, 1, 2, 3].filter(s => !lobby.has(s)),
        params,
        inGame: !!session,
    });
    // what a newcomer sees while a game is live
    const inProgress = () => ({
        t: 'inprogress',
        params: session.params,
        frontier: session.tic,
        players: session.players.filter(p => p.ingame || p.joining).map(p =>
            ({ slot: p.slot, color: COLORS[p.slot], name: session.names?.[p.slot] ?? COLORS[p.slot], live: p.ingame })),
        freeSlots: session.players.filter(p => !p.ingame && !p.joining).map(p => p.slot),
    });
    const cast = msg => {
        const s = JSON.stringify(msg);
        for (const p of lobby.values()) if (p.ws.readyState === 1) p.ws.send(s);
    };

    // A lobby socket is one of two things: a seat in the lobby (slot >= 0,
    // before a game starts) or an observer of a live game, who reserves a
    // slot only on `join` -- so merely looking never blocks one.
    function lobbyConnect(ws) {
        safeWs(ws, log, 'lobby');
        const reply = m => ws.send(JSON.stringify(m));
        let slot = -1;          // lobby seat
        let reserved = -1;      // drop-in reservation

        if (session) {
            reply(inProgress());
        } else {
            slot = 0;
            while (lobby.has(slot)) slot++;
            if (slot >= MAXPLAYERS) {
                reply({ t: 'full', reason: 'lobby full' });
                refuse(ws, log);
                return;
            }
            lobby.set(slot, { ws, name: null });
            reply({ t: 'welcome', slot, color: COLORS[slot] });
            cast(roster());
            log(`lobby: ${COLORS[slot]} joined (${lobby.size} in lobby)`);
        }

        ws.on('message', raw => {
            if (!rateOk(ws)) return;
            let m;
            try { m = JSON.parse(raw); } catch { return; }
            if (m.t === 'ping') { reply({ t: 'pong', t0: m.t0 }); return; }

            if (slot < 0) {     // observer of a live game
                if (!session) { reply({ t: 'full', reason: 'game over' }); return; }
                if (m.t !== 'join' || reserved >= 0) return;
                const want = Number.isInteger(m.slot) ? m.slot : -1;
                const p = session.players.find(q => q.slot === want && !q.ingame && !q.joining && !q.ws)
                    ?? session.players.find(q => !q.ingame && !q.joining && !q.ws);
                if (!p) { reply({ t: 'full', reason: 'game full' }); return; }
                reserved = p.slot;
                p.joining = true;
                p.reservedAt = Date.now();
                const nm = cleanName(m.name);
                if (nm) { session.names = session.names ?? [null, null, null, null]; session.names[p.slot] = nm; }
                reply({ t: 'welcome', slot: p.slot, color: COLORS[p.slot] });
                reply({ t: 'launch', params: session.params, numplayers: MAXPLAYERS,
                        slots: session.slots, names: session.names, join: true, frontier: session.tic });
                log(`lobby: ${COLORS[p.slot]} dropping in (frontier ${session.tic})`);
                return;
            }

            if (session) return;    // the lobby is frozen once a game starts
            if (m.t === 'name') {
                lobby.get(slot).name = cleanName(m.name) || null;
                cast(roster());
            } else if (m.t === 'slot') {
                // color choice IS slot choice (the engine colors by slot)
                const want = +m.slot;
                if (want >= 0 && want < MAXPLAYERS && !lobby.has(want) && want !== slot) {
                    lobby.set(want, lobby.get(slot));
                    lobby.delete(slot);
                    slot = want;
                    reply({ t: 'welcome', slot, color: COLORS[slot] });
                    cast(roster());
                }
            } else if (m.t === 'params') {
                const p = { ...params, ...m.params };
                // a sanitised filename says nothing about whether this server
                // HAS it: an unserved name keeps the current one, and says so
                const wantWad = String(p.wad).replace(/[^a-z0-9_.-]/g, '');
                let served = [];
                try { served = servedWads() ?? []; }
                catch (e) { log(`lobby: cannot read the WAD library (${e?.message ?? e}) — refusing every wad change`); }
                const wadOk = Array.isArray(served) && served.includes(wantWad);
                if (!wadOk && wantWad !== params.wad)
                    log(`lobby: refusing wad "${wantWad}" — not in this server's library; keeping "${params.wad}"`);
                params = {
                    wad: wadOk ? wantWad : params.wad,
                    episode: Math.max(1, Math.min(9, +p.episode || 1)),
                    map: Math.max(1, Math.min(32, +p.map || 1)),
                    skill: Math.max(1, Math.min(5, +p.skill || 3)),
                    mode: ['coop', 'deathmatch', 'altdeath'].includes(p.mode) ? p.mode : 'coop',
                    nomonsters: !!p.nomonsters,
                    fast: !!p.fast,
                    respawn: !!p.respawn,
                    timer: [0, 5, 10, 15, 20, 30].includes(+p.timer) ? +p.timer : 0,
                };
                cast(roster());
            } else if (m.t === 'start' && lobby.size >= 1) {
                startGame();
            }
        });
        ws.on('close', () => {
            if (slot >= 0) {
                lobby.delete(slot);
                cast(roster());
                log(`lobby: ${COLORS[slot]} left`);
                return;
            }
            const p = reserved >= 0 && session?.players[reserved];
            if (p && !p.ingame && !p.ws) { p.joining = false; p.reservedAt = 0; }
        });
    }

    // --- game session -------------------------------------------------------
    // Sessions are always MAXPLAYERS wide: color choice = slot choice, so
    // occupied slots may be sparse (players on 0 and 3). Phantom slots are
    // not-ingame from tic 0; the engine's playeringame mask mirrors this.
    function startGame() {
        const slots = [...lobby.keys()].sort();
        session = {
            numplayers: MAXPLAYERS,
            players: [0, 1, 2, 3].map(slot => ({
                slot, ws: null,
                cmds: new Map(),        // tic → Buffer(8)
                last: Buffer.alloc(CMD_SIZE),
                lastSeen: Date.now(),
                ingame: lobby.has(slot),
                joined: !lobby.has(slot),
            })),
            tic: 0,                     // next tic to seal
            timer: null,
            launched: 0,
            params: { ...params },      // frozen for the game; handed to drop-ins
            slots,                      // the tic-0 ingame slots
            names: null,
            slabs: [],                  // every sealed bundle, for catch-up, 1,024 per slab
            historyLen: 0,
            historyFull: false,         // cap reached: catch-up can no longer be served
            scratch: null,              // the bundle being sealed once the cap is reached
            spectators: new Set(),      // read-only observers; never in session.players
        };
        let n = 3;
        const tick = () => {
            if (!session) return;
            if (n > 0) { cast({ t: 'countdown', n: n-- }); setTimeout(tick, 1000); return; }
            const names = [0, 1, 2, 3].map(s => lobby.has(s) ? displayName(s) : null);
            session.names = names;
            cast({ t: 'launch', params, numplayers: MAXPLAYERS, slots, names });
            log(`game: launching ${slots.length}p (slots ${slots.join(',')}) ${params.wad} E${params.episode}M${params.map} skill ${params.skill} ${params.mode}`);
            session.launched = Date.now();
            session.timer = setInterval(sealSweep, 50);
        };
        tick();
    }

    function endSession(reason) {
        if (!session) return;
        clearInterval(session.timer);
        for (const p of session.players) p.ws?.close();
        for (const sw of session.spectators) try { sw.close(); } catch { /* gone */ }
        session = null;
        log(`game: over (${reason})`);
        cast(roster());
    }

    // Stream the whole sealed history to a joining socket.  ws.send() buffers
    // in the Node heap, so a stalled peer is refused rather than allowed to
    // pull the whole history into memory.  Returns false when refused.
    function burstHistory(ws, who) {
        const size = 6 + CMD_SIZE * session.numplayers;
        for (let i = 0; i < session.historyLen; i++) {
            if (ws.bufferedAmount > SEND_BACKLOG_CAP) {
                refuse(ws, log, `${who} too slow to catch up (${ws.bufferedAmount} B buffered) — dropping`);
                return false;
            }
            const off = (i % SLAB_TICS) * size;
            ws.send(session.slabs[Math.floor(i / SLAB_TICS)].subarray(off, off + size));
        }
        return true;
    }

    // --- spectator endpoint ---------------------------------------------------
    // Receive-only: the history burst, then live bundles.  There is NO
    // ws.on('message') here, so injection is structurally impossible.
    function spectateConnect(ws) {
        safeWs(ws, log, 'spectate');
        if (!session) { refuse(ws, log); return; }
        // past the cap the history is a prefix; replaying it would desync silently
        if (session.historyFull) {
            refuse(ws, log, `spectate: refusing — session is past the ${MAX_HISTORY_TICS}-tic history cap, catch-up cannot be served`);
            return;
        }
        if (session.spectators.size >= MAX_SPECTATORS) {
            refuse(ws, log, `spectate: cap hit (${session.spectators.size}/${MAX_SPECTATORS}) — refusing`);
            return;
        }
        if (!burstHistory(ws, 'spectate: observer')) return;
        session.spectators.add(ws);
        log(`spectate: observer connected (history ${session.historyLen} tics)`);
        ws.on('close', () => {
            session?.spectators.delete(ws);
            log('spectate: observer disconnected');
        });
    }

    function relayConnect(ws, url) {
        safeWs(ws, log, 'game');
        // slot must be an integer 0–3 naming an unoccupied seat of a live session
        let slot;
        try { slot = +new URL(url, 'http://x').searchParams.get('slot'); } catch { refuse(ws, log); return; }
        if (!Number.isInteger(slot) || slot < 0 || slot >= MAXPLAYERS) { refuse(ws, log); return; }
        const p = session?.players.find(p => p.slot === slot);
        if (!p || p.ws) { refuse(ws, log); return; }
        p.ws = ws;
        p.joined = true;
        p.lastSeen = Date.now();
        ws.binaryType = 'nodebuffer';

        // a slot connecting while not-ingame is a drop-in: stream the history
        // so it can re-simulate to the frontier; live bundles follow
        if (!p.ingame) {
            if (session.historyFull) {
                refuse(ws, log, `game: ${COLORS[slot]} refused — session is past the ${MAX_HISTORY_TICS}-tic history cap, catch-up cannot be served`);
                return;
            }
            p.joining = true;
            p.reservedAt = p.reservedAt || Date.now();
            if (!burstHistory(ws, `game: ${COLORS[slot]}`)) return;
            log(`game: ${COLORS[slot]} catching up (${session.historyLen} tics)`);
        }

        ws.on('message', buf => {
            if (!rateOk(ws)) return;
            if (!session || buf.length !== 4 + CMD_SIZE) return;
            const tic = buf.readUInt32LE(0);
            p.sentAny = true;
            p.lastSeen = Date.now();
            // a joiner's first cmd means it caught up: promote it a short
            // margin ahead so its cmds are ready by the join tic
            if (p.joining && !p.ingame && !p.joinAt) {
                p.joinAt = session.tic + JOIN_MARGIN;
                log(`game: ${COLORS[slot]} live — dropping in at tic ${p.joinAt}`);
            }
            if (tic < session.tic || tic > session.tic + 512) return;  // sealed or absurd
            p.cmds.set(tic, buf.subarray(4));
            seal();
        });
        ws.on('close', () => {
            if (!session) return;
            p.ws = null;
            p.ingame = false;
            p.joining = false;
            p.joinAt = 0;
            log(`game: ${COLORS[p.slot]} disconnected`);
            if (session.players.every(q => !q.ingame)) endSession('all players left');
        });
    }

    const allJoined = () => session.players.every(p => p.joined || !p.ingame);

    // Seal every tic whose live cmds are all present.  The live set is
    // recomputed each pass: sealTic may promote a drop-in mid-loop.
    function seal() {
        if (!session || !allJoined()) return;
        for (;;) {
            const live = session.players.filter(p => p.ingame);
            if (!live.length || !live.every(p => p.cmds.has(session.tic))) break;
            sealTic();
        }
    }

    // Grace/drop sweep: keeps the game moving when a client stalls.
    function sealSweep() {
        if (!session) return;
        const now = Date.now();
        // a reservation that never went live must not hold the slot
        for (const p of session.players)
            if (p.joining && !p.ingame && now - (p.reservedAt || now) > JOIN_TIMEOUT_MS) {
                p.joining = false;
                p.reservedAt = 0;
                if (p.ws) { p.ws.close(); p.ws = null; }
                log(`game: ${COLORS[p.slot]} join timed out — slot freed`);
            }
        // a client that never connected cannot block the launch forever
        if (now - session.launched > NEVER_JOINED_MS)
            for (const p of session.players)
                if (!p.joined && p.ingame) {
                    p.ingame = false;
                    log(`game: ${COLORS[p.slot]} never joined — dropped`);
                }
        if (session.players.every(q => !q.ingame)) { endSession('nobody joined'); return; }
        const live = session.players.filter(p => p.ingame);
        if (!live.length || !allJoined()) return;
        // no fabrication until the game is rolling — wasm boot times differ
        if (!live.every(p => p.sentAny) && now - session.launched < NEVER_JOINED_MS) return;
        const laggards = live.filter(p => !p.cmds.has(session.tic));
        if (!laggards.length) return;
        for (const p of laggards) {
            if (now - p.lastSeen > DROP_MS) {
                p.ingame = false;
                p.ws?.close();
                log(`game: ${COLORS[p.slot]} dropped (unresponsive)`);
            }
        }
        if (laggards.some(p => p.ingame) &&
            now - Math.min(...laggards.map(p => p.lastSeen)) < GRACE_MS)
            return;
        sealTic();      // fabricate what's missing, once per sweep
        seal();
    }

    // bundle: [u32 tic][u8 ingameMask][u8 fabricatedMask][ticcmd × n].
    // A fabricated cmd carries no valid consistancy checksum; the flag tells
    // clients to skip the desync comparison for exactly those.
    function sealTic() {
        const tic = session.tic++;
        // a drop-in goes live exactly at its scheduled tic, so every client
        // flips the ingame bit on the same sealed tic and spawns it in lockstep
        for (const p of session.players)
            if (p.joinAt && tic >= p.joinAt) {
                p.ingame = true;
                p.joinAt = 0;
                log(`game: ${COLORS[p.slot]} dropped in at tic ${tic}`);
            }
        const size = 6 + CMD_SIZE * session.numplayers;
        let buf;
        if (session.historyLen < MAX_HISTORY_TICS) {
            // retained: the next slot of the current slab (every byte is written)
            if (session.historyLen % SLAB_TICS === 0) session.slabs.push(Buffer.allocUnsafe(size * SLAB_TICS));
            const off = (session.historyLen % SLAB_TICS) * size;
            buf = session.slabs[session.slabs.length - 1].subarray(off, off + size);
            session.historyLen++;
        } else {
            if (!session.historyFull) {
                session.historyFull = true;
                log(`game: history cap reached (${MAX_HISTORY_TICS} tics) — drop-in and spectating are closed for this session; play continues`);
            }
            buf = session.scratch ??= Buffer.alloc(size);
        }
        buf.writeUInt32LE(tic, 0);
        let mask = 0, fab = 0;
        session.players.forEach((p, i) => {
            if (p.ingame) mask |= 1 << i;
            let cmd = p.cmds.get(tic);
            if (!cmd) { fab |= 1 << i; cmd = p.last; }
            cmd.copy(buf, 6 + i * CMD_SIZE);
            if (cmd !== p.last) cmd.copy(p.last);     // p.last is allocated once per player
            p.cmds.delete(tic);
        });
        buf[4] = mask;
        buf[5] = fab;
        for (const p of session.players)
            if (p.ws?.readyState === 1) p.ws.send(buf);
        for (const sw of session.spectators)
            if (sw.readyState === 1) sw.send(buf);
    }

    // --- ws mounting ---------------------------------------------------------
    // maxPayload: lobby frames are small JSON, relay frames 12 bytes; the
    // spectate endpoint has no message handler at all.  perMessageDeflate
    // off: compressing 12-byte latency-critical packets only adds delay.
    const lobbyWss    = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    const gameWss     = new WebSocketServer({ noServer: true, maxPayload: 64,   perMessageDeflate: false });
    const spectateWss = new WebSocketServer({ noServer: true, maxPayload: 64,   perMessageDeflate: false });
    for (const [wss, tag] of [[lobbyWss, 'lobby'], [gameWss, 'game'], [spectateWss, 'spectate']])
        wss.on('error', err => log(`${tag}Wss error: ${err?.message ?? err}`));

    // one connection counter, at the connection event, so every accepted
    // socket has exactly one increment and one decrement
    const capped = (wss, what, connect) => wss.on('connection', (ws, req) => {
        if (connCount >= MAX_CONNS) {
            refuse(ws, log, `conn cap hit (${connCount}/${MAX_CONNS}): rejecting ${what} connection`);
            return;
        }
        connCount++;
        ws.on('close', () => connCount--);
        connect(ws, req);
    });
    capped(lobbyWss,    'lobby',    ws => lobbyConnect(ws));
    capped(gameWss,     'game',     (ws, req) => relayConnect(ws, req.url));
    capped(spectateWss, 'spectate', ws => spectateConnect(ws));

    return {
        // What is going on right now, for an operator: counts only, never names,
        // slots or addresses.  tools/deploy.sh refuses to restart the service
        // while a game is live, and check@webdoom reads the same route -- both
        // need this to be cheap and to require no lobby connection.
        status() {
            return {
                session: !!session,
                players: session ? session.players.filter(p => p.ingame).length : 0,
                spectators: session ? session.spectators.size : 0,
                lobby: lobby.size,
                tic: session ? session.tic : 0,
            };
        },
        upgrade(req, socket, head) {
            // a URL llhttp accepts and the WHATWG parser rejects must not throw
            let path;
            try { path = new URL(req.url, 'http://x').pathname; }
            catch { socket.destroy(); return; }
            const wss = path === '/ws/lobby' ? lobbyWss
                      : path === '/ws/game'  ? gameWss
                      : path === '/ws/spectate' ? spectateWss
                      : null;
            if (!wss) { socket.destroy(); return; }
            socket.setNoDelay(true);    // no Nagle on tiny, time-critical frames
            wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
        },
    };
}
