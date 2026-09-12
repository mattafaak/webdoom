#!/usr/bin/env node
// The in-heap file registry's bound, and the constant that states it twice.
//
// web_register_file() used to return void and no-op silently at MAXWEBFILES,
// which W_WebFile could not see: every later lookup of that name missed,
// malloc'd the file again, failed to register it again, and leaked.  It returns
// 1/0 now, W_WebFile frees and returns NULL on a refusal, and web.h says so.
//
// MAXWEBFILES is also written twice -- engine/web/files.c and client/js/lobby.js
// -- and the client caps its manifest with its copy.  A mirror that is asserted
// is a mirror; one that is not is two constants that happen to agree today.
//
// usage: node tools/web-registry-test.mjs [build-dir]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = process.argv[2] ?? 'build';

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};

// ── the mirrored constant ────────────────────────────────────────────────────
const cSrc = readFileSync(join(root, 'engine/web/files.c'), 'utf8');
const jsSrc = readFileSync(join(root, 'client/js/lobby.js'), 'utf8');
const cMax = Number((/#define\s+MAXWEBFILES\s+(\d+)/.exec(cSrc) ?? [])[1]);
const jsMax = Number((/const\s+MAXWEBFILES\s*=\s*(\d+)/.exec(jsSrc) ?? [])[1]);
check('MAXWEBFILES is readable on both sides of the wire',
    Number.isInteger(cMax) && Number.isInteger(jsMax),
    `files.c=${cMax} lobby.js=${jsMax}`);
check('the two copies of MAXWEBFILES agree', cMax === jsMax, `${cMax} vs ${jsMax}`);

// ── the registry itself ──────────────────────────────────────────────────────
const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;
const doom = await createDoom({ print: () => {}, printErr: () => {}, onDoomError: () => {} });
const reg = (name, bytes) => {
    const p = doom._malloc(bytes.length);
    doom.HEAPU8.set(bytes, p);
    return doom.ccall('web_register_file', 'number', ['string', 'number', 'number'],
        [name, p, bytes.length]);
};
const one = new Uint8Array([1, 2, 3, 4]);

let accepted = 0;
for (let i = 0; i < cMax; i++) accepted += reg(`f${i}.lmp`, one);
check(`the registry accepts exactly its declared capacity`,
    accepted === cMax, `${accepted} of ${cMax} accepted`);

const over = reg('one-too-many.lmp', one);
check('the file past the cap is refused, not silently dropped',
    over === 0, `web_register_file returned ${over}`);

// The leak was a REPEAT: the same name retried and re-malloc'd every time.
// The refusal has to be stable, or a caller that retries is back where it was.
const again = [reg('one-too-many.lmp', one), reg('one-too-many.lmp', one)];
check('the refusal is stable across retries',
    again.every(r => r === 0), `retries returned ${again.join(', ')}`);

if (results.length < 5) { console.log('FAIL — the suite did not complete'); process.exit(1); }
const bad = results.filter(r => !r.ok);
console.log(bad.length
    ? `FAIL — web-registry: ${bad.length} of ${results.length} assertions failed`
    : `PASS — web-registry: ${results.length} assertions, registry capacity ${cMax} enforced and mirrored`);
process.exit(bad.length ? 1 : 0);
