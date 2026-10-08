// webdoom lobby + tic relay. One lobby (LAN-party model), arcade slots:
// join order = slot = color. Any player sets params or hits start.
//
// Relay: clients send [u32 tic][8B ticcmd]; when every live player's
// cmd for tic T is in, the server broadcasts a sealed bundle
// [u32 tic][u8 ingameMask][u8 fabricatedMask][ticcmd × numplayers].
// WebSocket (TCP) makes delivery ordered+reliable — no resend protocol exists
// or is needed. A player silent past the grace window no longer holds the
// seal: its last cmd is repeated and the others play on at their own pace;
// past the drop window it is out, and told why.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { envInt } from './env.js';

const COLORS = ['Green', 'Indigo', 'Brown', 'Red'];
const MAXPLAYERS = 4;
const CMD_SIZE = 8;
const SWEEP_MS = 50;            // the grace/drop sweep's period (sealSweep)
const GRACE_MS = 250;           // fabricate a missing cmd after this
const QUIET_SWEEPS = GRACE_MS / SWEEP_MS;   // sweeps unheard while others were heard: silent
const DROP_MS = 5000;           // remove the player after this
// the close reason a dropped player's client shows (net.js shows ev.reason);
// 4000 is the first code the WebSocket spec leaves to applications
const DROP_CODE = 4000;
const DROP_REASON = `dropped by the server: no input from this player for ${DROP_MS / 1000} seconds`;
// ticcmd_t's last two bytes (engine/core/d_ticcmd.h): chatchar, then buttons,
// whose BT_SPECIAL bit (d_event.h) makes the rest a pause or a savegame
const CMD_CHATCHAR = 6, CMD_BUTTONS = 7, BT_SPECIAL = 0x80;
const NEVER_JOINED_MS = 10000;  // a launched player that never connected is dropped
const JOIN_MARGIN = 12;         // tics between a drop-in going live and spawning
const JOIN_TIMEOUT_MS = envInt('WEBDOOM_JOIN_TIMEOUT', 30000);   // reclaim a stalled reservation

// Resource caps, all well above legitimate 4-player LAN play at 35 Hz.
// 4 players × 2 sockets + observers = ~18 legit connections.
const MAX_CONNS = envInt('WEBDOOM_MAX_CONNS', 50);
// spectators need no slot and no credential, so they get their own cap
const MAX_SPECTATORS = envInt('WEBDOOM_MAX_SPECTATORS', 8);
// a peer with more than this queued is not reading and is dropped (sendTo)
const SEND_BACKLOG_CAP = envInt('WEBDOOM_SEND_BACKLOG', 4 * 1024 * 1024);
// The sealed history -- one 38-byte bundle per tic -- is kept from tic 0
// because drop-in and spectator catch-up replay it whole; a ring would hand
// a joiner a prefix and desync it silently.  So it stops growing at the cap
// and those two features refuse past it; live play continues.  It lives in
// 1,024-tic slabs: one Buffer object per tic would cost ~460 B of RSS
// each (28.8 MB for the 63,000-tic cap, measured after GC); the slabs hold
// the same bundles in 8.1 MB, and a view is made only while one is sent.
const MAX_HISTORY_TICS = envInt('WEBDOOM_MAX_HISTORY_TICS', 35 * 60 * 30);
const SLAB_TICS = 1024;
// 4 players × 35 Hz = 140 msg/s aggregate; 300 per connection is 2× that
const RATE_CAP_PER_SEC = envInt('WEBDOOM_RATE_CAP', 300);
const RATE_WINDOW_MS = 1000;

// Lobby fields arrive from the network as whatever JSON the sender chose.
// String() and unary + call an object's own toString/valueOf, and one that is
// not callable throws -- inside the 'message' listener, where a throw wedges
// that socket's receiver for good.  So only a string or number is coerced;
// anything else reads as absent.
const prim = v => typeof v === 'string' || typeof v === 'number';
const str = v => prim(v) ? String(v) : '';
const num = v => prim(v) ? +v : NaN;
const cleanName = n => str(n).replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 10);

