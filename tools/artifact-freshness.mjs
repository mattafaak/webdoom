#!/usr/bin/env node
// tools/artifact-freshness.mjs — assert a built artifact is not older than the
// sources it was built from.
//
// WHY THIS EXISTS
// ---------------
// Two suite gates — the differential fuzzer (`run-fuzz.mjs --require-native`)
// and the adversarial map gate (`run-map-fuzz.mjs --adversarial-gate`) — run a
// native ASan build of engine/core as their reference.  Both checked only
// `existsSync`.  On 2026-09-11 that binary was found to be 10 engine commits
// and 6 engine/core source files behind the tree, covering the entire
// 20.2b/20.3a-d optimization series: the memory-safety gate had been green
// against code that was no longer in the repo, and nothing could say so.
//
// The same hole existed one level up: `run-tests.sh` built the variant trees
// but never build/, so every gate that loads
// build/doom.js — smoke, sim goldens, render goldens, music, seek, verify —
// validated whatever artifact a human last left there.
//
// This is failure mode #2 from the project's own list: a value that reports
// itself is not the value that is in force.  A gate must know the provenance of
// the thing it is testing, and say it.
//
// mtime is the instrument.  It is not perfect — a `git checkout` restamps
// sources and will report a false stale — but it is the one signal that is
// always available, and a false stale is a loud, cheap, correctable failure,
// whereas a false fresh is the silent one that cost this project a phase.
//
// usage:
//   node tools/artifact-freshness.mjs --all          # check every artifact
//   node tools/artifact-freshness.mjs build nat-doom # check named artifacts
//   node tools/artifact-freshness.mjs --list
// Exit 0 iff every checked artifact exists and is at least as new as its
// newest source.  Missing artifacts are reported separately from stale ones.
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './lib/util.mjs';


// engine/core minus the six platform files every target replaces; those live in
// each target's own directory and are covered by that target's `dirs` entry.
const CORE_EXCLUDE = new Set(['i_main.c', 'i_net.c', 'i_sound.c', 'i_system.c', 'i_video.c', 'd_net.c']);

// The registry IS the contract: an artifact is listed here with the sources it
// is built from and the command that rebuilds it, or it is not checked at all.
export const ARTIFACTS = {
    'build': {
        desc:    'shipping wasm engine (the artifact almost every gate loads)',
        path:    'build/doom.wasm',
        also:    ['build/doom.js'],
        dirs:    [['engine/core', true], ['engine/web', false]],
        files:   ['engine/Makefile'],
        binds:   true,
        rebuild: 'source tools/emsdk-env.sh && make -C engine',
    },
    // The worklet synth links only three objects, so its sources are those
    // three files -- NOT all of engine/core.  Listed under `build`'s `also` it
    // read STALE after any renderer edit, because make correctly did not relink
    // it: an artifact is only as stale as the sources it is actually built from.
    'synth': {
        desc:    'OPL synth for the AudioWorklet (ledger NC6)',
        path:    'build/synth.wasm',
        files:   ['engine/web/mus_opl.c', 'engine/web/opl3.c', 'engine/web/opl3.h',
                  'engine/web/synth_main.c', 'engine/web/web.h', 'engine/Makefile'],
        rebuild: 'source tools/emsdk-env.sh && make -C engine',
    },
    'nat-doom': {
        desc:    'native ASan/UBSan reference (the sanitizer IS the adversarial gate)',
        path:    'tools/native-sanitize/nat-doom',
        dirs:    [['engine/core', true], ['tools/native-sanitize', false]],
        files:   ['tools/native-sanitize/Makefile'],
        rebuild: 'make -C tools/native-sanitize',
    },
    'fs-doom': {
        desc:    'freestanding reference (icount source for the optimization ledger)',
        path:    'tools/freestanding/fs-doom',
        dirs:    [['engine/core', true], ['tools/freestanding', false]],
        files:   ['tools/freestanding/Makefile'],
        rebuild: 'make -C tools/freestanding',
    },
    // ── the compile-time variants ────────────────────────────────────────────
    //
    // These were not registered, and the registry IS the contract -- so nothing
    // checked them.  The gap had teeth because the suite pairs them
    // asymmetrically: `build-invariants` needs emsdk, `sim-invariants` needs only
    // `wad`.  On a host without emsdk the build leg SKIPs and the leg that LOADS
    // the tree runs anyway, against whatever bytes are on disk, from a tree built
    // before the change under test.
    //
    // Same sources as `build` -- the variants differ only by a -D on the command
    // line -- so the same dirs and Makefile decide staleness.
    //
    // `optional` means ABSENT is not a failure for --all: a host that has never
    // built a variant is not stale, it is uninvolved, and the consuming legs
    // have their own prerequisite. Absent ones are named and counted, never
    // passed over in silence. Present-and-stale is always a failure.
    ...Object.fromEntries([
        ['build-invariants', 'WEBDOOM_INVARIANTS', 'demo-visible invariant asserts'],
    ].map(([dir, define, desc]) => [dir, {
        desc:     `${desc} (-D${define})`,
        path:     `${dir}/doom.wasm`,
        also:     [`${dir}/doom.js`],
        dirs:     [['engine/core', true], ['engine/web', false]],
        files:    ['engine/Makefile'],
        binds:    true,
        optional: true,
        rebuild:  `bash tools/build-toggle.sh ${define} ${dir}`,
    }])),
};

function sourcesOf(spec) {
    const out = [];
    for (const [dir, isCore] of spec.dirs ?? []) {
        const abs = join(root, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs)) {
            if (!/\.[ch]$/.test(name)) continue;
            if (isCore && CORE_EXCLUDE.has(name)) continue;
            out.push(join(abs, name));
        }
    }
    for (const f of spec.files ?? []) {
        const abs = join(root, f);
        if (existsSync(abs)) out.push(abs);
    }
    return out;
}

// Returns { name, path, exists, builtAt, sourceCount, newer[] }.
// `newer` is the list of sources strictly newer than the artifact, newest first.
export function inspect(name) {
    const spec = ARTIFACTS[name];
    if (!spec) throw new Error(`artifact-freshness: unknown artifact '${name}'`);
    const artifacts = [spec.path, ...(spec.also ?? [])].map(p => join(root, p));
    const missing = artifacts.filter(p => !existsSync(p));
    if (missing.length) {
        return { name, spec, path: spec.path, exists: false,
                 missing: missing.map(p => relative(root, p)), newer: [], sourceCount: 0 };
    }
    // The OLDEST of the artifact's own files is the honest build time: doom.js
    // and doom.wasm come from one link, and a partial rebuild must read stale.
    const builtAt = Math.min(...artifacts.map(p => statSync(p).mtimeMs));
    const sources = sourcesOf(spec);
    const newer = sources
        .map(p => ({ p, m: statSync(p).mtimeMs }))
        .filter(x => x.m > builtAt)
        .sort((a, b) => b.m - a.m)
        .map(x => ({ file: relative(root, x.p), mtime: new Date(x.m).toISOString() }));
    return { name, spec, path: spec.path, exists: true, builtAt,
             builtAtISO: new Date(builtAt).toISOString(), sourceCount: sources.length, newer };
}

// One line of provenance, for a gate to print before it trusts the artifact.
export function provenance(name) {
    const r = inspect(name);
    if (!r.exists) return `${name}: ABSENT (${r.missing.join(', ')})`;
    const state = r.newer.length ? `STALE by ${r.newer.length} source(s)` : 'current';
    return `${name}: ${r.path} built ${r.builtAtISO} — ${state} vs ${r.sourceCount} sources`;
}

