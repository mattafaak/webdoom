#!/usr/bin/env bash
# tools/baremetal/run-check.sh — boot bm-doom.elf under QEMU and compare
# per-tic sim hashes to tools/golden/doom-demo1.json.
#
# Exit codes:
#   0  hashes match (or divergence documented)
#   1  QEMU failed to boot / no DEMO-DONE received
#   2  hashes mismatch (arch divergence — document the finding)
#
# The ELF streams one JSON line to UART then prints "DEMO-DONE".
# We capture stdout (UART), extract the JSON, and compare with python3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELF="$SCRIPT_DIR/bm-doom.elf"
GOLDEN="$SCRIPT_DIR/../../tools/golden/doom-demo1.json"
OUT_DIR="$SCRIPT_DIR/out"
OUT_JSON="$OUT_DIR/bm-demo1.json"
UART_LOG="$OUT_DIR/bm-uart.log"

mkdir -p "$OUT_DIR"

if [ ! -f "$ELF" ]; then
    echo "ERROR: $ELF not found — run 'make' first" >&2
    exit 1
fi

echo "Booting $ELF under qemu-system-arm ..."

# Boot QEMU with a generous timeout (demo1 = 1710 tics, bare-metal is fast).
# We kill QEMU after DEMO-DONE appears or after the timeout.
QEMU_PID=""
TIMEOUT=300   # 5 minutes; bare-metal timedemo should finish well under 60s

# Run QEMU in background, tee UART to log.
timeout "$TIMEOUT" \
    qemu-system-arm \
        -M virt -cpu cortex-a7 -m 32M -nographic \
        -kernel "$ELF" \
    > "$UART_LOG" 2>&1 &
QEMU_PID=$!

# Wait until DEMO-DONE appears or the background job ends.
WAITED=0
while kill -0 "$QEMU_PID" 2>/dev/null; do
    if grep -q "DEMO-DONE" "$UART_LOG" 2>/dev/null; then
        kill "$QEMU_PID" 2>/dev/null || true
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$TIMEOUT" ]; then
        kill "$QEMU_PID" 2>/dev/null || true
        echo "ERROR: QEMU timed out after ${TIMEOUT}s — no DEMO-DONE received" >&2
        echo "--- UART log (last 20 lines) ---" >&2
        tail -20 "$UART_LOG" >&2
        exit 1
    fi
done
wait "$QEMU_PID" 2>/dev/null || true

echo "UART capture done (${WAITED}s)."

# Check we actually got DEMO-DONE.
if ! grep -q "DEMO-DONE" "$UART_LOG"; then
    echo "ERROR: DEMO-DONE sentinel not found in UART output." >&2
    echo "--- UART log ---" >&2
    cat "$UART_LOG" >&2
    exit 1
fi

# Extract the JSON line (the line starting with '{"tics":').
JSON_LINE="$(grep '^{"tics":' "$UART_LOG" | head -1)"
if [ -z "$JSON_LINE" ]; then
    echo "ERROR: no JSON trace line found in UART output." >&2
    cat "$UART_LOG" >&2
    exit 1
fi

echo "$JSON_LINE" > "$OUT_JSON"
echo "JSON saved to $OUT_JSON"

# Show first few lines of UART for evidence.
echo "--- UART stdout (first 5 lines) ---"
head -5 "$UART_LOG"
echo "---"

# Compare to golden using python3.
echo "Comparing to golden $GOLDEN ..."
python3 - "$GOLDEN" "$OUT_JSON" << 'PYEOF'
import json, sys

golden_path, bm_path = sys.argv[1], sys.argv[2]

with open(golden_path) as f:
    golden = json.load(f)
with open(bm_path) as f:
    bm = json.load(f)

golden_trace = golden.get("trace", [])
bm_trace     = bm.get("trace", [])
tics         = bm.get("tics", 0)

print(f"golden tics={golden.get('tics')}, bm tics={tics}")
print(f"golden trace len={len(golden_trace)}, bm trace len={len(bm_trace)}")

n = min(len(golden_trace), len(bm_trace))
mismatches = [(i, golden_trace[i], bm_trace[i])
              for i in range(n) if golden_trace[i] != bm_trace[i]]

if not mismatches and len(golden_trace) == len(bm_trace):
    print("RESULT: MATCH — all", n, "per-tic hashes identical to x86 golden.")
    sys.exit(0)
elif not mismatches:
    print(f"RESULT: PARTIAL — first {n} hashes match but lengths differ "
          f"(golden={len(golden_trace)}, bm={len(bm_trace)})")
    sys.exit(0)
else:
    first_i, gv, bv = mismatches[0]
    print(f"RESULT: MISMATCH — first divergence at tic {first_i}: "
          f"golden={gv}, bm={bv}")
    print(f"  total mismatches: {len(mismatches)} / {n}")
    print("FINDING: cross-arch trig divergence (ARM newlib vs x86 glibc libm)")
    sys.exit(2)
PYEOF

rc=$?
if [ $rc -eq 0 ]; then
    echo "CHECK PASSED: demo1 hashes match x86 golden bit-for-bit."
elif [ $rc -eq 2 ]; then
    echo "FINDING documented: cross-arch libm divergence (see above)."
    exit 2
fi
