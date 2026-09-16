// The launcher: a DOOM-style drill-down menu.  SINGLE PLAYER → a game → boot;
// MULTIPLAYER → the lobby, START ready on the current defaults, GAME and MAP
// pickers and value rows for the rest.  Doing nothing = you are Green/Indigo/…
import { bootDoom } from './main.js';
import { connectLobby, launchArgs } from './net.js';
import { loadDoomFont } from './doomfont.js';
import { setStatus, loading, serverConfig } from './ui.js';

import { createMenu } from './menu.js';
import { createCountdown } from './countdown.js';
import { createFire } from './fire.js';
import { identifyWad, WadError } from './wad-import.js';
import { libraryAdd, libraryList } from './wad-library.js';
import { validateSf2, Sf2Error, sf2StoreCurrent } from './sf2-library.js';
import { parseDemoUrl, startReplay, stopAndShare, showSharePanel, showWadWarning } from './demo.js';
import {
    ACTIONS, loadSettings, saveSettings, defaultSettings, captureBind,
} from './input.js';
import { sf2GetCurrentMeta } from './sf2-library.js';

const $ = id => document.getElementById(id);
// the call sites read `status(...)`
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

const MAXWEBFILES = 40;     // the engine's file registry cap; mirrored in engine/web/files.c
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

// Curated order; grouped entries (Master Levels) fold into a submenu.
// tools/check-menu-reachable.mjs asserts every entry can be served or imported.
const GAME_ORDER = ['doom.wad', 'doom2.wad', 'sigil.wad', 'nerve.wad',
    'tnt.wad', 'plutonia.wad', 'chex.wad'];

