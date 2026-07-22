// Settings overlay: key rebinding, mouse/gamepad tuning. Toggled with
// F8 (or the gear button); state persists via input.js's localStorage.
import { ACTIONS, saveSettings, defaultSettings } from './input.js';

export function createSettingsUI(input, doom) {
    const s = input.settings;
    const panel = document.createElement('div');
    panel.id = 'settings';
    panel.hidden = true;
    document.getElementById('stage').appendChild(panel);

    const keyName = code => String(code)
        .replace(/[^a-zA-Z0-9]/g, '')   // codes are alphanumeric; localStorage isn't trusted
        .replace(/^Key|^Digit/, '')
        .replace(/^Arrow/, '')
        .replace(/(Left|Right)$/, ' $1');

    function render() {
        panel.innerHTML = `
        <h2>webdoom settings</h2>
        <table>
          ${ACTIONS.map(a => `
            <tr><td>${a.label}</td>
                <td><button class="bind" data-id="${a.id}">${keyName(s.binds[a.id])}</button></td></tr>
          `).join('')}
        </table>
        <label>Mouse sensitivity <input type="range" id="sens" min="1" max="12" step="1" value="${s.mouseSens}"></label>
        <label><input type="checkbox" id="mmove" ${s.mouseY === 'move' ? 'checked' : ''}> Mouse Y moves player (1993 style)</label>
        <label><input type="checkbox" id="arun" ${s.alwaysRun ? 'checked' : ''}> Always run</label>
        <label><input type="checkbox" id="smooth" ${s.smooth ? 'checked' : ''}> Smooth rendering (uncapped fps)</label>
        <label><input type="checkbox" id="opl3" ${s.opl3 ? 'checked' : ''}> OPL3 stereo music (18-voice; OPL2 mono is default)</label>
        <label>Gamepad turn speed <input type="range" id="pturn" min="0.4" max="2" step="0.1" value="${s.padTurnSpeed}"></label>
        <div class="row">
          <button id="reset">Reset defaults</button>
          <button id="close">Close (F8)</button>
        </div>`;

        panel.querySelectorAll('.bind').forEach(btn => {
            btn.onclick = () => {
                btn.textContent = 'press a key…';
                input.startCapture(btn.dataset.id, () => render());
            };
        });
        panel.querySelector('#sens').oninput = e => { s.mouseSens = +e.target.value; saveSettings(s); };
        panel.querySelector('#mmove').onchange = e => { s.mouseY = e.target.checked ? 'move' : 'off'; saveSettings(s); };
        panel.querySelector('#arun').onchange = e => { s.alwaysRun = e.target.checked; saveSettings(s); };
        panel.querySelector('#smooth').onchange = e => {
            s.smooth = e.target.checked;
            saveSettings(s);
            doom?._web_set_smooth(s.smooth ? 1 : 0);
        };
        panel.querySelector('#opl3').onchange = e => {
            s.opl3 = e.target.checked;
            saveSettings(s);
            doom?._web_set_opl_mode(s.opl3 ? 1 : 0);
        };
        panel.querySelector('#pturn').oninput = e => { s.padTurnSpeed = +e.target.value; saveSettings(s); };
        panel.querySelector('#reset').onclick = () => {
            Object.assign(s, defaultSettings());
            saveSettings(s);
            render();
        };
        panel.querySelector('#close').onclick = toggle;
    }

    function toggle() {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            document.exitPointerLock?.();
            render();
        } else {
            input.cancelCapture();
        }
    }

    window.addEventListener('keydown', e => {
        if (e.code === 'F8') { e.preventDefault(); toggle(); }
    }, true);

    return { toggle };
}
