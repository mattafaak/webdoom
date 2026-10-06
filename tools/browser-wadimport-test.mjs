#!/usr/bin/env node
// Browser test for drag-and-drop WAD import.
//
// Tests covered:
//   (1) Malformed-corpus rejection — 7 hostile inputs, each rejected with a
//       user-visible WadError message and zero uncaught exceptions.
//   (2) Import flow — synthetic PWAD (generated in-test, no binary assets)
//       imported via a real DataTransfer drop event on #landing → lobby.js
//       drop handler → e.dataTransfer.files[0] → entry appears in CHOOSE GAME.
//   (3) SP boot with imported PWAD — click entry → engine boots with local WAD.
//   (4) Reload survival — page reload → local entry still present (IDB).
//
// RED-PROOF (documented):
//   On master (feature absent), window.__wd?.wadImport is undefined → check [1]
//   fails with "FAIL: wad-import module not available".  The import-flow checks
//   [2-4] also fail because window.__wd.handleWadImport does not exist.
//   Run: node tools/browser-wadimport-test.mjs -- will exit 1 on master.
//
// Chrome flags: --disable-gpu (NOT --use-angle=swiftshader, which crashes in
// this container per env notes).
//
// Usage: node tools/browser-wadimport-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { startServer } from './lib/server.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const BASE_URL = process.argv[2] ?? (await startServer()).url;
// a fresh profile per run (launchChrome), so the SW cache is always cold on entry
const chrome = await launchChrome({ gpu: 'none' });

// The launcher menu or the end of the run: nothing below can be measured
// without it.
async function menuOrFatal(label, secs = 30) {
    if (!await tab.waitForMenu(secs).catch(e => fatal(`${label}: ${e.message}`)))
        fatal(`${label}: lobby menu did not appear within ${secs}s ` +
              `(status: "${await tab.ev(`document.getElementById('status')?.textContent`)}")`);
}

// ── Synthetic WAD factory ─────────────────────────────────────────────────────
// Makes a minimal valid PWAD:
//   header: magic(4) + nlumps(4 LE) + dirofs(4 LE) = 12 bytes
//   directory: 1 entry × 16 bytes = 16 bytes at offset 12
//   lump entry: offset(4 LE) + size(4 LE) + name(8 bytes) = 16 bytes
//   Total: 28 bytes
// The lump is a zero-size marker (name "TESTLUMP") so it doesn't interfere
// with game data and no binary assets are committed.
function makeSyntheticPWAD(lumpName = 'TESTLUMP') {
    const buf = new Uint8Array(28);
    const dv  = new DataView(buf.buffer);
    // magic: PWAD
    buf[0] = 0x50; buf[1] = 0x57; buf[2] = 0x41; buf[3] = 0x44;
    dv.setInt32(4, 1,  true);  // nlumps = 1
    dv.setInt32(8, 12, true);  // dirofs = 12 (immediately after header)
    // lump entry at offset 12:
    dv.setInt32(12, 0, true);  // lump data offset (0 = points to header; zero-size so no OOB)
    dv.setInt32(16, 0, true);  // lump size = 0 (marker lump)
    for (let i = 0; i < Math.min(lumpName.length, 8); i++)
        buf[20 + i] = lumpName.charCodeAt(i);
    return buf;
}

// ── Session ───────────────────────────────────────────────────────────────────
const tab = await chrome.tab(BASE_URL);
// insecure origins have no service worker, so this one is not fatal
if (!await tab.waitForSW(15)) console.log('  tab: SW not controlling within 15s (expected on insecure origin)');
await menuOrFatal('tab');

// ── [1] Malformed-corpus rejection tests ─────────────────────────────────────
console.log('[1] Malformed-corpus rejection tests...');

