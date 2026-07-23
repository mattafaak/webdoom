#!/usr/bin/env bash
# tools/386/fetch-roms.sh — download 86Box BIOS ROMs for the 386DX-40 harness.
#
# ROMs are sourced from the public 86Box/roms repository on GitHub.
# They are NOT committed to this repo (licensed for redistribution but
# vary by manufacturer).  86Box finds them via -R <rompath>.
#
# Usage:
#   bash tools/386/fetch-roms.sh               # default dest: ~/toolchains/emu/86box-roms
#   bash tools/386/fetch-roms.sh /path/to/roms # explicit dest
#
# The DataExpert 386C [OPTi 391] machine is the chosen 386DX-40 profile:
#   - Supports 386DX at 33–40 MHz (max_bus = 40 MHz in 86Box machine table)
#   - ROM available as a single 64 KB binary on GitHub (public, no login)
#   - Used by the 386dx40.cfg config in this directory
#
# Design mirrors tools/setup-emsdk.sh and tools/fetch-soundfont.sh:
# idempotent (skip if already present), fail-fast on download error.
set -eo pipefail

ROMPATH="${1:-${HOME}/toolchains/emu/86box-roms}"
BASE_URL="https://raw.githubusercontent.com/86Box/roms/master"

# --- machine: DataExpert 386C (dataexpert386wb) ---
# internal_name used in 386dx40.cfg; max_bus = 40 MHz (386DX-40 profile)
MACHINE_DIR="${ROMPATH}/machines/dataexpert386wb"
ROM_FILE="${MACHINE_DIR}/st0386-wb-ver2-0-618f078c738cb397184464.bin"
ROM_URL="${BASE_URL}/machines/dataexpert386wb/st0386-wb-ver2-0-618f078c738cb397184464.bin"
ROM_SIZE=65536    # 64 KB — must match exactly

echo "[fetch-roms] ROM dest: ${ROMPATH}"

if [ -f "${ROM_FILE}" ]; then
    actual_size="$(wc -c < "${ROM_FILE}")"
    if [ "${actual_size}" -eq "${ROM_SIZE}" ]; then
        echo "[fetch-roms] ROM already present (${actual_size} B): ${ROM_FILE}"
        echo "[fetch-roms] DONE (no-op)"
        exit 0
    fi
    echo "[fetch-roms] WARN: existing ROM has wrong size (${actual_size} != ${ROM_SIZE}), re-downloading"
fi

mkdir -p "${MACHINE_DIR}"
echo "[fetch-roms] Downloading DataExpert 386C ROM (MR BIOS V1.26, 64 KB)…"
curl -fsSL --max-time 30 --retry 3 \
    "${ROM_URL}" -o "${ROM_FILE}"

actual_size="$(wc -c < "${ROM_FILE}")"
if [ "${actual_size}" -ne "${ROM_SIZE}" ]; then
    echo "[fetch-roms] ERROR: downloaded ROM has wrong size (${actual_size} != ${ROM_SIZE})" >&2
    rm -f "${ROM_FILE}"
    exit 1
fi
echo "[fetch-roms] ROM downloaded: ${ROM_FILE} (${actual_size} B)"

# Verify 86Box recognizes the machine (optional, requires 86Box on PATH or default location)
BOX_BIN="${BOX_BIN:-${HOME}/toolchains/bin/86Box}"
if [ -x "${BOX_BIN}" ]; then
    MISSING_OUT="$(mktemp /tmp/86box-missing-XXXXXX.log)"
    trap 'rm -f "${MISSING_OUT}"' EXIT
    export SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy
    timeout 8 "${BOX_BIN}" -R "${ROMPATH}" --missing 2>/dev/null > "${MISSING_OUT}" || true
    if grep -qF "[OPTi 391] DataExpert 386C" "${MISSING_OUT}"; then
        echo "[fetch-roms] WARN: 86Box still lists DataExpert 386C as missing — ROM path may be wrong" >&2
        exit 1
    fi
    echo "[fetch-roms] Verified: DataExpert 386C not in 86Box missing list (ROM found)"
else
    echo "[fetch-roms] 86Box binary not found at ${BOX_BIN}, skipping ROM verification"
fi

echo "[fetch-roms] DONE. Set BOX_ROM_PATH=${ROMPATH} or pass to run-386box.sh -R <path>"
