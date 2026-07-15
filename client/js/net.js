// Netplay client: joins the lobby, and once launched wires the engine's
// tic stream to the relay. Environment-agnostic (browser + node test
// harness) — pass in a WebSocket constructor and the base URL.

const CMD_SIZE = 8;

export function connectLobby(baseUrl, WS = WebSocket) {
    const ws = new WS(`${baseUrl}/ws/lobby`);
    const handlers = new Map();
    const api = {
        slot: -1, color: null,
        on(t, fn) { handlers.set(t, fn); return api; },
        send(msg) { ws.send(JSON.stringify(msg)); },
        setParams(params) { api.send({ t: 'params', params }); },
        start() { api.send({ t: 'start' }); },
        ping() {
            return new Promise(res => {
                const t0 = performance.now();
                handlers.set('pong', () => res(performance.now() - t0));
                api.send({ t: 'ping', t0 });
            });
        },
        close() { ws.close(); },
    };
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.t === 'welcome') { api.slot = m.slot; api.color = m.color; }
        handlers.get(m.t)?.(m);
    };
    ws.onclose = () => handlers.get('closed')?.();
    ws.onerror = e => handlers.get('error')?.(e);
    return api;
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

    const scratch = doom._web_net_scratch();
    const ingamePtr = doom._malloc(8);
    let live = false;               // once true, bundles just fill netcmds
    const queue = [];               // bundles awaiting go()/catchUp

    // Push one sealed bundle into the engine (netcmds + per-tic ingame ring).
    const deliver = data => {
        const b = new Uint8Array(data);
        if (b.length !== 6 + CMD_SIZE * numplayers) return;
        const tic = new DataView(b.buffer, b.byteOffset).getUint32(0, true);
        const ingameMask = b[4], fabMask = b[5];
        for (let i = 0; i < numplayers; i++) {
            doom.HEAPU8[ingamePtr + i] = (ingameMask >> i) & 1;
            doom.HEAPU8.set(
                b.subarray(6 + i * CMD_SIZE, 6 + (i + 1) * CMD_SIZE),
                scratch + i * CMD_SIZE,
            );
        }
        doom._web_net_bundle(tic, scratch, ingamePtr, fabMask);
    };

    ws.onmessage = ev => {
        if (live) deliver(ev.data);
        else queue.push(ev.data);   // buffered until go()/catchUp drains it
    };

    return {
        // Non-join: start live delivery (bundles fill netcmds; the rAF loop's
        // TryRunTics paces them). Call once callMain has run.
        go() { live = true; for (const d of queue.splice(0)) deliver(d); },

        // Join in progress: replay the streamed history (and any live bundles
        // that arrive meanwhile) UNPACED — one web_replay_tic per bundle — up
        // to the frontier, then switch to live. onProgress(done, total) drives
        // the loading bar. The sim rebuilds the exact world by construction.
        async catchUp(frontier, onProgress) {
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
            live = true;
            for (const d of queue.splice(0)) deliver(d);
        },
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
