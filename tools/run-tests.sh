#!/bin/bash
# webdoom test suite — leg-isolating runner.
#
# WHY THIS SHAPE
# --------------
# The previous runner was 254 lines of `set -eo pipefail` with ~32 legs in a
# straight line.  It aborted at the first red, so a failure at leg 3 left the
# other 29 unverified AND UNMENTIONED: the operator saw one error and nothing
# about the rest of the suite.  That is the project's own doctrine violated by
# its top-level runner — "could not run" and "ran and passed" must not produce
# the same word, and here they produced no word at all.
#
# Every leg now runs through tools/gate.sh, which executes the command outside
# any pipeline so its exit code is exact (the six-times pipe-exit trap), keeps
# the untrimmed log, and prints a trimmed view.  A failing leg is recorded and
# the run continues.  The suite ends with a table naming every leg, its verdict,
# its duration and the count it reported about itself.
#
# A leg whose prerequisites are absent is SKIPPED WITH A REASON rather than
# failing confusingly or passing silently, and the final verdict always states
# the skip count — so a run with skips can never read as a clean pass.
# --require-complete turns any skip into a failure, for the host that is
# supposed to be able to run everything.
#
# usage:
#   tools/run-tests.sh                 # full tier (everything)
#   tools/run-tests.sh --quick         # no WADs, no build, no browser — clone-safe
#   tools/run-tests.sh --only ID [...] # run just these legs
#   tools/run-tests.sh --list          # print the leg registry and exit
#   tools/run-tests.sh --require-complete   # a SKIP is a failure
#
# Copyright (C) 2026, GPL-2.0-or-later.

# Deliberately NOT -e: this runner must survive a failing leg in order to
# report it and everything after it.  Every command that can fail is either
# guarded with `|| rc=$?` or is a leg.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

TIER=full
PERF=0
NO_SLOW=0
REQUIRE_COMPLETE=0
ONLY=()
LIST=0
while [ $# -gt 0 ]; do
    case "$1" in
        --quick)            TIER=quick; shift ;;
        # The perf gate is opt-in because it reaches OTHER MACHINES, not
        # because it is slow -- measured at ~26 s for all three hosts, against
        # fleet-bench.sh's own stale comment claiming "bench itself can take
        # 10 min on wbox". A default-tier leg that fails whenever a teammate's
        # laptop is asleep is a leg people learn to ignore.
        #
        # It SKIPs with its reason NAMED AND COUNTED in the default run, which
        # is the whole difference between a gate that is opt-in and a gate that
        # does not exist.
        --perf)             PERF=1; shift ;;
        # n64-demos is 435 s of an 1,129 s suite -- 39% of the whole run in one
        # leg, on a toolchain almost no host has.  --no-slow is for iterating;
        # it is NOT a quieter default.  The leg still SKIPs with its reason
        # named and counted, and --require-complete still fails on it, because
        # a shorter run is exactly the thing that must not be mistaken for a
        # complete one.
        --no-slow)          NO_SLOW=1; shift ;;
        --full)             TIER=full; shift ;;
        --only)             ONLY+=("$2"); shift 2 ;;
        --list)             LIST=1; shift ;;
        --require-complete) REQUIRE_COMPLETE=1; shift ;;
        -h|--help)          sed -n '28,36p' "$0"; exit 0 ;;
        *) echo "unknown argument '$1' (see --list, --help)" >&2; exit 2 ;;
    esac
done

LOGDIR="$(mktemp -d -t webdoom-suite-XXXXXX)"
SUMMARY="$LOGDIR/summary.tsv"
: > "$SUMMARY"

# ── prerequisite probes ──────────────────────────────────────────────────────
# Each returns 0 when satisfied; the reason string is what the table prints.
IWADS=(doom.wad doom2.wad tnt.wad plutonia.wad)
have_build()   { [ -f build/doom.js ] && [ -f build/doom.wasm ]; }
have_wad()     { local w; for w in "${IWADS[@]}"; do [ -f "wads/lib/$w" ] || return 1; done; }
have_native()  { [ -x tools/native-sanitize/nat-doom ]; }
have_fs()      { [ -x tools/freestanding/fs-doom ]; }
have_zig()     { command -v zig >/dev/null 2>&1; }
# The PINNED major, not merely 'a clang-format': output differs across majors,
# so a different one would report violations that are not violations.
have_clangfmt(){ command -v clang-format >/dev/null 2>&1 && \
                 [ "$(clang-format --version | grep -oE '[0-9]+' | head -1)" = "22" ]; }
