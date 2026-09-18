// 活体探针：真实 janus.db 里，「四层图的第四层（agent_step）」到底有没有底料。
//
// 为什么需要它：`_probe_task_events_plan.mjs` 只看 `activityType='plan'` 一个入口，报回
// 「0 条」，但 0 条有三种完全不同的解释，而它们指向完全不同的行动：
//
//   1. **app-server 从不发 `turn/plan/updated`** —— 那么 agent_step 这一层永远不会有底料，
//      值得投入的是 `agent_task` 层漂移与 `status` 通道，而不是四层图；
//   2. **发了但没落库**（`emitNativeActivity` / `standaloneProtocolActivity` 那条路被丢）
//      —— 那么是持久化层的 bug，修它就能拿到底料；
//   3. **落库了但被截断**（`boundedTaskProcessValue` 上限 12KB 会把 `plan` 换成
//      `{truncated:true,preview}`，于是 `normalizeAgentPlan` 返回 `supported:false`、
//      步骤数变 0）—— 那么是阈值问题，调大即可。
//
// 区分三者的唯一办法是**看旁证**：`plan` 的发现路径与 `goal` / `usage` / `model` /
// `reasoning` 完全同源（都在 `codex.js` 的 handleNotification 里走
// `standaloneProtocolActivity` → `emitNativeActivity` → task_events）。所以
// 「同源的兄弟 activityType 有行、只有 plan 没有」才能证明是解释 1；如果连兄弟都没有，
// 说明这条通道整个没落库（解释 2）；如果有行但载荷带 `truncated` 标记，就是解释 3。
//
// 用法：node _probe_agent_plan_live.mjs <janus.db>
// 只读打开，不改任何东西。
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error('usage: node _probe_agent_plan_live.mjs <janus.db>');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const q = (sql, params = []) => { try { return db.prepare(sql).all(...params); } catch { return []; } };
const one = (sql, params = []) => q(sql, params)[0] || null;
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const hasTable = (name) => Boolean(one("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", [name]));
const count = (name) => (hasTable(name) ? (one(`SELECT COUNT(*) AS n FROM ${ident(name)}`)?.n ?? 0) : null);

// `boundedTaskProcessValue` 的默认上限。载荷超过它就会被换成 {truncated,preview}。
const TRUNCATION_LIMIT = 12_000;

const report = {
  db: DB_PATH,
  // ---------------------------------------------------------------------
  // 1. 四层图的表在不在
  // ---------------------------------------------------------------------
  // 桌面端 SQLite 由 sqliteSchema.js / sqliteMigrations.js 建表；云端 PG 由 cloud/migrations
  // 的 094/095/096 建表。两边表名相同，但**不是同一个库**，所以这个探针必须把
  // 「表不存在」与「表存在但是 0 行」分开报 —— 这两件事的行动完全不同。
  collaborationGraph: {},
  // ---------------------------------------------------------------------
  // 2. plan 通道（唯一能把 agent_step 变成真实节点的来源）
  // ---------------------------------------------------------------------
  planChannel: {},
  rowCounts: {},
};

for (const table of ['collaboration_graphs', 'collaboration_graph_nodes',
  'collaboration_graph_edges', 'collaboration_graph_events']) {
  report.collaborationGraph[table] = { exists: hasTable(table), rows: count(table) };
}

for (const table of ['task_events', 'task_runs', 'task_nodes', 'task_graph_revisions',
  'task_node_result_versions', 'ubuddy_planning_sessions', 'ubuddy_planning_session_events',
  'collaboration_groups', 'agent_delegations']) {
  report.rowCounts[table] = count(table);
}

