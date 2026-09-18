#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
export HF_ENDPOINT=https://hf-mirror.com
export HF_HOME=/root/autodl-tmp/hf
export PYTHONUNBUFFERED=1
cd /root/autodl-tmp/Janus

kill $(cat /root/autodl-tmp/rdmd_runs/eval-test.pid 2>/dev/null) 2>/dev/null || true
pkill -f 'eval_rdmd_qlora.py' 2>/dev/null || true
sleep 5

/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json
from pathlib import Path
src = Path('/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/test.jsonl')
rows = [line for line in src.read_text(encoding='utf-8').splitlines() if line.strip()]
for gpu in range(3):
    out = Path(f'/root/autodl-tmp/rdmd_runs/eval_shards/g{gpu}')
    out.mkdir(parents=True, exist_ok=True)
    shard = rows[gpu::3]
    (out / 'test.jsonl').write_text('\n'.join(shard) + '\n', encoding='utf-8')
    print('gpu', gpu, 'rows', len(shard))
PY

for gpu in 0 1 2; do
  CUDA_VISIBLE_DEVICES=$gpu nohup /root/autodl-tmp/rdmd-env/bin/python -u scripts/eval_rdmd_qlora.py \
    --data /root/autodl-tmp/rdmd_runs/eval_shards/g$gpu \
    --split test \
    --adapter /root/autodl-tmp/rdmd_runs/qlora-v2/adapter \
    --model /root/autodl-tmp/models/Qwen3-8B \
    --output /root/autodl-tmp/rdmd_runs/eval-shard$gpu.predictions.jsonl \
    > /root/autodl-tmp/rdmd_runs/eval-shard$gpu.log 2>&1 &
  echo $! > /root/autodl-tmp/rdmd_runs/eval-shard$gpu.pid
  echo "gpu$gpu pid $(cat /root/autodl-tmp/rdmd_runs/eval-shard$gpu.pid)"
done
