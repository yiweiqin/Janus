#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
SFT=/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft
echo "=== v2 SFT splits ==="
for f in "$SFT"/*.jsonl; do
  [ -e "$f" ] || continue
  echo "$(basename "$f") $(wc -l < "$f")"
done
echo "=== manifest ==="
cat "$SFT/manifest.json" 2>/dev/null | head -c 1500
echo
echo "=== adapter ==="
ls /root/autodl-tmp/rdmd_runs/qlora-v2/adapter 2>/dev/null | head -20
echo "=== running eval procs ==="
pgrep -af 'eval_rdmd_qlora.py' || echo none
echo "=== GPU ==="
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
echo "=== disk ==="
df -h /root/autodl-tmp | tail -2