// --- plan 通道：同源兄弟 + plan 自己 -------------------------------------------------
{
  const activityTypes = q(`SELECT json_extract(payload_json,'$.activityType') AS activityType, COUNT(*) AS n
                           FROM task_events WHERE activityType IS NOT NULL
                           GROUP BY activityType ORDER BY n DESC`);
  const byName = Object.fromEntries(activityTypes.map((r) => [r.activityType, r.n]));

  // plan 的发现路径与这些 activityType 完全同源（都在 codex.js 的 handleNotification 里
  // 走 standaloneProtocolActivity）。它们是「这条通道整体还在不在」的对照组。
  const siblings = ['goal', 'usage', 'model', 'reasoning', 'sandbox', 'answer', 'artifact'];
  const presentSiblings = siblings.filter((name) => byName[name]);
  const missingSiblings = siblings.filter((name) => !byName[name]);

  const planRows = q(`SELECT id, task_run_id, task_node_id, event_type, created_at,
                             length(payload_json) AS payloadBytes
                      FROM task_events
                      WHERE activityType='plan' OR payload_json LIKE '%"plan"%'
                      ORDER BY created_at DESC LIMIT 50`);

  // 载荷长度：`plan` 一旦超过 12KB 就会被 boundedTaskProcessValue 换成
  // {truncated:true,preview}，于是 normalizeAgentPlan 拿不到步骤数组。
  const lengths = q(`SELECT length(payload_json) AS n FROM task_events
                     WHERE activityType='plan' OR payload_json LIKE '%"plan"%'`);
  const payloadStats = lengths.length
    ? { rows: lengths.length, min: Math.min(...lengths.map((r) => r.n)), max: Math.max(...lengths.map((r) => r.n)) }
    : { rows: 0, min: null, max: null };

  // 「被截断」这件事在库里的直接证据：payload 里出现 truncated 标记。
  const truncatedRows = one(`SELECT COUNT(*) AS n FROM task_events
                             WHERE payload_json LIKE '%"truncated":true%'`)?.n ?? 0;

  // 步骤数组形状：只有真正能喂 normalizeAgentPlan 的行才算底料。
  const stepShapes = new Map();
  let rowsWithSteps = 0;
  const planRowsFull = q(`SELECT id, task_node_id, payload_json FROM task_events
                          WHERE activityType='plan' ORDER BY created_at DESC LIMIT 50`);
  for (const row of planRowsFull) {
    let payload = null;
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { continue; }
    const steps = payload.plan;
    if (!Array.isArray(steps) || !steps.length) continue;
    rowsWithSteps += 1;
    const fields = [...new Set(steps.flatMap((s) => (s && typeof s === 'object' ? Object.keys(s) : [`<${typeof s}>`])))].sort();
    stepShapes.set(fields.join(','), (stepShapes.get(fields.join(',')) || 0) + 1);
  }

  report.planChannel = {
    activityTypes: byName,
    siblingsPresent: presentSiblings,
    siblingsMissing: missingSiblings,
    planRows: planRows.length,
    planRowsWithSteps: rowsWithSteps,
    planStepFieldShapes: Object.fromEntries(stepShapes),
    planOwningTaskNodes: [...new Set(planRows.map((r) => r.task_node_id).filter(Boolean))].slice(0, 20),
    planPayloadBytes: payloadStats,
    truncatedPayloadRows: truncatedRows,
    truncationLimit: TRUNCATION_LIMIT,
    // 12KB 以上的行有多少：只要有一行超限，就有理由怀疑解释 3。
    rowsOverTruncationLimit: one(
      `SELECT COUNT(*) AS n FROM task_events WHERE length(payload_json) > ?`, [TRUNCATION_LIMIT])?.n ?? 0,
    // planning session 侧（持续规划）也看一眼：它是 plan 的另一条落库通路。
    planningSessionEvents: count('ubuddy_planning_session_events'),
    planLikePlanningEvents: hasTable('ubuddy_planning_session_events')
      ? (one(`SELECT COUNT(*) AS n FROM ubuddy_planning_session_events
              WHERE event_type LIKE '%plan%' OR payload_json LIKE '%"plan"%'`)?.n ?? 0)
      : null,
  };
}

