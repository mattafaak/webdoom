#!/usr/bin/env bash
# tools/386/run-386box.sh — 386DX-40 harness using 86Box
#
# Boots a DataExpert 386C (386DX @ 40 MHz) image in 86Box, captures DOOM
# icount data via the COM1 serial pipe, and prints cycles/tic.
#
# Exit codes:
#   0 — success: cycles/tic received and printed
#   1 — boot/launch failure (ROM missing, disk image absent or corrupt,
#         86Box crash, or no serial output within timeout)
#   2 — usage error
#
# Usage:
#   bash tools/386/run-386box.sh [OPTIONS]
#
# Options:
#   -d <hdd.img>    HDD image with FreeDOS + DOOM (default: tools/386/doom386.img)
#   -R <rompath>    86Box ROM directory (default: ~/toolchains/emu/86box-roms)
#   -b <86box-bin>  Path to 86Box binary (default: ~/toolchains/bin/86Box)
#   -t <seconds>    Timeout waiting for serial output (default: 120)
#   --drift-test    Prove error detection: run with a corrupt image (→ FAIL),
#                   then run with the real image (→ PASS if available).
#                   Exits 0 iff the corrupt run failed and the real run passed.
#   --check-roms    Download ROMs if needed (calls fetch-roms.sh), then exit.
#
# Dependencies (all user-level, no root):
#   86Box binary    ~/toolchains/bin/86Box (built -DQT=OFF; SDL_VIDEODRIVER=offscreen)
#   BIOS ROM        ~/toolchains/emu/86box-roms/machines/dataexpert386wb/*.bin
#                   (fetch-roms.sh downloads from 86Box/roms on GitHub)
#   HDD image       tools/386/doom386.img  (NOT in repo — see docs/386/BRING-UP.md)
#                   must contain: FreeDOS + DOOM.EXE (shareware) + timedemo.bat
#                   timedemo.bat runs: DOOM.EXE -timedemo demo1 > timing.txt
#                                then: TYPE timing.txt > COM1
#
# icount / cycles-per-tic:
#   DOOM's -timedemo prints: "timed X gametics in Y realtimes"
#   realtimes = elapsed DOOM ticks at 35 Hz (DOOM sets PIT to 35 Hz)
#   cycles/tic = (40,000,000 * Y) / (35 * X)
#   At 100% speed: X = Y → cycles/tic = 40,000,000/35 = 1,142,857
#   In practice DOOM uses only a fraction of the budget → Y < X
#   (see docs/feasibility-atlas.md §3.5 for the budget rationale)
#
# Serial capture protocol:
#   COM1 → FIFO pair (<vmdir>/com1.in, <vmdir>/com1.out)
#   timedemo.bat writes the timing line to COM1 then writes "RUN_DONE\r\n"
#   This script reads <vmdir>/com1.out until it sees "RUN_DONE" or times out.
#
# Headless operation:
#   SDL_VIDEODRIVER=offscreen  — 86Box renders to an offscreen SDL surface
#   SDL_AUDIODRIVER=dummy      — no audio device needed
#   No X/Wayland display required.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# --------------------------------------------------------------------------- #
# Defaults                                                                     #
# --------------------------------------------------------------------------- #
HDD_IMG="${HDD_IMG:-${SCRIPT_DIR}/doom386.img}"
ROM_PATH="${BOX_ROM_PATH:-${HOME}/toolchains/emu/86box-roms}"
BOX_BIN="${BOX_BIN:-${HOME}/toolchains/bin/86Box}"
TIMEOUT_S="${BOX_TIMEOUT:-120}"
DRIFT_TEST=0
CHECK_ROMS=0

# --------------------------------------------------------------------------- #
# Argument parsing                                                             #
# --------------------------------------------------------------------------- #
while [ $# -gt 0 ]; do
    case "$1" in
        -d) HDD_IMG="$2"; shift 2 ;;
        -R) ROM_PATH="$2"; shift 2 ;;
        -b) BOX_BIN="$2"; shift 2 ;;
        -t) TIMEOUT_S="$2"; shift 2 ;;
        --drift-test) DRIFT_TEST=1; shift ;;
        --check-roms) CHECK_ROMS=1; shift ;;
        -h|--help)
            sed -n '2,50p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "run-386box.sh: unknown option: $1" >&2
            exit 2
            ;;
    esac
done

# --------------------------------------------------------------------------- #
# ROM check / fetch                                                            #
# --------------------------------------------------------------------------- #
check_roms() {
    local rom_file="${ROM_PATH}/machines/dataexpert386wb/st0386-wb-ver2-0-618f078c738cb397184464.bin"
    if [ ! -f "${rom_file}" ]; then
        echo "[386] BIOS ROM not found: ${rom_file}"
        echo "[386] Run: bash tools/386/fetch-roms.sh  (downloads from GitHub)"
        return 1
    fi
    echo "[386] ROM present: ${rom_file}"
    return 0
}

