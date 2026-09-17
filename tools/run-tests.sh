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
#   tools/run-tests.sh --jobs N        # N legs at a time (round 10); 1 = serial
#   tools/run-tests.sh --list          # print the leg registry and exit
#   tools/run-tests.sh --require-complete   # a SKIP is a failure
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
while [ $# -gt 0 ]; do
    case "$1" in
        --quick)            TIER=quick; shift ;;
        # legs run N at a time, each on its own server and port; a leg tagged
        # `alone` (CPU-heavy or timing-graded) drains the pool first
        --jobs)             JOBS="$2"; shift 2 ;;
        # opt-in because it reaches other machines (~30 s), not because it is
        # slow; it SKIPs, named and counted, in the default run
        --perf)             PERF=1; shift ;;
        # n64-demos is ~7 min of the run; --no-slow is for iterating, and the
        # leg still SKIPs named and counted (--require-complete still fails)
        --no-slow)          NO_SLOW=1; shift ;;
        --full)             TIER=full; shift ;;
        --only)             ONLY+=("$2"); shift 2 ;;
        --list)             LIST=1; shift ;;
        --require-complete) REQUIRE_COMPLETE=1; shift ;;
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
                 [ "$(clang-format --version | grep -oE '[0-9]+' | head -1)" = "22" ]; }
have_qemuarm() { command -v qemu-arm-static >/dev/null 2>&1; }
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
    [clangfmt]='have_clangfmt|clang-format 22 not present'
    [qemuarm]='have_qemuarm|qemu-arm-static not on PATH'
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
    [slow]='have_notslow|--no-slow given: this leg is ~7 min of the suite'
    [perf]='have_perf|perf tier not requested (run: tools/run-tests.sh --perf; ~30 s measured, needs wbox and tank up)'
    # not a prerequisite: under --jobs the leg runs with the pool drained
    [alone]='true|'
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
# --only takes and what the summary table prints.  Compound legs were split so
# each reports its own verdict — "engine smoke (doom, doom2)" used to be two
# commands under one heading, and the second was unreachable if the first failed.
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

echo "webdoom suite — tier: $TIER${ONLY+ }${ONLY[*]-}"
echo "logs: $LOGDIR"

