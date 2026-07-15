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

const $ = id => document.getElementById(id);
const status = msg => { $('status').textContent = msg; };

const SKILLS = ["I'M TOO YOUNG TO DIE", 'HEY, NOT TOO ROUGH', 'HURT ME PLENTY',
    'ULTRA-VIOLENCE', 'NIGHTMARE!'];
const MODES = [['coop', 'COOPERATIVE'], ['deathmatch', 'DEATHMATCH'], ['altdeath', 'DEATHMATCH 2.0']];
const COLORS = ['Green', 'Indigo', 'Brown', 'Red'];

let manifest = [];
let font = null;
let menu = null;
let lobby = null;
let roster = null;              // latest roster message
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
        ],
    };
}

// Quit Game (→ Y) inside the engine returns here.
function returnToMenu() {
    booted = false;
    if (lobby) { lobby.close(); lobby = null; }
    roster = null;
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
        menu.hide();
        const m = singleMap(w);
        const args = m ? ['-warp', String(m), '-skill', '3'] : [];
        bootDoom({ wads: stackFor(w.file), args, onQuit: returnToMenu })
            .catch(err => status(String(err)));
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
    if (lobby) { menu.push(lobbyScreen()); return; }
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    lobby = connectLobby(base);
    lobby
        .on('roster', m => {
            roster = m;
            if (menu.current()?.id === 'lobby') menu.refresh(lobbyScreen());
            else if (menu.depth() === 1) {
                if (m.inGame) { status('game in progress — try again shortly'); lobby.close(); lobby = null; }
                else menu.push(lobbyScreen());
            }
        })
        .on('full', m => { status(m.reason); lobby = null; })
        .on('countdown', m => { if (!booted) countdown.show(m.n); })
        .on('launch', async m => {
            if (booted) return;
            booted = true;
            countdown.show('GO');
            const rtt = await lobby.ping().catch(() => 5);
            const e = entry(m.params.wad);
            menu.hide();
            bootDoom({
                wads: stackFor(m.params.wad),
                args: launchArgs(m.params, isCommercial(e)),
                net: { slot: lobby.slot, numplayers: m.numplayers, rttMs: rtt, names: m.names, slots: m.slots },
                onQuit: returnToMenu,
            }).then(() => {
                countdown.dismiss();
                lobby.close();
            }).catch(err => status(String(err)));
        })
        .on('closed', () => {
            if (booted || !lobby) return;   // deliberate leave already reset
            lobby = null; roster = null;
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
    menu.reset(rootScreen());
}

// --- boot ------------------------------------------------------------------------
(async () => {
    if ('serviceWorker' in navigator)
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    try {
        manifest = (await (await fetch('/api/wads')).json()).wads;
        font = await loadDoomFont();
        menu = createMenu(font, $('landing'));
        countdown = createCountdown(font, $('countdown'));
    } catch (err) {
        console.error(err);
        status('cannot reach server');
        return;
    }
    menu.reset(rootScreen());
    status('');
})();
