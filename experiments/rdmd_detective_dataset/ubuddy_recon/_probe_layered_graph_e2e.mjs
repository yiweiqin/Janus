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
const { migrateDatabase } = await import('../../../src/main/modules/persistence/infrastructure/sqliteMigrations.js');
const db = new DatabaseSync(DB_PATH);

// --- 0. 在副本上跑真实迁移，把 collaboration_graph_* 建出来 ------------------------
// 这一步是**必须**的，而且它原来漏了：文件头写着"在副本上跑真实迁移"，代码里却没有
// 任何迁移调用，于是 `collaboration_graph_*` 始终不存在、`projectTaskRunToCollaborationGraph`
// 抛进 `projectionError`、紧接着那句 `SELECT ... FROM collaboration_graph_nodes` 直接
// 硬失败（`no such table`）。也就是说这个探针**从来没有真正跑到过投影那一步**。
//
// `migrateDatabase` 是桌面端自己的入口（`sqliteMigrations.js:517`），它里面第 553 行
// 就是无条件调用 `ensureUBuddyCollaborationGraphSchema(db)` —— 这正是活库里缺的那一段。
// 在**副本**上跑它，等价于"用户装了一个含该迁移的构建并重启桌面端"。
const before = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collaboration_graph%'`).all();
migrateDatabase(db);
const after = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collaboration_graph%'`).all();
report.steps.push({
  step: 'migrate_on_snapshot',
  tablesBefore: before.map((r) => r.name),
  tablesAfter: after.map((r) => r.name),
  created: after.length - before.length,
});

// --- 1. 找一个能撑起四层图的真实 task run -------------------------------------------
// 条件：有 task node（agent_task 层的来源）、有 delegation（ubuddy 层的来源）。
//
// 新增一列 `plan_event_count`：活库里**已经**有真实 plan 事件了（见文件头更正），
// 所以优先挑一个自带真实 plan 事件的 run —— 那就不需要注入，验证的直接就是真数据。
const candidates = db.prepare(`
  SELECT tr.id AS task_run_id, tr.title, tr.status,
         (SELECT COUNT(*) FROM task_nodes tn WHERE tn.task_run_id = tr.id) AS node_count,
         (SELECT COUNT(*) FROM task_events te
           WHERE te.task_run_id = tr.id
             AND json_extract(te.payload_json,'$.activityType') = 'plan'
             AND json_extract(te.payload_json,'$.plan') IS NOT NULL) AS plan_event_count,
         coalesce(json_extract(tr.metadata_json,'$.delegationId'),'') AS delegation_id,
         coalesce(json_extract(tr.metadata_json,'$.collaborationGroupId'),'') AS group_id
  FROM task_runs tr
  ORDER BY (plan_event_count > 0) DESC, node_count DESC, tr.created_at DESC
`).all();
report.steps.push({
  step: 'candidates',
  taskRuns: candidates.length,
  rows: candidates.map((row) => ({
    taskRunId: row.task_run_id, nodes: row.node_count, status: row.status,
    planEvents: row.plan_event_count,
    delegationId: row.delegation_id, groupId: row.group_id,
  })),
});

const chosen = candidates.find((row) => row.node_count > 0 && row.delegation_id && row.plan_event_count > 1)
  || candidates.find((row) => row.node_count > 0 && row.plan_event_count > 1)
  || candidates.find((row) => row.node_count > 0 && row.delegation_id)
  || candidates.find((row) => row.node_count > 0);
if (!chosen) {
  console.log(JSON.stringify({ ...report, error: 'no task run with task nodes' }, null, 2));
  process.exit(1);
}
report.chosen = { taskRunId: chosen.task_run_id, title: chosen.title, nodes: chosen.node_count,
  planEvents: chosen.plan_event_count, delegationId: chosen.delegation_id, groupId: chosen.group_id };

// --- 2. plan 事件：真实优先，没有才注入 ----------------------------------------------
// 真实事件存在时**一律用真实的**：注入的载荷再像也终究是我写的，
// 而这一段要回答的恰恰是"真实形状的载荷能不能走通"。
const realPlanRows = db.prepare(`
  SELECT id, task_node_id, payload_json, created_at FROM task_events
  WHERE task_run_id = ?
    AND json_extract(payload_json,'$.activityType') = 'plan'
    AND json_extract(payload_json,'$.plan') IS NOT NULL
  ORDER BY created_at`).all(chosen.task_run_id);

let planTargetNodeId = '';
let planEventSource = '';

