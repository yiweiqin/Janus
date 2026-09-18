#!/bin/bash
# Adversarial probe run on the real GPU box: dry-run the contract, then infer on rows whose shape the
# training corpus provably never contained (a derived-only second cause). Per-case failures are
# contained by predict.py's guard, so a row that overflows the context is reported as invalid rather
# than aborting the batch.
set -uo pipefail
export PATH=/root/autodl-tmp/rdmd-env/bin:$PATH
PY=/root/autodl-tmp/rdmd-env/bin/python
DEPLOY=/root/autodl-tmp/rdmd-deploy/rdmd_detective
CASES=/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/data/adv_cases.jsonl
RUN=/root/autodl-tmp/rdmd-deploy
OUT=$RUN/adv_verdicts.jsonl
ADAPTER=/root/autodl-tmp/rdmd_runs/qlora-v3/adapter
MODEL=/root/autodl-tmp/models/Qwen3-8B
cd "$DEPLOY" || { echo "NO_DEPLOY_DIR $DEPLOY"; exit 2; }

echo "=== preflight ==="
ls -l "$CASES" || exit 2
test -f "$ADAPTER/adapter_config.json" && echo "adapter OK" || { echo "NO_ADAPTER"; exit 2; }
test -d "$MODEL" && echo "model OK" || { echo "NO_MODEL"; exit 2; }
echo "cases: $(wc -l < "$CASES")"

echo "=== dry-run (prompt contract only, no model) ==="
$PY predict.py --input "$CASES" --dry-run --output /tmp/adv_dryrun.jsonl
echo "dryrun_exit=$?"
$PY - <<'PY'
import json
rows = [json.loads(l) for l in open('/tmp/adv_dryrun.jsonl', encoding='utf-8')]
chars = sorted(len(r['prompt']) for r in rows)
print('prompts', len(rows), 'chars min/median/max', chars[0], chars[len(chars) // 2], chars[-1])
PY

echo "=== real inference (GPU 0) ==="
CUDA_VISIBLE_DEVICES=0 $PY -u predict.py \
  --input "$CASES" \
  --output "$OUT" \
  --adapter "$ADAPTER" \
  --model "$MODEL" > "$RUN/adv_predict.log" 2>&1
echo "predict_exit=$?"
tail -n 20 "$RUN/adv_predict.log"

echo "=== verdict summary ==="
$PY - <<'PY'
import collections, json
rows = [json.loads(l) for l in open('/root/autodl-tmp/rdmd-deploy/adv_verdicts.jsonl', encoding='utf-8')]
print('rows', len(rows))
print('status', dict(collections.Counter(r['verdict']['status'] for r in rows)))
print('invalid', sum(1 for r in rows if not r['valid']))
print('warnings', dict(collections.Counter(w for r in rows for w in r['warnings'])))
for r in rows:
    print(r['id'], '->', r['verdict']['status'], r['verdict']['nodeId'], r['verdict']['type'], r['valid'])
PY
echo "ADV_E2E_DONE"
