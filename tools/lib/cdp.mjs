// Headless Chrome over raw CDP, the way every browser leg did it by hand.
// launchChrome() spawns, allocates a port, waits for /json/version; tab()
// opens a page with the JSON-RPC demux and the helpers the legs share.
import { spawn } from 'node:child_process';
import { chromeBin, chromeProfileArg, reapOnExit } from '../chrome-harness.mjs';
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
    const proc = spawn(chromeBin(), [
        ...(headless ? ['--headless=new'] : []), `--remote-debugging-port=${port}`, chromeProfileArg(),
        '--no-first-run', '--no-sandbox', ...GPU[gpu], `--window-size=${windowSize}`,
        '--autoplay-policy=no-user-gesture-required', ...flags, 'about:blank',
    ], { stdio: 'ignore', detached: true });
    const kill = reapOnExit(proc);
    const deadline = Date.now() + readyMs;
    for (;;) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* not yet */ }
        if (Date.now() > deadline) { kill(); throw new Error(`chrome did not answer CDP on ${port} in ${readyMs} ms`); }
        await sleep(200);
    }
    return { port, proc, kill, tab: url => openTab(port, url) };
}

async function openTab(port, url = 'about:blank') {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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
        navigate: url => cdp('Page.navigate', { url }),
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
        row: pfx => tab.ev(`document.querySelector('#dmenu .row[data-label^=${JSON.stringify(pfx)}]')?.dataset.label ?? null`),
        inGame: () => tab.ev(`!document.getElementById('screen').hidden && document.getElementById('status')?.textContent === ''`),
        // SINGLE PLAYER → the first Doom entry → the engine running
        async bootSP(secs = 90) {
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
                if (await tab.ev(`!!window.webdoom?.doom && document.getElementById('status')?.textContent === ''`)) return true;
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