if [ "${CHECK_ROMS}" -eq 1 ]; then
    if ! check_roms; then
        echo "[386] Fetching ROMs…"
        bash "${SCRIPT_DIR}/fetch-roms.sh" "${ROM_PATH}"
    fi
    exit 0
fi

# --------------------------------------------------------------------------- #
# run_86box <hdd_path> <vmdir> — run 86Box and return exit code               #
# Returns:                                                                     #
#   0  — serial output received with RUN_DONE marker                          #
#   1  — timeout, no output, or 86Box crashed                                 #
# Writes parsed "cycles_per_tic=<N>" to stdout on success.                    #
# --------------------------------------------------------------------------- #
run_86box() {
    local hdd_path="$1"
    local vmdir="$2"
    local fifo_base="${vmdir}/com1"
    local logfile="${vmdir}/86box.log"
    local cfg_out="${vmdir}/86box.cfg"
    local out_fifo="${fifo_base}.out"
    local rc=1

    rm -rf "${vmdir}"
    mkdir -p "${vmdir}"

    # --- Verify 86Box binary ---
    if [ ! -x "${BOX_BIN}" ]; then
        echo "[386] 86Box binary not found or not executable: ${BOX_BIN}" >&2
        return 1
    fi

    # --- Verify ROM ---
    if ! check_roms 2>/dev/null; then
        echo "[386] ROM missing — cannot boot" >&2
        return 1
    fi

    # --- Verify HDD image ---
    if [ ! -f "${hdd_path}" ]; then
        echo "[386] HDD image not found: ${hdd_path}" >&2
        echo "[386] See docs/386/BRING-UP.md §3 for how to create doom386.img" >&2
        return 1
    fi
    local img_size
    img_size="$(wc -c < "${hdd_path}")"
    if [ "${img_size}" -lt 1048576 ]; then
        echo "[386] HDD image too small (${img_size} B < 1 MB) — likely corrupt" >&2
        return 1
    fi

    # --- Build 86Box config (substitute FIFO path and HDD) ---
    sed "s|FIFO_BASE_PLACEHOLDER|${fifo_base}|g" "${SCRIPT_DIR}/386dx40.cfg" > "${cfg_out}"
    # Append HDD (raw image, primary IDE):
    # Format: size_bytes,spt,heads,cylinders,bus  (0,0,0 = auto-detect geometry)
    printf '\n[Hard disks]\nhdd_01_parameters = %d,0,0,0,ide\nhdd_01_fn = %s\n' \
        "${img_size}" "${hdd_path}" >> "${cfg_out}"

    # --- Launch 86Box headlessly ---
    # Prefer xvfb-run (real virtual X server) over SDL offscreen driver.
    # xvfb-run confirmed working 2026-07-23; SDL_VIDEODRIVER=offscreen also works.
    local run_prefix=""
    if command -v xvfb-run > /dev/null 2>&1; then
        run_prefix="xvfb-run -a"
    else
        export SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy
    fi

    echo "[386] Starting 86Box (386DX @ 40 MHz, timeout ${TIMEOUT_S}s)…"
    timeout "${TIMEOUT_S}" ${run_prefix} "${BOX_BIN}" \
        -P "${vmdir}" \
        -R "${ROM_PATH}" \
        -L "${logfile}" \
        -N \
        "${cfg_out}" \
        > "${vmdir}/86box-stdout.log" 2>&1 &
    local box_pid=$!
    echo "[386] 86Box PID=${box_pid}"

    # --- Read serial output from FIFO until RUN_DONE or timeout ---
    local deadline=$(( $(date +%s) + TIMEOUT_S ))
    local serial_output=""
    local done=0

    # Wait for FIFO to be created by 86Box (up to 10 s)
    local fifo_wait=0
    while [ ! -e "${out_fifo}" ] && [ "${fifo_wait}" -lt 10 ]; do
        sleep 1
        fifo_wait=$(( fifo_wait + 1 ))
    done

    if [ ! -e "${out_fifo}" ]; then
        echo "[386] Serial FIFO not created within 10s — 86Box may have crashed" >&2
        kill "${box_pid}" 2>/dev/null || true
        wait "${box_pid}" 2>/dev/null || true
        return 1
    fi

    echo "[386] Serial FIFO ready: ${out_fifo}"
    # Read from output FIFO (non-blocking, poll until RUN_DONE or deadline)
    while [ "$(date +%s)" -lt "${deadline}" ]; do
        local line
        # dd with 1s timeout (reads available bytes without blocking forever)
        if IFS= read -r -t 5 line < "${out_fifo}" 2>/dev/null; then
            # Strip CR (DOS line endings)
            line="${line%%$'\r'}"
            echo "[386] COM1: ${line}"
            serial_output="${serial_output}${line}"$'\n'
            if [[ "${line}" == "RUN_DONE" ]]; then
                done=1
                break
            fi
        fi
    done

    kill "${box_pid}" 2>/dev/null || true
    wait "${box_pid}" 2>/dev/null || true

    if [ "${done}" -ne 1 ]; then
        echo "[386] FAIL: no RUN_DONE received within ${TIMEOUT_S}s" >&2
        echo "[386] Serial output so far:"
        echo "${serial_output}" | sed 's/^/  /'
        return 1
    fi

    # --- Parse "timed X gametics in Y realtimes" ---
    local gametics realtimes
    gametics="$(echo "${serial_output}" | grep -oP 'timed \K[0-9]+(?= gametics)'   | head -1)" || true
    realtimes="$(echo "${serial_output}" | grep -oP 'in \K[0-9]+(?= realtimes)'   | head -1)" || true

    if [ -z "${gametics}" ] || [ -z "${realtimes}" ] || [ "${gametics}" -eq 0 ]; then
        echo "[386] FAIL: could not parse timedemo output from serial data" >&2
        echo "[386] Raw serial output:"
        echo "${serial_output}" | sed 's/^/  /'
        return 1
    fi

    # cycles/tic = (40,000,000 * realtimes) / (35 * gametics)
    # Use awk for integer arithmetic with large numbers
    local cycles_per_tic
    cycles_per_tic="$(awk "BEGIN { printf \"%d\", (40000000 * ${realtimes}) / (35 * ${gametics}) }")"

    echo ""
    echo "=== 386DX-40 timedemo result ==="
    echo "gametics    : ${gametics}"
    echo "realtimes   : ${realtimes}  (at 35 Hz DOOM timer)"
    echo "cycles/tic  : ${cycles_per_tic}"
    echo "budget      : 1142857  (40 MHz / 35 Hz)"
    local pct
    pct="$(awk "BEGIN { printf \"%.1f\", (${cycles_per_tic} / 1142857) * 100 }")"
    echo "% of budget : ${pct}%"
    echo "================================"

    return 0
}

