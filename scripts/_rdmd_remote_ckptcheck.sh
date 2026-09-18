#!/bin/bash
RUN_TAG="${RUN_TAG:-qlora-v3}"
RUN=/root/autodl-tmp/rdmd_runs/$RUN_TAG
echo "== checkpoints =="
ls -la "$RUN/checkpoints" 2>/dev/null
for d in "$RUN"/checkpoints/checkpoint-*; do
  [ -d "$d" ] || continue
  echo "--- $d ---"
  ls -la "$d" | head -15
  echo "adapter_config.json present: $([ -f "$d/adapter_config.json" ] && echo YES || echo NO)"
  echo "adapter weights: $(ls "$d" | grep -c 'adapter_model')"
done
echo "== trainer_state (best checkpoint / best metric) =="
if [ -f "$RUN/trainer_state.json" ]; then
  /root/autodl-tmp/rdmd-env/bin/python -c "
import json
s=json.load(open('$RUN/trainer_state.json'))
print('best_checkpoint', s.get('best_model_checkpoint'))
print('best_metric', s.get('best_metric'))
print('global_step', s.get('global_step'))
"
fi
echo "== GPU ==="
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader
