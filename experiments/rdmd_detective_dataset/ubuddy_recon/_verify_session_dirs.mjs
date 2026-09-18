// 只读：检查 session 目录名 ↔ sessions 表 ↔ rollout 的对应关系（比 codex_thread_id 更宽的 join）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const ROOT = process.argv[3];
const q = (s, p = []) => { try { return db.prepare(s).all(...p); } catch (e) { return [{ __error: String(e?.message || e) }]; } };

console.log('### 磁盘上的 codex_backend_sessions 目录');
const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
for (const d of dirs) {
  const dir = path.join(ROOT, d);
  let n = 0, bytes = 0;
  (function walk(p) {
    let es = []; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) { n++; try { bytes += fs.statSync(f).size; } catch {} } }
  })(dir);
  console.log(`  ${d}  rollouts=${n}  bytes=${bytes}`);
}

console.log('\n### sessions 表里 id 以 session_task_node_ 开头的行');
const rows = q(`SELECT id, codex_thread_id, department_id, agent_id, status, created_at FROM sessions WHERE id LIKE 'session_task_node_%'`);
console.log(`  数量: ${rows.length}`);
for (const r of rows) console.log(`  ${r.id}  thread=${r.codex_thread_id || '(空)'}  agent=${r.agent_id}  status=${r.status}  ${r.created_at}`);

console.log('\n### 目录名是否都能在 sessions 表里找到');
for (const d of dirs) {
  if (!d.startsWith('session')) continue;
  const hit = q('SELECT id, codex_thread_id FROM sessions WHERE id=?', [d])[0];
  console.log(`  ${d}  -> ${hit && !hit.__error ? `FOUND thread=${hit.codex_thread_id || '(空)'}` : 'NOT IN sessions'}`);
}

console.log('\n### 24 个 task_node 执行按 status 汇总（哪些真跑过 rollout）');
for (const r of q(`SELECT status, count(*) n FROM model_executions WHERE execution_kind='task_node' GROUP BY status`)) {
  console.log(`  status=${String(r.status).padEnd(14)} n=${r.n}`);
}
db.close();
