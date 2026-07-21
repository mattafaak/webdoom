// DOOM-style drill-down front end. One short list per screen:
//   SINGLE PLAYER → game → boot (engine's own menu takes it from there)
//   MULTIPLAYER   → everyone lands in the lobby, START ready on the
//                   current defaults; GAME/MAP/MODE/SKILL are optional
//                   one-screen pickers. Doing nothing = you're
//                   Green/Indigo/… and ready to go.
import { bootDoom } from './main.js';
import { connectLobby, launchArgs } from './net.js';
import { loadDoomFont } from './doomfont.js';
import { createMenu } from './menu.js';
import { createCountdown } from './countdown.js';
import { createFire } from './fire.js';
import { identifyWad, WadError } from './wad-import.js';
import { libraryAdd, libraryList } from './wad-library.js';

const $ = id => document.getElementById(id);
const status = msg => { $('status').textContent = msg; };

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
const GAME_ORDER = ['doom.wad', 'doom2.wad', 'sigil.wad', 'nerve.wad',
    'tnt.wad', 'plutonia.wad', 'chex.wad', 'hacx.wad'];

const sortedGames = () => manifest.filter(w => !w.patch && !w.group)
    .sort((a, b) => {
        const ia = GAME_ORDER.indexOf(a.file), ib = GAME_ORDER.indexOf(b.file);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
const groups = () => [...new Set(manifest.filter(w => w.group).map(w => w.group))];

// --- screens -----------------------------------------------------------------

function rootScreen() {
    return {
        items: [
            { label: 'SINGLE PLAYER', action: () => menu.push(spGameScreen()) },
            { label: 'MULTIPLAYER', action: enterMultiplayer },
            { label: 'IMPORT WAD', action: () => document.getElementById('wad-file-input')?.click() },
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

// Quit Game (→ Y) inside the engine returns here.
function returnToMenu() {
    booted = false;
    if (lobby) { lobby.close(); lobby = null; }
    roster = null;
    ipSummary = null; ipSlot = -1;
    fire?.resume();   // restart fire now that we are back on the launcher
    // flare is triggered by menu.reset() → onTransition('reset') below
    menu.show();
    menu.reset(rootScreen());
}

// a single-map PWAD (a Master Level, at its own slot like MAP25) is
// launched straight into that map — the engine's New Game would start at
// MAP01, i.e. the base IWAD's map, not the one you picked.
const singleMap = w => (w.maps?.length === 1 && !w.maps[0].startsWith('E')) ? +w.maps[0].slice(3) : null;

function spGameScreen() {
    const boot = w => {
        if (booted) return;
        booted = true;
        fire?.pause();    // stop fire while the game is running
        menu.hide();
        const m = singleMap(w);
        const args = m ? ['-warp', String(m), '-skill', '3'] : [];
        bootDoom({ wads: stackFor(w.file), args, onQuit: returnToMenu })
            .catch(err => {
                // WAD fetch / engine boot failed: reset so the user can retry
                // without reloading the page.  main.js has already restored
                // #landing visibility via restoreOnFailure(); here we re-arm
                // the booted guard and bring the menu back to the root screen.
                booted = false;
                fire?.resume();
                // flare triggered by menu.reset() → onTransition('reset')
                menu.show();
                menu.reset(rootScreen());
                status(String(err));
            });
    };
    return {
        title: 'CHOOSE GAME',
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
        }))),
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
            const rtts = [];
            for (let i = 0; i < 12; i++) rtts.push(await lobby.ping().catch(() => 50));
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
                // Reset all state so the user can retry from the root menu.
                booted = false;
                countdown.reset();
                fire?.resume();
                // flare triggered by menu.reset() → onTransition('reset')
                menu.show();
                menu.reset(rootScreen());
                if (lobby) { lobby.close(); lobby = null; }
                roster = null;
                ipSummary = null; ipSlot = -1;
                status(String(err));
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
    return picker('CHOOSE GAME', sortedGames().map(w => ({
        label: w.title,
        thumb: font.titleThumb(w.file, 52),
        apply: () => pickWad(w),
    })).concat(groups().map(g => ({
        label: g,
        action: () => menu.push(picker(g,
            manifest.filter(w => w.group === g).map(w => ({
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
        const files = sortedGames().map(w => w.file);
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
              maxValue: sortedGames().reduce((a, b) => b.title.length > a.length ? b.title : a, ''),
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

function leaveLobby() {
    const l = lobby;
    lobby = null;               // mark deliberate before the close event
    l?.close();
    roster = null;
    ipSummary = null; ipSlot = -1;
    countdown.reset();          // guard T25: dismiss countdown if user ESCs mid-countdown
    // flare triggered by menu.reset() → onTransition('reset')
    menu.reset(rootScreen());
}

// --- boot ------------------------------------------------------------------------
(async () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
        // When a new service worker takes control mid-session, surface a
        // non-intrusive reload prompt rather than silently serving a mixed
        // old/new asset state. The prompt never interrupts an active match.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            const el = document.getElementById('sw-update');
            if (el) el.hidden = false;
        });
    }
    try {
        manifest = (await (await fetch('/api/wads')).json()).wads;

        // Merge local-library entries into the manifest.
        // Entries already on the server (same sha256) are skipped.
        const serverShas = new Set(manifest.map(e => e.sha256));
        const localEntries = await libraryList().catch(() => []);
        for (const e of localEntries) {
            if (!serverShas.has(e.sha256)) manifest.push(e);
        }

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
    } catch (err) {
        console.error(err);
        status('cannot reach server');
        return;
    }

    // --- WAD import: file picker (for keyboard/test access) + drag-drop ------
    // Hidden file input — triggered by "IMPORT WAD" menu item or programmatically.
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.wad';
    fileInput.id = 'wad-file-input';
    fileInput.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', e => {
        const f = e.target.files[0];
        if (f) { fileInput.value = ''; handleWadImport(f); }
    });

    // Drag-and-drop on #landing (the full landing menu area).
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
        if (f) handleWadImport(f);
    });

    // Expose for test injection and external tooling.
    window.__handleWadImport = handleWadImport;
    window.__wadImport = { identifyWad, WadError };

    // PSX DOOM fire background. Inserted into #stage so it sits behind
    // the menu and is invisible during gameplay (paused while game runs).
    fire = createFire($('stage'));

    // Mirror the audio.js visibilitychange pattern: pause fire when the tab
    // is hidden (zero CPU cost), resume when it becomes visible again.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) fire.pause();
        else if (!booted) fire.resume();
    });

    menu.reset(rootScreen());   // triggers onTransition('reset') → fire.flare()
    status('');
    // On insecure origins (plain http://<LAN-IP>) navigator.serviceWorker is
    // absent — the SW never engages and its WAD cache is unavailable.
    // Surface a non-silent notice so players know WADs are cached locally via
    // IndexedDB instead. This replaces the previous silent no-op.
    if (!('serviceWorker' in navigator)) {
        status('offline caching unavailable (insecure origin) — WADs cached locally instead');
    }
})();
