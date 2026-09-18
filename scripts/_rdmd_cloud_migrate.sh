#!/usr/bin/env bash
# 在盒子上把云库推到迁移头（096 放四层图的 depth 上界，097 建 RDMD 作业表）。
#
# **必须用 migrator 角色**：cloud_* / collaboration_* 这些表的 owner 是
# janus_migrator_login，用 api 角色（janus_api_login）执行 ALTER 会直接
# `ERROR: must be owner of table collaboration_graph_nodes`。
# cloud/scripts/migrate.mjs 读的是 DATABASE_MIGRATOR_URL，走的就是这条正路；
# 而 `cloud/src/index.mjs` 在非 production 下用 api 池调 migrate()，在这台盒子上必然失败 ——
# 所以"起服务顺便把迁移跑了"在这里行不通，必须先迁移、再按 production 起服务。
set -euo pipefail

NODE=/root/.nvm/versions/node/v22.23.2/bin/node
JANUS=/root/Janus
[ -x "$NODE" ] || { echo "node 不可用: $NODE"; exit 1; }
[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a

cd "$JANUS"

echo "############ 迁移前 ############"
psql "$DATABASE_URL" -tAc "SELECT filename FROM public.schema_migrations ORDER BY applied_at, filename;" | tail -4
echo "--- depth 约束（096 会删掉它）---"
psql "$DATABASE_URL" -tAc "SELECT conname||' :: '||pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.collaboration_graph_nodes'::regclass AND contype='c';"
echo "--- rdmd 作业表（应为空/None）---"
psql "$DATABASE_URL" -tAc "SELECT coalesce(to_regclass('public.cloud_rdmd_inference_jobs')::text,'(不存在)');"

echo
echo "############ 执行迁移（migrator 角色）############"
"$NODE" cloud/scripts/migrate.mjs

echo
echo "############ 迁移后 ############"
psql "$DATABASE_URL" -tAc "SELECT filename FROM public.schema_migrations ORDER BY applied_at, filename;" | tail -4
echo "--- depth 约束（应已消失）---"
psql "$DATABASE_URL" -tAc "SELECT coalesce(string_agg(conname,','),'(无 CHECK)') FROM pg_constraint WHERE conrelid='public.collaboration_graph_nodes'::regclass AND contype='c';"
echo "--- rdmd 作业表结构 ---"
psql "$DATABASE_URL" -tAc "SELECT column_name||':'||data_type FROM information_schema.columns WHERE table_name='cloud_rdmd_inference_jobs' ORDER BY ordinal_position;"
echo "--- rdmd 作业表的约束 ---"
psql "$DATABASE_URL" -tAc "SELECT conname FROM pg_constraint WHERE conrelid='public.cloud_rdmd_inference_jobs'::regclass ORDER BY conname;"
echo "--- 索引 ---"
psql "$DATABASE_URL" -tAc "SELECT indexname FROM pg_indexes WHERE tablename='cloud_rdmd_inference_jobs' ORDER BY indexname;"

echo
echo "############ readiness 自检（应用层的判据）############"
"$NODE" -e "
import('./cloud/src/db.mjs').then(async (m) => {
  const pool = m.createPgPool(process.env.DATABASE_URL);
  try {
    const r = await m.cloudDatabaseReadiness(pool);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ready) { console.error('NOT_READY'); process.exit(3); }
    console.log('READY');
  } finally { await pool.end(); }
}).catch((e) => { console.error('readiness_error', e.message); process.exit(4); });
"
