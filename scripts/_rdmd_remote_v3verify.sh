#!/bin/bash
echo "=== rdmd_runs backups ==="
ls -la /root/autodl-tmp/rdmd_runs/ | grep -i backup || echo "NO_BACKUP_FILES"
echo "=== all sft_backup* anywhere ==="
find /root/autodl-tmp -maxdepth 4 -name 'sft_backup*' 2>/dev/null || echo none
echo "=== remote sft now ==="
ls -la /root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/
echo "=== remote sft manifest ==="
/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import json
from pathlib import Path
p = Path('/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/manifest.json')
if p.is_file():
    m = json.loads(p.read_text(encoding='utf-8-sig'))
    for k in ['schemaVersion','sourceVersion','status','mainLoss','unknownInMainLoss','rejected','graphLeak']:
        print(k, '=', m.get(k))
else:
    print('NO_MANIFEST')
PY
echo "=== line counts ==="
for f in /root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/*.jsonl; do
  echo "$(basename "$f") $(wc -l < "$f")"
done
echo "=== rdmd_runs top ==="
ls -la /root/autodl-tmp/rdmd_runs/ | head -40
echo "=== disk ==="
df -h /root/autodl-tmp | tail -2
