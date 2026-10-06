// tools/chrome-harness.mjs — the three things every CDP leg got wrong.
//
// WHY THIS EXISTS
// ---------------
// Twenty-one legs launch headless Chrome, and they disagreed about everything
// that matters. Surveyed at HEAD before this file landed:
//
//   * CHROME_BIN honoured by 6 of 21.  The other 15 hardcoded
//     spawn('google-chrome-stable', ...) while run-tests.sh's have_browser()
//     probe DID honour CHROME_BIN, and also fell back to
//     /opt/google/chrome/chrome.  So the probe and the legs could disagree in
//     both directions.  Observed directly: with CHROME_BIN=/nonexistent the
//     prerequisite passed (because /opt/google/chrome/chrome exists here) and
//     then browser-sp and persist PASSED while browser-qol and browser-teardown
//     died `spawn /nonexistent-chrome ENOENT` -- in one run, from one cause.
//
//   * --user-data-dir set by 6 of 21.  The other 15 shared Chrome's DEFAULT
//     profile, so localStorage, IndexedDB and service-worker caches persisted
//     across legs within a single suite run -- and persist-test.mjs asserts
//     over exactly that state.  (browser-qol-test.mjs did too, until the QoL
//     overlays it covered were deleted.)
//
//   * exit/SIGINT/SIGTERM handlers registered by 7 of 21.  README names
//     orphaned Chrome processes exhausting /tmp as the original cause of the
//     browser-lobby T07 flake, and run-tests.sh's EXIT trap reaps only the
//     servers it started, never Chrome.
//
// The helpers are deliberately small and composable rather than one
// launchChrome() that owns the spawn: the legs' argument lists genuinely differ
// (host-resolver rules, background-throttling flags, window sizes), and
// rewriting twenty-one call sites into one signature would have been a much
// larger change to prove correct than the defects justify.
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { mkdtempSync, rmSync, accessSync, constants, readdirSync, readlinkSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

// The same resolution order run-tests.sh's have_browser() uses, so the
// prerequisite probe and the thing it is a probe FOR cannot disagree.
export function chromeBin() {
    // CHROME_BIN, when set, is the ONLY answer -- as it is for the probe now.
    // Falling back past an explicit CHROME_BIN is what let have_browser() say
    // yes (via /opt) while the legs spawned the missing binary and died.
    if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
    for (const dir of (process.env.PATH ?? '').split(':')) {
        if (!dir) continue;
        try { accessSync(join(dir, 'google-chrome-stable'), constants.X_OK); return 'google-chrome-stable'; }
        catch { /* next PATH entry */ }
    }
    try { accessSync('/opt/google/chrome/chrome', constants.X_OK); return '/opt/google/chrome/chrome'; }
    catch { /* fall through */ }
    return 'google-chrome-stable';   // let spawn produce the honest ENOENT
}

// Profiles made but not yet handed to a reapOnExit(): removed at exit.  Each
// reaper removes its own, after its Chrome has exited.
const unowned = new Set();
process.on('exit', () => { for (const d of unowned) rmProfile(d); });
const PREFIX = 'webdoom-chrome-';
// The rm runs once the profile's Chrome has exited.  The retries cover the
// case where that could not be confirmed (no /proc, or a group still dying
// after SIGKILL's wait) and a last write lands mid-rm (ENOTEMPTY).
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
// A profile with no SingletonLock this old is no live leg's: Chrome holds the
// lock for as long as it runs, and a leg starting up writes one within seconds.
const STALE_MS = 30 * 60 * 1000;
// sun_path is 108 bytes with its NUL.  Chrome aborts at startup ("Socket path
// too long") when TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket is longer.
const SOCKET_PATH_MAX = 107;

// A private profile directory, and the same directory as a ready-to-splice
// Chrome flag.  Spawn Chrome with TMPDIR=dir: Chrome leaves four entries under
// TMPDIR per launch and never removes them (a com.google.Chrome.XXXXXX
// directory holding SingletonSocket and SingletonCookie, a url_fetcher
// directory and two .com.google.Chrome.* files), so pointing TMPDIR into the
// profile makes one rm take them too.  Removed by reapOnExit(child, dir), or
// at exit if no reaper ever owns it.  Every call first sweeps the profiles
// earlier legs left behind.
export function chromeProfile() {
    const socket = join(tmpdir(), `${PREFIX}XXXXXX`, 'com.google.Chrome.XXXXXX', 'SingletonSocket');
    if (Buffer.byteLength(socket) > SOCKET_PATH_MAX)
        throw new Error(`tmpdir() is too long for Chrome: its singleton socket would be ${socket} (over ${SOCKET_PATH_MAX} bytes); set TMPDIR shorter`);
    sweepStaleProfiles();
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    unowned.add(dir);
    return { dir, arg: `--user-data-dir=${dir}` };
}

// Whether the SingletonLock in a profile names a live Chrome: true, false, or
// null when there is no lock.  The lock is a symlink to "<host>-<pid>".  A lock
// that cannot be parsed, or that names another host, is not ours to judge and
// counts as live.
function lockAlive(dir) {
    let target;
    try { target = readlinkSync(join(dir, 'SingletonLock')); } catch { return null; }
    const m = /^(.*)-(\d+)$/.exec(target);
    if (!m || m[1] !== hostname()) return true;
    try { process.kill(+m[2], 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

// Remove the webdoom-chrome-* profiles in tmpdir() that no leg can still be
// using: the lock names a dead pid, or there is no lock and the directory is
// older than STALE_MS.  Legs run in parallel, so a live lock or a recent
// lockless directory (a leg between mkdtemp and Chrome taking its lock) is
// always kept.  Returns how many were removed.
export function sweepStaleProfiles(dir = tmpdir(), now = Date.now()) {
    let names;
    try { names = readdirSync(dir); } catch { return 0; }
    let swept = 0;
    for (const name of names) {
        if (!name.startsWith(PREFIX)) continue;
        const p = join(dir, name);
        const alive = lockAlive(p);
        if (alive) continue;
        if (alive === null) {
            let st;
            try { st = lstatSync(p); } catch { continue; }
            if (!st.isDirectory() || now - st.mtimeMs < STALE_MS) continue;
        }
        try { rmSync(p, RM); swept++; } catch { /* another sweep, or its owner, got there first */ }
    }
    return swept;
}

function rmProfile(dir) {
    unowned.delete(dir);
    try { rmSync(dir, RM); } catch { /* left for the next launch's sweep */ }
}

// Members of process group `pgid` that have not exited.  An exited member stays
// a zombie until node reaps it, which only the event loop does, and the exit
// hook runs where the loop never turns again -- so kill(-pgid, 0) would call
// the group alive for as long as we waited.  /proc's state field tells the two
// apart.  No /proc reads as none left, and the wait below is skipped.
function liveMembers(pgid) {
    let n = 0, pids;
    try { pids = readdirSync('/proc'); } catch { return 0; }
    for (const p of pids) {
        if (!/^\d/.test(p)) continue;
        let stat;
        try { stat = readFileSync(`/proc/${p}/stat`, 'latin1'); } catch { continue; }
        // after the parenthesised comm: state ppid pgrp ...
        const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (+pgrp === pgid && state !== 'Z' && state !== 'X') n++;
    }
    return n;
}

// Block until the group has exited or `ms` has passed; true when it exited.
// Synchronous on purpose: the exit hook cannot await.
function waitGroupExit(pgid, ms) {
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (const deadline = Date.now() + ms; liveMembers(pgid); ) {
        if (Date.now() > deadline) return false;
        Atomics.wait(nap, 0, 0, 20);
    }
    return true;
}

// Kill this Chrome and its helpers, and clean its profile, however the leg
// ends: normal exit, an uncaught throw, or the runner terminating it.
//
// The group kill matters because Chrome forks a zygote, a GPU process and a
// renderer per tab; killing the top pid alone leaves them, which is the shape
// that fills /tmp.  tools/n64/run-n64-demos.sh learned the identical lesson
// about ares and says so in its own comment -- killing $ARES_PID alone is NOT
// enough, observed rather than assumed.  Requires `detached: true` on the spawn.
//
// The profile is removed only after the group has exited.  SIGTERM starts a
// shutdown that keeps writing the profile (Local State, component updates)
// after the signal returns, so an rm issued at once either fails ENOTEMPTY or
// finishes before the directory is written again: the profile leaks either way.
// A Chrome that has not exited in 5 s is killed outright.  Only this Chrome's
// own profile is removed; another Chrome the leg launched is still using its.
export function reapOnExit(child, dir = null) {
    if (dir) unowned.delete(dir);
    let dead = false;
    const signal = sig => {
        try { process.kill(-child.pid, sig); }
        catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const kill = () => {
        if (dead) return;
        dead = true;
        signal('SIGTERM');
        if (child.pid && !waitGroupExit(child.pid, 5000)) {
            signal('SIGKILL');
            waitGroupExit(child.pid, 2000);
        }
        if (dir) rmProfile(dir);
    };
    process.on('exit', kill);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => { kill(); process.exit(130); });
    }
    return kill;
}
