#!/usr/bin/env node
// Run every committed reproducer for the engine's derived figures (docs/
// engine-archaeology.md) and require each one to come out the same.
//
// Each reproducer must exit 0.  Every value it emits on its CLAIMS_JSON line is
// compared against `expect` below, so a reproducer that only prints a figure
// still fails when the figure moves.  Two of them (source-constant, wad-verify)
// carry their own expected values and print "N/N passed"; for those the floor
// is the count.
//
// Documents are not read.  A figure quoted in prose is the reader's to keep in
// step with this file.
//
// usage: node tools/archaeology/run.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../lib/util.mjs';

const A = 'tools/archaeology';
const WAD = join(root, 'wads/lib/doom.wad');
const tmp = mkdtempSync(join(tmpdir(), 'webdoom-arch-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// The PLAYPAL and COLORMAP lumps of doom.wad, for the colormap reproducers.
function lumps() {
    const wad = readFileSync(WAD);
    const n = wad.readUInt32LE(4), dir = wad.readUInt32LE(8);
    const out = {};
    for (let i = 0; i < n; i++) {
        const e = dir + i * 16, ofs = wad.readUInt32LE(e), size = wad.readUInt32LE(e + 4);
        const name = wad.toString('ascii', e + 8, e + 16).replace(/\0.*$/, '');
        if (name === 'PLAYPAL' || name === 'COLORMAP') {
            out[name] = join(tmp, `${name}.lmp`);
            writeFileSync(out[name], wad.subarray(ofs, ofs + size));
        }
    }
    return out;
}

const node = file => () => ['node', [join(A, file)]];
const c = (file, args = () => []) => () => {
    const bin = join(tmp, file.replace(/\.c$/, ''));
    execFileSync('gcc', ['-O2', join(A, file), '-o', bin, '-lm'], { cwd: root, stdio: 'pipe' });
    return [bin, args()];
};

const REPRODUCERS = [
    { name: 'source-constant', run: node('source-constant-verify.mjs'), floor: 33 },
    { name: 'wad-data', run: node('wad-verify.mjs'), floor: 23, wad: true },
    { name: 'finesine-stats', run: node('finesine-stats.mjs'),
      expect: { 'ea-001': '5377', 'ea-002': '33', 'ea-003': '16385' } },
    { name: 'gamma-crack', run: node('gamma-crack.mjs'),
      expect: { 'ea-010': '5', 'ea-011': '34', 'ea-012': '36', 'ea-013': '41', 'ea-014': '34' } },
    { name: 'rndtable-stats', run: c('rndtable-stats.c'),
      expect: { 'ea-007': '128.85', 'ea-008': '166', 'ea-009': '90' } },
    { name: 'fixeddiv-proof', run: c('fixeddiv-proof.c'),
      expect: { 'ea-004': '137438953472', 'ea-005': '8388608', 'ea-006': '0' } },
    { name: 'fixedmul-proof', run: c('fixedmul-proof.c'),
      expect: { 'ea-042': '4611686018427387904', 'ea-043': '1' } },
    { name: 'aprox-distance-crack', run: c('aprox-distance-crack.c'),
      expect: { 'ea-015': '+11.8%', 'ea-016': '+6.1%', 'ea-017': '0.0%', 'ea-044': '+41.4%', 'ea-045': '11.81%' } },
    { name: 'angle-roundtrip-check', run: c('angle-roundtrip-check.c'),
      expect: { 'ea-046': '3', 'ea-047': '2048' } },
    { name: 'checkcoord-verify', run: node('checkcoord-verify.mjs'), expect: { 'ea-027': '9' } },
    { name: 'zlight-distmap', run: node('zlight-distmap.mjs'), expect: { 'ea-028': '16 to 2048' } },
    { name: 'colormap-crack', wad: true,
      run: c('colormap-crack.c', () => { const l = lumps(); return [l.PLAYPAL, l.COLORMAP]; }),
      expect: { 'ea-018': '0', 'ea-019': '313', 'ea-020': '2373', 'ea-021': '1208' } },
    { name: 'colormap-invuln-crack', wad: true,
      run: c('colormap-invuln-crack.c', () => { const l = lumps(); return [l.PLAYPAL, l.COLORMAP]; }),
      expect: { 'ea-023': '241', 'ea-024': '15', 'ea-025': '262', 'ea-026': '91' } },
    { name: 'colormap-cross-palette', wad: true,
      run: c('colormap-cross-palette.c', () => [join(root, 'wads/lib')]),
      expect: { 'ea-048': '3517', 'ea-049': '4' } },
];

const haveWad = existsSync(WAD);
let ran = 0, skipped = 0, values = 0;
const failures = [];
for (const r of REPRODUCERS) {
    if (r.wad && !haveWad) { skipped++; console.log(`SKIP  ${r.name}: wads/lib/doom.wad absent`); continue; }
    let out;
    try {
        const [cmd, args] = r.run();
        out = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        failures.push(`${r.name}: exited ${e.status ?? e.message}`);
        console.log(`FAIL  ${r.name}: exited ${e.status ?? e.message}\n${String(e.stdout ?? '').split('\n').filter(l => /FAIL/.test(l)).join('\n')}`);
        continue;
    }
    ran++;
    const problems = [];
    if (r.floor) {
        const m = /(\d+)\/(\d+) passed/.exec(out);
        if (!m || m[1] !== m[2] || +m[2] < r.floor) problems.push(`expected at least ${r.floor}/${r.floor} passed, got ${m ? m[0] : 'no count'}`);
        else values += +m[2];
    }
    if (r.expect) {
        const m = /CLAIMS_JSON (\{.*\})/.exec(out);
        const got = m ? JSON.parse(m[1]) : {};
        for (const [id, want] of Object.entries(r.expect)) {
            if (String(got[id]) !== want) problems.push(`${id} = ${JSON.stringify(got[id])}, expected ${JSON.stringify(want)}`);
            else values++;
        }
    }
    if (problems.length) { failures.push(`${r.name}: ${problems.join('; ')}`); console.log(`FAIL  ${r.name}: ${problems.join('; ')}`); }
    else console.log(`ok    ${r.name}`);
}

if (failures.length) {
    console.log(`FAIL archaeology: ${failures.length} of ${ran} reproducers disagree`);
    process.exit(1);
}
if (ran === 0) { console.log('FAIL archaeology: no reproducer ran'); process.exit(1); }
console.log(`PASS archaeology: ${ran} reproducers, ${values} values reproduced` +
            (skipped ? `; ${skipped} skipped (no doom.wad)` : ''));