const corpusResult = await tab.ev(`
    (async () => {
        // RED-PROOF: on master window.__wd?.wadImport is undefined → TypeError here.
        if (!window.__wd?.wadImport) return JSON.stringify({ fatal: 'wad-import module not available' });
        const { identifyWad, WadError } = window.__wd?.wadImport;
        const results = [];
        const cases = [
            { desc: 'zero-byte file',           bytes: new Uint8Array(0),    name: 'test.wad' },
            { desc: 'truncated header (<12B)',   bytes: new Uint8Array(4),    name: 'test.wad' },
            { desc: 'non-IWAD/PWAD magic',       bytes: (() => {
                const b = new Uint8Array(12);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x5A; // PWAZ
                return b;
            })(), name: 'test.wad' },
            { desc: 'absurd nlumps (0x7FFFFFFF)', bytes: (() => {
                const b = new Uint8Array(12);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44; // PWAD
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 0x7FFFFFFF, true);  // 2 billion lumps
                dv.setInt32(8, 12, true);
                return b;
            })(), name: 'test.wad' },
            { desc: 'directory offset past EOF', bytes: (() => {
                const b = new Uint8Array(28);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44;
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 1, true);
                dv.setInt32(8, 9999, true);         // dirofs > fileSize
                return b;
            })(), name: 'test.wad' },
            { desc: 'negative lump size',        bytes: (() => {
                const b = new Uint8Array(28);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44;
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 1, true);
                dv.setInt32(8, 12, true);
                dv.setInt32(12, 0, true);
                dv.setInt32(16, -1, true);           // negative lump size
                return b;
            })(), name: 'test.wad' },
            { desc: 'lump data extends past EOF', bytes: (() => {
                const b = new Uint8Array(28);
                b[0]=0x50; b[1]=0x57; b[2]=0x41; b[3]=0x44;
                const dv = new DataView(b.buffer);
                dv.setInt32(4, 1, true);
                dv.setInt32(8, 12, true);
                dv.setInt32(12, 0, true);
                dv.setInt32(16, 99999, true);        // size way beyond EOF
                return b;
            })(), name: 'test.wad' },
        ];
        // A well-formed empty PWAD under names the engine would misread.
        const emptyPwad = () => { const b = new Uint8Array(12); b.set([0x50, 0x57, 0x41, 0x44]); new DataView(b.buffer).setInt32(8, 12, true); return b; };
        for (const [desc, name] of [
            ['name starting with @ (an engine response file)', '@x.wad'],
            ['name starting with - (an engine option)', '-x.wad'],
            ['non-ASCII name', 'café.wad'],
            ['name over 31 characters', 'a'.repeat(28) + '.wad'],
        ]) cases.push({ desc, bytes: emptyPwad(), name });
        for (const { desc, bytes, name } of cases) {
            try {
                await identifyWad(bytes, name);
                results.push({ desc, passed: false, error: 'no error thrown — expected WadError' });
            } catch (e) {
                results.push({
                    desc, passed: e.name === 'WadError',
                    type: e.name, msg: e.message.slice(0, 80),
                });
            }
        }
        // and the rule refuses names, not spaces: an ordinary file still imports
        try { await identifyWad(emptyPwad(), 'My Map 2.wad'); results.push({ desc: 'an ordinary name is accepted', passed: true, msg: 'accepted' }); }
        catch (e) { results.push({ desc: 'an ordinary name is accepted', passed: false, error: 'refused: ' + e.message }); }
        return JSON.stringify(results);
    })()
`);

if (!corpusResult) fatal('malformed-corpus evaluate returned null');
let corpus;
try { corpus = JSON.parse(corpusResult); } catch { fatal(`malformed-corpus result is not JSON: ${corpusResult}`); }
if (corpus.fatal) fatal(corpus.fatal);
for (const r of corpus)
    check(`[${r.desc}]: WadError("${r.msg}")`, r.passed, r.error ?? `expected WadError, got ${r.type}: ${r.msg}`);

// no uncaught exceptions from the corpus
check(`malformed corpus: all ${corpus.length} inputs handled, zero uncaught exceptions`,
      tab.errors.length === 0, `uncaught JS exceptions during corpus tests: ${tab.errors.join('; ')}`);
if (corpus.length < 12) fatal(`only ${corpus.length} corpus cases ran`);

// ── [2] Import flow — synthetic PWAD via DataTransfer drop ───────────────────
// Exercises the real drag-drop path (DataTransfer → landing drop event →
// lobby.js handler → e.dataTransfer.files[0] → handleWadImport), which is
// what the DoD specifies ("browser test drag-drops a PWAD (DataTransfer)").
console.log('[2] Import flow: synthetic PWAD via DataTransfer drop...');

const pwadBytes = Array.from(makeSyntheticPWAD());  // array of numbers for JSON serialization

// RED-PROOF check: on master window.__wd.handleWadImport is undefined (feature absent).
const hasImportFn = await tab.ev(`typeof window.__wd.handleWadImport === 'function'`);
if (!hasImportFn) fatal('window.__wd.handleWadImport not available (feature not implemented)');

