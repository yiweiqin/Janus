set +e
echo "=== 1. LLM 端点可达性（.orgbench_env 里的 codexpro） ==="
for u in https://codexpro.wwxb1123.xyz/v1/models https://api.openai.com/v1/models; do
  printf '%-45s -> ' "$u"
  curl -sS -m 15 -o /dev/null -w '%{http_code}\n' "$u" 2>&1
done

echo "=== 2. Electron 二进制镜像（GitHub 不通，走 npmmirror） ==="
for u in https://registry.npmmirror.com/-/binary/electron/ https://npmmirror.com/mirrors/electron/; do
  printf '%-55s -> ' "$u"
  curl -sS -m 15 -o /dev/null -w '%{http_code}\n' "$u" 2>&1
done

echo "=== 3. GUI 依赖：xvfb 可装? 当前有无 DISPLAY ==="
echo "DISPLAY='${DISPLAY:-<unset>}'"
apt-cache policy xvfb 2>/dev/null | head -3
ls /usr/bin/Xvfb 2>&1

echo "=== 4. 桌面端启动脚本是否存在 ==="
for f in scripts/dev.mjs scripts/cloud.mjs src/main/index.js src/main/main.js; do
  [ -e "/root/Janus/$f" ] && echo "OK   $f" || echo "MISS $f"
done
echo "--- package.json main 字段 ---"
node -e "const p=require('/root/Janus/package.json');console.log('main =',p.main)" 2>&1
echo "--- src/main 顶层 ---"
ls /root/Janus/src/main 2>&1 | head -20

echo "=== 5. codex CLI 是否存在 ==="
command -v codex 2>&1 || echo "codex: not found"
ls /root/.codex 2>&1 | head -5
echo "=== DONE ==="
