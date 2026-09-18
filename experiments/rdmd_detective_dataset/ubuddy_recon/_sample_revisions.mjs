// 只读采样：真实 task_graph_revisions 的 before/after 形状，以及 task_runs/task_nodes 的快照。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const q = (s, p = []) => { try { return db.prepare(s).all(...p); } catch (e) { return [{ __error: String(e?.message || e) }]; } };

console.log('=== task_graph_revisions 样本（全部） ===');
const revs = q(`SELECT id, task_run_id, revision_type, reason, before_json, after_json, created_at
                FROM task_graph_revisions ORDER BY created_at`);
for (const r of revs) {
  console.log(`\n--- ${r.revision_type}  run=${String(r.task_run_id).slice(0, 20)}  ${r.created_at} ---`);
  console.log(`  reason: ${String(r.reason || '').slice(0, 200)}`);
  console.log(`  before_json (${String(r.before_json || '').length} chars): ${String(r.before_json || '').slice(0, 700)}`);
  console.log(`  after_json  (${String(r.after_json || '').length} chars): ${String(r.after_json || '').slice(0, 700)}`);
}

console.log('\n\n=== task_runs 样本 ===');
for (const r of q(`SELECT id, title, status, objective, created_at, updated_at FROM task_runs ORDER BY created_at`)) {
  console.log(`  ${String(r.id).slice(0, 40)} status=${r.status}`);
  console.log(`    title: ${String(r.title || '').slice(0, 120)}`);
}

console.log('\n=== task_nodes 样本（title / objective / result_summary 的长度） ===');
for (const r of q(`SELECT id, task_run_id, title, status, length(objective) AS obj_len,
                          length(coalesce(result_summary,'')) AS sum_len, length(coalesce(result_text,'')) AS txt_len,
                          dependencies_json, agent_id
                   FROM task_nodes ORDER BY created_at`)) {
  console.log(`  ${String(r.id).slice(0, 34)} [${r.status}] agent=${r.agent_id}`);
  console.log(`    title: ${String(r.title || '').slice(0, 100)}`);
  console.log(`    objective=${r.obj_len}ch  result_summary=${r.sum_len}ch  result_text=${r.txt_len}ch  deps=${r.dependencies_json}`);
}
db.close();
