#!/usr/bin/env bash
# 验证 GPU 盒上的 worker **常驻模式**真的能跑（不是只验证 `--once`）。
#
# 为什么值得单独验一次：`--once` 只走一遍循环体就退出，而常驻模式多了三件事 ——
#   1. 空队列时的轮询（`claim` 返回 0 条不算失败，睡 poll_seconds 再来）；
#   2. 网络/云侧抖动时的容错（catch 后不许退出，除 401/403 是凭据问题才退）；
#   3. 长期占用 GPU 的副作用（本脚本起完就停，不留常驻进程）。
# 这三件事在 `--once` 下一条都不会执行到，而它们才是生产形态。
#
# 本脚本**只验证并报告，不替用户决定是否常驻**：起 → 看两轮轮询 → 停。
# 想让 worker 一直跑（这样真实任务的判定才会自动产生），用 _rdmd_worker_daemon.sh。
set -uo pipefail
PY=/root/autodl-tmp/rdmd-env/bin/python
JANUS_TRAIN=/root/autodl-tmp/Janus
STATE=/root/autodl-tmp/rdmd_runs/rdmd_zombie_state.json
LOG=/root/autodl-tmp/rdmd_runs/rdmd_worker_daemon.log
ADAPTER=/root/autodl-tmp/rdmd_runs/qlora-v3/adapter
BASE=/root/autodl-tmp/models/Qwen3-8B
DEVICE="${RDMD_DEVICE:-cuda:1}"

[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a

GRANT=$(grep -o '"grant": *"[^"]*"' "$STATE" 2>/dev/null | head -1 | cut -d'"' -f4)
[ -n "$GRANT" ] || { echo "缺 grant（先跑 e2e submit）"; exit 1; }

# 先确保没有残留的同类进程，否则"看日志"这件事本身就不成立。
pkill -f 'rdmd_gpu_worker.py' 2>/dev/null && echo "先停掉了已有的 worker" || echo "没有残留 worker"
sleep 1

echo "############ 起常驻 worker（空队列，期望它安静轮询而不是退出）############"
RDMD_DEVICE_GRANT="$GRANT" \
RDMD_ADAPTER="$ADAPTER" \
RDMD_BASE_MODEL="$BASE" \
RDMD_DEVICE="$DEVICE" \
RDMD_CLOUD_API="http://127.0.0.1:8787" \
RDMD_WORKER_ID="gpu-daemon-cuda1" \
RDMD_POLL_SECONDS=3 \
nohup "$PY" "$JANUS_TRAIN/scripts/rdmd_gpu_worker.py" > "$LOG" 2>&1 &
PID=$!
echo "pid=$PID log=$LOG"

echo
echo "############ 观察 ~10 秒（应当看到多轮轮询且没有退出）############"
sleep 10
if kill -0 "$PID" 2>/dev/null; then
  echo "OK：常驻进程仍活着（空队列没有让它退出）"
else
  echo "FAIL：常驻进程已退出，日志如下"; tail -20 "$LOG"; exit 1
fi
echo "--- 日志 ---"
tail -20 "$LOG"
echo "--- 日志行数（轮询确实在继续）---"
wc -l < "$LOG"

echo
echo "############ 逐条断言常驻模式的三件事 ############"
grep -q 'worker=' "$LOG" && echo "OK：启动自述（worker id / adapter sha256 / 契约版本）已打印"
grep -qi 'error' "$LOG" && { echo "FAIL：空队列不该报 error"; exit 1; } || echo "OK：空队列安静轮询，没有把正常情况记成 error"

echo
echo "############ 停止（本脚本不留常驻进程）############"
kill "$PID" 2>/dev/null
sleep 1
kill -0 "$PID" 2>/dev/null && { echo "FAIL：停不掉"; exit 1; } || echo "OK：已停止"
pgrep -f 'rdmd_gpu_worker.py' >/dev/null && echo "还有残留进程" || echo "OK：没有残留 worker 进程"

echo
echo "daemon_check_ok"
