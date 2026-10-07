#!/usr/bin/env bash
# tools/floor/run-x86.sh — the floor gate on the host: fs-doom over all 13
# demos, a correctness run (mode A) and a timing run (mode B) each, then
# tools/floor/floor-gate.mjs.  The verdict is DEMAND: x86 instructions per tic,
# the demand every other target is measured against.
#
# Instructions are counted with perf_event_open, and on a hybrid CPU that
# counter belongs to one core type: on an E-core it counts nothing (measured:
# 1,710 of 1,710 tics read 0).  So every run is pinned to a P-core, one per
# job; the gate refuses a tic that took 0.
#
# Audio runs in every tic (tools/freestanding/fs_audio.c): the web build's OPL
# music synth and the 8-channel sound-effect mixer, so the demand is the game
# WITH its sound.  Each demo's AUDIO line must then show music and sound
# effects, be the same in both runs, and match the references: its synthhash
# tools/floor/synth-ref.json's l2 (held to build/synth.wasm by the synth-native
# leg) and the whole line tools/floor/audio-ref.json.  Mode A's runs leave the
# demo's sound events in <out>/<demo>.audio.txt.
#   WD_AUDIO=0            audio off: the old, game-only demand (AUDIO lines 0)
#   WD_AUDIO_REF_WRITE=1  rewrite audio-ref.json from this run (refused unless
#                         every synthhash matches synth-ref.json)
#
# usage: bash tools/floor/run-x86.sh [out_dir]
# Copyright (C) 2026, GPL-2.0-or-later.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/tools/floor/out-x86}"
FS="${FS_DOOM:-$ROOT/tools/freestanding/fs-doom}"   # FS_DOOM: a side build
WADS="$ROOT/wads/lib"
[ -x "$FS" ] || { echo "FAIL floor-x86: $FS not built (make -C tools/freestanding)"; exit 1; }
BUILD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -n "$(git -C "$ROOT" status --porcelain -- engine tools/freestanding tools/floor 2>/dev/null)" ] && BUILD="$BUILD+dirty"

