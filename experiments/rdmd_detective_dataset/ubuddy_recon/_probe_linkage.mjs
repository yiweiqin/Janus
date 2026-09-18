// 只读：查 task_runs / sessions / model_executions 的表结构与真实链路，
// 为 G_plan / G_exec 的构造定义提供依据。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const q = (s, p = []) => { try { return db.prepare(s).all(...p); } catch (e) { return [{ __error: String(e?.message || e) }]; } };
const cols = (t) => q(`PRAGMA table_info(${t})`).map((r) => r.name);

for (const t of ['task_runs', 'sessions', 'model_executions', 'task_node_result_versions']) {
  const has = q("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]).length > 0;
  console.log(`\n### ${t}  ${has ? '' : '(不存在)'}`);
  if (!has) continue;
  const c = cols(t);
  console.log(`  列 (${c.length}): ${c.join(', ')}`);
  console.log(`  行数: ${q(`SELECT count(*) n FROM ${t}`)[0]?.n}`);
}

console.log('\n### task_runs 全量（挑可用字段）');
const trc = cols('task_runs');
const pick = ['id', 'title', 'status', 'objective', 'lead_agent_id', 'owner_user_id', 'created_at'].filter((c) => trc.includes(c));
for (const r of q(`SELECT ${pick.join(',')} FROM task_runs`)) {
  console.log(`  ${JSON.stringify(r).slice(0, 320)}`);
}

console.log('\n### sessions：codex_thread_id 与 task 的关联');
const sc = cols('sessions');
if (sc.includes('codex_thread_id')) {
  const sel = ['id', ...(sc.includes('task_run_id') ? ['task_run_id'] : []), ...(sc.includes('agent_kind') ? ['agent_kind'] : []), 'codex_thread_id'].filter((c) => sc.includes(c));
  const rows = q(`SELECT ${sel.join(',')} FROM sessions WHERE trim(coalesce(codex_thread_id,''))<>'' LIMIT 30`);
  console.log(`  有 codex_thread_id 的 session 数: ${q(`SELECT count(*) n FROM sessions WHERE trim(coalesce(codex_thread_id,''))<>''`)[0]?.n}`);
  for (const r of rows) console.log(`  ${JSON.stringify(r).slice(0, 240)}`);
} else {
  console.log('  sessions 无 codex_thread_id 列');
}

console.log('\n### model_executions：codex_thread_id / task_node 关联');
const mc = cols('model_executions');
if (mc.includes('codex_thread_id')) {
  console.log(`  有 codex_thread_id 的行: ${q(`SELECT count(*) n FROM model_executions WHERE trim(coalesce(codex_thread_id,''))<>''`)[0]?.n}`);
  const sel = ['id', ...(mc.includes('task_node_id') ? ['task_node_id'] : []), ...(mc.includes('task_run_id') ? ['task_run_id'] : []), ...(mc.includes('execution_kind') ? ['execution_kind'] : []), 'codex_thread_id'].filter((c) => mc.includes(c));
  for (const r of q(`SELECT ${sel.join(',')} FROM model_executions LIMIT 20`)) console.log(`  ${JSON.stringify(r).slice(0, 300)}`);
}

db.close();
