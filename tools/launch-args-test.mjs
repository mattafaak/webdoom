#!/usr/bin/env node
// The lobby's settings reach the engine, and a hostile launch does not.
//
//   1. Set the RULES screen's options in a real lobby, start, and the launch
//      frame's params must become the matching engine arguments.
//   2. NO MONSTERS must change the world the engine builds from them.
//   3. A launch frame is server-controlled; params no server clamp can
//      produce must be refused before they reach the engine's argv parser,
//      which reads a value starting with '@' as a response file.
//
// usage: node tools/launch-args-test.mjs [--build-dir DIR]
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { root, sleep, buildDirArg } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

const { connectLobby, launchArgs } = await import(join(root, 'client/js/net.js'));

// 1. the RULES screen, through the real server
{
    const srv = await startServer({});
    const lobby = connectLobby(srv.ws);
    const launch = new Promise(res => lobby.on('launch', res));
    await sleep(300);
    lobby.setParams({ episode: 1, map: 2, skill: 4, mode: 'deathmatch', nomonsters: true, fast: true, respawn: true, timer: 10 });
    await sleep(200);
    lobby.start();
    const m = await launch;
    const args = launchArgs(m.params, false).join(' ');
    for (const want of ['-warp 1 2', '-skill 4', '-deathmatch', '-nomonsters', '-fast', '-respawn', '-timer 10'])
        check(`the lobby's settings reach the engine: ${want}`, args.includes(want), args);
    lobby.close();
    srv.stop();
}

// 2. NO MONSTERS changes the world (the state hash counts thinkers)
{
    const wad = loadWad('doom.wad');
    const hashAfter = async params => {
        const doom = await bootEngine(buildDirArg(), [['doomu.wad', wad]], {});
        doom.callMain([...launchArgs(params, false), '-nodraw']);
        doom._web_set_singletics(1);
        for (let i = 0; i < 3; i++) { doom._web_wipe_skip(); doom._web_frame(); }
        return doom._web_state_hash() >>> 0;
    };
    const base = { episode: 1, map: 1, skill: 3, mode: 'coop' };
    check('NO MONSTERS changes the world the engine builds',
          await hashAfter({ ...base, nomonsters: true }) !== await hashAfter(base));
}

// 3. hostile params are refused
const good = { episode: 1, map: 1, skill: 3, mode: 'coop' };
check('a legitimate launch is accepted', (() => { try { launchArgs(good, false); return true; } catch { return false; } })());
for (const [label, params, commercial] of [
    ['map "@x" (a response file to the engine)', { ...good, map: '@x' }, false],
    ['map "@x" in a MAP01-style game', { ...good, map: '@x' }, true],
    ['map "1" (a string)', { ...good, map: '1' }, false],
    ['map 40', { ...good, map: 40 }, true],
    ['episode 1e9', { ...good, episode: 1e9 }, false],
    ['skill 0', { ...good, skill: 0 }, false],
    ['skill "3"', { ...good, skill: '3' }, false],
    ['mode "evil"', { ...good, mode: 'evil' }, false],
    ['timer -5', { ...good, timer: -5 }, false],
    ['timer "10"', { ...good, timer: '10' }, false],
    ['no params at all', null, false],
]) {
    let threw = false;
    try { launchArgs(params, commercial); } catch { threw = true; }
    check(`a launch with ${label} is refused`, threw);
}

summary('launch arguments: the RULES reach the engine, hostile params never do');
