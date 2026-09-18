#!/bin/bash
echo "=== GPU ==="
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
echo "=== running procs ==="
pgrep -af 'train_qlora_rdmd.py|eval_rdmd_qlora.py' || echo no_rdmd_procs
echo "=== env ==="
if [ -x /root/autodl-tmp/rdmd-env/bin/python ]; then
  /root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import torch, transformers, peft, datasets, bitsandbytes
print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'gpus', torch.cuda.device_count())
print('transformers', transformers.__version__, 'peft', peft.__version__)
PY
else
  echo "NO_ENV"
fi
echo "=== model ==="
ls /root/autodl-tmp/models/Qwen3-8B/config.json 2>/dev/null && du -sh /root/autodl-tmp/models/Qwen3-8B 2>/dev/null || echo "NO_MODEL"
echo "=== existing runs ==="
ls -d /root/autodl-tmp/rdmd_runs/qlora-* 2>/dev/null || echo no_qlora_dirs
echo "qlora-v3 exists? $([ -e /root/autodl-tmp/rdmd_runs/qlora-v3 ] && echo YES || echo no)"
echo "=== data sanity ==="
head -c 200 /root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/qlora_config.json
echo
wc -l /root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/train.jsonl
echo "=== disk ==="
df -h /root/autodl-tmp | tail -2
