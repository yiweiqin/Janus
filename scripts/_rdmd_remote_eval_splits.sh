#!/bin/bash
# Generic sharded evaluator: scores every listed SFT split with the adapter of one run tag.
#
# Usage (via rdmd_ssh.py, which exports the vars before the script body):
#   python scripts/rdmd_ssh.py --set RUN_TAG=qlora-v3 \
#     --set "SPLITS=test eval_unknown eval_no_drift development" \
#     --command-file scripts/_rdmd_remote_eval_splits.sh --timeout 120
#
# All splits are merged into one row list and sharded over the 3 GPUs so the slowest split does
# not dominate wall clock. Scoring then happens per split from the merged predictions.
set -uo pipefail
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
export HF_ENDPOINT=https://hf-mirror.com
export HF_HOME=/root/autodl-tmp/hf
export PYTHONUNBUFFERED=1
cd /root/autodl-tmp/Janus

RUN_TAG="${RUN_TAG:?set RUN_TAG (e.g. qlora-v3)}"
SPLITS="${SPLITS:?set SPLITS (space separated)}"
GPUS="${GPUS:-3}"
RUN=/root/autodl-tmp/rdmd_runs
# Overridable so an intermediate checkpoint can be scored while a later run is still training on the
# other GPUs. Defaults reproduce the original behaviour exactly.
ADAPTER="${ADAPTER:-$RUN/$RUN_TAG/adapter}"
OUT="${OUT:-$RUN/eval-$RUN_TAG}"
export RUN_TAG SPLITS GPUS OUT ADAPTER

# Shards are indexed 0..GPUS-1 for filenames, but may be pinned to specific physical GPUs. That lets
# an interim eval use idle cards without touching the one the trainer is using.
if [ -z "${GPU_IDS:-}" ]; then
  GPU_IDS="$(seq 0 $((GPUS - 1)))"
fi
GPU_LIST=$(echo $GPU_IDS | tr '\n' ' ')

if [ ! -f "$ADAPTER/adapter_config.json" ]; then
  echo "MISSING_ADAPTER $ADAPTER"
  exit 1
fi
mkdir -p "$OUT/shards"
# Scope the cleanup to THIS eval's shard inputs. A bare `pkill -f eval_rdmd_qlora.py` would kill any
# other eval running on the box -- e.g. scoring an intermediate checkpoint would take down the final
# eval in progress. The --data path is unique per OUT, so this only clears leftover shards of the
# same eval.
pkill -f "eval_rdmd_qlora.py --data $OUT/shards" 2>/dev/null || true
sleep 3

# 出处必须先写好，否则不起 shard。这个检查是硬停而不是警告：等三个小时跑完再发现
# 判决书无法归属，代价是重跑；在这里停，代价是零。标记由 _rdmd_remote_eval_manifest.sh
# 落，读后即删，所以上一次的残留骗不过这一次。
if [ ! -f "$OUT/.eval_manifest.ready" ]; then
  echo "NO_MANIFEST $OUT：先管 _rdmd_remote_eval_manifest.sh 过来（或用 _rdmd_train_then_eval.py，它按顺序管两个）"
  exit 4
fi
rm -f "$OUT/.eval_manifest.ready"

/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json, os
from pathlib import Path

run_tag = os.environ['RUN_TAG']
splits = os.environ['SPLITS'].split()
gpus = int(os.environ['GPUS'])
out = Path(os.environ['OUT'])
sft = Path('/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft')
rows = []
for split in splits:
    path = sft / f'{split}.jsonl'
    if not path.is_file():
        print('MISSING_SPLIT', split)
        continue
    part = [line for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    print('source', split, len(part))
    rows.extend(part)
print('merged total', len(rows), 'run_tag', run_tag)
for gpu in range(gpus):
    shard_dir = out / 'shards' / f'g{gpu}'
    shard_dir.mkdir(parents=True, exist_ok=True)
    shard = rows[gpu::gpus]
    (shard_dir / 'test.jsonl').write_text('\n'.join(shard) + '\n', encoding='utf-8')
    print('gpu', gpu, 'rows', len(shard))
PY
shard_status=$?
if [ "$shard_status" -ne 0 ]; then
  echo "ABORT shard_status=$shard_status"
  exit "$shard_status"
fi


idx=0
for gpu in $GPU_LIST; do
  CUDA_VISIBLE_DEVICES=$gpu nohup /root/autodl-tmp/rdmd-env/bin/python -u scripts/eval_rdmd_qlora.py \
    --data "$OUT/shards/g$idx" \
    --split test \
    --adapter "$ADAPTER" \
    --model /root/autodl-tmp/models/Qwen3-8B \
    --output "$OUT/shard$idx.predictions.jsonl" \
    > "$OUT/shard$idx.log" 2>&1 &
  echo $! > "$OUT/shard$idx.pid"
  echo "shard$idx on physical gpu$gpu pid $(cat "$OUT/shard$idx.pid")"
  idx=$((idx + 1))
done
echo LAUNCHED "$OUT" adapter="$ADAPTER"
