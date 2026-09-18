#!/bin/bash
OUT="${OUT:-/root/autodl-tmp/rdmd_runs/eval-qlora-v3-checkpoint-530}"
echo "== files in OUT =="
ls -la "$OUT" 2>/dev/null
echo "== shard0 log tail =="
tail -c 2000 "$OUT/shard0.log" 2>/dev/null
echo
echo "== shard1 log tail =="
tail -c 2000 "$OUT/shard1.log" 2>/dev/null
echo
echo "== any traceback? =="
grep -al 'Traceback\|Error\|CUDA out of memory' "$OUT"/shard*.log 2>/dev/null || echo "no traceback in shard logs"
echo "== shard input dirs =="
ls -la "$OUT/shards/g0" "$OUT/shards/g1" 2>/dev/null
echo "== disk =="
df -h /root/autodl-tmp | tail -1
