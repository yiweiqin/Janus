set +e
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
# shellcheck disable=SC1091
source /root/.config/janus/remote.env
cd /tmp

MIG="$DATABASE_MIGRATOR_URL"

echo "=== 现有角色 ==="
psql "$MIG" -Atc "select rolname from pg_roles where rolname like 'janus%' order by 1" 2>&1

echo "=== 数据库 owner ==="
psql "$MIG" -Atc "select datname, pg_get_userbyid(datdba) from pg_database where datname='janus'" 2>&1

echo "=== public 表数 / collaboration_graph* ==="
psql "$MIG" -Atc "select count(*) from information_schema.tables where table_schema='public'" 2>&1
psql "$MIG" -Atc "select table_name from information_schema.tables where table_name like 'collaboration_graph%' order by 1" 2>&1

echo "=== 重新跑迁移（完整错误信息） ==="
cd /root/Janus
node cloud/scripts/migrate.mjs 2>&1 | head -70
echo "migrate exit=${PIPESTATUS[0]}"
echo "=== DONE ==="