// `binds`: the loader (also[0]) must name its module (path) by content, as
// engine/Makefile stamps it -- every reference is <module>?v=<sha256[:12]>.
// A loader and module from two different links pass the mtime test and fail
// this one.  Returns null when bound, or what is wrong.
export function binding(name) {
    const spec = ARTIFACTS[name];
    if (!spec.binds) return null;
    const wasm = join(root, spec.path), js = join(root, spec.also[0]);
    const tag = createHash('sha256').update(readFileSync(wasm)).digest('hex').slice(0, 12);
    const mod = basename(wasm);
    const refs = [...readFileSync(js, 'latin1').matchAll(new RegExp(`"${mod.replace('.', '\\.')}(\\?v=([0-9a-f]*))?"`, 'g'))];
    if (!refs.length) return `${spec.also[0]} never names "${mod}"`;
    const off = refs.filter(m => m[2] !== tag);
    return off.length ? `${spec.also[0]} names ${off[0][0]} but ${spec.path} is ?v=${tag} (${off.length} of ${refs.length} references)`
                      : null;
}

// Throwing form for gates.  Returns the inspect() record when fresh.
export function assertFresh(name) {
    const r = inspect(name);
    if (!r.exists)
        throw new Error(`${name} is absent (${r.missing.join(', ')}) — rebuild: ${r.spec.rebuild}`);
    if (r.newer.length) {
        const shown = r.newer.slice(0, 5).map(x => `      ${x.file} (${x.mtime})`).join('\n');
        throw new Error(
            `${name} is STALE: ${r.newer.length} of ${r.sourceCount} sources are newer than ` +
            `${r.path} (built ${r.builtAtISO}).\n${shown}` +
            (r.newer.length > 5 ? `\n      … and ${r.newer.length - 5} more` : '') +
            `\n    Rebuild: ${r.spec.rebuild}`);
    }
    const unbound = binding(name);
    if (unbound) throw new Error(`${name} is UNBOUND: ${unbound}.\n    Rebuild: ${r.spec.rebuild}`);
    return r;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    if (args.includes('--list')) {
        for (const [n, s] of Object.entries(ARTIFACTS)) console.log(`${n.padEnd(10)} ${s.path}  — ${s.desc}`);
        process.exit(0);
    }
    const unknown = args.filter(a => a.startsWith('--') && a !== '--all');
    if (unknown.length) {
        console.error(`usage: artifact-freshness.mjs [--all | --list | <name>...]  (unknown: ${unknown.join(' ')})`);
        process.exit(2);
    }
    const names = args.includes('--all') || args.length === 0
        ? Object.keys(ARTIFACTS)
        : args;
    for (const n of names) {
        if (!ARTIFACTS[n]) { console.error(`FAIL unknown artifact '${n}' — see --list`); process.exit(2); }
    }
    let bad = 0, checked = 0;
    const absentOptional = [];
    for (const n of names) {
        // An optional variant that was never built on this host is uninvolved,
        // not stale.  Named and counted, never silent -- and only when the user
        // asked for everything: `artifact-freshness build-invariants` is someone
        // asking about that tree specifically, and "absent" is the answer.
        const explicit = !(args.includes('--all') || args.length === 0);
        if (ARTIFACTS[n].optional && !explicit && !inspect(n).exists) {
            absentOptional.push(n);
            continue;
        }
        checked++;
        try {
            const r = assertFresh(n);
            console.log(`PASS ${n}: ${r.path} built ${r.builtAtISO}, newer than all ${r.sourceCount} sources`
                        + (r.spec.binds ? ', its loader bound to it by content' : ''));
        } catch (e) {
            console.log(`FAIL ${e.message}`);
            bad++;
        }
    }
    if (absentOptional.length)
        console.log(`  not built on this host (optional, so not graded): ${absentOptional.join(', ')}`);
    // A run that checked nothing is not a pass (failure mode #3).
    if (!checked) { console.log('FAIL artifact-freshness: checked 0 artifacts — vacuous run'); process.exit(1); }
    console.log(bad ? `artifact-freshness: ${bad} of ${checked} artifact(s) stale or absent`
                    : `PASS — all ${checked} artifact(s) current with their sources`
                      + (absentOptional.length ? ` (${absentOptional.length} optional not built)` : ''));
    process.exit(bad ? 1 : 0);
}
