set +e
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
chmod +x /root/Janus/scripts/janus-cloud-start.sh
# 清掉之前手工起的进程和 pid 文件
[ -f /root/.config/janus/cloud.pid ] && kill "$(cat /root/.config/janus/cloud.pid)" 2>/dev/null
pkill -f 'cloud/src/index.mjs' 2>/dev/null
pkill -f 'cloud/src/evolution-worker.mjs' 2>/dev/null
sleep 1
rm -f /root/Janus/.local-runtime/*.pid
echo "=== restart（NODE_ENV=production，两个进程） ==="
/root/Janus/scripts/janus-cloud-start.sh restart 2>&1
echo "=== 退出码=$? ==="
echo "=== 错误日志（若有） ==="
for f in /root/Janus/.local-runtime/cloud-api.err.log /root/Janus/.local-runtime/evolution-worker.err.log; do
  echo "--- $f ---"
  tail -25 "$f" 2>&1
done
echo "=== DONE ==="
