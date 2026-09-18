#!/bin/bash
export PATH=/root/miniconda3/bin:/root/autodl-tmp/rdmd-env/bin:$PATH
echo LAST_METRICS
/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
from pathlib import Path
import os
text = Path('/root/autodl-tmp/rdmd_runs/qlora-v2.train.log').read_text(errors='replace')
keep = []
for line in text.splitlines():
    s = line.strip()
    if "'loss':" in s or 'eval_loss' in s:
        keep.append(s[-500:])
print('\n'.join(keep[-20:]))
print('---ckpt---')
root = '/root/autodl-tmp/rdmd_runs/qlora-v2'
for name in sorted(os.listdir(root)):
    path = os.path.join(root, name)
    kind = 'dir' if os.path.isdir(path) else str(os.path.getsize(path))
    print(name, kind)
ad = os.path.join(root, 'adapter')
print('adapter', os.path.exists(ad), os.listdir(ad)[:12] if os.path.exists(ad) else '')
PY
echo GPU
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
echo TIME
date