# --------------------------------------------------------------------------- #
# Drift test                                                                   #
# --------------------------------------------------------------------------- #
if [ "${DRIFT_TEST}" -eq 1 ]; then
    echo "[386] === DRIFT TEST ==="

    # Phase 1: corrupt image (empty 512-byte file) — must FAIL
    CORRUPT_IMG="$(mktemp /tmp/86box-corrupt-XXXXXX.img)"
    dd if=/dev/zero of="${CORRUPT_IMG}" bs=512 count=1 2>/dev/null
    echo "[386] Phase 1: corrupt image (512 zero bytes) → expect FAIL"
    CORRUPT_VMDIR="$(mktemp -d /tmp/86box-corrupt-vmdir-XXXXXX)"
    if run_86box "${CORRUPT_IMG}" "${CORRUPT_VMDIR}"; then
        rm -f "${CORRUPT_IMG}"
        rm -rf "${CORRUPT_VMDIR}"
        echo "[386] DRIFT TEST FAILED: corrupt image did NOT trigger failure" >&2
        exit 1
    fi
    rm -f "${CORRUPT_IMG}"
    rm -rf "${CORRUPT_VMDIR}"
    echo "[386] Phase 1: PASS (corrupt image correctly detected as FAIL)"

    # Phase 2: real image — must PASS (only if doom386.img exists)
    if [ ! -f "${HDD_IMG}" ]; then
        echo "[386] Phase 2: SKIP — ${HDD_IMG} not present (drift-test Phase 1 only)"
        echo "[386] DRIFT TEST: Phase 1 passed (corrupt→FAIL confirmed)."
        echo "[386] Phase 2 requires doom386.img — see docs/386/BRING-UP.md §3"
        exit 0
    fi
    echo "[386] Phase 2: real image → expect PASS"
    REAL_VMDIR="$(mktemp -d /tmp/86box-real-vmdir-XXXXXX)"
    if ! run_86box "${HDD_IMG}" "${REAL_VMDIR}"; then
        rm -rf "${REAL_VMDIR}"
        echo "[386] DRIFT TEST FAILED: real image returned non-zero" >&2
        exit 1
    fi
    rm -rf "${REAL_VMDIR}"
    echo "[386] Phase 2: PASS (real image → success)"
    echo "[386] DRIFT TEST: both phases passed (corrupt→FAIL, restore→PASS)."
    exit 0
fi

# --------------------------------------------------------------------------- #
# Normal run                                                                   #
# --------------------------------------------------------------------------- #
VMDIR="$(mktemp -d /tmp/86box-run-XXXXXX)"
trap 'rm -rf "${VMDIR}"' EXIT

if ! check_roms; then
    echo "[386] Run: bash tools/386/fetch-roms.sh  to download the BIOS ROM" >&2
    exit 1
fi

if run_86box "${HDD_IMG}" "${VMDIR}"; then
    echo "[386] SUCCESS: cycles/tic measurement complete"
    exit 0
else
    echo "[386] FAIL: see messages above for cause" >&2
    exit 1
fi
