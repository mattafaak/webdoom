// Netplay client: joins the lobby, and once launched wires the engine's
// tic stream to the relay. Environment-agnostic (browser + node test
// harness) — pass in a WebSocket constructor and the base URL.

const CMD_SIZE = 8;
// Mirrors server/game.js's MAXPLAYERS. Used to bound a slot index that arrives
// off the wire before it reaches an array subscript.
const MAXPLAYERS = 4;

// Everything in a `launch` or `inprogress` frame is attacker-controlled: the
// threat model this whole file is written against is an impostor answering
// ws://host:8666/ws/lobby, which on a plain-HTTP LAN is anything on the wire.
//
// `slot` was bounded (see the welcome handler) and `numplayers` was NOT, and
// numplayers is a LOOP BOUND on two fixed-size allocations in makeBundlePump:
// an 8-byte _malloc for the per-tic ingame ring, and the engine's
// `static ticcmd_t scratch[MAXPLAYERS]`, which is 32 bytes.  A launch frame
// carrying numplayers 1000 plus one correctly-sized 8,006-byte bundle wrote
// ~1 KB and ~8 KB of attacker-chosen bytes past them.
//
// The engine's own guard in web_net_setup rejects numplayers > MAXPLAYERS, but
// it runs BEFORE the pump and only protects the C-side write loop -- so it
// cannot stop this, and a gate that exercises it proves the wrong boundary.
// The check has to be here, at the point the value crosses out of the wire.
//
// This REFUSES rather than clamps.  A server sending either value out of range
// is hostile or broken; continuing with a silently different player count
// produces a game that desyncs instead of one that fails.
function checkNetShape(numplayers, slots) {
    if (!Number.isInteger(numplayers) || numplayers < 1 || numplayers > MAXPLAYERS)
        throw new Error(
            `refusing launch: numplayers ${JSON.stringify(numplayers)} is not an integer 1..${MAXPLAYERS}`);
    if (slots == null) return null;
    if (!Array.isArray(slots))
        throw new Error(`refusing launch: slots is ${typeof slots}, not an array`);
    for (const s of slots)
        if (!Number.isInteger(s) || s < 0 || s >= MAXPLAYERS)
            throw new Error(
                `refusing launch: slot ${JSON.stringify(s)} is not an integer 0..${MAXPLAYERS - 1}`);
    return slots;
}

// How long a ping may go unanswered before it resolves with a fallback.
// See PING_TIMEOUT_MS at the call site in lobby.js for why this exists at all.
const PING_TIMEOUT_MS = 3000;

// The page's own server, as a WebSocket origin (browser only).
export const pageWsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

