#!/usr/bin/env node
// tools/firefox-smoke.mjs — Firefox loads the page and executes JS.
//
// Asserts, from the server's own request log:
//   (1) a Firefox UA fetched something (the page HTML parsed)
//   (2) /api/wads was requested (lobby.js ran — JS executed)
// It does NOT assert that a frame rendered.  That is the `firefox-frame` leg's
// job (round 8): Firefox 155 serves WebDriver BiDi rather than CDP, which is
// enough to drive it without geckodriver.  This leg stays because it is the
// cheap one -- no Xvfb, no WebGL, ~12 s -- and it still covers the case where
// the page loads but nothing renders.
//
// Was a shell script (round 11 converted it).  It owned port 8675 and its own
// spawn/curl-poll/fail-closed block, a third copy of the runner's -- and the
// comment in it admitted the gap: "the two files that own their own ports and
// never took the runner's assert_port_owned".  tools/lib/server.mjs allocates a
// free port, polls it ready, and asserts the listener is the process it
// started, so the copy and the fixed port both go.
//
// The awk counting from the shell version is kept in spirit: `grep -c` prints 0
// AND exits 1 when nothing matches, so `$(grep -c X f || echo 0)` used to fire
// the fallback IN ADDITION to grep's own output and produce the two-line string
// "0\n0".  Counting here is a filter over captured lines, which cannot do that.
//
// usage: node tools/firefox-smoke.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './lib/server.mjs';
import { sleep } from './lib/util.mjs';

const FF = process.env.FIREFOX_BIN ?? 'firefox';
const reqs = [];
const srv = await startServer({
    env: { LOG_REQUESTS: '1' },
    onStderr: t => { for (const line of t.split('\n')) if (line.trim()) reqs.push(line); },
});

const profile = mkdtempSync(join(tmpdir(), 'ff-profile-'));
const done = () => { try { srv.stop(); } catch { /* gone */ } rmSync(profile, { recursive: true, force: true }); };

// Let Firefox execute JS for a few seconds, then kill it.  No screenshot: the
// service-worker registration and the /api/wads fetch are async and must land
// before the process exits.
const ff = spawn(FF, ['--headless', '--no-remote', '--profile', profile, srv.url],
                 { stdio: 'ignore', detached: true });
await sleep(11000);
try { process.kill(-ff.pid, 'SIGKILL'); } catch { try { ff.kill('SIGKILL'); } catch { /* gone */ } }
await sleep(1000);   // let in-flight requests land in the log

const ua   = reqs.filter(l => /Firefox\//.test(l)).length;
const wads = reqs.filter(l => l.includes('/api/wads')).length;
console.log(`  Firefox UA requests: ${ua}   /api/wads requests: ${wads}`);
done();

if (ua > 0 && wads > 0) {
    console.log(`PASS firefox smoke: Firefox UA confirmed, JS executed (${ua} UA hits, ${wads} /api/wads)`);
    process.exit(0);
}
console.log(`FAIL firefox smoke: Firefox UA=${ua} /api/wads=${wads} (expected both > 0)`);
process.exit(1);
