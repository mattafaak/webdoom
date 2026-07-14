// Landing + arcade lobby. Single player: pick a game, hit PLAY.
// Multiplayer: open the panel — you get the next color slot, everyone
// sees the roster live, any player tweaks params or hits START; a
// countdown broadcasts and every client auto-launches identically.
import { bootDoom } from './main.js';
import { connectLobby, launchArgs } from './net.js';

const $ = id => document.getElementById(id);
const status = msg => { $('status').textContent = msg; };
const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let manifest = [];
let lobby = null;
let booted = false;

const isCommercial = e => e?.maps?.[0]?.startsWith('MAP');
const entry = file => manifest.find(w => w.file === file);

// A selectable "game" = an IWAD, or a PWAD stacked on its base IWAD.
// Official patch wads (tnt31) stack silently onto their base.
function stackFor(file) {
    const e = entry(file);
    if (!e) return [];
    const stack = e.kind === 'IWAD' ? [e] : [entry(e.base), e].filter(Boolean);
    for (const p of manifest)
        if (p.patch && stack.some(s => s.file === p.base) && !stack.includes(p))
            stack.push(p);
    return stack.map(w => ({ file: w.file, sha: w.sha256 }));
}

function gameOptions() {
    return manifest
        .filter(w => !w.patch)
        .map(w => `<option value="${esc(w.file)}">${w.group ? `${esc(w.group)}: ` : ''}${esc(w.title)}</option>`)
        .join('');
}

function fillMapSelectors(file) {
    const e = entry(file);
    const maps = e?.maps ?? [];
    const commercial = isCommercial(e);
    $('mp-ep-wrap').hidden = commercial;
    if (commercial) {
        $('mp-map').innerHTML = maps.map(m => `<option value="${+m.slice(3)}">${m}</option>`).join('');
    } else {
        const eps = [...new Set(maps.map(m => +m[1]))].sort();
        $('mp-episode').innerHTML = eps.map(n => `<option value="${n}">Episode ${n}</option>`).join('');
        const ep = +$('mp-episode').value || eps[0];
        $('mp-map').innerHTML = maps.filter(m => +m[1] === ep)
            .map(m => `<option value="${+m[3]}">${m}</option>`).join('');
    }
}

// --- single player -----------------------------------------------------------
function initSP() {
    $('wad-select').innerHTML = gameOptions();
    $('wad-select').value = localStorage.getItem('webdoom.wad') ?? 'doom.wad';
    if (!$('wad-select').value) $('wad-select').selectedIndex = 0;
    $('play').onclick = () => {
        if (booted) return;
        booted = true;
        const file = $('wad-select').value;
        localStorage.setItem('webdoom.wad', file);
        lobby?.close();
        bootDoom({ wads: stackFor(file) }).catch(err => status(String(err)));
    };
}

// --- multiplayer ----------------------------------------------------------------
const COLOR_CSS = { Green: '#3a3', Indigo: '#557', Brown: '#a73', Red: '#c33' };

function initMP() {
    $('mp-wad').innerHTML = gameOptions();
    $('mp-wad').value = 'doom.wad';
    fillMapSelectors('doom.wad');

    $('mp').ontoggle = () => {
        if ($('mp').open && !lobby) joinLobby();
    };

    const sendParams = () => lobby?.setParams({
        wad: $('mp-wad').value,
        episode: +$('mp-episode').value || 1,
        map: +$('mp-map').value || 1,
        skill: +$('mp-skill').value,
        mode: $('mp-mode').value,
    });
    $('mp-wad').onchange = () => { fillMapSelectors($('mp-wad').value); sendParams(); };
    $('mp-episode').onchange = () => { fillMapSelectors($('mp-wad').value); sendParams(); };
    for (const id of ['mp-map', 'mp-skill', 'mp-mode']) $(id).onchange = sendParams;
    $('mp-start').onclick = () => lobby?.start();
}

function renderRoster(m) {
    $('mp-roster').innerHTML = m.players.map(p => `
        <span class="chip${p.slot === lobby.slot ? ' you' : ''}"
              style="--c:${COLOR_CSS[p.color] ?? '#666'}">${esc(p.color)}${p.slot === lobby.slot ? ' (you)' : ''}</span>
    `).join('');
    // reflect params set by other players
    const p = m.params;
    if ($('mp-wad').value !== p.wad) { $('mp-wad').value = p.wad; fillMapSelectors(p.wad); }
    $('mp-episode').value = p.episode;
    $('mp-map').value = p.map;
    $('mp-skill').value = p.skill;
    $('mp-mode').value = p.mode;
    $('mp-note').textContent = m.inGame ? 'game in progress — wait for it to finish'
        : `${m.players.length} player${m.players.length > 1 ? 's' : ''} in lobby`;
}

function joinLobby() {
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    lobby = connectLobby(base);
    lobby
        .on('roster', renderRoster)
        .on('full', m => { $('mp-note').textContent = m.reason; lobby = null; })
        .on('countdown', m => {
            if (booted) return;         // in-game: nothing may re-show it
            $('countdown').hidden = false;
            $('countdown').textContent = m.n;
        })
        .on('launch', async m => {
            if (booted) return;
            booted = true;
            $('countdown').textContent = 'GO';
            const rtt = await lobby.ping().catch(() => 5);
            const e = entry(m.params.wad);
            bootDoom({
                wads: stackFor(m.params.wad),
                args: launchArgs(m.params, isCommercial(e)),
                net: { slot: lobby.slot, numplayers: m.numplayers, rttMs: rtt },
            }).then(() => {
                $('countdown').hidden = true;
                lobby.close();          // lobby's job is done; the relay owns the game
            }).catch(err => status(String(err)));
        })
        .on('closed', () => { if (!booted) $('mp-note').textContent = 'lobby connection lost'; });
}

// --- boot ------------------------------------------------------------------------
(async () => {
    if ('serviceWorker' in navigator)
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    try {
        manifest = (await (await fetch('/api/wads')).json()).wads;
    } catch {
        status('cannot reach server manifest');
        return;
    }
    initSP();
    initMP();
    status('');
})();
