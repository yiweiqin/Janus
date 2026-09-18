#!/usr/bin/env bash
# 只读侦察 3：确认"能不能在这台盒子上把云 API 真的跑起来"。
# 要回答三件事，任何一件不成立，P4 的验收就得换路：
#   (a) cloud/src 的运行时依赖在 /root/Janus/node_modules 里齐不齐（pg / express ...）
#   (b) janus_api_login 这个角色有没有 DDL 权限（迁移 096/097 要 ALTER/CREATE）
#   (c) 非 production 启动会不会真的走 migrate(pool)
set -uo pipefail

NODE=/root/.nvm/versions/node/v22.23.2/bin/node
echo "############ 1) node 可用性 ############"
"$NODE" --version || echo "(node 不可用)"
echo "node_modules 包数: $(ls -1 /root/Janus/node_modules 2>/dev/null | wc -l)"
echo "--- cloud/src 直接依赖是否就位 ---"
for m in pg express; do
  if [ -d /root/Janus/node_modules/$m ]; then
    printf "%-10s OK  " "$m"; "$NODE" -e "console.log(require('/root/Janus/node_modules/$m/package.json').version)" 2>/dev/null || echo "?"
  else
    echo "$m  缺失"
  fi
done
echo "--- cloud/src 里所有 import 的裸包名（用于对照）---"
grep -rhoE "from '(pg|express|[a-z@][a-z0-9@/._-]+)'" /root/Janus/cloud/src 2>/dev/null \
  | sed -E "s/from '//; s/'//" | grep -vE "^\.|^node:" | sort -u | head -30

echo
echo "############ 2) 数据库权限 ############"
[ -f /root/.config/janus/remote.env ] && { set -a; . /root/.config/janus/remote.env; set +a; }
echo "--- 当前角色与属性 ---"
psql "$DATABASE_URL" -tAc "SELECT current_user, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user;" 2>&1
echo "--- public schema 上的 CREATE 权限 ---"
psql "$DATABASE_URL" -tAc "SELECT has_schema_privilege(current_user,'public','CREATE');" 2>&1
echo "--- collaboration_graph_nodes 的 owner ---"
psql "$DATABASE_URL" -tAc "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='collaboration_graph_nodes';" 2>&1
echo "--- migrator 角色是谁（只打印用户名）---"
if [ -n "${DATABASE_MIGRATOR_URL:-}" ]; then
  echo "$DATABASE_MIGRATOR_URL" | sed -E 's#postgresql://([^:]+):[^@]*@.*#migrator_user=\1#'
else
  echo "(未设置 DATABASE_MIGRATOR_URL)"
fi
echo "--- 实测一次可回滚的 DDL：能否 ALTER 那张表 ---"
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -tAc \
  "BEGIN; ALTER TABLE public.collaboration_graph_nodes ADD COLUMN _rdmd_probe_col int; ROLLBACK;" 2>&1 | head -3
echo "--- 确认探针列没留下 ---"
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='collaboration_graph_nodes' AND column_name='_rdmd_probe_col';" 2>&1

echo
echo "############ 3) 现有 depth 约束（096 要删的就是它）############"
psql "$DATABASE_URL" -tAc "SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid='public.collaboration_graph_nodes'::regclass AND contype='c';" 2>&1 | head -10

echo
echo "############ 4) 096/097 的文件在不在盒子上 ############"
ls -la /root/Janus/cloud/database/migrations/09[4567]*.sql 2>&1

echo
echo "############ 5) 训练进度（不要干扰）############"
tail -3 /root/autodl-tmp/rdmd_runs/qlora-v4/train.log 2>/dev/null || ls -la /root/autodl-tmp/rdmd_runs/qlora-v4/ 2>/dev/null | head -10
nvidia-smi --query-gpu=index,utilization.gpu,memory.used --format=csv,noheader 2>/dev/null
