// 探针：在真实 janus.db 的 task_events 里找「计划步骤」事件，并报出 step 的字段形状。
//
// 背景：rollout JSONL 里**没有** plan 数据（_probe_plan_steps.mjs 实测 planStepShapes 为空），
// 所以 plan step 的唯一落点是 task_events.payload_json（scheduler 的 publishProcessEvent）。
// 本脚本只读。
//
// 用法：node _probe_task_events_plan.mjs <janus.db>
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error('usage: node _probe_task_events_plan.mjs <janus.db>');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const q = (sql, params = []) => { try { return db.prepare(sql).all(...params); } catch { return []; } };

const total = q('SELECT COUNT(*) AS n FROM task_events')[0]?.n ?? 0;
const byType = q(`SELECT event_type, COUNT(*) AS n FROM task_events GROUP BY event_type ORDER BY n DESC LIMIT 30`);
const activityTypes = q(`SELECT json_extract(payload_json,'$.activityType') AS activityType, COUNT(*) AS n
                         FROM task_events WHERE activityType IS NOT NULL GROUP BY activityType ORDER BY n DESC`);

const planRows = q(`SELECT id, task_run_id, task_node_id, event_type, summary, payload_json, created_at
                    FROM task_events
                    WHERE activityType = 'plan' OR payload_json LIKE '%"plan":%'
                    ORDER BY created_at DESC LIMIT 40`);

const stepShapes = new Map();
const samples = [];
for (const row of planRows) {
  let payload = null;
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { continue; }
  const steps = payload.plan;
  if (!Array.isArray(steps) || !steps.length) continue;
  const fields = [...new Set(steps.flatMap((s) => (s && typeof s === 'object' ? Object.keys(s) : [`<${typeof s}>`])))].sort();
  const key = fields.join(',');
  stepShapes.set(key, (stepShapes.get(key) || 0) + 1);
  if (samples.length < 3) samples.push({ eventId: row.id, taskNodeId: row.task_node_id, stepCount: steps.length, steps: steps.slice(0, 4) });
}

console.log(JSON.stringify({
  db: DB_PATH,
  totalTaskEvents: total,
  eventTypeHistogram: byType,
  activityTypeHistogram: activityTypes,
  planEventRows: planRows.length,
  planStepShapes: [...stepShapes.entries()].map(([fields, n]) => ({ fields: fields.split(','), occurrences: n })),
  samples,
}, null, 2));
db.close();
