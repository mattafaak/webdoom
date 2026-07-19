#!/bin/bash
# webdoom test suite. Requires: built engine, wads fetched, chrome.
# Starts its own throwaway server for the browser suites.
set -eo pipefail
cd "$(dirname "$0")/.."

echo "── lint (clang-format + JS syntax) ─────────────────────"
bash tools/lint.sh

echo "── archaeology drift (doc figures == manifest == script) "
bash tools/archaeology/verify-all.sh

echo "── size ledger (doom.wasm budget + README KB gate) ─────"
node tools/archaeology/size-ledger.mjs

echo "── engine smoke (doom, doom2) ──────────────────────────"
node tools/smoke-test.mjs doom.wad 700 | tail -2
node tools/smoke-test.mjs doom2.wad 1100 | tail -2

# ── invariant build (primary sim-safety gate) ────────────────────────────────
# The invariant build compiles with -DWEBDOOM_INVARIANTS into a *separate*
# artifact dir (build-invariants/) so the shipping build/ artifact is NEVER
# touched.  This gate is stronger than the golden-trace gate below:
#   • An assert names the broken invariant at the call site (e.g. p_tick.c:85).
#   • A golden diff is a downstream symptom — it fires only after the full demo
#     runs and gives no indication of *which* invariant was violated.
# See docs/playsim.md §16.2 for the proof: both injection experiments showed
# the assert naming the exact source location vs. a hash mismatch with no cause.
echo "── invariant build (sim-safety gate) ───────────────────"
source tools/emsdk-env.sh
(cd engine && make -j8 EXTRA_CFLAGS=-DWEBDOOM_INVARIANTS BUILD=../build-invariants OUT=../build-invariants/doom.js 2>&1 | tail -3)
node tools/demo-test.mjs --build-dir build-invariants | tail -2

echo "── differential fuzz (fast tier: 20 seeds, parallel 8) ─"
# Fast CI tier: ~1 min. Fails the suite immediately on any divergence (set -eo pipefail).
# Full / release tier: node tools/fuzz/run-fuzz.mjs --seeds 1000 --parallel 8  (~30 min)
# Drift-proof test: FUZZ_FORCE_DIVERGE=1 node tools/fuzz/run-fuzz.mjs --seeds 1 --parallel 1
node tools/fuzz/run-fuzz.mjs --seeds 20 --parallel 8 --require-native

echo "── demo compatibility (golden traces) ──────────────────"
node tools/demo-test.mjs | tail -2

echo "── render goldens (per-tic framebuffer hashes) ─────────"
node tools/demo-test.mjs --render | tail -2

echo "── netplay determinism (2p, 4p) ────────────────────────"
node tools/net-test.mjs 2 | tail -2
node tools/net-test.mjs 4 | tail -2

echo "── drop-in determinism (coop, deathmatch) ──────────────"
node tools/join-test.mjs | tail -1
node tools/join-test.mjs dm | tail -1

echo "── drop-in edge cases + churn ──────────────────────────"
node tools/edge-test.mjs | tail -1
node tools/churn-test.mjs | tail -1

echo "── sw.js precache integrity (ws-003 drift prevention) ──"
node tools/check-sw-precache.mjs

echo "── static HTTP path fuzz (ws-005 companion) ────────────"
node tools/http-fuzz-test.mjs | tail -1

echo "── net fuzz + abuse (malformed/hostile clients) ────────"
node tools/net-fuzz-test.mjs | tail -1

echo "── adversarial map gate (tenet-4: 0 sanitizer reports) ─"
# Gate: run 30 adversarial map seeds against nat-doom ASan build.
# Exit 0 iff all results are {clean | I_Error}; exit 1 on any ASan/UBSan hit.
# Reproduce: node tools/fuzz/run-map-fuzz.mjs --adversarial-gate [--build-dir build-test]
node tools/fuzz/run-map-fuzz.mjs --adversarial-gate | tail -4

echo "── browser (SP gate + 2-tab multiplayer) ───────────────"
DOOM_PORT=8668 DOOM_HOST=127.0.0.1 node server/serve.js & SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
sleep 1
node tools/browser-test.mjs http://127.0.0.1:8668/ | tail -2
node tools/browser-net-test.mjs http://127.0.0.1:8668/ | tail -1
node tools/browser-join-test.mjs http://127.0.0.1:8668/ | tail -1
node tools/persist-test.mjs http://127.0.0.1:8668/ | tail -1
node tools/browser-resilience-test.mjs http://127.0.0.1:8668/ | tail -2
node tools/browser-lobby-test.mjs http://127.0.0.1:8668/ | tail -2
node tools/browser-fire-test.mjs http://127.0.0.1:8668/ /tmp | tail -3
node tools/browser-ierror-test.mjs http://127.0.0.1:8668/ | tail -1
node tools/browser-rafdeath-test.mjs http://127.0.0.1:8668/ | tail -1
node tools/browser-offline-test.mjs | tail -2

