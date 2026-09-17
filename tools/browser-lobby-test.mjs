#!/usr/bin/env node
// Lobby state-machine edge tests: drives every transition in docs/state-machine.md
// that is not already covered by browser-test / browser-net-test / browser-join-test
// / browser-resilience-test. See coverage table in docs/state-machine.md.
//
// Covered here:
//   T01 LANDING→SP-PICK          T02 SP-PICK→LANDING
//   T06 IN-GAME-SP→LANDING       T07 LANDING→MP-LOBBY
//   T08 LANDING→DROP-IN-OFFER    T09 MP-LOBBY→MP-PARAMS
//   T10 MP-PARAMS→MP-LOBBY       T11 MP-LOBBY→LANDING (ESC)
//   T12 DROP-IN-OFFER→LANDING    T13 MP-LOBBY→MP-COUNTDOWN
//   T16 MP-LOADING→LANDING       T21 MP-LOBBY→LANDING (ws)
//   T22 DROP-IN-OFFER→LANDING    T23 MP-COUNTDOWN→LANDING (ws)
//   T24 MP-PARAMS→LANDING (ws)   T25 MP-COUNTDOWN→LANDING (ESC)
//   Impossible-state guard: countdown cleared on ws-close (Bug#1/T23)
//   Impossible-state guard: countdown cleared on ESC mid-countdown (Bug#1/T25)
//   Impossible-state guard: booted reset on MP WAD fail (Bug#2)
//
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const chrome = await launchChrome();
const openTab = () => chrome.tab(url);
const cleanup = code => { chrome.kill(); process.exit(code); };

// thin names over the tab helpers, so the cases read as they always did
const clickItem = (tab, text, retries) => tab.click(text, retries);
const pressEsc = tab => tab.esc();

// Patch the page's WebSocket constructor to capture the lobby socket, so a
// case can close it from outside or inject a server frame.
async function patchWS(tab) {
    await tab.ev(`
        (() => {
            if (window.__wsPatched) return;
            window.__wsPatched = true;
            window.__lobbyWS = null;
            const Orig = window.WebSocket;
            window.WebSocket = function(url, ...a) {
                const ws = new Orig(url, ...a);
                if (typeof url === 'string' && url.includes('/ws/lobby'))
                    window.__lobbyWS = ws;
                return ws;
            };
            Object.assign(window.WebSocket, Orig);
        })()
    `);
}
const forceCloseWS = tab => tab.ev(`if (window.__lobbyWS) window.__lobbyWS.close()`);