have_qemuarm() { command -v qemu-arm-static >/dev/null 2>&1; }
# The N64 gate needs three separate things and none of them are common: the
# mips64-elf cross compiler, the ares emulator, and an X server to run it
# headless under.  Checked together because a partial toolchain would fail the
# leg for a reason that has nothing to do with the engine.
have_n64()     { [ -x "${N64_INST:-$HOME/toolchains/n64}/bin/mips64-elf-gcc" ] && \
                 command -v ares >/dev/null 2>&1 && \
                 command -v xvfb-run >/dev/null 2>&1; }
have_gcc()     { command -v gcc >/dev/null 2>&1; }
# An explicit CHROME_BIN is the ONLY answer when it is set.  This used to read
# `command -v "${CHROME_BIN:-google-chrome-stable}" || [ -x /opt/... ]`, so a
# CHROME_BIN pointing at nothing still satisfied the probe via the /opt fallback
# while the legs spawned the missing binary -- observed: browser-sp and persist
# PASSED (they hardcoded google-chrome-stable) while browser-qol and
# browser-teardown died ENOENT, in one run.  tools/chrome-harness.mjs resolves
# it in exactly this order, so the probe and the spawn cannot disagree.
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
# The 16 legs below share one server on 8668.  Making that a PREREQUISITE, rather
# than an `if` wrapped around the whole block, is what lets each of them report
# its own named SKIP -- see the browser-suite comment for what the aggregate skip
# was hiding.
SHARED_UP=0
have_shared()  { [ "$SHARED_UP" = "1" ]; }
have_loadbudget(){ [ -f "tools/golden/load-budget-$(hostname).json" ]; }
have_xvfb()    { command -v xvfb-run >/dev/null 2>&1; }
have_systemd() { command -v systemd-analyze >/dev/null 2>&1; }
have_perf()    { [ "$PERF" = "1" ]; }
have_notslow() { [ "$NO_SLOW" = "0" ]; }
# PRESENT is not the same as CURRENT, and for the compile-time variants the
# difference was load-bearing: `build-fakeflat` needs emsdk while
# `render-fakeflat` needed only `wad`, so on a host without emsdk the build leg
# SKIPped and the render leg ran against whatever was on disk -- printing a
# full-count PASS from a tree built before the change under test.  The freshness
# registry already knows what current means; ask it.
have_fresh()   { node tools/artifact-freshness.mjs "$1" >/dev/null 2>&1; }

need_reason() {   # need_reason <tag> -> prints why it is unmet
    case "$1" in
        build)    echo "build/doom.js absent (run: source tools/emsdk-env.sh && make -C engine)" ;;
        wad)      echo "IWADs absent (run: tools/fetch-wads.sh)" ;;
        native)   echo "nat-doom absent (run: make -C tools/native-sanitize)" ;;
        fs)       echo "fs-doom absent (run: make -C tools/freestanding)" ;;
        zig)      echo "zig not on PATH (needed to cross-build for ARM)" ;;
        clangfmt) echo "clang-format 22 not present (have: $(command -v clang-format >/dev/null 2>&1 && clang-format --version | grep -oE '[0-9]+' | head -1 || echo none))" ;;
        qemuarm)  echo "qemu-arm-static not on PATH" ;;
        n64)      echo "N64 toolchain incomplete (need mips64-elf-gcc under \$N64_INST, ares and xvfb-run; run: source ~/toolchains/env.sh)" ;;
        gcc)      echo "gcc not on PATH" ;;
        systemd)  echo "systemd-analyze not on PATH (the unit file cannot be validated here)" ;;
        xvfb)     echo "xvfb-run not on PATH (headless Firefox has NO WebGL here, so the frame gate needs a real X display)" ;;
        loadbudget) echo "no load-budget baseline for host $(hostname) (record: node tools/load-budget-test.mjs --record)" ;;
        browser)  echo "Chrome not found (set CHROME_BIN)" ;;
        firefox)  echo "/usr/bin/firefox not found" ;;
        emsdk)    echo "emsdk not found (run: tools/setup-emsdk.sh)" ;;
        baseline) echo "no browser-pipeline baseline for host $(hostname)" ;;
        shared)   echo "shared browser server on 8668 not started" ;;
        slow)     echo "--no-slow given: this leg is 39% of the suite runtime (measured 435 s of 1,129 s)" ;;
        perf)     echo "perf tier not requested (run: tools/run-tests.sh --perf; ~30 s measured, needs wbox and tank up)" ;;
        fresh-*)  echo "build-${1#fresh-} absent or stale (node tools/artifact-freshness.mjs build-${1#fresh-})" ;;
        *)        echo "unmet prerequisite '$1'" ;;
    esac
}
need_met() {
    case "$1" in
        build) have_build ;; wad) have_wad ;; native) have_native ;; gcc) have_gcc ;; fs) have_fs ;;
        systemd) have_systemd ;;
        xvfb) have_xvfb ;;
        loadbudget) have_loadbudget ;;
        zig) have_zig ;; qemuarm) have_qemuarm ;; clangfmt) have_clangfmt ;;
        n64) have_n64 ;;
        browser) have_browser ;; firefox) have_firefox ;; emsdk) have_emsdk ;;
        baseline) have_baseline ;; shared) have_shared ;; perf) have_perf ;; slow) have_notslow ;;
        fresh-*) have_fresh "build-${1#fresh-}" ;;
        *) return 1 ;;
    esac
}

