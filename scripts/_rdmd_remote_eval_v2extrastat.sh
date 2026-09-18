#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
OUT=/root/autodl-tmp/rdmd_runs/v2extra
echo PIDS
for gpu in 0 1 2; do
  pid=$(cat $OUT/shard$gpu.pid 2>/dev/null)
  if ps -p "$pid" > /dev/null 2>&1; then
    echo "gpu$gpu pid=$pid RUNNING"
  else
    echo "gpu$gpu pid=$pid DONE"
  fi
  echo "  progress: $(grep -a '^\[eval\]' $OUT/shard$gpu.log | tail -n 1)"
  echo "  tail: $(tail -c 200 $OUT/shard$gpu.log | tr '\n' ' ')"
done
echo FINAL_REPORTS
for split in eval_unknown eval_no_drift development; do
  if [ -s "$OUT/$split.report.json" ]; then
    echo "--- $split ---"
    cat "$OUT/$split.report.json"
  fi
done
echo GPU
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
