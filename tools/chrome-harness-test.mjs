// tools/chrome-harness-test.mjs — a leg that launches Chrome leaves nothing in
// the temp directory, and a launch sweeps what earlier legs left behind.
//
// Each case runs a child node process with TMPDIR pointed at a fresh directory
// of its own, so node's tmpdir() and Chrome's temp dir both land there and
// nothing a parallel leg writes into the shared /tmp can be counted against
// it.  The child launches Chrome through tools/lib/cdp.mjs, opens about:blank
// and exits the way every leg does (process.exit after its summary).  The
// parent waits for Chrome's whole process group to be gone -- a profile that
// reappears after a premature rm is the leak this exists to catch -- and then
// reads the directory.
//
// The per-case directories sit directly under tmpdir() rather than anywhere
// deeper: Chrome aborts when its singleton socket path passes 107 bytes, and
// that path is built under TMPDIR.
//
// usage: node tools/chrome-harness-test.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './lib/util.mjs';

const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === '--child') {
    const { launchChrome } = await import('./lib/cdp.mjs');
    const chrome = await launchChrome();
    const tab = await chrome.tab('about:blank');
    if (process.argv[3] === 'two') {
        // browser-fire's shape: a second Chrome, killed while the first runs on
        const other = await launchChrome();
        await (await other.tab('about:blank')).ev('1');
        console.log(`OTHER_PID ${other.proc.pid}`);
        other.kill();
        const left = readdirSync(tmpdir()).filter(n => n.startsWith('webdoom-chrome-')).length;
        console.log(`PROFILES_AFTER_KILL ${left}`);
    }
    const two = await tab.ev('1 + 1');
    console.log(`CHROME_PID ${chrome.proc.pid} EVAL ${two}`);
    process.exit(0);
}

const { check, summary } = await import('./lib/report.mjs');
const LAUNCHES = 3;
const base = mkdtempSync(join(tmpdir(), 'wdch-'));
const cleanup = () => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } };
process.on('exit', cleanup);

// every path under dir, relative to it
function walk(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        out.push(relative(dir, p));
        if (e.isDirectory() && !e.isSymbolicLink()) out.push(...walk(p).map(q => join(e.name, q)));
    }
    return out;
}

const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Run one child with TMPDIR=dir; resolve with Chrome's pid once the child has
// exited and Chrome's process group is gone (or 15 s have passed).
async function runChild(dir, mode = 'one') {
    const child = spawn(process.execPath, [SELF, '--child', mode], {
        env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    // SIGTERM, not SIGKILL: the child's own handler then reaps its Chrome
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    const code = await new Promise(res => child.on('exit', c => res(c)));
    clearTimeout(timer);
    const m = /CHROME_PID (\d+) EVAL 2/.exec(out);
    if (!m) return { ok: false, code, out };
    const pids = [+m[1], ...[...out.matchAll(/OTHER_PID (\d+)/g)].map(o => +o[1])];
    const deadline = Date.now() + 15000;
    while (pids.some(groupAlive) && Date.now() < deadline) await sleep(100);
    const lingered = pids.some(groupAlive);
    if (lingered) {
        for (const pid of pids) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
        await sleep(500);
    }
    return { ok: code === 0, code, out, lingered };
}

// The paths left under dir, counted the way the summary reports them.
function leftovers(dir) {
    const left = walk(dir);
    return {
        left,
        profiles: readdirSync(dir).filter(n => n.startsWith('webdoom-chrome-')).length,
        singleton: left.filter(p => /^\.?com\.google\.Chrome\./.test(basename(p))).length,
    };
}
const describe = ({ left, profiles, singleton }) =>
    `${left.length} entries left (${profiles} webdoom-chrome-*, ${singleton} com.google.Chrome.*): ${left.slice(0, 6).join(', ')}`;

// ── 1. a normal exit leaves the temp directory empty ─────────────────────────
let leftProfiles = 0, leftSingleton = 0, leftEntries = 0, launched = 0;
for (let i = 0; i < LAUNCHES; i++) {
    const dir = join(base, `a${i}`);
    mkdirSync(dir);
    const r = await runChild(dir);
    if (!check(`launch ${i + 1}: Chrome answered and the child exited 0`, r.ok, `exit ${r.code}: ${r.out.trim().split('\n').slice(-3).join(' | ')}`)) continue;
    launched++;
    check(`launch ${i + 1}: Chrome's process group exited after the leg did`, !r.lingered);
    const l = leftovers(dir);
    leftProfiles += l.profiles; leftSingleton += l.singleton; leftEntries += l.left.length;
    check(`launch ${i + 1}: its TMPDIR is empty once Chrome is gone`, l.left.length === 0, describe(l));
}

// ── 2. killing one of two Chromes leaves the other's profile alone ──────────
{
    const dir = join(base, 'two');
    mkdirSync(dir);
    const r = await runChild(dir, 'two');
    if (check('two Chromes: both answered and the child exited 0', r.ok, `exit ${r.code}: ${r.out.trim().split('\n').slice(-3).join(' | ')}`)) {
        launched += 2;
        const after = /PROFILES_AFTER_KILL (\d+)/.exec(r.out)?.[1];
        check('two Chromes: killing one removes only its own profile', after === '1', `${after} profiles left while the other Chrome ran`);
        check("two Chromes: both process groups exited after the leg did", !r.lingered);
        const l = leftovers(dir);
        leftProfiles += l.profiles; leftSingleton += l.singleton; leftEntries += l.left.length;
        check('two Chromes: the TMPDIR is empty once both are gone', l.left.length === 0, describe(l));
    }
}
console.log(`  ${launched} launches: ${leftProfiles} webdoom-chrome-* and ${leftSingleton} com.google.Chrome.* entries left, ${leftEntries} paths in all`);

// ── 3. a launch sweeps only what is stale ────────────────────────────────────
// Stale: a lock naming a dead pid, or no lock and older than 30 minutes.  Kept:
// a lock naming a live pid however old the dir is (a long leg), a lockless dir
// that is recent (a parallel leg between mkdtemp and Chrome writing its lock),
// and anything not named webdoom-chrome-* (not ours to judge).
const sweepDir = join(base, 'b');
mkdirSync(sweepDir);
const twoHoursAgo = Date.now() / 1000 - 7200;
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
const seed = (name, { lockPid = null, old = false } = {}) => {
    const d = join(sweepDir, name);
    mkdirSync(join(d, 'Default'), { recursive: true });
    writeFileSync(join(d, 'Default', 'Preferences'), '{}');
    if (lockPid !== null) symlinkSync(`${hostname()}-${lockPid}`, join(d, 'SingletonLock'));
    if (old) utimesSync(d, twoHoursAgo, twoHoursAgo);
    return d;
};
const staleOld  = seed('webdoom-chrome-staleold', { old: true });
const staleDead = seed('webdoom-chrome-staledead', { lockPid: deadPid });
const live      = seed('webdoom-chrome-livelock', { lockPid: process.pid, old: true });
const fresh     = seed('webdoom-chrome-freshnolock');
const foreign   = seed('com.google.Chrome.foreign', { old: true });
const r = await runChild(sweepDir);
check('sweep launch: Chrome answered and the child exited 0', r.ok, `exit ${r.code}: ${r.out.trim().split('\n').slice(-3).join(' | ')}`);
const removed = [
    check('sweep: a lockless profile 2 h old is removed', !existsSync(staleOld)),
    check(`sweep: a profile whose lock names a dead pid (${deadPid}) is removed`, !existsSync(staleDead)),
].filter(Boolean).length;
const kept = [
    check('sweep: a profile whose lock names a live pid is kept, though 2 h old', existsSync(live)),
    check('sweep: a lockless profile made just now is kept (a parallel leg starting up)', existsSync(fresh)),
    check('sweep: a directory not named webdoom-chrome-* is never touched', existsSync(foreign)),
].filter(Boolean).length;
const want = ['com.google.Chrome.foreign', 'webdoom-chrome-freshnolock', 'webdoom-chrome-livelock'];
const rest = walk(sweepDir).filter(p => !want.some(w => p === w || p.startsWith(`${w}/`)));
check('sweep: nothing else is left once Chrome is gone', rest.length === 0, rest.join(', '));

summary(`chrome-harness: ${launched} launches left ${leftEntries} temp paths; the sweep removed ${removed} of 2 stale dirs and kept ${kept} of the 3 it must keep`,
    { min: 3 * LAUNCHES + 4 + 7 });
process.exit();
