// Start a webdoom server for a test and wait until it answers.  Readiness is
// an HTTP poll with a timeout, never a fixed sleep; a port is allocated unless
// given, so an orphan from an earlier run cannot be mistaken for this one.
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root, sleep, freePort } from './util.mjs';

// Who is actually listening on this port?  A free port plus a readiness poll
// still cannot tell THIS server from one that raced in ahead of it, and that
// is the 12.2b lesson: a stale server answers just as well and serves a
// different build.  run-tests.sh has asserted ownership since round 4
// (assert_port_owned); the shared helper did not, so every leg on it was one
// race away from measuring somebody else.  No `ss` means "could not verify",
// which is said out loud rather than passed over -- an unverifiable check that
// looks like a passing one is the shape this project keeps naming.
function assertOwned(port, pid) {
    let out;
    try { out = execFileSync('ss', ['-tlnpH', `sport = :${port}`], { encoding: 'utf8' }); }
    catch { return `port ${port} ownership NOT verified (ss unavailable)`; }
    const owner = /pid=(\d+)/.exec(out)?.[1];
    if (!owner) throw new Error(`port ${port}: ss sees no listener, but the server just answered on it`);
    if (owner !== String(pid))
        throw new Error(`port ${port} is held by pid ${owner}, not the server we started (pid ${pid}) — ` +
                        `a foreign or orphaned server would have been tested instead of this build`);
    return null;
}

export async function startServer({ port = null, env = {}, servePath = join(root, 'server/serve.js'),
                                     onStderr = null, onStdout = null, readyMs = 15000 } = {}) {
    port ??= await freePort();
    const proc = spawn('node', [servePath], {
        env: { ...process.env, DOOM_PORT: String(port), DOOM_HOST: '127.0.0.1', ...env },
        stdio: ['ignore', onStdout ? 'pipe' : 'ignore', onStderr ? 'pipe' : 'ignore'],
    });
    if (onStdout) proc.stdout.on('data', d => onStdout(String(d)));
    if (onStderr) proc.stderr.on('data', d => onStderr(String(d)));
    let stopping = false;
    proc.on('exit', (code, sig) => {
        if (!stopping && code !== null && code !== 0) {
            console.error(`FAIL: server exited unexpectedly (code ${code} sig ${sig})`);
            process.exitCode = 1;
        }
    });
    const stop = () => { stopping = true; try { proc.kill(); } catch { /* gone */ } };
    process.on('exit', stop);

    const deadline = Date.now() + readyMs;
    for (;;) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/api/wads`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) break;
        } catch { /* not yet */ }
        if (proc.exitCode !== null) throw new Error(`server exited during startup (code ${proc.exitCode})`);
        if (Date.now() > deadline) { stop(); throw new Error(`server on ${port} not ready in ${readyMs} ms`); }
        await sleep(150);
    }
    let note = null;
    try { note = assertOwned(port, proc.pid); }
    catch (e) { stop(); throw e; }
    return { proc, port, note, url: `http://127.0.0.1:${port}/`, ws: `ws://127.0.0.1:${port}`, stop };
}
