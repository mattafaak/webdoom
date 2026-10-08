#!/usr/bin/env node
// Browser drop-in test through the DOOM menu: tab A starts a co-op game;
// tab C opens MULTIPLAYER, sees the GAME IN PROGRESS screen, hits DROP IN,
// catches up, and lands in the running game. Exercises the full client join
// path (inprogress summary → join → catch-up boot).
// usage: node tools/browser-join-test.mjs [url] [outdir]
//
// State-machine edge coverage (docs/state-machine.md):
//   T18 DROP-IN-OFFER → DROP-IN-LOADING  (click DROP IN → lobby.send join → server welcome+launch)
//   T19 DROP-IN-LOADING → IN-GAME-MP     (catch-up done, relay goes live)
//   T31 DROP-IN-OFFER → IN-GAME-MP       (click SPECTATE → receive-only boot)
//
// Every wait here is a poll with a deadline, never a sleep followed by one
// read: under load (the suite at --jobs 6, other work on the host) a fixed
// sleep is a race the page can lose.  The DROP IN and SPECTATE rows exist only
// once the server's `inprogress` summary has arrived (client/js/lobby.js,
// enterMultiplayer: the screen reads CONNECTING… until then).
//
// "In the game" is the engine running, not the boot begun.  The shared
// tab.inGame (tools/lib/cdp.mjs) reads the canvas and an empty status line,
// and bootDoom un-hides the canvas before it even loads the engine
// (client/js/main.js), so that predicate holds from the first moment of a
// boot: polled every 20 ms, it read true 1 ms after SPECTATE while the engine
// ran only at 1,464 ms, the loading panel reading "LOADING ENGINE…" and then
// "SPECTATING — CATCHING UP" in between (2026-10-08, alder, idle).  So this
// file waits for what only a finished boot has: the engine handle, which
// main.js publishes after the catch-up, and the loading panel hidden, which
// happens when the frame loop starts.  Between DROP IN and that
// lie the join round trip, the twelve pings that size the jitter buffer
// (lobby.js; each waits up to net.js's PING_TIMEOUT_MS, 3 s), the cold engine
// boot and the sim-only replay to the frontier; a cold single-player boot
// alone gets 90 s elsewhere (bootSP, tools/lib/cdp.mjs), so every boot here
// gets the same.
//
// Each player has a window of its own (chrome.window, tools/lib/cdp.mjs), as
// each real player has.  In one window, opening C's tab hid A's: a hidden
// page gets no requestAnimationFrame, so the host stopped sending, and the
// server dropped it after DROP_MS, 5 s (server/game.js), ending the game if
// C was not in it yet.  The server's log had "Green dropped (unresponsive)"
// in each of 8 runs of the one-window test, all of which passed, so the test
// passed only while C's whole drop-in fit in those 5 s; under load (load
// average ~60) it once did not: C reached the game, then C and A read "the
// connection to the game server was lost" and D found no game to spectate.
// That was before main.js's hidden-page clock: a hidden netplay page now
// plays on a Worker's 28 ms clock (browser-net-hidden), but it draws nothing
// and takes no input, so each player keeps its window.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const outdir = process.argv[3] ?? '/tmp';
const chrome = await launchChrome();
const BOOT_S = 90;      // a cold engine boot, as bootSP allows
const ROW_S = 20;       // the inprogress summary: one lobby round trip
// A page whose main thread is wedged never answers Runtime.evaluate, and
// tab.ev has no deadline, so one read of such a page would hang this leg
// rather than fail it (seen: a catch-up broken on purpose left one tab
// unresponsive and the run waiting for good).  Every read here is bounded;
// WEDGED is what an unanswered one returns.
const EV_MS = 5000;
const WEDGED = Symbol('no answer');
function bounded(p) {
    let timer;
    return Promise.race([p, new Promise(r => { timer = setTimeout(() => r(WEDGED), EV_MS); })])
        .finally(() => clearTimeout(timer));
}
const evT = (t, expr) => bounded(t.ev(expr));
// evidence, not a check: a screenshot a wedged page cannot take is skipped
const shot = async (tab, file) => {
    const m = await bounded(tab.cdp('Page.captureScreenshot', { format: 'png' }));
    if (m !== WEDGED && m?.result?.data) writeFileSync(join(outdir, file), Buffer.from(m.result.data, 'base64'));
};
// The shared helpers this also uses (tab.click, tab.waitForMenu) read the page
// without a deadline, and run-tests.sh has none per leg, so the whole test
// gets one, well past the sum of its own waits (three boots, three menus,
// three rows: under 7 minutes).
const TEST_S = 600;
setTimeout(() => fatal(`the test did not finish within ${TEST_S} s: a page stopped answering CDP`), TEST_S * 1000).unref();
const running = async t => (await evT(t, `!!window.webdoom?.doom && document.getElementById('loading')?.hidden === true &&
    !document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`)) === true;
