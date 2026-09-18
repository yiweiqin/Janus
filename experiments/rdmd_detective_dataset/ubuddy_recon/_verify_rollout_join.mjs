// 只读验证：task_node → codex_thread_id → rollout JSONL 的 join 是否闭合。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const ROOT = process.argv[3];
const q = (s, p = []) => { try { return db.prepare(s).all(...p); } catch (e) { return [{ __error: String(e?.message || e) }]; } };

// 1. 收集磁盘上所有 rollout 文件
const rollouts = [];
(function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) rollouts.push(full);
  }
})(ROOT);
console.log(`磁盘 rollout 文件: ${rollouts.length}`);

// rollout-2026-09-14T23-13-50-01a0a07b-4e85-7540-9442-42a82ff00ddd.jsonl
// 线程 id 是时间戳之后的 UUID 部分
const byThread = new Map();
for (const f of rollouts) {
  const base = path.basename(f).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  const m = base.match(/^(.*?T\d{2}-\d{2}-\d{2})-(.+)$/);
  const thread = m ? m[2] : '';
  if (thread) byThread.set(thread, f);
}
console.log(`可解析出 thread id 的 rollout: ${byThread.size}`);

// 2. model_executions 的 task_node 执行
console.log('\n### execution_kind 分布');
for (const r of q(`SELECT execution_kind, count(*) n, sum(CASE WHEN trim(coalesce(codex_thread_id,''))<>'' THEN 1 ELSE 0 END) AS with_thread
                   FROM model_executions GROUP BY execution_kind ORDER BY n DESC`)) {
  console.log(`  ${String(r.execution_kind).padEnd(34)} n=${r.n}  with_codex_thread=${r.with_thread}`);
}

console.log('\n### task_node 执行的 join 闭合情况');
const tns = q(`SELECT task_node_id, task_run_id, codex_thread_id, status
               FROM model_executions WHERE execution_kind='task_node' ORDER BY started_at`);
console.log(`  task_node 执行数: ${tns.length}`);
let closed = 0;
for (const r of tns) {
  const th = String(r.codex_thread_id || '').trim();
  const f = th ? byThread.get(th) : null;
  if (f) closed++;
  console.log(`  node=${String(r.task_node_id).slice(0, 30)} status=${r.status} thread=${th || '(空)'} rollout=${f ? path.basename(f) : '未找到'}`);
}
console.log(`  -> 闭合 ${closed} / ${tns.length}`);

// 3. 反向：磁盘上哪些 rollout 没有被任何 model_executions 引用
const referenced = new Set(q(`SELECT codex_thread_id FROM model_executions WHERE trim(coalesce(codex_thread_id,''))<>''`).map((r) => r.codex_thread_id));
const orphans = [...byThread.entries()].filter(([t]) => !referenced.has(t));
console.log(`\n### 磁盘 rollout 未被 model_executions 引用: ${orphans.length} / ${byThread.size}`);
for (const [t, f] of orphans.slice(0, 12)) console.log(`  ${t}  ${path.basename(f)}`);

db.close();
