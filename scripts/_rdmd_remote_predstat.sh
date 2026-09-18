#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json
from collections import Counter
from pathlib import Path
rows = [json.loads(l) for l in Path('/root/autodl-tmp/rdmd_runs/eval-merged.predictions.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]
print('merged rows', len(rows))
by_status = Counter()
pred_status = Counter()
for row in rows:
    gold = json.loads(row['gold'])
    try:
        pred = json.loads(row['prediction'].strip().split('```')[0].strip())
    except Exception:
        pred = None
    by_status[gold['status']] += 1
    pred_status[(gold['status'], (pred or {}).get('status'))] += 1
print('gold status', dict(by_status))
print('gold->pred status', dict(pred_status))
print('---samples from UNKNOWN gold---')
shown = 0
for row in rows:
    gold = json.loads(row['gold'])
    if gold['status'] == 'UNKNOWN' and shown < 3:
        print(row['id'], 'PRED:', row['prediction'].strip()[:200])
        shown += 1
print('---samples from no_drift gold---')
shown = 0
for row in rows:
    gold = json.loads(row['gold'])
    if gold['status'] == 'no_drift' and shown < 2:
        print(row['id'], 'PRED:', row['prediction'].strip()[:200])
        shown += 1
PY
