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
REQUIRE_C=0
for a in "$@"; do
    case "$a" in
        --fix)       FIX=1 ;;
        --require-c) REQUIRE_C=1 ;;
        *) echo "lint: unknown argument '$a' (expected --fix or --require-c)" >&2; exit 2 ;;
    esac
done

ERRORS=0
C_CHECKED=0   # did the C formatting check actually run?

# ---------------------------------------------------------------------------
# C formatting via clang-format
# ---------------------------------------------------------------------------

PINNED_MAJOR=22

if ! command -v clang-format >/dev/null 2>&1; then
    echo "lint: SKIP: clang-format not found — C formatting checks did NOT run"
else
    CF_VERSION="$(clang-format --version | grep -oP '\d+' | head -1)"
    if [ "$CF_VERSION" != "$PINNED_MAJOR" ]; then
        echo "lint: SKIP: clang-format major is $CF_VERSION, pinned $PINNED_MAJOR — C formatting checks did NOT run"
        echo "lint:       (output varies across major versions; skipped to avoid false positives on a contributor's box)"
    else
        C_FILES=(
            engine/web/*.c
            engine/web/*.h
            tools/archaeology/*.c
        )

        if [ "$FIX" = "1" ]; then
            echo "lint: clang-format --fix on ${#C_FILES[@]} C files"
            clang-format -i "${C_FILES[@]}"
            C_CHECKED=1
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
            C_CHECKED=1
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
    tools/fuzz/*.mjs
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
# Shell pipe-exit-code trap (see tools/check-pipe-exit.mjs and tools/gate.sh)
#
# A pipeline without pipefail reports the LAST command's status, so a failing
# gate piped into `tail` exits 0 and reads as green.  That has happened six
# times here; this keeps it from coming back through a committed script.
# ---------------------------------------------------------------------------

if ! node "$REPO_ROOT/tools/check-pipe-exit.mjs"; then
    ERRORS=1
fi

# ---------------------------------------------------------------------------
# Executable bit on scripts README tells a user to run BARE
#
# README.md's quick start says `tools/run-tests.sh`, with no interpreter.  If
# the mode bit is lost the documented command dies "Permission denied" while
# `bash tools/run-tests.sh` keeps working, so every existing caller stays green
# and only a new reader following the README hits it.  This mesh has paid for
# that exact shape before (four guards calling a mode-644 psafe mirror, every
# call dying into 2>/dev/null for two weeks).  Caused here on 2026-09-11 by an
# atomic-rewrite helper that did not preserve the mode.
# ---------------------------------------------------------------------------

BARE=$(grep -oE '(^|[^a-zA-Z/.])tools/[a-z0-9/-]+\.sh' README.md \
       | grep -oE 'tools/[a-z0-9/-]+\.sh' | sort -u)
BARE_BAD=0
BARE_N=0
for f in $BARE; do
    # only the ones README runs with no interpreter in front of them
    if grep -qE '(bash|sh|source|\.) +'"$f" README.md; then continue; fi
    [ -f "$f" ] || continue
    BARE_N=$((BARE_N + 1))
    if [ ! -x "$f" ]; then
        echo "lint: FAIL $f is not executable, but README invokes it directly"
        BARE_BAD=1
    fi
done
if [ "$BARE_BAD" = "1" ]; then
    ERRORS=1
elif [ "$BARE_N" -eq 0 ]; then
    # A check that found nothing to check is broken, not clean.
    echo "lint: FAIL exec-bit check found 0 bare-invoked scripts in README.md"
    ERRORS=1
else
    echo "lint: exec bit OK ($BARE_N bare-invoked script(s) in README)"
fi

# ---------------------------------------------------------------------------
# Final result
# ---------------------------------------------------------------------------

# A skip that nobody counts is a gate that quietly shrank.  Half of this gate's
# scope (engine/web + tools/archaeology C) evaporates on a version mismatch, and
# it used to print the same "lint: OK" either way (task 21.8).  The suite passes
# --require-c so the host that is supposed to have the pinned toolchain cannot
# silently run half a lint; an ad-hoc run still degrades, but says so.
if [ "$C_CHECKED" = "0" ]; then
    if [ "$REQUIRE_C" = "1" ]; then
        echo "lint: FAILED — C formatting checks did not run and --require-c was given"
        echo "lint:          install clang-format $PINNED_MAJOR, or drop --require-c to accept partial lint"
        exit 1
    fi
    ERRORS_NOTE=" (C CHECKS SKIPPED — JS and pipe-exit only)"
else
    ERRORS_NOTE=""
fi

if [ "$ERRORS" = "1" ]; then
    echo "lint: FAILED — see above"
    exit 1
fi

echo "lint: OK${ERRORS_NOTE}"
