// 探针：在真实 janus.db 的 task_events 里找「计划步骤」事件，并报出 step 的字段形状。
//
// 背景：rollout JSONL 里**没有** plan 数据（_probe_plan_steps.mjs 实测 planStepShapes 为空），
// 所以 plan step 的唯一落点是 task_events.payload_json（scheduler 的 publishProcessEvent）。
// 本脚本只读。
//
// 用法：node _probe_task_events_plan.mjs <janus.db>
//
// ---------------------------------------------------------------------------
// 这个脚本曾经报出 `planEventRows: 0`，而真实库里有 6 条 plan 事件 —— 结论错了，
// 但没有任何症状。原因有两层，两层都得修：
//
//   1. WHERE 里用了 **SELECT 别名**：`WHERE activityType = 'plan'`。SQLite 只在
//      `GROUP BY` 那种形式上容忍别名（所以本文件里那条直方图查询是好的、更能骗人），
//      `= 'plan'` 这种比较直接抛 `no such column: activityType`。
//   2. `q()` 把异常吞成 `[]`：于是"查询写错了"和"表里没有这类数据"变成同一个输出。
//
// 第 2 条是要害。第 1 条只是这一次的具体错法；`catch { return [] }` 会让**任何**下一次
// SQL 笔误都继续以"真实数据里确实没有"的形式汇报出来 —— 而这正是"输入侧是断的"
// 这个结论原来的证据。所以现在查询失败会**打印出来并以非零码退出**，不再冒充空结果。
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error('usage: node _probe_task_events_plan.mjs <janus.db>');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const failures = [];

// 查询失败必须可见：绝不返回 []。修这个探针的那次真实教训见文件头。
const q = (label, sql, params = []) => {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    failures.push({ label, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 160), message: String(error.message || error) });
    return null;
  }
};

const total = q('total task_events', 'SELECT COUNT(*) AS n FROM task_events')?.[0]?.n ?? 0;
const byType = q('event_type histogram',
  `SELECT event_type, COUNT(*) AS n FROM task_events GROUP BY event_type ORDER BY n DESC LIMIT 30`);
// 别名在 WHERE 里按 SQLite 的容忍度只对 IS NOT NULL + GROUP BY 这种形式成立，
// 但仍写成 json_extract 以免留一个"靠方言侥幸"的地方。
const activityTypes = q('activityType histogram',
  `SELECT json_extract(payload_json,'$.activityType') AS activityType, COUNT(*) AS n
   FROM task_events WHERE json_extract(payload_json,'$.activityType') IS NOT NULL
   GROUP BY activityType ORDER BY n DESC`);

// plan 事件的判据：payload 里既有 activityType='plan'，也有一个非空的 plan 数组。
const planRows = q('plan events',
  `SELECT id, task_run_id, task_node_id, event_type, summary, payload_json, created_at
   FROM task_events
   WHERE json_extract(payload_json,'$.activityType') = 'plan'
      OR json_extract(payload_json,'$.plan') IS NOT NULL
   ORDER BY created_at DESC LIMIT 200`);

const stepShapes = new Map();
const samples = [];
const stepStatuses = new Map();
const byTaskRun = new Map();
const producers = new Map();

for (const row of planRows || []) {
  let payload = null;
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { continue; }
  const steps = payload.plan;
  if (!Array.isArray(steps) || !steps.length) continue;

  byTaskRun.set(row.task_run_id, (byTaskRun.get(row.task_run_id) || 0) + steps.length);

  const producerKey = `${payload.eventOrigin || '?'}/${payload.nativeSource || '?'}/${row.event_type}`;
  producers.set(producerKey, (producers.get(producerKey) || 0) + 1);

  const fields = [...new Set(steps.flatMap((s) => (s && typeof s === 'object' ? Object.keys(s) : [`<${typeof s}>`])))].sort();
  const key = fields.join(',');
  stepShapes.set(key, (stepShapes.get(key) || 0) + 1);

  for (const s of steps) {
    const st = (s && typeof s === 'object' && s.status) || '<none>';
    stepStatuses.set(st, (stepStatuses.get(st) || 0) + 1);
  }

  if (samples.length < 3) {
    samples.push({ eventId: row.id, taskNodeId: row.task_node_id, stepCount: steps.length, steps: steps.slice(0, 4) });
  }
}

// step 的 status 取值，正是 agent_step 层唯一的漂移信号（v2 契约里 agent_step 要求 title+status）。
// 单独报出来，是为了让"投影真的能把 cancelled 做出来吗"这件事有据可查。
const PLAN_STEP_STATUSES_EXPECTED = ['pending', 'inProgress', 'completed', 'cancelled'];

console.log(JSON.stringify({
  db: DB_PATH,
  totalTaskEvents: total,
  eventTypeHistogram: byType,
  activityTypeHistogram: activityTypes,
  planEventRows: (planRows || []).length,
  planStepCount: [...byTaskRun.values()].reduce((a, b) => a + b, 0),
  planEventsByTaskRun: [...byTaskRun.entries()].map(([taskRunId, steps]) => ({ taskRunId, steps })),
  producers: [...producers.entries()].map(([producer, n]) => ({ producer, n })),
  planStepShapes: [...stepShapes.entries()].map(([fields, n]) => ({ fields: fields.split(','), occurrences: n })),
  planStepStatuses: [...stepStatuses.entries()].map(([status, n]) => ({ status, n })),
  unexpectedStepStatuses: [...stepStatuses.keys()].filter((s) => !PLAN_STEP_STATUSES_EXPECTED.includes(s)),
  samples,
  queryFailures: failures,
}, null, 2));

db.close();

// 查询失败 = 探针没跑成，不是"数据里没有"。
if (failures.length) {
  console.error(`\n[FAIL] ${failures.length} 条查询失败 —— 上面的 0 不代表"数据里没有"：`);
  for (const f of failures) console.error(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
