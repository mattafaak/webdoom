// webdoom lobby + tic relay. One lobby (LAN-party model), arcade slots:
// join order = slot = color. Any player sets params or hits start.
//
// Relay: clients send [u32 tic][8B ticcmd]; when every live player's
// cmd for tic T is in, the server broadcasts a sealed bundle
// [u32 tic][u8 ingameMask][ticcmd × numplayers]. WebSocket (TCP) makes
// delivery ordered+reliable — no resend protocol exists or is needed.
// A player silent past the grace window gets their last cmd duplicated
// (bounded stall for others); past the drop window they're marked out.
import { WebSocketServer } from 'ws';

const COLORS = ['Green', 'Indigo', 'Brown', 'Red'];
const MAXPLAYERS = 4;
const CMD_SIZE = 8;
const GRACE_MS = 250;       // fabricate a missing cmd after this
const DROP_MS = 5000;       // remove the player after this
const JOIN_MARGIN = 12;     // tics between a drop-in going live and spawning
const JOIN_TIMEOUT_MS = +(process.env.WEBDOOM_JOIN_TIMEOUT || 30000);  // reclaim a stalled reservation

// Resource caps — all sized well above legitimate LAN 4-player play at 35 Hz.
// 4 players × 2 sockets each + 10 lobby observers = 18 legit; 50 gives 2.7× headroom.
const MAX_CONNS = +(process.env.WEBDOOM_MAX_CONNS || 50);
// 4 players × 35 Hz = 140 msg/s aggregate; per-conn cap at 300 gives a single client
// 2× the full-table aggregate — plenty for legit play, kills flood attacks.
const RATE_CAP_PER_SEC = +(process.env.WEBDOOM_RATE_CAP || 300);
const RATE_WINDOW_MS = 1000;

const defaultParams = () => ({
    wad: 'doom.wad', episode: 1, map: 1, skill: 3, mode: 'coop',
    nomonsters: false, fast: false, respawn: false, timer: 0,
});

// Attach a no-op error handler so protocol violations (e.g. maxPayload exceeded,
// malformed frame) are absorbed rather than propagated as uncaught exceptions.
// The ws library terminates the socket on its own after emitting 'error';
// the 'close' event fires next and any normal cleanup runs from there.
function safeWs(ws, log, tag) {
    ws.on('error', err => {
        log(`ws error [${tag}]: ${err?.message ?? err}`);
        try { ws.terminate(); } catch {}
    });
    return ws;
}

// Per-connection rate guard. Returns true and increments the counter if the
// message is within the rate cap; returns false (and terminates the socket) if
// the client is flooding. State is attached directly to the ws object.
//
// Window model: TUMBLING (fixed-duration, non-overlapping). When the first
// message arrives after the previous window closed, a fresh window starts at
// that moment. This means a client can burst up to 2× RATE_CAP_PER_SEC across
// a window boundary (tail of old window + head of new). That ~2× headroom is
// intentional: legitimate 35 Hz play never hits 300 msg/s, while a flood attack
// sustains far above it and is caught within the very next window.
function rateOk(ws) {
    const now = Date.now();
    if (!ws._rateTs || now - ws._rateTs >= RATE_WINDOW_MS) {
        ws._rateTs = now;
        ws._rateCount = 0;
    }
    ws._rateCount++;
    if (ws._rateCount > RATE_CAP_PER_SEC) {
        // Flooding: terminate immediately, don't send a close frame (avoids
        // being stuck in CLOSING while the attacker ignores the handshake).
        try { ws.terminate(); } catch {}
        return false;
    }
    return true;
}

