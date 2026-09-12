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
import { mkdtempSync, rmSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
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

const profiles = [];

// A private profile directory, as a ready-to-splice Chrome flag.  Removed by
// reapOnExit(), or by the exit hook below if the leg never calls it.
export function chromeProfileArg() {
    const dir = mkdtempSync(join(tmpdir(), 'webdoom-chrome-'));
    profiles.push(dir);
    return `--user-data-dir=${dir}`;
}

function rmProfiles() {
    while (profiles.length) {
        const d = profiles.pop();
        try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
}

// Kill this Chrome and its helpers, and clean the profile, however the leg ends:
// normal exit, an uncaught throw, or the runner terminating it.
//
// The group kill matters because Chrome forks a zygote, a GPU process and a
// renderer per tab; killing the top pid alone leaves them, which is the shape
// that fills /tmp.  tools/n64/run-n64-demos.sh learned the identical lesson
// about ares and says so in its own comment -- killing $ARES_PID alone is NOT
// enough, observed rather than assumed.  Requires `detached: true` on the spawn.
export function reapOnExit(child) {
    let dead = false;
    const kill = () => {
        if (dead) return;
        dead = true;
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { try { child.kill(); } catch { /* already gone */ } }
        rmProfiles();
    };
    process.on('exit', kill);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => { kill(); process.exit(130); });
    }
    return kill;
}
