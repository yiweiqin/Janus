set +e
# 云端数据库侦察（只读 SELECT）。在 bjb1 上用 DATABASE_URL 连本地 Postgres。
# 注意：remote.env 里 PGUSER 可能是空的，所以不能用裸 psql，必须显式带 URI。
source /root/.config/janus/remote.env 2>/dev/null
echo "=== identity ==="
psql "$DATABASE_URL" -Atc "select current_database() || ' / ' || current_user" 2>&1
echo "=== 表清单（含 collaboration / task） ==="
psql "$DATABASE_URL" -Atc "select table_name from information_schema.tables where table_schema='public' order by 1" 2>&1 | grep -E 'collaboration|task|migration|evolution|sync' | head -40
echo "=== 迁移头 ==="
psql "$DATABASE_URL" -Atc "select max(version) from schema_migrations" 2>&1
psql "$DATABASE_URL" -Atc "select version, applied_at from schema_migrations order by version desc limit 5" 2>&1
echo "=== collaboration_graph* 行数 ==="
psql "$DATABASE_URL" -c "
select 'collaboration_graphs' as t, count(*) from collaboration_graphs
union all select 'collaboration_graph_nodes', count(*) from collaboration_graph_nodes
union all select 'collaboration_graph_edges', count(*) from collaboration_graph_edges
union all select 'collaboration_graph_events', count(*) from collaboration_graph_events
" 2>&1
echo "=== nodes 按 depth 分布（depth=3 即 agent_step） ==="
psql "$DATABASE_URL" -c "select depth, count(*) from collaboration_graph_nodes group by 1 order by 1" 2>&1
echo "=== nodes 按 kind 分布 ==="
psql "$DATABASE_URL" -c "select kind, count(*) from collaboration_graph_nodes group by 1 order by 2 desc limit 15" 2>&1
echo "=== edges 按 kind 分布 ==="
psql "$DATABASE_URL" -c "select kind, count(*) from collaboration_graph_edges group by 1 order by 2 desc limit 15" 2>&1
echo "=== 富文本填充率 ==="
psql "$DATABASE_URL" -c "
select count(*) as nodes,
  count(*) filter (where coalesce(public_summary,'') <> '') as with_summary,
  count(*) filter (where coalesce(title,'') <> '') as with_title
from collaboration_graph_nodes" 2>&1
echo "=== DONE ==="