# ── tier: quick ──────────────────────────────────────────────────────────────
# Everything here runs on a bare clone: no WADs, no build, no browser.  This is
# the tier a public CI can actually run (task 24.3).
# Split so a host without the PINNED clang-format still runs the JS half as a
# real gate, and has the C half reported as a counted SKIP with its reason,
# rather than both folded into one green "lint: OK".  Public CI is exactly
# that host (task 24.3).
leg lint-js         -        "JS syntax + pipe-exit rule + exec bits" -- bash tools/lint.sh --js-only
leg lint-c          clangfmt "clang-format over the web layer"        -- bash tools/lint.sh --c-only --require-c
leg doc-drift       gcc  "doc figures == claims.json == script output" -- bash tools/archaeology/verify-all.sh
leg state-machine   -    "lobby edge<->test coverage (static)"      -- node tools/check-state-machine.mjs
leg sw-precache     -    "sw.js SHELL list <-> app-shell imports"   -- node tools/check-sw-precache.mjs
leg http-fuzz       -    "static HTTP path attacks (ws-005)"        -- node tools/http-fuzz-test.mjs
leg demo-store-fuzz -    "demo-store cap enforcement (19.2)"        -- node tools/demo-store-fuzz-test.mjs
leg net-fuzz        -    "malformed/hostile WebSocket clients"      -- node tools/net-fuzz-test.mjs
# The claims index is both the human inventory and doc-drift's locator table,
# and nothing checked the inventory itself: 50 rows said "verified" while
# nothing anywhere checked them (task 24.2).
leg claims-index    -    "the claims index does not overclaim"        -- node tools/archaeology/claims-index-check.mjs
leg promises-index  -    "the promises index has not gone stale"      -- node tools/archaeology/promises-index-check.mjs
# web.h is the core<->platform contract spec.md tenet 5 points a bare-metal port
# at.  It declared 5 of 73 exports and got one arity wrong (task 25.2).
leg web-contract    -    "web.h matches the exports it declares"      -- node tools/web-contract-check.mjs
# The registry's bound, and MAXWEBFILES, which is written on both sides of the
# wire (files.c and lobby.js) and was asserted by nothing.
leg web-registry    build "file-registry cap + the MAXWEBFILES mirror"  -- node tools/web-registry-test.mjs
# COLORS, CMD_SIZE, MAXPLAYERS, FRAGMENT_MAX and MAXWEBFILES each exist twice,
# once on each side of the wire, and two of them say "mirror of" in a comment.
# Nothing compared them until round 6.
leg wire-constants  -     "cross-wire constants agree on both sides"    -- node tools/check-wire-constants.mjs
leg gate-census     -    "every gate is wired or registered with a reason" -- node tools/gate-census.mjs
# A document may not contradict the project's own record of what is done.  The
# claims machinery checks NUMBERS against code and nothing checked STATUS prose:
# task 24.4's own stale-doc banner said "ZONESIZE is still open" about a change
# that shipped in July (round 5, D2).
leg status-drift    -    "no doc contradicts a landed verdict"        -- node tools/archaeology/status-drift-check.mjs
# 26 documents, 8 linked from README.  A document nobody links is one nobody
# reads, and adding one is when it is cheap to say where it belongs (D5).
leg docs-index      -    "every doc is reachable from docs/README.md" -- node tools/archaeology/docs-index-check.mjs
# The launcher may not offer a game that can never load: hacx.wad sat in
# GAME_ORDER, absent from the manifest and refused by the importer, while
# README advertised it as part of the shipped library (E1).
leg menu-reachable  -    "no GAME_ORDER entry is unreachable"         -- node tools/check-menu-reachable.mjs
# rme-009: README:41 says webdoom.service is a ready systemd unit and nothing
# checked it -- no boot test, no file validation, not one assertion.
# `systemd-analyze verify` alone would be a quiet exit-0: on a good unit it
# exits 0 and prints NOTHING, so it cannot tell a sound unit from a dead check.
leg service-file    systemd  "webdoom.service is a ready unit (rme-009)" -- bash tools/service-check.sh

if [ "$TIER" = "quick" ]; then
    QUICK_ONLY=1
else
    QUICK_ONLY=0
fi

if [ "$QUICK_ONLY" = "0" ]; then

# ── artifacts under test are current with their sources (21.4/21.5) ──────────
leg freshness       build      "build/ + native refs not older than sources" -- node tools/artifact-freshness.mjs --all
leg size-ledger     build      "doom.wasm budget + README KB three-way"      -- node tools/archaeology/size-ledger.mjs
# prf-002/003: perf.md published "177.7 KB gzip" total and "35 KB" for the JS
# surface, both marked *not machine-verified*, and perf-015/016 sat "unverifiable"
# in claims.json. Nothing recomputed them for months: the surface measured 2.5x
# its documented figure, and the per-file table still listed a file round 7 deleted.
leg payload-size    build      "page-load wire cost vs budget (prf-002/003)"  -- node tools/payload-size.mjs
# perf-009 (__heap_base) is a HARD check that no suite leg had ever run: the
# measurement-stamp family is --full only, and the doc-drift leg calls
# verify-all.sh with no arguments.  It drifted 48 B unnoticed before round 7
# moved it on purpose.  --require-complete is what stops this leg printing green
# for a run that skipped the families it exists to execute.  fresh-perf is not
# decoration either: `build` means the artifact is PRESENT, not CURRENT.
leg stamp-full      build,fresh-perf  "verify-all --full: +30 measurement-stamp and runtime-stat claims" -- bash tools/archaeology/verify-all.sh --full --require-complete