if (realPlanRows.length > 1) {
  // 取真实事件最多的那个 task node，这样"首版 vs 后续版本"的折叠在一批真数据上发生。
  const byNode = new Map();
  for (const row of realPlanRows) {
    const list = byNode.get(row.task_node_id) || [];
    list.push(row);
    byNode.set(row.task_node_id, list);
  }
  const best = [...byNode.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  planTargetNodeId = best[0];
  planEventSource = `real (${best[1].length} events on node ${best[0]})`;
  report.steps.push({
    step: 'plan_events',
    source: planEventSource,
    totalForRun: realPlanRows.length,
    nodesWithPlans: byNode.size,
    revisionChain: best[1].map((row) => ({
      createdAt: row.created_at,
      stepCount: (JSON.parse(row.payload_json).plan || []).length,
    })),
  });
} else {
  // 退路：这个 run 没有真实 plan 事件，按真实形状注入（形状取自
  // uBuddyAgentPlanSteps.js#normalizeAgentPlanStep：`step` 是 label 的来源）。
  //
  // 两次更新：首版 3 步；第二版只剩 2 步 -> 第 3 步会被 foldAgentPlanEvents 标成 cancelled，
  // 这正是 G_plan（首版，3 步）与 G_exec（最终，2 步 + 1 cancelled）在 step 层的唯一漂移。
  const firstNode = db.prepare('SELECT id, title, agent_id FROM task_nodes WHERE task_run_id = ? ORDER BY created_at LIMIT 1')
    .get(chosen.task_run_id);
  if (!firstNode) {
    console.log(JSON.stringify({ ...report, error: 'chosen run has no task node row' }, null, 2));
    process.exit(1);
  }
  planTargetNodeId = firstNode.id;
  planEventSource = 'injected (no real plan events on this run)';

  const insertEvent = db.prepare(`
    INSERT INTO task_events (id, task_run_id, task_node_id, event_type, summary, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const planPayload = (steps, explanation) => JSON.stringify({
    activityType: 'plan', status: 'running', title: 'Codex 执行计划', detail: explanation,
    plan: steps.map((label, index) => ({ step: label, status: 'pending', index })),
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
  report.steps.push({ step: 'plan_events', source: planEventSource, injected: 2 });
}
report.planTarget = { taskNodeId: planTargetNodeId, source: planEventSource };

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

// --- 5b. 闸门豁免试算（**只测量，不改契约**）------------------------------------------
// 实测：v2 闸门在真实数据上唯一过不去的东西，是 exec 侧 `agent_task` 缺 `output`，
// 而那两个节点的 status 都是 `cancelled` —— 一个被取消的任务**本来就没有交付文本**，
// 这份「缺口」不是投影坏了、也不是数据没到，是它永远不会到。
//
// 契约自己的分类里没有这一格：`summarizePlanExecGaps` 的注释把 agent_task 缺 output
// 解释成「没有执行结果」（该等结果），但 cancelled 的结果永远等不到。
//
// 所以下面按「终止负向状态豁免 outcome 字段」试算一次，回答一个**可判定**的问题：
// 这条规则是不是把闸门归零的充分且最小的改动？
//
// 刻意只在这个探针里算，**不写进契约**：改必需集要 JS 与
// `deploy/rdmd_detective.py#required_fields_for_kind` 同步改、要 bump
// `PLAN_EXEC_CONTRACT_VERSION`，而版本号已经写进已完成任务的
// `cloud_rdmd_inference_jobs.contract_version`（全是 `ubuddy_plan_exec_v2`）——
// 一次未经验证的 bump 会让 v4 刚刚拿到的真机证据失效。先测量，再决定。
const TERMINAL_NEGATIVE = new Set(['cancelled', 'failed']);
const statusBySideAndId = new Map();
for (const [side, graph] of [['plan', reader?.plan], ['exec', reader?.exec]]) {
  for (const node of (graph?.nodes || [])) statusBySideAndId.set(`${side}|${node.id}`, node.status || '');
}
const gapsWithStatus = (reader?.gaps || []).map((gap) => ({
  ...gap,
  status: statusBySideAndId.get(`${gap.side}|${gap.nodeId}`) || '',
}));
const waived = gapsWithStatus.filter(
  (gap) => gap.field === 'output' && TERMINAL_NEGATIVE.has(gap.status),
);
const remaining = gapsWithStatus.filter(
  (gap) => !(gap.field === 'output' && TERMINAL_NEGATIVE.has(gap.status)),
);
report.gateWaiverDryRun = {
  note: '只试算；契约与投影一行未改',
  waiveRule: 'exec 侧 agent_task 的 output，在 status ∈ {cancelled, failed} 时不判缺',
  gapsBefore: gapsWithStatus.length,
  gapsWaived: waived.length,
  gapsAfter: remaining.length,
  waivedDetail: waived.map((gap) => ({ nodeId: gap.nodeId, field: gap.field, kind: gap.kind, side: gap.side, status: gap.status })),
  remainingDetail: remaining.map((gap) => ({ nodeId: gap.nodeId, field: gap.field, kind: gap.kind, side: gap.side, status: gap.status })),
  wouldPass: remaining.length === 0,
  // 两侧**所有**节点的 kind/status 分布：免得「终止负向」这个集合是我拍脑袋定的，
  // 也让下次有人想问「还有哪些状态会缺 output」时能直接看出来。
  nodeStatusDistribution: (() => {
    const counts = new Map();
    for (const [side, graph] of [['plan', reader?.plan], ['exec', reader?.exec]]) {
      for (const node of (graph?.nodes || [])) {
        const key = `${side}/${node.kind || '?'}/${node.status || '(空)'}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return [...counts.entries()].sort().map(([key, n]) => `${key} ×${n}`);
  })(),
};

console.log(JSON.stringify(report, null, 2));
db.close();
