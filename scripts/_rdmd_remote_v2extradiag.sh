#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
OUT=/root/autodl-tmp/rdmd_runs/v2extra
for gpu in 0 1 2; do
  pid=$(cat $OUT/shard$gpu.pid 2>/dev/null)
  echo "=== gpu$gpu pid=$pid ==="
  ps -o pid,etime,time,%cpu,cmd -p "$pid" 2>/dev/null | tail -n 1
  echo "log_bytes $(stat -c %s $OUT/shard$gpu.log 2>/dev/null) mtime $(stat -c %y $OUT/shard$gpu.log 2>/dev/null)"
  echo "eval_lines $(grep -ac '\[eval\]' $OUT/shard$gpu.log 2>/dev/null)"
  echo "preds_lines $(wc -l < $OUT/shard$gpu.predictions.jsonl 2>/dev/null || echo 0)"
done
echo "=== nvidia-smi procs ==="
nvidia-smi --query-compute-apps=pid,used_memory --format=csv
echo "=== last 3 outputs of gpu2 log (raw) ==="
tail -c 400 $OUT/shard2.log