export function connectLobby(baseUrl, WS = WebSocket) {
    const ws = new WS(`${baseUrl}/ws/lobby`);
    const handlers = new Map();
    const api = {
        slot: -1,
        on(t, fn) { handlers.set(t, fn); return api; },
        // ws.send throws before OPEN and after CLOSE
        send(msg) {
            if (ws.readyState !== 1) return false;
            try { ws.send(JSON.stringify(msg)); return true; }
            catch { return false; }
        },
        setParams(params) { api.send({ t: 'params', params }); },
        start() { api.send({ t: 'start' }); },
        // Resolves null on timeout rather than hanging or rejecting: the
        // caller's 12-ping loop runs between `launch` and bootDoom, and an
        // unanswered ping is not a zero-latency ping.
        ping() {
            return new Promise(res => {
                const t0 = performance.now();
                let done = false;
                const finish = v => { if (!done) { done = true; clearTimeout(timer); res(v); } };
                const timer = setTimeout(() => finish(null), PING_TIMEOUT_MS);
                handlers.set('pong', () => finish(performance.now() - t0));
                if (!api.send({ t: 'ping', t0 })) finish(null);
            });
        },
        close() { ws.close(); },
    };
    ws.onmessage = ev => {
        // The server treats the client as hostile (try/catch around every
        // parse); on a plain-http LAN anything can answer ws://host/ws/lobby,
        // so this side does the same -- a throw here would leave lobby.js
        // never learning the connection was unusable.
        let m;
        try { m = JSON.parse(ev.data); }
        catch { return; }                       // not JSON: not a message
        if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
        // A `roster` or `inprogress` frame reaches lobby.js's screen builders,
        // and those guarded the CONTAINER and not the MEMBER:
        // `roster?.players.find(...)` throws on `{"t":"roster"}`, because `?.`
        // only covers `roster` being nullish -- while the two lines under it
        // correctly used `?? []` and `?? {}`.  The throw propagates out of this
        // very handler, so the UI wedges on CONNECTING with an empty status
        // line and the socket stops being useful, which is the failure shape
        // CLAUDE.md records under "one case can disarm the next".
        //
        // Normalised HERE rather than at each read, for the same reason
        // checkNetShape sits here: this is where the value crosses out of the
        // wire, and a new screen builder cannot reintroduce the hole.  After
        // this, `players` and `freeSlots` are arrays and `params` is an object,
        // whatever arrived.  Shape only -- the contents stay the server's.
        if (m.t === 'roster' || m.t === 'inprogress') {
            m = { ...m,
                players:   Array.isArray(m.players)   ? m.players.filter(p => p && typeof p === 'object') : [],
                freeSlots: Array.isArray(m.freeSlots) ? m.freeSlots.filter(Number.isInteger) : [],
                params:    (m.params && typeof m.params === 'object') ? m.params : {} };
        }
        if (m.t === 'welcome') {
            // slot indexes COLORS[] and the player arrays in lobby.js.
            if (Number.isInteger(m.slot) && m.slot >= 0 && m.slot < MAXPLAYERS) api.slot = m.slot;
        }
        handlers.get(m.t)?.(m);
    };
    ws.onclose = () => handlers.get('closed')?.();
    ws.onerror = e => handlers.get('error')?.(e);
    return api;
}

// ── Shared bundle plumbing ───────────────────────────────────────────────────
// attachRelay and attachSpectate are one receiver with three differences:
// the URL, where fabMask comes from, and one step when catch-up ends.
//   fabOverride: null -> read fabMask from the wire (byte 5), as a player does
//                0xFF -> mark every slot fabricated, as a spectator must, so
//                        the engine's consistancy check is bypassed (the sim
//                        is still bit-identical, verified by _web_state_hash)
//
// Bundles queue here and reach the engine in tic order, no faster than its
// 35-tic ring can hold them: a hidden tab stops the sim but not the socket.
// The relay sends every tic once and in order, so a gap, or a backlog past
// BACKLOG_MAX, cannot be recovered from; the session ends with that reason
// (`lose`) instead of desyncing.
const BACKLOG_MAX = 35 * 30;    // 30 s of tics

