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
REQUIRE_COMPLETE=0
ONLY=()
LIST=0
while [ $# -gt 0 ]; do
    case "$1" in
        --quick)            TIER=quick; shift ;;
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
have_gcc()     { command -v gcc >/dev/null 2>&1; }
have_browser() { command -v "${CHROME_BIN:-google-chrome-stable}" >/dev/null 2>&1 || [ -x /opt/google/chrome/chrome ]; }
have_firefox() { [ -x /usr/bin/firefox ]; }
have_emsdk()   { [ -x "${EMSDK_DIR:-$HOME/projects/bee-kettle-doom/emsdk}/upstream/emscripten/emcc" ]; }
have_baseline(){ [ -f "tools/golden/browser-pipeline-$(hostname).json" ]; }

need_reason() {   # need_reason <tag> -> prints why it is unmet
    case "$1" in
        build)    echo "build/doom.js absent (run: source tools/emsdk-env.sh && make -C engine)" ;;
        wad)      echo "IWADs absent (run: tools/fetch-wads.sh)" ;;
        native)   echo "nat-doom absent (run: make -C tools/native-sanitize)" ;;
        fs)       echo "fs-doom absent (run: make -C tools/freestanding)" ;;
        zig)      echo "zig not on PATH (needed to cross-build for ARM)" ;;
        clangfmt) echo "clang-format 22 not present (have: $(command -v clang-format >/dev/null 2>&1 && clang-format --version | grep -oE '[0-9]+' | head -1 || echo none))" ;;
        qemuarm)  echo "qemu-arm-static not on PATH" ;;
        gcc)      echo "gcc not on PATH" ;;
        browser)  echo "Chrome not found (set CHROME_BIN)" ;;
        firefox)  echo "/usr/bin/firefox not found" ;;
        emsdk)    echo "emsdk not found (run: tools/setup-emsdk.sh)" ;;
        baseline) echo "no browser-pipeline baseline for host $(hostname)" ;;
        *)        echo "unmet prerequisite '$1'" ;;
    esac
}
need_met() {
    case "$1" in
        build) have_build ;; wad) have_wad ;; native) have_native ;; gcc) have_gcc ;; fs) have_fs ;;
        zig) have_zig ;; qemuarm) have_qemuarm ;; clangfmt) have_clangfmt ;;
        browser) have_browser ;; firefox) have_firefox ;; emsdk) have_emsdk ;;
        baseline) have_baseline ;;
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
assert_port_owned() {   # assert_port_owned <port> <pid>
    if ! command -v ss >/dev/null 2>&1; then
        echo "  note: ss not available — port ownership NOT verified for $1"
        return 0
    fi
    local owner
    owner="$(ss -tlnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
    if [ -z "$owner" ]; then
        echo "  note: no listener found for port $1 in ss output — ownership NOT verified"
        return 0
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
        if curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
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
leg gate-census     -    "every gate is wired or registered with a reason" -- node tools/gate-census.mjs

if [ "$TIER" = "quick" ]; then
    QUICK_ONLY=1
else
    QUICK_ONLY=0
fi

if [ "$QUICK_ONLY" = "0" ]; then

# ── artifacts under test are current with their sources (21.4/21.5) ──────────
leg freshness       build      "build/ + native refs not older than sources" -- node tools/artifact-freshness.mjs --all
leg size-ledger     build      "doom.wasm budget + README KB three-way"      -- node tools/archaeology/size-ledger.mjs

# ── engine boots and makes sound ─────────────────────────────────────────────
leg smoke-doom      build,wad  "boots doom.wad headless, 700 frames"   -- node tools/smoke-test.mjs doom.wad 700
leg smoke-doom2     build,wad  "boots doom2.wad headless, 1100 frames" -- node tools/smoke-test.mjs doom2.wad 1100
leg opl-mode        build,wad  "OPL2 byte-identical to ref; OPL3 RMS"  -- node tools/opl-mode-test.mjs doom.wad
leg gm-frames       build,wad  "GM/GUS pump chain + DMXGUS mapping"    -- node tools/gm-frames-test.mjs doom.wad

# ── the sim-safety gate: an assert names the broken invariant at its call site,
#    which a golden diff cannot do.  It runs BEFORE the goldens for that reason.
leg build-invariants emsdk     "compile -DWEBDOOM_INVARIANTS"          -- bash tools/build-toggle.sh WEBDOOM_INVARIANTS build-invariants
leg sim-invariants   wad       "13 demos under armed invariant asserts" -- node tools/demo-test.mjs --build-dir build-invariants

# ── differential + goldens ───────────────────────────────────────────────────
leg fuzz-diff       native,wad "20 mutated demos: wasm == native"      -- node tools/fuzz/run-fuzz.mjs --seeds 20 --parallel 8 --require-native
leg sim-goldens     build,wad  "13 demos, per-tic gamestate hashes"    -- node tools/demo-test.mjs
leg render-goldens  build,wad  "13 demos, per-tic framebuffer hashes"  -- node tools/demo-test.mjs --render
leg render-low      build,wad  "low-detail render goldens (14.2b)"     -- node tools/demo-test.mjs --render --low-detail
leg render-wide     build,wad  "854-px Hor+ render goldens (18.2c)"    -- node tools/demo-test.mjs --render-wide
leg sim-wide        build,wad  "wide ENABLED must match sim goldens"   -- node tools/demo-test.mjs --sim-wide

leg build-fakeflat   emsdk     "compile -DWEBDOOM_FAKEFLAT"            -- bash tools/build-toggle.sh WEBDOOM_FAKEFLAT build-fakeflat
leg render-fakeflat  wad       "fakeflat render goldens (20.3a)"       -- node tools/demo-test.mjs --render-fakeflat
leg build-potato     emsdk     "compile -DWEBDOOM_POTATO"              -- bash tools/build-toggle.sh WEBDOOM_POTATO build-potato
leg render-potato    wad       "potato render goldens (20.3c)"         -- node tools/demo-test.mjs --render-potato

# ── 20.3b and 20.3d shipped with no regression gate at all (task 21.12) ───────
# run-tests.sh built and gated only fakeflat and potato.  Both of these are
# PIXEL-IDENTICAL when on — that is the whole claim — so they need no golden
# family of their own: the gate is the vanilla render goldens replayed against
# the toggle build, which is exactly the proof the ledger records.  Their only
# surviving evidence until now was an md5 typed into a document.
leg build-sbskip     emsdk     "compile -DWEBDOOM_SBSKIP"              -- bash tools/build-toggle.sh WEBDOOM_SBSKIP build-sbskip
leg render-sbskip    wad       "sbskip pixel-identical to vanilla (20.3b)" -- node tools/demo-test.mjs --render --build-dir build-sbskip
leg sim-sbskip       wad       "sbskip leaves the playsim untouched"   -- node tools/demo-test.mjs --build-dir build-sbskip
leg build-diffblit   emsdk     "compile -DWEBDOOM_DIFFBLIT"            -- bash tools/build-toggle.sh WEBDOOM_DIFFBLIT build-diffblit
leg render-diffblit  wad       "diffblit pixel-identical to vanilla (20.3d)" -- node tools/demo-test.mjs --render --build-dir build-diffblit
leg sim-diffblit     wad       "diffblit leaves the playsim untouched" -- node tools/demo-test.mjs --build-dir build-diffblit

# Every md5 the ledger states about a built artifact, checked against the
# artifact — including the toggle-off byte-identity claim that all four 20.3
# entries rest on.  "proven" used to mean a human ran md5sum once.
leg toggle-identity  build     "ledger md5/size claims == the artifacts"    -- node tools/toggle-identity-check.mjs
leg golden-provenance -        "every golden says where it came from"       -- node tools/golden-provenance.mjs --check

leg sprite-witness  build,wad  "r_things.c:530 cull pin, 320 + 854"    -- node tools/sprite-witness-test.mjs

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
leg demo-verify-cli build,wad  "the shipped 19.4 CLI itself, --all mode"     -- node tools/demo-verify.mjs --all

# ── netcode determinism ──────────────────────────────────────────────────────
leg mixed-width-net build,wad  "P0=320 vs P1=854 per-tic hash"         -- node tools/mixed-width-net-test.mjs
leg net-2p          build,wad  "2 real wasm clients through the relay" -- node tools/net-test.mjs 2
leg net-4p          build,wad  "4 real wasm clients through the relay" -- node tools/net-test.mjs 4
leg join-coop       build,wad  "drop-in determinism, co-op"            -- node tools/join-test.mjs
leg join-dm         build,wad  "drop-in determinism, deathmatch"       -- node tools/join-test.mjs dm
leg spectate        build,wad  "spectator catch-up determinism (19.5)" -- node tools/spectate-test.mjs
leg spectate-inject build,wad  "spectator injection is a no-op"        -- node tools/spectate-inject-test.mjs
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
# Hostile lump CONTENT.  wad-import.js validates a WAD's directory well;
# nothing validated what is inside a lump, and a PWAD lump overrides the
# IWAD's, so an imported WAD can hand the engine any bytes under a known name.
leg wad-content-fuzz build,wad "hostile GENMIDI/MUS lump payloads (23.2)" -- node tools/wad-content-fuzz-test.mjs

# ── browser suite ────────────────────────────────────────────────────────────
# One shared server for the 16 legs that only need a page to load.  Started
# once, torn down by the single EXIT trap, readiness polled rather than slept.
if [ "${#ONLY[@]}" -eq 0 ] || printf '%s\n' "${ONLY[@]}" | grep -q '^browser-\|^persist$'; then
    if have_browser && have_build && have_wad; then
        if serve_start 8668; then
            U=http://127.0.0.1:8668/
            leg browser-sp        browser,build,wad "title -> menu -> new game -> movement" -- node tools/browser-test.mjs "$U"
            leg browser-net       browser,build,wad "2 tabs through the lobby into co-op"   -- node tools/browser-net-test.mjs "$U"
            leg browser-join      browser,build,wad "browser drop-in"                       -- node tools/browser-join-test.mjs "$U"
            leg persist           browser,build,wad "settings/keybind persistence"          -- node tools/persist-test.mjs "$U"
            leg browser-resilience browser,build,wad "fetch/sw/visibility/gamepad failures" -- node tools/browser-resilience-test.mjs "$U"
            leg browser-lobby     browser,build,wad "lobby state machine, 25 edges"         -- node tools/browser-lobby-test.mjs "$U"
            leg browser-fire      browser,build,wad "PSX fire background + reduced-motion"  -- node tools/browser-fire-test.mjs "$U" /tmp
            leg browser-ierror    browser,build,wad "I_Error surfaces, no wedge"            -- node tools/browser-ierror-test.mjs "$U"
            leg browser-rafdeath  browser,build,wad "rAF death recovery"                    -- node tools/browser-rafdeath-test.mjs "$U"
            leg browser-wide      browser,build,wad "widescreen toggle"                     -- node tools/browser-wide-toggle-test.mjs "$U"
            leg browser-qol       browser,build,wad "QoL batch + F8 vanilla toggle"         -- node tools/browser-qol-test.mjs "$U"
            leg browser-wadimport browser,build,wad "user WAD import (16.6a)"               -- node tools/browser-wadimport-test.mjs "$U"
            leg browser-mp-gating browser,build,wad "local-WAD MP gating (16.6b)"           -- node tools/browser-mp-gating-test.mjs "$U"
            leg browser-sf2       browser,build,wad "SoundFont UX (17.2b)"                  -- node tools/browser-sf2-test.mjs "$U"
            leg browser-offline   browser,build,wad "offline single player"                 -- node tools/browser-offline-test.mjs
            leg browser-demo      browser,build,wad "demo permalink replay (19.2)"          -- node tools/browser-demo-test.mjs "$U"
            # The old runner gave this its own server on 8669 "per the 12.2b
            # stale-server lesson".  That lesson was about a STALE server being
            # picked up; this runner starts its own, polls it ready and tears it
            # down from one trap, so the shared secure-context server is fine and
            # the test itself only patches audioWorklet client-side.
            leg browser-music-fallback browser,build,wad "BufferSink fallback, audioWorklet=undefined" -- node tools/browser-music-fallback-test.mjs "$U"
            serve_stop_all
        else
            echo "SKIP browser suite: could not start a server on 8668"
            printf 'browser-suite\tSKIP\t0\tcould not start server on 8668\n' >> "$SUMMARY"
            SKIPPED=$((SKIPPED + 1))
        fi
    else
        echo "SKIP browser suite: prerequisites absent"
        printf 'browser-suite\tSKIP\t0\tbrowser/build/wad prerequisite absent\n' >> "$SUMMARY"
        SKIPPED=$((SKIPPED + 1))
    fi
fi

# These three own their servers (dedicated ports, per the 12.2b stale-server
# lesson), so they are ordinary legs.
leg browser-insecure browser "real insecure origin: IDB WAD cache + music fallback" -- node tools/browser-insecure-test.mjs
leg browser-pipeline browser,baseline "per-frame JS/GPU cost vs this host's baseline" -- bash tools/pipeline-gate.sh
leg firefox-smoke    firefox "Firefox UA executes JS and fetches /api/wads" -- bash tools/firefox-smoke.sh

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

TOTAL=$((PASSED + FAILED + SKIPPED))
printf '  %d legs: %d passed, %d failed, %d skipped  (tier: %s)\n' \
       "$TOTAL" "$PASSED" "$FAILED" "$SKIPPED" "$TIER"

# A run that executed no legs is not a pass — the shape this whole round exists
# to remove (failure mode #3).
if [ "$TOTAL" -eq 0 ]; then
    echo "  SUITE VACUOUS: 0 legs ran — check --only ids against --list"
    exit 1
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