# ── engine boots and makes sound ─────────────────────────────────────────────
leg smoke-doom      build,wad  "boots doom.wad headless, 700 frames"   -- node tools/smoke-test.mjs doom.wad 700
leg smoke-doom2     build,wad  "boots doom2.wad headless, 1100 frames" -- node tools/smoke-test.mjs doom2.wad 1100
# rme-008: the demo goldens cover the four demo-bearing IWADs. The other 24
# entries in wads/manifest.json -- SIGIL, NRFTL, Chex Quest and the 20 Master
# Levels -- had no automated test of any kind, so a shipped WAD that failed to
# load would have been found by a player. Target list derived from the manifest.
leg smoke-pwad      build,wad  "24 ungated library WADs boot and render (rme-008)" -- node tools/smoke-pwad-test.mjs
leg opl-mode        build,wad  "OPL2 byte-identical to ref; OPL3 RMS"  -- node tools/opl-mode-test.mjs doom.wad

# ── the sim-safety gate: an assert names the broken invariant at its call site,
#    which a golden diff cannot do.  It runs BEFORE the goldens for that reason.
leg build-invariants emsdk     "compile -DWEBDOOM_INVARIANTS"          -- bash tools/build-toggle.sh WEBDOOM_INVARIANTS build-invariants
# --sim-drawn, not -nodraw: this is the ONLY leg on the armed build, and until
# round 8 it ran with the renderer switched off -- so DOOM_ASSERT(doom_in_render_path
# == 0), the assert written to catch render->sim contamination, had never once run
# in a process where the renderer executes.  --fractic pins the interpolation
# fraction, which -timedemo otherwise saturates at FRACUNIT (see demo-test.mjs).
leg sim-invariants   wad,fresh-invariants     "13 demos, armed asserts, renderer running, freelook + interpolation active" -- node tools/demo-test.mjs --sim-drawn --smooth --fractic 32768 --pitch 40 --build-dir build-invariants

# ── differential + goldens ───────────────────────────────────────────────────
leg fuzz-diff       native,wad,alone "20 mutated demos: wasm == native"      -- node tools/fuzz/run-fuzz.mjs --seeds 20 --parallel 8 --require-native
leg sim-goldens     build,wad  "13 demos, per-tic gamestate hashes"    -- node tools/demo-test.mjs
leg render-goldens  build,wad  "13 demos, per-tic framebuffer hashes"  -- node tools/demo-test.mjs --render
leg render-low      build,wad  "low-detail render goldens (14.2b)"     -- node tools/demo-test.mjs --render --low-detail
# spc-011: spec.md promises freelook and interpolation are render-side and cannot
# reach the playsim.  sim-wide was the only leg proving that class and it was
# deleted with widescreen.  This is its successor on the shipping artifact.
leg sim-freelook    build,wad  "13 demos, freelook active, playsim untouched (spc-011)" -- node tools/demo-test.mjs --sim-drawn --pitch 40

leg golden-provenance -        "every golden says where it came from"       -- node tools/golden-provenance.mjs --check


# ── gates that existed and ran nowhere until the census (task 21.11) ──────────
# README.md advertises the native ASan/UBSan demo suite as part of the gate set;
# it was run only by hand.  The freestanding 13/13 check calls itself "the
# crown-jewel proof for rung 1" and is cited as a landing gate throughout
# Plans; also hand-run.  demo-verify.mjs is the SHIPPED 19.4 CLI, and its test
# re-implements the logic rather than importing it, so the CLI's own argv
# handling, --all mode and size cap were ungated.
leg native-asan     native,wad,alone "13 demos under ASan/UBSan (README's claim)"  -- bash tools/native-sanitize/run-all.sh wads/lib tools/native-sanitize/out sim
leg freestanding-sim fs,wad    "fs-doom 13/13 == vanilla (rung 1 proof)"     -- bash tools/freestanding/run-check.sh
leg ro-wad          fs,wad     "WAD blob stays read-only over 13 demos (XIP)" -- bash tools/freestanding/ro-wad-check.sh
# The ARM reference, on alder (F4).  spec.md lists pi5 as "ARM reference", but
# what pi5 ran was node bench.mjs against the WASM build -- a performance
# sample, and wasm is architecture-independent, so the ARM row never tested ARM
# codegen, ABI or alignment.  pi5 is also down.  Timings cannot move to alder
# (emulated cycles are not hardware cycles); correctness can, and it is the
# half that was missing.  zig cross-builds the freestanding core for 32-bit ARM
# and qemu-arm-static replays all 13 golden demos.
leg arm-cross       zig,qemuarm,wad "freestanding core 13/13 on 32-bit ARM" -- bash tools/freestanding/arm-check.sh
# The N64 rung of the same argument, and the strongest one: a 93.75 MHz
# big-endian MIPS console, a 12.4 MB WAD read in place out of cartridge space,
# and the whole 44,580-tic golden set reproduced bit-for-bit.  MEASURED 8m19s
# for the 13 demos (23:30:40 -> 23:38:59, 2026-09-11) -- the longest leg in the
# suite by a wide margin, and it is here rather than in the out-of-suite
# registry because it is now green and a gate nobody runs rots.
leg n64-demos       n64,wad,slow,alone "13/13 demo sim-hashes on emulated N64 (~8 min)" -- bash tools/n64/run-n64-demos.sh
leg demo-verify-cli build,wad  "the shipped 19.4 CLI itself, --all mode"     -- node tools/demo-verify.mjs --all