function makeBundlePump(doom, numplayers, fabOverride, lose, lostReason) {
    const scratch = doom._web_net_scratch();
    const ingamePtr = doom._malloc(8);

    let live = false;               // go()/catchUp done: offer bundles as they come
    let next = -1;                  // the tic the next bundle must carry
    let disposed = false;
    const queue = [];               // validated bundles the engine has not taken

    const accept = data => {
        const b = new Uint8Array(data);
        if (b.length !== 6 + CMD_SIZE * numplayers) return;
        const tic = new DataView(b.buffer, b.byteOffset).getUint32(0, true);
        // the engine refuses these too; this keeps them off the queue
        if (tic >= 0x7FFFFFFF) return;
        if (next >= 0 && tic < next) return;            // a repeat
        if (next >= 0 && tic > next) return lose(`the game server skipped tic ${next}`);
        if (queue.length >= BACKLOG_MAX) return lose('fell too far behind the game');
        next = tic + 1;
        queue.push({ tic, b });
    };

    // Hand the oldest queued bundle to the engine: 1 taken, 0 no room yet.
    const deliverOne = () => {
        const { tic, b } = queue[0];
        for (let i = 0; i < numplayers; i++) {
            doom.HEAPU8[ingamePtr + i] = (b[4] >> i) & 1;
            doom.HEAPU8.set(b.subarray(6 + i * CMD_SIZE, 6 + (i + 1) * CMD_SIZE), scratch + i * CMD_SIZE);
        }
        const rc = doom._web_net_bundle(tic, scratch, ingamePtr, fabOverride ?? b[5]);
        if (rc === 0) return 0;
        queue.shift();
        if (rc < 0) lose(`the game server sent an invalid tic (${tic})`);
        return 1;
    };

    // Give the engine every queued bundle its ring has room for.  main.js
    // calls this before each frame, so a backlog drains as the sim catches up.
    const offer = () => {
        if (disposed || !live) return;
        while (queue.length && !lostReason() && deliverOne()) { /* next */ }
    };

    return {
        onmessage: ev => { if (!disposed) { accept(ev.data); offer(); } },
        offer,

        // Non-join: start delivery. Call once callMain has run.
        go() { live = true; offer(); },

        dispose() {
            if (disposed) return;
            disposed = true;
            queue.length = 0;
            doom._free(ingamePtr);
        },

        // Join in progress: replay the streamed history (and any live bundles
        // that arrive meanwhile) UNPACED — one web_replay_tic per bundle — up
        // to the frontier, then switch to live. onProgress(done, total) drives
        // the loading bar. The sim rebuilds the exact world by construction.
        // onCaughtUp runs after _web_end_catchup and before live delivery.
        async catchUp(frontier, onProgress, onCaughtUp) {
            const CHUNK = 512;      // replay this many tics before yielding
            // No progress for this long means the stream is not coming back.
            const STALL_MS = 15000;
            const yieldToNet = () => new Promise(r => setTimeout(r, 0));
            if (!Number.isInteger(frontier) || frontier < 0 || frontier > 0x7FFFFFFF)
                throw new Error(
                    `refusing catch-up: frontier ${JSON.stringify(frontier)} is not a plausible tic`);
            const ended = () => {
                if (disposed) throw new Error('the session ended during catch-up');
                if (lostReason()) throw new Error(lostReason());
            };
            let lastTic = -1;
            let lastMoved = Date.now();
            for (;;) {
                let n = 0;
                while (queue.length) {
                    ended();
                    if (!deliverOne()) throw new Error('catch-up: the engine refused the next tic');
                    ended();
                    doom._web_replay_tic();      // advance the sim one tic
                    if (++n >= CHUNK) {
                        onProgress?.(doom._web_gametic(), frontier);
                        await yieldToNet();      // let more bundles arrive
                        n = 0;
                    }
                }
                ended();
                const at = doom._web_gametic();
                onProgress?.(at, frontier);
                if (at >= frontier) break;
                if (at !== lastTic) { lastTic = at; lastMoved = Date.now(); }
                else if (Date.now() - lastMoved > STALL_MS)
                    throw new Error(
                        `catch-up stalled at tic ${at} of ${frontier} — no bundles for ` +
                        `${Math.round(STALL_MS / 1000)}s; the relay is gone or the frontier is unreachable`);
                await yieldToNet();
            }
            doom._web_end_catchup();
            onCaughtUp?.();
            live = true;
            offer();
        },
    };
}

