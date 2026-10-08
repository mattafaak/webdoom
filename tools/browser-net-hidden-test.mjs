#!/usr/bin/env node
// A hidden netplay page keeps playing, in real Chrome.  A page that is hidden
// gets no requestAnimationFrame, which is what runs the game, so client/js/
// main.js drives a hidden netplay page from a Worker's 28 ms clock with the
// engine's drawing off.  Two players, each in a window of its own; B is hidden
// for real by a tab opened beside it in its window, and the leg checks that it
// is hidden rather than assuming it: B reads 'hidden', A 'visible', and B's
// requestAnimationFrame count stays flat.
//
//   phase 1  B hidden 12 s: its gametic advances at least 30 tics/s, it is
//            fabricated on at most 2% of tics, A and B agree on every common
//            tic's state hash, and it has exactly one Worker; shown again, it
//            has none and draws.  The tick intervals (p50, p99, max) are
//            printed.
//   phase 2  B hidden and busy for 7 s (a frozen page): the relay drops it
//            and it is told why (/dropped/), while A plays on at at least 30
//            tics/s.
//   phase 3  B spectates, booted while hidden: it starts on the clock, and a
//            throw in its frame ends the session with no Worker left.
//   phase 4  single player hidden 3 s: at most 1 tic, and no Worker.
//
// Red-proof: with main.js's startClock returning at once, phase 1 fails (B
// stops at the moment it is hidden, and is dropped).
//
// usage: node tools/browser-net-hidden-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const chrome = await launchChrome();
const BOOT_S = 90;
const ROW_S = 20;
const MIN_RATE = 30;            // tics/s; 35 is true time
const TEST_S = 480;
setTimeout(() => fatal(`the test did not finish within ${TEST_S} s: a page stopped answering CDP`), TEST_S * 1000).unref();

// Every read is bounded: phase 2 wedges B's main thread on purpose, and a page
// that never answers must fail the leg, not hang it.
const EV_MS = 5000;
const WEDGED = Symbol('no answer');
const bounded = p => {
    let timer;
    return Promise.race([p, new Promise(r => { timer = setTimeout(() => r(WEDGED), EV_MS); })])
        .finally(() => clearTimeout(timer));
};
const evT = (t, expr) => bounded(t.ev(expr));
const running = async t => (await evT(t, `!!window.webdoom?.doom && document.getElementById('loading')?.hidden === true &&
    !document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`)) === true;
const waitRunning = (t, secs) => t.waitFor(() => running(t), { timeout: secs * 1000, every: 500 });
const waitRow = (t, label, secs) => t.waitFor(
    async () => (await evT(t, `!!document.querySelector('#dmenu .row[data-label*=${JSON.stringify(label)}]')`)) === true,
    { timeout: secs * 1000, every: 250 });
const status = t => evT(t, `document.getElementById('status')?.textContent ?? null`);
const vis = t => evT(t, 'document.visibilityState');
const menuReady = async (t, who) => {
    let ok;
    try { ok = await t.waitForMenu(30); } catch (e) { fatal(`${who}: ${e.message}`); }
    if (!ok) fatal(`${who}: the launcher menu did not appear within 30 s`);
};

const A = await chrome.window(url);
const B = await chrome.window(url);

// B's dedicated Workers, as the browser reports them: each one is a target the
// page auto-attaches to, and detaches from when it is terminated.
const workers = { live: 0, made: 0, ids: new Set() };
B.on('Target.attachedToTarget', p => {
    if (p.targetInfo?.type !== 'worker') return;
    workers.ids.add(p.sessionId); workers.live++; workers.made++;
});
B.on('Target.detachedFromTarget', p => { if (workers.ids.delete(p.sessionId)) workers.live--; });
await B.cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
// B's relay slot, from the game socket's URL
let bSlot = null;
await B.cdp('Network.enable');
B.on('Network.webSocketCreated', p => { const m = /\/ws\/game\?slot=(\d)/.exec(p.url ?? ''); if (m) bSlot = +m[1]; });