# ── netcode determinism ──────────────────────────────────────────────────────
leg net-2p          build,wad  "2 real wasm clients through the relay" -- node tools/net-test.mjs 2
leg net-4p          build,wad  "4 real wasm clients through the relay" -- node tools/net-test.mjs 4
leg join-coop       build,wad  "drop-in determinism, co-op"            -- node tools/join-test.mjs
leg join-dm         build,wad  "drop-in determinism, deathmatch"       -- node tools/join-test.mjs dm
leg spectate        build,wad  "spectator catch-up determinism (19.5)" -- node tools/spectate-test.mjs
leg spectate-inject build,wad  "spectator injection is a no-op"        -- node tools/spectate-inject-test.mjs
# 23.6's open half. `spectate` proves an observer re-simulates the identical
# world and `spectate-inject` proves it cannot write ticcmds; nothing drove the
# spectate path with malformed or abusive clients, so every resource cap on it
# -- MAX_SPECTATORS, maxPayload, the history-cap refusal, the close-handler
# bookkeeping -- was unasserted.
leg spectate-fuzz   build,wad  "hostile clients against /ws/spectate (23.6)" -- node tools/spectate-fuzz-test.mjs
leg edge            build,wad  "drop-in edge cases"                    -- node tools/edge-test.mjs
leg churn           build,wad  "connect/disconnect churn"              -- node tools/churn-test.mjs

# ── demo tooling ─────────────────────────────────────────────────────────────
leg demo-seek       build,wad  "scrubber seek == linear replay (19.3)" -- node tools/demo-seek-test.mjs
leg demo-verify     build,wad  "13 goldens + doctored + hostile (19.4)" -- node tools/demo-verify-test.mjs

# ── tenet 4: the sanitizer IS the gate ───────────────────────────────────────
leg adversarial-map native,wad,alone "30 adversarial maps, 0 ASan/UBSan reports" -- node tools/fuzz/run-map-fuzz.mjs --adversarial-gate

# The other direction (task 23.8).  Every other fuzz gate points hostile CLIENT
# at the server; this points a hostile SERVER at the engine, which is the
# direction that produced the 23.1 out-of-bounds write and had no coverage.
leg hostile-server  build,wad  "hostile server frames vs the engine (23.8)" -- node tools/hostile-server-test.mjs
# The same direction, one layer up.  23.8 fuzzes a hostile server into the
# ENGINE; nothing fuzzed one into the LOBBY JSON path, where the client did a
# bare JSON.parse on every frame while the server hardened exactly that
# direction on its own side (round 5, B2).  Needs no WAD and no build: it drives
# client/js/net.js directly against a fake server.
leg hostile-lobby   -          "hostile server frames vs the lobby client"  -- node tools/hostile-lobby-test.mjs
# Hostile lump CONTENT.  wad-import.js validates a WAD's directory well;
# nothing validated what is inside a lump, and a PWAD lump overrides the
# IWAD's, so an imported WAD can hand the engine any bytes under a known name.
leg wad-content-fuzz build,wad "hostile GENMIDI/MUS lump payloads (23.2)" -- node tools/wad-content-fuzz-test.mjs

