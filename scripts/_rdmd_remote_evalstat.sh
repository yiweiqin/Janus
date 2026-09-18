#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
echo EVAL_PID
cat /root/autodl-tmp/rdmd_runs/eval-test.pid 2>/dev/null
ps -fp $(cat /root/autodl-tmp/rdmd_runs/eval-test.pid 2>/dev/null) 2>/dev/null || echo "eval process not running"
echo EVAL_PROGRESS
grep -a '^\[eval\]' /root/autodl-tmp/rdmd_runs/eval-test.log | tail -n 5
echo EVAL_TAIL
tail -c 1200 /root/autodl-tmp/rdmd_runs/eval-test.log
echo TRAIN_FINAL
/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json
from pathlib import Path
p = Path('/root/autodl-tmp/rdmd_runs/qlora-v2/trainer_state.json')
if p.is_file():
    state = json.loads(p.read_text())
    print('best_metric', state.get('best_metric'))
    print('global_step', state.get('global_step'), 'epoch', state.get('epoch'))
    print('log_history tail:')
    for row in state.get('log_history', [])[-6:]:
        print(row)
else:
    print('no trainer_state.json')
PY
echo GPU
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
