#!/bin/bash
OUT="${OUT:-/root/autodl-tmp/rdmd_runs/eval-qlora-v3-checkpoint-530}"
SHARDS="${SHARDS:-2}"
for i in $(seq 0 $((SHARDS - 1))); do
  line=$(grep -ah '^\[eval\]' "$OUT/shard$i.log" 2>/dev/null | tail -n 1)
  alive=no
  pid=$(cat "$OUT/shard$i.pid" 2>/dev/null)
  if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then alive=yes; fi
  echo "shard$i alive=$alive pid=$pid progress=[$line]"
done
echo "train_step=$(grep -ao '[0-9]*/1060' /root/autodl-tmp/rdmd_runs/qlora-v3.train.log 2>/dev/null | tail -n 1)"
echo "== gpu =="
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader
