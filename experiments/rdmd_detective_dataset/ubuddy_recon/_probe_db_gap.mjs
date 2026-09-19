// Probe the real DB: does it contain the *product* collaboration-graph tables,
// and if so, what do real exec-side nodes actually carry (kind / summary / output)?
// Read-only. This decides whether P1's 6/6 is a contract gap or a harness gap.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const has = (t) => {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  return !!r;
};
const tables = ['collaboration_graph_nodes', 'collaboration_graph_edges', 'collaboration_graph_events',
  'collaboration_graphs', 'task_nodes', 'task_runs', 'task_events'];

console.log('=== table presence + row counts ===');
for (const t of tables) {
  if (!has(t)) { console.log(`  ${t.padEnd(30)} MISSING`); continue; }
  try {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
    console.log(`  ${t.padEnd(30)} ${n}`);
  } catch (e) { console.log(`  ${t.padEnd(30)} ERR ${e.message.slice(0, 60)}`); }
}

if (has('collaboration_graph_nodes')) {
  console.log('\n=== collaboration_graph_nodes: kind distribution ===');
  try {
    for (const r of db.prepare(`SELECT kind, COUNT(*) AS n FROM collaboration_graph_nodes GROUP BY kind ORDER BY n DESC`).all()) {
      console.log(`  ${String(r.kind).padEnd(16)} ${r.n}`);
    }
  } catch (e) { console.log('  ERR', e.message.slice(0, 120)); }

  console.log('\n=== non-empty outcome-text columns per kind ===');
  const cols = db.prepare(`PRAGMA table_info(collaboration_graph_nodes)`).all().map((c) => c.name);
  console.log('  columns:', cols.join(', '));
  for (const col of ['public_summary', 'status', 'title']) {
    if (!cols.includes(col)) continue;
    try {
      for (const r of db.prepare(`SELECT kind, COUNT(*) AS n, SUM(CASE WHEN COALESCE(${col},'')<>'' THEN 1 ELSE 0 END) AS nonempty
                                  FROM collaboration_graph_nodes GROUP BY kind`).all()) {
        console.log(`  ${col.padEnd(15)} ${String(r.kind).padEnd(14)} ${r.nonempty}/${r.n} non-empty`);
      }
    } catch (e) { console.log(`  ${col}: ERR ${e.message.slice(0, 80)}`); }
  }
}

console.log('\n=== task_nodes: dependencies_json populated? ===');
try {
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(dependencies_json,'[]') NOT IN ('','[]') THEN 1 ELSE 0 END) AS withdeps FROM task_nodes`).get();
  console.log(`  task_nodes=${r.n}, with non-empty dependencies_json=${r.withdeps}`);
} catch (e) { console.log('  ERR', e.message.slice(0, 100)); }

console.log('\n=== task_events: any plan events? ===');
try {
  for (const r of db.prepare(`SELECT activity_type, COUNT(*) AS n FROM task_events GROUP BY activity_type ORDER BY n DESC LIMIT 20`).all()) {
    console.log(`  ${String(r.activity_type).padEnd(30)} ${r.n}`);
  }
} catch (e) { console.log('  ERR', e.message.slice(0, 100)); }
