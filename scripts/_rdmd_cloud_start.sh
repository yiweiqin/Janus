#!/usr/bin/env bash
# 在盒子上起云 API（P4 的验证前提：没有云 API 就没有作业队列）。
#
# 三个刻意的选择：
#
# 1. **NODE_ENV=production**。不是"假装生产"，而是避开一个真实的陷阱：
#    `cloud/src/index.mjs` 只在非 production 下调 `migrate(pool)`，而那个 pool 用的是
#    api 角色（janus_api_login），它**不是**这些表的 owner —— 于是启动即
#    `ERROR: must be owner of table collaboration_graph_nodes`。迁移该由
#    scripts/_rdmd_cloud_migrate.sh 用 migrator 角色单独跑（已跑完）。
#    production 模式下 index.mjs 只做 readiness 断言，正好是我们想要的闸门。
#
# 2. **HOST=127.0.0.1**。这台盒子的 IP 是 172.17.0.2（AutoDL 容器内网），
#    对外没有任何入站能力；worker 与云 API 同机，走 127.0.0.1 就够。
#    绑到 0.0.0.0 只会多开一个谁也连不上的面。
#
# 3. **RDMD_CLOUD_BACKEND=null 起步**。P4 的验收要求"null 后端下全链路跑通且恒定
#    record_only" —— 先证明没有 GPU 也能把链路走通，再切 gpu_worker。
#    用 RDMD_BACKEND 环境变量覆盖，便于同一个脚本验证两种后端。
set -euo pipefail

NODE=/root/.nvm/versions/node/v22.23.2/bin/node
JANUS=/root/Janus
LOG_DIR=/root/autodl-tmp/rdmd_runs
LOG="$LOG_DIR/cloud_api.log"
PIDFILE="$LOG_DIR/cloud_api.pid"

[ -x "$NODE" ] || { echo "node 不可用: $NODE"; exit 1; }
[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
mkdir -p "$LOG_DIR"
set -a; . /root/.config/janus/remote.env; set +a
cd "$JANUS"

# 幂等：已经在跑就先停掉，避免"新代码起了但老进程占着端口"这种最迷惑的状态。
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "stopping existing cloud api pid=$(cat "$PIDFILE")"
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 2
fi
pkill -f "cloud/src/index.mjs" 2>/dev/null || true
sleep 1

export NODE_ENV=production
export HOST=127.0.0.1
export PORT=8787
# 独立能力位：不显式打开时，submit 一律 not_eligible（见 rdmd/index.mjs 的三道闸）。
export RDMD_CLOUD_ENABLED=true
export RDMD_CLOUD_BACKEND="${RDMD_BACKEND:-null}"

echo "--- 启动参数 ---"
echo "NODE_ENV=$NODE_ENV HOST=$HOST PORT=$PORT RDMD_CLOUD_BACKEND=$RDMD_CLOUD_BACKEND RDMD_CLOUD_ENABLED=$RDMD_CLOUD_ENABLED"

setsid nohup "$NODE" cloud/src/index.mjs >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "started pid=$(cat "$PIDFILE") log=$LOG"

# 等就绪：readiness 断言要碰数据库，给它几秒。
for i in $(seq 1 20); do
  sleep 1
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:8787/healthz" 2>/dev/null; then
    echo "up after ${i}s"
    break
  fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "进程已退出，日志尾部："
    tail -30 "$LOG"
    exit 1
  fi
done

echo
echo "############ 日志尾部 ############"
tail -20 "$LOG"

echo
echo "############ /healthz ############"
curl -s -m 5 "http://127.0.0.1:8787/healthz"; echo
echo "############ /readyz ############"
curl -s -m 5 "http://127.0.0.1:8787/readyz"; echo

echo
echo "############ rdmd 端点是否在（未认证应得 401/403，而不是 404）############"
for probe in "POST /api/rdmd/jobs" "POST /api/rdmd/jobs/claim" "POST /api/rdmd/jobs/x/verdict" "GET /api/rdmd/jobs/x"; do
  method=${probe%% *}; path=${probe##* }
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -X "$method" -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:8787$path")
  echo "$method $path -> $code"
done
