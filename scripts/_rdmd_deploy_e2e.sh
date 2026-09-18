#!/bin/bash
# End-to-end check of the delivered package on the real GPU box: contract dry-run, then real
# inference against the actual adapter + base model, then score against the gold fixture.
set -uo pipefail
export PATH=/root/autodl-tmp/rdmd-env/bin:$PATH
PY=/root/autodl-tmp/rdmd-env/bin/python
DEPLOY=/root/autodl-tmp/rdmd-deploy/rdmd_detective
cd "$DEPLOY" || { echo "NO_DEPLOY_DIR $DEPLOY"; exit 2; }

echo "=== deps ==="
$PY -c "import torch,peft,transformers;print('torch',torch.__version__,'| peft',peft.__version__,'| transformers',transformers.__version__)" 2>&1

echo "=== python syntax of delivered files ==="
$PY -m py_compile rdmd_detective.py predict.py && echo "SYNTAX_OK"

echo "=== dry-run (builds prompts, no model) ==="
CUDA_VISIBLE_DEVICES=0 $PY predict.py --input examples/smoke_cases.jsonl \
  --dry-run --output /tmp/rdmd_dryrun.jsonl
echo "dryrun_exit=$?"
$PY -c "
import json
rows=[json.loads(l) for l in open('/tmp/rdmd_dryrun.jsonl',encoding='utf-8')]
print('dryrun rows', len(rows))
print('promptChars min/max', min(r['promptChars'] for r in rows), max(r['promptChars'] for r in rows))
"

echo "=== real inference (GPU 0) ==="
CUDA_VISIBLE_DEVICES=0 $PY -u predict.py \
  --input examples/smoke_cases.jsonl \
  --output /root/autodl-tmp/rdmd-deploy/verdicts.jsonl \
  --adapter /root/autodl-tmp/rdmd_runs/qlora-v3/adapter \
  --model /root/autodl-tmp/models/Qwen3-8B 2>&1
echo "predict_exit=$?"

echo "=== score vs gold fixture ==="
$PY - <<'PY'
import json
from pathlib import Path
D = Path('/root/autodl-tmp/rdmd-deploy')
preds = {}
for line in (D / 'verdicts.jsonl').read_text(encoding='utf-8').splitlines():
    if line.strip():
        row = json.loads(line)
        preds[row['id']] = row
gold = [json.loads(l) for l in Path('examples/smoke_expected.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]
ok_status = ok_node = ok_type = 0
invalid = 0
for g in gold:
    p = preds.get(g['id'])
    if not p:
        print('MISSING PREDICTION', g['id']); continue
    if not p['valid']:
        invalid += 1
    v = p['verdict']
    if v['status'] == g['status']:
        ok_status += 1
    if g['status'] == 'drift':
        if v['nodeId'] == g['nodeId']:
            ok_node += 1
        if v['type'] == g['type']:
            ok_type += 1
    print(f"  {g['id'][:52]:52s} gold={g['status']:9s} pred={v['status']:9s} "
          f"node={v['nodeId'] or '-':4s} type={v['type'] or '-':20s} valid={p['valid']}")
n_drift = sum(1 for g in gold if g['status'] == 'drift')
print(f"statusHit   {ok_status}/{len(gold)}")
print(f"nodeHit     {ok_node}/{n_drift} (drift only)")
print(f"typeHit     {ok_type}/{n_drift} (drift only)")
print(f"invalid     {invalid}")
PY
echo "SCORE_EXIT=$?"
