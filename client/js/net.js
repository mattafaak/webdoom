// Netplay client: joins the lobby, and once launched wires the engine's
// tic stream to the relay. Environment-agnostic (browser + node test
// harness) — pass in a WebSocket constructor and the base URL.

const CMD_SIZE = 8;
// Mirrors server/game.js's MAXPLAYERS. Used to bound a slot index that arrives
// off the wire before it reaches an array subscript.
const MAXPLAYERS = 4;

// How long a ping may go unanswered before it resolves with a fallback.
// See PING_TIMEOUT_MS at the call site in lobby.js for why this exists at all.
const PING_TIMEOUT_MS = 3000;

export function connectLobby(baseUrl, WS = WebSocket) {
    const ws = new WS(`${baseUrl}/ws/lobby`);
    const handlers = new Map();
    let closed = false;
    const api = {
        slot: -1, color: null,
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
        close() { closed = true; ws.close(); },
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
        if (m.t === 'welcome') {
            // slot indexes COLORS[] and the player arrays in lobby.js.
            if (Number.isInteger(m.slot) && m.slot >= 0 && m.slot < MAXPLAYERS) api.slot = m.slot;
            if (typeof m.color === 'string') api.color = m.color;
        }
        handlers.get(m.t)?.(m);
    };
    ws.onclose = () => { closed = true; handlers.get('closed')?.(); };
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
function makeBundlePump(doom, numplayers, fabOverride) {
    const scratch = doom._web_net_scratch();
    const ingamePtr = doom._malloc(8);
    if (!ingamePtr) throw new Error('out of memory for the per-tic ingame ring');

    let live = false;               // once true, bundles just fill netcmds
    const queue = [];               // bundles awaiting go()/catchUp

    // Push one sealed bundle into the engine (netcmds + per-tic ingame ring).
    const deliver = data => {
        const b = new Uint8Array(data);
        if (b.length !== 6 + CMD_SIZE * numplayers) return;
        const tic = new DataView(b.buffer, b.byteOffset).getUint32(0, true);
        // Mirrors the engine guard in web_net_bundle: a u32 >= 2^31 lands in C
        // as a negative int and indexes before the tic-ring arrays.  The engine
        // is the load-bearing check (a bare-metal port inherits it); this keeps
        // a hostile frame from crossing the boundary at all.
        if (tic >= 0x7FFFFFFF) return;
        const ingameMask = b[4];
        const fabMask = fabOverride ?? b[5];
        for (let i = 0; i < numplayers; i++) {
            doom.HEAPU8[ingamePtr + i] = (ingameMask >> i) & 1;
            doom.HEAPU8.set(
                b.subarray(6 + i * CMD_SIZE, 6 + (i + 1) * CMD_SIZE),
                scratch + i * CMD_SIZE,
            );
        }
        doom._web_net_bundle(tic, scratch, ingamePtr, fabMask);
    };

    const drain = () => { live = true; for (const d of queue.splice(0)) deliver(d); };

    return {
        onmessage: ev => {
            if (live) deliver(ev.data);
            else queue.push(ev.data);   // buffered until go()/catchUp drains it
        },

        // Non-join: start live delivery (bundles fill netcmds; the rAF loop's
        // TryRunTics paces them). Call once callMain has run.
        go: drain,

        // Join in progress: replay the streamed history (and any live bundles
        // that arrive meanwhile) UNPACED — one web_replay_tic per bundle — up
        // to the frontier, then switch to live. onProgress(done, total) drives
        // the loading bar. The sim rebuilds the exact world by construction.
        // onCaughtUp runs after _web_end_catchup and before live delivery.
        async catchUp(frontier, onProgress, onCaughtUp) {
            const CHUNK = 512;      // replay this many tics before yielding
            const yieldToNet = () => new Promise(r => setTimeout(r, 0));
            for (;;) {
                let n = 0;
                while (queue.length) {
                    deliver(queue.shift());     // netcmds for this tic
                    doom._web_replay_tic();      // advance the sim one tic
                    if (++n >= CHUNK) {
                        onProgress?.(doom._web_gametic(), frontier);
                        await yieldToNet();      // let more bundles arrive
                        n = 0;
                    }
                }
                onProgress?.(doom._web_gametic(), frontier);
                if (doom._web_gametic() >= frontier && !queue.length) break;
                await yieldToNet();
            }
            doom._web_end_catchup();
            onCaughtUp?.();
            drain();
        },
    };
}

// Call before doom.callMain(): configures the engine for the session and
// installs the send/receive hooks. rttMs sizes the input delay. slots =
// occupied lobby slots (sparse: color choice = slot choice); the bundle
// is always numplayers wide with phantoms marked not-ingame.
export function attachRelay(doom, baseUrl, { slot, numplayers, slots = null, names = null, jitterMs = 5 }, WS = WebSocket) {
    const ws = new WS(`${baseUrl}/ws/game?slot=${slot}`);
    ws.binaryType = 'arraybuffer';

    const mask = (slots ?? [...Array(numplayers).keys()])
        .reduce((m, s) => m | (1 << s), 0);
    doom._web_net_setup(slot, numplayers, mask);
    names?.forEach((n, i) => {
        if (n) doom.ccall('web_set_player_name', null, ['number', 'string'], [i, n]);
    });
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
    const pump = makeBundlePump(doom, numplayers, null);
    ws.onmessage = pump.onmessage;

    return {
        go: pump.go,
        catchUp: (frontier, onProgress) => pump.catchUp(frontier, onProgress),
        quit() { ws.close(); },
    };
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
    const ws = new WS(`${baseUrl}/ws/spectate`);
    ws.binaryType = 'arraybuffer';

    const ingameSlots = (slots ?? [...Array(numplayers).keys()]);
    const mask = ingameSlots.reduce((m, s) => m | (1 << s), 0);
    // Use the first ingame slot as consoleplayer. A phantom (not-ingame) slot
    // leaves players[consoleplayer].mo NULL, which corrupts sound-listener
    // arithmetic and diverges consistancy[] from the veteran simulation.
    const observerSlot = ingameSlots[0] ?? 0;
    doom._web_net_setup(observerSlot, numplayers, mask);
    names?.forEach((n, i) => {
        if (n) doom.ccall('web_set_player_name', null, ['number', 'string'], [i, n]);
    });
    doom._web_net_set_delay(2);
    // Structural enforcement: netSend is a no-op. The /ws/spectate server
    // handler has no inbound message listener either, so ticcmds cannot be
    // injected by any path.
    doom.netSend = () => {};

    // Spectators pass fabMask=0xFF (all slots "fabricated"); see makeBundlePump.
    const FAB_ALL = 0xFF;
    const pump = makeBundlePump(doom, numplayers, FAB_ALL);
    ws.onmessage = pump.onmessage;

    return {
        catchUp: (frontier, onProgress) => pump.catchUp(frontier, onProgress, () => {
            // Park the view on the first live player so the status bar renders
            // against a valid player slot (phantom slots have no HUD state).
            const anchor = doom._web_first_ingame();
            if (anchor >= 0) doom._web_set_console(anchor);
        }),
        quit() { ws.close(); },
    };
}

// Engine argv for a launch message — identical on every client.
// `commercial` = MAP01-style wad (doom2/finaldoom family): single -warp N.
export function launchArgs(params, commercial) {
    const args = ['-warp'];
    if (commercial)
        args.push(String(params.map));
    else
        args.push(String(params.episode), String(params.map));
    args.push('-skill', String(params.skill));
    if (params.mode === 'deathmatch') args.push('-deathmatch');
    if (params.mode === 'altdeath') args.push('-altdeath');
    return args;
}