const waitInGame = (t, secs) => t.waitFor(() => running(t), { timeout: secs * 1000, every: 500 });
const waitRow = (t, label, secs) => t.waitFor(
    async () => (await evT(t, `!!document.querySelector('#dmenu .row[data-label*=${JSON.stringify(label)}]')`)) === true,
    { timeout: secs * 1000, every: 250 });
const menuReady = async (t, who) => {
    let ok;
    try { ok = await t.waitForMenu(30); } catch (e) { fatal(`${who}: ${e.message}`); }
    if (!ok) fatal(`${who}: the launcher menu did not appear within 30 s`);
};

// What the server told a tab: the frontier (sealed tic) in the `inprogress`
// summary and in the drop-in's `launch`.  Read off the wire with CDP's Network
// domain, so the page runs unmodified; text frames only (the relay's bundles
// are binary).
function watchFrontier(tab) {
    const seen = { inprogress: null, launch: null };
    tab.on('Network.webSocketFrameReceived', p => {
        const d = p.response?.opcode === 1 ? p.response.payloadData : null;
        if (!d || !d.includes('"frontier"')) return;
        try {
            const m = JSON.parse(d);
            if (m.t === 'inprogress' || m.t === 'launch') seen[m.t] = m.frontier;
        } catch { /* not ours */ }
    });
    return seen;
}

// Why a tab is not in the game: its status line, the loading panel (label and
// percent: the catch-up bar is done/frontier), the engine's gametic once the
// handle exists (main.js publishes window.webdoom only after the catch-up),
// the frontier it was sent, and where the host is; or that it gave no answer.
async function joinState(tab, seen) {
    const s = await evT(tab, `(() => {
        const L = document.getElementById('loading');
        const d = window.webdoom?.doom;
        return {
            status: document.getElementById('status')?.textContent ?? null,
            vis: document.visibilityState,
            screen: !document.getElementById('screen')?.hidden,
            loading: L && !L.hidden
                ? (document.getElementById('loading-label')?.textContent ?? '') + ' ' +
                  (document.getElementById('loading-bar')?.getAttribute('aria-valuenow') ?? '?') + '%'
                : 'hidden',
            gametic: typeof d?._web_gametic === 'function' ? d._web_gametic() : null,
            menu: document.querySelector('#dmenu .mtitle')?.textContent ?? null,
        };
    })()`);
    const host = await evT(A, `({ tic: window.webdoom?.doom?._web_gametic?.() ?? null,
                                  status: document.getElementById('status')?.textContent ?? null })`);
    const hostAt = host === WEDGED ? `unknown (A gave no answer in ${EV_MS / 1000} s)`
        : host?.tic ?? `n/a (A has no engine; its status ${JSON.stringify(host?.status)})`;
    if (s === WEDGED) return `the page gave no answer in ${EV_MS / 1000} s (its main thread is wedged); ` +
        `frontier sent: inprogress ${seen.inprogress ?? 'none'}, launch ${seen.launch ?? 'none'}; host A at gametic ${hostAt}`;
    return `status ${JSON.stringify(s?.status)}; page ${s?.vis}; canvas ${s?.screen ? 'shown' : 'hidden'}; ` +
           `loading panel ${s?.loading}; gametic ${s?.gametic ?? 'n/a (no engine handle yet)'}; ` +
           `frontier sent: inprogress ${seen.inprogress ?? 'none'}, launch ${seen.launch ?? 'none'}; ` +
           `host A at gametic ${hostAt}; menu title ${JSON.stringify(s?.menu)}`;
}

