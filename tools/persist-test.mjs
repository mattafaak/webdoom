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
// ── Phase 2b: Load Game slot visibility (task 16.1) ──────────────────────────
// After reload the six Load-Game slots must be populated via the web bridge
// (M_ReadSaveStrings → Web_FileLen / Web_FileCopyN).  Slot 0 was saved above
// so it must be selectable (status 1).
//
// Discriminator: web_menu_active() (exported from i_main.c).
//   • A status-1 slot triggers M_LoadSelect → M_ClearMenus → menuactive=0.
//   • A status-0 (unselectable) slot does nothing; menuactive stays 1.
// This is exact vanilla semantics — no timing heuristics.
await key('F3', 0x72);   // open Load Game menu (menuactive → 1)
await sleep(400);
const menuOpenedAfterF3 = await ev(`window.webdoom?.doom?.ccall('web_menu_active','number',[],[]) === 1`);
console.log('menu active after F3:', menuOpenedAfterF3);
if (!menuOpenedAfterF3) fail('Load Game menu did not open after F3 (web_menu_active !== 1)');
await key('Enter', 13);  // select slot 0
// poll up to 2 s for menuactive to drop to 0 (slot was selectable → loaded)
let slotLoaded = false;
for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (await ev(`window.webdoom?.doom?.ccall('web_menu_active','number',[],[]) === 0`)) {
        slotLoaded = true; break;
    }
}
console.log('load-game slot 0 selectable (menuactive cleared):', slotLoaded);
if (!slotLoaded) fail('Load Game slot 0 was not selectable after reload — menuactive did not clear (M_ReadSaveStrings bridge not working)');

// ── Phase 4: quit-within-3s durability (task 16.2) ───────────────────────────
// Scenario: player saves, then quits before the 3-second sync interval fires.
// The save must survive via write-through (doom.onFileWrite) and/or the final
// flush triggered in doom.onQuit. Without the fix the save is lost.
//
// We reload for a fresh engine so slot-1 is guaranteed empty pre-save.
await cdp('Page.reload');
await bootSP();
// Start a new game to reach E1M1 again
for (const [k, vk] of [['Escape', 27], ['Enter', 13], ['Enter', 13], ['Enter', 13]]) await key(k, vk);
await sleep(3000);   // wait for map to load

// Verify write-through is wired: check that doom.onFileWrite is a function
const hasOnFileWrite = await ev(`typeof window.webdoom?.doom?.onFileWrite === 'function'`);
console.log('doom.onFileWrite wired:', hasOnFileWrite);
if (!hasOnFileWrite) fail('doom.onFileWrite not wired — write-through missing');

// Save to slot 1: F2, arrow-down (slot 1), Enter, type 'b', Enter
await key('F2', 0x71);
await sleep(200);
await key('ArrowDown', 40);
await sleep(100);
await key('Enter', 13);
await key('b', 66);
await key('Enter', 13);
// Wait 500ms — long enough for write-through IDB write, SHORT enough to be
// well within the 3s interval (so this tests write-through, not the interval).
await sleep(500);

// Assert the save is in IDB immediately after write-through (not via interval)
const inIdbWriteThrough = await ev(`(async () => {
    const d = await new Promise((res, rej) => { const r = indexedDB.open('webdoom', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const v = await new Promise(res => { const t = d.transaction('files');
        const g = t.objectStore('files').get('doom.wad:doomsav1.dsg');
        t.oncomplete = () => res(g.result); });
    d.close(); return v ? v.length : 0;
})()`);
console.log('savegame bytes in IDB via write-through (< 3s after save):', inIdbWriteThrough);
if (!inIdbWriteThrough) fail('write-through did not persist doomsav1.dsg within 500ms — doom.onFileWrite not working');

// Now trigger quit immediately (simulating "Quit Game → Y" within 3s of save).
// The interval has NOT fired (< 3s since save).  The final flush in onQuit
// must ensure the save is still durable.
await ev(`window.webdoom?.doom?.onQuit?.()`);
await sleep(300);   // let the async flush complete

// Reload and verify the save survived the quick quit
await cdp('Page.reload');
await bootSP();
const restoredAfterQuickQuit = await ev(`window.webdoom.doom['fileMap']?.get('doomsav1.dsg')?.length ?? 0`);
console.log('savegame bytes restored after quit-within-3s:', restoredAfterQuickQuit);
if (!restoredAfterQuickQuit) fail('save lost after quit-within-3s — write-through or final flush broken');
console.log('quit-within-3s test: PASS');

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

console.log('PASS — savegame survives a page reload; load slots visible; quit-within-3s durable; interval stops cleanly on quit');
chrome.kill(); process.exit(0);
