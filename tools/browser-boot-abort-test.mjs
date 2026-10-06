#!/usr/bin/env node
// A session must not outlive its own end.  bootDoom awaits the engine, the WAD
// download and the save data; if the launcher takes over in the meantime and
// bootDoom carries on afterwards, it opens the game socket, attaches input and
// starts a frame loop behind the launcher that nothing can stop.
//
// The way in is the lobby: while the WAD download for a launch is still in
// flight, the server sends `full`.  This delivers both frames through the
// page's own lobby socket (WebSocket is wrapped before the page loads; the
// frames enter where a server's would), holds the download with Fetch
// interception, releases it, and then requires that the engine's frame loop
// never schedules itself while the launcher is showing.
//
// The seam is requestAnimationFrame, wrapped before the page loads, because a
// correct build never publishes an engine handle for a session that ended
// mid-boot: a probe that waits for window.webdoom has nothing to wrap there and
// measures nothing.  The wrapper attributes each registration to the module
// that made it (main.js's frame loop, not countdown.js's animations) and
// counts the ones made while #landing is visible.  Registrations, not
// callbacks: the loop's last callback can run after the launcher is back and
// correctly decline to continue.  A control boot at the end proves the seam
// sees the engine's loop when it does run.
//
// usage: node tools/browser-boot-abort-test.mjs <url>
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? fatal('usage: browser-boot-abort-test.mjs <url>');
const chrome = await launchChrome();

const tab = await chrome.tab('about:blank');
await tab.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
        const Native = window.WebSocket;
        window.__sockets = [];
        window.WebSocket = class extends Native {
            constructor(...a) { super(...a); window.__sockets.push(this); }
        };
        window.__deliver = (part, msg) => {
            const ws = window.__sockets.find(s => s.url.includes(part) && s.readyState === 1);
            if (!ws) return false;
            ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
            return true;
        };
        const raf = window.requestAnimationFrame.bind(window);
        window.__loop = { behindLauncher: 0, onScreen: 0, other: 0 };
        window.requestAnimationFrame = cb => {
            if (/\\/js\\/main\\.js/.test(new Error().stack || '')) {
                const landing = document.getElementById('landing');
                if (landing && !landing.hidden) window.__loop.behindLauncher++;
                else window.__loop.onScreen++;
            } else window.__loop.other++;
            return raf(cb);
        };
    })();` });

// the service worker would fetch the WAD itself, out of this tab's sight
await tab.cdp('Network.enable');
await tab.cdp('Network.setBypassServiceWorker', { bypass: true });
const held = [];
tab.on('Fetch.requestPaused', p => held.push(p.requestId));
await tab.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/wads/*' }] });
await tab.cdp('Page.navigate', { url });
if (!await tab.waitForMenu()) fatal('the launcher menu never appeared');
if (!await tab.click('MULTIPLAYER')) fatal('MULTIPLAYER not found');
if (!await tab.waitFor(() => tab.ev(`window.__sockets.some(s => s.url.includes('/ws/lobby') && s.readyState === 1)`), { timeout: 30000 }))
    fatal('no lobby socket');
await sleep(500);

// a launch, then -- with its WAD still downloading -- `full`
tab.ev(`__deliver('/ws/lobby', { t: 'launch', numplayers: 2, slots: [0, 1], names: ['A', 'B'],
        params: { wad: 'doom.wad', episode: 1, map: 1, skill: 3, mode: 'coop' } })`);
if (!await tab.waitFor(() => held.length > 0, { timeout: 20000 })) fatal('the launch never fetched its WAD');
await tab.ev(`__deliver('/ws/lobby', { t: 'full', reason: 'lobby full' })`);
await sleep(500);
for (const id of held.splice(0)) await tab.cdp('Fetch.continueRequest', { requestId: id });
await tab.cdp('Fetch.disable');

// From here on, sample: whenever #landing is showing, the loop must not run.
let sampled = 0, zombie = 0;
for (let i = 0; i < 20; i++) {
    const before = await tab.ev(`window.__loop.behindLauncher`);
    await sleep(300);
    const s = await tab.ev(`({ landing: !document.getElementById('landing').hidden, behind: window.__loop.behindLauncher })`);
    if (s.landing) { sampled++; if (s.behind > before) zombie++; }
}
const loop = await tab.ev(`({ ...window.__loop })`);
console.log(`  frame-loop registrations: ${loop.behindLauncher} behind the launcher, ${loop.onScreen} with the canvas up; `
          + `${loop.other} from other modules`);
check('the launcher came back', sampled > 0, 'never saw #landing');
check(`the frame loop never scheduled itself behind the launcher (${sampled} samples, ${loop.behindLauncher} registrations)`,
      loop.behindLauncher === 0, `it advanced in ${zombie} of ${sampled} samples, ${loop.behindLauncher} registrations in all`);
const gameSockets = await tab.ev(`window.__sockets.filter(s => s.url.includes('/ws/game') && s.readyState <= 1).length`);
check('no game socket is left open behind the launcher', gameSockets === 0, `${gameSockets} open`);

// CONTROL: the seam sees the engine's loop when it does run.  Without this a
// renamed module or a loop driven some other way reads as zero above.
const shownBefore = loop.onScreen;
if (!await tab.bootSP(60).catch(e => fatal(`control boot: ${e.message}`))) fatal('control boot: single player never started');
await sleep(500);
const control = await tab.ev(`({ ...window.__loop })`);
check(`CONTROL: a running game's loop is counted (${control.onScreen - shownBefore} registrations in a single-player boot)`,
      control.onScreen - shownBefore > 10, 'the seam saw no frames from a running game, so the zero above measured nothing');
check('CONTROL: none of them behind the launcher', control.behindLauncher === loop.behindLauncher,
      `${control.behindLauncher - loop.behindLauncher} more behind the launcher`);
await tab.close();
summary('a session that ends while the game is loading leaves nothing running', { min: 5 });
process.exit();
