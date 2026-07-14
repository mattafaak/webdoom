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

const defaultParams = () => ({
    wad: 'doom.wad', episode: 1, map: 1, skill: 3, mode: 'coop',
});

export function createGame(log = console.log) {
    // --- lobby state -------------------------------------------------------
    const lobby = new Map();        // slot → ws
    let params = defaultParams();
    let session = null;             // active relay session or null

    const roster = () => ({
        t: 'roster',
        players: [...lobby.keys()].sort().map(s => ({ slot: s, color: COLORS[s] })),
        params,
        inGame: !!session,
    });
    const cast = msg => {
        const s = JSON.stringify(msg);
        for (const ws of lobby.values()) if (ws.readyState === 1) ws.send(s);
    };

    function lobbyConnect(ws) {
        let slot = 0;
        while (lobby.has(slot)) slot++;
        if (slot >= MAXPLAYERS || session) {
            ws.send(JSON.stringify({ t: 'full', reason: session ? 'game in progress' : 'lobby full' }));
            ws.close();
            return;
        }
        lobby.set(slot, ws);
        ws.send(JSON.stringify({ t: 'welcome', slot, color: COLORS[slot] }));
        cast(roster());
        log(`lobby: ${COLORS[slot]} joined (${lobby.size} in lobby)`);

        ws.on('message', raw => {
            let m;
            try { m = JSON.parse(raw); } catch { return; }
            if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', t0: m.t0 })); return; }
            if (session) return;
            if (m.t === 'params') {
                const p = { ...params, ...m.params };
                params = {
                    wad: String(p.wad).replace(/[^a-z0-9_.-]/g, ''),
                    episode: Math.max(1, Math.min(9, +p.episode || 1)),
                    map: Math.max(1, Math.min(32, +p.map || 1)),
                    skill: Math.max(1, Math.min(5, +p.skill || 3)),
                    mode: ['coop', 'deathmatch', 'altdeath'].includes(p.mode) ? p.mode : 'coop',
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
    function startGame() {
        const slots = [...lobby.keys()].sort();
        const numplayers = slots.length;
        session = {
            numplayers,
            players: slots.map(slot => ({
                slot, ws: null,
                cmds: new Map(),        // tic → Buffer(8)
                last: Buffer.alloc(CMD_SIZE),
                lastSeen: Date.now(),
                ingame: true,
                joined: false,
            })),
            tic: 0,                     // next tic to seal
            timer: null,
            launched: 0,
        };
        let n = 3;
        const tick = () => {
            if (!session) return;
            if (n > 0) { cast({ t: 'countdown', n: n-- }); setTimeout(tick, 1000); return; }
            cast({ t: 'launch', params, numplayers, slots });
            log(`game: launching ${numplayers}p ${params.wad} E${params.episode}M${params.map} skill ${params.skill} ${params.mode}`);
            session.launched = Date.now();
            session.timer = setInterval(sealSweep, 50);
        };
        tick();
    }

    function endSession(reason) {
        if (!session) return;
        clearInterval(session.timer);
        for (const p of session.players) p.ws?.close();
        session = null;
        log(`game: over (${reason})`);
        cast(roster());
    }

    function relayConnect(ws, url) {
        const slot = +new URL(url, 'http://x').searchParams.get('slot');
        const p = session?.players.find(p => p.slot === slot);
        if (!p || p.ws) { ws.close(); return; }
        p.ws = ws;
        p.joined = true;
        p.lastSeen = Date.now();
        ws.binaryType = 'nodebuffer';

        ws.on('message', buf => {
            if (buf.length !== 4 + CMD_SIZE) return;
            const tic = buf.readUInt32LE(0);
            p.sentAny = true;
            p.lastSeen = Date.now();
            if (tic < session.tic || tic > session.tic + 512) return;  // sealed or absurd
            p.cmds.set(tic, buf.subarray(4));
            seal();
        });
        ws.on('close', () => {
            if (!session) return;
            p.ws = null;
            p.ingame = false;
            log(`game: ${COLORS[p.slot]} disconnected`);
            if (session.players.every(q => !q.ingame)) endSession('all players left');
        });
    }

    const allJoined = () => session.players.every(p => p.joined || !p.ingame);

    // Seal every tic whose live cmds are all present.
    function seal() {
        if (!session) return;
        const live = session.players.filter(p => p.ingame);
        if (!live.length || !allJoined()) return;
        while (live.every(p => p.cmds.has(session.tic))) sealTic();
    }

    // Grace/drop sweep: keeps the game moving when a client stalls.
    function sealSweep() {
        if (!session) return;
        const now = Date.now();
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
        for (const p of session.players)
            if (p.ws?.readyState === 1) p.ws.send(buf);
    }

    // --- ws mounting ---------------------------------------------------------
    const lobbyWss = new WebSocketServer({ noServer: true });
    const gameWss = new WebSocketServer({ noServer: true });
    lobbyWss.on('connection', lobbyConnect);
    gameWss.on('connection', (ws, req) => relayConnect(ws, req.url));

    return {
        upgrade(req, socket, head) {
            const path = new URL(req.url, 'http://x').pathname;
            const wss = path === '/ws/lobby' ? lobbyWss : path === '/ws/game' ? gameWss : null;
            if (!wss) { socket.destroy(); return; }
            wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
        },
    };
}