# ── browser suite ────────────────────────────────────────────────────────────
# One shared server for the 16 legs that only need a page to load.  Started
# once, torn down by the single EXIT trap, readiness polled rather than slept.
#
# THE AGGREGATE SKIP THIS REPLACED
# -------------------------------
# These legs used to sit inside `if have_browser && have_build && have_wad`,
# and the else branch emitted ONE row -- `browser-suite SKIP` -- and incremented
# SKIPPED once.  So on a host without Chrome or without IWADs the closing line
# read something like "64 legs: 63 passed, 0 failed, 1 skipped" for a registry
# of 81, and seventeen legs vanished with nothing naming them.  It looked
# exactly like a complete run.
#
# Now the shared server is a PREREQUISITE (`shared`) like any other, so each leg
# reports its own SKIP with its own reason and the count is honest.  The
# coverage check at the end asserts the total against the registry.
if [ "${#ONLY[@]}" -eq 0 ] || printf '%s\n' "${ONLY[@]}" | grep -q '^browser-\|^persist$'; then
    U=http://127.0.0.1:8668/
    if have_browser && have_build && have_wad; then
        if [ "$JOBS" -gt 1 ]; then
            # each browser leg gets its own server when it launches: two legs
            # on one lobby would see each other's games
            U=__SHARED_URL__; SHARED_UP=1
        elif serve_start 8668; then SHARED_UP=1; else
            echo "  note: shared browser server on 8668 did not start — the 16 legs below will each SKIP"
        fi
    fi
    leg browser-sp            browser,build,wad,shared "title -> menu -> new game -> movement" -- node tools/browser-test.mjs "$U"
    leg browser-net           browser,build,wad,shared "2 tabs through the lobby into co-op"   -- node tools/browser-net-test.mjs "$U"
    leg browser-join          browser,build,wad,shared "browser drop-in"                       -- node tools/browser-join-test.mjs "$U"
    leg persist               browser,build,wad,shared "settings/keybind persistence"          -- node tools/persist-test.mjs "$U"
        # The third direction of tenet 4: localStorage and the rebind UI are
        # USER input, and had no gate at all.  Closes the REBIND half of promises
        # rme-004; the analog twin-stick half is still PARTIAL (a headless runner
        # has no stick).  This comment said "closes rme-004" flat, contradicting
        # the promises index, and nothing scans tools/ comments for claims like
        # that -- which is why it survived.
    leg browser-options       browser,build,wad,shared "hostile localStorage + the OPTIONS screen" -- node tools/browser-options-test.mjs "$U"
    leg browser-resilience    browser,build,wad,shared "fetch/sw/visibility/gamepad failures" -- node tools/browser-resilience-test.mjs "$U"
    leg browser-lobby         browser,build,wad,shared "lobby state machine, 25 edges"         -- node tools/browser-lobby-test.mjs "$U"
    leg browser-fire          browser,build,wad,shared "PSX fire background + reduced-motion"  -- node tools/browser-fire-test.mjs "$U" /tmp
    leg browser-ierror        browser,build,wad,shared "I_Error surfaces, no wedge"            -- node tools/browser-ierror-test.mjs "$U"
    leg browser-rafdeath      browser,build,wad,shared "rAF death recovery"                    -- node tools/browser-rafdeath-test.mjs "$U"
    leg browser-wadimport     browser,build,wad,shared "user WAD import (16.6a)"               -- node tools/browser-wadimport-test.mjs "$U"
    leg browser-mp-gating     browser,build,wad,shared "local-WAD MP gating (16.6b)"           -- node tools/browser-mp-gating-test.mjs "$U"
    leg browser-offline       browser,build,wad,shared "offline single player"                 -- node tools/browser-offline-test.mjs
    leg browser-demo          browser,build,wad,shared "demo permalink replay (19.2)"          -- node tools/browser-demo-test.mjs "$U"
        # The old runner gave this its own server on 8669 "per the 12.2b
        # stale-server lesson".  That lesson was about a STALE server being
        # picked up; this runner starts its own, polls it ready and tears it
        # down from one trap, so the shared secure-context server is fine and
        # the test itself only patches audioWorklet client-side.
    leg browser-music-fallback browser,build,wad,shared "BufferSink fallback, audioWorklet=undefined" -- node tools/browser-music-fallback-test.mjs "$U"
        # play -> quit -> play must accumulate nothing (task 23.7b).  Measured
        # across three cycles: growth that repeats per cycle is a leak, a one-off
        # difference is not.
    leg browser-teardown  browser,build,wad,shared "play->quit->play x3 leaks nothing"      -- node tools/browser-teardown-test.mjs "$U"
    [ "$SHARED_UP" = "1" ] && [ "$JOBS" -le 1 ] && serve_stop_all
