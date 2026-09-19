#!/usr/bin/env bash
# 在 bjb1 上把 Janus 云端跑起来。
# 分四步，每步都先验证再做下一步，避免把「没跑起来」误判成「跑起来了」。
set -uo pipefail

export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
JANUS=/root/Janus
CONF=/root/.config/janus

echo "###### A. 依赖：cloud 生产代码只需要 express + pg ######"
# 不走完整 npm ci：Electron 的二进制要从 GitHub 下载，而这台机器 GitHub 不通。
# cloud/src 的裸依赖只有 express 和 pg（已用 grep 全量确认）。
if [ -d "${JANUS}/node_modules/express" ] && [ -d "${JANUS}/node_modules/pg" ]; then
  echo "deps already present"
else
  rm -rf /tmp/clouddeps && mkdir -p /tmp/clouddeps && cd /tmp/clouddeps
  npm init -y >/dev/null 2>&1
  npm install --no-audit --no-fund express pg 2>&1 | tail -5
  mkdir -p "${JANUS}/node_modules"
  cp -r /tmp/clouddeps/node_modules/. "${JANUS}/node_modules/"
fi
ls -d "${JANUS}/node_modules/express" "${JANUS}/node_modules/pg" 2>&1
node -e "import('express').then(()=>console.log('express import OK')).catch(e=>console.log('express FAIL',e.message))" 2>&1
cd "$JANUS" && node -e "import('pg').then(()=>console.log('pg import OK')).catch(e=>console.log('pg FAIL',e.message))" 2>&1

echo "###### B. PostgreSQL 角色 / 库 / env ######"
mkdir -p "$CONF" && chmod 700 "$CONF"
pg_ctlcluster 14 main start >/dev/null 2>&1 || true
sleep 2

api_pw="$(openssl rand -hex 24)"
worker_pw="$(openssl rand -hex 24)"
migrator_pw="$(openssl rand -hex 24)"
jwt_secret="$(openssl rand -hex 48)"

runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
  --set=migrator_pw="$migrator_pw" --set=api_pw="$api_pw" --set=worker_pw="$worker_pw" postgres <<'SQL'
SELECT format('CREATE ROLE janus_migrator LOGIN PASSWORD %L', :'migrator_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='janus_migrator') \gexec
SELECT format('ALTER ROLE janus_migrator PASSWORD %L', :'migrator_pw') \gexec
SELECT format('CREATE ROLE janus_api LOGIN PASSWORD %L', :'api_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='janus_api') \gexec
SELECT format('ALTER ROLE janus_api PASSWORD %L', :'api_pw') \gexec
SELECT format('CREATE ROLE janus_evolution_worker LOGIN PASSWORD %L', :'worker_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='janus_evolution_worker') \gexec
SELECT format('ALTER ROLE janus_evolution_worker PASSWORD %L', :'worker_pw') \gexec
SQL
echo "roles exit=$?"

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='janus'" | grep -q 1; then
  runuser -u postgres -- createdb -O janus_migrator janus
  echo "created database janus"
else
  echo "database janus already exists"
fi

cat > "$CONF/remote.env" <<EOF
export DATABASE_URL=postgresql://janus_api:${api_pw}@127.0.0.1:5432/janus
export DATABASE_MIGRATOR_URL=postgresql://janus_migrator:${migrator_pw}@127.0.0.1:5432/janus
export EVOLUTION_WORKER_DATABASE_URL=postgresql://janus_evolution_worker:${worker_pw}@127.0.0.1:5432/janus
export JWT_SECRET=${jwt_secret}
export PGHOST=127.0.0.1
export PGPORT=5432
export PGDATABASE=janus
export PGUSER=janus_api
EOF
chmod 600 "$CONF/remote.env"
grep -qF 'source /root/.config/janus/remote.env' /root/.bashrc \
  || printf '\n[ -f /root/.config/janus/remote.env ] && source /root/.config/janus/remote.env\n' >> /root/.bashrc
echo "env written: $(grep -c . "$CONF/remote.env") lines (values redacted)"

echo "###### C. 迁移 ######"
# shellcheck disable=SC1091
source "$CONF/remote.env"
cd "$JANUS"
node cloud/scripts/migrate.mjs 2>&1 | tail -20
echo "migrate exit=$?"

echo "###### D. 验证：collaboration_graph_* 表是否建出来 ######"
PGPASSWORD="$migrator_pw" psql -h 127.0.0.1 -U janus_migrator -d janus -Atc \
  "select table_name from information_schema.tables where table_name like 'collaboration_graph%' order by 1" 2>&1
echo "###### SETUP DONE ######"
