#!/usr/bin/env node
// The in-heap file registry's bound.  web_register_file() returns 1/0, and
// W_WebFile frees and returns NULL on a refusal, so a lookup that cannot
// register does not re-read and leak the file on every retry.  The registry
// holds one session's stack and small files; it is not the WAD library, which
// has no engine limit (browser-wadimport [5]).
//
// usage: node tools/web-registry-test.mjs [build-dir]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const buildDir = process.argv[2] ?? 'build';

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};

const cSrc = readFileSync(join(root, 'engine/web/files.c'), 'utf8');
const cMax = Number((/#define\s+MAXWEBFILES\s+(\d+)/.exec(cSrc) ?? [])[1]);
check('MAXWEBFILES is readable in files.c', Number.isInteger(cMax) && cMax > 0, `files.c=${cMax}`);

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

if (results.length < 4) { console.log('FAIL — the suite did not complete'); process.exit(1); }
const bad = results.filter(r => !r.ok);
console.log(bad.length
    ? `FAIL — web-registry: ${bad.length} of ${results.length} assertions failed`
    : `PASS — web-registry: ${results.length} assertions, registry capacity ${cMax} enforced`);
process.exit(bad.length ? 1 : 0);
