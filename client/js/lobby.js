// DOOM-style drill-down front end. One short list per screen:
//   SINGLE PLAYER → game → boot (engine's own menu takes it from there)
//   MULTIPLAYER   → joins the lobby; first player drills
//                   GAME → (EPISODE) → MAP → MODE → SKILL → lobby screen;
//                   later joiners land straight on the lobby screen.
// Lobby screen: roster in player colors, START, name entry, free-color
// pick, setup summary. Doing nothing = you're Green/Indigo/… and ready.
import { bootDoom } from './main.js';
import { connectLobby, launchArgs } from './net.js';
import { loadDoomFont } from './doomfont.js';
import { createMenu } from './menu.js';

const $ = id => document.getElementById(id);
const status = msg => { $('status').textContent = msg; };

const SKILLS = ["I'M TOO YOUNG TO DIE", 'HEY, NOT TOO ROUGH', 'HURT ME PLENTY',
    'ULTRA-VIOLENCE', 'NIGHTMARE!'];
const MODES = [['coop', 'COOPERATIVE'], ['deathmatch', 'DEATHMATCH'], ['altdeath', 'DEATHMATCH 2.0']];
const COLORS = ['Green', 'Indigo', 'Brown', 'Red'];

let manifest = [];
let menu = null;
let lobby = null;
let roster = null;              // latest roster message
let booted = false;
let inLobbyScreen = false;

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

function gameItems(onPick) {
    const top = manifest.filter(w => !w.patch && !w.group)
        .sort((a, b) => {
            const ia = GAME_ORDER.indexOf(a.file), ib = GAME_ORDER.indexOf(b.file);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        })
        .map(w => ({ label: w.title, action: () => onPick(w) }));
    const grouped = [...new Set(manifest.filter(w => w.group).map(w => w.group))]
        .map(g => ({
            label: g,
            action: () => menu.push({
                title: g,
                items: manifest.filter(w => w.group === g)
                    .map(w => ({ label: w.title, action: () => onPick(w) })),
            }),
        }));
    return [...top, ...grouped];
}

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
    return {
        title: 'CHOOSE GAME',
        items: gameItems(w => {
            if (booted) return;
            booted = true;
            menu.hide();
            bootDoom({ wads: stackFor(w.file) }).catch(err => status(String(err)));
        }),
    };
}

// --- multiplayer -----------------------------------------------------------------

function enterMultiplayer() {
    if (lobby) { menu.push(lobbyScreen()); inLobbyScreen = true; return; }
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    lobby = connectLobby(base);
    lobby
        .on('roster', m => {
            const first = roster === null && m.players.length === 1;
            roster = m;
            if (first && !m.inGame) {
                menu.push(mpGameScreen());         // first one in drills the setup
            } else if (roster && menu.depth() === 1) {
                if (m.inGame) { status('game in progress — try again shortly'); lobby.close(); }
                else { menu.push(lobbyScreen()); inLobbyScreen = true; }
            } else if (inLobbyScreen) {
                menu.refresh(lobbyScreen());       // live roster/param updates
            }
        })
        .on('full', m => { status(m.reason); lobby = null; })
        .on('countdown', m => {
            if (booted) return;
            $('countdown').hidden = false;
            $('countdown').textContent = m.n;
        })
        .on('launch', async m => {
            if (booted) return;
            booted = true;
            $('countdown').textContent = 'GO';
            const rtt = await lobby.ping().catch(() => 5);
            const e = entry(m.params.wad);
            menu.hide();
            bootDoom({
                wads: stackFor(m.params.wad),
                args: launchArgs(m.params, isCommercial(e)),
                net: { slot: lobby.slot, numplayers: m.numplayers, rttMs: rtt, names: m.names, slots: m.slots },
            }).then(() => {
                $('countdown').hidden = true;
                lobby.close();
            }).catch(err => status(String(err)));
        })
        .on('closed', () => {
            if (booted) return;
            lobby = null; roster = null; inLobbyScreen = false;
            status('lobby connection lost');
            menu.reset(rootScreen());
        });
}

