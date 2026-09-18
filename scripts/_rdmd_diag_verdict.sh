#!/usr/bin/env bash
# 诊断：模型对"这条真实 case"到底回了什么。
# 云侧 400 说 drift 判定缺 nodeId/type —— 要看的是**原始 completion** 与 predict.py 的
# 归一结果，而不是猜。所以这里直接跑 predict.py 并把 JSONL 原样打出来。
set -uo pipefail
PY=/root/autodl-tmp/rdmd-env/bin/python
JANUS_TRAIN=/root/autodl-tmp/Janus
DEPLOY="$JANUS_TRAIN/experiments/rdmd_detective_dataset/deploy"
ADAPTER=/root/autodl-tmp/rdmd_runs/qlora-v3/adapter
BASE=/root/autodl-tmp/models/Qwen3-8B
DEVICE="${RDMD_DEVICE:-cuda:1}"

JOB_ID="${1:-rdmdjob_dd711e08-60dd-4c42-856f-e96b648170ee}"
[ -f /root/.config/janus/remote.env ] && { set -a; . /root/.config/janus/remote.env; set +a; }

CASE=/tmp/rdmd_diag_case.json
OUT=/tmp/rdmd_diag_out.jsonl
psql "$DATABASE_URL" -tAc "SELECT case_json FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB_ID'" > "$CASE"
echo "case_bytes=$(stat -c%s "$CASE")"

echo
echo "############ 真实生成（max-new-tokens 256）############"
"$PY" "$DEPLOY/predict.py" --input "$CASE" --output "$OUT" \
  --model "$BASE" --adapter "$ADAPTER" --device "$DEVICE" --max-new-tokens 256 2>&1 | tail -5
echo "predict_exit=$?"

echo
echo "############ predict.py 的 JSONL 记录（原样）############"
"$PY" - "$OUT" <<'PYEOF'
import json, sys
path = sys.argv[1]
for line in open(path, encoding='utf-8'):
    if not line.strip():
        continue
    record = json.loads(line)
    print('keys           :', sorted(record.keys()))
    print('valid          :', record.get('valid'))
    print('warnings       :', record.get('warnings'))
    print('verdict        :', json.dumps(record.get('verdict'), ensure_ascii=False))
    raw = record.get('raw_completion') or record.get('completion') or record.get('raw') or ''
    print('raw_completion :', repr(raw)[:1200])
    print('-' * 60)
PYEOF
