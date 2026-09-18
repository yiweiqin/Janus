#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
echo PIDS
for gpu in 0 1 2; do
  pid=$(cat /root/autodl-tmp/rdmd_runs/eval-shard$gpu.pid 2>/dev/null)
  if ps -p "$pid" > /dev/null 2>&1; then
    echo "gpu$gpu pid=$pid RUNNING"
  else
    echo "gpu$gpu pid=$pid DONE"
  fi
  echo "  progress: $(grep -a '^\[eval\]' /root/autodl-tmp/rdmd_runs/eval-shard$gpu.log | tail -n 1)"
  echo "  tail: $(tail -c 300 /root/autodl-tmp/rdmd_runs/eval-shard$gpu.log | tr '\n' ' ' | tail -c 300)"
done
echo FINAL_REPORT
if [ -s /root/autodl-tmp/rdmd_runs/eval-final.json ]; then
  cat /root/autodl-tmp/rdmd_runs/eval-final.json
else
  echo "not ready"
fi
echo GPU
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