export function createGame(log = console.log) {
    // --- lobby state -------------------------------------------------------
    const lobby = new Map();        // slot → {ws, name} (name null = color default)
    let params = defaultParams();
    let session = null;             // active relay session or null
    let connCount = 0;              // total open ws connections (lobby + game + spectate)

    const displayName = slot => lobby.get(slot)?.name ?? COLORS[slot];
    const roster = () => ({
        t: 'roster',
        players: [...lobby.keys()].sort().map(s =>
            ({ slot: s, color: COLORS[s], name: displayName(s) })),
        freeSlots: [0, 1, 2, 3].filter(s => !lobby.has(s)),
        params,
        inGame: !!session,
    });
    const cast = msg => {
        const s = JSON.stringify(msg);
        for (const p of lobby.values()) if (p.ws.readyState === 1) p.ws.send(s);
    };

    function lobbyConnect(ws) {
        safeWs(ws, log, 'lobby');

        // Join in progress: a game is live. Show the newcomer a summary and
        // let them choose to drop in — no slot is reserved until they ask, so
        // merely looking never blocks a slot.
        if (session) {
            const inProgress = () => ({
                t: 'inprogress',
                params: session.params,
                frontier: session.tic,
                players: session.players.filter(p => p.ingame || p.joining).map(p =>
                    ({ slot: p.slot, color: COLORS[p.slot], name: session.names?.[p.slot] ?? COLORS[p.slot], live: p.ingame })),
                freeSlots: session.players.filter(p => !p.ingame && !p.joining).map(p => p.slot),
            });
            ws.send(JSON.stringify(inProgress()));
            let mySlot = -1;
            ws.on('message', raw => {
                if (!rateOk(ws)) return;
                let m; try { m = JSON.parse(raw); } catch { return; }
                if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', t0: m.t0 })); return; }
                if (!session) { ws.send(JSON.stringify({ t: 'full', reason: 'game over' })); return; }
                if (m.t === 'join' && mySlot < 0) {
                    const want = Number.isInteger(m.slot) ? m.slot : -1;
                    const p = session.players.find(q => q.slot === want && !q.ingame && !q.joining && !q.ws)
                        ?? session.players.find(q => !q.ingame && !q.joining && !q.ws);
                    if (!p) { ws.send(JSON.stringify({ t: 'full', reason: 'game full' })); return; }
                    mySlot = p.slot;
                    p.joining = true;
                    p.reservedAt = Date.now();
                    const nm = String(m.name ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 10);
                    if (nm) { session.names = session.names ?? [null, null, null, null]; session.names[p.slot] = nm; }
                    ws.send(JSON.stringify({ t: 'welcome', slot: p.slot, color: COLORS[p.slot] }));
                    ws.send(JSON.stringify({ t: 'launch', params: session.params, numplayers: MAXPLAYERS,
                        slots: session.slots, names: session.names, join: true, frontier: session.tic }));
                    log(`lobby: ${COLORS[p.slot]} dropping in (frontier ${session.tic})`);
                }
            });
            ws.on('close', () => {
                const p = mySlot >= 0 && session?.players[mySlot];
                if (p && !p.ingame && !p.ws) { p.joining = false; p.reservedAt = 0; }
            });
            return;
        }

        let slot = 0;
        while (lobby.has(slot)) slot++;
        if (slot >= MAXPLAYERS) {
            ws.send(JSON.stringify({ t: 'full', reason: 'lobby full' }));
            // Use terminate() for the refused connection: avoids leaving the
            // socket in CLOSING state if the client ignores the close frame.
            try { ws.terminate(); } catch {}
            return;
        }
        lobby.set(slot, { ws, name: null });
        ws.send(JSON.stringify({ t: 'welcome', slot, color: COLORS[slot] }));
        cast(roster());
        log(`lobby: ${COLORS[slot]} joined (${lobby.size} in lobby)`);

        ws.on('message', raw => {
            if (!rateOk(ws)) return;
            let m;
            try { m = JSON.parse(raw); } catch { return; }
            if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', t0: m.t0 })); return; }
            if (session) return;
            if (m.t === 'name') {
                const name = String(m.name ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 10);
                lobby.get(slot).name = name || null;
                cast(roster());
                return;
            }
            if (m.t === 'slot') {
                // color choice IS slot choice (the engine colors by slot)
                const want = +m.slot;
                if (want >= 0 && want < MAXPLAYERS && !lobby.has(want) && want !== slot) {
                    lobby.set(want, lobby.get(slot));
                    lobby.delete(slot);
                    slot = want;
                    ws.send(JSON.stringify({ t: 'welcome', slot, color: COLORS[slot] }));
                    cast(roster());
                }
                return;
            }
            if (m.t === 'params') {
                const p = { ...params, ...m.params };
                params = {
                    wad: String(p.wad).replace(/[^a-z0-9_.-]/g, ''),
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
            }
            if (m.t === 'start' && lobby.size >= 1) startGame();
        });
        ws.on('close', () => {
            lobby.delete(slot);
            cast(roster());
            log(`lobby: ${COLORS[slot]} left`);
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
            history: [],                // every sealed bundle, for drop-in and spectator catch-up
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
        for (const sw of session.spectators) try { sw.close(); } catch {}
        session = null;
        log(`game: over (${reason})`);
        cast(roster());
    }

    // --- spectator endpoint ---------------------------------------------------
    // A spectator is a receive-only observer: it gets the full sealed-bundle
    // history as a burst on connect, then follows live bundles. The handler has
    // NO ws.on('message') listener — zero ticcmd write code by design — so
    // injection is structurally impossible, not just guarded by a flag.
    function spectateConnect(ws) {
        safeWs(ws, log, 'spectate');
        if (!session) { try { ws.terminate(); } catch {} return; }
        for (const b of session.history) ws.send(b);
        session.spectators.add(ws);
        log(`spectate: observer connected (history ${session.history.length} tics)`);
        ws.on('close', () => {
            session?.spectators.delete(ws);
            log('spectate: observer disconnected');
        });
    }

    function relayConnect(ws, url) {
        safeWs(ws, log, 'game');

        // Validate slot: must be an integer 0–3, session must exist, slot must
        // be unoccupied. Use terminate() for any rejection — avoids leaving
        // the socket in CLOSING state if the client ignores the close frame,
        // and makes the rejection visible immediately on the client side.
        let slot;
        try { slot = +new URL(url, 'http://x').searchParams.get('slot'); } catch {
            try { ws.terminate(); } catch {}
            return;
        }
        if (!Number.isFinite(slot) || slot < 0 || slot >= MAXPLAYERS || !Number.isInteger(slot)) {
            try { ws.terminate(); } catch {}
            return;
        }
        const p = session?.players.find(p => p.slot === slot);
        if (!p || p.ws) {
            // Slot occupied or no session: reject immediately with terminate()
            // so the client sees an error/close without waiting for the close
            // handshake, and the slot owner is unaffected.
            try { ws.terminate(); } catch {}
            return;
        }
        p.ws = ws;
        p.joined = true;
        p.lastSeen = Date.now();
        ws.binaryType = 'nodebuffer';

        // Drop-in: a slot connecting while not-ingame during a live game is a
        // joiner. Stream the whole sealed history so it can re-simulate to the
        // current frontier; live bundles then follow via sealTic's broadcast.
        if (!p.ingame) {
            p.joining = true;
            p.reservedAt = p.reservedAt || Date.now();
            for (const b of session.history) ws.send(b);
            log(`game: ${COLORS[slot]} catching up (${session.history.length} tics)`);
        }

        ws.on('message', buf => {
            if (!rateOk(ws)) return;
            if (!session || buf.length !== 4 + CMD_SIZE) return;
            const tic = buf.readUInt32LE(0);
            p.sentAny = true;
            p.lastSeen = Date.now();
            // a joiner's first cmd means it caught up and went live: promote
            // it a short margin ahead so its cmds are ready by the join tic
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

    // Seal every tic whose live cmds are all present. Recompute the live set
    // each pass: sealTic may promote a drop-in mid-loop, and the next tic
    // must then wait for that new player's cmd rather than fabricating it.
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
        // reclaim a drop-in reservation that never caught up and went live in
        // the window — a crashed or abandoned joiner must not hold a slot
        for (const p of session.players)
            if (p.joining && !p.ingame && now - (p.reservedAt || now) > JOIN_TIMEOUT_MS) {
                p.joining = false;
                p.reservedAt = 0;
                if (p.ws) { p.ws.close(); p.ws = null; }
                log(`game: ${COLORS[p.slot]} join timed out — slot freed`);
            }
        // a client that never connected can't block the launch forever
        if (now - session.launched > 10000)
            for (const p of session.players)
                if (!p.joined && p.ingame) {
                    p.ingame = false;
                    log(`game: ${COLORS[p.slot]} never joined — dropped`);
                }
        if (session.players.every(q => !q.ingame)) { endSession('nobody joined'); return; }
        const live = session.players.filter(p => p.ingame);
        if (!live.length || !allJoined()) return;
        // no fabrication until the game is rolling — wasm boot times differ
        if (!live.every(p => p.sentAny) && now - session.launched < 10000) return;
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
    // Fabricated cmds carry no valid consistancy checksum — the flag tells
    // clients to skip the desync comparison for exactly those, keeping the
    // detector fully armed for every real cmd.
    function sealTic() {
        const tic = session.tic++;
        // A drop-in goes live exactly at its scheduled tic — every client
        // sees the ingame bit flip on the same sealed tic and spawns it in
        // lockstep (engine's PST_REBORN path).
        for (const p of session.players)
            if (p.joinAt && tic >= p.joinAt) {
                p.ingame = true;
                p.joinAt = 0;
                log(`game: ${COLORS[p.slot]} dropped in at tic ${tic}`);
            }
        const buf = Buffer.alloc(6 + CMD_SIZE * session.numplayers);
        buf.writeUInt32LE(tic, 0);
        let mask = 0, fab = 0;
        session.players.forEach((p, i) => {
            if (p.ingame) mask |= 1 << i;
            let cmd = p.cmds.get(tic);
            if (!cmd) { fab |= 1 << i; cmd = p.last; }
            cmd.copy(buf, 6 + i * CMD_SIZE);
            p.last = Buffer.from(cmd);
            p.cmds.delete(tic);
        });
        buf[4] = mask;
        buf[5] = fab;
        session.history.push(buf);      // for drop-in and spectator catch-up replay
        for (const p of session.players)
            if (p.ws?.readyState === 1) p.ws.send(buf);
        // Broadcast sealed bundle to all spectators (same bundle, same tic).
        for (const sw of session.spectators)
            if (sw.readyState === 1) sw.send(buf);
    }

    // --- ws mounting ---------------------------------------------------------
    // maxPayload: lobby messages are small JSON, relay messages are 12
    // bytes — anything bigger is garbage (default cap is 100MB).
    // perMessageDeflate off: compressing 12-byte, latency-critical packets
    // only burns CPU and adds delay; pin it so a ws default flip can't
    // silently re-enable it.
    const lobbyWss    = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    const gameWss     = new WebSocketServer({ noServer: true, maxPayload: 64,   perMessageDeflate: false });
    // spectateWss: receive-only — maxPayload 64 accepts zero-payload pings only;
    // no ws.on('message') in spectateConnect so even those are no-ops.
    const spectateWss = new WebSocketServer({ noServer: true, maxPayload: 64,   perMessageDeflate: false });

    // Absorb server-level errors (e.g. bad handshake packets) so the process
    // doesn't exit if a single malformed upgrade sneaks through.
    lobbyWss.on('error',    err => log(`lobbyWss error: ${err?.message ?? err}`));
    gameWss.on('error',     err => log(`gameWss error: ${err?.message ?? err}`));
    spectateWss.on('error', err => log(`spectateWss error: ${err?.message ?? err}`));

    // Connection cap: connCount tracks every open socket across both endpoints.
    // Managed here (at connection event level) so every accepted socket has
    // exactly one increment and one decrement — regardless of what the handler
    // does internally (lobby-full reject, slot-occupied reject, etc.).
    lobbyWss.on('connection', ws => {
        if (connCount >= MAX_CONNS) {
            log(`conn cap hit (${connCount}/${MAX_CONNS}): rejecting lobby connection`);
            // Absorb errors before terminate(): a frame racing in between the
            // WebSocket handshake completing and terminate() firing would
            // otherwise emit an unhandled 'error' and crash the process.
            ws.on('error', () => {});
            try { ws.terminate(); } catch {}
            return;
        }
        connCount++;
        ws.on('close', () => connCount--);
        lobbyConnect(ws);
    });

    gameWss.on('connection', (ws, req) => {
        if (connCount >= MAX_CONNS) {
            log(`conn cap hit (${connCount}/${MAX_CONNS}): rejecting game connection`);
            // Absorb errors before terminate() — same race as lobby cap above.
            ws.on('error', () => {});
            try { ws.terminate(); } catch {}
            return;
        }
        connCount++;
        ws.on('close', () => connCount--);
        relayConnect(ws, req.url);
    });

    spectateWss.on('connection', ws => {
        if (connCount >= MAX_CONNS) {
            log(`conn cap hit (${connCount}/${MAX_CONNS}): rejecting spectate connection`);
            ws.on('error', () => {});
            try { ws.terminate(); } catch {}
            return;
        }
        connCount++;
        ws.on('close', () => connCount--);
        spectateConnect(ws);
    });

    return {
        upgrade(req, socket, head) {
            // Guard against malformed upgrade URLs (e.g. raw control bytes that
            // llhttp lets through but the WHATWG URL ctor rejects). Without the
            // try/catch, a TypeError here is uncaught and crashes the process.
            let path;
            try { path = new URL(req.url, 'http://x').pathname; }
            catch { socket.destroy(); return; }
            const wss = path === '/ws/lobby' ? lobbyWss
                      : path === '/ws/game'  ? gameWss
                      : path === '/ws/spectate' ? spectateWss
                      : null;
            if (!wss) { socket.destroy(); return; }
            // Kill Nagle: ticcmds and bundles are tiny and time-critical, so
            // batching them behind delayed-ACK would add tens of ms of lag.
            socket.setNoDelay(true);
            wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
        },
    };
}
