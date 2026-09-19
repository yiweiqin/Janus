#!/usr/bin/env bash
# Janus 云端在 Linux 上的启动脚本 —— 与 scripts/local-janus-start.ps1 语义对齐。
#
# 与那版 PowerShell 的对应关系：
#   - 两个进程：cloud/src/index.mjs（API） + cloud/src/evolution-worker.mjs（进化 worker）
#   - NODE_ENV=production：走 assertDatabaseRole + assertCloudDatabaseReady 这条真实就绪门，
#     而不是非生产模式下的自动迁移（那会掩盖角色/迁移配置错误）
#   - MAIL_PROVIDER=console：不依赖 SMTP
#   - JANUS_FILE_STORAGE_ROOT：大文件存储根目录
#
# 用法：janus-cloud-start.sh [start|stop|restart|status]
set -uo pipefail

export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
REPO="${JANUS_REPO:-/root/Janus}"
CONF=/root/.config/janus
RUNTIME="$REPO/.local-runtime"
FILESTORAGE="$REPO/.local-data/file-storage"

mkdir -p "$RUNTIME" "$FILESTORAGE"

start_one() {
  local name="$1" entry="$2"
  local pidfile="$RUNTIME/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "  $name already running (pid $(cat "$pidfile"))"
    return 0
  fi
  nohup node "$entry" >> "$RUNTIME/$name.out.log" 2>> "$RUNTIME/$name.err.log" &
  echo $! > "$pidfile"
  sleep 2
  if kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "  $name started (pid $(cat "$pidfile"))"
  else
    echo "  $name FAILED to start; see $RUNTIME/$name.err.log"
    return 1
  fi
}

stop_one() {
  local name="$1"
  local pidfile="$RUNTIME/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null
    echo "  $name stopped (pid $(cat "$pidfile"))"
  fi
  rm -f "$pidfile"
}

do_start() {
  # shellcheck disable=SC1091
  source "$CONF/remote.env"
  export NODE_ENV=production
  export HOST="${HOST:-127.0.0.1}"
  export PORT="${PORT:-8787}"
  export MAIL_PROVIDER=console
  export JANUS_FILE_STORAGE_ROOT="$FILESTORAGE"
  export JANUS_EVOLUTION_WORKER_INTERVAL_MS="${JANUS_EVOLUTION_WORKER_INTERVAL_MS:-60000}"

  pg_ctlcluster 14 main start >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do pg_isready -q && break; sleep 1; done

  cd "$REPO" || exit 1
  start_one cloud-api 'cloud/src/index.mjs'
  start_one evolution-worker 'cloud/src/evolution-worker.mjs'
}

do_status() {
  echo "node: $(node -v 2>&1)"
  echo "postgres: $(pg_isready 2>&1)"
  for name in cloud-api evolution-worker; do
    local pidfile="$RUNTIME/$name.pid"
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "  $name: running (pid $(cat "$pidfile"))"
    else
      echo "  $name: not running"
    fi
  done
  printf '  /healthz -> '
  curl -sS -m 8 -o /tmp/_hz.txt -w '%{http_code}' "http://127.0.0.1:${PORT:-8787}/healthz" 2>&1
  echo " $(cat /tmp/_hz.txt 2>/dev/null)"
  printf '  /readyz  -> '
  curl -sS -m 8 -o /tmp/_rz.txt -w '%{http_code}' "http://127.0.0.1:${PORT:-8787}/readyz" 2>&1
  echo " $(head -c 400 /tmp/_rz.txt 2>/dev/null)"
}

case "${1:-start}" in
  start)   do_start; do_status ;;
  stop)    stop_one cloud-api; stop_one evolution-worker ;;
  restart) stop_one cloud-api; stop_one evolution-worker; do_start; do_status ;;
  status)  do_status ;;
  *) echo "usage: $0 [start|stop|restart|status]" >&2; exit 2 ;;
esac
