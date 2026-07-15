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

function spGameScreen() {
    const boot = w => {
        if (booted) return;
        booted = true;
        menu.hide();
        bootDoom({ wads: stackFor(w.file) }).catch(err => status(String(err)));
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

function gamePick() {
    return picker('CHOOSE GAME', sortedGames().map(w => ({
        label: w.title,
        thumb: font.titleThumb(w.file, 52),
        apply: () => setParams({ wad: w.file, episode: 1, map: 1 }),
    })).concat(groups().map(g => ({
        label: g,
        action: () => menu.push(picker(g,
            manifest.filter(w => w.group === g).map(w => ({
                label: w.title,
                apply: () => setParams({ wad: w.file, episode: 1, map: 1 }),
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

function mapName(p) {
    const e = entry(p.wad);
    return isCommercial(e) ? `MAP${String(p.map).padStart(2, '0')}` : `E${p.episode}M${p.map}`;
}

function lobbyScreen() {
    const me = roster?.players.find(pl => pl.slot === lobby.slot);
    const p = roster?.params ?? {};
    const free = roster?.freeSlots ?? [];
    const mode = MODES.find(m => m[0] === p.mode)?.[1] ?? p.mode;
    return {
        id: 'lobby',
        title: 'FIGHT TOGETHER',
        header: (roster?.players ?? []).map(pl =>
            ({ text: pl.name + '  ', color: pl.color })),
        onBack: leaveLobby,
        items: [
            { label: 'START GAME', action: () => lobby.start() },
            { label: 'GAME: ', value: entry(p.wad)?.title ?? p.wad, action: () => menu.push(gamePick()) },
            { label: 'MAP: ', value: mapName(p), action: () => menu.push(mapPick()) },
            { label: 'MODE: ', value: mode, action: () => menu.push(modePick()) },
            { label: 'SKILL: ', value: SKILLS[p.skill - 1] ?? '', action: () => menu.push(skillPick()) },
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
                action: () => {
                    const order = [lobby.slot, ...free].sort();
                    const next = order[(order.indexOf(lobby.slot) + 1) % order.length];
                    if (next !== lobby.slot) lobby.send({ t: 'slot', slot: next });
                },
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
