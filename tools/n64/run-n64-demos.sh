#!/usr/bin/env bash
# tools/n64/run-n64-demos.sh — N64 ares sim-hash gate (task 20.4c).
#
# Builds N64 ROMs for 13 demos across 4 IWADs, runs each in ares with the
# GDB debug stub, dumps the per-tic sim-hash trace via GDB, and compares
# against tools/golden/<iwad>-<demo>.json bit-by-bit.
#
# DoD: exits 0 iff all 13 traces match golden bit-identically.
# Partial results are reported honestly with the count.
#
# Prerequisites:
#   source ~/toolchains/env.sh  (mips64-elf-gcc, ares, N64_INST)
#   wads/lib/ populated with doom.wad, doom2.wad, tnt.wad, plutonia.wad
#   gdb (system GDB, tested with GDB 17.2)
#   xvfb-run (for headless ares)
#   nc (for port-open check)
#   python3
#
# Usage:
#   bash tools/gate.sh n64-demos -- bash tools/n64/run-n64-demos.sh
#
# Engine/core: 0-diff.  Only tools/n64/ changes.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GOLDEN_DIR="$REPO_ROOT/tools/golden"
N64_DIR="$SCRIPT_DIR"
WORK_DIR="$N64_DIR/n64_trace_work"

# Toolchain environment (mips64-elf-gcc, ares, N64_INST, LIBDRAGON, etc.)
if [ -f "$HOME/toolchains/env.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/toolchains/env.sh"
fi

# GDB stub port (ares developer server default).
GDB_PORT=9123

# Timeout in seconds per demo run.
# Longest demo: plutonia-demo1 = 7403 tics @ 35 Hz = ~211 s real-time.
# ares typically runs at 150–300 % speed; 600 s is generous.
GDB_TIMEOUT=600

ARES="${ARES:-ares}"
GDB="${GDB:-gdb}"

# ── Sanity checks ────────────────────────────────────────────────────────────

if ! command -v "$ARES" >/dev/null 2>&1; then
    echo "run-n64-demos: ERROR: ares not found on PATH (try: source ~/toolchains/env.sh)" >&2
    exit 1
fi

if ! command -v "$GDB" >/dev/null 2>&1; then
    echo "run-n64-demos: ERROR: gdb not found" >&2
    exit 1
fi

if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "run-n64-demos: ERROR: xvfb-run not found (install xvfb package)" >&2
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "run-n64-demos: ERROR: python3 not found" >&2
    exit 1
fi

# ── Demo manifest ────────────────────────────────────────────────────────────
# Format: "iwad_key:wad_filename:wad_name_for_engine:demo_name"
# wad_name_for_engine: what IdentifyVersion() sees in d_main.c:592-630.
# doom.wad is Ultimate DOOM → present as doomu.wad.

DEMOS="
doom:doom.wad:doomu.wad:demo1
doom:doom.wad:doomu.wad:demo2
doom:doom.wad:doomu.wad:demo3
doom:doom.wad:doomu.wad:demo4
doom2:doom2.wad:doom2.wad:demo1
doom2:doom2.wad:doom2.wad:demo2
doom2:doom2.wad:doom2.wad:demo3
tnt:tnt.wad:tnt.wad:demo1
tnt:tnt.wad:tnt.wad:demo2
tnt:tnt.wad:tnt.wad:demo3
plutonia:plutonia.wad:plutonia.wad:demo1
plutonia:plutonia.wad:plutonia.wad:demo2
plutonia:plutonia.wad:plutonia.wad:demo3
"

TOTAL=0
PASS=0
FAIL=0
FAIL_NAMES=""

mkdir -p "$WORK_DIR"

# ── Helper: wait for GDB port ─────────────────────────────────────────────────

wait_for_port() {
    local port="$1"
    local retries=0
    local max_retries=120  # ares GDB stub can take up to ~90 s to open
    while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
        retries=$((retries + 1))
        if [ "$retries" -ge "$max_retries" ]; then
            return 1
        fi
        sleep 1
    done
    return 0
}

# ── Helper: kill any stale ares on GDB_PORT ───────────────────────────────────

kill_stale_ares() {
    # Attempt graceful kill of any process holding GDB_PORT.
    # Failure is acceptable (process may not exist).
    local pid
    pid=$(ss -tlnp "sport = :$GDB_PORT" 2>/dev/null \
          | grep -oP '(?<=pid=)\d+' | head -1 || true)
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        sleep 1
    fi
}

# ── Main loop ────────────────────────────────────────────────────────────────

PREV_IWAD=""

for entry in $DEMOS; do
    [ -z "$entry" ] && continue

    IWAD_KEY="${entry%%:*}"; rest="${entry#*:}"
    WAD_FILE="${rest%%:*}";  rest="${rest#*:}"
    WAD_NAME="${rest%%:*}";  DEMO="${rest#*:}"

    WAD_PATH="$REPO_ROOT/wads/lib/$WAD_FILE"
    TAG="${IWAD_KEY}-${DEMO}"
    ELF="$WORK_DIR/${TAG}.elf"
    ROM="$WORK_DIR/${TAG}.z64"
    TRACE_BIN="$WORK_DIR/${TAG}.trace.bin"
    GDB_SCRIPT="$WORK_DIR/${TAG}.gdb"
    GDB_LOG="$WORK_DIR/${TAG}.gdb.log"

    TOTAL=$((TOTAL + 1))

    echo ""
    echo "=== [$TOTAL/13] Building $TAG ==="

    if [ ! -f "$WAD_PATH" ]; then
        echo "FAIL: $TAG — WAD not found: $WAD_PATH"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(missing-wad)"
        continue
    fi

    # Force-rebuild n64_main.o: its compiled content changes with every
    # N64_TIMEDEMO and every N64_WAD_LEN (different WAD file sizes).
    rm -f "$N64_DIR/obj/plat/n64_main.o"

    # First build for a new IWAD also forces n64_hash.o rebuild in case of
    # stale objects from a previous IWAD (same N64_WAD_LEN might be cached).
    if [ "$IWAD_KEY" != "$PREV_IWAD" ]; then
        rm -f "$N64_DIR/obj/plat/n64_hash.o"
    fi
    PREV_IWAD="$IWAD_KEY"

    # Build ROM.  Parallelise across CPUs; route only tail of stdout.
    if ! make -j"$(nproc)" -C "$N64_DIR" \
            N64_WAD="$WAD_PATH" \
            N64_WAD_NAME="$WAD_NAME" \
            N64_TIMEDEMO="$DEMO" \
            OUT_ELF="$ELF" \
            OUT_ROM="$ROM" 2>&1 | tail -4; then
        echo "FAIL: $TAG — make failed"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(build-fail)"
        continue
    fi

    if [ ! -f "$ELF" ] || [ ! -f "$ROM" ]; then
        echo "FAIL: $TAG — ROM/ELF missing after make"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(build-fail)"
        continue
    fi

    echo "=== [$TOTAL/13] Running $TAG in ares (GDB stub on :$GDB_PORT) ==="

    # Kill any stale ares on the GDB port before starting fresh.
    kill_stale_ares

    # Start ares headlessly with the GDB debug stub.
    rm -f "$TRACE_BIN"
    ARES_PID=""
    xvfb-run -a "$ARES" \
        --setting Developer/DebugServerEnabled=true \
        --setting Developer/DebugServerUseIPv4=true \
        --system "Nintendo 64" \
        --no-file-prompt "$ROM" \
        >"$GDB_LOG.ares" 2>&1 &
    ARES_PID=$!

    # Wait for the GDB stub port to open (up to 60 s).
    if ! wait_for_port "$GDB_PORT"; then
        echo "FAIL: $TAG — ares GDB stub did not open :$GDB_PORT within 30 s"
        kill "$ARES_PID" 2>/dev/null || true
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(stub-timeout)"
        continue
    fi

    # Generate GDB batch script.
    # ares's GDB stub keeps the CPU running after connection — 'continue'
    # fails ("target is running").  Use GDB's Python API to poll
    # n64_trace_len via memory-read packets (m-packet: works while CPU
    # runs, confirmed in diagnostics).  Stability detection:
    #   - poll every POLL_SECS seconds
    #   - when trace_len > 0 and hasn't changed for STABLE_NEEDED polls
    #     (STABLE_NEEDED × POLL_SECS seconds), the demo is complete
    #     (CPU is spinning in n64_demo_complete_halt's infinite loop)
    # addr_trace must use &n64_trace (address of array) not n64_trace
    # (which evaluates to the VALUE at n64_trace[0] in GDB).
    {
        printf 'set auto-load safe-path /\n'
        printf 'set architecture mips:4000\n'
        printf 'set pagination off\n'
        printf 'file %s\n' "$ELF"
        printf 'target remote 127.0.0.1:%d\n' "$GDB_PORT"
        printf 'python\n'
        printf 'import gdb, time\n'
        printf 'TRACE_BIN      = "%s"\n'  "$TRACE_BIN"
        printf 'MAX_WAIT       = %d\n'    "$GDB_TIMEOUT"
        printf 'POLL_SECS      = 5\n'
        printf 'STABLE_NEEDED  = 6\n'     # 6 × 5 s = 30 s of stability
        printf 'prev_len       = -1\n'
        printf 'stable         = 0\n'
        printf 'inf            = gdb.selected_inferior()\n'
        printf 'addr_len   = int(gdb.parse_and_eval("(unsigned int)&n64_trace_len"))\n'
        printf 'addr_trace = int(gdb.parse_and_eval("(unsigned int)&n64_trace"))\n'
        printf 'print(f"addr_len=0x{addr_len:08x} addr_trace=0x{addr_trace:08x}")\n'
        printf 'deadline   = time.monotonic() + MAX_WAIT\n'
        printf 'while time.monotonic() < deadline:\n'
        printf '    try:\n'
        printf '        raw4 = bytes(inf.read_memory(addr_len, 4))\n'
        printf '        cur  = int.from_bytes(raw4, "big")\n'
        printf '    except Exception as e:\n'
        printf '        print(f"ERROR: memory read failed: {e}")\n'
        printf '        gdb.execute("quit 1")\n'
        printf '        break\n'
        printf '    if cur > 0 and cur == prev_len:\n'
        printf '        stable += 1\n'
        printf '        print(f"  stable={stable}/{STABLE_NEEDED} trace_len={cur}")\n'
        printf '        if stable >= STABLE_NEEDED:\n'
        printf '            break\n'
        printf '    else:\n'
        printf '        if cur != prev_len:\n'
        printf '            print(f"  trace_len={cur} (was {prev_len})")\n'
        printf '        stable = 0\n'
        printf '    prev_len = cur\n'
        printf '    time.sleep(POLL_SECS)\n'
        printf 'raw4 = bytes(inf.read_memory(addr_len, 4))\n'
        printf 'n    = int.from_bytes(raw4, "big")\n'
        printf 'print(f"N64_TRACE_LEN={n}")\n'
        printf 'if n <= 0 or n > 10000:\n'
        printf '    print(f"ERROR: trace never completed (n={n})")\n'
        printf '    gdb.execute("quit 1")\n'
        printf 'else:\n'
        printf '    raw = bytes(inf.read_memory(addr_trace, n * 4))\n'
        printf '    open(TRACE_BIN, "wb").write(raw)\n'
        printf '    print(f"TRACE_WRITTEN:{len(raw)}_bytes")\n'
        printf '    gdb.execute("quit 0")\n'
        printf 'end\n'
    } > "$GDB_SCRIPT"

    # Run GDB batch with per-demo timeout.
    GDB_RC=0
    timeout "$GDB_TIMEOUT" "$GDB" -batch -x "$GDB_SCRIPT" \
        >"$GDB_LOG" 2>&1 || GDB_RC=$?

    # Kill ares (demo is done or timed out).
    kill "$ARES_PID" 2>/dev/null || true
    ARES_PID=""

    if [ "$GDB_RC" -eq 124 ]; then
        echo "FAIL: $TAG — GDB timed out after ${GDB_TIMEOUT}s (demo did not complete)"
        tail -5 "$GDB_LOG" >&2
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(gdb-timeout)"
        continue
    fi

    if [ ! -f "$TRACE_BIN" ] || [ ! -s "$TRACE_BIN" ]; then
        echo "FAIL: $TAG — trace binary not produced by GDB"
        tail -10 "$GDB_LOG" >&2
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(no-trace)"
        continue
    fi

    # Compare trace against golden.
    GOLDEN="$GOLDEN_DIR/${TAG}.json"
    if [ ! -f "$GOLDEN" ]; then
        echo "FAIL: $TAG — golden not found: $GOLDEN"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG(no-golden)"
        continue
    fi

    # Parse big-endian uint32 dump and compare against JSON golden.
    RESULT=$(python3 - "$TRACE_BIN" "$GOLDEN" << 'PYEOF'
import sys, struct, json

trace_bin  = sys.argv[1]
golden_path = sys.argv[2]

raw = open(trace_bin, 'rb').read()
if len(raw) == 0:
    print("FAIL:empty_trace")
    sys.exit(0)
if len(raw) % 4 != 0:
    print(f"FAIL:bad_trace_size:{len(raw)}_bytes")
    sys.exit(0)

n = len(raw) // 4
# N64 is big-endian; dump bytes are raw target memory.
trace = list(struct.unpack(f'>{n}I', raw))

golden = json.load(open(golden_path))
expected = [int(x) for x in golden['trace']]
g_tics   = golden['tics']

if len(trace) != len(expected):
    print(f"FAIL:len_mismatch:n64={len(trace)},golden={len(expected)}")
    sys.exit(0)

first_bad = None
for i, (a, b) in enumerate(zip(trace, expected)):
    if a != b:
        first_bad = i
        break

if first_bad is not None:
    bad_count = sum(1 for a, b in zip(trace, expected) if a != b)
    print(f"FAIL:hash_mismatch:first_at_tic={first_bad},"
          f"n64=0x{trace[first_bad]:08x},"
          f"golden=0x{expected[first_bad]:08x},"
          f"mismatches={bad_count}/{len(expected)}")
    sys.exit(0)

print(f"PASS:{len(trace)}_tics")
PYEOF
)

    if [[ "$RESULT" == PASS:* ]]; then
        echo "PASS: $TAG ($RESULT)"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $TAG — $RESULT"
        FAIL=$((FAIL + 1))
        FAIL_NAMES="$FAIL_NAMES $TAG($RESULT)"
    fi
done

# ── Final report ─────────────────────────────────────────────────────────────

echo ""
if [ "$FAIL" -eq 0 ]; then
    echo "PASS — all N64 sim-hash goldens bit-identical ($PASS demos)"
    exit 0
else
    echo "FAIL — $PASS/$TOTAL N64 sim-hash demos matched golden"
    echo "Failed:$FAIL_NAMES"
    exit 1
fi