// Hide B for real: a tab opened beside it in its own window.  B's window is
// brought forward first, so the tab lands there and not in A's.
async function hideB() {
    await B.cdp('Target.activateTarget', { targetId: B.id });
    await sleep(300);
    const cover = await chrome.tab('about:blank');
    const ok = await B.waitFor(async () => (await vis(B)) === 'hidden', { timeout: 5000, every: 100 });
    return { cover, ok };
}
async function showB(cover) {
    await cover.close();
    return B.waitFor(async () => (await vis(B)) === 'visible', { timeout: 5000, every: 100 });
}

// Per-page instruments, for the session running now: a requestAnimationFrame
// counter, every tic's state hash and every step's time while hidden (through
// main.js's frame hook), and every bundle the engine stores with its
// fabricated mask (net.js calls doom._web_net_bundle through the handle).
const INSTRUMENT = `(() => {
    const d = window.webdoom?.doom;
    if (!d) return false;
    const nh = window.__nh = { raf: 0, hashes: {}, steps: [], stored: [] };
    (function f() { if (window.__nh !== nh) return; nh.raf++; requestAnimationFrame(f); })();
    window._doomFrameHook = () => {
        nh.hashes[d._web_gametic()] = d._web_state_hash() >>> 0;
        if (document.visibilityState === 'hidden') nh.steps.push(performance.now());
    };
    const orig = d._web_net_bundle;
    d._web_net_bundle = (tic, cmds, ingame, fab) => {
        const rc = orig(tic, cmds, ingame, fab);
        if (rc === 1) nh.stored.push([performance.now(), fab]);
        return rc;
    };
    return true;
})()`;
const snap = t => evT(t, `({ g: window.webdoom?.doom?._web_gametic?.() ?? null, raf: window.__nh?.raf ?? null,
                            now: performance.now(), vis: document.visibilityState })`);
const rateOf = (s0, s1) => (s1.g - s0.g) / ((s1.now - s0.now) / 1000);
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

// ── a two-player co-op game ─────────────────────────────────────────────────
await menuReady(A, 'A');
await menuReady(B, 'B');
if (!await A.click('MULTIPLAYER')) fatal('A: MULTIPLAYER not found');
if (!await waitRow(A, 'START GAME', ROW_S)) fatal(`A: the lobby did not appear within ${ROW_S} s`);
if (!await B.click('MULTIPLAYER')) fatal('B: MULTIPLAYER not found');
if (!await waitRow(B, 'START GAME', ROW_S)) fatal(`B: the lobby did not appear within ${ROW_S} s`);
await sleep(500);
if (!await A.click('START GAME')) fatal('A: START GAME not clickable');
if (!await waitRunning(A, BOOT_S) || !await waitRunning(B, BOOT_S))
    fatal(`the game did not start in both windows within ${BOOT_S} s (A: ${await status(A)}, B: ${await status(B)})`);
if (bSlot === null) fatal("B's game socket was never seen: no slot to read the fabricated bits by");
for (const [t, who] of [[A, 'A'], [B, 'B']])
    if (await evT(t, INSTRUMENT) !== true) fatal(`${who}: could not instrument the engine`);
await sleep(2000);      // past the opening melt

