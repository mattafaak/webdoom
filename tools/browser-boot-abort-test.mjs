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
// interception, releases it, and then requires that whenever the launcher is
// showing, the engine runs no frames.
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

// From here on, sample: whenever #landing is showing, frames must not advance.
await tab.waitFor(() => tab.ev(`!!window.webdoom?.doom`), { timeout: 15000 });
await tab.ev(`(() => { const d = window.webdoom?.doom; if (!d) return;
    const f = d._web_frame; window.__frames = 0; d._web_frame = (...a) => { window.__frames++; return f.apply(d, a); }; })()`);
let sampled = 0, zombie = 0;
for (let i = 0; i < 20; i++) {
    const before = await tab.ev(`window.__frames ?? 0`);
    await sleep(300);
    const s = await tab.ev(`({ landing: !document.getElementById('landing').hidden, frames: window.__frames ?? 0 })`);
    if (s.landing) { sampled++; if (s.frames > before) zombie++; }
}
check('the launcher came back', sampled > 0, 'never saw #landing');
check(`no engine frames while the launcher shows (${sampled} samples)`, zombie === 0, `frames ran in ${zombie} of ${sampled}`);
const gameSockets = await tab.ev(`window.__sockets.filter(s => s.url.includes('/ws/game') && s.readyState <= 1).length`);
check('no game socket is left open behind the launcher', gameSockets === 0, `${gameSockets} open`);
await tab.close();
summary('a session that ends while the game is loading leaves nothing running');
process.exit();