const sortedGames = () => manifest.filter(w => !w.patch && !w.group)
    .sort((a, b) => {
        const ia = GAME_ORDER.indexOf(a.file), ib = GAME_ORDER.indexOf(b.file);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
const groups = () => [...new Set(manifest.filter(w => w.group).map(w => w.group))];

// Multiplayer offers only what the server can serve: a user-imported WAD
// (local:true) has a sha the other players cannot fetch.  The flag exists for
// the browser test that red-proves this filter.
let serverGamesFilter = true;
const serverGames = () => serverGamesFilter ? sortedGames().filter(w => !w.local) : sortedGames();


// --- screens -----------------------------------------------------------------

function rootScreen() {
    return {
        id: 'root',
        items: [
            { label: 'SINGLE PLAYER', action: () => menu.push(spGameScreen()) },
            { label: 'MULTIPLAYER', action: enterMultiplayer },
            { label: 'OPTIONS', action: () => menu.push(optionsScreen()) },
            { label: 'IMPORT WAD', action: () => document.getElementById('wad-file-input')?.click() },
        ],
    };
}

// --- OPTIONS -------------------------------------------------------------------
// Nothing is applied live: the launcher runs before any engine exists.
// saveSettings() persists and main.js applies the set at boot; DOOM's own
// menu (Escape) owns volume, detail and screen size in game.
let settings = null;
const S = () => (settings ??= loadSettings());

// GM needs a stored .sf2 and the operator's synth URL: fetched once on entry,
// so the MUSIC row can name what is missing.
let gmState = null;
async function loadGmState() {
    if (gmState) return;
    const [meta, cfg] = await Promise.all([sf2GetCurrentMeta().catch(() => null), serverConfig()]);
    gmState = { sf2: !!meta, url: !!cfg?.spessaSynthUrl };
    if (menu.current()?.id === 'options') menu.refresh(optionsScreen());
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

// wrap-around step through a list; an unknown value steps from the start
const cyc = (arr, cur, dir) => arr[(arr.indexOf(cur) + dir + arr.length) % arr.length];

const keyName = code => String(code)
    .replace(/[^a-zA-Z0-9]/g, '')      // codes are alphanumeric; localStorage is not trusted
    .replace(/^Key|^Digit/, '')
    .replace(/^Arrow/, '')
    .replace(/(?!^)(Left|Right)$/, ' $1')
    .trim()                            // 'ArrowLeft' -> 'Left' -> ' Left' without this
    .toUpperCase();

// Every OPTIONS value row: ←/→ steps it, Enter steps it forward, and each
// change is saved and re-rendered.  `next(cur, dir)` computes the new value.
const setting = (key, next) => dir => {
    S()[key] = next(S()[key], dir);
    saveSettings(S());
    menu.refresh(optionsScreen());
};
const flip = key => setting(key, v => !v);
// A ladder of allowed values.  A stored value that is in range but not on the
// ladder (hand-edited localStorage; sanitizeSettings clamps, it does not round)
// lands on the next rung up rather than jumping to the start.
const ladder = steps => (cur, dir) => {
    let i = steps.indexOf(cur);
    if (i < 0) i = Math.max(0, steps.findIndex(v => v >= cur));
    return steps[(i + dir + steps.length) % steps.length];
};
// Left/right cycles and Enter advances by one -- the same function, so the
// two cannot drift apart.
const both = fn => ({ cycle: fn, action: () => fn(1) });

const SENS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const PADTURN = [0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
const DEADZONE = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.9];
const MOUSEY = ['off', 'look', 'move'];
const BACKENDS = ['opl2', 'opl3', 'gm'];

const onoff = v => (v ? 'ON' : 'OFF');

function optionsScreen() {
    loadGmState();
    // opl3 is a legacy bool kept in step with musicBackend for back-compat.
    const music = (v, dir) => { const b = cyc(BACKENDS, v, dir); S().opl3 = b === 'opl3'; return b; };
    return {
        id: 'options',
        title: 'OPTIONS',
        nowrap: true,
        // DOOM's own menu is still there and still owns four settings, one of
        // which (mouse sensitivity) multiplies the same mouse deltas this
        // screen scales.  Saying so is cheaper than a player finding out.
        header: [{ text: 'IN GAME, ESC OPENS DOOM\'S OWN MENU' }],
        items: [
            { label: 'CONTROLS', action: () => menu.push(controlsScreen()) },
            { label: 'MOUSE SENSITIVITY: ', value: String(S().mouseSens), maxValue: '12',
              ...both(setting('mouseSens', ladder(SENS))) },
            { label: 'MOUSE Y: ', value: S().mouseY.toUpperCase(), maxValue: 'LOOK',
              ...both(setting('mouseY', (v, d) => cyc(MOUSEY, v, d))) },
            { label: 'ALWAYS RUN: ', value: onoff(S().alwaysRun), maxValue: 'OFF',
              ...both(flip('alwaysRun')) },
            { label: 'SMOOTH RENDERING: ', value: onoff(S().smooth), maxValue: 'OFF',
              ...both(flip('smooth')) },
            { label: 'MUSIC: ', value: musicValue(), maxValue: 'GM - NO SYNTH URL',
              ...both(setting('musicBackend', music)) },
            { label: 'GAMEPAD TURN: ', value: S().padTurnSpeed.toFixed(1), maxValue: '2.0',
              ...both(setting('padTurnSpeed', ladder(PADTURN))) },
            { label: 'GAMEPAD DEADZONE: ', value: S().padDeadzone.toFixed(2), maxValue: '0.90',
              ...both(setting('padDeadzone', ladder(DEADZONE))) },
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
        id: 'controls',
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
    if (manifest.length >= MAXWEBFILES) {
        status(`WAD library full (max ${MAXWEBFILES} files)`);
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
        status(`Imported: ${entry.title}`, 6000);

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

        status(`SoundFont loaded: ${name}`, 6000);

    } catch (err) {
        const msg = err instanceof Sf2Error
            ? `SF2 rejected: ${err.message}`
            : `SF2 error: ${err.message ?? String(err)}`;
        status(msg);
    }
}

// ── one way back to the launcher ─────────────────────────────────────────────
// Every step is idempotent, so single player and a live lobby take the same
// path.  `lobby` is nulled BEFORE close(): the 'closed' handler reads !lobby
// to tell a deliberate leave from a dropped connection.
// reason: shown in #status; omit it for a clean return (passing '' would
// blank a message another path just set).
function resetToLauncher(reason) {
    booted = false;
    recOverlay.hide();
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

// ── one way into a game ──────────────────────────────────────────────────────
// Every path that boots the engine -- single player, a lobby launch, a
// spectator, a demo permalink -- comes through here: the guard, the fire and
// menu state, the recording overlay, and the one catch.
//   after(doom): runs once the engine is up (start a replay, close the lobby)
function enterGame({ wads, args = [], net = null, record = false, after = null }) {
    if (booted) return;
    booted = true;
    fire?.pause();
    menu.hide();
    if (record) recOverlay.show();
    bootDoom({ wads, args, net, record, onQuit: returnToMenu })
        .then(doom => {
            if (record) recOverlay.arm(doom, wads[0].file);
            after?.(doom);
        })
        .catch(err => resetToLauncher(err));
}

// A REC badge while recording and, once the engine is up, a STOP & SHARE
// button.  resetToLauncher() removes both, so a quit mid-recording leaves
// nothing over the launcher.
const recOverlay = {
    show() {
        const el = document.createElement('div');
        el.id = 'rec-indicator';
        el.textContent = '● REC';
        document.body.appendChild(el);
    },
    arm(doom, wadFile) {
        const btn = document.createElement('button');
        btn.id = 'demo-stop-btn';
        btn.textContent = '⏹ STOP & SHARE';
        btn.title = 'Stop recording and generate a share link';
        btn.onclick = async () => {
            recOverlay.hide();
            try { showSharePanel(await stopAndShare(doom, wadFile)); }
            catch (e) { status('demo share error: ' + e.message); }
        };
        document.body.appendChild(btn);
    },
    hide() {
        for (const id of ['rec-indicator', 'demo-stop-btn']) document.getElementById(id)?.remove();
    },
};

// a single-map PWAD (a Master Level, at its own slot like MAP25) is
// launched straight into that map — the engine's New Game would start at
// MAP01, i.e. the base IWAD's map, not the one you picked.
const singleMap = w => (w.maps?.length === 1 && !w.maps[0].startsWith('E')) ? +w.maps[0].slice(3) : null;

// The game list in curated order, grouped entries (Master Levels) one screen
// down.  onPick(w, depth) gets how many screens deep the pick was made, so a
// multiplayer picker can unwind back to the lobby.  local=false hides
// user-imported WADs: the server cannot serve them to the other players.
function gameItems(onPick, local = true) {
    const games = local ? sortedGames() : serverGames();
    return games.map(w => ({ label: w.title, thumb: font.titleThumb(w.file, 52), action: () => onPick(w, 1) }))
        .concat(groups().map(g => ({
            label: g,
            action: () => menu.push({
                id: 'group', title: g,
                items: manifest.filter(w => w.group === g && (local || !w.local))
                    .map(w => ({ label: w.title, action: () => onPick(w, 2) })),
            }),
        })));
}

let recordNext = false;     // the RECORD DEMO row on CHOOSE GAME

function spGameScreen() {
    // a single-map PWAD warps straight to its own slot; the engine's New
    // Game would start the base IWAD's MAP01 instead
    const boot = w => {
        const m = singleMap(w);
        enterGame({ wads: stackFor(w.file), args: m ? ['-warp', String(m), '-skill', '3'] : [], record: recordNext });
    };
    return {
        id: 'sp',
        title: 'CHOOSE GAME',
        items: [
            ...gameItems(boot),
            // recording is a switch on this list, not a second copy of it
            { label: 'RECORD DEMO: ', value: onoff(recordNext), maxValue: 'OFF',
              ...both(() => { recordNext = !recordNext; menu.refresh(spGameScreen()); }) },
        ],
    };
}

// --- multiplayer -----------------------------------------------------------------
// Lobby-first: MULTIPLAYER drops everyone straight into the lobby with
// START ready on the current params; GAME/MAP/MODE/SKILL are optional
// one-screen pickers that pop back. Host start = two clicks.

let countdown = null;

// On the stack from the click until the server answers, so leaving it (ESC)
// closes the socket: a connection with no screen would hold a colour slot
// nobody can see.
const connectingScreen = () => ({ id: 'connecting', title: 'CONNECTING…', items: [], onBack: leaveLobby });

function enterMultiplayer() {
    if (lobby) resetToLauncher();          // a stale handle: start clean
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    lobby = connectLobby(base);
    menu.push(connectingScreen());
    // roster: a lobby is forming.  inprogress: a game is live, offer to drop
    // in.  Either replaces CONNECTING, then refreshes its own screen in place.
    const show = (id, build) => {
        const cur = menu.current()?.id;
        if (cur === id || cur === 'connecting') menu.refresh(build());
    };
    lobby
        .on('inprogress', m => { ipSummary = m; show('inprogress', inProgressScreen); })
        .on('roster', m => { roster = m; show('lobby', lobbyScreen); })
        .on('full', m => resetToLauncher(m.reason))
        .on('countdown', m => { if (!booted) countdown.show(m.n); })
        .on('launch', async m => {
            if (booted) return;
            if (!m.join) countdown.show('GO');    // drop-ins get the catch-up bar, not a countdown
            // Size the jitter buffer from the 75th-percentile spread above the
            // fastest of 12 pings: the mean is already lockstep's own lag and
            // the max would turn one spike into permanent lag.  An unanswered
            // ping (null, PING_TIMEOUT_MS) counts as 50 ms, not as 0.
            const rtts = [];
            for (let i = 0; i < 12; i++) rtts.push((await lobby.ping()) ?? 50);
            rtts.sort((a, b) => a - b);
            const jitterMs = rtts[Math.floor(rtts.length * 0.75)] - rtts[0];
            const e = entry(m.params.wad);
            enterGame({
                wads: stackFor(m.params.wad),
                args: launchArgs(m.params, isCommercial(e)),
                net: { slot: lobby.slot, numplayers: m.numplayers, jitterMs, names: m.names, slots: m.slots,
                       join: !!m.join, frontier: m.frontier },
                after: () => { countdown.dismiss(); lobby.close(); },
            });
        })
        // a dropped connection; a deliberate leave nulls `lobby` first
        .on('closed', () => { if (!booted && lobby) resetToLauncher('lobby connection lost'); });
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

const gamePick = () => ({
    title: 'CHOOSE GAME',
    items: gameItems((w, depth) => { pickWad(w); menu.unwind(depth); menu.refresh(lobbyScreen()); }, false),
});


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

// game rules: toggles stay on this screen; Esc returns to the lobby
function rulesScreen() {
    const p = roster?.params ?? {};
    const set = patch => { setParams(patch); menu.refresh(rulesScreen()); };
    const timers = [0, 5, 10, 15, 20, 30];
    const toggle = key => both(() => set({ [key]: !p[key] }));
    return {
        id: 'rules',
        title: 'RULES',
        items: [
            { label: 'NO MONSTERS: ', value: onoff(p.nomonsters), ...toggle('nomonsters') },
            { label: 'FAST MONSTERS: ', value: onoff(p.fast), ...toggle('fast') },
            { label: 'RESPAWN MONSTERS: ', value: onoff(p.respawn), ...toggle('respawn') },
            { label: 'TIME LIMIT: ', value: p.timer ? `${p.timer} MIN` : 'OFF',
              ...both(dir => set({ timer: cyc(timers, p.timer ?? 0, dir) })) },
        ],
    };
}

function mapName(p) {
    const e = entry(p.wad);
    return isCommercial(e) ? `MAP${String(p.map).padStart(2, '0')}` : `E${p.episode}M${p.map}`;
}


// Shown when you open MULTIPLAYER and a game is already live: a summary
// (wad art, map, mode, who's in) plus optional color/name and a DROP IN that
// catches you up into the running game.
function spectateGame() {
    const s = ipSummary; if (!s) return;
    const names = [null, null, null, null];
    (s.players ?? []).forEach(pl => { names[pl.slot] = pl.name ?? pl.color; });
    enterGame({
        wads: stackFor(s.params.wad),
        args: launchArgs(s.params, isCommercial(entry(s.params.wad))),
        net: { numplayers: 4, slots: (s.players ?? []).map(pl => pl.slot), names,
               spectate: true, frontier: s.frontier ?? 0 },
        after: () => lobby.close(),
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
        ipSlot = cyc(free, ipSlot, dir);
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
        // who is in, then what they are playing -- a header line, not rows,
        // so the cursor only lands on things that do something
        header: [
            ...(s.players ?? []).map(pl =>
                ({ text: (pl.name ?? pl.color) + (pl.live ? '  ' : '… '), color: pl.color })),
            { text: `-  ${entry(p.wad)?.title ?? p.wad}  ${mapName(p)}  ${mode}` },
        ],
        onBack: leaveLobby,
        items: [
            free.length
                ? { label: 'DROP IN', action: dropIn }
                : { label: 'GAME FULL', color: 'Red' },
            { label: 'SPECTATE', action: () => spectateGame() },
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
        const next = cyc(maps, mapName(p), dir);
        if (!next) return;
        if (isCommercial(w)) setParams({ map: +next.slice(3) });
        else setParams({ episode: +next[1], map: +next[3] });
        refresh();
    };
    const cycleMode = dir => { setParams({ mode: cyc(MODES.map(m => m[0]), p.mode, dir) }); refresh(); };
    const cycleSkill = dir => { setParams({ skill: cyc([1, 2, 3, 4, 5], p.skill, dir) }); refresh(); };
    const cycleColor = dir => {
        const next = cyc([lobby.slot, ...free].sort((a, b) => a - b), lobby.slot, dir);
        if (next !== lobby.slot) lobby.send({ t: 'slot', slot: next });
    };


    return {
        id: 'lobby',
        title: 'FIGHT TOGETHER',
        header: (roster?.players ?? []).map(pl =>
            ({ text: pl.name + '  ', color: pl.color })),
        onBack: leaveLobby,
        // GAME and MAP open a picker on Enter (long lists); every value row
        // cycles with ←/→.  maxValue is the longest value a row can show, so
        // the menu never re-scales as a value changes.
        items: [
            { label: 'START GAME', action: () => lobby.start() },
            { label: 'GAME: ', value: entry(p.wad)?.title ?? p.wad,
              maxValue: serverGames().reduce((a, b) => b.title.length > a.length ? b.title : a, ''),
              action: () => menu.push(gamePick()), cycle: cycleGame },
            { label: 'MAP: ', value: mapName(p), maxValue: 'MAP00',
              action: () => menu.push(mapPick()), cycle: cycleMap },
            { label: 'MODE: ', value: mode, maxValue: 'DEATHMATCH 2.0', ...both(cycleMode) },
            { label: 'SKILL: ', value: SKILLS[p.skill - 1] ?? '', maxValue: "I'M TOO YOUNG TO DIE",
              ...both(cycleSkill) },
            { label: 'RULES', action: () => menu.push(rulesScreen()) },

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
        // wired here, not inline in index.html, so a script-src CSP holds
        document.getElementById('sw-reload')?.addEventListener('click', () => location.reload());
        // controllerchange also fires when a FIRST worker claims this page;
        // only a page that was already controlled has an old version to replace
        const hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.register('/sw.js').catch(() => {});
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) return;   // first claim, not an update
            const el = document.getElementById('sw-update');
            if (el) el.hidden = false;
        });
    }
    try {
        // the launcher's own startup (manifest, IDB, ~63 font patches) is long
        // enough on a slow host to need a bar
        loading.show('READING THE WAD LIBRARY…');
        manifest = (await (await fetch('/api/wads')).json()).wads;

        // merge the local library in, capped at the engine's registry size;
        // overflow is skipped loudly, never silently dropped
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
            // a full flare on return to root, a subtle one between screens;
            // fire is created below, and flare() is a no-op while paused
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
        // "cannot reach server" only when the server really was unreachable
        // (browser-resilience keys on it); an answered request that could not
        // be used says what it was
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

    // The one test seam (browser-wadimport, browser-sf2, browser-mp-gating).
    // setServerGamesFilter(false) is the red-proof that the MP filter is
    // load-bearing; injectManifest bypasses IDB.
    window.__wd = {
        handleWadImport, handleSf2Import,
        wadImport: { identifyWad, WadError },
        sf2Library: { validateSf2, Sf2Error },
        injectManifest: entry => manifest.push(entry),
        setServerGamesFilter: enabled => { serverGamesFilter = enabled; },
    };

    // PSX DOOM fire background. Inserted into #stage so it sits behind
    // the menu and is invisible during gameplay (paused while game runs).
    fire = createFire($('stage'));

    // Mirror the audio.js visibilitychange pattern: pause fire when the tab
    // is hidden (zero CPU cost), resume when it becomes visible again.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) fire.pause();
        else if (!booted) fire.resume();
    });

    // ── Demo permalink ───────────────────────────────────────────────────────
    // ?demo=<sha256id>&wad=<file> is server-stored; #demo=<base64url>&wad=<file>
    // is fragment-embedded.  The receiver must own the WAD.
    const demoInfo = await parseDemoUrl().catch(() => null);
    if (demoInfo) {
        const { bytes, wad } = demoInfo;
        if (wad && !entry(wad)) {
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
        status('REPLAYING DEMO — watch the recording', 6000);
        enterGame({

            wads: stackFor(wadEntry.file),
            after: doom => {
                if (startReplay(doom, bytes) !== 0) { resetToLauncher('demo replay failed: version mismatch'); return; }
                // the scrubber sits under the canvas; bootDoom installs attachScrubber
                window.webdoom?.attachScrubber?.(bytes, document.getElementById('screen')?.parentElement ?? document.body);
            },
        });
        return;
    }


    menu.reset(rootScreen());   // triggers onTransition('reset') → fire.flare()
    status('');
    // No service worker on a plain-http LAN origin: WADs still cache in IDB,
    // only offline install is lost.  Informational, once per browser.
    if (!('serviceWorker' in navigator) &&
            !localStorage.getItem('http-notice-shown')) {
        localStorage.setItem('http-notice-shown', '1');
        status('ℹ WADs cached locally — offline install needs HTTPS or localhost (all features work)');
    }
})();
