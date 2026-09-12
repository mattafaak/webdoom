#!/usr/bin/env node
// tools/gm-config-test.mjs — the operator path for the GM backend (task 25.1).
//
// WHAT WAS WRONG
// --------------
// docs/decision-17.2a Decision 5 says: "The internal routing in audio.js accepts
// a setGmMode(enabled, soundfontUrl) call (for 17.2b to wire)".  17.2b wired the
// backend PICKER (settings.js, now the OPTIONS screen) and the SOUNDFONT
// BYTES (lobby.js), but never the
// third parameter.  No caller passed a SpessaSynth URL, so gmSpessaSynthUrl was
// permanently null, arm() always took the SKIP branch, and the GM backend --
// which spec.md's music contract and two decision records present as delivered
// -- could not activate under any configuration.  The suite did not catch it
// because browser-sf2-test gate [5] deliberately asserts that fallback.
//
// WHAT THIS GATES, AND WHAT IT DOES NOT
// -------------------------------------
// GATES: the operator configuration path exists and is served correctly —
// /api/config reports the URL from WEBDOOM_SPESSASYNTH_URL, and null when unset.
// That is the link that was missing.
//
// DOES NOT GATE: that SpessaSynth then loads and produces audible GM.  It cannot:
// decision-17.2a Decision 1 keeps SpessaSynth OUT of this repository and out of
// package.json on purpose (operator-hosted, never a CDN), so there is nothing
// for a test to load.  The browser side is covered by browser-sf2-test gate [5]
// (the unconfigured fallback) and by inspection of audio.js's arm().  An
// end-to-end activation test would require vendoring the dependency the project
// deliberately does not vendor, so it is not written rather than faked.
//
// usage: node tools/gm-config-test.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withServer(port, env, fn) {
    const srv = spawn('node', [join(root, 'server/serve.js')], {
        env: { ...process.env, DOOM_PORT: String(port), DOOM_HOST: '127.0.0.1', ...env },
        stdio: 'ignore',
    });
    try {
        for (let i = 0; i < 80; i++) {
            try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await sleep(50); }
        }
        return await fn(`http://127.0.0.1:${port}`);
    } finally { srv.kill(); }
}

let passes = 0, failures = 0;
const ok = (name, good, detail = '') => {
    console.log(`  ${good ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    good ? passes++ : failures++;
};

const URL_A = 'https://music.example.invalid/spessasynth/index.js';

await withServer(8941, {}, async base => {
    const r = await fetch(`${base}/api/config`);
    ok('/api/config responds', r.ok, `HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    ok('unset  -> spessaSynthUrl is null', j !== null && j.spessaSynthUrl === null,
       `got ${JSON.stringify(j)}`);
});

await withServer(8942, { WEBDOOM_SPESSASYNTH_URL: URL_A }, async base => {
    const j = await (await fetch(`${base}/api/config`)).json().catch(() => null);
    ok('configured -> the operator URL is served', j?.spessaSynthUrl === URL_A,
       `got ${JSON.stringify(j)}`);
});

// The client reads this endpoint in audio.js arm().  Assert the contract it
// depends on rather than the fetch itself: a payload shape change here would
// silently return the backend to the state this task fixed.
await withServer(8943, { WEBDOOM_SPESSASYNTH_URL: URL_A }, async base => {
    const j = await (await fetch(`${base}/api/config`)).json().catch(() => null);
    ok('payload is a flat object with the key audio.js reads',
       j !== null && typeof j === 'object' && !Array.isArray(j) && 'spessaSynthUrl' in j,
       `keys: ${j ? Object.keys(j).join(',') : 'n/a'}`);
});

const EXPECTED = 4;
console.log(`\n  ${passes} passed, ${failures} failed`);
if (failures) { console.log(`FAIL gm-config-test: ${failures} check(s)`); process.exit(1); }
if (passes !== EXPECTED) {
    console.log(`FAIL gm-config-test: ran ${passes} of ${EXPECTED} checks — not a pass`);
    process.exit(1);
}
console.log(`PASS — gm-config-test: the GM operator configuration path is served (${passes} checks)`);