// ── phase 1: hidden 12 s ────────────────────────────────────────────────────
{
    const { cover, ok } = await hideB();
    const [va, vb] = [await vis(A), await vis(B)];
    check(`phase 1: B is hidden and A is not (B '${vb}', A '${va}')`, ok && vb === 'hidden' && va === 'visible');
    await sleep(500);                       // the clock has taken over
    const b0 = await snap(B);
    await sleep(12000);
    const b1 = await snap(B);
    const live = workers.live;
    const rate = rateOf(b0, b1);
    check(`phase 1: B's requestAnimationFrame count stays flat while hidden (${b0.raf} -> ${b1.raf})`,
          b1.raf === b0.raf, `${b1.raf - b0.raf} frames ran while hidden`);
    check(`phase 1: hidden B runs at least ${MIN_RATE} tics/s for 12 s`, rate >= MIN_RATE,
          `${rate.toFixed(1)} tics/s (gametic ${b0.g} -> ${b1.g})`);
    check('phase 1: hidden B runs on exactly one Worker', live === 1, `${live} Workers live`);
    const m = await evT(B, `(() => {
        const nh = window.__nh, a = ${b0.now}, b = ${b1.now};
        const st = nh.steps.filter(t => t >= a && t <= b);
        const iv = []; for (let i = 1; i < st.length; i++) iv.push(st[i] - st[i - 1]);
        const bundles = nh.stored.filter(([t]) => t >= a && t <= b);
        return { iv, bundles: bundles.length, fab: bundles.filter(([, f]) => (f >> ${bSlot}) & 1).length };
    })()`);
    const iv = (m?.iv ?? []).sort((x, y) => x - y);
    console.log(`  B hidden: ${rate.toFixed(1)} tics/s; ${iv.length + 1} clock steps, interval p50 ${pct(iv, 0.5)?.toFixed(1)} ms, ` +
                `p99 ${pct(iv, 0.99)?.toFixed(1)} ms, max ${iv[iv.length - 1]?.toFixed(1)} ms; ` +
                `B fabricated on ${m?.fab} of ${m?.bundles} bundles`);
    check(`phase 1: the clock stepped B (${iv.length + 1} steps in 12 s)`, iv.length >= 300, `${iv.length + 1} steps`);
    check('phase 1: B is fabricated on at most 2% of tics', m?.bundles > 300 && m.fab <= m.bundles * 0.02,
          `${m?.fab} of ${m?.bundles} bundles`);
    const [ha, hb] = [await evT(A, 'window.__nh.hashes'), await evT(B, 'window.__nh.hashes')];
    const common = Object.keys(ha ?? {}).filter(k => +k > 2 && hb && k in hb);
    const bad = common.filter(k => ha[k] !== hb[k]);
    check(`phase 1: A and B agree on every common tic (${common.length} compared)`, common.length >= 400 && bad.length === 0,
          `${bad.length} of ${common.length} differ, first at tic ${bad[0]}`);

    const shown = await showB(cover);
    await sleep(1000);
    const b2 = await snap(B);
    check('phase 1: shown again, B has no Worker and draws', shown && workers.live === 0 && b2.raf > b1.raf && await running(B),
          `visible ${shown}, ${workers.live} Workers, rAF ${b1.raf} -> ${b2.raf}, status ${JSON.stringify(await status(B))}`);
}

// ── phase 2: hidden and frozen 7 s ──────────────────────────────────────────
let stillHidden;
{
    // in the game first: a status left over from an earlier drop would
    // otherwise pass the drop check below with nothing frozen
    const inGame = await running(B);
    const { cover, ok } = await hideB();
    check('phase 2: B is in the game and hidden when it freezes', inGame && ok,
          `running ${inGame}, hidden ${ok}, status ${JSON.stringify(await status(B))}`);
    const t0 = Date.now();
    // fire and forget: the reply comes when the loop ends
    B.cdp('Runtime.evaluate', { expression: '(() => { const t = performance.now(); while (performance.now() - t < 7000); })()' });
    await sleep(500);
    const a0 = await snap(A);
    await sleep(Math.max(0, 7000 - (Date.now() - t0)));
    const a1 = await snap(A);
    const rate = rateOf(a0, a1);
    console.log(`  A while B was frozen: ${rate.toFixed(1)} tics/s`);
    check(`phase 2: A plays on at least ${MIN_RATE} tics/s while B is frozen`, rate >= MIN_RATE, `${rate.toFixed(1)} tics/s`);
    let said = null;
    await B.waitFor(async () => { said = await status(B); return typeof said === 'string' && said !== ''; },
                    { timeout: 15000, every: 250 });
    console.log(`  B was told: ${JSON.stringify(said)}`);
    check('phase 2: B is dropped and told why', /dropped/.test(said ?? ''), `status ${JSON.stringify(said)}`);
    check('phase 2: B left no Worker behind', workers.live === 0, `${workers.live} Workers live`);
    check('phase 2: A is still in the game', await running(A), `A status ${JSON.stringify(await status(A))}`);
    stillHidden = cover;        // phase 3 boots B while it is still hidden
}
await phase3(stillHidden);
await phase4();

