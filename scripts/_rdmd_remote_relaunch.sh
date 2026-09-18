set -euo pipefail
export PATH=/root/miniconda3/bin:$PATH
cd /root/autodl-tmp/Janus
if pgrep -f train_qlora_rdmd.py >/dev/null 2>&1; then
  pkill -f train_qlora_rdmd.py || true
  sleep 2
fi
rm -rf /root/autodl-tmp/rdmd_runs/qlora-v2
mkdir -p /root/autodl-tmp/rdmd_runs
LOG=/root/autodl-tmp/rdmd_runs/qlora-v2.train.log
nohup env PYTHONUNBUFFERED=1 CUDA_VISIBLE_DEVICES=0 HF_HOME=/root/autodl-tmp/hf HF_ENDPOINT=https://hf-mirror.com \
  /root/autodl-tmp/rdmd-env/bin/python -u scripts/train_qlora_rdmd.py \
  --data experiments/rdmd_detective_dataset/sft \
  --model /root/autodl-tmp/models/Qwen3-8B \
  --output /root/autodl-tmp/rdmd_runs/qlora-v2 \
  --force \
  > "$LOG" 2>&1 &
echo $! > /root/autodl-tmp/rdmd_runs/qlora-v2.pid
sleep 8
echo pid=$(cat /root/autodl-tmp/rdmd_runs/qlora-v2.pid)
ps -fp $(cat /root/autodl-tmp/rdmd_runs/qlora-v2.pid)
echo '---log---'
cat "$LOG"