const A = await chrome.window(url);
await menuReady(A, 'A');

// A: start a co-op game solo
if (!await A.click('MULTIPLAYER')) fatal('A: MULTIPLAYER not found');
// the lobby screen replaces CONNECTING… when the server's roster arrives
if (!await waitRow(A, 'START GAME', ROW_S)) fatal(`A: START GAME not offered within ${ROW_S} s`);
if (!await A.click('START GAME')) fatal('A: START GAME not clickable');
if (!await waitInGame(A, BOOT_S)) fatal(`A: never reached in-game within ${BOOT_S} s: ${await joinState(A, {})}`);
console.log('A is in-game; letting it run…');
await sleep(2500);   // build some history to catch up on

// C: open MULTIPLAYER → should get the GAME IN PROGRESS screen
const C = await chrome.window(url);
await C.cdp('Network.enable');
const cSeen = watchFrontier(C);
await menuReady(C, 'C');
if (!await C.click('MULTIPLAYER')) fatal('C: MULTIPLAYER not found');
if (!await waitRow(C, 'DROP IN', ROW_S)) {
    const title = await evT(C, `document.querySelector('#dmenu .mtitle')?.textContent ?? document.querySelector('#dmenu')?.textContent`);
    fatal(`C: no DROP IN on the in-progress screen within ${ROW_S} s (menu text: ${String(title).slice(0, 80)})`);
}
console.log(`C sees GAME IN PROGRESS with DROP IN (frontier ${cSeen.inprogress ?? '?'})`);
await shot(C, 'webdoom-inprogress.png');

// C: drop in → catch up → in-game
if (!await C.click('DROP IN')) fatal('C: DROP IN not clickable');
let t0 = Date.now();
const cIn = await waitInGame(C, BOOT_S);
if (cIn) console.log(`C in the game ${((Date.now() - t0) / 1000).toFixed(1)} s after DROP IN (frontier ${cSeen.launch ?? '?'})`);
check('C: drops in, catches up and reaches the game', cIn,
      cIn ? '' : `never dropped in / reached in-game within ${BOOT_S} s: ${await joinState(C, cSeen)}`);
await sleep(2000);
const cStays = await running(C);
check('C: stays in the game after joining', cStays,
      cStays ? '' : `fell out of the game after joining: ${await joinState(C, cSeen)}`);
await shot(C, 'webdoom-droppedin.png');

// D: SPECTATE from the same screen → a receive-only boot into the running game
const D = await chrome.window(url);
await D.cdp('Network.enable');
const dSeen = watchFrontier(D);
await menuReady(D, 'D');
if (!await D.click('MULTIPLAYER')) fatal('D: MULTIPLAYER not found');
if (!await waitRow(D, 'SPECTATE', ROW_S)) fatal(`D: SPECTATE not offered on the in-progress screen within ${ROW_S} s`);
if (!await D.click('SPECTATE')) fatal('D: SPECTATE not clickable');
t0 = Date.now();
const dIn = await waitInGame(D, BOOT_S);
if (dIn) console.log(`D in the game ${((Date.now() - t0) / 1000).toFixed(1)} s after SPECTATE (frontier ${dSeen.inprogress ?? '?'})`);
check('D: the spectator reaches the game', dIn,
      dIn ? '' : `spectator never reached in-game within ${BOOT_S} s: ${await joinState(D, dSeen)}`);
await sleep(1500);
const dStays = await running(D);
check('D: the spectator stays in the game', dStays,
      dStays ? '' : `spectator fell out of the game: ${await joinState(D, dSeen)}`);
console.log('D is spectating');

const errs = [...A.errors, ...C.errors, ...D.errors];
check('no page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
summary('browser drop-in: GAME IN PROGRESS → DROP IN → caught up in-game; SPECTATE → watching', { min: 5 });
process.exit();