// drill steps accumulate into this, sent progressively
const setup = {};

function mpGameScreen() {
    return {
        title: 'CHOOSE GAME',
        onBack: leaveLobby,
        items: gameItems(w => {
            setup.wad = w.file;
            lobby.setParams({ wad: w.file });
            menu.push(isCommercial(w) ? mpMapScreen(w) : mpEpisodeScreen(w));
        }),
    };
}

function mpEpisodeScreen(w) {
    const eps = [...new Set((w.maps ?? []).map(m => +m[1]))].sort();
    return {
        title: 'WHICH EPISODE?',
        items: eps.map(n => ({
            label: `EPISODE ${n}`,
            action: () => {
                setup.episode = n;
                lobby.setParams({ episode: n });
                menu.push(mpMapScreen(w, n));
            },
        })),
    };
}

function mpMapScreen(w, ep = null) {
    const maps = (w.maps ?? []).filter(m => ep === null || +m[1] === ep);
    return {
        title: 'WHICH MAP?',
        items: maps.map(m => ({
            label: m,
            action: () => {
                setup.map = ep === null ? +m.slice(3) : +m[3];
                lobby.setParams({ map: setup.map });
                menu.push(mpModeScreen());
            },
        })),
    };
}

function mpModeScreen() {
    return {
        title: 'WHICH MODE?',
        items: MODES.map(([value, label]) => ({
            label,
            action: () => {
                setup.mode = value;
                lobby.setParams({ mode: value });
                menu.push(mpSkillScreen());
            },
        })),
    };
}

function mpSkillScreen() {
    return {
        title: 'HOW TOUGH ARE YOU?',
        items: SKILLS.map((label, i) => ({
            label,
            action: () => {
                setup.skill = i + 1;
                lobby.setParams({ skill: i + 1 });
                menu.push(lobbyScreen());
                inLobbyScreen = true;
            },
        })),
    };
}

function summary(p) {
    const e = entry(p.wad);
    const map = isCommercial(e) ? `MAP${String(p.map).padStart(2, '0')}` : `E${p.episode}M${p.map}`;
    const mode = MODES.find(m => m[0] === p.mode)?.[1] ?? p.mode;
    return `${map} - ${mode} - ${SKILLS[p.skill - 1] ?? ''}`;
}

function lobbyScreen() {
    const me = roster?.players.find(p => p.slot === lobby.slot);
    const p = roster?.params ?? {};
    const free = roster?.freeSlots ?? [];
    return {
        title: entry(p.wad)?.title ?? 'LOBBY',
        header: (roster?.players ?? []).map(pl =>
            ({ text: pl.name + '  ', color: pl.color })),
        onBack: leaveLobby,
        items: [
            { label: summary(p), action: () => menu.push(mpGameScreen()) },
            { label: 'START GAME', action: () => lobby.start() },
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
                    // cycle through free colors (slot change = color change)
                    const order = [lobby.slot, ...free].sort();
                    const next = order[(order.indexOf(lobby.slot) + 1) % order.length];
                    if (next !== lobby.slot) lobby.send({ t: 'slot', slot: next });
                },
            }] : []),
        ],
    };
}

function leaveLobby() {
    inLobbyScreen = false;
    lobby?.close();
    lobby = null;
    roster = null;
    menu.reset(rootScreen());
}

// --- boot ------------------------------------------------------------------------
(async () => {
    if ('serviceWorker' in navigator)
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    try {
        manifest = (await (await fetch('/api/wads')).json()).wads;
        const font = await loadDoomFont();
        menu = createMenu(font, $('landing'));
    } catch (err) {
        console.error(err);
        status('cannot reach server');
        return;
    }
    menu.reset(rootScreen());
    status('');
})();
