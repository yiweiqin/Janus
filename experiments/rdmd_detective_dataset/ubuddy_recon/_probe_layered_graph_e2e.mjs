// 端到端验证：真实任务 -> 四层图投影 -> G_plan/G_exec -> 闸门。
//
// 为什么只能在**副本**上做：本机两个 janus.db 都没建过 collaboration_graph_* 表
// （见 _real_live/AGENT_PLAN_OBSERVATION.zh-CN.md 第 1.1 节），而且真实库里
// `activityType='plan'` 有 0 条 —— 也就是说四层图的投影**从来没有被真实数据跑过一次**。
//
// 这个脚本把两步都补上：
//   1. 在副本上跑真实迁移，把 collaboration_graph_* 建出来；
//   2. 挑一个真实 task run（带 delegation，这样 ubuddy 层会存在），
//      往 task_events 里按真实形状注入两条 `turn/plan/updated` 事件
//      （首版 3 步 + 后续版本砍掉第 3 步），然后调用**真实 store 方法**
//      `projectTaskRunToCollaborationGraph` 与 `readPlanExecGraphs`。
//
// 注入 plan 事件是刻意的，而且必须说清楚边界：这不是「写适配器补底料」——
// 探针不改产品代码、不改真实库，也不假设产品会在没有 plan 的情况下工作。
// 它验证的是**当 app-server 真的发出 plan 时，产品侧的投影与闸门是否成立**。
// 这是观测门两条分支里「观测到了」那一条的等价验证。
//
// 用法：node _probe_layered_graph_e2e.mjs <snapshot.db>
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error('usage: node _probe_layered_graph_e2e.mjs <snapshot.db>');
  process.exit(2);
}

const report = { db: DB_PATH, steps: [] };

const { Store } = await import('../../../src/main/store.js');
const db = new DatabaseSync(DB_PATH);

// --- 1. 找一个能撑起四层图的真实 task run -------------------------------------------
// 条件：有 task node（agent_task 层的来源）、有 delegation（ubuddy 层的来源）。
const candidates = db.prepare(`
  SELECT tr.id AS task_run_id, tr.title, tr.status,
         (SELECT COUNT(*) FROM task_nodes tn WHERE tn.task_run_id = tr.id) AS node_count,
         coalesce(json_extract(tr.metadata_json,'$.delegationId'),'') AS delegation_id,
         coalesce(json_extract(tr.metadata_json,'$.collaborationGroupId'),'') AS group_id
  FROM task_runs tr
  ORDER BY node_count DESC, tr.created_at DESC
`).all();
report.steps.push({
  step: 'candidates',
  taskRuns: candidates.length,
  rows: candidates.map((row) => ({
    taskRunId: row.task_run_id, nodes: row.node_count, status: row.status,
    delegationId: row.delegation_id, groupId: row.group_id,
  })),
});

const chosen = candidates.find((row) => row.node_count > 0 && row.delegation_id)
  || candidates.find((row) => row.node_count > 0);
if (!chosen) {
  console.log(JSON.stringify({ ...report, error: 'no task run with task nodes' }, null, 2));
  process.exit(1);
}
report.chosen = { taskRunId: chosen.task_run_id, title: chosen.title, nodes: chosen.node_count,
  delegationId: chosen.delegation_id, groupId: chosen.group_id };

// --- 2. 按真实形状注入 plan 事件 -----------------------------------------------------
// 形状来自 uBuddyAgentPlanSteps.js#normalizeAgentPlan：
//   payload.activityType === 'plan' 且 payload.plan.steps 是数组。
// 两次更新：首版 3 步；第二版只剩 2 步 -> 第 3 步会被 foldAgentPlanEvents 标成 cancelled，
// 这正是 G_plan（首版，3 步）与 G_exec（最终，2 步 + 1 cancelled）在 step 层的唯一漂移。
const firstNode = db.prepare('SELECT id, title, agent_id FROM task_nodes WHERE task_run_id = ? ORDER BY created_at LIMIT 1')
  .get(chosen.task_run_id);
if (!firstNode) {
  console.log(JSON.stringify({ ...report, error: 'chosen run has no task node row' }, null, 2));
  process.exit(1);
}
report.planTarget = { taskNodeId: firstNode.id, title: firstNode.title };

