#!/bin/bash
B=/root/autodl-tmp/rdmd_runs/sft_backup_20260913_112704.tar.gz
echo "=== archive members (first 12) ==="
tar -tzf "$B" | head -12
echo "=== v2 manifest from inside the backup ==="
tar -xzOf "$B" sft/manifest.json | head -c 700
echo
echo "=== line counts inside the backup ==="
for name in train development test eval_unknown eval_no_drift; do
  echo "$name $(tar -xzOf "$B" sft/$name.jsonl | wc -l)"
done
echo "=== size ==="
du -h "$B"
