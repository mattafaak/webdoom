#!/bin/bash
# webdoom test suite. Requires: built engine, wads fetched, chrome.
# Starts its own throwaway server for the browser suites.
set -eo pipefail
cd "$(dirname "$0")/.."

echo "── lint (clang-format + JS syntax) ─────────────────────"
bash tools/lint.sh

echo "── archaeology drift (doc figures == manifest == script) "
bash tools/archaeology/verify-all.sh

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

echo "ALL SUITES PASS"
