set +e
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
CONF=/root/.config/janus
JANUS=/root/Janus

echo "=== 1. 剥掉 /root/Janus 下所有文本文件的 UTF-8 BOM ==="
stripped=0
while IFS= read -r -d '' f; do
  if [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    sed -i '1s/^\xEF\xBB\xBF//' "$f"
    stripped=$((stripped+1))
    echo "  stripped: ${f#/root/Janus/}"
  fi
done < <(find "$JANUS" -path "$JANUS/node_modules" -prune -o \
  \( -name '*.json' -o -name '*.js' -o -name '*.mjs' -o -name '*.sql' -o -name '*.md' \) \
  -type f -print0)
echo "stripped=$stripped"

echo "=== 2. 确认 package.json 可被 JSON.parse ==="
cd "$JANUS"
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));console.log('package.json OK, version =',p.version)" 2>&1

echo "=== 3. 重启云端 ==="
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
echo "pid=$(cat "$CONF/cloud.pid") alive=$(kill -0 "$(cat "$CONF/cloud.pid")" 2>/dev/null && echo yes || echo no)"

echo "=== 4. 端口 & 探测 ==="
ss -ltnp 2>/dev/null | grep 8787 | head
for p in /healthz /readyz; do
  printf '%-10s -> ' "$p"
  curl -sS -m 8 -o /tmp/b.txt -w '%{http_code}' "http://127.0.0.1:8787${p}" 2>&1
  echo " | $(head -c 500 /tmp/b.txt 2>/dev/null | tr -d '\n')"
done

echo "=== 5. cloud.log 全文 ==="
cat "$CONF/cloud.log" 2>&1 | head -40
echo "=== DONE ==="
