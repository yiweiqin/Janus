#!/usr/bin/env bash
# 从开发机远程操作盒子上那个常驻 worker：`--set ACTION=start|stop|status|log`。
#
# 为什么不直接 `rdmd_ssh.py --command "... start"`：PowerShell 会吃掉命令里的 `$` 与引号，
# 试过两轮都是 shell 层面的问题而不是脚本层面的问题。参数走环境变量（`--set ACTION=...`）
# 是这条路子上唯一不需要跟引号搏斗的形态，与 _rdmd_cloud_e2e.sh 用 STAGE 是同一个理由。
set -uo pipefail
DAEMON=/root/autodl-tmp/Janus/scripts/_rdmd_worker_daemon.sh
ACTION="${ACTION:-status}"

[ -f "$DAEMON" ] || { echo "盒子上没有 $DAEMON（先跑 rdmd_worker_deploy.py）"; exit 1; }

echo "=== worker daemon: $ACTION ==="
bash "$DAEMON" "$ACTION"
RC=$?

if [ "$ACTION" = "start" ]; then
  # 起完多看一眼：只看 "started" 会漏掉"起来之后立刻因为凭据/契约问题退出"。
  # 这个 worker 的错误都在日志里，而它一退，status 会显示 not running。
  sleep 5
  echo
  echo "=== 5 秒后复查（确认它没有立刻退出）==="
  bash "$DAEMON" status
fi
echo "=== worker_daemon_exit=$RC ==="
