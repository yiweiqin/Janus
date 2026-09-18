#!/bin/bash
# Merge shards produced by _rdmd_remote_eval_splits.sh, then score each requested split.
# Usage: python scripts/rdmd_ssh.py --set RUN_TAG=qlora-v3 --set "SPLITS=test eval_unknown" \
#          --command-file scripts/_rdmd_remote_eval_splits_final.sh --timeout 300
set -uo pipefail
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
cd /root/autodl-tmp/Janus

RUN_TAG="${RUN_TAG:?set RUN_TAG}"
SPLITS="${SPLITS:?set SPLITS}"
GPUS="${GPUS:-3}"
RUN=/root/autodl-tmp/rdmd_runs
# Honour an exported OUT/GPUS. The launcher gained ADAPTER/OUT/GPU_IDS overrides so an interim
# checkpoint can be scored on idle GPUs; without the same override here the finaliser looked in the
# default directory, found no shards, and reported SHARDS_NOT_READY even though every shard had
# already written its predictions.
OUT="${OUT:-$RUN/eval-$RUN_TAG}"
export OUT GPUS

echo PIDS
for gpu in $(seq 0 $((GPUS - 1))); do
  pid=$(cat "$OUT/shard$gpu.pid" 2>/dev/null || echo '')
  if [ -n "$pid" ] && ps -p "$pid" > /dev/null 2>&1; then
    echo "gpu$gpu pid=$pid RUNNING  progress: $(grep -a '^\[eval\]' "$OUT/shard$gpu.log" | tail -n 1)"
  else
    echo "gpu$gpu pid=$pid DONE"
  fi
done

/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import os
from pathlib import Path
out = Path(os.environ['OUT'])
gpus = int(os.environ['GPUS'])
rows = []
missing = []
for gpu in range(gpus):
    path = out / f'shard{gpu}.predictions.jsonl'
    if path.is_file():
        rows.extend(line for line in path.read_text(encoding='utf-8').splitlines() if line.strip())
    else:
        missing.append(gpu)
if missing:
    print('SHARDS_NOT_READY', missing)
    raise SystemExit(2)
(out / 'merged.predictions.jsonl').write_text('\n'.join(rows) + '\n', encoding='utf-8')
print('merged_preds', len(rows))
PY
merge_status=$?
if [ "$merge_status" -ne 0 ]; then
  echo "ABORT merge_status=$merge_status"
  exit "$merge_status"
fi

for split in $SPLITS; do
  echo "=== $split ==="
  /root/autodl-tmp/rdmd-env/bin/python -u scripts/eval_rdmd_qlora.py \
    --data experiments/rdmd_detective_dataset/sft \
    --split "$split" \
    --predictions "$OUT/merged.predictions.jsonl" \
    --output "$OUT/$split.report.json"
done
echo "REPORTS_DONE $OUT"