# ── the headline a leg reported about itself ─────────────────────────────────
# A FAILING LEG MUST NOT WEAR A PASSING HEADLINE, and a leg's own result line
# beats its first PASS line — both lessons paid for elsewhere in this mesh.  So
# a red prefers a FAIL/Error line and a green prefers a PASS/summary line;
# gate.sh's own "GATE x rc=" line is never the headline.
headline() {
    local log="$1" rc="$2" h=""
    # Exclude ONLY gate.sh's own trailer.  The first version excluded every line
    # starting "GATE ", which also threw away a tool's own "GATE PASS: ..."
    # verdict — so adversarial-map's headline became a trailing rule-of-thumb
    # sentence instead of "0 clean + 30 I_Error, 0 sanitizer reports".
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

    local t
    for t in ${needs//,/ }; do
        [ "$t" = "-" ] && continue
        if ! need_met "$t"; then
            local why; why="$(need_reason "$t")"
            printf '\n── %-26s SKIP — %s\n' "$id" "$why"
            printf '%s\tSKIP\t0\t%s\n' "$id" "$why" >> "$SUMMARY"
            SKIPPED=$((SKIPPED + 1))
            return 0
        fi
    done

    printf '\n── %-26s %s\n' "$id" "$desc"
    local log="$LOGDIR/$id.log" rc=0 t0 t1
    t0=$(date +%s)
    bash tools/gate.sh --tail 2 --log "$log" "$id" -- "$@" || rc=$?
    t1=$(date +%s)
    local secs=$((t1 - t0)) head; head="$(headline "$log" "$rc")"
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

# ── throwaway servers ────────────────────────────────────────────────────────
# Readiness is polled, never slept for: a fixed sleep means the test proceeds
# against whatever is on that port, which is how a stale server once served an
# uninstrumented client to the collector (the 12.2b lesson).  Ownership of the
# port is asserted in task 21.7.
SERVERS=()
# Answering on the port is not the same as being OUR server: a stale process from
# an earlier run answers just as well, and serves a different build.  So the port
# is checked for OWNERSHIP, not just for a response (task 21.7).
# Both non-verification paths used to `return 0` after printing a "note", and
# nothing anywhere counted notes -- so on a container without iproute2 the
# 12.2b stale-server protection was silently off for the whole browser suite
# and the run still read as fully verified. The two cases are not the same and
# no longer get the same treatment:
#
#   ss missing          -> genuinely cannot verify. Counted in NOTES and
#                          reported in the summary, so it is visible.
#   ss present, no owner -> we started a server and nothing is listening on its
#                          port. That is a failure, not a note.
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
        # --max-time is load-bearing, not belt-and-braces.  Without it curl waits
        # forever for a response, so a process that ACCEPTS on this port and then
        # says nothing -- a squatter, a wedged orphan from an earlier run -- hangs
        # the readiness loop indefinitely instead of failing it.  Observed: the
        # suite sat on this line past its own 300 s timeout with the leg neither
        # running nor skipping.  A poll that cannot time out is not a poll.
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
# ONE trap for every server this run starts — the old runner reassigned the EXIT
# trap four times, each overwriting the last, and never trapped the firefox leg's
# server at all.
cleanup() { serve_stop_all; rm -rf "$LOGDIR"; }
trap cleanup EXIT INT TERM

# ═══════════════════════════════════════════════════════════════════════════════
# THE LEG REGISTRY
#
# One line per leg: id, prerequisites, description, command.  The id is what
# --only takes and what the summary table prints.  Compound legs were split so
# each reports its own verdict — "engine smoke (doom, doom2)" used to be two
# commands under one heading, and the second was unreachable if the first failed.
# ═══════════════════════════════════════════════════════════════════════════════

# --list reads the registry out of this file.  A discovery that finds almost
# nothing is a red, not an empty list: the first version of this used a regex
# that required exactly one space after the id, so column alignment hid 40 of
# the 50 legs and it reported 10 with no error (the roster-discovery lesson).
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
leg gm-config       -    "the GM backend's operator config path (25.1)" -- node tools/gm-config-test.mjs
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
leg gm-frames       build,wad  "GM/GUS pump chain + DMXGUS mapping"    -- node tools/gm-frames-test.mjs doom.wad

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
leg fuzz-diff       native,wad "20 mutated demos: wasm == native"      -- node tools/fuzz/run-fuzz.mjs --seeds 20 --parallel 8 --require-native
leg sim-goldens     build,wad  "13 demos, per-tic gamestate hashes"    -- node tools/demo-test.mjs
leg render-goldens  build,wad  "13 demos, per-tic framebuffer hashes"  -- node tools/demo-test.mjs --render
leg render-low      build,wad  "low-detail render goldens (14.2b)"     -- node tools/demo-test.mjs --render --low-detail
# spc-011: spec.md promises freelook and interpolation are render-side and cannot
# reach the playsim.  sim-wide was the only leg proving that class and it was
# deleted with widescreen.  This is its successor on the shipping artifact.
leg sim-freelook    build,wad  "13 demos, freelook active, playsim untouched (spc-011)" -- node tools/demo-test.mjs --sim-drawn --pitch 40

leg build-fakeflat   emsdk     "compile -DWEBDOOM_FAKEFLAT"            -- bash tools/build-toggle.sh WEBDOOM_FAKEFLAT build-fakeflat
leg render-fakeflat  wad,fresh-fakeflat       "fakeflat render goldens (20.3a)"       -- node tools/demo-test.mjs --render-fakeflat
leg build-potato     emsdk     "compile -DWEBDOOM_POTATO"              -- bash tools/build-toggle.sh WEBDOOM_POTATO build-potato
leg render-potato    wad,fresh-potato         "potato render goldens (20.3c)"         -- node tools/demo-test.mjs --render-potato

# ── 20.3b and 20.3d shipped with no regression gate at all (task 21.12) ───────
# run-tests.sh built and gated only fakeflat and potato.  Both of these are
# PIXEL-IDENTICAL when on — that is the whole claim — so they need no golden
# family of their own: the gate is the vanilla render goldens replayed against
# the toggle build, which is exactly the proof the ledger records.  Their only
# surviving evidence until now was an md5 typed into a document.
leg build-sbskip     emsdk     "compile -DWEBDOOM_SBSKIP"              -- bash tools/build-toggle.sh WEBDOOM_SBSKIP build-sbskip
leg render-sbskip    wad,fresh-sbskip         "sbskip pixel-identical to vanilla (20.3b)" -- node tools/demo-test.mjs --render --build-dir build-sbskip
leg sim-sbskip       wad,fresh-sbskip         "sbskip leaves the playsim untouched"   -- node tools/demo-test.mjs --sim-drawn --build-dir build-sbskip
leg build-diffblit   emsdk     "compile -DWEBDOOM_DIFFBLIT"            -- bash tools/build-toggle.sh WEBDOOM_DIFFBLIT build-diffblit
leg render-diffblit  wad,fresh-diffblit       "diffblit pixel-identical to vanilla (20.3d)" -- node tools/demo-test.mjs --render --build-dir build-diffblit
leg sim-diffblit     wad,fresh-diffblit       "diffblit leaves the playsim untouched" -- node tools/demo-test.mjs --sim-drawn --build-dir build-diffblit

# Every md5 the ledger states about a built artifact, checked against the
# artifact — including the toggle-off byte-identity claim that all four 20.3
# entries rest on.  "proven" used to mean a human ran md5sum once.
leg toggle-identity  build     "ledger md5/size claims == the artifacts"    -- node tools/toggle-identity-check.mjs
leg golden-provenance -        "every golden says where it came from"       -- node tools/golden-provenance.mjs --check


# ── gates that existed and ran nowhere until the census (task 21.11) ──────────
# README.md advertises the native ASan/UBSan demo suite as part of the gate set;
# it was run only by hand.  The freestanding 13/13 check calls itself "the
# crown-jewel proof for rung 1" and is cited as a landing gate throughout
# Plans; also hand-run.  demo-verify.mjs is the SHIPPED 19.4 CLI, and its test
# re-implements the logic rather than importing it, so the CLI's own argv
# handling, --all mode and size cap were ungated.
leg native-asan     native,wad "13 demos under ASan/UBSan (README's claim)"  -- bash tools/native-sanitize/run-all.sh wads/lib tools/native-sanitize/out sim
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
leg n64-demos       n64,wad,slow    "13/13 demo sim-hashes on emulated N64 (~8 min)" -- bash tools/n64/run-n64-demos.sh
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
leg adversarial-map native,wad "30 adversarial maps, 0 ASan/UBSan reports" -- node tools/fuzz/run-map-fuzz.mjs --adversarial-gate

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
        if serve_start 8668; then SHARED_UP=1; else
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
    leg browser-sf2           browser,build,wad,shared "SoundFont UX (17.2b)"                  -- node tools/browser-sf2-test.mjs "$U"
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
    [ "$SHARED_UP" = "1" ] && serve_stop_all
fi

# These three own their servers (dedicated ports, per the 12.2b stale-server
# lesson), so they are ordinary legs.
leg browser-insecure browser "real insecure origin: IDB WAD cache + music fallback" -- node tools/browser-insecure-test.mjs
# rme-005: "second load is instant". The offline half is gated; "instant" was a
# performance claim with no gate. This is a REGRESSION gate against a baseline
# committed per host -- a host without one SKIPs by name, as browser-pipeline does.
leg load-budget     browser,loadbudget,build,wad "warm load within this host's budget (rme-005)" -- node tools/load-budget-test.mjs
leg browser-pipeline browser,baseline "per-frame JS/GPU cost vs this host's baseline" -- bash tools/pipeline-gate.sh
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
leg perf-fleet      perf,build,wad "per-stage render ms on alder+wbox+tank vs baseline" -- bash tools/fleet-bench.sh --check

fi   # QUICK_ONLY

# ═══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════
echo
echo "══════════════════════════════════════════════════════════════════════════════"
printf '  %-22s %-11s %5s  %s\n' LEG VERDICT SECS "WHAT IT REPORTED"
echo "  ────────────────────────────────────────────────────────────────────────────"
while IFS=$'\t' read -r id verdict secs note; do
    printf '  %-22s %-11s %5s  %s\n' "$id" "$verdict" "$secs" "$note"
done < "$SUMMARY"
echo "  ────────────────────────────────────────────────────────────────────────────"

# ── persist the per-leg table ────────────────────────────────────────────────
# $SUMMARY lives in the mktemp dir the EXIT trap deletes, so the SECS column --
# the only per-leg timing this project produces -- died with every run. The one
# timing table that exists in the repo is in a doc, because a human pasted it
# there. Keep the last run's, next to the failing-leg logs.
mkdir -p "$REPO/tools/.suite-logs"
{
    printf '# webdoom suite — %s, tier %s, host %s\n' "$(date -Is)" "$TIER" "$(hostname)"
    printf '# leg\tverdict\tsecs\theadline\n'
    cat "$SUMMARY"
} > "$REPO/tools/.suite-logs/last-run.tsv" 2>/dev/null || true

TOTAL=$((PASSED + FAILED + SKIPPED))
printf '  %d legs: %d passed, %d failed, %d skipped  (tier: %s)\n' \
       "$TOTAL" "$PASSED" "$FAILED" "$SKIPPED" "$TIER"
if [ "$NOTES" -gt 0 ]; then
    printf '  %d note(s) — something could not be verified:\n' "$NOTES"
    printf '    %s\n' "${NOTE_TEXT[@]}"
fi
printf '  per-leg timings: tools/.suite-logs/last-run.tsv\n'

# A run that executed no legs is not a pass — the shape this whole round exists
# to remove (failure mode #3).
if [ "$TOTAL" -eq 0 ]; then
    echo "  SUITE VACUOUS: 0 legs ran — check --only ids against --list"
    exit 1
fi

# ── coverage: does the total account for the whole registry? ─────────────────
#
# TOTAL is built by adding up what ran, so it could only ever answer "how many
# legs did I reach", never "how many are there".  Nothing compared the two, and
# the browser block's aggregate skip collapsed the whole block into one SKIPPED
# increment — so a WAD-less or Chrome-less host printed a perfectly plausible
# "64 legs: 63 passed, 0 failed, 1 skipped" against a registry of 81 and lost
# seventeen without a word.
#
# demo-test.mjs has had exactly this control since task 21.2 (EXPECTED_DEMOS
# from MATRIX, assertFullCoverage), one level down from where it was needed.
# --only is the one case where a shortfall is the point, so it is exempt.
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
