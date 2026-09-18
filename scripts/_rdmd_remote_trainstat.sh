#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
RUN_TAG="${RUN_TAG:-qlora-v3}"
RUN=/root/autodl-tmp/rdmd_runs/$RUN_TAG
echo "=== proc ==="
pid=$(cat "$RUN.pid" 2>/dev/null)
if [ -n "$pid" ] && ps -p "$pid" > /dev/null 2>&1; then
  ps -o pid,etime,time,%cpu,cmd -p "$pid" | tail -n 1
else
  echo "NOT_RUNNING (pid=$pid)"
fi
pgrep -af train_qlora_rdmd.py || echo no_trainer_proc
echo "=== stage markers ==="
grep -a 'loading_tokenizer\|^encode \|^encoded \|trainable params\|Running training\|Num examples' "$RUN.train.log" 2>/dev/null | tail -n 12
echo "=== loss tail ==="
grep -a "'loss'" "$RUN.train.log" 2>/dev/null | tail -n 5
echo "=== log tail (raw) ==="
tail -c 600 "$RUN.train.log" 2>/dev/null
echo
echo "=== run manifest ==="
/root/autodl-tmp/rdmd-env/bin/python - <<PY
import json
from pathlib import Path
p = Path("$RUN/run_manifest.json")
if p.is_file():
    m = json.loads(p.read_text(encoding="utf-8-sig"))
    for k in ["status","dataKind","mainLoss","unknownInMainLoss","rows","maxTokens","minimumSupervisedTokens","maxLength"]:
        print(k, "=", m.get(k))
else:
    print("no run_manifest.json yet")
PY
echo "=== outputs ==="
ls -la "$RUN" 2>/dev/null | head -20
echo "=== disk ==="
df -h /root/autodl-tmp | tail -1
echo "=== GPU ==="
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
