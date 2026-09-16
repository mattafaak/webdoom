// One verdict idiom for every tool: check() counts, summary() prints the
// PASS/FAIL line the suite runner quotes, and a test that never reaches
// summary() fails from the exit hook -- an uncaughtException handler
// otherwise lets a test give up and exit 0.
let passes = 0, fails = 0, printed = false;

export function check(label, ok, detail = '') {
    if (ok) { passes++; console.log(`  PASS  ${label}`); }
    else    { fails++; console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`); }
    return !!ok;
}
export const pass = label => check(label, true);
export const counts = () => ({ passes, fails });

// The sanctioned end: prints the summary and the verdict line, sets the exit
// code, returns whether everything passed.  `what` is the one-line headline
// the suite table shows.
export function summary(what) {
    printed = true;
    console.log(`  ${passes} passed, ${fails} failed`);
    console.log(`${fails ? 'FAIL' : 'PASS'} — ${what}`);
    process.exitCode = fails ? 1 : 0;
    return fails === 0;
}

// Fail fast with a reason; also a sanctioned end.
export function fatal(msg, cleanup = null) {
    printed = true;
    console.error(`FAIL: ${msg}`);
    try { cleanup?.(); } catch { /* best effort */ }
    process.exit(1);
}

process.on('exit', code => {
    if (!printed && code === 0) {
        console.log('FAIL — the test ended without printing its summary (an uncaught error, or a missing summary() call)');
        process.exitCode = 1;
    }
});
