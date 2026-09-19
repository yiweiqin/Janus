set +e
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
CONF=/root/.config/janus
mkdir -p "$CONF"
pg_ctlcluster 14 main start >/dev/null 2>&1 || true
# shellcheck disable=SC1091
source "$CONF/remote.env"
export HOST=127.0.0.1
export PORT=8787

if [ -f "$CONF/cloud.pid" ] && kill -0 "$(cat "$CONF/cloud.pid")" 2>/dev/null; then
  echo "already running: $(cat "$CONF/cloud.pid")"
else
  cd /root/Janus
  nohup node cloud/src/index.mjs >> "$CONF/cloud.log" 2>&1 &
  echo $! > "$CONF/cloud.pid"
  sleep 4
fi
echo "pid=$(cat "$CONF/cloud.pid") alive=$(kill -0 "$(cat "$CONF/cloud.pid")" 2>/dev/null && echo yes || echo no)"

echo "=== 监听端口 ==="
ss -ltnp 2>/dev/null | grep -E '8787|5432' | head

echo "=== 探测端点 ==="
for p in / /health /healthz /readyz /api/health /version; do
  printf '%-14s -> ' "$p"
  curl -sS -m 8 -o /tmp/body.txt -w '%{http_code}' "http://127.0.0.1:8787${p}" 2>&1
  echo " | $(head -c 160 /tmp/body.txt 2>/dev/null | tr -d '\n')"
done

echo "=== cloud.log（最后 30 行） ==="
tail -30 "$CONF/cloud.log" 2>&1
echo "=== DONE ==="