// --- agent_step 节点与 sequence_of 边 -------------------------------------------------
{
  const nodes = report.collaborationGraph['collaboration_graph_nodes'];
  const edges = report.collaborationGraph['collaboration_graph_edges'];
  const byKind = [];
  const byDepth = [];
  const fill = [];
  if (nodes.exists) {
    byKind.push(...q(`SELECT kind, COUNT(*) AS n FROM collaboration_graph_nodes GROUP BY kind ORDER BY n DESC`));
    byDepth.push(...q(`SELECT depth, COUNT(*) AS n FROM collaboration_graph_nodes GROUP BY depth ORDER BY 1`));
    // 按 kind 的真实字段填充率：这是契约分档（PLAN_EXEC_REQUIRED_FIELDS_BY_KIND）唯一的实测依据。
    fill.push(...q(`SELECT kind,
                             COUNT(*) AS nodes,
                             COUNT(*) FILTER (WHERE COALESCE(title,'')<>'')           AS title_filled,
                             COUNT(*) FILTER (WHERE COALESCE(public_summary,'')<>'')  AS summary_filled,
                             COUNT(*) FILTER (WHERE COALESCE(owner_agent_id,'')<>'')  AS agent_filled,
                             COUNT(*) FILTER (WHERE COALESCE(status,'')<>'')          AS status_filled,
                             COUNT(*) FILTER (WHERE COALESCE(public_metadata_json,'') NOT IN ('','{}')) AS metadata_filled
                      FROM collaboration_graph_nodes GROUP BY kind ORDER BY nodes DESC`));
  }
  const edgeKinds = edges.exists
    ? q(`SELECT kind, COUNT(*) AS n FROM collaboration_graph_edges GROUP BY kind ORDER BY n DESC`)
    : [];
  report.collaborationGraph.nodesByKind = byKind;
  report.collaborationGraph.nodesByDepth = byDepth;
  report.collaborationGraph.agentsStepNodes = byKind.find((r) => r.kind === 'agent_step')?.n ?? 0;
  report.collaborationGraph.sequenceOfEdges = edgeKinds.find((r) => r.kind === 'sequence_of')?.n ?? 0;
  report.collaborationGraph.edgesByKind = edgeKinds;
  report.collaborationGraph.fieldFillByKind = fill;
}

// --- 结论 -----------------------------------------------------------------------------
{
  const plan = report.planChannel;
  const graphTablesPresent = Object.values(report.collaborationGraph)
    .some((v) => v && typeof v === 'object' && v.exists === true);
  let verdict = 'no_plan_observed';
  let explanation = '';
  if (plan.planRowsWithSteps > 0) {
    verdict = 'plan_observed';
    explanation = `拿到 ${plan.planRowsWithSteps} 行带步骤数组的 plan 事件，四层图这一条路成立。`;
  } else if (plan.siblingsPresent.length >= 3) {
    explanation = `plan 的同源兄弟（${plan.siblingsPresent.join('/')}）都有行，说明 ` +
      'stdin 通知通道在落库；只有 plan 没有 ⇒ 当前配置下 app-server 没有发出 turn/plan/updated（解释 1）。' +
      '价值重心应转向 agent_task 层漂移与 status 通道，不要写适配器去补底料。';
  } else if (plan.rowsOverTruncationLimit > 0) {
    verdict = 'inconclusive_truncation';
    explanation = `有 ${plan.rowsOverTruncationLimit} 行载荷超过 ${TRUNCATION_LIMIT} 字节，` +
      '怀疑 boundedTaskProcessValue 把 plan 换成了 {truncated,preview}（解释 3）。需要看那些行的 activityType。';
  } else {
    explanation = `plan 的同源兄弟也几乎都没有行（${plan.siblingsPresent.length}/${plan.siblingsPresent.length +
      plan.siblingsMissing.length}），无法区分是「没发」还是「没落库」（解释 2），需要补日志。`;
  }
  report.verdict = {
    kind: verdict,
    explanation,
    graphTablesPresent,
    // 观测不到 plan 时，这一层就永远没有底料 —— 直接影响「值不值得继续投入四层图」。
    agentStepLayerHasMaterial: (report.collaborationGraph.agentsStepNodes ?? 0) > 0,
  };
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
