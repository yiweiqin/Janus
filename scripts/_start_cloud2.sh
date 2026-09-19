set +e
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
CONF=/root/.config/janus
JANUS=/root/Janus

echo "=== 1. 追加 MAIL_PROVIDER=console（开发/自测模式，不依赖 SMTP） ==="
grep -q '^export MAIL_PROVIDER=' "$CONF/remote.env" \
  || echo 'export MAIL_PROVIDER=console' >> "$CONF/remote.env"
grep -c . "$CONF/remote.env"

echo "=== 2. 重启云端 ==="
[ -f "$CONF/cloud.pid" ] && kill "$(cat "$CONF/cloud.pid")" 2>/dev/null
pkill -f 'cloud/src/index.mjs' 2>/dev/null
sleep 1
pg_ctlcluster 14 main start >/dev/null 2>&1 || true
# shellcheck disable=SC1091
source "$CONF/remote.env"
export HOST=127.0.0.1 PORT=8787
: > "$CONF/cloud.log"
cd "$JANUS"
nohup node cloud/src/index.mjs >> "$CONF/cloud.log" 2>&1 &
echo $! > "$CONF/cloud.pid"
sleep 6
echo "alive=$(kill -0 "$(cat "$CONF/cloud.pid")" 2>/dev/null && echo yes || echo no)"

echo "=== 3. 端口 ==="
ss -ltnp 2>/dev/null | grep 8787 | head

echo "=== 4. 探测 ==="
for p in /healthz /readyz; do
  printf '%-10s -> ' "$p"
  curl -sS -m 8 -o /tmp/b.txt -w '%{http_code}' "http://127.0.0.1:8787${p}" 2>&1
  echo " | $(head -c 600 /tmp/b.txt 2>/dev/null | tr -d '\n')"
done

echo "=== 5. cloud.log ==="
head -40 "$CONF/cloud.log" 2>&1
echo "=== DONE ==="
