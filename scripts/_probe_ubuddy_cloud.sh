#!/usr/bin/env bash
# uBuddy 云端数据侦察：第一步，只回答「到底有没有数据」。
# 只读 SELECT，不改任何东西。可在无卡模式下跑（用不到 GPU）。
#
# 目标机：跑 Janus 云端 + PostgreSQL 的那台（仓库里记作 seeta，
# connect.westb.seetacloud.com:42985）。**不是** RDMD 训练盒子（bjb1:53957）。
set +e

echo "=== host ==="
hostname; date

echo "=== postgres cluster ==="
pg_lsclusters 2>/dev/null
pg_isready 2>&1
# 容器重启后 postgres 不会自动拉起，需要显式启动。
if ! pg_isready >/dev/null 2>&1; then
  echo "[info] postgres not ready, trying to start cluster 14/main..."
  pg_ctlcluster 14 main start 2>&1 | head -5
  sleep 3
  pg_isready 2>&1
fi

echo "=== env ==="
if [ -f /root/.config/janus/remote.env ]; then
  echo "found /root/.config/janus/remote.env"
  # shellcheck disable=SC1091
  source /root/.config/janus/remote.env
  echo "PGHOST=$PGHOST PGPORT=$PGPORT PGDATABASE=$PGDATABASE PGUSER=$PGUSER"
  echo "DATABASE_URL host/port/db: $(echo "$DATABASE_URL" | sed -E 's#//[^:]+:[^@]+@#//***:***@#')"
else
  echo "[warn] /root/.config/janus/remote.env missing"
fi

echo "=== tables: collaboration_graph* ==="
psql -Atc "select table_name from information_schema.tables where table_name like 'collaboration_graph%' order by 1" 2>&1

echo "=== row counts ==="
psql -c "
select 'collaboration_graphs'  as t, count(*) from collaboration_graphs
union all select 'collaboration_graph_nodes',  count(*) from collaboration_graph_nodes
union all select 'collaboration_graph_edges',  count(*) from collaboration_graph_edges
union all select 'collaboration_graph_events', count(*) from collaboration_graph_events
" 2>&1

echo "=== task tables row counts ==="
psql -c "
select 'task_runs' as t, count(*) from task_runs
union all select 'task_nodes', count(*) from task_nodes
" 2>&1

echo "=== nodes per graph (distribution) ==="
psql -c "
select n as nodes_per_graph, count(*) as graphs
from (
  select g.id, (select count(*) from collaboration_graph_nodes x where x.graph_id = g.id) as n
  from collaboration_graphs g
) s
group by n order by n
" 2>&1

echo "=== rich text fill (public_summary) ==="
psql -c "
select
  count(*) as nodes,
  count(*) filter (where coalesce(public_summary,'') <> '') as with_summary,
  round(100.0 * count(*) filter (where coalesce(public_summary,'') <> '') / greatest(count(*),1), 1) as pct
from collaboration_graph_nodes
" 2>&1

echo "=== edges: kind distribution ==="
psql -c "select kind, count(*) from collaboration_graph_edges group by kind order by 2 desc" 2>&1

echo "=== edges: parent_node_id fill ==="
psql -c "
select
  count(*) filter (where kind <> 'root') as non_root,
  count(*) filter (where kind <> 'root' and coalesce(parent_node_id,'') <> '') as non_root_with_parent
from collaboration_graph_nodes
" 2>&1

echo "=== events: type distribution (top 20) ==="
psql -c "select event_type, count(*) from collaboration_graph_events group by 1 order by 2 desc limit 20" 2>&1

echo "=== events: revisions per graph (distribution) ==="
psql -c "
select revs as revisions_per_graph, count(*) as graphs from (
  select g.id, (select count(*) from collaboration_graph_events e where e.graph_id = g.id) as revs
  from collaboration_graphs g
) s group by revs order by revs
" 2>&1

echo "=== graphs by lifecycle_status ==="
psql -c "select lifecycle_status, count(*) from collaboration_graphs group by 1 order by 2 desc" 2>&1

echo "=== DONE ==="
