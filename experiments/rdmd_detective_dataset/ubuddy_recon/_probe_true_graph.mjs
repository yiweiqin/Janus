// 只读探针：核对 collaboration_graph_* 是否真的存在于活库中。
//
// 背景：此前 UBUDDY_RECON 的实测是在上游表（task_runs / task_nodes /
// task_node_result_versions / task_graph_revisions）上做的，因为当时
// collaboration_graph_* 在两个库里都不存在。但 sqliteMigrations.js:553 的
// ensureUBuddyCollaborationGraphSchema(db) 是无条件调用的 —— 桌面端一旦重启就会建表。
// 这个探针回答的正是：现在到底建出来了没有。
//
// 只读打开；不做任何写入。
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error('usage: node _probe_true_graph.mjs <path-to-janus.db>');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function q(sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    return [{ __error: String(error?.message || error) }];
  }
}

function tableExists(name) {
  const row = q("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return Array.isArray(row) && row.length > 0 && !row[0].__error;
}

console.log(`DB: ${DB_PATH}`);

console.log('\n=== 1. collaboration_graph_* 表是否存在 ===');
for (const t of ['collaboration_graphs', 'collaboration_graph_nodes', 'collaboration_graph_edges', 'collaboration_graph_events']) {
  const exists = tableExists(t);
  let count = '-';
  if (exists) {
    const r = q(`SELECT count(*) AS n FROM ${t}`);
    count = r[0]?.__error ? `ERR ${r[0].__error}` : r[0].n;
  }
  console.log(`  ${exists ? 'EXISTS' : 'MISSING'}  ${t.padEnd(30)} rows=${count}`);
}

console.log('\n=== 2. schema_migrations 里的 uBuddy 相关迁移 ===');
for (const r of q("SELECT id FROM schema_migrations WHERE id LIKE '%collaboration%' OR id LIKE '%ubuddy%' ORDER BY id")) {
  console.log(`  ${r.id ?? r.__error}`);
}

console.log('\n=== 3. 上游表规模（对照） ===');
for (const t of ['task_runs', 'task_nodes', 'task_node_result_versions', 'task_graph_revisions', 'task_events', 'agent_delegations']) {
  if (!tableExists(t)) { console.log(`  MISSING  ${t}`); continue; }
  const r = q(`SELECT count(*) AS n FROM ${t}`);
  console.log(`  ${t.padEnd(30)} rows=${r[0]?.__error ? `ERR ${r[0].__error}` : r[0].n}`);
}

if (tableExists('collaboration_graphs')) {
  console.log('\n=== 4. 图规模 ===');
  console.log('  graphs:', JSON.stringify(q('SELECT count(*) AS n FROM collaboration_graphs')[0]));
  console.log('  nodes :', JSON.stringify(q('SELECT count(*) AS n FROM collaboration_graph_nodes')[0]));
  console.log('  edges :', JSON.stringify(q('SELECT count(*) AS n FROM collaboration_graph_edges')[0]));
  console.log('  events:', JSON.stringify(q('SELECT count(*) AS n FROM collaboration_graph_events')[0]));

  console.log('\n=== 5. 节点 kind / depth 分布 ===');
  for (const r of q('SELECT kind, depth, count(*) AS n FROM collaboration_graph_nodes GROUP BY kind, depth ORDER BY n DESC')) {
    console.log(`  kind=${String(r.kind).padEnd(12)} depth=${r.depth}  n=${r.n}`);
  }

  console.log('\n=== 6. 边 kind 分布（关键：dependency_of 有没有 ===');
  for (const r of q('SELECT kind, count(*) AS n FROM collaboration_graph_edges GROUP BY kind ORDER BY n DESC')) {
    console.log(`  ${String(r.kind).padEnd(16)} n=${r.n}`);
  }

  console.log('\n=== 7. 每图节点数 / 边数分布 ===');
  const perGraph = q(`SELECT g.id, 
      (SELECT count(*) FROM collaboration_graph_nodes n WHERE n.graph_id=g.id) AS node_count,
      (SELECT count(*) FROM collaboration_graph_edges e WHERE e.graph_id=g.id) AS edge_count
    FROM collaboration_graphs g`);
  const nodeCounts = perGraph.map((r) => r.node_count).sort((a, b) => a - b);
  const edgeCounts = perGraph.map((r) => r.edge_count).sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : '-');
  console.log(`  node_count: n=${nodeCounts.length} min=${nodeCounts[0] ?? '-'} p50=${pct(nodeCounts, 0.5)} p90=${pct(nodeCounts, 0.9)} max=${nodeCounts.at(-1) ?? '-'}`);
  console.log(`  edge_count: n=${edgeCounts.length} min=${edgeCounts[0] ?? '-'} p50=${pct(edgeCounts, 0.5)} p90=${pct(edgeCounts, 0.9)} max=${edgeCounts.at(-1) ?? '-'}`);

  console.log('\n=== 8. 事件类型分布 ===');
  for (const r of q('SELECT event_type, count(*) AS n FROM collaboration_graph_events GROUP BY event_type ORDER BY n DESC LIMIT 25')) {
    console.log(`  ${String(r.event_type).padEnd(34)} n=${r.n}`);
  }

  console.log('\n=== 9. public_summary 填充率 ===');
  for (const r of q(`SELECT kind,
      count(*) AS total,
      sum(CASE WHEN trim(coalesce(public_summary,''))<>'' THEN 1 ELSE 0 END) AS filled,
      sum(CASE WHEN trim(coalesce(title,''))<>'' THEN 1 ELSE 0 END) AS title_filled
    FROM collaboration_graph_nodes GROUP BY kind`)) {
    console.log(`  kind=${String(r.kind).padEnd(12)} total=${r.total} summary_filled=${r.filled} title_filled=${r.title_filled}`);
  }
}

db.close();
