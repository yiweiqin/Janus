#!/bin/bash
RUN_TAG="${RUN_TAG:-qlora-v3}"
RUN=/root/autodl-tmp/rdmd_runs/$RUN_TAG
LOG="$RUN.train.log"
echo "== loss history (every 10th step) =="
grep -ao "'loss': '[^']*'" "$LOG" | sed "s/'loss': //"
echo "== grad_norm history =="
grep -ao "'grad_norm': '[^']*'" "$LOG" | sed "s/'grad_norm': //"
echo "== current step =="
grep -ao "[0-9]*/1060 \[" "$LOG" | tail -n 1
echo "== epoch / lr =="
grep -ao "'epoch': '[^']*'" "$LOG" | tail -n 1
grep -ao "'learning_rate': '[^']*'" "$LOG" | tail -n 1
echo "== elapsed on the tqdm line =="
tail -c 400 "$LOG"
echo
echo "== checkpoint dir (epoch eval writes here) =="
ls -la "$RUN/checkpoints" 2>/dev/null
echo "== dev eval lines, if any =="
grep -a "eval_loss\|Evaluation\|eval_" "$LOG" 2>/dev/null | tail -n 5 || echo "(no dev eval yet)"
echo "== disk =="
df -h /root/autodl-tmp | tail -1
echo "== gpu =="
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader
