#!/usr/bin/env node
// Browser test for MP gating — local WADs must not appear in MP picker.
//
// Tests covered:
//   (1) SP picker includes local WAD (local WADs are valid for SP play).
//   (2) MP CHOOSE GAME picker excludes local WAD (MP requires server library).
//   (3) Red-proof: with filter temporarily disabled, local WAD IS visible in MP
//       picker — verifying the filter is load-bearing, not accidental.
//
// Requires window.__wd.injectManifest (test hook exposed by lobby.js).
//
// RED-PROOF (documented):
//   Without the serverGames() filter (i.e. using sortedGames() in gamePick()),
//   the local WAD appears in the MP CHOOSE GAME picker.  Test (3) below confirms
//   this by removing the filter in-page and asserting the WAD IS present — then
//   restoring the filter and asserting it is absent.
//
// usage: node tools/browser-mp-gating-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { startServer } from './lib/server.mjs';
import { sleep } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const BASE_URL = process.argv[2] ?? (await startServer()).url;
// a fresh profile per run (launchChrome), so the SW cache is always cold on entry
const chrome = await launchChrome({ gpu: 'none' });

// MULTIPLAYER -> the lobby (its START GAME row) -> GAME: -> the CHOOSE GAME
// picker gamePick() builds.  `when` names the pass in a failure message.
async function openMpGamePick(when) {
    let inLobby = false;
    for (let attempt = 0; attempt < 3 && !inLobby; attempt++) {
        if (!await tab.click('MULTIPLAYER', 10)) fatal(`MULTIPLAYER row not found${when}`);
        inLobby = await tab.waitFor(() => tab.ev(`!!document.querySelector('#dmenu .row[data-label*="START GAME"]')`),
                                    { timeout: 6000, every: 300 });
        if (!inLobby) { await tab.esc(); await sleep(400); }
    }
    if (!inLobby) fatal(`MP lobby (START GAME row) did not appear${when}`);
    if (!await tab.click('GAME:', 10)) fatal(`GAME: row not found in lobby${when}`);
    await sleep(300);
}
const localWadInPicker = () => tab.ev(`[...document.querySelectorAll('#dmenu .row')]
    .some(r => r.dataset.label?.includes('LOCAL-MOD-TEST'))`);
// CHOOSE GAME -> lobby -> root
async function backToRoot() {
    await tab.esc();
    await sleep(200);
    await tab.esc();
    await sleep(400);
}

// ── Session ───────────────────────────────────────────────────────────────────
const tab = await chrome.tab(BASE_URL);
if (!await tab.waitForMenu(30).catch(e => fatal(`tab: ${e.message}`)))
    fatal(`tab: lobby menu did not appear within 30s (status: "${await tab.ev(`document.getElementById('status')?.textContent`)}")`);

// Verify that the test hook is available (lobby.js must expose it).
if (!await tab.ev(`typeof window.__wd.injectManifest === 'function'`))
    fatal('window.__wd.injectManifest not found — lobby.js test hook missing');

// ── Inject a fake local WAD entry into the in-memory manifest ─────────────────
// This simulates a user having imported a WAD in a previous session that was
// loaded from IDB on startup.  We inject directly rather than going through
// IDB/import to keep the test hermetic and fast.
const LOCAL_WAD = {
    file: 'localmod.wad',
    title: 'LOCAL-MOD-TEST',
    kind: 'PWAD',
    sha256: 'deadbeef'.repeat(8),
    size: 28,
    local: true,
    base: 'doom2.wad',
    maps: ['MAP01'],
};
await tab.ev(`window.__wd.injectManifest(${JSON.stringify(LOCAL_WAD)})`);
console.log('Injected local WAD: localmod.wad (local:true)');

// ── Test 1: SP picker includes local WAD ─────────────────────────────────────
console.log('\n[1] SP picker should include local WAD...');
const spResult = await tab.ev(`
    (() => {
        const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
        if (!sp) return 'no SP row';
        sp.click();
        // SP picks from sortedGames() which includes local:true
        const rows = [...document.querySelectorAll('#dmenu .row')];
        const found = rows.some(r => r.dataset.label?.includes('LOCAL-MOD-TEST'));
        return found ? 'found' : 'not found in: [' + rows.map(r => r.dataset.label).join(', ') + ']';
    })()
`);
check('local WAD present in SP CHOOSE GAME picker', spResult === 'found', spResult);

// Return to root
await tab.esc();
await sleep(300);

// ── Test 2: MP CHOOSE GAME picker excludes local WAD ─────────────────────────
console.log('\n[2] MP CHOOSE GAME picker should exclude local WAD...');
await openMpGamePick('');
const mpLabels = await tab.ev(`[...document.querySelectorAll('#dmenu .row')].map(r => r.dataset.label).join(', ')`);
check('local WAD absent from MP CHOOSE GAME picker', !await localWadInPicker(), `present rows: ${mpLabels}`);
console.log(`  MP game list: [${mpLabels}]`);
await backToRoot();

// ── Test 3: Red-proof — verify filter is load-bearing ────────────────────────
// Temporarily patch serverGames (via test hook) to bypass the local filter,
// then verify LOCAL-MOD-TEST DOES appear (RED state). Restore → absent (GREEN).
console.log('\n[3] Red-proof: disable filter → local WAD appears in MP picker...');
if (!await tab.ev(`typeof window.__wd.setServerGamesFilter === 'function'`))
    fatal('window.__wd.setServerGamesFilter not found — lobby.js filter hook missing');

await tab.ev(`window.__wd.setServerGamesFilter(false)`);
await openMpGamePick(' for red-proof');
check('RED: with filter disabled, local WAD IS present in MP picker (expected FAIL state)', await localWadInPicker(),
      'the WAD injection or the filter hook is not working');
await backToRoot();

await tab.ev(`window.__wd.setServerGamesFilter(true)`);
await openMpGamePick(' after restoring filter');
check('GREEN: with filter restored, local WAD absent from MP picker', !await localWadInPicker());

// ── Final uncaught-exception sweep ────────────────────────────────────────────
const finalErrors = tab.errors.filter(e =>
    !e.includes('storage.persist') && !e.includes('IndexedDB'),
);
if (finalErrors.length > 0) fatal(`uncaught JS exceptions: ${finalErrors.join('; ')}`);

tab.close();
summary('SP includes local WAD, MP excludes it; red-proof confirms filter is load-bearing');
process.exit();