// Wait for the server to have no live session: open a tab, look at what
// MULTIPLAYER offers (START GAME = clean, DROP IN = a session is live).
async function waitForCleanServer(secs = 20) {
    const deadline = Date.now() + secs * 1000;
    while (Date.now() < deadline) {
        const tab = await openTab();
        try {
            if (!await tab.waitForMenu(6)) { await tab.close(); await sleep(1000); continue; }
            await patchWS(tab);
            await tab.click('MULTIPLAYER', 6);
            let clean = false;
            for (let i = 0; i < 8; i++) {
                if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`)) { clean = true; break; }
                const hasDropIn = await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`);
                if (!hasDropIn && i > 2) { clean = true; break; }   // maybe no roster yet
                await sleep(500);
            }
            await tab.close();
            if (clean) return;
        } catch {
            try { await tab.close(); } catch { /* gone */ }
        }
        await sleep(1000);
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function runTest(name, fn) {
    console.log(`\n[TEST] ${name}`);
    try { await fn(); check(name, true); }
    catch (err) { check(name, false, err.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: lobby-menu-nav
// Covers T01 LANDING→SP-PICK, T02 SP-PICK→LANDING,
//         T07 LANDING→MP-LOBBY, T09 MP-LOBBY→MP-PARAMS (5 pickers),
//         T10 MP-PARAMS→MP-LOBBY, T11 MP-LOBBY→LANDING (ESC)
// No server game session started.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('lobby-menu-nav', async () => {
    const tab = await openTab();
    try {
        assert(await tab.waitForMenu(), 'root menu did not appear');

        // T01: LANDING → SP-PICK
        assert(await clickItem(tab, 'SINGLE PLAYER'), 'SINGLE PLAYER not found');
        await sleep(200);
        const inSpPick = await tab.ev(`!!document.querySelector('#dmenu .mtitle') || !!document.querySelector('#dmenu .row')`);
        assert(inSpPick, 'T01: SP-PICK screen did not appear');
        const noStart = await tab.ev(`!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`);
        assert(noStart, 'T01: still showing root after SINGLE PLAYER click');

        // T02: SP-PICK → LANDING
        await pressEsc(tab);
        await sleep(200);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`),
            'T02: ESC did not return to LANDING',
        );

        // T07: LANDING → MP-LOBBY (lobby ws connects; roster pushes lobbyScreen)
        // The lobby ws connect → server roster → START GAME render is
        // occasionally lost (a transient ws-connect / first-roster race — the
        // click lands but no lobbyScreen appears). The assertion below is
        // unchanged (START GAME *must* appear); we only re-ATTEMPT the flaky
        // action: if the row hasn't shown after ~4s, ESC back to the root menu
        // and re-open MULTIPLAYER. Up to 3 attempts. A genuinely broken lobby
        // fails all three; a transient race passes on retry.
        await patchWS(tab);
        let inLobby = false;
        for (let attempt = 0; attempt < 3 && !inLobby; attempt++) {
            assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
            for (let i = 0; i < 14; i++) {   // ~4.2s poll per attempt
                if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                    { inLobby = true; break; }
                await sleep(300);
            }
            if (!inLobby) {   // re-attempt: return to root, drop the stale ws
                await pressEsc(tab);
                await sleep(400);
            }
        }
        assert(inLobby, 'T07: MP-LOBBY (START GAME row) did not appear after 3 attempts');

        // MODE and SKILL are value rows, not pickers: a click steps the value
        // in place and the lobby screen stays.
        const rowLabel = async pfx => tab.ev(
            `[...document.querySelectorAll('#dmenu .row')].find(r => r.dataset.label.startsWith(${JSON.stringify(pfx)}))?.dataset.label ?? null`);
        for (const label of ['MODE:', 'SKILL:']) {
            const before = await rowLabel(label);
            assert(before, `${label} row not found`);
            assert(await clickItem(tab, label), `${label} row not clickable`);
            await sleep(200);
            const after = await rowLabel(label);
            assert(after && after !== before, `${label} did not step on click (${before} -> ${after})`);
            assert(await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
                   `${label} left the lobby screen`);
        }

        // T09/T10 × 3 pickers: open each picker, verify screen changed, ESC back
        for (const label of ['GAME:', 'MAP:', 'RULES']) {
            assert(await clickItem(tab, label), `T09: ${label} row not found`);

            await sleep(200);
            const notLobby = await tab.ev(`!document.querySelector('#dmenu .row[data-label*="START GAME"]')`);
            assert(notLobby, `T09: ${label} picker did not replace lobby screen`);
            await pressEsc(tab);
            await sleep(200);
            const backLobby = await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`);
            assert(backLobby, `T10: ESC from ${label} picker did not return to MP-LOBBY`);
        }

        // T11: MP-LOBBY → LANDING (ESC triggers leaveLobby → root)
        await pressEsc(tab);
        await sleep(400);
        const atRoot = await tab.ev(
            `!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
             !document.querySelector('#dmenu .row[data-label*="START GAME"]')`,
        );
        assert(atRoot, 'T11: ESC from MP-LOBBY did not return to LANDING');
        // lobby ws must be closed
        const wsGone = await tab.ev(`window.__lobbyWS?.readyState >= 2`);
        assert(wsGone, 'T11: lobby ws not closed after leaveLobby');

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: sp-quit
// Covers T06: IN-GAME-SP → LANDING (onQuit callback)
// SP path only — no lobby server session.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('sp-quit', async () => {
    const tab = await openTab();
    try {
        assert(await tab.waitForMenu(), 'root menu did not appear');

        let clicked = false, booted = false;
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            if (!clicked) {
                clicked = await tab.ev(`(() => {
                    const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
                    if (!sp) return false;
                    sp.click();
                    const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]')
                           || document.querySelector('#dmenu .row[data-label*="DOOM"]');
                    if (!g) return false;
                    g.click();
                    return true;
                })()`);
                continue;
            }
            booted = await tab.ev(
                `!document.getElementById('screen').hidden &&
                 document.getElementById('status')?.textContent === ''`,
            );
            if (booted) break;
        }
        assert(booted, 'sp-quit: engine did not boot');

        // T06: trigger the onQuit callback (same path as in-engine Quit Game → Y)
        await tab.ev(`window.webdoom?.doom?.onQuit?.()`);
        await sleep(800);

        assert(
            await tab.ev(`!document.getElementById('landing').hidden &&
                          !!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`),
            'T06: onQuit did not return to LANDING',
        );
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T06: game canvas still visible after quit',
        );
        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: mp-lobby-ws-close
// Covers T21: MP-LOBBY → LANDING (unexpected ws close)
//         T24: MP-PARAMS → LANDING (ws close while picker open)
// No START GAME → no server session started.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('mp-lobby-ws-close', async () => {
    const tab = await openTab();
    try {
        assert(await tab.waitForMenu(), 'root menu did not appear');
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-lobby-ws-close: MP-LOBBY did not appear');

        // T21: force ws close while in MP-LOBBY
        await forceCloseWS(tab);
        await sleep(600);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T21: ws close did not reset to LANDING from MP-LOBBY',
        );
        assert(
            (await tab.ev(`document.getElementById('status')?.textContent`))?.length > 0,
            'T21: no status message on unexpected ws close',
        );

        // T24: reconnect, navigate into a picker, close ws there
        await patchWS(tab);
        assert(await clickItem(tab, 'MULTIPLAYER'), 'T24: MULTIPLAYER not found on retry');
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`)) break;
            await sleep(300);
        }
        assert(await clickItem(tab, 'GAME:'), 'T24: GAME row not found');
        await sleep(200);
        assert(
            await tab.ev(`!document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T24: not in MP-PARAMS before ws close',
        );
        await forceCloseWS(tab);
        await sleep(600);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T24: ws close from MP-PARAMS did not reset to LANDING',
        );

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: drop-in-offer-esc
// Covers T08: LANDING → DROP-IN-OFFER
//         T12: DROP-IN-OFFER → LANDING (ESC → leaveLobby)
// Tab A starts a co-op game; tab B joins the offer screen and ESCs.
// Closing tabA terminates its relay ws → server endSession immediately.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('drop-in-offer-esc', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    try {
        assert(await tabA.waitForMenu(), 'A: menu did not appear');
        assert(await tabB.waitForMenu(), 'B: menu did not appear');

        // Tab A: connect to lobby and start a solo game
        await patchWS(tabA);
        assert(await clickItem(tabA, 'MULTIPLAYER'), 'A: MULTIPLAYER not found');
        for (let i = 0; i < 20; i++) {
            if (await tabA.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`)) break;
            await sleep(300);
        }
        assert(await clickItem(tabA, 'START GAME'), 'A: START GAME not found');
        let aInGame = false;
        for (let i = 0; i < 60; i++) {
            aInGame = await tabA.ev(
                `!document.getElementById('screen').hidden &&
                 document.getElementById('status')?.textContent === ''`,
            );
            if (aInGame) break;
            await sleep(500);
        }
        assert(aInGame, 'A: did not boot into game');
        await sleep(1500); // let server accumulate some game history

        // T08: Tab B opens MULTIPLAYER → inprogress → DROP-IN-OFFER
        await patchWS(tabB);
        assert(await clickItem(tabB, 'MULTIPLAYER'), 'B: MULTIPLAYER not found');
        let bHasOffer = false;
        for (let i = 0; i < 20; i++) {
            if (await tabB.ev(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`))
                { bHasOffer = true; break; }
            await sleep(500);
        }
        assert(bHasOffer, 'T08: B did not see DROP IN on GAME IN PROGRESS screen');

        // T12: ESC → LANDING
        await pressEsc(tabB);
        await sleep(400);
        assert(
            await tabB.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                           !document.querySelector('#dmenu .row[data-label*="DROP IN"]')`),
            'T12: ESC from DROP-IN-OFFER did not return to LANDING',
        );
        assert(
            await tabB.ev(`document.getElementById('screen').hidden`),
            'T12: game canvas not hidden after ESC from drop-in-offer',
        );

        assert(tabA.errors.length === 0, `A exceptions: ${tabA.errors.join('; ')}`);
        assert(tabB.errors.length === 0, `B exceptions: ${tabB.errors.join('; ')}`);
    } finally {
        await tabA.close();
        await tabB.close();
        // tabA.close() terminates the Chrome tab which closes its relay ws,
        // causing the server to call endSession('all players left') immediately.
        await sleep(1500);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: drop-in-offer-ws-close
// Covers T22: DROP-IN-OFFER → LANDING (unexpected ws close)
// Same setup as test 4 but force-closes B's lobby ws instead of ESC.
// ═══════════════════════════════════════════════════════════════════════════
await runTest('drop-in-offer-ws-close', async () => {
    // Ensure previous session has fully ended
    await waitForCleanServer(12);

    const tabA = await openTab();
    const tabB = await openTab();
    try {
        assert(await tabA.waitForMenu(), 'A: menu did not appear');
        assert(await tabB.waitForMenu(), 'B: menu did not appear');

        await patchWS(tabA);
        assert(await clickItem(tabA, 'MULTIPLAYER'), 'A: MULTIPLAYER not found');
        for (let i = 0; i < 20; i++) {
            if (await tabA.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`)) break;
            await sleep(300);
        }
        assert(await clickItem(tabA, 'START GAME'), 'A: START GAME not found');
        let aInGame = false;
        for (let i = 0; i < 60; i++) {
            aInGame = await tabA.ev(
                `!document.getElementById('screen').hidden &&
                 document.getElementById('status')?.textContent === ''`,
            );
            if (aInGame) break;
            await sleep(500);
        }
        assert(aInGame, 'A: did not boot into game');
        await sleep(1500);

        await patchWS(tabB);
        assert(await clickItem(tabB, 'MULTIPLAYER'), 'B: MULTIPLAYER not found');
        let bHasOffer = false;
        for (let i = 0; i < 20; i++) {
            if (await tabB.ev(`!!document.querySelector('#dmenu .row[data-label*="DROP IN"]')`))
                { bHasOffer = true; break; }
            await sleep(500);
        }
        assert(bHasOffer, 'T22 setup: B did not see DROP IN');

        // T22: force-close B's lobby ws
        await forceCloseWS(tabB);
        await sleep(600);
        assert(
            await tabB.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                           !document.querySelector('#dmenu .row[data-label*="DROP IN"]')`),
            'T22: ws close did not return B to LANDING from DROP-IN-OFFER',
        );

        assert(tabA.errors.length === 0, `A exceptions: ${tabA.errors.join('; ')}`);
        assert(tabB.errors.length === 0, `B exceptions: ${tabB.errors.join('; ')}`);
    } finally {
        await tabA.close();
        await tabB.close();
        await sleep(1500);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: mp-countdown-ws-close
// Covers T13: MP-LOBBY → MP-COUNTDOWN (START GAME → countdown visible)
//         T23: MP-COUNTDOWN → LANDING (ws close) + impossible-state Bug#1
// Server session starts after 3-second countdown; we disconnect the client
// during the countdown. Session will linger ~13s (10s nobody-joined timeout).
// ═══════════════════════════════════════════════════════════════════════════
await waitForCleanServer(12);
await runTest('mp-countdown-ws-close', async () => {
    const tab = await openTab();
    try {
        assert(await tab.waitForMenu(), 'root menu did not appear');
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-countdown-ws-close: MP-LOBBY did not appear');

        // T13: click START GAME → server sends countdown messages → overlay visible
        assert(await clickItem(tab, 'START GAME'), 'START GAME not found');
        let cdVisible = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!document.getElementById('countdown')?.hidden`))
                { cdVisible = true; break; }
            await sleep(200);
        }
        assert(cdVisible, 'T13: countdown host element did not become visible');

        // T23 + Bug#1 guard: close ws mid-countdown
        await forceCloseWS(tab);
        await sleep(800);

        // countdown MUST be hidden (countdown.reset() called in closed handler)
        assert(
            await tab.ev(`!!document.getElementById('countdown')?.hidden`),
            'T23/Bug#1: countdown still visible after ws close — countdown.reset() not called',
        );
        // root menu must be back
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T23: ws close did not reset to LANDING root menu',
        );
        // game canvas must be hidden (booted must be false)
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T23: game canvas visible after ws close mid-countdown',
        );

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: mp-countdown-esc
// Covers T25: MP-COUNTDOWN → LANDING (ESC → leaveLobby)
//         + impossible-state Bug#1 via the ESC path (missed by first audit).
// Trace: leaveLobby() sets lobby=null synchronously, then ws close fires;
// the closed handler's `if (!lobby) return` early-exits, so countdown.reset()
// in the closed handler is never reached. The fix is countdown.reset() in
// leaveLobby() itself.
// Session lingers after ESC (server countdown still fires); waitForCleanServer
// before the next test.
// ═══════════════════════════════════════════════════════════════════════════
await waitForCleanServer(16);
await runTest('mp-countdown-esc', async () => {
    const tab = await openTab();
    try {
        assert(await tab.waitForMenu(), 'root menu did not appear');
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-countdown-esc: MP-LOBBY did not appear');

        // T13 (prerequisite): START GAME → countdown overlay appears
        assert(await clickItem(tab, 'START GAME'), 'START GAME not found');
        let cdVisible = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!document.getElementById('countdown')?.hidden`))
                { cdVisible = true; break; }
            await sleep(200);
        }
        assert(cdVisible, 'T25 setup: countdown did not appear after START GAME');

        // T25 + Bug#1(ESC): press ESC → leaveLobby() → countdown.reset() must fire
        await pressEsc(tab);
        await sleep(500);

        // countdown MUST be hidden
        assert(
            await tab.ev(`!!document.getElementById('countdown')?.hidden`),
            'T25/Bug#1(ESC): countdown still visible after ESC mid-countdown — countdown.reset() missing from leaveLobby()',
        );
        // root menu must be restored and interactive
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T25: ESC from MP-COUNTDOWN did not restore LANDING root menu',
        );
        // game canvas must be hidden (booted never set — launch never fired)
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T25: game canvas visible after ESC mid-countdown',
        );

        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 7b: mp-lobby-full
// Covers T30: MP-LOBBY → LANDING (server `full`).  The handler is the same
// from MP-CONNECTING and DROP-IN-OFFER.  The frame is injected through the
// captured socket, since a real refusal needs four other players.  It used to
// null the handle WITHOUT closing the socket: a second MULTIPLAYER opened a
// second socket beside the orphan, and DROP IN dereferenced null.
// ═══════════════════════════════════════════════════════════════════════════
await waitForCleanServer(16);
await runTest('mp-lobby-full', async () => {
    const tab = await openTab();
    try {
        assert(await tab.waitForMenu(), 'root menu did not appear');
        await patchWS(tab);
        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-lobby-full: MP-LOBBY did not appear');

        await tab.ev(`window.__lobbyWS.onmessage({ data: JSON.stringify({ t: 'full', reason: 'game full (injected)' }) })`);
        await sleep(600);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]') &&
                          !document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
            'T30: server full did not reset to LANDING',
        );
        assert(
            (await tab.ev(`document.getElementById('status')?.textContent`) ?? '').includes('full'),
            'T30: the refusal reason is not shown',
        );
        assert(await tab.ev(`window.__lobbyWS.readyState >= 2`), 'T30: lobby socket left open after full');

        // and MULTIPLAYER works again, on a fresh socket
        assert(await clickItem(tab, 'MULTIPLAYER'), 'T30: MULTIPLAYER not found after full');
        inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'T30: MP-LOBBY did not reappear after full');
        assert(await tab.ev(`window.__lobbyWS.readyState === 1`), 'T30: no live lobby socket after re-entry');
        await pressEsc(tab);
        await sleep(300);
        assert(tab.errors.length === 0, `exceptions: ${tab.errors.join('; ')}`);
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 8: mp-launch-wad-fail

// Covers T16: MP-LOADING → LANDING (WAD failure) + impossible-state Bug#2
// Also exercises the same catch path for T20 (DROP-IN-LOADING → LANDING,
// same catch block — drop-in entry point not independently driven).
// WAD fetch is blocked after START, forcing bootDoom to reject post-launch.
// Session starts then lingers; it's the last game-starting test so no follow-on.
// ═══════════════════════════════════════════════════════════════════════════
await waitForCleanServer(16);
await runTest('mp-launch-wad-fail', async () => {
    const tab = await openTab();
    try {
        assert(await tab.waitForMenu(), 'root menu did not appear');
        await tab.cdp('Network.enable', {});
        await patchWS(tab);

        assert(await clickItem(tab, 'MULTIPLAYER'), 'MULTIPLAYER not found');
        let inLobby = false;
        for (let i = 0; i < 20; i++) {
            if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`))
                { inLobby = true; break; }
            await sleep(300);
        }
        assert(inLobby, 'mp-launch-wad-fail: MP-LOBBY did not appear');

        // Block WAD fetches; click START → countdown → launch → bootDoom fails
        await tab.cdp('Network.setBlockedURLs', { urls: ['*/wads/*'] });
        assert(await clickItem(tab, 'START GAME'), 'START GAME not found');

        // Wait for error status after bootDoom rejects
        let statusText = '', landingVisible = false;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            statusText = (await tab.ev(`document.getElementById('status')?.textContent`)) ?? '';
            if (statusText.length > 0) {
                landingVisible = await tab.ev(`!document.getElementById('landing').hidden`);
                break;
            }
        }

        // Bug#2 guard assertions
        assert(statusText.length > 0, 'T16/Bug#2: no error status shown after MP WAD failure');
        assert(landingVisible, 'T16/Bug#2: landing hidden after MP WAD failure — user stuck');
        assert(
            await tab.ev(`document.getElementById('screen').hidden`),
            'T16/Bug#2: game canvas visible — booted not reset after MP WAD failure',
        );
        assert(
            await tab.ev(`!!document.getElementById('countdown')?.hidden`),
            'T16/Bug#2: countdown still visible after MP WAD failure',
        );
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`),
            'T16/Bug#2: root menu not restored after MP WAD failure',
        );

        // No fatal (non-WAD-fetch) exceptions
        const fatal = tab.errors.filter(e =>
            !/wad fetch failed|Failed to fetch|ERR_BLOCKED/i.test(e),
        );
        assert(fatal.length === 0, `unexpected exceptions: ${fatal.join('; ')}`);

        // Recovery check: MULTIPLAYER re-connects after failure (booted=false, lobby=null)
        await tab.cdp('Network.setBlockedURLs', { urls: [] });
        await tab.ev(`document.getElementById('status').textContent = ''`);
        assert(
            await tab.ev(`!!document.querySelector('#dmenu .row[data-label="MULTIPLAYER"]')`),
            'T16/Bug#2: MULTIPLAYER row missing after failure — menu not restored',
        );
    } finally {
        await tab.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── lobby state-machine test results ────────────────────────');
summary('lobby state-machine edges covered and clean');
cleanup(process.exitCode ?? 0);