// Synthesise a DataTransfer drop event on #landing.
// Chrome headless supports `new DataTransfer()` construction.
// We dispatch dragover first so lobby.js's preventDefault() / dropEffect
// wiring fires correctly, then dispatch drop with the same DataTransfer.
const importStatus = await tab.ev(`
    (async () => {
        const bytes = new Uint8Array(${JSON.stringify(pwadBytes)});
        const file  = new File([bytes], 'testmod.wad', { type: 'application/octet-stream' });
        const dt    = new DataTransfer();
        dt.items.add(file);
        const landing = document.getElementById('landing');
        // dragover — lobby.js calls e.preventDefault() + sets dropEffect
        landing.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer: dt,
        }));
        // drop — lobby.js reads e.dataTransfer.files[0] and calls handleWadImport
        landing.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt,
        }));
        // handleWadImport is async; poll for the status update (up to 4 s).
        for (let i = 0; i < 40; i++) {
            const s = document.getElementById('status')?.textContent ?? '';
            if (s.startsWith('Imported:') || s.startsWith('Rejected:') ||
                s.startsWith('Import error:') || s.startsWith('Already imported:') ||
                s.startsWith('WAD library full')) {
                return s;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        return document.getElementById('status')?.textContent ?? '(timeout)';
    })()
`);

if (!importStatus?.startsWith('Imported:')) fatal(`import did not succeed — status: "${importStatus}"`);
console.log(`  import succeeded: "${importStatus}"`);

// Navigate to SINGLE PLAYER → CHOOSE GAME and verify entry appears.
await sleep(300);
const entryVisible = await tab.ev(`
    (() => {
        // Click SINGLE PLAYER to push spGameScreen
        const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
        if (!sp) return 'no SINGLE PLAYER item';
        sp.click();
        // Look for testmod entry in the new screen
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const found = rows.some(r => r.dataset.label?.toLowerCase().includes('testmod'));
        return found ? 'found' : 'not found in: ' + rows.map(r => r.dataset.label).join(', ');
    })()
`);
check('testmod entry visible in CHOOSE GAME screen', entryVisible === 'found', entryVisible);

// ── [3] SP boot with imported PWAD ────────────────────────────────────────────
console.log('[3] SP boot with imported PWAD...');

// Click the testmod entry to start SP boot
const bootStarted = await tab.ev(`
    (() => {
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const testmodRow = rows.find(r => r.dataset.label?.toLowerCase().includes('testmod'));
        if (!testmodRow) return 'no testmod row';
        testmodRow.click();
        return 'clicked';
    })()
`);
if (bootStarted !== 'clicked') fatal(`could not click testmod entry: ${bootStarted}`);

// Wait for engine to boot (canvas visible, status empty) — up to 120s
// (doom.wad is ~12MB, needs to download then engine initialise).
const booted = await tab.waitFor(async () => {
    const s = await tab.ev(`document.getElementById('status')?.textContent`);
    if (s?.startsWith('engine error') || s?.startsWith('cannot')) fatal(`engine error during SP boot: "${s}"`);
    return tab.inGame();
}, { timeout: 120000, every: 500 });
if (!booted)
    fatal(`engine did not boot within 120s (status: "${await tab.ev(`document.getElementById('status')?.textContent`)}")`);
check('SP booted with testmod.wad as active PWAD', booted);

// Verify the local WAD was served from IDB, not the server (it's not on the server).
// We can infer this from the boot succeeding — fetchWad would have thrown
// "wad fetch failed: testmod.wad" if it tried the network.
check('testmod.wad served from local IDB (network fetch would have 404\'d)', booted);

// Check no new uncaught exceptions during boot.
const bootErrors = tab.errors.filter(e =>
    !e.includes('storage.persist') && !e.includes('IndexedDB'),
);
if (bootErrors.length > 0) fatal(`uncaught exceptions during SP boot: ${bootErrors.join('; ')}`);

// ── [4] Reload survival ────────────────────────────────────────────────────────
console.log('[4] Reload survival: page reload → local library persists...');

// Reload the tab (CDP Page.reload)
await tab.cdp('Page.reload');
await sleep(2000);
await menuOrFatal('reload-tab', 60);

// After reload, check if testmod.wad entry still appears in the game list.
const afterReload = await tab.ev(`
    (() => {
        const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
        if (!sp) return 'no SINGLE PLAYER';
        sp.click();
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const found = rows.some(r => r.dataset.label?.toLowerCase().includes('testmod'));
        return found ? 'found' : 'not found in: ' + rows.map(r => r.dataset.label).join(', ');
    })()
`);
check('testmod entry still present after page reload (IDB survived)', afterReload === 'found',
      `IDB did not persist: ${afterReload}`);

