#!/usr/bin/env bash
# 只读：gpu_worker 后端要用的东西是否都在盒子上（predict.py / adapter / 空闲 GPU）。
set -uo pipefail
echo "############ worker 脚本与 deploy/ ############"
for f in /root/autodl-tmp/Janus/scripts/rdmd_gpu_worker.py /root/Janus/scripts/rdmd_gpu_worker.py; do
  [ -f "$f" ] && echo "OK   $f" || echo "MISS $f"
done
for f in /root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/deploy/predict.py \
         /root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/deploy/rdmd_detective.py; do
  [ -f "$f" ] && echo "OK   $f" || echo "MISS $f"
done
echo "--- 别处的 predict.py ---"
find /root -maxdepth 5 -name predict.py 2>/dev/null | head -5

echo
echo "############ CONTRACT_VERSION 一致性（worker 会拿它跟云侧比对）############"
for f in $(find /root -maxdepth 6 -name rdmd_detective.py 2>/dev/null | head -3); do
  printf "%s -> " "$f"; grep -m1 "CONTRACT_VERSION" "$f" || echo "(无)"
done
printf "cloud/rdmd 的契约版本 -> "
grep -rh "PLAN_EXEC_CONTRACT_VERSION = " /root/Janus/src/shared/contracts/uBuddyPlanExec.js 2>/dev/null | head -1

echo
echo "############ adapter 与基座 ############"
ls -d /root/autodl-tmp/rdmd_runs/qlora-v3 2>/dev/null && ls -1 /root/autodl-tmp/rdmd_runs/qlora-v3 | head -10
echo "--- adapter 权重文件（worker 要对它做 sha256）---"
ls -la /root/autodl-tmp/rdmd_runs/qlora-v3/adapter_model.safetensors 2>/dev/null || echo "(无 adapter_model.safetensors)"
ls -la /root/autodl-tmp/models/Qwen3-8B/config.json 2>/dev/null || echo "(无 Qwen3-8B)"
echo "--- v4 训练产物（还在训，不该被 worker 用）---"
ls -1 /root/autodl-tmp/rdmd_runs/qlora-v4/ 2>/dev/null

echo
echo "############ GPU 占用（v4 训练占着哪张卡）############"
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
echo "--- 训练进程 ---"
ps -eo pid,etime,cmd | grep train_qlora | grep -v grep | head -3

echo
echo "############ rdmd-env 里的依赖（predict.py 要 transformers/peft）############"
/root/autodl-tmp/rdmd-env/bin/python -c "
import importlib.metadata as md
for p in ['torch','transformers','peft','accelerate','bitsandbytes','requests']:
    try: print(f'  {p:14s} {md.version(p)}')
    except Exception as e: print(f'  {p:14s} MISSING')
" 2>&1 | head -10
