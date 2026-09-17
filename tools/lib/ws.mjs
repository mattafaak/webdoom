// Raw WebSocket helpers for protocol-level tests: every await is bounded, and
// frames are recorded from the moment the socket exists.  The server sends
// `welcome` the instant a lobby socket connects; a listener attached after
// `open` resolved missed it on ~1 run in 2 (F1, 2026-09-11).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { root } from './util.mjs';

export const WebSocket = createRequire(join(root, 'server/game.js'))('ws');

const AWAIT_MS = 20000;
const withTimeout = (p, label, ms = AWAIT_MS) => Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms).unref())]);
export const open = ws => withTimeout(
    new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }), 'ws open');

// Each arriving frame satisfies at most one waiter, and a matched frame
// leaves the buffer, so a later wait cannot match it again.
export function attachBuf(ws) {
    ws._buf = [];
    ws._waiters = [];
    ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        ws._buf.push(m);
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
export function onceMsg(ws, pred) {
    if (!ws._buf) attachBuf(ws);
    const i = ws._buf.findIndex(pred);
    if (i >= 0) return Promise.resolve(ws._buf.splice(i, 1)[0]);
    return withTimeout(new Promise(res => { ws._waiters.push({ pred, resolve: res }); }), 'onceMsg');
}
export const lobbyJoin = base => attachBuf(new WebSocket(base + '/ws/lobby'));
