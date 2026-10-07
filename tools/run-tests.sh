#!/bin/bash
# webdoom test suite — leg-isolating runner.
#
# Every leg runs through tools/gate.sh (exact exit code, outside any pipeline),
# a red is recorded and the run continues, and the suite ends with a table
# naming every leg, its verdict, its duration and what it reported.  A leg
# whose prerequisites are absent SKIPs with a reason and is counted, so a run
# with skips never reads as a clean pass; --require-complete makes a skip a
# failure.
#
# usage:
#   tools/run-tests.sh                 # full tier (everything)
#   tools/run-tests.sh --quick         # no WADs, no build, no browser — clone-safe
#   tools/run-tests.sh --only ID [...] # run just these legs
#   tools/run-tests.sh --jobs N        # N legs at a time; 1 = serial
#   tools/run-tests.sh --list          # print the leg registry and exit
#   tools/run-tests.sh --require-complete   # a SKIP is a failure
#   tools/run-tests.sh --keep-logs DIR      # keep every leg's full log in DIR
#
# Copyright (C) 2026, GPL-2.0-or-later.

# Deliberately NOT -e: a failing leg must be reported, not abort the run.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
SUITE_T0=$(date +%s)

TIER=full
PERF=0
NO_SLOW=0
REQUIRE_COMPLETE=0
ONLY=()
LIST=0
JOBS=1
KEEP_LOGS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --quick)            TIER=quick; shift ;;
        # legs run N at a time, each on its own server and port; a leg tagged
        # `alone` (timing-graded -- contention IS the measurement) drains the
        # pool first, while `heavy` (expensive but hash-graded) may overlap.
        #
        # 6 is the recommendation on a 24-thread host: the same full table
        # took 642 s at 3, 577 s at 6 and 564 s at 10, and n64-demos alone is
        # 434 s of it.  The default stays 1: CI runs this file with no --jobs
        # on a 2-core runner, where six concurrent Chromes are untested and the
        # timing-graded legs have nowhere to hide, and a default is what an
        # unmeasured host gets.
        --jobs)             JOBS="$2"; shift 2 ;;
        # opt-in because it reaches other machines (~30 s), not because it is
        # slow; it SKIPs, named and counted, in the default run
        --perf)             PERF=1; shift ;;
        # n64-demos is ~8 min of the run; --no-slow is for iterating, and the
        # leg still SKIPs named and counted (--require-complete still fails)
        --no-slow)          NO_SLOW=1; shift ;;
        --full)             TIER=full; shift ;;
        --only)             ONLY+=("$2"); shift 2 ;;
        --list)             LIST=1; shift ;;
        --require-complete) REQUIRE_COMPLETE=1; shift ;;
        # passing legs' logs are otherwise deleted with LOGDIR; a before/after
        # comparison of what each leg asserted needs all of them
        --keep-logs)        KEEP_LOGS="$2"; shift 2 ;;
        -h|--help)          sed -n '/^# usage:/,/^#$/p' "$0"; exit 0 ;;
        *) echo "unknown argument '$1' (see --list, --help)" >&2; exit 2 ;;
    esac
done