echo "── browser pipeline baseline comparison ─────────────────"
# Hostname-gated: compare a fresh browser-pipeline.mjs run against the
# committed per-host golden.  Unknown hosts SKIP loudly so CI on other
# machines never silently passes with no data.
#
# Dedicated port 8677 — avoids stale-server confusion (12.2b lesson:
# port 8666 once served an uninstrumented client to the collector).
#
# Tolerance band derivation (from baseline run1/run2 variance × 3):
#   palette/p99      spread=0ms → floor=0.1ms → tol=0.3ms → thr=0.4ms
#   upload/p99       spread=0ms → floor=0.1ms → tol=0.3ms → thr=0.5ms
#   raf_duration/p99 spread=0.1ms → tol=0.3ms → thr=1.2ms
#   raf_interval/p50 spread=0ms → floor=1.0ms → tol=3.0ms → thr=19.7ms
#   input_lat/p50    spread=0.1ms → floor=0.5ms → tol=1.5ms → thr=9.9ms
#   input_lat/p99    SKIP — n=35; baseline notes 35–61ms run-to-run spread
#   worklet          SKIP — n=0 in headless (AudioContext never arms)
_BP_HOST="$(hostname)"
_BP_BASELINE="tools/golden/browser-pipeline-${_BP_HOST}.json"
if [ ! -f "$_BP_BASELINE" ]; then
    echo "SKIP: no browser-pipeline baseline for host '${_BP_HOST}' — add tools/golden/browser-pipeline-${_BP_HOST}.json to gate this host"
else
    DOOM_PORT=8677 DOOM_HOST=127.0.0.1 node server/serve.js >/dev/null 2>&1 & _BP_SRV=$!
    trap "kill $SRV 2>/dev/null; kill $_BP_SRV 2>/dev/null" EXIT
    sleep 1
    _BP_CURRENT="$(mktemp /tmp/browser-pipeline-current-XXXXXX.json)"
    node tools/browser-pipeline.mjs --url http://127.0.0.1:8677/ --json > "$_BP_CURRENT"
    kill "$_BP_SRV" 2>/dev/null; wait "$_BP_SRV" 2>/dev/null || true
    node tools/browser-pipeline-compare.mjs --baseline "$_BP_BASELINE" --current "$_BP_CURRENT"
    _BP_RC=$?
    rm -f "$_BP_CURRENT"
    if [ "$_BP_RC" -ne 0 ]; then
        echo "browser pipeline baseline: FAIL (see regression above)"
        exit 1
    fi
    echo "browser pipeline baseline: PASS"
fi

echo "── firefox smoke (UA + JS execution check) ──────────────"
# Asserts Firefox UA requests /api/wads, proving:
#   (1) Firefox loaded the page HTML (DOM fetch of JS modules)
#   (2) JS executed (lobby.js calls /api/wads to populate the WAD list)
#   (3) Service worker registered (sw.js was fetched, re-fetched modules)
# SKIP loudly when firefox binary is absent (CI without Firefox is valid).
if [ ! -x /usr/bin/firefox ]; then
    echo "SKIP: /usr/bin/firefox not found"
else
    _FF_LOG="$(mktemp /tmp/ff-smoke-XXXXXX.log)"
    _FF_PROFILE="$(mktemp -d /tmp/ff-profile-XXXXXX)"
    DOOM_PORT=8675 DOOM_HOST=127.0.0.1 LOG_REQUESTS=1 node server/serve.js 2>"$_FF_LOG" >/dev/null &
    _FF_SRV=$!
    sleep 1
    # Run Firefox headless; let it execute JS for 9 s, then kill.
    # No --screenshot: we need JS to run async (sw registration + /api/wads fetch)
    # before the process exits.  timeout rc=124 is expected and suppressed.
    timeout 11 firefox --headless --no-remote --profile "$_FF_PROFILE" \
        http://127.0.0.1:8675/ >/dev/null 2>&1 || true
    sleep 1  # allow in-flight requests to complete
    kill "$_FF_SRV" 2>/dev/null; wait "$_FF_SRV" 2>/dev/null || true
    rm -rf "$_FF_PROFILE"
    _FF_UA_LINES="$(grep -c "Firefox/" "$_FF_LOG" 2>/dev/null || echo 0)"
    _FF_WADS_LINES="$(grep -c "/api/wads" "$_FF_LOG" 2>/dev/null || echo 0)"
    echo "  Firefox UA requests: ${_FF_UA_LINES}  /api/wads requests: ${_FF_WADS_LINES}"
    rm -f "$_FF_LOG"
    if [ "$_FF_UA_LINES" -gt 0 ] && [ "$_FF_WADS_LINES" -gt 0 ]; then
        echo "firefox smoke: PASS — Firefox UA confirmed, JS executed (/api/wads fetched)"
    else
        echo "firefox smoke: FAIL — Firefox UA=${_FF_UA_LINES} /api/wads=${_FF_WADS_LINES}"
        exit 1
    fi
fi

echo "ALL SUITES PASS"