# P-cores: the cpu_core PMU's CPUs on a hybrid part, else every CPU
expand () { local r a b; for r in ${1//,/ }; do a=${r%-*}; b=${r#*-}; seq "$a" "$b"; done; }
if [ -r /sys/devices/cpu_core/cpus ]; then
    mapfile -t CPUS < <(expand "$(cat /sys/devices/cpu_core/cpus)")
else
    mapfile -t CPUS < <(seq 0 $(( $(nproc) - 1 )))
fi

rm -rf "$OUT"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DEMOS=(
    "doom.wad     doomu.wad    demo1 doom-demo1"
    "doom.wad     doomu.wad    demo2 doom-demo2"
    "doom.wad     doomu.wad    demo3 doom-demo3"
    "doom.wad     doomu.wad    demo4 doom-demo4"
    "doom2.wad    doom2.wad    demo1 doom2-demo1"
    "doom2.wad    doom2.wad    demo2 doom2-demo2"
    "doom2.wad    doom2.wad    demo3 doom2-demo3"
    "tnt.wad      tnt.wad      demo1 tnt-demo1"
    "tnt.wad      tnt.wad      demo2 tnt-demo2"
    "tnt.wad      tnt.wad      demo3 tnt-demo3"
    "plutonia.wad plutonia.wad demo1 plutonia-demo1"
    "plutonia.wad plutonia.wad demo2 plutonia-demo2"
    "plutonia.wad plutonia.wad demo3 plutonia-demo3"
)

jobs_run=0
fails=0
pids=()
for entry in "${DEMOS[@]}"; do
    read -r src as demo name <<< "$entry"
    [ -f "$WADS/$src" ] || { echo "FAIL floor-x86: $WADS/$src absent (tools/fetch-wads.sh)"; exit 1; }
    mkdir -p "$TMP/$name"
    ln -sf "$WADS/$src" "$TMP/$name/$as"
    for mode in A B; do
        cpu="${CPUS[$(( jobs_run % ${#CPUS[@]} ))]}"
        trace=""
        [ "$mode" = A ] && trace="$OUT/$name.audio.txt"
        ( WD_CYCLES=1 WD_BUILD="$BUILD" WD_FLOOR_MODE=$mode WD_FLOOR_NAME="$name" \
              WD_AUDIO_TRACE="$trace" \
              taskset -c "$cpu" "$FS" "$TMP/$name/$as" -timedemo "$demo" \
              -floor "$OUT/$name.$mode.log" > /dev/null 2> "$OUT/$name.$mode.err" ) &
        pids+=($!)
        jobs_run=$(( jobs_run + 1 ))
        if [ $(( jobs_run % ${#CPUS[@]} )) -eq 0 ]; then
            for p in "${pids[@]}"; do wait "$p" || fails=$(( fails + 1 )); done
            pids=()
        fi
    done
done
for p in "${pids[@]}"; do wait "$p" || fails=$(( fails + 1 )); done
[ "$fails" -eq 0 ] || { echo "FAIL floor-x86: $fails fs-doom run(s) exited non-zero (see $OUT/*.err)"; exit 1; }

echo "floor-x86: $jobs_run runs of fs-doom ($BUILD), pinned to ${#CPUS[@]} CPU(s)"

# The tic flags come from floor_wrap.c's --wrap hooks.  Every attract demo opens
# with a level load, so a demo with no L tic, or a run that counted no bytes
# out of the WAD, means the hooks were not linked: the demand would then
# silently include the 4-42 M-instruction load tics.
node -e '
const fs = require("fs"), dir = process.argv[1];
const logs = fs.readdirSync(dir).filter(f => f.endsWith(".A.log"));
const noLoad = logs.filter(f => !/^T \d+ \d+ \d+ \S*L/m.test(fs.readFileSync(dir + "/" + f, "utf8")));
const anyMiss = logs.some(f => /^T .* (\S*,)?M:\d+/m.test(fs.readFileSync(dir + "/" + f, "utf8")));
if (noLoad.length) { console.log(`FAIL floor-x86: ${noLoad.length} of ${logs.length} demos have no load tic: the --wrap hooks did not fire (${noLoad[0]})`); process.exit(1); }
if (!anyMiss) { console.log("FAIL floor-x86: no tic copied a byte out of the WAD: the memcpy hook did not fire"); process.exit(1); }
' "$OUT" || exit 1
# The audio: every demo heard music and sound effects, both runs heard the
# same, and the samples are the references'.
node -e '
const fs = require("fs"), [dir, root, wdAudio, write] = process.argv.slice(1), off = wdAudio === "0" ? "1" : "0";
const synth = JSON.parse(fs.readFileSync(root + "/tools/floor/synth-ref.json", "utf8")).demos;
const refPath = root + "/tools/floor/audio-ref.json";
const ref = fs.existsSync(refPath) ? JSON.parse(fs.readFileSync(refPath, "utf8")) : null;
const KEYS = ["samples", "underruns", "music_events", "sfx_starts", "synthhash", "mixhash", "frames"];
const audio = f => { const t = fs.readFileSync(dir + "/" + f, "utf8");
                     const a = /^AUDIO (.*)$/m.exec(t), d = /^DEMO (\S+) tics=(\d+)$/m.exec(t);
                     return { demo: d[1], tics: +d[2], ...Object.fromEntries(a[1].split(" ").map(kv => kv.split("="))) }; };
const logs = fs.readdirSync(dir).filter(f => f.endsWith(".log")).sort(), bad = [], out = {};
for (const f of logs) {
    const a = audio(f), line = KEYS.map(k => `${k}=${a[k]}`).join(" ");
    if (off === "1") { if (KEYS.some(k => k !== "synthhash" && k !== "mixhash" && +a[k] !== 0)) bad.push(`${f}: WD_AUDIO=0 but the AUDIO line is ${line}`); continue; }
    const want = Math.floor(a.tics * 49716 / 35), s = synth[a.demo + ".opl2"];
    if (!(+a.music_events > 0)) bad.push(`${f}: played no music (${line})`);
    if (!(+a.sfx_starts > 0)) bad.push(`${f}: started no sound effect (${line})`);
    if (+a.frames !== a.tics || +a.samples !== want) bad.push(`${f}: ${a.frames} audio tics and ${a.samples} frames for ${a.tics} tics (${want} expected)`);
    if (!s || a.synthhash !== s.l2) bad.push(`${f}: synthhash ${a.synthhash}, tools/floor/synth-ref.json says ${s && s.l2} (${s && s.song})`);
    if (out[a.demo] && out[a.demo] !== line) bad.push(`${f}: the two runs heard different audio (${out[a.demo]} vs ${line})`);
    out[a.demo] = line;
    if (ref && write !== "1" && ref[a.demo] !== line) bad.push(`${f}: AUDIO ${line}, tools/floor/audio-ref.json says ${ref[a.demo]}`);
}
if (off !== "1" && !ref && write !== "1") bad.push("tools/floor/audio-ref.json is missing (WD_AUDIO_REF_WRITE=1 writes it)");
for (const b of bad) console.log(`FAIL floor-x86: ${b}`);
if (bad.length) process.exit(1);
if (off === "1") { console.log(`floor-x86: WD_AUDIO=0: audio off in all ${logs.length} runs (the game-only demand)`); process.exit(0); }
if (write === "1") { fs.writeFileSync(refPath, JSON.stringify(out, null, 1) + "\n"); console.log(`floor-x86: wrote ${refPath}`); }
console.log(`floor-x86: audio in all ${logs.length} runs: music and sound effects in every demo, both runs alike; ` +
            `synthhash == synth-ref.json on ${logs.length}, AUDIO == audio-ref.json on ${write === "1" ? 0 : logs.length}`);
' "$OUT" "$ROOT" "${WD_AUDIO:-1}" "${WD_AUDIO_REF_WRITE:-0}" || exit 1
exec node "$ROOT/tools/floor/floor-gate.mjs" "$OUT"/*.log
