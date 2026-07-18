// save in E1M1, reload the page, assert the savegame was restored into
// the fresh engine FS from IndexedDB. Also tests ws-008 teardown: after
// doom.onQuit() the sync interval must stop firing (no unhandled rejections).
import { spawn } from 'node:child_process';
const CDP = 9230;
const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run', '--no-sandbox',
    '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);
const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
const logs = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 200)); };
const cdp = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const key = async (k, vk, code) => {
    code ??= k.length === 1 ? `Key${k.toUpperCase()}` : k;
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    await sleep(120);
};
await cdp('Runtime.enable'); await cdp('Page.enable');
const fail = m => { console.error('FAIL:', m); chrome.kill(); process.exit(1); };

async function bootSP() {
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        if (await ev(`(() => { const r = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (!r) return false; r.click();
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]');
            return g ? (g.click(), true) : false; })()`)) break;
    }
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        if (await ev(`window.webdoom && document.getElementById('status')?.textContent === ''`)) return;
    }
    fail('boot timeout');
}

await bootSP();
// menu → new game → E1M1
for (const [k, vk] of [['Escape', 27], ['Enter', 13], ['Enter', 13], ['Enter', 13]]) await key(k, vk);
await sleep(3000);
// save: F2, Enter (slot 0), type name char, Enter
await key('F2', 0x71); await key('Enter', 13); await key('a', 65); await key('Enter', 13);
await sleep(4500);      // sync interval is 3s
const inFs = await ev(`window.webdoom.doom['fileMap']?.get('doomsav0.dsg')?.length ?? 0`);
console.log('savegame bytes in FS:', inFs);
console.log('console tail:', logs.filter(l => /sync|persist|EXC|error/i.test(l)).slice(-5));
const inIdb = await ev(`(async () => {
    const d = await new Promise((res, rej) => { const r = indexedDB.open('webdoom', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const v = await new Promise(res => { const t = d.transaction('files');
        const g = t.objectStore('files').get('doom.wad:doomsav0.dsg');
        t.oncomplete = () => res(g.result); });
    return v ? v.length : 0;
})()`);
console.log('savegame bytes in IndexedDB:', inIdb);
if (!inIdb) fail('save never synced to IndexedDB');

await cdp('Page.reload');
await bootSP();
const restored = await ev(`window.webdoom.doom['fileMap']?.get('doomsav0.dsg')?.length ?? 0`);
console.log('savegame bytes restored after reload:', restored);
if (!restored) fail('savegame not restored after reload');
console.log('savegame bytes restored after reload:', restored);

// ── Phase 3: teardown test (ws-008) ──────────────────────────────────────────
// Set up an unhandled-rejection listener, trigger doom.onQuit() to stop the
// sync interval, wait > 3 s, then assert no wasm/sync rejections fired.
await ev(`window.__urj = []; window.addEventListener('unhandledrejection', e => window.__urj.push(String(e.reason)));`);
// Trigger quit programmatically (same path as Quit Game → Y in the engine)
await ev(`window.webdoom?.doom?.onQuit?.()`);
await sleep(4500);  // wait > the 3 s interval to catch any orphaned firing
const urjRaw = await ev(`JSON.stringify(window.__urj)`);
const urjList = JSON.parse(urjRaw ?? '[]');
const badRej = urjList.filter(r => /wasm|RuntimeError|abort|sync|save/i.test(r));
if (badRej.length) fail(`unhandled rejections after quit: ${badRej.join(', ')}`);
console.log(`teardown test: ${urjList.length} total unhandled rejections, ${badRej.length} wasm/sync related — OK`);

console.log('PASS — savegame survives a page reload; interval stops cleanly on quit');
chrome.kill(); process.exit(0);