// ── [5] The library is not the engine's file registry ────────────────────────
// (a) A WAD named like one the server offers is refused, not shadowed.  Every
//     menu entry, stack, save namespace and demo link names a game by its file
//     name, so a second sigil.wad in the library is one nobody can choose.
// (b) A session registers its own stack and a few small files, never the
//     library, so the registry's 40 entries are no cap on how many WADs can be
//     imported -- the library had been capped at 40 entries, served ones
//     included.
console.log('[5] Library: a served name, and more WADs than the engine registry holds...');
const lib = await tab.ev(`(async () => {
    const pwad = lump => {
        const b = new Uint8Array(28), dv = new DataView(b.buffer);
        b.set([0x50, 0x57, 0x41, 0x44]);
        dv.setInt32(4, 1, true); dv.setInt32(8, 12, true);
        for (let i = 0; i < lump.length; i++) b[20 + i] = lump.charCodeAt(i);
        return b;
    };
    const status = () => document.getElementById('status')?.textContent ?? '';
    const imp = async (name, lump) => { await window.__wd.handleWadImport(new File([pwad(lump)], name)); return status(); };
    const libraryFiles = () => new Promise((res, rej) => {
        const r = indexedDB.open('webdoom-local-library', 1);
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
            const g = r.result.transaction('manifest').objectStore('manifest').getAll();
            g.onsuccess = () => { r.result.close(); res(g.result.map(e => e.file)); };
            g.onerror = () => rej(g.error);
        };
    });
    const served = (await (await fetch('/api/wads')).json()).wads;
    const victim = served.find(w => w.kind === 'PWAD' && !w.patch && !w.group);
    if (!victim) return { fatal: 'the server offers no PWAD to collide with' };
    const clash = await imp(victim.file, 'CLASH');
    const clashStored = (await libraryFiles()).filter(f => f === victim.file).length;

    const before = served.length + (await libraryFiles()).length;
    const want = Math.max(0, 41 - before) + 2;          // past the old cap of 40
    const results = [];
    for (let i = 0; i < want; i++) results.push(await imp('libfill' + i + '.wad', 'FILL' + i));
    return { victim: victim.file, clash, clashStored, before, want,
             imported: results.filter(r => r.startsWith('Imported:')).length,
             refused: results.filter(r => !r.startsWith('Imported:')).slice(0, 2),
             last: 'libfill' + (want - 1) };
})()`);
if (!lib || lib.fatal) fatal(lib?.fatal ?? 'library case returned nothing');
const aFails = [], bFails = [];
if (!(lib.clash.startsWith('Rejected:') && lib.clash.includes('already offers')))
    aFails.push(`importing a second ${lib.victim}: status "${lib.clash}", want a refusal naming the served WAD`);
if (lib.clashStored !== 0)
    aFails.push(`${lib.clashStored} library entr${lib.clashStored === 1 ? 'y' : 'ies'} named ${lib.victim} stored beside the served one`);
if (lib.imported !== lib.want)
    bFails.push(`${lib.imported} of ${lib.want} imports past ${lib.before} entries succeeded; refused: ${JSON.stringify(lib.refused)}`);
// and the merge at startup keeps them all
await tab.cdp('Page.reload');
await sleep(2000);
await menuOrFatal('reload-tab-2', 60);
const lastListed = await tab.ev(`
    (() => {
        document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')?.click();
        const rows = [...document.querySelectorAll('#dmenu .row')];
        return rows.some(r => r.dataset.label?.toLowerCase() === ${JSON.stringify(lib.last)});
    })()
`);
if (!lastListed) bFails.push(`after a reload, ${lib.last} is not in CHOOSE GAME`);
check(`(a) a second ${lib.victim} is refused: "${lib.clash}"`, aFails.length === 0, aFails.join('; '));
check(`(b) ${lib.want} imports past ${lib.before} entries (the old cap was 40), all listed after a reload`,
      bFails.length === 0, bFails.join('; '));

// Final uncaught-exception sweep
const finalErrors = tab.errors.filter(e =>
    !e.includes('storage.persist') && !e.includes('IndexedDB'),
);
if (finalErrors.length > 0) fatal(`uncaught JS exceptions: ${finalErrors.join('; ')}`);

tab.close();
summary('malformed corpus clean, import→entry→boot→reload all verified, a served name refused, the library past 40');
process.exit();
