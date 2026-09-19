set +e
echo "=== 解包到 /root/Janus ==="
mkdir -p /root/Janus
tar -xzf /root/janus_src.tar.gz -C /root/ --overwrite
echo "exit=$?"
ls -la /root/Janus | head -25

echo "=== 关键路径检查 ==="
for p in cloud/src/index.mjs cloud/scripts/migrate.mjs cloud/database/migrations package.json package-lock.json; do
  if [ -e "/root/Janus/$p" ]; then echo "OK   $p"; else echo "MISS $p"; fi
done

echo "=== 迁移文件数 ==="
ls /root/Janus/cloud/database/migrations/*.sql 2>/dev/null | wc -l
ls /root/Janus/cloud/database/migrations/ 2>/dev/null | tail -8

echo "=== cloud/src/index.mjs 头部 import ==="
head -40 /root/Janus/cloud/src/index.mjs 2>/dev/null

echo "=== cloud/src 顶层 ==="
ls -la /root/Janus/cloud/src/ 2>/dev/null | head -30
echo "=== DONE ==="