// A seat token binds a slot to the lobby socket it was given to: a launched
// seat's token goes only to that seat's lobby socket, a drop-in's only to the
// observer that reserved it, and /ws/game binds a slot only with the slot's
// current token.  The slot number alone is public (the roster lists it).
const newToken = () => randomBytes(16).toString('hex');
const tokenMatches = (given, want) => {
    if (typeof given !== 'string' || typeof want !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
};

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

// Whether anything more may be queued to this peer.  ws.send() and ws.pong()
// queue in the Node heap once the kernel buffers are full, so a peer that
// stops reading would pull everything sent to it -- a history burst, every
// live bundle, every roster, every pong -- into server memory.  Past
// SEND_BACKLOG_CAP it is refused instead.
function canSend(ws, log, who) {
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount > SEND_BACKLOG_CAP) {
        refuse(ws, log, `${who}: not reading (${ws.bufferedAmount} B queued) — dropping`);
        return false;
    }
    return true;
}
// The one way to send.  Returns whether the data was queued.
function sendTo(ws, data, log, who) {
    if (!canSend(ws, log, who)) return false;
    ws.send(data);
    return true;
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
// Counts messages and pings alike.  Refuses the socket on a flood and
// returns false.
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
        for (const p of lobby.values()) sendTo(p.ws, s, log, 'lobby');
    };

    // A lobby socket is one of two things: a seat in the lobby (slot >= 0,
    // before a game starts) or an observer of a live game, who reserves a
    // slot only on `join` -- so merely looking never blocks one.
    function lobbyConnect(ws) {
        safeWs(ws, log, 'lobby');
        const reply = m => sendTo(ws, JSON.stringify(m), log, 'lobby');
        let slot = -1;          // lobby seat
        let reserved = -1;      // drop-in reservation
        let reservedIn = null;  // ...and the session it was made in
        let reservedToken = null;   // ...and the token that says it is still ours

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
            if (!m || typeof m !== 'object') return;
            if (m.t === 'ping') { reply({ t: 'pong', t0: m.t0 }); return; }

            if (slot < 0) {     // observer of a live game
                if (!session) { reply({ t: 'full', reason: 'game over' }); return; }
                if (m.t !== 'join' || reserved >= 0) return;
                const want = Number.isInteger(m.slot) ? m.slot : -1;
                const p = session.players.find(q => q.slot === want && !q.ingame && !q.joining && !q.ws)
                    ?? session.players.find(q => !q.ingame && !q.joining && !q.ws);
                if (!p) { reply({ t: 'full', reason: 'game full' }); return; }
                reserved = p.slot;
                reservedIn = session;
                reservedToken = p.token = newToken();
                p.joining = true;
                p.reservedAt = Date.now();
                const nm = cleanName(m.name);
                if (nm) { session.names = session.names ?? [null, null, null, null]; session.names[p.slot] = nm; }
                reply({ t: 'welcome', slot: p.slot, color: COLORS[p.slot] });
                reply({ t: 'launch', params: session.params, numplayers: MAXPLAYERS,
                        slots: session.slots, names: session.names, join: true, frontier: session.tic,
                        token: reservedToken });
                log(`lobby: ${COLORS[p.slot]} dropping in (frontier ${session.tic})`);
                return;
            }

            if (session) return;    // the lobby is frozen once a game starts
            if (m.t === 'name') {
                lobby.get(slot).name = cleanName(m.name) || null;
                cast(roster());
            } else if (m.t === 'slot') {
                // color choice IS slot choice (the engine colors by slot)
                const want = num(m.slot);
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
                const wantWad = str(p.wad).replace(/[^a-z0-9_.-]/g, '');
                let served = [];
                try { served = servedWads() ?? []; }
                catch (e) { log(`lobby: cannot read the WAD library (${e?.message ?? e}) — refusing every wad change`); }
                const wadOk = Array.isArray(served) && served.includes(wantWad);
                if (!wadOk && wantWad !== params.wad)
                    log(`lobby: refusing wad "${wantWad}" — not in this server's library; keeping "${params.wad}"`);
                params = {
                    wad: wadOk ? wantWad : params.wad,
                    episode: Math.max(1, Math.min(9, num(p.episode) || 1)),
                    map: Math.max(1, Math.min(32, num(p.map) || 1)),
                    skill: Math.max(1, Math.min(5, num(p.skill) || 3)),
                    mode: ['coop', 'deathmatch', 'altdeath'].includes(p.mode) ? p.mode : 'coop',
                    nomonsters: !!p.nomonsters,
                    fast: !!p.fast,
                    respawn: !!p.respawn,
                    timer: [0, 5, 10, 15, 20, 30].includes(num(p.timer)) ? num(p.timer) : 0,
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
            // Release the reservation only while it is still this socket's: a
            // timed-out one may since have been given to another observer.
            const p = reserved >= 0 && session === reservedIn && session.players[reserved];
            if (p && p.token === reservedToken && !p.ingame && !p.ws) {
                p.joining = false;
                p.reservedAt = 0;
                p.token = null;
            }
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
                token: null,            // the seat token /ws/game must present (newToken)
                cmds: new Map(),        // tic → Buffer(8)
                last: Buffer.alloc(CMD_SIZE),   // the cmd a fabricated tic repeats
                lastSeen: Date.now(),           // last filled the tic being sealed
                lastHeard: Date.now(),          // last sent any well-formed frame
                quiet: 0,                       // sweeps unheard while others were heard
                silent: false,                  // judged silent by sealSweep; any frame clears it
                ingame: lobby.has(slot),
                joined: !lobby.has(slot),
                joining: false,         // a drop-in holds this slot (reserved, or catching up)
                reservedAt: 0,          // when that hold began; 0 = none
                joinAt: 0,              // the tic the drop-in enters at; 0 = not scheduled
                sentAny: false,         // this seat has sent at least one cmd
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
            spectators: new Set(),      // read-only observers; never in session.players
        };
        // The countdown belongs to the session that started it.  One that ends
        // and is restarted inside a second would otherwise run two chains on
        // the new session: two launches, and two sweeps of which endSession
        // can clear only one.
        const me = session;
        let n = 3;
        const tick = () => {
            if (session !== me) return;
            if (n > 0) { cast({ t: 'countdown', n: n-- }); me.timer = setTimeout(tick, 1000); return; }
            const names = [0, 1, 2, 3].map(s => lobby.has(s) ? displayName(s) : null);
            me.names = names;
            // each seat's launch frame carries that seat's token and no other
            for (const [s, member] of lobby) {
                me.players[s].token = newToken();
                sendTo(member.ws, JSON.stringify({ t: 'launch', params, numplayers: MAXPLAYERS, slots, names,
                                                  token: me.players[s].token }), log, 'lobby');
            }
            log(`game: launching ${slots.length}p (slots ${slots.join(',')}) ${params.wad} E${params.episode}M${params.map} skill ${params.skill} ${params.mode}`);
            me.launched = me.lastSweep = Date.now();
            // The sweep runs from setImmediate, after the event loop's poll
            // phase: when the relay has been stalled (GC, a starved host), every
            // frame that queued up meanwhile is read before anyone is judged
            // late or silent.  The session check keeps a sweep queued by an
            // ended session off its successor.
            me.timer = setInterval(() => setImmediate(() => { if (session === me) sealSweep(); }), SWEEP_MS);
        };
        tick();
    }

    function endSession(reason) {
        if (!session) return;
        // the pending countdown tick or the seal sweep: the two share one
        // timer list, so clearInterval cancels either
        clearInterval(session.timer);
        for (const p of session.players) p.ws?.close();
        for (const sw of session.spectators) try { sw.close(); } catch { /* gone */ }
        session = null;
        log(`game: over (${reason})`);
        cast(roster());
    }

    // Stream the whole sealed history to a joining socket.  Returns false when
    // the socket was refused for not reading it.
    function burstHistory(ws, who) {
        const size = 6 + CMD_SIZE * session.numplayers;
        for (let i = 0; i < session.historyLen; i++) {
            const off = (i % SLAB_TICS) * size;
            if (!sendTo(ws, session.slabs[Math.floor(i / SLAB_TICS)].subarray(off, off + size), log, who))
                return false;
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
        const me = session;
        me.spectators.add(ws);
        log(`spectate: observer connected (history ${me.historyLen} tics)`);
        ws.on('close', () => {
            me.spectators.delete(ws);
            log('spectate: observer disconnected');
        });
    }

    function relayConnect(ws, url) {
        safeWs(ws, log, 'game');
        // slot must be an integer 0–3 naming an unoccupied seat of a live
        // session, and token must be that seat's current token
        let slot, token;
        try {
            // `+null` is 0 and Number.isInteger(0) is true, so a connection
            // with NO ?slot at all would bind slot 0: a client bug becomes a
            // silently wrong game rather than a refusal.
            const q = new URL(url, 'http://x').searchParams;
            const raw = q.get('slot');
            if (raw === null) { refuse(ws, log); return; }
            slot = +raw;
            token = q.get('token');
        } catch { refuse(ws, log); return; }
        if (!Number.isInteger(slot) || slot < 0 || slot >= MAXPLAYERS) { refuse(ws, log); return; }
        const p = session?.players.find(p => p.slot === slot);
        if (!p || p.ws || !tokenMatches(token, p.token)) { refuse(ws, log); return; }
        // A socket speaks for its slot only while it holds it.  A timed-out
        // joiner, or any socket of a session that has ended, can stay in
        // CLOSING for up to ws's 30 s close timeout -- long enough for a new
        // socket to bind the slot -- and its late frames and 'close' must not
        // act on that binding or on a newer session.
        const me = session;
        const mine = () => session === me && p.ws === ws;
        p.ws = ws;
        p.joined = true;
        p.lastSeen = p.lastHeard = Date.now();
        p.quiet = 0;                // a slot's last occupant may have been silent
        p.silent = false;
        ws.binaryType = 'nodebuffer';

        // a slot connecting while not-ingame is a drop-in: stream the history
        // so it can re-simulate to the frontier; live bundles follow
        if (!p.ingame) {
            // Both refusals below happen AFTER `p.ws = ws` and BEFORE the
            // 'close' handler that undoes it is registered, so each releases
            // the slot by hand.  Left pointing at a terminated socket, the
            // slot would fail relayConnect's own `if (!p || p.ws) refuse` on
            // every legitimate reconnect -- for the rest of the session on the
            // historyFull path, which never sets p.joining and so never times
            // out.
            const unbind = () => { p.ws = null; p.joined = false; };
            if (session.historyFull) {
                unbind();
                refuse(ws, log, `game: ${COLORS[slot]} refused — session is past the ${MAX_HISTORY_TICS}-tic history cap, catch-up cannot be served`);
                return;
            }
            p.joining = true;
            p.reservedAt = p.reservedAt || Date.now();
            if (!burstHistory(ws, `game: ${COLORS[slot]}`)) {
                unbind(); p.joining = false; p.reservedAt = 0; p.token = null;
                return;
            }
            log(`game: ${COLORS[slot]} catching up (${session.historyLen} tics)`);
        }

        ws.on('message', buf => {
            if (!rateOk(ws)) return;
            if (!mine() || buf.length !== 4 + CMD_SIZE) return;
            const tic = buf.readUInt32LE(0);
            p.sentAny = true;
            // Heard, whatever the tic: a player catching up after a freeze
            // sends cmds only for tics the relay already sealed without it,
            // and those are discarded below, yet it is back and holds the seal
            // again.  Judged by `lastSeen` instead, it never fills a tic,
            // stays silent, and is dropped while sending (net-hidden's 3 s
            // case).
            p.lastHeard = Date.now();
            p.quiet = 0;
            p.silent = false;
            // a joiner's first cmd means it caught up: promote it a short
            // margin ahead so its cmds are ready by the join tic
            if (p.joining && !p.ingame && !p.joinAt) {
                p.joinAt = session.tic + JOIN_MARGIN;
                log(`game: ${COLORS[slot]} live — dropping in at tic ${p.joinAt}`);
            }
            if (tic < session.tic || tic > session.tic + 512) return;  // sealed or absurd
            p.cmds.set(tic, buf.subarray(4));
            // `lastSeen` is read only by sealSweep, and only about a LAGGARD --
            // a player missing cmds[session.tic] -- so it records when this
            // player last left that tic filled, not when it last sent bytes.
            // A frame that skips the owed tic (a sealed one, one past the
            // window, or any future tic while the current one is empty) is
            // not progress, however often it arrives: counting it would keep a
            // peer inside GRACE_MS forever, never fabricated for and never
            // dropped, with the seal frozen for everyone.  An honest client
            // sends sequential tics over TCP, so its frames always fill or
            // follow the current one.  sealTic also counts a tic sealed with
            // this player's own cmd: it filled that one.
            if (p.cmds.has(session.tic)) p.lastSeen = Date.now();
            seal();
        });
        ws.on('close', () => {
            if (!mine()) return;
            p.ws = null;
            p.token = null;         // a player who leaves comes back through the lobby
            p.ingame = false;
            p.joining = false;
            p.joinAt = 0;
            log(`game: ${COLORS[p.slot]} disconnected`);
            if (session.players.every(q => !q.ingame)) endSession('all players left');
        });
    }

    const allJoined = () => session.players.every(p => p.joined || !p.ingame);

    // Seal every tic whose live cmds are all present, a silent player's last
    // cmd standing in for its own (sealTic fabricates it, and sealSweep judges
    // who is silent), so the players still sending go on at their own 35
    // tics/s.  Only a tic some live player really sent is sealed here: with
    // every player silent there is none, and the loop ends instead of
    // spinning -- the sweep paces that case.  The live set is recomputed each
    // pass: sealTic may promote a drop-in mid-loop.
    function seal() {
        if (!session || !allJoined()) return;
        for (;;) {
            const live = session.players.filter(p => p.ingame);
            const t = session.tic;
            if (!live.some(p => p.cmds.has(t))) break;
            if (!live.every(p => p.cmds.has(t) || p.silent)) break;
            sealTic();
        }
    }

    // Grace/drop sweep: keeps the game moving when a client stalls.
    function sealSweep() {
        if (!session) return;
        const now = Date.now();
        const prev = session.lastSweep;     // the sweep before this one
        session.lastSweep = now;
        // A reservation that never went live must not hold the slot: the slot
        // is offered again.  Its token still binds until a new `join` takes
        // the slot and replaces it, so a client whose boot outlasts the
        // timeout still gets in when nobody else wanted the seat; a joiner
        // that bound and stalled is closed, and its token goes with it.
        for (const p of session.players)
            if (p.joining && !p.ingame && now - (p.reservedAt || now) > JOIN_TIMEOUT_MS) {
                p.joining = false;
                p.reservedAt = 0;
                p.joinAt = 0;       // a drop-in this reservation scheduled goes with it
                if (p.ws) { p.ws.close(); p.ws = null; p.token = null; }
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
        // Silent: a player that has sent nothing for GRACE_MS, and through
        // QUIET_SWEEPS sweeps since its last frame in each of which another
        // live player was heard -- a frozen page, a tab whose game loop
        // stopped.  It no longer holds the seal (seal()) until its next
        // frame, which also resets the count.  Silence is counted against
        // the others, not by the clock: when everyone goes quiet at once
        // (the opening melt, a stall of the relay, of its link or of a host
        // running several clients), the frames come back as bursts read one
        // socket at a time, and a clock alone found the second player silent
        // while its burst was still unread and sealed the first one's burst
        // with the second fabricated -- 13-14 tics for one player with the
        // relay stopped for 400 ms, against 1 each before this rule.  A
        // sweep in which nobody was heard counts for no one, so that case
        // keeps the old pace below; and since a loaded relay's sweeps come
        // late rather than not at all, the count still runs under load.  A
        // player whose cmd is merely late is still being heard, so it is never
        // silent, and boot is not silence (the sentAny rule above).
        for (const p of live) {
            if (!p.sentAny || p.lastHeard > prev) continue;          // heard since the last sweep
            if (!live.some(q => q !== p && q.lastHeard > prev)) continue;   // nobody was
            if (++p.quiet >= QUIET_SWEEPS && now - p.lastHeard > GRACE_MS) p.silent = true;
        }
        // This also seals what the players left have filled when the one
        // missing a tic has just left (its socket closed, or it never
        // connected and was dropped above): they may already have sent their
        // whole lead and gone quiet waiting (an engine runs at most
        // BACKUPTICS/2-1 tics past its last bundle), so no frame is coming.
        // Their `lastSeen` is renewed as their own cmds are sealed (sealTic):
        // otherwise a seal a never-connected seat held for 10 s would leave
        // them 10 s stale, and the next sweep would drop every player whose
        // reply to the new bundles took longer than one sweep (net-fuzz
        // SURFACE 27).
        seal();
        const laggards = session.players.filter(p => p.ingame && !p.cmds.has(session.tic));
        if (!laggards.length) return;
        // The drop is on `lastSeen`, not `lastHeard`: a peer that sends
        // frames which never fill the tic it owes is heard all the time, and
        // must still go (net-fuzz SURFACE 10).
        for (const p of laggards) {
            if (now - p.lastSeen > DROP_MS) {
                p.ingame = false;
                p.ws?.close(DROP_CODE, DROP_REASON);
                log(`game: ${COLORS[p.slot]} dropped (unresponsive)`);
            }
        }
        // A laggard that filled a tic within the grace has its next cmd in
        // flight, and while any has, the sweep fabricates nothing: sealing
        // now would fabricate that player too.  (The test was the OLDEST
        // laggard's age, so a silent player past the grace got everyone
        // missing the tic fabricated, the players still sending included.)
        // A silent laggard is never in flight -- it has not been heard for
        // GRACE_MS -- and seal() repeats its cmd whenever the others send.
        // What is left for the sweep is a tic nobody has sent (everyone
        // quiet), or one owed by a player still heard that has not filled a
        // tic for the grace (a peer sending useless tics, a client catching
        // up).  Those keep the old pace, one tic per sweep.
        if (laggards.some(p => p.ingame && now - p.lastSeen < GRACE_MS)) return;
        sealTic();      // fabricate what's missing, once per sweep
        seal();
    }

    // bundle: [u32 tic][u8 ingameMask][u8 fabricatedMask][ticcmd × n].
    // A fabricated cmd carries no valid consistancy checksum; the flag tells
    // clients to skip the desync comparison for exactly those.  It repeats the
    // player's last cmd without its one-tic events: no chat character, and no
    // buttons at all when BT_SPECIAL makes them a pause or a savegame, which
    // repeated would toggle the pause, or save, on every fabricated tic.
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
            // A FRESH buffer per tic, deliberately.  `ws` frames unmasked
            // server payloads without copying, and net.Socket.write queues a
            // Buffer BY REFERENCE when the kernel buffer is full -- so with one
            // reused scratch a backlogged peer would receive whatever the NEXT
            // tic wrote into it, not the tic that was queued: silent bundle
            // corruption and a desync.  The slab path above is per-tic for the
            // same reason.  38 bytes a tic on a session already past 30
            // minutes.
            buf = Buffer.alloc(size);
        }
        buf.writeUInt32LE(tic, 0);
        let mask = 0, fab = 0;
        const now = Date.now();
        session.players.forEach((p, i) => {
            if (p.ingame) mask |= 1 << i;
            let cmd = p.cmds.get(tic);
            if (!cmd) { fab |= 1 << i; cmd = p.last; }
            else p.lastSeen = now;      // its own cmd filled this tic
            cmd.copy(buf, 6 + i * CMD_SIZE);
            if (cmd !== p.last) {
                cmd.copy(p.last);       // p.last is allocated once per player
                p.last[CMD_CHATCHAR] = 0;
                if (p.last[CMD_BUTTONS] & BT_SPECIAL) p.last[CMD_BUTTONS] = 0;
            }
            p.cmds.delete(tic);
        });
        buf[4] = mask;
        buf[5] = fab;
        for (const p of session.players)
            if (p.ws) sendTo(p.ws, buf, log, `game: ${COLORS[p.slot]}`);
        for (const sw of session.spectators)
            sendTo(sw, buf, log, 'spectate: observer');
    }

    // --- ws mounting ---------------------------------------------------------
    // maxPayload: lobby frames are small JSON, relay frames 12 bytes; the
    // spectate endpoint has no message handler at all.  perMessageDeflate
    // off: compressing 12-byte latency-critical packets only adds delay.
    // autoPong off: ws would answer every ping itself, outside the rate guard
    // and the send backlog cap, where a peer flooding pings and never reading
    // grows the heap without bound; `capped` answers them instead.
    const opts = maxPayload => ({ noServer: true, maxPayload, perMessageDeflate: false, autoPong: false });
    const lobbyWss    = new WebSocketServer(opts(1024));
    const gameWss     = new WebSocketServer(opts(64));
    const spectateWss = new WebSocketServer(opts(64));
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
        ws.on('ping', data => { if (rateOk(ws) && canSend(ws, log, what)) ws.pong(data); });
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
