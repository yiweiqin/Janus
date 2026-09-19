#!/usr/bin/env bash
# 修正角色体系：按 deploy/community/postgres/init/00-roles.sh 的规范重建。
# 之前照抄的 configure-janus-postgres.sh 是旧版，把基础角色直接建成了 LOGIN，
# 缺少 *_login 角色，导致 baseline 的 ALTER DEFAULT PRIVILEGES FOR ROLE janus_migrator_login 失败。
set -uo pipefail
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
CONF=/root/.config/janus
cd /tmp

api_pw="$(openssl rand -hex 24)"
worker_pw="$(openssl rand -hex 24)"
migrator_pw="$(openssl rand -hex 24)"

echo "=== 1. 基础角色改为 NOLOGIN，并建 *_login 登录角色 ==="
runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
  --set=api_password="$api_pw" \
  --set=worker_password="$worker_pw" \
  --set=migrator_password="$migrator_pw" \
  --dbname=postgres <<'SQL'
ALTER ROLE janus_api NOLOGIN;
ALTER ROLE janus_evolution_worker NOLOGIN;
ALTER ROLE janus_migrator NOLOGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='janus_api_login') THEN
    CREATE ROLE janus_api_login LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='janus_worker_login') THEN
    CREATE ROLE janus_worker_login LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='janus_migrator_login') THEN
    CREATE ROLE janus_migrator_login LOGIN;
  END IF;
END $$;
ALTER ROLE janus_api_login PASSWORD :'api_password';
ALTER ROLE janus_worker_login PASSWORD :'worker_password';
ALTER ROLE janus_migrator_login PASSWORD :'migrator_password';
GRANT janus_api TO janus_api_login;
GRANT janus_evolution_worker TO janus_worker_login;
GRANT janus_migrator TO janus_migrator_login;
GRANT CONNECT ON DATABASE janus TO janus_api_login, janus_worker_login, janus_migrator_login;
GRANT USAGE, CREATE ON SCHEMA public TO janus_migrator_login;
SQL
echo "roles exit=$?"

echo "=== 2. 重写 remote.env（改用 *_login 角色） ==="
jwt_secret="$(grep -oP 'JWT_SECRET=\K.*' "$CONF/remote.env" 2>/dev/null || openssl rand -hex 48)"
cat > "$CONF/remote.env" <<EOF
export DATABASE_URL=postgresql://janus_api_login:${api_pw}@127.0.0.1:5432/janus
export DATABASE_MIGRATOR_URL=postgresql://janus_migrator_login:${migrator_pw}@127.0.0.1:5432/janus
export EVOLUTION_WORKER_DATABASE_URL=postgresql://janus_worker_login:${worker_pw}@127.0.0.1:5432/janus
export JWT_SECRET=${jwt_secret}
export PGHOST=127.0.0.1
export PGPORT=5432
export PGDATABASE=janus
EOF
chmod 600 "$CONF/remote.env"
echo "env rewritten ($(grep -c . "$CONF/remote.env") lines)"

echo "=== 3. 跑迁移 ==="
# shellcheck disable=SC1091
source "$CONF/remote.env"
cd /root/Janus
node cloud/scripts/migrate.mjs 2>&1 | tail -25
echo "migrate exit=${PIPESTATUS[0]}"

echo "=== 4. 验证 collaboration_graph_* ==="
psql "$DATABASE_MIGRATOR_URL" -Atc \
  "select table_name from information_schema.tables where table_name like 'collaboration_graph%' order by 1" 2>&1
echo "--- public 表总数 ---"
psql "$DATABASE_MIGRATOR_URL" -Atc "select count(*) from information_schema.tables where table_schema='public'" 2>&1
echo "--- 迁移头 ---"
psql "$DATABASE_MIGRATOR_URL" -Atc "select filename from schema_migrations order by applied_at desc limit 5" 2>&1
echo "=== DONE ==="
