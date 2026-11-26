#!/usr/bin/env bash
# P1 acceptance: kill the runner mid-flight, restart, prove nothing double-ran and nothing stuck.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)"
LEDGER="$DIR/ledger.jsonl"
NODE_BIN="${NODE_BIN:-node}"

echo "ledger: $LEDGER"

"$NODE_BIN" "$ROOT/bin/crew-daemon.mjs" --ledger "$LEDGER" --tasks 3 --work 5000 --tick 150 --quiet &
PID=$!
sleep 1.3
kill -9 "$PID" 2>/dev/null
wait "$PID" 2>/dev/null

STARTED=$(grep -c '"type":"run.started"' "$LEDGER")
FINISHED=$(grep -c '"type":"run.finished"' "$LEDGER")
echo "=== killed -9: run.started=$STARTED run.finished=$FINISHED ==="
if [ "$FINISHED" -ge "$STARTED" ]; then
  echo "FAIL: the crash did not leave any run in flight"
  exit 1
fi

OUT=$("$NODE_BIN" "$ROOT/bin/crew-daemon.mjs" --ledger "$LEDGER" --work 150 --tick 80 --ticks 40 --quiet 2>&1)
echo "$OUT"

echo "$OUT" | grep -q 'recovered 3 interrupted run(s)' || { echo "FAIL: restart did not reconcile the crashed runs"; exit 1; }
echo "$OUT" | grep -q 'summary tasks: done=3' || { echo "FAIL: tasks did not all finish after restart"; exit 1; }
echo "$OUT" | grep -q 'invariants: ok' || { echo "FAIL: ledger invariants broken"; exit 1; }

echo "PASS: crashed mid-run, recovered, finished clean"
