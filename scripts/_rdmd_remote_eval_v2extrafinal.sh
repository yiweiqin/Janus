#!/bin/bash
# Merge v2-extra shard predictions and score each of the three splits separately.
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
cd /root/autodl-tmp/Janus
OUT=/root/autodl-tmp/rdmd_runs/v2extra

/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json
from pathlib import Path
out = Path('/root/autodl-tmp/rdmd_runs/v2extra')
rows = []
for gpu in range(3):
    p = out / f'shard{gpu}.predictions.jsonl'
    if p.is_file():
        rows.extend(line for line in p.read_text(encoding='utf-8').splitlines() if line.strip())
merged = out / 'merged.predictions.jsonl'
merged.write_text('\n'.join(rows) + '\n', encoding='utf-8')
print('merged_preds', len(rows))
PY

for split in eval_unknown eval_no_drift development; do
  echo "=== $split ==="
  /root/autodl-tmp/rdmd-env/bin/python -u scripts/eval_rdmd_qlora.py \
    --data experiments/rdmd_detective_dataset/sft \
    --split $split \
    --predictions $OUT/merged.predictions.jsonl \
    --output $OUT/$split.report.json
done