// The setup both attach* functions do, in the order they must do it: validate
// the shape BEFORE anything sizes on it, open the socket, set binaryType, fold
// the slots into a player mask, call _web_net_setup, then push the names (a
// ccall per player that must land after _web_net_setup and before any tic).
//
// The socket's close or error ends the session through `lose`, unless quit()
// closed it.  Callers learn of it through the returned object's onLost, which
// fires at once if the loss came before it was assigned.
function attachCommon(doom, url, { numplayers, slots, names }, WS, consoleSlotOf) {
    slots = checkNetShape(numplayers, slots);   // before anything sizes on it
    const ws = new WS(url);
    ws.binaryType = 'arraybuffer';

    const ingameSlots = slots ?? [...Array(numplayers).keys()];
    const mask = ingameSlots.reduce((m, s) => m | (1 << s), 0);
    doom._web_net_setup(consoleSlotOf(ingameSlots), numplayers, mask);
    // A name is copied onto the engine's 1 MB stack before the engine can
    // bound it, so it is cleaned here exactly as the server cleans one it
    // accepts (server/game.js cleanName): a 1.2M-character name from a
    // hostile server overran the stack into the engine's static data.
    (Array.isArray(names) ? names.slice(0, numplayers) : []).forEach((n, i) => {
        const clean = typeof n === 'string' ? n.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 10) : '';
        if (clean) doom.ccall('web_set_player_name', null, ['number', 'string'], [i, clean]);
    });

    let quitting = false, lostReason = null, onLost = null;
    const lose = reason => {
        if (quitting || lostReason) return;
        lostReason = reason;
        try { ws.close(); } catch { /* already closed */ }
        onLost?.(reason);
    };
    ws.onclose = ev => lose(ev?.reason || 'the connection to the game server was lost');
    ws.onerror = () => lose('the connection to the game server failed');
    const control = {
        get onLost() { return onLost; },
        set onLost(fn) { onLost = fn; if (lostReason) fn?.(lostReason); },
    };
    const quit = pump => { quitting = true; try { ws.close(); } catch { /* closed */ } pump.dispose(); };
    return { ws, slots, ingameSlots, mask, lose, lostReason: () => lostReason, control, quit };
}

// Call before doom.callMain(): configures the engine for the session and
// installs the send/receive hooks. rttMs sizes the input delay. slots =
// occupied lobby slots (sparse: color choice = slot choice); the bundle
// is always numplayers wide with phantoms marked not-ingame.  token is the
// seat token from this client's own `launch` frame; the server binds the
// slot only with it.  A non-string is sent as empty, which it refuses.
export function attachRelay(doom, baseUrl, { slot, token = '', numplayers, slots = null, names = null, jitterMs = 5 }, WS = WebSocket) {
    const tok = encodeURIComponent(typeof token === 'string' ? token : '');
    const { ws, lose, lostReason, control, quit } = attachCommon(doom, `${baseUrl}/ws/game?slot=${slot}&token=${tok}`,
                                { numplayers, slots, names }, WS, () => slot);
    // Jitter buffer depth (tics behind the sealed frontier, one tic =
    // 28.6ms). Size it to network JITTER, never to mean RTT: in lockstep
    // your cmd must round-trip before it applies, so the mean latency is
    // already baked into the frontier — adding it to the buffer double-lags
    // the game. The buffer only has to cover arrival-time *variance* so the
    // sim's wall-clock pacing never outruns the frontier. Floor of 2 for LAN
    // micro-jitter; capped at 4 so a pathological link can't trade all its
    // responsiveness for smoothness — the sim's safety drain mops up spikes.
    const delay = Math.min(4, Math.max(2, Math.ceil(jitterMs / 28.6) + 1));
    doom._web_net_set_delay(delay);

    const up = new Uint8Array(4 + CMD_SIZE);
    const upView = new DataView(up.buffer);
    doom.netSend = (tic, cmdPtr) => {
        upView.setUint32(0, tic, true);
        up.set(doom.HEAPU8.subarray(cmdPtr, cmdPtr + CMD_SIZE), 4);
        if (ws.readyState === 1) ws.send(up);
    };

    // A player reads fabMask from the wire.
    const pump = makeBundlePump(doom, numplayers, null, lose, lostReason);
    ws.onmessage = pump.onmessage;

    return Object.assign(control, {
        go: pump.go,
        offer: pump.offer,
        catchUp: (frontier, onProgress) => pump.catchUp(frontier, onProgress),
        quit: () => quit(pump),
    });
}

