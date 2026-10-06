// save in E1M1, reload the page, assert the savegame was restored into
// the fresh engine FS from IndexedDB. Also tests teardown: after
// doom.onQuit() the sync interval must stop firing (no unhandled rejections).
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';
const chrome = await launchChrome();
const url = process.argv[2] ?? (await startServer()).url;
const tab = await chrome.tab(url);
const { cdp, ev, key } = tab;
// every console line, exceptions marked, so the tail below can be filtered
const logs = tab.logs;
const bootSP = async () => { if (!await tab.bootSP(30).catch(e => fatal(e.message))) fatal('boot timeout'); };

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
check('the savegame synced to IndexedDB', inIdb > 0, 'save never synced to IndexedDB');

await cdp('Page.reload');
await bootSP();
const restored = await ev(`window.webdoom.doom['fileMap']?.get('doomsav0.dsg')?.length ?? 0`);
console.log('savegame bytes restored after reload:', restored);
check('the savegame is restored into the engine after a reload', restored > 0, 'savegame not restored after reload');
// ── Phase 2b: Load Game slot visibility ────────────────────────────────────
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
check('F3 opens the Load Game menu', menuOpenedAfterF3, 'web_menu_active !== 1');
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
check('Load Game slot 0 is selectable after a reload', slotLoaded,
      'menuactive did not clear (M_ReadSaveStrings bridge not working)');

// ── Phase 4: quit-within-3s durability ─────────────────────────────────────
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
check('doom.onFileWrite is wired (write-through)', hasOnFileWrite, 'write-through missing');

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
check('write-through stores doomsav1.dsg in IndexedDB within 500 ms', inIdbWriteThrough > 0,
      'doom.onFileWrite not working');

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
check('a save survives a quit within 3 s', restoredAfterQuickQuit > 0, 'write-through or final flush broken');

// ── Phase 2d: a save as big as the engine writes comes back ──────────────────
// Saves are sized from the level, so a map with thousands of monsters writes
// one past 1 MB: a 4096-unit room with 6,000 imps saves 1,056,607 bytes
// through the menu.  Stored, it must be restored after a reload, not dropped
// as "larger than the engine writes".
const BIG = 1056607;
await ev(`(async () => {
    const d = await new Promise((res, rej) => { const r = indexedDB.open('webdoom', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const t = d.transaction('files', 'readwrite');
        t.objectStore('files').put(new Uint8Array(${BIG}).fill(32), 'doom.wad:doomsav2.dsg');
        t.oncomplete = res; t.onerror = () => rej(t.error); });
    d.close();
})()`);
await cdp('Page.reload');
await bootSP();
const bigRestored = await ev(`window.webdoom.doom['fileMap']?.get('doomsav2.dsg')?.length ?? 0`);
console.log('a 1,056,607-byte save restored after reload:', bigRestored);
check('a save past 1 MB, which the engine can write, is restored after a reload', bigRestored === BIG, `got ${bigRestored} bytes`);

// ── Phase 2c: a save the browser will not store is not silent ─────────────────
// The engine prints "game saved" before IndexedDB has the bytes; when the
// write fails (quota, private mode, a revoked origin) the player must be told.
await ev(`IDBObjectStore.prototype.put = function () { throw new DOMException('the disk is full', 'QuotaExceededError'); }`);
for (const [k, vk] of [['Escape', 27], ['Enter', 13], ['Enter', 13], ['Enter', 13]]) await key(k, vk);   // a new game
await sleep(2500);
await key('F2', 0x71); await key('ArrowDown', 40); await key('ArrowDown', 40); await key('Enter', 13);
await key('c', 67); await key('Enter', 13);
await sleep(1500);
const failNotice = await ev(`window.__wdLastStatus ?? ''`);
console.log('status after a refused save:', JSON.stringify(failNotice));
check('a save IndexedDB refuses is reported to the player', /would not store your save/.test(failNotice),
      'the refusal was silent: the player believes it was kept');

// ── Phase 3: teardown test ───────────────────────────────────────────────
// Set up an unhandled-rejection listener, trigger doom.onQuit() to stop the
// sync interval, wait > 3 s, then assert no wasm/sync rejections fired.
await ev(`window.__urj = []; window.addEventListener('unhandledrejection', e => window.__urj.push(String(e.reason)));`);
// Trigger quit programmatically (same path as Quit Game → Y in the engine)
await ev(`window.webdoom?.doom?.onQuit?.()`);
await sleep(4500);  // wait > the 3 s interval to catch any orphaned firing
const urjRaw = await ev(`JSON.stringify(window.__urj)`);
const urjList = JSON.parse(urjRaw ?? '[]');
const badRej = urjList.filter(r => /wasm|RuntimeError|abort|sync|save/i.test(r));
console.log(`teardown test: ${urjList.length} total unhandled rejections, ${badRej.length} wasm/sync related`);
check('no wasm/sync unhandled rejection after quit (the sync interval stopped)', badRej.length === 0, badRej.join(', '));

summary('savegame survives a page reload; load slots visible; quit-within-3s durable; a save past 1 MB is restored; a refused save is reported; interval stops cleanly on quit');
process.exit();
