#!/bin/bash
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
export HF_ENDPOINT=https://hf-mirror.com
export HF_HOME=/root/autodl-tmp/hf
export PYTHONUNBUFFERED=1
export CUDA_VISIBLE_DEVICES=0
cd /root/autodl-tmp/Janus
mkdir -p /root/autodl-tmp/rdmd_runs
nohup /root/autodl-tmp/rdmd-env/bin/python -u scripts/eval_rdmd_qlora.py \
  --data experiments/rdmd_detective_dataset/sft \
  --split test \
  --adapter /root/autodl-tmp/rdmd_runs/qlora-v2/adapter \
  --model /root/autodl-tmp/models/Qwen3-8B \
  --output /root/autodl-tmp/rdmd_runs/eval-test.predictions.jsonl \
  > /root/autodl-tmp/rdmd_runs/eval-test.log 2>&1 &
echo $! > /root/autodl-tmp/rdmd_runs/eval-test.pid
echo LAUNCHED
cat /root/autodl-tmp/rdmd_runs/eval-test.pid
sleep 20
echo LOG
tail -n 20 /root/autodl-tmp/rdmd_runs/eval-test.log