const insertEvent = db.prepare(`
  INSERT INTO task_events (id, task_run_id, task_node_id, event_type, summary, payload_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const planPayload = (steps, explanation) => JSON.stringify({
  activityType: 'plan', status: 'running', title: 'Codex 执行计划', detail: explanation,
  plan: steps.map((label, index) => ({ label, status: 'queued' })),
});
const baseTime = Date.parse('2026-09-17T11:00:00.000Z');
db.exec('BEGIN IMMEDIATE');
try {
  insertEvent.run('rdmd_probe_plan_v1', chosen.task_run_id, firstNode.id, 'agent_plan', '首版计划',
    planPayload(['拉原始表', '缺失值处理', '交付物复核'], '先取数再清洗，最后复核交付物'),
    new Date(baseTime).toISOString());
  insertEvent.run('rdmd_probe_plan_v2', chosen.task_run_id, firstNode.id, 'agent_plan', '砍掉第三步',
    planPayload(['拉原始表', '缺失值处理'], '时间不够，先交核心两步'),
    new Date(baseTime + 600_000).toISOString());
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* 事务可能已自行中止 */ }
  throw error;
}
report.steps.push({ step: 'injected_plan_events', taskNodeId: firstNode.id, events: 2 });

// --- 3. 用真实 store 方法做投影 ------------------------------------------------------
const store = new Store(db, { root: '' });
let projection = null;
let projectionError = '';
try {
  projection = store.projectTaskRunToCollaborationGraph(chosen.task_run_id, {
    type: 'task_node_updated', afterRevision: 0,
  });
} catch (error) {
  projectionError = `${error.name}: ${error.message}`;
}
report.steps.push({
  step: 'project', error: projectionError,
  planProjection: projection?.planProjection || null,
  changedNodes: projection?.changedNodes?.length ?? null,
  changedEdges: projection?.changedEdges?.length ?? null,
});

// --- 4. 图上的真实形状 ---------------------------------------------------------------
const graphId = projection?.graphId || '';
const nodesByKind = db.prepare('SELECT kind, depth, COUNT(*) AS n FROM collaboration_graph_nodes WHERE graph_id=? GROUP BY kind, depth ORDER BY depth')
  .all(graphId);
const edgesByKind = db.prepare('SELECT kind, COUNT(*) AS n FROM collaboration_graph_edges WHERE graph_id=? GROUP BY kind ORDER BY n DESC')
  .all(graphId);
const stepRows = db.prepare("SELECT node_id, title, status, public_summary FROM collaboration_graph_nodes WHERE graph_id=? AND kind='agent_step' ORDER BY title")
  .all(graphId);
report.graph = {
  graphId,
  nodesByKind: nodesByKind.map((row) => ({ kind: row.kind, depth: row.depth, n: row.n })),
  edgesByKind: edgesByKind.map((row) => ({ kind: row.kind, n: row.n })),
  // 这是「step 层真实字段填充率」的实测值（计划 P0 观测的交付物之一）：
  // 只要 title 与 status 有值、public_summary 恒空，就证明 v2 的 step 档取值是对的。
  stepNodes: stepRows.map((row) => ({ title: row.title, status: row.status,
    summaryEmpty: row.public_summary === '' })),
};

// --- 5. 闸门 -------------------------------------------------------------------------
let reader = null;
let readerError = '';
try {
  reader = store.readPlanExecGraphs({ taskRunId: chosen.task_run_id, skipAuthorization: true });
} catch (error) {
  readerError = `${error.name}: ${error.message}`;
}
report.gate = {
  error: readerError,
  planNodes: reader?.plan?.nodes?.length ?? null,
  execNodes: reader?.exec?.nodes?.length ?? null,
  gaps: reader?.gaps ?? null,
  gapSummary: reader?.gapSummary ?? null,
  passes: Array.isArray(reader?.gaps) ? reader.gaps.length === 0 : null,
  planSteps: (reader?.plan?.nodes || []).filter((node) => node.kind === 'agent_step')
    .map((node) => ({ title: node.title, status: node.status })),
  execSteps: (reader?.exec?.nodes || []).filter((node) => node.kind === 'agent_step')
    .map((node) => ({ title: node.title, status: node.status })),
  // 度量与模型契约分开报：度量今天就该能跑。
  metric: reader?.metric ?? null,
};

console.log(JSON.stringify(report, null, 2));
db.close();