// ── phase 3: a spectator booted hidden; a throw on the clock ────────────────
async function phase3(cover) {
    await menuReady(B, 'B');
    if (!await B.click('MULTIPLAYER')) fatal('B: MULTIPLAYER not found');
    if (!await waitRow(B, 'SPECTATE', ROW_S)) fatal(`B: SPECTATE not offered within ${ROW_S} s`);
    const made0 = workers.made;
    if (!await B.click('SPECTATE')) fatal('B: SPECTATE not clickable');
    const up = await waitRunning(B, BOOT_S);
    check('phase 3: B spectates, booted while hidden', up && (await vis(B)) === 'hidden',
          `running ${up}, '${await vis(B)}', status ${JSON.stringify(await status(B))}`);
    if (await evT(B, INSTRUMENT) !== true) fatal('B: could not instrument the spectator');
    await sleep(500);
    const b0 = await snap(B);
    await sleep(3000);
    const b1 = await snap(B);
    const rate = rateOf(b0, b1);
    check(`phase 3: the hidden spectator starts on the clock (${rate.toFixed(1)} tics/s, one Worker)`,
          workers.live === 1 && workers.made === made0 + 1 && rate >= MIN_RATE,
          `${workers.live} live, ${workers.made - made0} made, ${rate.toFixed(1)} tics/s`);
    await evT(B, `(() => {
        const d = window.webdoom.doom, orig = d._web_frame;
        window.__throws = 0;
        d._web_frame = function () { window.__throws++; d._web_frame = orig; throw new Error('synthetic-net-hidden'); };
        return true;
    })()`);
    await B.waitFor(async () => /engine error/.test((await status(B)) ?? ''), { timeout: 5000, every: 100 });
    await sleep(300);
    const said = await status(B);
    const throws = await evT(B, 'window.__throws');
    check('phase 3: a throw on the clock ends the session with its reason, and no Worker is left',
          throws === 1 && /engine error/.test(said ?? '') && workers.live === 0,
          `${throws} throws, status ${JSON.stringify(said)}, ${workers.live} Workers live`);
    await showB(cover);
}

// ── phase 4: single player hidden 3 s ───────────────────────────────────────
async function phase4() {
    // a fresh page: the launcher still shows phase 3's "engine error", which
    // bootSP reads as a failed boot
    await B.cdp('Page.reload');
    await menuReady(B, 'B');
    if (!await B.bootSP(BOOT_S).catch(e => fatal(`B: single player: ${e.message}`))) fatal('B: single player did not boot');
    await sleep(1500);
    const made0 = workers.made;
    const { cover, ok } = await hideB();
    const s0 = await snap(B);
    await sleep(3000);
    const s1 = await snap(B);
    check(`phase 4: hidden single player advances at most 1 tic in 3 s (${s0.g} -> ${s1.g})`,
          ok && s1.vis === 'hidden' && s1.g - s0.g <= 1, `'${s1.vis}', ${s1.g - s0.g} tics`);
    check('phase 4: and creates no Worker', workers.made === made0 && workers.live === 0,
          `${workers.made - made0} made, ${workers.live} live`);
    await showB(cover);

    const unexpected = [...A.errors, ...B.errors].filter(e => !/synthetic-net-hidden/.test(e));
    check('no unexpected page exceptions', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
    summary('a hidden netplay page plays on its clock, a frozen one is dropped and told why, single player still pauses',
            { min: 19 });
    process.exit();
}