// Spectate: receive-only observer. Connects to /ws/spectate (no slot param),
// streams the sealed-bundle history for catch-up, then watches live.
// Structurally cannot send ticcmds: doom.netSend is set to a no-op, and the
// server's spectateConnect has no inbound message handler.
//
// consoleplayer is set to the FIRST ingame slot so the engine runs
// bit-identical to that player: same mo pointer, same sound listener,
// same consistancy[] tracking. Local ticcmds built by G_BuildTiccmd are
// discarded by the no-op netSend; netcmds[] is written only by web_net_bundle
// (sealed bundles), so the simulation is authoritative and deterministic.
export function attachSpectate(doom, baseUrl, { numplayers, slots = null, names = null }, WS = WebSocket) {
    // Use the first ingame slot as consoleplayer. A phantom (not-ingame) slot
    // leaves players[consoleplayer].mo NULL, which corrupts sound-listener
    // arithmetic and diverges consistancy[] from the veteran simulation.
    const { ws, lose, lostReason, control, quit } = attachCommon(doom, `${baseUrl}/ws/spectate`,
                                             { numplayers, slots, names }, WS,
                                             ing => ing[0] ?? 0);
    doom._web_net_set_delay(2);
    // Structural enforcement: netSend is a no-op. The /ws/spectate server
    // handler has no inbound message listener either, so ticcmds cannot be
    // injected by any path.
    doom.netSend = () => {};

    // Spectators pass fabMask=0xFF (all slots "fabricated"); see makeBundlePump.
    const FAB_ALL = 0xFF;
    const pump = makeBundlePump(doom, numplayers, FAB_ALL, lose, lostReason);
    ws.onmessage = pump.onmessage;

    return Object.assign(control, {
        offer: pump.offer,
        catchUp: (frontier, onProgress) => pump.catchUp(frontier, onProgress, () => {
            // Park the view on the first live player so the status bar renders
            // against a valid player slot (phantom slots have no HUD state).
            const anchor = doom._web_first_ingame();
            if (anchor >= 0) doom._web_set_console(anchor);
        }),
        quit: () => quit(pump),
    });
}

// Engine argv for a launch message — identical on every client, joiners and
// spectators included, since each builds it from the same params.
// `commercial` = MAP01-style wad (doom2/finaldoom family): single -warp N.
//
// The params come off the wire, so each must be a value the server's own
// clamps can produce; anything else throws and the launch is refused.  The
// engine parses argv with no such care: a value starting with '@' is read as
// a response file.
export function launchArgs(params, commercial) {
    const p = params && typeof params === 'object' ? params : {};
    const int = (v, lo, hi, what) => {
        if (!Number.isInteger(v) || v < lo || v > hi)
            throw new Error(`refusing launch: ${what} ${JSON.stringify(v)}`);
        return String(v);
    };
    const args = ['-warp'];
    if (commercial)
        args.push(int(p.map, 1, 32, 'map'));
    else
        args.push(int(p.episode, 1, 9, 'episode'), int(p.map, 1, 32, 'map'));
    args.push('-skill', int(p.skill, 1, 5, 'skill'));
    if (!['coop', 'deathmatch', 'altdeath'].includes(p.mode ?? 'coop'))
        throw new Error(`refusing launch: mode ${JSON.stringify(p.mode)}`);
    if (p.mode === 'deathmatch') args.push('-deathmatch');
    if (p.mode === 'altdeath') args.push('-altdeath');
    // the RULES screen
    if (p.nomonsters === true) args.push('-nomonsters');
    if (p.fast === true) args.push('-fast');
    if (p.respawn === true) args.push('-respawn');
    if (p.timer !== undefined && p.timer !== 0) args.push('-timer', int(p.timer, 1, 30, 'timer'));
    return args;
}
