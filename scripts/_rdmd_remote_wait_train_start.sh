#!/bin/bash
# Block until v3 training produces its first loss line, or the process dies, or we time out.
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
RUN_TAG="${RUN_TAG:-qlora-v3}"
RUN=/root/autodl-tmp/rdmd_runs/$RUN_TAG
LOG="$RUN.train.log"
DEADLINE=$(( $(date +%s) + ${WAIT_SECONDS:-1500} ))

while true; do
  pid=$(cat "$RUN.pid" 2>/dev/null)
  alive=no
  if [ -n "$pid" ] && ps -p "$pid" > /dev/null 2>&1; then alive=yes; fi
  loss=$(grep -a "'loss'" "$LOG" 2>/dev/null | tail -n 1)

  if [ -n "$loss" ]; then
    echo "FIRST_LOSS_SEEN"
    grep -a "'loss'" "$LOG" | tail -n 3
    echo "--- stage ---"
    grep -a '^encoded \|trainable params\|Running training\|Num examples' "$LOG" | tail -n 5
    exit 0
  fi
  if [ "$alive" = "no" ]; then
    echo "PROCESS_DIED_BEFORE_FIRST_LOSS"
    echo "--- tail ---"
    tail -c 1500 "$LOG"
    exit 1
  fi
  now=$(date +%s)
  if [ "$now" -gt "$DEADLINE" ]; then
    echo "TIMEOUT_STILL_ENCODING"
    echo "--- tail ---"
    tail -c 600 "$LOG"
    exit 2
  fi
  sleep 20
done
