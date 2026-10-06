#!/usr/bin/env node
// tools/deploy.sh --check, against a stub systemctl, from temporary trees.
//
// deploy.sh decides three things before it would restart anything: whether
// the unit serves THIS checkout (it runs `node server/serve.js` from its own
// WorkingDirectory, wherever deploy.sh sits), whether the running process is
// older than the server code and package files, and who a restart would drop.
// Each is asserted here through --check only, which exits before the quick
// tier and before `systemctl restart`; the stub logs every systemctl call so
// a restart would show.  The trees hold a copy of deploy.sh and server/, so
// mtimes can be set without touching this checkout, and "who is connected"
// comes from a real server on a free port with a real seat, game and
// spectator.
//
// usage: node tools/deploy-check-test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync,
         chmodSync, symlinkSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { WebSocket, open, lobbyJoin, onceMsg } from './lib/ws.mjs';
import { check, summary } from './lib/report.mjs';

const base = mkdtempSync(join(tmpdir(), 'webdoom-deploy-'));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

const bin = join(base, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'systemctl'), `#!/bin/bash
echo "$*" >> "$STUB_LOG"
case "$1" in
    is-active) exit 0 ;;
    show) case "$*" in
              *WorkingDirectory*) echo "$STUB_WD" ;;
              *ActiveEnterTimestamp*) echo "@$STUB_STARTED" ;;
          esac ;;
esac
exit 0
`);
chmodSync(join(bin, 'systemctl'), 0o755);

function tree(name) {
    const t = join(base, name);
    mkdirSync(join(t, 'tools'), { recursive: true });
    mkdirSync(join(t, 'server'));
    copyFileSync(join(root, 'tools/deploy.sh'), join(t, 'tools/deploy.sh'));
    for (const f of readdirSync(join(root, 'server')).filter(f => /\.(js|json)$/.test(f)))
        copyFileSync(join(root, 'server', f), join(t, 'server', f));
    return t;
}
const touch = (file, s) => utimesSync(file, s, s);
const now = () => Math.floor(Date.now() / 1000);

let run = 0;
function deployCheck(t, { wd, started, port }) {
    const log = join(base, `systemctl-${++run}.log`);
    const r = spawnSync('bash', [join(t, 'tools/deploy.sh'), '--check'], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log,
               STUB_WD: wd, STUB_STARTED: String(started), DOOM_PORT: String(port) },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { rc: r.status, out: `${r.stdout}${r.stderr}`, restarted: /^restart/m.test(calls) };
}

let statusHits = 0;
const srv = await startServer({ env: { LOG_REQUESTS: '1' },
                                onStderr: t => { statusHits += (t.match(/^GET \/api\/status /gm) ?? []).length; } });
const here = tree('here');
const elsewhere = tree('elsewhere');
symlinkSync(here, join(base, 'here-link'));

// ── 1. a unit serving another checkout ───────────────────────────────────────
{
    const hits = statusHits;
    const r = deployCheck(here, { wd: elsewhere, started: now() + 3600, port: srv.port });
    await sleep(300);       // spawnSync held this event loop: let the server's log line arrive
    check('another checkout: refused, naming the WorkingDirectory it serves',
          r.rc !== 0 && /REFUSING — webdoom\.service serves WorkingDirectory=/.test(r.out),
          `rc=${r.rc}: ${r.out.trim().split('\n')[0]}`);
    check('another checkout: refused before asking who is connected', statusHits === hits,
          `${statusHits - hits} /api/status request(s)`);
    check('another checkout: nothing restarted', !r.restarted, r.restarted ? 'systemctl restart was called' : 'no restart');
}

// ── 2. the package files count as server code ────────────────────────────────
{
    const old = now() - 7200;
    for (const f of readdirSync(join(here, 'server'))) touch(join(here, 'server', f), old);
    const fresh = deployCheck(here, { wd: here, started: now() - 3600, port: srv.port });
    check('CONTROL: an unchanged tree reads fresh', fresh.rc === 0 && /fresh:/.test(fresh.out),
          `rc=${fresh.rc}: ${fresh.out.trim().split('\n')[0]}`);
    touch(join(here, 'server/package-lock.json'), now());
    const stale = deployCheck(here, { wd: here, started: now() - 3600, port: srv.port });
    check('package-lock.json newer than the running service reads STALE',
          stale.rc !== 0 && /STALE:/.test(stale.out), `rc=${stale.rc}: ${stale.out.trim().split('\n')[0]}`);
    check('package files: nothing restarted', !fresh.restarted && !stale.restarted, 'no restart');
}

// ── 3. who a restart would drop: a game, a lobby seat, a spectator ───────────
{
    const lob = lobbyJoin(srv.ws);
    await open(lob);
    await onceMsg(lob, m => m.t === 'welcome');
    lob.send(JSON.stringify({ t: 'start' }));
    await onceMsg(lob, m => m.t === 'launch');
    const spec = new WebSocket(`${srv.ws}/ws/spectate`);
    await open(spec);
    await sleep(200);
    // reached through a symlink: the same tree, resolved
    const r = deployCheck(join(base, 'here-link'), { wd: here, started: now() + 3600, port: srv.port });
    check('this checkout, through a symlink: not refused', r.rc === 0 && !/REFUSING/.test(r.out),
          `rc=${r.rc}: ${r.out.trim().split('\n')[0]}`);
    check('who would be dropped counts the game, the lobby and the spectator',
          /a restart now would drop: 1 in a game, 1 in the lobby, 1 spectating/.test(r.out),
          r.out.split('\n').find(l => /would drop|live:/.test(l))?.trim() ?? '(no such line)');
    check('connected: nothing restarted', !r.restarted, 'no restart');
    spec.close();
    lob.close();
}

srv.stop();
summary('deploy.sh --check: refuses another checkout, sees package files, counts everyone connected');