fi

# These three own their servers (dedicated ports, per the 12.2b stale-server
# lesson), so they are ordinary legs.
leg browser-insecure browser "real insecure origin: IDB WAD cache + music fallback" -- node tools/browser-insecure-test.mjs
# rme-005: "second load is instant". The offline half is gated; "instant" was a
# performance claim with no gate. This is a REGRESSION gate against a baseline
# committed per host -- a host without one SKIPs by name, as browser-pipeline does.
leg load-budget     browser,loadbudget,build,wad,alone "warm load within this host's budget (rme-005)" -- node tools/load-budget-test.mjs
leg browser-pipeline browser,baseline,alone "per-frame JS/GPU cost vs this host's baseline" -- bash tools/pipeline-gate.sh
leg firefox-smoke    firefox "Firefox UA executes JS and fetches /api/wads" -- bash tools/firefox-smoke.sh
# rme-002: firefox-smoke proves the HTML parsed and JS ran; it asserts NO frame.
# Firefox 155 does not speak CDP at all (--remote-debugging-port serves WebDriver
# BiDi, /json/list 404s), so this drives BiDi. It runs under Xvfb, NOT --headless:
# measured here, headless Firefox reports webgl2:false AND webgl1:false, the client
# falls back to createRenderer2D, and the gate would prove a path no user takes.
# The kind==='webgl2' assertion is what stops that drift passing silently.
leg firefox-frame   firefox,xvfb,build,wad "Firefox renders a real frame via WebGL2 (rme-002)" -- node tools/firefox-frame-test.mjs

# ── the perf gate (spec.md §Correctness gates) ───────────────────────────────
#
# spec.md:55-57 has required this since it was written -- "bench.mjs per-stage
# numbers on the three live reference hosts; regressions on any host block" --
# and there was no leg at all.  Neither bench.mjs nor fleet-bench.sh appeared
# in this file, and gate-census's name heuristic could not see either, so
# nothing could even report them as orphaned.
#
# --check is what makes it a gate rather than a recorder: fleet-bench.sh
# normally ENDS by rewriting tools/golden/bench-baseline.json, and a gate that
# rewrites its own reference to match what it just measured cannot fail.
leg perf-fleet      perf,build,wad,alone "per-stage render ms on alder+wbox+tank vs baseline" -- bash tools/fleet-bench.sh --check

fi   # QUICK_ONLY

[ "$JOBS" -gt 1 ] && run_queue

# ═══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════
# rows land in completion order under --jobs; the table is registry order
ORDERED="$LOGDIR/ordered.tsv"
for id in ${ORDER[@]+"${ORDER[@]}"}; do grep -m1 "^$id"$'\t' "$SUMMARY" || true; done > "$ORDERED"
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
# Only a whole-tier run writes it: an --only run used to overwrite it with a
# handful of legs labelled as the tier.
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

# A run that executed no legs is not a pass — the shape this whole round exists
# to remove (failure mode #3).
if [ "$TOTAL" -eq 0 ]; then
    echo "  SUITE VACUOUS: 0 legs ran — check --only ids against --list"
    exit 1
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
