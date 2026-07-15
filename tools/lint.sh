#!/usr/bin/env bash
# tools/lint.sh — webdoom lint/format gate
#
# Pinned clang-format major version: 22
# (clang-format output varies across major versions; on mismatch we
#  warn and skip C checks rather than failing CI on someone else's machine)
#
# Usage:
#   bash tools/lint.sh          # check mode — exits nonzero on violations
#   bash tools/lint.sh --fix    # fix mode — applies formatting in-place
#
# Scope:
#   C:  engine/web/*.{c,h}  tools/archaeology/*.c
#   JS: client/js/*.js  client/sw.js  client/game.js  server/*.js  tools/*.mjs
#
# engine/core/ is EXEMPT (vendored linuxdoom-1.10 archaeology record).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FIX=0
if [ "${1:-}" = "--fix" ]; then
    FIX=1
fi

ERRORS=0

# ---------------------------------------------------------------------------
# C formatting via clang-format
# ---------------------------------------------------------------------------

PINNED_MAJOR=22

if ! command -v clang-format >/dev/null 2>&1; then
    echo "lint: WARNING: clang-format not found — skipping C checks"
else
    CF_VERSION="$(clang-format --version | grep -oP '\d+' | head -1)"
    if [ "$CF_VERSION" != "$PINNED_MAJOR" ]; then
        echo "lint: WARNING: clang-format major version is $CF_VERSION, expected $PINNED_MAJOR — skipping C checks to avoid version-drift false positives"
    else
        C_FILES=(
            engine/web/*.c
            engine/web/*.h
            tools/archaeology/*.c
        )

        if [ "$FIX" = "1" ]; then
            echo "lint: clang-format --fix on ${#C_FILES[@]} C files"
            clang-format -i "${C_FILES[@]}"
        else
            BAD_C=()
            for f in "${C_FILES[@]}"; do
                if ! clang-format --dry-run --Werror "$f" 2>/dev/null; then
                    BAD_C+=("$f")
                fi
            done
            if [ "${#BAD_C[@]}" -gt 0 ]; then
                echo "lint: FAIL clang-format violations in:"
                printf '  %s\n' "${BAD_C[@]}"
                echo "  Run: bash tools/lint.sh --fix"
                ERRORS=1
            else
                echo "lint: clang-format OK (${#C_FILES[@]} files)"
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# JS syntax check via node --check
# ---------------------------------------------------------------------------

JS_FILES=(
    client/js/*.js
    client/sw.js
    server/*.js
    tools/*.mjs
)

if [ "$FIX" = "1" ]; then
    echo "lint: node --check (no auto-fix for JS syntax errors)"
fi

NODE_FAIL=0
for f in "${JS_FILES[@]}"; do
    if ! node --check "$f" 2>/tmp/node-check-err; then
        echo "lint: FAIL node --check $f"
        cat /tmp/node-check-err
        NODE_FAIL=1
    fi
done

if [ "$NODE_FAIL" = "1" ]; then
    ERRORS=1
else
    echo "lint: node --check OK (${#JS_FILES[@]} files)"
fi

# ---------------------------------------------------------------------------
# Final result
# ---------------------------------------------------------------------------

if [ "$ERRORS" = "1" ]; then
    echo "lint: FAILED — see above"
    exit 1
fi

echo "lint: OK"
