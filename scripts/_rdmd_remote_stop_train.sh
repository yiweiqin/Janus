#!/bin/bash
# 停掉远端正在跑的训练，并把该 run tag 的输出目录清空。
#
# 为什么要有这个脚本：P3 首次起训时 `schemaVersion` 还停在 v3（`schema.json` 忘了升版本），
# 于是训练器把 `dataKind = rdmd_detective_sft_v3` 写进了 run manifest —— 那份 adapter 会
# **自称是用 v3 语料训的**，而 P3 的全部意义就是产出可与 v3 对照的 v4，P4 又要求"判定带出处"。
# 这类出处错误修不回来（adapter 已经烙上了错误的 manifest），只能重训。
# 起训才 20 分钟、跑到 1/1074 步，重来的代价接近零，所以立刻停。
#
# 只停训练进程、只删指定的 run tag 目录；`qlora-v3` 与 `qlora-v2` 一律不动。
set -uo pipefail
RUN_TAG="${RDMD_RUN_TAG:-qlora-v4}"
RUN=/root/autodl-tmp/rdmd_runs/$RUN_TAG

echo "=== before ==="
pgrep -af train_qlora_rdmd.py || echo no_trainer_proc
GPU_BUSY=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader | wc -l)
echo "gpu_compute_apps=$GPU_BUSY"
ls -la "$RUN" 2>/dev/null | head -5 || echo "NO_RUN_DIR $RUN"

if pgrep -f train_qlora_rdmd.py >/dev/null 2>&1; then
  pkill -f train_qlora_rdmd.py || true
  sleep 5
  if pgrep -f train_qlora_rdmd.py >/dev/null 2>&1; then
    echo "[stop] SIGTERM did not take; sending SIGKILL"
    pkill -9 -f train_qlora_rdmd.py || true
    sleep 3
  fi
fi

# run tag 目录连同日志一起清掉：留着半截的 run_manifest.json 会让下一步的 "already running"
# 与 manifest 校验函数误判（它只看 status 字段，而半截 manifest 可能写着 training）。
rm -rf "$RUN" "$RUN.train.log" "$RUN.pid"

echo "=== after ==="
pgrep -af train_qlora_rdmd.py || echo no_trainer_proc
pgrep -af predict.py || echo no_predict_proc
echo "gpu_compute_apps=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader | wc -l)"
echo "siblings left untouched:"
ls -d /root/autodl-tmp/rdmd_runs/*/ 2>/dev/null
ls -la "$RUN" 2>/dev/null || echo "RUN_DIR_CLEARED $RUN"
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
echo "STOP_DONE"