LOGDIR="$(mktemp -d -t webdoom-suite-XXXXXX)"
SUMMARY="$LOGDIR/summary.tsv"
: > "$SUMMARY"
# a full run starts with no stale failure logs, so a red in the directory is
# from THIS run (the last table, last-run.tsv, is kept)
[ "${#ONLY[@]}" -eq 0 ] && [ "$LIST" = "0" ] && rm -f "$REPO"/tools/.suite-logs/*.log

# ── prerequisite probes ──────────────────────────────────────────────────────
# Each returns 0 when satisfied; the reason string is what the table prints.
IWADS=(doom.wad doom2.wad tnt.wad plutonia.wad)
have_build()   { [ -f build/doom.js ] && [ -f build/doom.wasm ]; }
have_wad()     { local w; for w in "${IWADS[@]}"; do [ -f "wads/lib/$w" ] || return 1; done; }
have_native()  { [ -x tools/native-sanitize/nat-doom ]; }
have_fs()      { [ -x tools/freestanding/fs-doom ]; }
have_zig()     { command -v zig >/dev/null 2>&1; }
# the pinned major: output differs across majors
have_clangfmt(){ command -v clang-format >/dev/null 2>&1 && \
                 [ "$(clang-format --version | grep -oE '[0-9]+' | head -1)" = "23" ]; }
have_qemuarm() { command -v qemu-arm-static >/dev/null 2>&1; }
have_qemuppc() { command -v qemu-ppc-static >/dev/null 2>&1 || command -v qemu-ppc >/dev/null 2>&1; }
# the Cortex-M boards (system emulation) and the bare-metal compiler, together
have_qemucm()  { command -v qemu-system-arm >/dev/null 2>&1 && command -v arm-none-eabi-gcc >/dev/null 2>&1; }
have_qemurv()  { command -v qemu-riscv32-static >/dev/null 2>&1; }
# the cross compiler, the ares emulator and an X server, together
have_n64()     { [ -x "${N64_INST:-$HOME/toolchains/n64}/bin/mips64-elf-gcc" ] && \
                 command -v ares >/dev/null 2>&1 && \
                 command -v xvfb-run >/dev/null 2>&1; }
have_gcc()     { command -v gcc >/dev/null 2>&1; }
# the same resolution order as tools/chrome-harness.mjs, so the probe and the
# spawn cannot disagree; an explicit CHROME_BIN is the only answer when set
have_browser() {
    if [ -n "${CHROME_BIN:-}" ]; then
        command -v "$CHROME_BIN" >/dev/null 2>&1 || [ -x "$CHROME_BIN" ]
    else
        command -v google-chrome-stable >/dev/null 2>&1 || [ -x /opt/google/chrome/chrome ]
    fi
}
have_firefox() { [ -x /usr/bin/firefox ]; }
have_emsdk()   { [ -x "${EMSDK_DIR:-$HOME/projects/bee-kettle-doom/emsdk}/upstream/emscripten/emcc" ]; }
have_baseline(){ [ -f "tools/golden/browser-pipeline-$(hostname).json" ]; }
# the browser legs share one server; as a prerequisite, each reports its own SKIP
SHARED_UP=0
have_shared()  { [ "$SHARED_UP" = "1" ]; }
have_loadbudget(){ [ -f "tools/golden/load-budget-$(hostname).json" ]; }
have_xvfb()    { command -v xvfb-run >/dev/null 2>&1; }
have_systemd() { command -v systemd-analyze >/dev/null 2>&1; }
have_perf()    { [ "$PERF" = "1" ]; }
have_notslow() { [ "$NO_SLOW" = "0" ]; }
# present is not current: a render leg must not run against a stale variant tree
have_fresh()   { node tools/artifact-freshness.mjs "$1" >/dev/null 2>&1; }

# One table: prerequisite tag → probe | reason (HOST is expanded when printed).
declare -A NEED=(
    [build]='have_build|build/doom.js absent (run: source tools/emsdk-env.sh && make -C engine)'
    [wad]='have_wad|IWADs absent (run: tools/fetch-wads.sh)'
    [native]='have_native|nat-doom absent (run: make -C tools/native-sanitize)'
    [fs]='have_fs|fs-doom absent (run: make -C tools/freestanding)'
    [zig]='have_zig|zig not on PATH (needed to cross-build for ARM)'
    [clangfmt]='have_clangfmt|clang-format 23 not present'
    [qemuarm]='have_qemuarm|qemu-arm-static not on PATH'
    [qemuppc]='have_qemuppc|qemu-ppc-static not on PATH (needed for the BIG-ENDIAN leg)'
    [qemucm]='have_qemucm|qemu-system-arm and arm-none-eabi-gcc not both on PATH (needed for the Cortex-M floor legs)'
    [qemurv]='have_qemurv|qemu-riscv32-static not on PATH (needed for the RV32 leg)'
    [n64]='have_n64|N64 toolchain incomplete (need mips64-elf-gcc under $N64_INST, ares and xvfb-run; run: source ~/toolchains/env.sh)'
    [gcc]='have_gcc|gcc not on PATH'
    [systemd]='have_systemd|systemd-analyze not on PATH (the unit file cannot be validated here)'
    [xvfb]='have_xvfb|xvfb-run not on PATH (headless Firefox has NO WebGL here, so the frame gate needs a real X display)'
    [loadbudget]='have_loadbudget|no load-budget baseline for host HOST (record: node tools/load-budget-test.mjs --record)'
    [browser]='have_browser|Chrome not found (set CHROME_BIN)'
    [firefox]='have_firefox|/usr/bin/firefox not found'
    [emsdk]='have_emsdk|emsdk not found (run: tools/setup-emsdk.sh)'
    [baseline]='have_baseline|no browser-pipeline baseline for host HOST'
    [shared]='have_shared|shared browser server on 8668 not started'
    [slow]='have_notslow|--no-slow given: this leg is ~8 min of the suite'
    [perf]='have_perf|perf tier not requested (run: tools/run-tests.sh --perf; ~30 s measured, needs wbox and tank up)'
    # not a prerequisite: under --jobs the leg runs with the pool drained
    [alone]='true|'
    # not a prerequisite either, and not `alone`: expensive but not graded on
    # time, so it may share the machine
    [heavy]='true|'
)
need_reason() {   # need_reason <tag> -> why it is unmet
    case "$1" in
        fresh-*) echo "build-${1#fresh-} absent or stale (node tools/artifact-freshness.mjs build-${1#fresh-})" ;;
        *) local r="${NEED[$1]-}"; r="${r#*|}"; echo "${r//HOST/$(hostname)}"; [ -n "$r" ] || echo "unmet prerequisite '$1'" ;;
    esac
}
need_met() {
    case "$1" in
        fresh-*) have_fresh "build-${1#fresh-}" ;;
        *) local p="${NEED[$1]-}"; p="${p%%|*}"; [ -n "$p" ] && "$p" ;;
    esac
}

# ── the headline a leg reported about itself ─────────────────────────────────
# A red prefers its FAIL/Error line and a green its PASS/summary line, so a
# failing leg never wears a passing headline; gate.sh's own trailer is never it.
headline() {
    local log="$1" rc="$2" h=""
    local OWN='^GATE [A-Za-z0-9_-]+ rc='
    [ -s "$log" ] || { echo "(no output)"; return; }
    if [ "$rc" -ne 0 ]; then
        h="$(grep -aE '(^|[^A-Za-z])(FAIL|GATE FAIL|FATAL|Error:|error:)' "$log" | grep -avE "$OWN" | tail -1)"
    else
        h="$(grep -aE '^(PASS|GATE PASS|ALL PASS)' "$log" | grep -avE "$OWN" | tail -1)"
    fi
    [ -n "$h" ] || h="$(grep -avE "$OWN" "$log" | grep -av '^[[:space:]]*$' | tail -1)"
    # collapse whitespace and clip for the table
    echo "$h" | tr -s '[:space:]' ' ' | cut -c1-96
}

PASSED=0; FAILED=0; SKIPPED=0
FAILED_IDS=()

# leg <id> <needs-csv|-> <description> -- <command...>
leg() {
    local id="$1" needs="$2" desc="$3"; shift 3
    [ "${1:-}" = "--" ] && shift

    if [ "${#ONLY[@]}" -gt 0 ]; then
        local want=0 o
        for o in "${ONLY[@]}"; do [ "$o" = "$id" ] && want=1; done
        [ "$want" = "1" ] || return 0
    fi

    ORDER+=("$id")
    local t
    for t in ${needs//,/ }; do
        [ "$t" = "-" ] && continue
        # a fresh-* need under --jobs is judged when the leg launches, after
        # the build-* leg it waits on has finished
        [ "$JOBS" -gt 1 ] && [[ "$t" == fresh-* ]] && continue
        if ! need_met "$t"; then
            skip_leg "$id" "$(need_reason "$t")"
            return 0
        fi
    done

    if [ "$JOBS" -gt 1 ]; then
        QUEUE+=("$id"$'\t'"$desc"$'\t'"$needs"$'\t'"$(printf '%q ' "$@")")
        return 0
    fi

    printf '\n── %-26s %s\n' "$id" "$desc"
    local log="$LOGDIR/$id.log" rc=0 t0 t1
    t0=$(date +%s)
    bash tools/gate.sh --tail 2 --log "$log" "$id" -- "$@" || rc=$?
    t1=$(date +%s)
    record_leg "$id" "$rc" "$((t1 - t0))"
}
skip_leg() {   # skip_leg <id> <why>
    printf '\n── %-26s SKIP — %s\n' "$1" "$2"
    printf '%s\tSKIP\t0\t%s\n' "$1" "$2" >> "$SUMMARY"
    SKIPPED=$((SKIPPED + 1))
}
record_leg() {   # record_leg <id> <rc> <secs>
    local id="$1" rc="$2" secs="$3" log="$LOGDIR/$1.log" head
    head="$(headline "$log" "$rc")"
    if [ -n "$KEEP_LOGS" ]; then mkdir -p "$KEEP_LOGS" && cp "$log" "$KEEP_LOGS/$id.log"; fi
    if [ "$rc" -eq 0 ]; then
        PASSED=$((PASSED + 1))
        printf '%s\tPASS\t%s\t%s\n' "$id" "$secs" "$head" >> "$SUMMARY"
    else
        FAILED=$((FAILED + 1)); FAILED_IDS+=("$id")
        printf '%s\tFAIL(rc=%s)\t%s\t%s\n' "$id" "$rc" "$secs" "$head" >> "$SUMMARY"
        mkdir -p "$REPO/tools/.suite-logs"
        cp "$log" "$REPO/tools/.suite-logs/$id.log" 2>/dev/null || true
    fi
}

# ── --jobs: the scheduler ────────────────────────────────────────────────────
# leg() enqueues `id \t desc \t needs \t cmd` (cmd %q-quoted); this runs up to
# JOBS at a time in their own process groups, each `shared` leg on a server of
# its own, an `alone` leg with the pool drained before and after, and a leg
# whose fresh-X need waits on build-X after that leg has finished.  Output is
# collected per leg and printed under its heading when it completes, so a
# FAIL still sits under its own name; the table is assembled in registry order.
QUEUE=()
ORDER=()
declare -A RUNNING=()     # pid -> id
declare -A LEG_T0=()
declare -A LEG_SRV=()     # id -> private server pid
declare -A DONE=()        # id -> 1 once finished (for fresh-X waits)
free_port() { node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
launch_leg() {   # launch_leg <id> <desc> <needs> <cmd>
    local id="$1" desc="$2" needs="$3" cmd="$4" t
    for t in ${needs//,/ }; do
        if [[ "$t" == fresh-* ]] && ! need_met "$t"; then
            skip_leg "$id" "$(need_reason "$t")"; DONE[$id]=1; return 0
        fi
    done
    if [[ ",$needs," == *,shared,* ]]; then
        local port; port="$(free_port)"
        if ! serve_start "$port" > "$LOGDIR/$id.srv" 2>&1; then
            cat "$LOGDIR/$id.srv"; skip_leg "$id" "private browser server on $port did not start"; DONE[$id]=1; return 0
        fi
        LEG_SRV[$id]="${SERVERS[-1]}"
        cmd="${cmd//__SHARED_URL__/http://127.0.0.1:$port/}"
    fi
    LEG_T0[$id]=$(date +%s)
    setsid bash -c "exec bash tools/gate.sh --tail 2 --log \"$LOGDIR/$id.log\" \"$id\" -- $cmd" \
        > "$LOGDIR/$id.out" 2>&1 &
    RUNNING[$!]="$id"
}
reap_one() {   # wait for any running leg and record it
    local pid rc=0 id
    wait -n -p pid ${!RUNNING[@]} || rc=$?
    id="${RUNNING[$pid]}"; unset "RUNNING[$pid]"
    printf '\n── %-26s %s\n' "$id" "$(grep -m1 -oP "^\Q$id\E\t\K[^\t]*" <<< "$(printf '%s\n' "${QUEUE[@]}")")"
    cat "$LOGDIR/$id.out"
    record_leg "$id" "$rc" "$(( $(date +%s) - LEG_T0[$id] ))"
    DONE[$id]=1
    if [ -n "${LEG_SRV[$id]-}" ]; then kill "${LEG_SRV[$id]}" 2>/dev/null; wait "${LEG_SRV[$id]}" 2>/dev/null; unset "LEG_SRV[$id]"; fi
}
drain() { while [ "${#RUNNING[@]}" -gt 0 ]; do reap_one; done; }
run_queue() {
    local n="${#QUEUE[@]}" pending=() i e id desc needs cmd launched
    for ((i = 0; i < n; i++)); do pending+=("$i"); done
    while [ "${#pending[@]}" -gt 0 ] || [ "${#RUNNING[@]}" -gt 0 ]; do
        launched=0
        local rest=()
        for i in "${pending[@]}"; do
            e="${QUEUE[$i]}"
            IFS=$'\t' read -r id desc needs cmd <<< "$e"
            local blocked=0 t
            for t in ${needs//,/ }; do
                [[ "$t" == fresh-* ]] && [ -z "${DONE[build-${t#fresh-}]-}" ] && blocked=1
            done
            if [ "$blocked" = "1" ] || [ "$launched" = "1" ] || [ "${#RUNNING[@]}" -ge "$JOBS" ]; then rest+=("$i"); continue; fi
            if [[ ",$needs," == *,alone,* ]]; then
                drain; launch_leg "$id" "$desc" "$needs" "$cmd"; drain
            else
                launch_leg "$id" "$desc" "$needs" "$cmd"
            fi
            launched=1
        done
        pending=("${rest[@]}")
        # nothing launched: either the pool is full or every pending leg is
        # blocked -- in both cases wait for one to finish
        if [ "$launched" = "0" ]; then
            if [ "${#RUNNING[@]}" -gt 0 ]; then reap_one
            elif [ "${#pending[@]}" -gt 0 ]; then
                # blocked forever: the build-* leg it waits on is not in this run
                for i in "${pending[@]}"; do
                    IFS=$'\t' read -r id desc needs cmd <<< "${QUEUE[$i]}"
                    launch_leg "$id" "$desc" "$needs" "$cmd"
                done
                pending=(); drain
            fi
        fi
    done
}

# ── throwaway servers ────────────────────────────────────────────────────────
# Readiness is polled with a timeout, never slept for, and the port's OWNER is
# asserted: a stale server from an earlier run answers just as well and serves
# a different build.  No `ss` is a counted note (cannot verify); `ss` seeing
# no owner is a failure.
SERVERS=()
NOTES=0
NOTE_TEXT=()
note() { NOTES=$((NOTES + 1)); NOTE_TEXT+=("$1"); echo "  note: $1"; }

assert_port_owned() {   # assert_port_owned <port> <pid>
    if ! command -v ss >/dev/null 2>&1; then
        note "ss not available — port ownership NOT verified for $1 (install iproute2)"
        return 0
    fi
    local owner
    owner="$(ss -tlnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
    if [ -z "$owner" ]; then
        echo "  port $1: ss sees no listener, but we just started a server on it"
        echo "  the server is not up, or it bound a different address — either way this is not verified"
        return 1
    fi
    [ "$owner" = "$2" ] && return 0
    echo "  port $1 is held by pid $owner, not the server we started (pid $2)"
    echo "  a foreign or orphaned server would have been tested instead of this build"
    echo "  find it with: ss -tlnp 'sport = :$1'"
    return 1
}
serve_start() {   # serve_start <port>
    local port="$1" i
    DOOM_PORT="$port" DOOM_HOST=127.0.0.1 node server/serve.js >"$LOGDIR/server-$port.log" 2>&1 &
    local pid=$!
    SERVERS+=("$pid")
    for i in $(seq 1 60); do
        # --max-time: a squatter that accepts and says nothing must fail the
        # poll, not hang it
        if curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
            assert_port_owned "$port" "$pid" || return 1
            return 0
        fi
        kill -0 "$pid" 2>/dev/null || { echo "server on $port died at startup:"; tail -5 "$LOGDIR/server-$port.log"; return 1; }
        sleep 0.25
    done
    echo "server on $port never became ready"; return 1
}
serve_stop_all() {
    local p
    for p in ${SERVERS[@]+"${SERVERS[@]}"}; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
    SERVERS=()
}
# one trap for every server and every running leg this run starts
cleanup() {
    local p
    for p in ${!RUNNING[@]+"${!RUNNING[@]}"}; do kill -- "-$p" 2>/dev/null; kill "$p" 2>/dev/null; done
    serve_stop_all; rm -rf "$LOGDIR"
}
trap cleanup EXIT INT TERM

# ═══════════════════════════════════════════════════════════════════════════════
# THE LEG REGISTRY
#
# One line per leg: id, prerequisites, description, command.  The id is what
# --only takes and what the summary table prints.  A leg that runs several
# cases reports each one, and a case that fails never makes a later one
# unreachable.
# ═══════════════════════════════════════════════════════════════════════════════

# --list reads the registry out of this file; a discovery that finds almost
# nothing is a red, not an empty list
list_legs() {
    awk '/^[[:space:]]*leg[[:space:]]+[a-z0-9-]+[[:space:]]/ {
             id = $2; needs = $3;
             desc = "";
             if (match($0, /"[^"]*"/)) desc = substr($0, RSTART + 1, RLENGTH - 2);
             printf "  %-22s %-18s %s\n", id, needs, desc
         }' "$1"
}
# How many legs the registry declares for a tier.  The summary compares what it
# accounted for against this: see the coverage check at the end for why.
count_legs() {   # count_legs <file> <quick|full>
    awk -v tier="$2" '
        /^if \[ "\$QUICK_ONLY" = "0" \]; then$/ { full_section = 1 }
        /^[[:space:]]*leg[[:space:]]+[a-z0-9-]+[[:space:]]/ {
            if (tier == "full" || !full_section) n++
        }
        END { print n+0 }' "$1"
}

if [ "$LIST" = "1" ]; then
    list_legs "$0"
    n=$(list_legs "$0" | wc -l)
    echo "  ($n legs)"
    if [ "$n" -lt 20 ]; then
        echo "  FAIL --list: discovered only $n legs; the registry is larger than that" >&2
        exit 1
    fi
    exit 0
fi

# An --only id the registry does not declare would be silently skipped, and
# the run would pass on the legs that were left.
if [ "${#ONLY[@]}" -gt 0 ]; then
    KNOWN_IDS=" $(list_legs "$0" | awk '{print $1}' | tr '\n' ' ') "
    for o in "${ONLY[@]}"; do
        case "$KNOWN_IDS" in
            *" $o "*) ;;
            *) echo "unknown leg for --only: $o (see --list)" >&2; exit 2 ;;
        esac
    done
fi

echo "webdoom suite — tier: $TIER${ONLY+ }${ONLY[*]-}"
echo "logs: $LOGDIR"

# ── tier: quick ──────────────────────────────────────────────────────────────
# Everything here runs on a bare clone: no WADs, no build, no browser.  This is
# the tier a public CI can actually run.
# Lint is two legs so a host without the pinned clang-format, public CI among
# them, still runs the JS half as a real gate and reports the C half as a
# counted SKIP with its reason.
leg lint-js         -        "JS syntax + pipe-exit rule + exec bits" -- bash tools/lint.sh --js-only
leg lint-c          clangfmt "clang-format over the web layer"        -- bash tools/lint.sh --c-only --require-c
leg archaeology     gcc  "every derived engine figure reproduces from its script" -- node tools/archaeology/run.mjs
leg docs            -    "doc links resolve; spec's named gates are legs" -- node tools/check-docs.mjs
leg sw-precache     -    "sw.js SHELL list <-> app-shell imports"   -- node tools/check-sw-precache.mjs
leg sw-wad-stream   -    "sw.js streams a WAD and caches it behind; an update keeps the launcher's API reads; a loader gets only its own module" -- node tools/sw-wad-stream-test.mjs
leg audio-stop-race -    "audio stopped while arming starts nothing afterwards" -- node tools/audio-stop-race-test.mjs
leg http-fuzz       -    "static HTTP path attacks"                -- node tools/http-fuzz-test.mjs
leg demo-store-fuzz -    "demo-store cap enforcement"               -- node tools/demo-store-fuzz-test.mjs
leg net-fuzz        -    "malformed/hostile WebSocket clients"      -- node tools/net-fuzz-test.mjs
# web.h is the core<->platform contract spec.md tenet 5 points a bare-metal port
# at, so it must declare what the build exports.
leg web-contract    -    "web.h matches the exports it declares"      -- node tools/web-contract-check.mjs
# The registry's bound, and MAXWEBFILES, which is written on both sides of the
# wire (files.c and lobby.js).
leg web-registry    build "the file registry refuses past its cap"       -- node tools/web-registry-test.mjs
# COLORS, CMD_SIZE, MAXPLAYERS, FRAGMENT_MAX and MAXWEBFILES each exist twice,
# once on each side of the wire.
leg wire-constants  -     "cross-wire constants agree on both sides"    -- node tools/check-wire-constants.mjs
# The launcher may not offer a game that can never load: a GAME_ORDER entry
# absent from the manifest, or one the importer refuses.
leg menu-reachable  -    "no GAME_ORDER entry is unreachable"         -- node tools/check-menu-reachable.mjs
# README says webdoom.service is a ready systemd unit.  `systemd-analyze
# verify` alone cannot be the check: on a good unit it exits 0 and prints
# nothing, so it cannot tell a sound unit from a dead check.
leg service-file    systemd  "webdoom.service is a ready unit" -- bash tools/service-check.sh
# deploy.sh restarts whatever tree the unit's WorkingDirectory names, so it
# must refuse to be run from any other; driven through --check only, against a
# stub systemctl.
leg deploy-check    -        "deploy.sh --check: right tree, package files, everyone connected" -- node tools/deploy-check-test.mjs
# The floor gate (tools/floor): the verdict a bare-metal target is graded by.
# Its red-proofs run on synthetic logs built from the goldens, so a bare clone
# can run them.
leg floor-gate-self -        "floor gate passes a good run, fails each way a log can lie" -- node tools/floor/floor-gate-test.mjs

if [ "$TIER" = "quick" ]; then
    QUICK_ONLY=1
else
    QUICK_ONLY=0
fi

if [ "$QUICK_ONLY" = "0" ]; then

# ── artifacts under test are current with their sources ───────────────────
leg freshness       build      "build/ + native refs not older than sources" -- node tools/artifact-freshness.mjs --all
leg size-budget     build      "doom.wasm, synth.wasm, __heap_base and page load under their ceilings" -- node tools/size-budget.mjs

# ── engine boots and makes sound ─────────────────────────────────────────────
# callMain([]) and the attract loop at wall-clock pacing, the path a browser
# takes; the demo goldens replay under -timedemo and do not cover it.
leg smoke-iwads     build,wad  "boots doom.wad (700 frames) and doom2.wad (1100) headless" -- node tools/smoke-test.mjs doom.wad 700 doom2.wad 1100
# The demo goldens cover the four demo-bearing IWADs; this covers the other 24
# entries in wads/manifest.json -- SIGIL, NRFTL, Chex Quest and the 20 Master
# Levels -- so a shipped WAD that fails to load is not found by a player.  The
# target list is derived from the manifest.
leg smoke-pwad      build,wad  "24 ungated library WADs boot and render" -- node tools/smoke-pwad-test.mjs
leg opl-mode        build,wad  "OPL2 byte-identical to ref; OPL3 RMS"  -- node tools/opl-mode-test.mjs doom.wad

# ── the sim-safety gate: an assert names the broken invariant at its call site,
#    which a golden diff cannot do.  It runs BEFORE the goldens for that reason.
leg build-invariants emsdk     "compile -DWEBDOOM_INVARIANTS"          -- bash tools/build-toggle.sh WEBDOOM_INVARIANTS build-invariants
# --sim-drawn, not -nodraw: this is the only leg on the armed build, and
# DOOM_ASSERT(doom_in_render_path == 0), the assert that catches render->sim
# contamination, can only fire in a process where the renderer executes.
# --fractic pins the interpolation fraction, which -timedemo otherwise
# saturates at FRACUNIT (see demo-test.mjs).
leg sim-invariants   wad,fresh-invariants     "13 demos, armed asserts, renderer running, freelook + interpolation active" -- node tools/demo-test.mjs --sim-drawn --smooth --fractic 32768 --pitch 40 --build-dir build-invariants

# ── differential + goldens ───────────────────────────────────────────────────
leg fuzz-diff       native,wad,heavy "20 mutated demos: wasm == native"      -- node tools/fuzz/run-fuzz.mjs --seeds 20 --parallel 8 --require-native
leg sim-goldens     build,wad  "13 demos, per-tic gamestate hashes"    -- node tools/demo-test.mjs
leg render-goldens  build,wad  "13 demos, per-tic framebuffer hashes"  -- node tools/demo-test.mjs --render
leg render-low      build,wad  "low-detail render goldens"            -- node tools/demo-test.mjs --render --low-detail
# spec.md promises freelook and interpolation are render-side and cannot reach
# the playsim; this proves it on the shipping artifact.
leg sim-freelook    build,wad  "13 demos, freelook active, playsim untouched" -- node tools/demo-test.mjs --sim-drawn --pitch 40


# ── sanitizers, the freestanding core, the shipped demo-verify CLI ───────────
# README.md advertises the native ASan/UBSan demo suite as part of the gate
# set, and the freestanding 13/13 check is the proof for rung 1.
# demo-verify-test imports the CLI's logic; demo-verify-cli runs the CLI
# itself, so its argv handling, --all mode and size cap are gated too.
leg native-asan     native,wad,heavy "13 demos under ASan/UBSan (README's claim)"  -- bash tools/native-sanitize/run-all.sh wads/lib tools/native-sanitize/out sim
leg freestanding-sim fs,wad    "fs-doom 13/13 == vanilla (rung 1 proof)"     -- bash tools/freestanding/run-check.sh
# its own out dir: under --jobs it runs beside freestanding-sim, and the two
# must not write per-demo JSON into one directory
leg ro-wad          fs,wad     "WAD blob stays read-only over 13 demos (XIP)" -- bash tools/freestanding/ro-wad-check.sh wads/lib tools/freestanding/out-ro
# The demand every bare-metal target is measured against: fs-doom through the
# floor gate, correctness (sim + render hashes) and x86 instructions per tic.
leg floor-x86       fs,wad     "floor gate on the host: 13 demos correct, worst graded tic" -- bash tools/floor/run-x86.sh
# The demand vector (tools/golden/floor-demand.json): each demo's worst graded
# tic must stay the same tic, within 1%.  And the smallest zone that renders
# all 13 demos correctly with audio running, 1216 KiB (bisected by
# zone-min.mjs), must still be the boundary: 1216 passes, 1212 fails.
leg floor-demand    fs,wad     "demand vector: same worst tic per demo, within 1%" -- node tools/floor/demand.mjs --check
leg zone-min        fs,wad     "smallest zone with rendering is still 1216 KiB"     -- node tools/floor/zone-min.mjs --check 1216
# The floor's music reference off the web: the OPL synth compiled natively
# (tools/freestanding/synth-bench, built by the leg) renders what synth.wasm
# renders, byte for byte, on the 13 demos' songs, and its register streams and
# samples match tools/floor/synth-ref.json, which every port is graded on.
leg synth-native    gcc,build,wad,heavy "native OPL synth == synth.wasm on 13 demo songs (OPL2/OPL3, 3 rates, -O1/-O2); L1/L2 references" -- node tools/synth-native-test.mjs
# The synth's exact savings (engine/web/opl3.c, "WEBDOOM: EXACT SAVINGS") held
# to the core as it was before them (tools/floor/opl3-ref), frame by frame:
# every music score in the four IWADs, OPL2 and OPL3, at 49,716 and 44,100 Hz,
# each whole, plus random register streams; four inexact variants must fail.
leg synth-exact     gcc,wad,heavy "OPL synth == its pre-savings reference: 137 IWAD scores x OPL2/OPL3 x 2 rates, fuzz; 4 inexact variants caught" -- node tools/synth-exact-test.mjs
# The same demand on the floor's candidate ISAs (tools/cortexm): engine/core
# with newlib on qemu's Cortex-M boards, no OS, the WAD read by semihosting.
# Each run first proves its instrument on the board (1e6/2e6-instruction
# loops, the unaligned trap, the WAD window's BusFault, the painted stack),
# then grades 13 demos, sim + render, through the floor gate.  Instructions
# under -icount are demand, not time: the verdict is DEMAND, never PASS.
leg armv6m-qemu     qemucm,wad,heavy "Cortex-M0+ code (ARMv6-M, mps2-an385): 13 demos correct, instructions per tic" -- bash tools/cortexm/run-floor.sh armv6m
leg armv8m-qemu     qemucm,wad,heavy "Cortex-M33 code (ARMv8-M, mps2-an505): 13 demos correct, instructions per tic" -- bash tools/cortexm/run-floor.sh armv8m
# The ARM reference.  wasm is architecture-independent, so only a native build
# tests ARM codegen, ABI and alignment; emulated cycles are not hardware
# cycles, so this gates correctness, not timing.  zig cross-builds the
# freestanding core for 32-bit ARM and qemu-arm-static replays all 13 golden
# demos.
leg arm-cross       zig,qemuarm,wad "freestanding core 13/13 on 32-bit ARM" -- bash tools/freestanding/arm-check.sh
# The big-endian leg.  tools/freestanding/be-check.sh defaults to PowerPC, the
# target docs/bare-metal.md cites; arm-check.sh execs the same script with
# little-endian ARM32 overrides, so only this leg tests byte order.  It is the
# cheap big-endian cover; n64-demos is the other, at about 7 minutes.
leg be-cross        zig,qemuppc,wad "freestanding core 13/13 on big-endian PowerPC" -- bash tools/freestanding/be-check.sh
# RISC-V, through the same be-check.sh: RV32IMAC soft-float (the candidate
# boards' RISC-V cores have no FPU, so tables.c's libm runs in software) and
# RV32GC, 13/13 per-tic sim hashes each under qemu-riscv32-static.
leg rv32-cross      zig,qemurv,wad "freestanding core 13/13 on RV32IMAC (soft-float) and RV32GC" -- bash tools/freestanding/rv32-check.sh
# The N64 rung of the same argument, and the strongest one: a 93.75 MHz
# big-endian MIPS console, a 12.4 MB WAD read in place out of cartridge space,
# and the whole 44,580-tic golden set reproduced bit-for-bit.  It is the
# longest leg by a wide margin (--no-slow skips it) and it is in the suite
# because a gate nobody runs rots.
leg n64-demos       n64,wad,slow,heavy "13/13 demo sim-hashes on emulated N64 (~8 min)" -- bash tools/n64/run-n64-demos.sh
# The N64 in render mode: the same 13 demos with the renderer running every
# tic (no -nodraw), each tic's sim AND render hash held to the goldens through
# floor-gate --correctness, which can only say CORRECT or FAIL.  n64-demos is
# the simulation alone; floor-x86 is the host.  Its timing (mode B, COUNT per
# tic) is evidence, not this leg: tools/floor/run-n64.sh without --correctness.
# Own out and work directories, so a full floor run's logs are never wiped.
leg n64-floor       n64,wad,slow,heavy "13/13 demos rendered on emulated N64: sim + render hash every tic" -- bash tools/floor/run-n64.sh --correctness --out tools/floor/out-n64-correct --work tools/n64/n64_floor_work-correct
leg demo-verify-cli build,wad  "the shipped demo-verify CLI itself, --all mode" -- node tools/demo-verify.mjs --all

# ── netcode determinism ──────────────────────────────────────────────────────
leg net-2p          build,wad  "2 real wasm clients through the relay" -- node tools/net-test.mjs 2
leg net-4p          build,wad  "4 real wasm clients through the relay" -- node tools/net-test.mjs 4
leg join-coop       build,wad  "drop-in determinism, co-op"            -- node tools/join-test.mjs
leg join-dm         build,wad  "drop-in determinism, deathmatch"       -- node tools/join-test.mjs dm
leg spectate        build,wad  "spectator catch-up determinism"        -- node tools/spectate-test.mjs
leg spectate-inject build,wad  "spectator injection is a no-op"        -- node tools/spectate-inject-test.mjs
# `spectate` proves an observer re-simulates the identical world and
# `spectate-inject` proves it cannot write ticcmds; this drives the spectate
# path with malformed and abusive clients, so every resource cap on it --
# MAX_SPECTATORS, maxPayload, the history-cap refusal, the close-handler
# bookkeeping -- is asserted.
leg spectate-fuzz   build,wad  "hostile clients against /ws/spectate" -- node tools/spectate-fuzz-test.mjs
leg edge            build,wad  "drop-in edge cases"                    -- node tools/edge-test.mjs
leg churn           build,wad  "connect/disconnect churn"              -- node tools/churn-test.mjs
leg net-hidden      build,wad  "a hidden tab survives 3 s in lockstep; told when dropped" -- node tools/net-hidden-test.mjs
leg net-reborn      build,wad  "a drop-in after a level change spawns as a first spawn" -- node tools/net-reborn-test.mjs
leg launch-args     build,wad  "RULES reach the engine; hostile launch params are refused" -- node tools/launch-args-test.mjs

# ── demo tooling ─────────────────────────────────────────────────────────────
leg demo-seek       build,wad  "scrubber seek == linear replay"        -- node tools/demo-seek-test.mjs
leg demo-verify     build,wad  "13 goldens + doctored + hostile"        -- node tools/demo-verify-test.mjs
leg save-compat     build,wad  "savegames written by 2a6a2de load and replay identically" -- node tools/save-compat-test.mjs
leg demo-replay     build,wad  "13 IWAD demos through web_play_demo_buf, seek, -fast, two-player" -- node tools/demo-replay-test.mjs

# ── tenet 4: the sanitizer IS the gate ───────────────────────────────────────
leg adversarial-map native,wad,heavy "30 adversarial maps, 0 ASan/UBSan reports; 36 bad-geometry maps refused at load" -- node tools/fuzz/run-map-fuzz.mjs --adversarial-gate

# The other direction: every other fuzz gate points a hostile CLIENT at the
# server; this points a hostile SERVER at the engine.
leg hostile-server  build,wad  "hostile server frames vs the engine" -- node tools/hostile-server-test.mjs
# The same direction, one layer up: hostile-server points a hostile server at
# the ENGINE, this one at the lobby's JSON path.  Needs no WAD and no build: it
# drives client/js/net.js directly against a fake server.
leg hostile-lobby   -          "hostile server frames vs the lobby client"  -- node tools/hostile-lobby-test.mjs
# Hostile lump CONTENT.  wad-import.js validates a WAD's directory, not what is
# inside a lump, and a PWAD lump overrides the IWAD's, so an imported WAD can
# hand the engine any bytes under a known name.
leg wad-content-fuzz build,wad "hostile GENMIDI/MUS/TEXTURE1 lump payloads" -- node tools/wad-content-fuzz-test.mjs
# Limits only a purpose-built map reaches (tools/lib/mapkit.mjs: one
# subsector, no node builder), each through the loader and a demo.
leg crafted-maps    build,wad  "purpose-built maps reach engine limits through a demo" -- node tools/fuzz/crafted-maps.mjs
# The web layer's own entry points (input, state hash, argv) with what a page
# script, a corrupted client or a hostile server could pass them.
leg hostile-calls   build,wad  "web entry points refuse hostile arguments" -- node tools/hostile-calls-test.mjs

# ── browser suite ────────────────────────────────────────────────────────────
# One shared server for the legs that only need a page to load.  Started once,
# torn down by the single EXIT trap, readiness polled rather than slept.  The
# shared server is a prerequisite (`shared`) like any other, so on a host
# without Chrome, a build or the IWADs each leg reports its own SKIP with its
# own reason, and the coverage check at the end asserts the total against the
# registry.
if [ "${#ONLY[@]}" -eq 0 ] || printf '%s\n' "${ONLY[@]}" | grep -q '^browser-\|^persist$'; then
    U=http://127.0.0.1:8668/
    if have_browser && have_build && have_wad; then
        if [ "$JOBS" -gt 1 ]; then
            # each browser leg gets its own server when it launches: two legs
            # on one lobby would see each other's games
            U=__SHARED_URL__; SHARED_UP=1
        elif serve_start 8668; then SHARED_UP=1; else
            echo "  note: shared browser server on 8668 did not start — the legs below will each SKIP"
        fi
    fi
    leg browser-sp            browser,build,wad,shared "title -> menu -> new game -> movement" -- node tools/browser-test.mjs "$U"
    leg browser-net           browser,build,wad,shared "2 tabs through the lobby into co-op"   -- node tools/browser-net-test.mjs "$U"
    leg browser-join          browser,build,wad,shared "browser drop-in"                       -- node tools/browser-join-test.mjs "$U"
    leg persist               browser,build,wad,shared "settings/keybind persistence"          -- node tools/persist-test.mjs "$U"
        # The third direction of tenet 4: localStorage and the rebind UI are
        # user input.
    leg browser-options       browser,build,wad,shared "hostile localStorage + the OPTIONS screen" -- node tools/browser-options-test.mjs "$U"
    leg browser-resilience    browser,build,wad,shared "fetch/sw/visibility/gamepad failures" -- node tools/browser-resilience-test.mjs "$U"
    leg browser-boot-abort    browser,build,wad,shared "a session ended mid-boot leaves nothing running" -- node tools/browser-boot-abort-test.mjs "$U"
    leg browser-pwad-session  browser,build,wad,shared "a PWAD game keeps its own saves and demo links" -- node tools/browser-pwad-session-test.mjs "$U"
        # The analog half of the controls.  browser-resilience covers hotplug
        # only; this drives a synthetic pad through the deadzone curve and the
        # axis mapping and reads what the ENGINE's own web_gamepad entry point
        # receives -- the same boundary browser-options uses for a rebound key.
    leg browser-gamepad       browser,build,wad,shared "analog twin-stick reaches the engine" -- node tools/browser-gamepad-test.mjs "$U"
    leg browser-lobby         browser,build,wad,shared "lobby state machine, 25 edges"         -- node tools/browser-lobby-test.mjs "$U"
    leg browser-fire          browser,build,wad,shared "PSX fire background + reduced-motion"  -- node tools/browser-fire-test.mjs "$U" /tmp
    leg browser-ierror        browser,build,wad,shared "I_Error surfaces, no wedge"            -- node tools/browser-ierror-test.mjs "$U"
    leg browser-rafdeath      browser,build,wad,shared "rAF death recovery"                    -- node tools/browser-rafdeath-test.mjs "$U"
    # The same gate at the other injection point: the palette read and the GL
    # draw are inside the frame loop's try as well as _web_frame, and a throw
    # from either must end the session too.
    leg browser-rafdeath-draw browser,build,wad,shared "rAF death recovery, draw path"         -- node tools/browser-rafdeath-test.mjs "$U" --inject _web_palette_version
    leg browser-wadimport     browser,build,wad,shared "user WAD import"                       -- node tools/browser-wadimport-test.mjs "$U"
    leg browser-mp-gating     browser,build,wad,shared "local-WAD MP gating"                   -- node tools/browser-mp-gating-test.mjs "$U"
    leg browser-offline       browser,build,wad,shared "offline single player"                 -- node tools/browser-offline-test.mjs
    leg browser-demo          browser,build,wad,shared "demo permalink replay"                  -- node tools/browser-demo-test.mjs "$U"
        # On a secure origin the worklet instantiates build/synth.wasm and the
        # main thread renders no music at all (the BufferSink fallback, where
        # there is no AudioWorklet, is browser-insecure's).  It
        # cannot assert audio was PRODUCED -- no audio device pulls the graph
        # headless or under xvfb -- so the samples are gated by opl-mode's
        # gate 7, which drives the shipped worklet file in node.
    leg browser-music-worklet browser,build,wad,shared "worklet owns the synth; main thread renders none" -- node tools/browser-music-worklet-test.mjs "$U"
        # play -> quit -> play must accumulate nothing.  Measured
        # across three cycles: growth that repeats per cycle is a leak, a one-off
        # difference is not.
    leg browser-teardown  browser,build,wad,shared "play->quit->play x3 leaks nothing"      -- node tools/browser-teardown-test.mjs "$U"
    [ "$SHARED_UP" = "1" ] && [ "$JOBS" -le 1 ] && serve_stop_all
fi

# These start their own servers, so they need no shared one.
leg browser-insecure browser "real insecure origin: IDB WAD cache + music fallback" -- node tools/browser-insecure-test.mjs
# Every browser leg launches Chrome through tools/chrome-harness.mjs; this one
# asserts a launch leaves nothing in the temp directory and sweeps only the
# profiles no live leg can be using.
leg chrome-harness  browser "a Chrome launch leaves no temp files; the sweep takes only stale profiles" -- node tools/chrome-harness-test.mjs
# "Second load is instant": a regression gate against a baseline committed per
# host -- a host without one SKIPs by name, as browser-pipeline does.
leg load-budget     browser,loadbudget,build,wad,alone "warm load within this host's budget" -- node tools/load-budget-test.mjs
leg browser-pipeline browser,baseline,alone "per-frame JS/GPU cost vs this host's baseline" -- bash tools/pipeline-gate.sh
# The server's request log shows a Firefox UA fetched the page and its JS asked
# for /api/wads; then the leg asserts a rendered frame.  Firefox 155
# does not speak CDP at all (--remote-debugging-port serves WebDriver BiDi,
# /json/list 404s), so this drives BiDi. It runs under Xvfb, NOT --headless:
# measured here, headless Firefox reports webgl2:false AND webgl1:false, the client
# falls back to createRenderer2D, and the gate would prove a path no user takes.
# The kind==='webgl2' assertion is what stops that drift passing silently.
leg firefox-frame   firefox,xvfb,build,wad "Firefox renders a real frame via WebGL2" -- node tools/firefox-frame-test.mjs

# ── the perf gate (spec.md §Correctness gates) ───────────────────────────────
#
# spec.md requires "bench.mjs per-stage numbers on the three live reference
# hosts; regressions on any host block".  --check is what makes it a gate
# rather than a recorder: fleet-bench.sh otherwise ends by rewriting
# tools/golden/bench-baseline.json, and a gate that rewrites its own reference
# to match what it just measured cannot fail.
leg perf-fleet      perf,build,wad,alone "per-stage render ms on alder+wbox+tank vs baseline" -- bash tools/fleet-bench.sh --check

fi   # QUICK_ONLY

[ "$JOBS" -gt 1 ] && run_queue

# ═══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════
# rows land in completion order under --jobs; the table is registry order
ORDERED="$LOGDIR/ordered.tsv"
for id in ${ORDER[@]+"${ORDER[@]}"}; do grep -m1 "^$id"$'\t' "$SUMMARY" || true; done > "$ORDERED"
[ -n "$KEEP_LOGS" ] && cp "$ORDERED" "$KEEP_LOGS/summary.tsv"
echo
echo "══════════════════════════════════════════════════════════════════════════════"
printf '  %-22s %-11s %5s  %s\n' LEG VERDICT SECS "WHAT IT REPORTED"
echo "  ────────────────────────────────────────────────────────────────────────────"
while IFS=$'\t' read -r id verdict secs note; do
    printf '  %-22s %-11s %5s  %s\n' "$id" "$verdict" "$secs" "$note"
done < "$ORDERED"
echo "  ────────────────────────────────────────────────────────────────────────────"

# ── persist the per-leg table ────────────────────────────────────────────────
# the only per-leg timing this project produces; kept beside the failing logs.
# Only a whole-tier run writes it, so an --only run cannot pass off a handful
# of legs as the tier.
ELAPSED=$(( $(date +%s) - SUITE_T0 ))
if [ "${#ONLY[@]}" -eq 0 ]; then
    mkdir -p "$REPO/tools/.suite-logs"
    {
        printf '# webdoom suite — %s, tier %s, host %s, jobs %s, %d s\n' "$(date -Is)" "$TIER" "$(hostname)" "$JOBS" "$ELAPSED"
        printf '# leg\tverdict\tsecs\theadline\n'
        cat "$ORDERED"
    } > "$REPO/tools/.suite-logs/last-run.tsv" 2>/dev/null || true
fi

TOTAL=$((PASSED + FAILED + SKIPPED))
printf '  %d legs: %d passed, %d failed, %d skipped  (tier: %s, jobs: %s, %d min %d s)\n' \
       "$TOTAL" "$PASSED" "$FAILED" "$SKIPPED" "$TIER" "$JOBS" "$((ELAPSED / 60))" "$((ELAPSED % 60))"
if [ "$NOTES" -gt 0 ]; then
    printf '  %d note(s) — something could not be verified:\n' "$NOTES"
    printf '    %s\n' "${NOTE_TEXT[@]}"
fi
[ "${#ONLY[@]}" -eq 0 ] && printf '  per-leg timings: tools/.suite-logs/last-run.tsv\n'

# A run that executed no legs is not a pass.
if [ "$TOTAL" -eq 0 ]; then
    echo "  SUITE VACUOUS: 0 legs ran — check --only ids against --list"
    exit 1
fi

# A leg named with --only that this tier never reached (a full-tier leg under
# --quick) did not run, so the run cannot pass on it.
if [ "${#ONLY[@]}" -gt 0 ]; then
    for o in "${ONLY[@]}"; do
        reached=0
        for id in "${ORDER[@]}"; do [ "$id" = "$o" ] && reached=1; done
        if [ "$reached" = 0 ]; then
            echo "  SUITE COVERAGE: --only $o was never reached in the $TIER tier"
            exit 1
        fi
    done
fi

# ── coverage: does the total account for the whole registry? ─────────────────
# TOTAL only says how many legs were reached; the registry says how many there
# are, and a leg that neither ran, failed nor skipped is a red.  --only is the
# one case where a shortfall is the point.
if [ "${#ONLY[@]}" -eq 0 ]; then
    REGISTRY=$(count_legs "$0" "$TIER")
    if [ "$REGISTRY" -lt 10 ]; then
        echo "  SUITE COVERAGE BROKEN: registry discovery found only $REGISTRY legs for tier $TIER"
        exit 1
    fi
    if [ "$TOTAL" -ne "$REGISTRY" ]; then
        echo "  SUITE COVERAGE: accounted for $TOTAL of $REGISTRY legs in the $TIER registry" \
             "— $((REGISTRY - TOTAL)) neither ran, failed nor skipped"
        exit 1
    fi
    printf '  coverage: %d of %d registry legs accounted for (tier: %s)\n' "$TOTAL" "$REGISTRY" "$TIER"
fi
if [ "$FAILED" -gt 0 ]; then
    echo "  SUITE FAILED: ${FAILED_IDS[*]}"
    echo "  failing logs kept at tools/.suite-logs/<leg>.log"
    exit 1
fi
if [ "$SKIPPED" -gt 0 ]; then
    # Never the word "pass" on its own when legs did not run.
    echo "  SUITE INCOMPLETE: $PASSED passed, $SKIPPED skipped (reasons above)"
    [ "$REQUIRE_COMPLETE" = "1" ] && { echo "  --require-complete: a skip is a failure"; exit 1; }
    exit 0
fi
echo "  ALL $PASSED LEGS PASS"
