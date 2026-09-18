#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
cd /root/autodl-tmp/Janus
/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json
from pathlib import Path
out = Path('/root/autodl-tmp/rdmd_runs/eval-merged.predictions.jsonl')
rows = []
for gpu in range(3):
    p = Path(f'/root/autodl-tmp/rdmd_runs/eval-shard{gpu}.predictions.jsonl')
    if p.is_file():
        rows.extend(line for line in p.read_text(encoding='utf-8').splitlines() if line.strip())
out.write_text('\n'.join(rows) + '\n', encoding='utf-8')
print('merged_preds', len(rows))
PY
/root/autodl-tmp/rdmd-env/bin/python -u scripts/eval_rdmd_qlora.py \
  --data experiments/rdmd_detective_dataset/sft \
  --split test \
  --predictions /root/autodl-tmp/rdmd_runs/eval-merged.predictions.jsonl \
  --output /root/autodl-tmp/rdmd_runs/eval-final.json \
  | tee /root/autodl-tmp/rdmd_runs/eval-final.report.txt
