#!/usr/bin/env bash
# 只读：角色关系 + baseline 文件指纹。决定"能不能在盒子上按生产模式启动云 API"。
set -uo pipefail
[ -f /root/.config/janus/remote.env ] && { set -a; . /root/.config/janus/remote.env; set +a; }

echo "############ 角色与成员关系 ############"
psql "$DATABASE_URL" -tAc \
  "SELECT rolname, pg_has_role(current_user, rolname, 'member') FROM pg_roles WHERE rolname LIKE 'janus%' ORDER BY rolname;" 2>&1

echo
echo "############ migrator 连接是谁 ############"
psql "$DATABASE_MIGRATOR_URL" -tAc \
  "SELECT current_user, pg_has_role(current_user,'janus_migrator','member');" 2>&1

echo
echo "############ 已应用迁移全量（确认 baseline 在册）############"
psql "$DATABASE_URL" -tAc "SELECT filename FROM public.schema_migrations ORDER BY applied_at, filename;" 2>&1 | tail -12

echo
echo "############ baseline / seed 文件指纹（与本地比对用）############"
for f in /root/Janus/cloud/database/baseline-sync8.sql /root/Janus/cloud/database/seed-agent-catalog.sql; do
  if [ -f "$f" ]; then
    printf "%s  bytes=%s  sha256=" "$(basename "$f")" "$(stat -c%s "$f")"
    sha256sum "$f" | cut -c1-16
  else
    echo "$(basename "$f")  缺失"
  fi
done

echo
echo "############ server.mjs 的 rdmd 注册点是否已在盒子上 ############"
grep -c "rdmd" /root/Janus/cloud/src/server.mjs 2>/dev/null || echo 0
