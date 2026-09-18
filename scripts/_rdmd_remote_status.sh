#!/bin/bash
RUN=/root/autodl-tmp/rdmd_runs/qlora-v3
echo "== trainer process =="
pid=$(cat "$RUN.pid" 2>/dev/null)
if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then echo "ALIVE pid=$pid"; else echo "GONE pid=$pid"; fi
echo "== train log tail =="
tail -c 1200 "$RUN.train.log" 2>/dev/null
echo
echo "== run manifest status =="
if [ -f "$RUN/run_manifest.json" ]; then
  /root/autodl-tmp/rdmd-env/bin/python -c "
import json
m=json.load(open('$RUN/run_manifest.json',encoding='utf-8-sig'))
for k in ('status','dataKind','mainLoss','rows','globalStep','bestDevelopmentLoss','bestCheckpoint','elapsedSeconds','failure'):
    v=m.get(k)
    if v is not None: print(k,'=',v)
"
else
  echo "no run_manifest.json"
fi
echo "== outputs =="
ls -la "$RUN" 2>/dev/null
echo "== adapter =="
ls -la "$RUN/adapter" 2>/dev/null | head -12
echo "== checkpoints =="
ls -d "$RUN"/checkpoints/checkpoint-* 2>/dev/null
echo "== eval dirs =="
ls -d /root/autodl-tmp/rdmd_runs/eval-* 2>/dev/null
echo "== gpu =="
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader
echo "== any python still running =="
pgrep -af 'eval_rdmd_qlora|train_qlora_rdmd' || echo none
