set +e
source /root/.config/janus/remote.env 2>/dev/null
echo "=== schema_migrations 的真实列 ==="
psql "$DATABASE_URL" -c "select column_name, data_type from information_schema.columns where table_name='schema_migrations' order by ordinal_position" 2>&1
psql "$DATABASE_URL" -Atc "select * from schema_migrations order by 1 desc limit 6" 2>&1
echo "=== 任务侧是否有任何真实数据 ==="
psql "$DATABASE_URL" -c "
select 'cloud_task_nodes' as t, count(*) from cloud_task_nodes
union all select 'cloud_task_events', count(*) from cloud_task_events
union all select 'cloud_evolution_jobs', count(*) from cloud_evolution_jobs
" 2>&1
echo "=== 094 建的 collaboration_graph_nodes 列（P1/P4 要对齐） ==="
psql "$DATABASE_URL" -c "select column_name, data_type, is_nullable from information_schema.columns where table_name='collaboration_graph_nodes' order by ordinal_position" 2>&1
echo "=== cloud_evolution_jobs 的列（迁移 097 照抄它的形状） ==="
psql "$DATABASE_URL" -c "select column_name, data_type, is_nullable from information_schema.columns where table_name='cloud_evolution_jobs' order by ordinal_position" 2>&1
echo "=== depth 约束是否已放宽到 3（迁移 096） ==="
psql "$DATABASE_URL" -Atc "select pg_get_constraintdef(oid) from pg_constraint where conrelid='collaboration_graph_nodes'::regclass and contype='c'" 2>&1
echo "=== DONE ==="
