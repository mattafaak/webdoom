#!/bin/bash
# webdoom test suite. Requires: built engine, wads fetched, chrome.
# Starts its own throwaway server for the browser suites.
set -e
cd "$(dirname "$0")/.."

echo "── engine smoke (doom, doom2) ──────────────────────────"
node tools/smoke-test.mjs doom.wad 700 | tail -2
node tools/smoke-test.mjs doom2.wad 1100 | tail -2

echo "── netplay determinism (2p, 4p) ────────────────────────"
node tools/net-test.mjs 2 | tail -2
node tools/net-test.mjs 4 | tail -2

echo "── browser (SP gate + 2-tab multiplayer) ───────────────"
DOOM_PORT=8668 DOOM_HOST=127.0.0.1 node server/serve.js & SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
sleep 1
node tools/browser-test.mjs http://127.0.0.1:8668/ | tail -2
node tools/browser-net-test.mjs http://127.0.0.1:8668/ | tail -1

echo "ALL SUITES PASS"
