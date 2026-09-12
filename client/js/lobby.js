// DOOM-style drill-down front end. One short list per screen:
//   SINGLE PLAYER → game → boot (engine's own menu takes it from there)
//   MULTIPLAYER   → everyone lands in the lobby, START ready on the
//                   current defaults; GAME/MAP/MODE/SKILL are optional
//                   one-screen pickers. Doing nothing = you're
//                   Green/Indigo/… and ready to go.
import { bootDoom } from './main.js';
import { connectLobby, launchArgs, attachSpectate } from './net.js';
import { loadDoomFont } from './doomfont.js';
import { setStatus, loading } from './ui.js';
import { createMenu } from './menu.js';
import { createCountdown } from './countdown.js';
import { createFire } from './fire.js';
import { identifyWad, WadError } from './wad-import.js';
import { libraryAdd, libraryList } from './wad-library.js';
import { validateSf2, Sf2Error, sf2StoreCurrent } from './sf2-library.js';
import {
    parseDemoUrl, startReplay, ownsWad,
    stopAndShare,
    showSharePanel, showWadWarning, showReplayNotice,
} from './demo.js';
import {
    ACTIONS, loadSettings, saveSettings, defaultSettings, captureBind,
} from './input.js';
import { sf2GetCurrentMeta } from './sf2-library.js';

const $ = id => document.getElementById(id);
// setStatus looks the element up each time and tolerates its absence; the six
// hand-written copies of this line did not all do either.  Imported under the
// local name so the twenty call sites below read unchanged.
const status = setStatus;

const SKILLS = ["I'M TOO YOUNG TO DIE", 'HEY, NOT TOO ROUGH', 'HURT ME PLENTY',
    'ULTRA-VIOLENCE', 'NIGHTMARE!'];
const MODES = [['coop', 'COOPERATIVE'], ['deathmatch', 'DEATHMATCH'], ['altdeath', 'DEATHMATCH 2.0']];
const COLORS = ['Green', 'Indigo', 'Brown', 'Red'];

let manifest = [];
let font = null;
let menu = null;
let fire = null;   // PSX DOOM fire background instance
let lobby = null;
let roster = null;              // latest roster message (pre-game lobby)
let ipSummary = null;          // latest 'inprogress' summary (game already live)
let ipSlot = -1;               // chosen drop-in color/slot
let ipName = '';               // chosen drop-in name (optional)
let booted = false;

const entry = file => manifest.find(w => w.file === file);
const isCommercial = e => e?.maps?.[0]?.startsWith('MAP');

function stackFor(file) {
    const e = entry(file);
    if (!e) return [];
    const stack = e.kind === 'IWAD' ? [e] : [entry(e.base), e].filter(Boolean);
    for (const p of manifest)
        if (p.patch && stack.some(s => s.file === p.base) && !stack.includes(p))
            stack.push(p);
    return stack.map(w => ({ file: w.file, sha: w.sha256 }));
}

// Curated order; grouped entries (Master Levels) fold into a submenu so
// each screen stays short.
// hacx.wad was here and could never load: absent from the server manifest (the
// only one of the eight that was) and explicitly refused by wad-import.js as
// "HACX v2 is not vanilla-engine compatible".  So it could not be served and it
// could not be imported -- a menu row with no reachable destination, which
// README then advertised as part of the shipped library.
// tools/check-menu-reachable.mjs gates the class.
const GAME_ORDER = ['doom.wad', 'doom2.wad', 'sigil.wad', 'nerve.wad',
    'tnt.wad', 'plutonia.wad', 'chex.wad'];

