// Headless Chrome over raw CDP, the way every browser leg did it by hand.
// launchChrome() spawns, allocates a port, waits for /json/version; tab()
// opens a page with the JSON-RPC demux and the helpers the legs share, and
// window() the same in a window of its own (a page that must keep running
// while another is open: see openWindow).
import { spawn } from 'node:child_process';
import { chromeBin, chromeProfile, reapOnExit } from '../chrome-harness.mjs';
import { sleep, freePort } from './util.mjs';

// Two GPU families exist: swiftshader (most legs) and none (the own-server
// legs, where swiftshader crashed in containers).  `flags` are appended.
const GPU = {
    swiftshader: ['--disable-gpu-sandbox', '--use-angle=swiftshader'],
    none:        ['--disable-gpu', '--disable-dev-shm-usage'],
};

export async function launchChrome({ gpu = 'swiftshader', flags = [], port = null, windowSize = '1280,960', readyMs = 20000,
                                     headless = true } = {}) {
    port ??= process.env.CDP_PORT ? +process.env.CDP_PORT : await freePort();
    const profile = chromeProfile();
    // TMPDIR inside the profile: Chrome's singleton directory goes with it
    const proc = spawn(chromeBin(), [
        ...(headless ? ['--headless=new'] : []), `--remote-debugging-port=${port}`, profile.arg,
        '--no-first-run', '--no-sandbox', ...GPU[gpu], `--window-size=${windowSize}`,
        '--autoplay-policy=no-user-gesture-required', ...flags, 'about:blank',
    ], { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: profile.dir } });
    const kill = reapOnExit(proc, profile.dir);
    const deadline = Date.now() + readyMs;
    for (;;) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* not yet */ }
        if (Date.now() > deadline) { kill(); throw new Error(`chrome did not answer CDP on ${port} in ${readyMs} ms`); }
        await sleep(200);
    }
    return { port, proc, kill, tab: url => openTab(port, url), window: url => openWindow(port, url) };
}

async function openTab(port, url = 'about:blank') {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    return attach(port, target);
}

// A page in a window of its own.  Chrome shows one tab per window: a tab
// opened beside another hides it (document.visibilityState 'hidden'), and a
// hidden page gets no requestAnimationFrame, which is what runs the game
// (client/js/main.js).  So players sharing a window stop playing as soon as
// another tab opens, and the server drops a player silent for its DROP_MS
// (server/game.js).  Measured headless, a co-op host at gametic 32: with a
// second tab opened beside it, it read 'hidden' and stopped at 33, and 7 s
// later "the connection to the game server was lost" (the server: "dropped
// (unresponsive)"); with the second page in a new window it stayed 'visible'
// and went on at 35 tics a second.  The page opens on about:blank and is
// attached before it navigates, so it misses no event of the load.
async function openWindow(port, url = 'about:blank') {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
    const reply = await new Promise(res => {
        bws.onmessage = ev => res(JSON.parse(ev.data));
        bws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank', newWindow: true } }));
    });
    bws.close();
    const id = reply.result?.targetId;
    if (!id) throw new Error(`Target.createTarget (newWindow) failed: ${JSON.stringify(reply.error ?? reply)}`);
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.id === id);
    if (!target) throw new Error(`the new window's page ${id} is not in /json/list`);
    const tab = await attach(port, target);
    if (url !== 'about:blank') await tab.cdp('Page.navigate', { url });
    return tab;
}

async function attach(port, target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const errors = [];    // exceptions + console.error
    const warnings = [];  // console.warn
    const logs = [];      // every console call
    const handlers = new Map();   // CDP event method → handler (tab.on)
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown')
            errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '?');
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = m.params.args.map(a => a.value ?? a.description).join(' ');
            logs.push(text);
            if (m.params.type === 'error') errors.push(text);
            if (m.params.type === 'warning') warnings.push(text);
        }
        handlers.get(m.method)?.(m.params);
    };
    const cdp = (method, params = {}) => new Promise(res => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    await cdp('Runtime.enable');
    await cdp('Page.enable');

    const tab = {
        id: target.id, cdp, errors, warnings, logs,
        on: (method, fn) => handlers.set(method, fn),
        ev: async (expression, opts = {}) =>
            (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...opts })).result?.result?.value,
        // a key press; vk is the Windows virtual key code the page's handlers see
        async key(k, vk, code) {
            code ??= k.length === 1 ? `Key${k.toUpperCase()}` : k;
            await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined });
            await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
            await sleep(120);
        },
        esc: () => tab.key('Escape', 27),
        // poll fn() until truthy; false on timeout
        async waitFor(fn, { timeout = 10000, every = 250 } = {}) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) { if (await fn()) return true; await sleep(every); }
            return false;
        },
        // the launcher's root menu; throws on an error status, false on timeout
        async waitForMenu(secs = 25) {
            for (let i = 0; i < secs * 2; i++) {
                if (await tab.ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`)) return true;
                const s = await tab.ev(`document.getElementById('status')?.textContent`);
                if (s && /^(cannot|engine error|Error)/.test(s)) throw new Error(`status while waiting for menu: ${s}`);
                await sleep(500);
            }
            return false;
        },
        waitForSW: (secs = 40) => tab.waitFor(() => tab.ev(`!!navigator.serviceWorker?.controller`), { timeout: secs * 1000, every: 500 }),
        // click a menu row whose data-label contains text
        async click(text, retries = 15) {
            for (let i = 0; i < retries; i++) {
                if (await tab.ev(`(() => { const r = document.querySelector('#dmenu .row[data-label*=${JSON.stringify(text)}]'); return r ? (r.click(), true) : false; })()`)) return true;
                await sleep(300);
            }
            return false;
        },
        inGame: () => tab.ev(`!document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`),
        // inGame() turns true as soon as a boot shows the screen, before the
        // engine runs (measured: 1 ms after SPECTATE, the engine at 1,464 ms).
        // running() is the engine itself: its handle published and the loading
        // panel gone, as browser-join-test.mjs waits for it.
        running: async () => (await tab.ev(`!!window.webdoom?.doom && document.getElementById('loading')?.hidden === true &&
            !document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`)) === true,
        // SINGLE PLAYER → the first Doom entry → the engine running.  "Running"
        // is a handle other than the one present when this started: a page
        // that kept the previous session's handle would otherwise satisfy the
        // wait while this boot is still downloading.  The old handle is marked
        // rather than held, so the wait cannot keep a dead engine reachable.
        async bootSP(secs = 90) {
            await tab.ev(`(() => { const d = window.webdoom?.doom; if (d) d.__bootSPStale = true; })()`);
            let clicked = false;
            for (let i = 0; i < secs * 2; i++) {
                await sleep(500);
                const s = await tab.ev(`document.getElementById('status')?.textContent`);
                if (s && /^(cannot|engine error|Error)/.test(s)) throw new Error(`during SP boot: ${s}`);
                if (!clicked) {
                    clicked = await tab.ev(`(() => {
                        const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
                        if (!sp) return false; sp.click();
                        const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]') || document.querySelector('#dmenu .row[data-label*="DOOM"]');
                        return g ? (g.click(), true) : false; })()`);
                    continue;
                }
                if (await tab.ev(`(() => { const d = window.webdoom?.doom;
                        return !!d && !d.__bootSPStale && document.getElementById('status')?.textContent === ''; })()`)) return true;
            }
            return false;
        },
        // close the page (releases its sockets), then the CDP session
        async close() {
            try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch { /* gone */ }
            ws.close();
        },
    };
    return tab;
}
