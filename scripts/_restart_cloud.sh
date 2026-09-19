set +e
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
CONF=/root/.config/janus
JANUS=/root/Janus

echo "=== 补装 nodemailer ==="
cd /tmp/clouddeps
npm install --no-audit --no-fund nodemailer 2>&1 | tail -3
cp -r /tmp/clouddeps/node_modules/. "$JANUS/node_modules/"
cd "$JANUS"
node -e "import('nodemailer').then(()=>console.log('nodemailer OK')).catch(e=>console.log('nodemailer FAIL',e.message))" 2>&1

echo "=== 重启云端 ==="
[ -f "$CONF/cloud.pid" ] && kill "$(cat "$CONF/cloud.pid")" 2>/dev/null
pkill -f 'cloud/src/index.mjs' 2>/dev/null
sleep 1
pg_ctlcluster 14 main start >/dev/null 2>&1 || true
# shellcheck disable=SC1091
source "$CONF/remote.env"
export HOST=127.0.0.1 PORT=8787
cd "$JANUS"
nohup node cloud/src/index.mjs >> "$CONF/cloud.log" 2>&1 &
echo $! > "$CONF/cloud.pid"
sleep 5
echo "pid=$(cat "$CONF/cloud.pid") alive=$(kill -0 "$(cat "$CONF/cloud.pid")" 2>/dev/null && echo yes || echo no)"

echo "=== 端口 ==="
ss -ltnp 2>/dev/null | grep -E '8787' | head

echo "=== 探测 ==="
for p in /healthz /readyz; do
  printf '%-10s -> ' "$p"
  curl -sS -m 8 -o /tmp/b.txt -w '%{http_code}' "http://127.0.0.1:8787${p}" 2>&1
  echo " | $(head -c 400 /tmp/b.txt 2>/dev/null | tr -d '\n')"
done

echo "=== cloud.log 尾部 ==="
tail -20 "$CONF/cloud.log" 2>&1
echo "=== DONE ==="