const sortedGames = () => manifest.filter(w => !w.patch && !w.group)
    .sort((a, b) => {
        const ia = GAME_ORDER.indexOf(a.file), ib = GAME_ORDER.indexOf(b.file);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
const groups = () => [...new Set(manifest.filter(w => w.group).map(w => w.group))];

// MP gating: local WADs (imported by the user, local:true) are SP-only.
// The server never knows about local shas, so they must not appear in the
// MP game picker — a client that selects one would send a sha the other
// players cannot fetch.  serverGames() is the canonical list for all MP paths.
// _serverGamesFilter is togglable via window.__testSetServerGamesFilter for
// browser tests that need to red-prove the filter is load-bearing.
let _serverGamesFilter = true;
const serverGames = () => _serverGamesFilter
    ? sortedGames().filter(w => !w.local)
    : sortedGames();

// --- screens -----------------------------------------------------------------

function rootScreen() {
    return {
        items: [
            { label: 'SINGLE PLAYER', action: () => menu.push(spGameScreen()) },
            { label: 'MULTIPLAYER', action: enterMultiplayer },
            { label: 'OPTIONS', action: () => menu.push(optionsScreen()) },
            { label: 'IMPORT WAD', action: () => document.getElementById('wad-file-input')?.click() },
        ],
    };
}

// --- OPTIONS -------------------------------------------------------------------
//
// The web-side settings used to live in an F8 HTML overlay (client/js/settings.js)
// that belonged to neither this menu nor the engine's, and was the only way to
// reach any of them.  They are menu screens now, in the same shape as
// optionsPick() below: a value rendered as text, left/right or Enter to change
// it, and nothing else on screen.
//
// There is no `doom` here -- the launcher runs before any engine exists -- so
// nothing is applied live.  Everything is persisted through saveSettings() and
// main.js applies the whole set at boot, which it already did for every one of
// these.  The cost is that a setting cannot be changed mid-game; DOOM's own
// menu (Escape) still owns volume, detail and screen size in game.
let settings = null;
const S = () => (settings ??= loadSettings());

// GM status is two async lookups (the stored .sf2 and the operator's synth
// URL).  Fetch once on entry, cache, and refresh the screen when they land, so
// the MUSIC row can say GM - NO SF2 instead of the game shouting it over the
// player later.  gmState stays null until both have answered.
let gmState = null;
async function loadGmState() {
    if (gmState) return;
    const [meta, cfg] = await Promise.all([
        sf2GetCurrentMeta().catch(() => null),
        fetch('/api/config').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    gmState = { sf2: !!meta, url: !!cfg?.spessaSynthUrl };
    if (menu.current()?.title === 'OPTIONS') menu.refresh(optionsScreen());
}

// What the MUSIC row reads.  For GM it names the reason it cannot work, at the
// place the choice is made -- audio.js used to setStatus() that reason over the
// running game, where #status has no timeout and it stayed for the session.
function musicValue() {
    const b = S().musicBackend ?? (S().opl3 ? 'opl3' : 'opl2');
    if (b !== 'gm') return b.toUpperCase();
    if (!gmState) return 'GM';
    if (!gmState.url) return 'GM - NO SYNTH URL';
    if (!gmState.sf2) return 'GM - NO SF2';
    return 'GM';
}

const keyName = code => String(code)
    .replace(/[^a-zA-Z0-9]/g, '')      // codes are alphanumeric; localStorage is not trusted
    .replace(/^Key|^Digit/, '')
    .replace(/^Arrow/, '')
    .replace(/(?!^)(Left|Right)$/, ' $1')
    .trim()                            // 'ArrowLeft' -> 'Left' -> ' Left' without this
    .toUpperCase();

// Step a setting through a fixed ladder, wrapping.  `steps` is the ladder, so
// a value that is in range but not ON the ladder (hand-edited localStorage,
// which sanitizeSettings clamps but does not round) lands on the next rung up
// rather than jumping to the start.
const stepper = (key, steps) => dir => {
    const cur = S()[key];
    let i = steps.indexOf(cur);
    if (i < 0) i = steps.findIndex(v => v >= cur);
    if (i < 0) i = 0;
    S()[key] = steps[(i + dir + steps.length) % steps.length];
    saveSettings(S());
    menu.refresh(optionsScreen());
};

const SENS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const PADTURN = [0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
const DEADZONE = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.9];
const MOUSEY = ['off', 'look', 'move'];
const BACKENDS = ['opl2', 'opl3', 'gm'];

function optionsScreen() {
    loadGmState();
    const onoff = v => (v ? 'ON' : 'OFF');
    const flip = key => () => {
        S()[key] = !S()[key];
        saveSettings(S());
        menu.refresh(optionsScreen());
    };
    const cycleIn = (key, list, after) => dir => {
        const i = list.indexOf(S()[key]);
        S()[key] = list[((i < 0 ? 0 : i) + dir + list.length) % list.length];
        after?.();
        saveSettings(S());
        menu.refresh(optionsScreen());
    };
    // Left/right cycles and Enter advances by one -- the same function, so the
    // two cannot drift apart.
    const both = fn => ({ cycle: fn, action: () => fn(1) });
    const opl3sync = () => { S().opl3 = S().musicBackend === 'opl3'; };
    return {
        title: 'OPTIONS',
        nowrap: true,
        // DOOM's own menu is still there and still owns four settings, one of
        // which (mouse sensitivity) multiplies the same mouse deltas this
        // screen scales.  Saying so is cheaper than a player finding out.
        header: [{ text: 'IN GAME, ESC OPENS DOOM\'S OWN MENU' }],
        items: [
            { label: 'CONTROLS', action: () => menu.push(controlsScreen()) },
            { label: 'MOUSE SENSITIVITY: ', value: String(S().mouseSens), maxValue: '12',
              ...both(stepper('mouseSens', SENS)) },
            { label: 'MOUSE Y: ', value: S().mouseY.toUpperCase(), maxValue: 'LOOK',
              ...both(cycleIn('mouseY', MOUSEY)) },
            { label: 'ALWAYS RUN: ', value: onoff(S().alwaysRun), maxValue: 'OFF',
              ...both(flip('alwaysRun')) },
            { label: 'SMOOTH RENDERING: ', value: onoff(S().smooth), maxValue: 'OFF',
              ...both(flip('smooth')) },
            // opl3 is a legacy bool kept in sync for back-compat (task 17.2b).
            { label: 'MUSIC: ', value: musicValue(), maxValue: 'GM - NO SYNTH URL',
              ...both(cycleIn('musicBackend', BACKENDS, opl3sync)) },
            { label: 'GAMEPAD TURN: ', value: S().padTurnSpeed.toFixed(1), maxValue: '2.0',
              ...both(stepper('padTurnSpeed', PADTURN)) },
            // padDeadzone was in the schema with no control at all: reachable
            // only by hand-editing localStorage, while the comment above SCHEMA
            // said the bounds "match the panel's own controls".
            { label: 'GAMEPAD DEADZONE: ', value: S().padDeadzone.toFixed(2), maxValue: '0.90',
              ...both(stepper('padDeadzone', DEADZONE)) },
            { label: 'RESET DEFAULTS', action: () => {
                Object.assign(S(), defaultSettings());
                saveSettings(S());
                menu.refresh(optionsScreen());
            } },
        ],
    };
}

function controlsScreen() {
    return {
        title: 'CONTROLS',
        nowrap: true,
        header: [{ text: 'ENTER REBINDS  -  ESC CANCELS' }],
        items: [
            ...ACTIONS.map(a => ({
                label: a.label.toUpperCase() + ': ',
                value: keyName(S().binds[a.id]),
                maxValue: 'PRESS A KEY',
                capture: done => captureBind(S(), a.id, () => {
                    done();
                    menu.refresh(controlsScreen());
                }),
            })),
            { label: 'RESET DEFAULTS', action: () => {
                S().binds = defaultSettings().binds;
                saveSettings(S());
                menu.refresh(controlsScreen());
            } },
        ],
    };
}

// Handle a WAD file import from either drag-drop or file picker.
// Reads file.arrayBuffer(), identifies the WAD, stores in local library,
// and adds the entry to the in-memory manifest.
async function handleWadImport(file) {
    // MAXWEBFILES=40: engine only accepts 40 files per boot;
    // cap the local library to prevent pathological stacks.
    if (manifest.length >= 40) {
        status('WAD library full (max 40 files)');
        return;
    }
    try {
        status('Reading WAD…');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const entry = await identifyWad(bytes, file.name);

        // Deduplicate by sha256 (same file imported twice → skip)
        if (manifest.find(m => m.sha256 === entry.sha256)) {
            status(`Already imported: ${entry.title}`);
            return;
        }

        await libraryAdd(entry, bytes);
        manifest.push(entry);
        status(`Imported: ${entry.title}`);

        // Refresh the menu so the new entry appears immediately.
        if (menu.depth() <= 1) menu.reset(rootScreen());
        else menu.refresh(spGameScreen());
    } catch (err) {
        const msg = err instanceof WadError
            ? `Rejected: ${err.message}`
            : `Import error: ${err.message ?? String(err)}`;
        status(msg);
    }
}

// Handle a .sf2 SoundFont file import from either drag-drop or file picker.
// Validates the RIFF/sfbk magic, stores bytes in IDB via sf2-library.js, and
// passes bytes to the active GM audio sink (if GM mode is already armed).
async function handleSf2Import(file) {
    try {
        status('Reading SoundFont…');
        const bytes = new Uint8Array(await file.arrayBuffer());
        validateSf2(bytes);   // throws Sf2Error on bad RIFF/sfbk magic or bounds

        const name = file.name.replace(/^.*[/\\]/, '');  // basename only
        await sf2StoreCurrent(name, bytes);

        // If GM mode is already active (game running), pass bytes to the audio sink.
        // setGmMode accepts the new bytes live; takes effect on next arm() or reload.
        window.doomAudio?.setGmMode?.(true, bytes);

        status(`SoundFont loaded: ${name}`);
    } catch (err) {
        const msg = err instanceof Sf2Error
            ? `SF2 rejected: ${err.message}`
            : `SF2 error: ${err.message ?? String(err)}`;
        status(msg);
    }
}

// ── one way back to the launcher ─────────────────────────────────────────────
//
// This used to be seven partly-overlapping combinations of the same nine
// statements -- booted, fire.resume, menu.show, menu.reset, lobby.close,
// lobby=null, roster=null, ipSummary/ipSlot, countdown.reset -- one per exit
// path, each with its own subset.  Round 5's A2 gave the ENGINE side one owner
// (main.js endSession); this is the launcher side.
//
// Every step is idempotent, so one function can serve a path that never had a
// lobby (single player) and one that is leaving a live one:
//   fire.resume()      returns immediately unless paused
//   menu.show()        a no-op when the menu is already visible
//   countdown.reset()  cancels a rAF and a timeout that may not exist
//   lobby              guarded, and NULLED BEFORE close() -- the 'closed'
//                      handler reads `!lobby` to tell a deliberate leave from
//                      a dropped connection, and that ordering is load-bearing
//
// reason: shown in #status.  Omit it for a clean return (Quit Game, leaving a
// lobby) -- passing '' would blank a message another path just set.
function resetToLauncher(reason) {
    booted = false;
    const l = lobby;
    lobby = null;
    try { l?.close(); } catch { /* already gone */ }
    roster = null;
    ipSummary = null;
    ipSlot = -1;
    countdown?.reset();
    fire?.resume();
    menu.show();
    // flare is triggered by menu.reset() -> onTransition('reset')
    menu.reset(rootScreen());
    if (reason) status(String(reason));
}


// Quit Game (→ Y) inside the engine returns here.
function returnToMenu() { resetToLauncher(); }

// a single-map PWAD (a Master Level, at its own slot like MAP25) is
// launched straight into that map — the engine's New Game would start at
// MAP01, i.e. the base IWAD's map, not the one you picked.
const singleMap = w => (w.maps?.length === 1 && !w.maps[0].startsWith('E')) ? +w.maps[0].slice(3) : null;

function spGameScreen() {
    // Boot helper. record=true arms the demo bridge before callMain so that
    // G_RecordDemo is called before D_DoomLoop runs G_BeginRecording.
    const boot = (w, record = false) => {
        if (booted) return;
        booted = true;
        fire?.pause();    // stop fire while the game is running
        menu.hide();
        const m = singleMap(w);
        const args = m ? ['-warp', String(m), '-skill', '3'] : [];

        // REC indicator overlay: shown while recording, pointer-events:none so it
        // never intercepts game input.  Removed when STOP & SHARE is clicked.
        let recIndicator = null;
        if (record) {
            recIndicator = document.createElement('div');
            recIndicator.id = 'rec-indicator';
            recIndicator.textContent = '● REC';
            recIndicator.style.cssText =
                'position:fixed;top:8px;left:8px;z-index:100;' +
                'color:#f33;font-family:monospace;font-size:14px;font-weight:bold;' +
                'pointer-events:none;text-shadow:0 0 4px #000;';
            document.body.appendChild(recIndicator);
        }

        // Pass record flag so main.js can arm the bridge before callMain.
        bootDoom({ wads: stackFor(w.file), args, onQuit: returnToMenu, record })
            .then(doom => {
                if (record && doom) {
                    // Inject a stop-and-share button into the overlay during gameplay.
                    const btn = document.createElement('button');
                    btn.id = 'demo-stop-btn';
                    btn.textContent = '⏹ STOP & SHARE';
                    btn.title = 'Stop recording and generate a share link';
                    btn.style.cssText =
                        'position:fixed;top:8px;right:8px;z-index:100;' +
                        'background:#222;color:#eee;border:1px solid #666;' +
                        'font-family:monospace;font-size:11px;padding:4px 10px;cursor:pointer;';
                    document.body.appendChild(btn);
                    btn.addEventListener('click', async () => {
                        btn.remove();
                        recIndicator?.remove();
                        recIndicator = null;
                        try {
                            const shareUrl = await stopAndShare(doom, w.file);
                            showSharePanel(shareUrl);
                        } catch (e) {
                            status('demo share error: ' + e.message);
                        }
                    });
                }
            })
            .catch(err => {
                // WAD fetch / engine boot failed: reset so the user can retry
                // without reloading the page.  main.js has already restored
                // #landing visibility via restoreOnFailure().  recIndicator is
                // local to this boot helper, so it is cleaned up here rather
                // than inside the shared reset.
                recIndicator?.remove();
                recIndicator = null;
                resetToLauncher(err);
            });
    };

    // Game list for recording: same entries as the main SP list but each boots
    // with record=true.  Used by the RECORD & SHARE top-level item.
    const recordPickerScreen = () => ({
        title: 'RECORD & SHARE',
        items: sortedGames().map(w => ({
            label: w.title,
            thumb: font.titleThumb(w.file, 52),
            action: () => boot(w, true),
        })).concat(groups().map(g => ({
            label: g,
            action: () => menu.push({
                title: g,
                items: manifest.filter(w => w.group === g)
                    .map(w => ({ label: w.title, action: () => boot(w, true) })),
            }),
        }))),
    });

    return {
        title: 'CHOOSE GAME',
        // Game row click = immediate PLAY (vanilla-first: 1 click to launch).
        // RECORD & SHARE is a separate top-level item at the end of the list.
        items: sortedGames().map(w => ({
            label: w.title,
            thumb: font.titleThumb(w.file, 52),
            action: () => boot(w),
        })).concat(groups().map(g => ({
            label: g,
            action: () => menu.push({
                title: g,
                items: manifest.filter(w => w.group === g)
                    .map(w => ({ label: w.title, action: () => boot(w) })),
            }),
        }))).concat([{
            label: 'RECORD & SHARE…',
            action: () => menu.push(recordPickerScreen()),
        }]),
    };
}

// --- multiplayer -----------------------------------------------------------------
// Lobby-first: MULTIPLAYER drops everyone straight into the lobby with
// START ready on the current params; GAME/MAP/MODE/SKILL are optional
// one-screen pickers that pop back. Host start = two clicks.

let countdown = null;

function enterMultiplayer() {
    if (lobby) { menu.push(ipSummary ? inProgressScreen() : lobbyScreen()); return; }
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    lobby = connectLobby(base);
    lobby
        // a game is already live: offer to drop in rather than form a lobby
        .on('inprogress', m => {
            ipSummary = m;
            if (menu.current()?.id === 'inprogress') menu.refresh(inProgressScreen());
            else if (menu.depth() === 1) menu.push(inProgressScreen());
        })
        .on('roster', m => {
            roster = m;
            if (menu.current()?.id === 'lobby') menu.refresh(lobbyScreen());
            else if (menu.depth() === 1) menu.push(lobbyScreen());
        })
        .on('full', m => { status(m.reason); lobby = null; })
        .on('countdown', m => { if (!booted) countdown.show(m.n); })
        .on('launch', async m => {
            if (booted) return;
            booted = true;
            fire?.pause();    // stop fire for the duration of the game
            if (!m.join) countdown.show('GO');    // drop-ins get the catch-up bar, not a countdown
            // Sample RTT and size the buffer to a ROBUST jitter estimate:
            // the 75th-percentile spread above the fastest ping, not the mean
            // (already in lockstep's inherent lag) nor the worst spike. On a
            // high-jitter relay link the max would balloon the buffer into
            // pure lag; the sim's safety drain absorbs the rare straggler a
            // tighter buffer lets through.
            //
            // `.catch(() => 50)` used to be the whole story here, and it could
            // never fire: ping() returned a promise with no timeout and no
            // reject path, so if the server stopped answering 'pong' -- or the
            // socket closed, which does nothing to a pending ping -- this loop
            // hung FOREVER. bootDoom was never reached and the player sat under
            // a "GO" countdown that never resolved, with no user-visible
            // timeout anywhere on the path. ping() resolves null on timeout now
            // (net.js PING_TIMEOUT_MS); an unanswered ping is not a
            // zero-latency ping, so it takes the same 50 ms fallback the dead
            // catch was written to supply.
            const rtts = [];
            let unanswered = 0;
            for (let i = 0; i < 12; i++) {
                const rtt = await lobby.ping();
                if (rtt === null) unanswered++;
                rtts.push(rtt ?? 50);
            }
            if (unanswered) console.warn(`webdoom: ${unanswered}/12 pings unanswered — jitter estimate is a guess`);
            rtts.sort((a, b) => a - b);
            const jitterMs = rtts[Math.floor(rtts.length * 0.75)] - rtts[0];
            const e = entry(m.params.wad);
            menu.hide();
            bootDoom({
                wads: stackFor(m.params.wad),
                args: launchArgs(m.params, isCommercial(e)),
                net: { slot: lobby.slot, numplayers: m.numplayers, jitterMs, names: m.names, slots: m.slots,
                       join: !!m.join, frontier: m.frontier },
                onQuit: returnToMenu,
            }).then(() => {
                countdown.dismiss();
                lobby.close();
            }).catch(err => {
                // Guard T16/T20: WAD fetch or engine boot failed in MP / drop-in path.
                resetToLauncher(err);
            });
        })
        .on('closed', () => {
            if (booted || !lobby) return;   // deliberate leave already reset
            lobby = null; roster = null;
            ipSummary = null; ipSlot = -1;
            countdown.reset();              // guard T23: dismiss countdown if ws lost mid-countdown
            status('lobby connection lost');
            menu.reset(rootScreen());
        });
}

// generic one-screen picker: choose → apply → back to the lobby
function picker(title, items, unwindBy = 1) {
    return {
        title,
        items: items.map(it => !it.apply ? it : ({
            ...it,
            action: () => {
                it.apply();
                menu.unwind(unwindBy);
                menu.refresh(lobbyScreen());
            },
        })),
    };
}

const setParams = p => {
    if (roster) roster.params = { ...roster.params, ...p };   // optimistic
    lobby.setParams(p);
};

// choosing a game sets wad + its starting map (a Master Level jumps to
// its own slot, e.g. MAP25, not MAP01)
const pickWad = w => setParams({ wad: w.file, episode: 1, map: singleMap(w) ?? 1 });

function gamePick() {
    // serverGames() excludes local:true WADs — MP requires the server library
    // because the server coordinates WAD distribution; local shas are unknown
    // to other players.
    return picker('CHOOSE GAME', serverGames().map(w => ({
        label: w.title,
        thumb: font.titleThumb(w.file, 52),
        apply: () => pickWad(w),
    })).concat(groups().map(g => ({
        label: g,
        action: () => menu.push(picker(g,
            manifest.filter(w => w.group === g && !w.local).map(w => ({
                label: w.title,
                apply: () => pickWad(w),
            })), 2)),
    }))));
}

function mapPick() {
    const w = entry(roster?.params.wad);
    const maps = w?.maps ?? [];
    if (isCommercial(w))
        return picker('WHICH MAP?', maps.map(m => ({
            label: m, apply: () => setParams({ map: +m.slice(3) }),
        })));
    const eps = [...new Set(maps.map(m => +m[1]))].sort();
    return {
        title: 'WHICH EPISODE?',
        items: eps.map(n => ({
            label: `EPISODE ${n}`,
            action: () => menu.push(picker('WHICH MAP?',
                maps.filter(m => +m[1] === n).map(m => ({
                    label: m, apply: () => setParams({ episode: n, map: +m[3] }),
                })), 2)),
        })),
    };
}

const modePick = () => picker('WHICH MODE?', MODES.map(([value, label]) =>
    ({ label, apply: () => setParams({ mode: value }) })));

const skillPick = () => picker('HOW TOUGH ARE YOU?', SKILLS.map((label, i) =>
    ({ label, apply: () => setParams({ skill: i + 1 }) })));

// gameplay flags: toggles stay on this screen; Esc returns to the lobby
function optionsPick() {
    const p = roster?.params ?? {};
    const onoff = v => v ? 'ON' : 'OFF';
    const set = patch => { setParams(patch); menu.refresh(optionsPick()); };
    const timers = [0, 5, 10, 15, 20, 30];
    const bump = dir => set({ timer: timers[(timers.indexOf(p.timer ?? 0) + dir + timers.length) % timers.length] });
    const flip = key => () => set({ [key]: !p[key] });
    return {
        title: 'OPTIONS',
        items: [
            { label: 'NO MONSTERS: ', value: onoff(p.nomonsters),
              action: flip('nomonsters'), cycle: flip('nomonsters') },
            { label: 'FAST MONSTERS: ', value: onoff(p.fast),
              action: flip('fast'), cycle: flip('fast') },
            { label: 'RESPAWN MONSTERS: ', value: onoff(p.respawn),
              action: flip('respawn'), cycle: flip('respawn') },
            { label: 'TIME LIMIT: ', value: p.timer ? `${p.timer} MIN` : 'OFF',
              action: () => bump(1), cycle: bump },
        ],
    };
}

function mapName(p) {
    const e = entry(p.wad);
    return isCommercial(e) ? `MAP${String(p.map).padStart(2, '0')}` : `E${p.episode}M${p.map}`;
}

// wrap-around cycle helper
const cyc = (arr, cur, dir) => arr[(arr.indexOf(cur) + dir + arr.length) % arr.length];

// Shown when you open MULTIPLAYER and a game is already live: a summary
// (wad art, map, mode, who's in) plus optional color/name and a DROP IN that
// catches you up into the running game.
async function spectateGame() {
    if (booted) return;
    const s = ipSummary; if (!s) return;
    booted = true; fire?.pause();
    const e = entry(s.params.wad);
    menu.hide();
    const names = (() => {
        const n = [null, null, null, null];
        (s.players ?? []).forEach(pl => { n[pl.slot] = pl.name ?? pl.color; });
        return n;
    })();
    bootDoom({
        wads: stackFor(s.params.wad),
        args: launchArgs(s.params, isCommercial(e)),
        net: {
            numplayers: 4,
            slots: (s.players ?? []).map(pl => pl.slot),
            names,
            spectate: true,
            frontier: s.frontier ?? 0,
        },
        onQuit: returnToMenu,
    }).then(() => { lobby.close(); }).catch(err => {
        resetToLauncher(err);
    });
}

function inProgressScreen() {
    const s = ipSummary;
    const p = s.params;
    const free = s.freeSlots ?? [];
    if (!free.includes(ipSlot)) ipSlot = free[0] ?? -1;
    const mode = MODES.find(m => m[0] === p.mode)?.[1] ?? p.mode;
    const refresh = () => menu.refresh(inProgressScreen());
    const cycleColor = dir => {
        if (free.length < 2) return;
        ipSlot = free[(free.indexOf(ipSlot) + dir + free.length) % free.length];
        refresh();
    };
    const dropIn = () => {
        if (booted || ipSlot < 0) return;
        lobby.send({ t: 'join', slot: ipSlot, name: ipName || undefined });
        // server replies welcome + launch(join); the launch handler boots
        // straight into catch-up
    };
    return {
        id: 'inprogress',
        title: 'GAME IN PROGRESS',
        header: (s.players ?? []).map(pl =>
            ({ text: (pl.name ?? pl.color) + (pl.live ? '  ' : '… '), color: pl.color })),
        onBack: leaveLobby,
        items: [
            free.length
                ? { label: 'DROP IN', action: dropIn }
                : { label: 'GAME FULL', color: 'Red' },
            { label: 'SPECTATE', action: () => spectateGame() },
            { label: 'GAME: ', value: entry(p.wad)?.title ?? p.wad, thumb: font.titleThumb(p.wad, 52) },
            { label: 'MAP: ', value: mapName(p) },
            { label: 'MODE: ', value: mode },
            { label: 'NAME: ', value: ipName,
              color: free.length ? COLORS[ipSlot] : null,
              entry: { initial: ipName, commit: v => { ipName = v; refresh(); } } },
            ...(free.length > 1 ? [{
                label: 'COLOR: ', value: (COLORS[ipSlot] ?? '').toUpperCase(), color: COLORS[ipSlot],
                action: () => cycleColor(1), cycle: cycleColor,
            }] : []),
        ],
    };
}

function lobbyScreen() {
    const me = roster?.players.find(pl => pl.slot === lobby.slot);
    const p = roster?.params ?? {};
    const free = roster?.freeSlots ?? [];
    const mode = MODES.find(m => m[0] === p.mode)?.[1] ?? p.mode;
    const refresh = () => menu.refresh(lobbyScreen());

    const cycleGame = dir => {
        const files = serverGames().map(w => w.file);
        setParams({ wad: cyc(files, p.wad, dir), episode: 1, map: 1 });
        refresh();
    };
    const cycleMap = dir => {
        const w = entry(p.wad), maps = w?.maps ?? [];
        const cur = mapName(p);
        const next = maps[(maps.indexOf(cur) + dir + maps.length) % maps.length];
        if (!next) return;
        if (isCommercial(w)) setParams({ map: +next.slice(3) });
        else setParams({ episode: +next[1], map: +next[3] });
        refresh();
    };
    const cycleMode = dir => { setParams({ mode: cyc(MODES.map(m => m[0]), p.mode, dir) }); refresh(); };
    const cycleSkill = dir => { setParams({ skill: ((p.skill - 1 + dir + 5) % 5) + 1 }); refresh(); };
    const cycleColor = dir => {
        const order = [lobby.slot, ...free].sort((a, b) => a - b);
        const next = order[(order.indexOf(lobby.slot) + dir + order.length) % order.length];
        if (next !== lobby.slot) lobby.send({ t: 'slot', slot: next });
    };

    return {
        id: 'lobby',
        title: 'FIGHT TOGETHER',
        header: (roster?.players ?? []).map(pl =>
            ({ text: pl.name + '  ', color: pl.color })),
        onBack: leaveLobby,
        // GAME/MAP/MODE/SKILL/COLOR: Enter opens the full picker, ←/→
        // cycles the value in place (both land on the same result)
        // maxValue = the longest value each cycler can show, so the menu
        // scale/width never changes as you cycle through them
        items: [
            { label: 'START GAME', action: () => lobby.start() },
            { label: 'GAME: ', value: entry(p.wad)?.title ?? p.wad,
              maxValue: serverGames().reduce((a, b) => b.title.length > a.length ? b.title : a, ''),
              action: () => menu.push(gamePick()), cycle: cycleGame },
            { label: 'MAP: ', value: mapName(p), maxValue: 'MAP00',
              action: () => menu.push(mapPick()), cycle: cycleMap },
            { label: 'MODE: ', value: mode, maxValue: 'DEATHMATCH 2.0',
              action: () => menu.push(modePick()), cycle: cycleMode },
            { label: 'SKILL: ', value: SKILLS[p.skill - 1] ?? '', maxValue: "I'M TOO YOUNG TO DIE",
              action: () => menu.push(skillPick()), cycle: cycleSkill },
            { label: 'OPTIONS', action: () => menu.push(optionsPick()) },
            {
                label: 'NAME: ', value: me?.name ?? '',
                color: me?.color ?? null,
                entry: {
                    initial: me?.name === me?.color ? '' : (me?.name ?? ''),
                    commit: v => lobby.send({ t: 'name', name: v }),
                },
            },
            ...(free.length ? [{
                label: 'COLOR: ', value: (me?.color ?? '').toUpperCase(),
                color: me?.color ?? null,
                action: () => cycleColor(1), cycle: cycleColor,
            }] : []),
        ],
    };
}

// guard T25: resetToLauncher dismisses a countdown the user ESC'd out of, and
// nulls `lobby` before close() so the 'closed' handler reads this as deliberate.
function leaveLobby() { resetToLauncher(); }

// --- boot ------------------------------------------------------------------------
(async () => {
    if ('serviceWorker' in navigator) {
        // The reload button used to be `<button onclick="location.reload()">` in
    // index.html -- the only inline event handler in the codebase, and the one
    // thing a script-src CSP would silently break. Wired here instead.
    document.getElementById('sw-reload')?.addEventListener('click', () => location.reload());
    // Was this page already controlled when we registered?  sw.js calls
    // skipWaiting() + clients.claim(), so on a FIRST visit the brand-new worker
    // claims this already-loaded page and fires controllerchange -- and the
    // banner below used to read that as "a new version replaced the old one".
    // It has no old one.  Every first-time visitor was told to reload, on a
    // page that had just finished loading.  controllerchange cannot tell the
    // two apart; the controller's existence BEFORE registration can.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
        // When a new service worker takes control mid-session, surface a
        // non-intrusive reload prompt rather than silently serving a mixed
        // old/new asset state. The prompt never interrupts an active match.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) return;   // first claim, not an update
            const el = document.getElementById('sw-update');
            if (el) el.hidden = false;
        });
    }
    try {
        // The launcher's OWN startup had no indicator: a /api/wads fetch, an
        // IndexedDB read and a base64 decode of ~63 font patches happen before
        // the first menu row exists, and #loading was owned entirely by
        // main.js and never shown until a game was already booting.  On a slow
        // host that is a black page for seconds with nothing to read.
        loading.show('READING THE WAD LIBRARY…');
        manifest = (await (await fetch('/api/wads')).json()).wads;

        // Merge local-library entries into the manifest.
        // Entries already on the server (same sha256) are skipped.
        // Capped at MAXWEBFILES=40 total (16.6b review: import-time enforcement
        // alone let server-manifest + local entries exceed the engine limit at
        // boot). Overflow entries are skipped loudly, never silently dropped.
        const MAXWEBFILES = 40;
        const serverShas = new Set(manifest.map(e => e.sha256));
        const localEntries = await libraryList().catch(() => []);
        for (const e of localEntries) {
            if (serverShas.has(e.sha256)) continue;
            if (manifest.length >= MAXWEBFILES) {
                console.warn(`WAD library: skipping "${e.name}" — manifest at engine limit (${MAXWEBFILES})`);
                continue;
            }
            manifest.push(e);
        }

        loading.set('DECODING THE MENU FONT…', 0.66);
        font = await loadDoomFont();
        // onTransition: single hook for every real screen change in the launcher
        // menu. Full-flare (peak 36) on return-to-root; subtle nav flare (peak 28)
        // for push/back between sub-screens. fire is initialized below; the closure
        // captures the module-scope variable by reference so it will be set by the
        // time any transition fires. fire?.flare() is a no-op while paused (in-game).
        menu = createMenu(font, $('landing'), {
            onTransition(type) {
                if (type === 'reset') fire?.flare();    // full arrival flare at root
                else                  fire?.flare(28);  // subtle between-screen flare
            },
        });
        countdown = createCountdown(font, $('countdown'));
        loading.hide();
    } catch (err) {
        loading.hide();
        console.error(err);
        // "cannot reach server" was printed for EVERY failure in this block,
        // including the server answering perfectly with no IWAD to offer.  A
        // genuinely unreachable server keeps that wording (it is true, and
        // tools/browser-resilience-test.mjs keys its early exit on it); an
        // answered request that we could not use now says what it was.
        const msg = String(err?.message ?? err);
        status(/fetch|network|load failed/i.test(msg) ? `cannot reach server — ${msg}` : msg);
        return;
    }

    // --- WAD / SF2 import: file picker (for keyboard/test access) + drag-drop --
    // Hidden file input — triggered by "IMPORT WAD / SF2" menu item or programmatically.
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.wad,.sf2';
    fileInput.id = 'wad-file-input';
    fileInput.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', e => {
        const f = e.target.files[0];
        if (!f) return;
        fileInput.value = '';
        if (f.name.toLowerCase().endsWith('.sf2')) handleSf2Import(f);
        else handleWadImport(f);
    });

    // Drag-and-drop on #landing (the full landing menu area).
    // Routes .sf2 files to handleSf2Import; everything else to handleWadImport.
    const landing = $('landing');
    landing.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        landing.classList.add('drop-hover');
    });
    landing.addEventListener('dragleave', e => {
        if (!landing.contains(e.relatedTarget)) landing.classList.remove('drop-hover');
    });
    landing.addEventListener('drop', e => {
        e.preventDefault();
        landing.classList.remove('drop-hover');
        const f = e.dataTransfer.files[0];
        if (!f) return;
        if (f.name.toLowerCase().endsWith('.sf2')) handleSf2Import(f);
        else handleWadImport(f);
    });

    // Expose for test injection and external tooling.
    window.__handleWadImport = handleWadImport;
    window.__handleSf2Import = handleSf2Import;
    window.__wadImport = { identifyWad, WadError };
    window.__sf2Library = { validateSf2, Sf2Error };

    // Test hooks (browser test use only):
    //   __testInjectManifest(entry) — push a fake manifest entry (bypasses IDB)
    //   __testSetServerGamesFilter(bool) — toggle the local-WAD filter in serverGames()
    //     false = disable (red-proof: local WADs appear in MP picker)
    //     true  = restore (green state: local WADs absent from MP picker)
    window.__testInjectManifest = entry => manifest.push(entry);
    window.__testSetServerGamesFilter = enabled => { _serverGamesFilter = enabled; };

    // PSX DOOM fire background. Inserted into #stage so it sits behind
    // the menu and is invisible during gameplay (paused while game runs).
    fire = createFire($('stage'));

    // Mirror the audio.js visibilitychange pattern: pause fire when the tab
    // is hidden (zero CPU cost), resume when it becomes visible again.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) fire.pause();
        else if (!booted) fire.resume();
    });

    // ── Demo permalink: check URL for a demo share param ──────────────────────
    // ?demo=<sha256id>&wad=<wadfile>  → server-stored demo
    // #demo=<base64url>&wad=<wadfile> → fragment-embedded demo (≤ FRAGMENT_MAX bytes)
    //
    // WAD ownership check: the named WAD must be in the server's manifest.
    // If missing, show a warning and abort replay (receiver must own the WAD).
    const demoInfo = await parseDemoUrl().catch(() => null);
    if (demoInfo) {
        const { bytes, wad } = demoInfo;
        if (wad && !ownsWad(manifest, wad)) {
            showWadWarning(wad);   // sets #status — do NOT clear it with status('')
            menu.reset(rootScreen());
            return;
        }
        // Find the matching WAD entry in the manifest for booting.
        const wadEntry = wad ? manifest.find(w => w.file === wad) : sortedGames()[0];
        if (!wadEntry) {
            showWadWarning(wad || '(unknown)');   // sets #status — do NOT clear it
            menu.reset(rootScreen());
            return;
        }
        // Hide the menu and replay the demo.
        booted = true;
        fire?.pause();
        menu.hide();
        showReplayNotice();
        bootDoom({ wads: stackFor(wadEntry.file), args: [], onQuit: returnToMenu })
            .then(doom => {
                if (!doom) return;
                const rc = startReplay(doom, bytes);
                if (rc !== 0) {
                    resetToLauncher('demo replay failed: version mismatch');
                    return;
                }
                // task 19.3: attach scrubber below the canvas.
                // window.webdoom.attachScrubber is set by bootDoom (main.js).
                // Container: the element that holds #screen (defaults to body).
                const scrubContainer = document.getElementById('screen')?.parentElement
                    ?? document.body;
                window.webdoom?.attachScrubber?.(bytes, scrubContainer);
            })
            .catch(err => { resetToLauncher(err); });
        return;
    }

    menu.reset(rootScreen());   // triggers onTransition('reset') → fire.flare()
    status('');
    // On insecure origins (plain http://<LAN-IP>) navigator.serviceWorker is
    // absent — the SW never engages and its WAD cache is unavailable. WADs
    // still cache locally via IndexedDB; only installable offline mode is
    // lost. Browsers hard-block SW on plain-HTTP non-localhost origins, so
    // this is informational, not an error — word it that way (field report:
    // the old "offline caching unavailable" phrasing was read as a bug three
    // times). Shown once per browser, not every launch.
    if (!('serviceWorker' in navigator) &&
            !localStorage.getItem('http-notice-shown')) {
        localStorage.setItem('http-notice-shown', '1');
        status('ℹ WADs cached locally — offline install needs HTTPS or localhost (all features work)');
    }
})();
