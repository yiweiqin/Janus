#!/bin/bash
# v2 adapter: evaluate the three remaining splits (eval_unknown, eval_no_drift, development)
# without overwriting the v2 SFT on disk. All three are merged, sharded over 3 GPUs, then
# scored per split from the merged predictions.
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
export HF_ENDPOINT=https://hf-mirror.com
export HF_HOME=/root/autodl-tmp/hf
export PYTHONUNBUFFERED=1
cd /root/autodl-tmp/Janus

RUN=/root/autodl-tmp/rdmd_runs
SFT=/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft
OUT=$RUN/v2extra
mkdir -p "$OUT/shards"

pkill -f 'eval_rdmd_qlora.py' 2>/dev/null || true
sleep 3

/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json
from pathlib import Path
run = Path('/root/autodl-tmp/rdmd_runs/v2extra')
sft = Path('/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft')
splits = ['eval_unknown', 'eval_no_drift', 'development']
rows = []
for split in splits:
    text = (sft / f'{split}.jsonl').read_text(encoding='utf-8')
    part = [line for line in text.splitlines() if line.strip()]
    print('source', split, len(part))
    rows.extend(part)
print('merged total', len(rows))
for gpu in range(3):
    out = run / 'shards' / f'g{gpu}'
    out.mkdir(parents=True, exist_ok=True)
    shard = rows[gpu::3]
    (out / 'test.jsonl').write_text('\n'.join(shard) + '\n', encoding='utf-8')
    print('gpu', gpu, 'rows', len(shard))
PY

for gpu in 0 1 2; do
  CUDA_VISIBLE_DEVICES=$gpu nohup /root/autodl-tmp/rdmd-env/bin/python -u scripts/eval_rdmd_qlora.py \
    --data $OUT/shards/g$gpu \
    --split test \
    --adapter /root/autodl-tmp/rdmd_runs/qlora-v2/adapter \
    --model /root/autodl-tmp/models/Qwen3-8B \
    --output $OUT/shard$gpu.predictions.jsonl \
    > $OUT/shard$gpu.log 2>&1 &
  echo $! > $OUT/shard$gpu.pid
  echo "gpu$gpu pid $(cat $OUT/shard$gpu.pid)"
done
echo LAUNCHED
