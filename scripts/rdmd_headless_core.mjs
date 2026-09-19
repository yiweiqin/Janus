/**
 * 无头桌面内核：证明「我们自己的那条链」去掉 Electron 也成立。
 *
 * ## 这个脚本要回答什么
 *
 * `src/main/runtime.js:1239-1250` 里，漂移诊断是这样被触发的：
 *
 *   if (['completed','failed','cancelled'].includes(task.status))
 *     queueMicrotask(() => planExecDrift.record({ task }))
 *
 * 这一句在 Electron 的 runtime 里。于是有一个很容易得出的结论：「不装桌面构建，
 * 这条链就跑不起来」。**这个结论是错的**，但错得不明显 —— 因为链上的每一段
 * 单独看都像是"要桌面端"：
 *
 *   - `openDatabase` / `migrateDatabase` 在 `src/main/` 下，看起来是桌面专属；
 *   - 协作图投影只在 `scheduler.js` 与 delegation 运行时里被调用；
 *   - `planExecDrift.record()` 只被 runtime 调。
 *
 * 实测不是：`src/main` 下**只有 `src/main/main.js:64` 一处** `require('electron')`，
 * 而这条链上的所有文件（db / store / sqliteMigrations / collaborationGraphStoreMethods /
 * planExecDriftService）都是纯 Node。
 *
 * ## 所以这个脚本做的事，是把两段**已经各自跑绿**的东西接起来
 *
 * 一段在 `experiments/rdmd_detective_dataset/ubuddy_recon/_probe_layered_graph_e2e.mjs`：
 * 跑真 `migrateDatabase` + 真 `Store` + 灌 plan 事件 + `projectTaskRunToCollaborationGraph`
 * + `readPlanExecGraphs`。它止步于"读到了图"。
 *
 * 一段在 `src/main/modules/collaboration/application/planExecDriftShadow.test.js`：
 * 真 SQLite + 真 `createPlanExecDriftService.record()`，但它把 `readPlanExecGraphs`
 * **换成了替身**（造一张真协作图需要整套投影写入，当时没有）。
 *
 * 这里两段都用原件，一处替身都不留。两段之间缺的那一跳，正是本脚本要断言的东西。
 *
 * ## 断言（写死在这里，不是"打印出来给人看"）
 *
 *   A1. 投影真的产出了四层图：`root` / `agent_task` / `agent_step` 三类节点都在，
 *       且 step 层带 `sequence_of` 链。
 *   A2. `readPlanExecGraphs` 真的读出了 `G_plan` 与 `G_exec`，且**两者不同**
 *       （首版 3 步 vs 最终 2 步 + 1 cancelled）。两者相同就说明 plan 事件没被折。
 *   A3. `record()` 的返回值 `status !== 'no_graph'` —— 这是"读到了图"与"没读到"的分界。
 *   A4. `store.listTaskEvents(taskRunId)` 里真的出现了 `eventType: 'rdmd_plan_exec_drift'`。
 *       这是整件事的终点：诊断真的落了库。
 *   A5. **`record()` 没有碰过协作图**（三张表的行数与内容签名，在投影之后与 `record()`
 *       之后完全一致）。这条是 `planExecDriftShadow.test.js` 的核心不变量，在真图上再验一次。
 *   A6. 同一批 plan 事件**重投影是空操作**（`appliedNodes/Edges` 都是 0，图签名不变）。
 *       不幂等的话，"样本在积累"会变成"节点在膨胀"。
 *
 * 为什么 A4 不能只看返回值：`persist()` 把 `recordTaskEvent` 包在 try/catch 里、
 * 失败只 `logger.warn`。返回值是对的、库里什么都没有 —— 这种失败**没有症状**。
 * 所以必须回读。
 *
 * 为什么 A5 的基线取在**投影之后**：建图、加节点、推 revision 正是投影的工作，
 * 拿投影之前当基线等于断言"投影什么都没干"。真正要守的不变量是 `record()` 只读图。
 *
 * ## 用法
 *
 *   node scripts/rdmd_headless_core.mjs                        # 临时新库（默认）
 *   node scripts/rdmd_headless_core.mjs --db <janus.db 副本>    # 已有快照
 *   node scripts/rdmd_headless_core.mjs --out report.json       # 落报告
 *   node scripts/rdmd_headless_core.mjs --keep                  # 保留临时库便于复查
 *   node scripts/rdmd_headless_core.mjs --emit-case case.json   # 把 case 交给工作流 A
 *
 * `--db` 那条路会**在快照上跑迁移**（原地修改那个文件），所以只给副本。
 * 这和 `_probe_layered_graph_e2e.mjs` 的口径一致。
 *
 * `--keep` 只在临时新库那条路上有意义（快照模式的目录是调用方的，永不删）。
 *
 * 事件 id 全部是确定性的（`rdmd_headless:*`），所以重跑同一套输入是幂等的。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** 模拟任务群的固定身份。用固定 id 才能让重跑幂等（`recordTaskEvent` 按 eventId upsert）。 */
export const HEADLESS_TASK_RUN_ID = 'rdmd_headless_run_1';
export const HEADLESS_GROUP_ID = 'rdmd_headless_group_1';

/**
 * 两条 plan 事件落在**同一个** task node 上，这是 revision 折叠的前提：
 * 首版 3 步 → 第二版砍掉第 3 步。`foldAgentPlanEvents` 会把被砍的步骤标成 `cancelled`，
 * 于是 G_plan（首版）与 G_exec（最终，2 步 + 1 cancelled）在 step 层产生**唯一**的漂移。
 *
 * 形状取自产品自己的消费点（`uBuddyAgentPlanSteps.js#normalizeAgentPlanStep`）：
 * `step` 是 label 的来源，`status` 走归一化（`pending` → `queued`）。
 */
const PLAN_V1 = ['拉取 2023-2025 线上份额原始表', '缺失值处理与口径对齐', '交付物复核'];
const PLAN_V2 = ['拉取 2023-2025 线上份额原始表', '缺失值处理与口径对齐'];

const planPayload = (steps, detail) => ({
  activityType: 'plan',
  status: 'running',
  title: 'Codex 执行计划',
  detail,
  plan: steps.map((step, index) => ({ step, status: 'pending', index })),
});

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((token) => token.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  return fallback;
}

// ---------------------------------------------------------------------------
// 开库：两条路，别混
// ---------------------------------------------------------------------------

/**
 * - **空/新库**：`openDatabase(root, { skipMigrationBackup: true })`。基础 schema 在建库时
 *   落地，迁移随后跟上（`db.js:84` 之后 `:87`）。这是"一台没装过桌面的机器"的形状。
 * - **已有快照**：`new DatabaseSync(path)` + `migrateDatabase(db)`。注意 `migrateDatabase`
 *   会对很多表做 `PRAGMA table_info`，**不能指向一个无关的空 SQLite 文件** —— 那样迁移会
 *   以为自己该建的是另一套东西。所以只喂真的 janus.db 副本。
 */
async function openTarget({ dbPath = '' } = {}) {
  if (dbPath) {
    const absolute = resolve(dbPath);
    const { migrateDatabase } = await import('../src/main/modules/persistence/infrastructure/sqliteMigrations.js');
    const db = new DatabaseSync(absolute);
    const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collaboration_graph%'").all();
    migrateDatabase(db);
    const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collaboration_graph%'").all();
    return {
      db, mode: 'snapshot', dbPath: absolute, root: dirname(absolute),
      // snapshot 模式**只关连接**：那个文件是调用方的，删了就是删用户的数据。
      cleanup: () => { try { db.close(); } catch { /* 已关 */ } },
      migrate: { tablesBefore: before.map((row) => row.name), tablesAfter: after.map((row) => row.name), created: after.length - before.length },
    };
  }
  const { openDatabase } = await import('../src/main/db.js');
  const root = mkdtempSync(join(tmpdir(), 'janus-rdmd-headless-'));
  // `openDatabase` 一步就把基础 schema 与迁移都跑完了（`db.js:84` 建表、`:87` 迁移）。
  const db = openDatabase(root, { skipMigrationBackup: true });
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collaboration_graph%'").all();
  return {
    db, mode: 'fresh', dbPath: join(root, 'data', 'janus.db'), root,
    // 先关连接再删目录（Windows 上句柄没放开就删不掉）。`--keep` 时留着给人复查。
    // 这里必须真的删：每次跑都 `mkdtempSync` 一个新目录，不删就是在 `/tmp` 里堆垃圾
    // —— 而 `cleanup` 如果只是"关连接"，`--keep` 也就成了一个什么都没保留的开关。
    cleanup: ({ keep = false } = {}) => {
      try { db.close(); } catch { /* 已关 */ }
      if (!keep) { try { rmSync(root, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
    },
    migrate: { tablesBefore: [], tablesAfter: after.map((row) => row.name), created: after.length,
      note: 'openDatabase 一步就把基础 schema 与迁移都跑完了' },
  };
}

// ---------------------------------------------------------------------------
// 灌一条模拟群任务
// ---------------------------------------------------------------------------

/**
 * 建 task run + 两个 task node（后者依赖前者），再灌三条 plan 事件。
 *
 * 为什么是两条 run 级的 plan 事件而不是一条：`buildPlanExecGraphs` 的 plan 侧取
 * `firstAgentPlan`（**首版**），exec 侧取最终折叠结果。只灌一条的话两侧必然相同，
 * A2 就永远发现不了"plan 事件没被折"这个 bug。
 *
 * **幂等**：`createTaskNode` 的 id 是自动生成的（没有 providedId），所以重跑同一个
 * `--db` 快照会不断追加重复节点 —— 节点数一路涨、图上多出一堆同名 `agent_task`，
 * 而报告里看不出这是"跑了两遍"还是"真的有两个节点"。这里先按标题复用已有节点。
 * 事件侧本来就幂等（`recordTaskEvent` 按 eventId upsert）。
 */
function seedTaskRun(store) {
  const existing = store.getTaskRun(HEADLESS_TASK_RUN_ID);
  const created = existing || store.createTaskRun({
    id: HEADLESS_TASK_RUN_ID,
    title: '消费电子份额·2023-2025 国内手机线上份额汇报',
    prompt: '汇总 2023-2025 年国内手机线上渠道份额，产出可交付的汇报材料。',
    ownerUserId: 'headless_owner',
    leadAgentId: 'coordinator_agent',
    departmentId: '',
    // 落在协作组上：`planExecTaskFamily` 的 anchor 取 groupId > delegationId > taskRunId，
    // 只给 taskRunId 的族是 `degenerate` 的（下一轮同类任务必然换族，样本永远不积累）。
    metadata: { collaborationGroupId: HEADLESS_GROUP_ID, objective: { summary: '线上份额汇报' } },
    deferAgentInstanceBinding: true,
  });
  const taskRunId = String(created?.id || HEADLESS_TASK_RUN_ID);
  const reused = Boolean(existing);
  const byTitle = new Map((created?.nodes || []).map((node) => [String(node.title || ''), node]));
  const ensureNode = (spec) => byTitle.get(spec.title) || store.createTaskNode({
    taskRunId, ...spec, deferAgentInstanceBinding: true,
  });

  const research = ensureNode({
    title: '份额数据整理', objective: '拉取并清洗原始份额表',
    agentId: 'research_agent', status: 'completed', outputFormat: 'markdown',
  });
  const writing = ensureNode({
    title: '汇报文案', objective: '把份额结论写成汇报文案',
    agentId: 'writing_agent', status: 'cancelled', dependencies: [research.id],
    outputFormat: 'markdown',
  });

  const recordPlan = (eventId, taskNodeId, steps, detail) => store.recordTaskEvent({
    eventId, taskRunId, taskNodeId, eventType: 'node_activity',
    actorId: 'research_agent', summary: 'Codex 执行计划',
    payload: planPayload(steps, detail),
  });

  // 同一个 node 上两条 → revision 折叠。id 用 `_v1` / `_v2` 保证 `created_at` 打平时
  // `listTaskEvents` 的 `id ASC` 兜底顺序仍然正确。
  recordPlan('rdmd_headless:plan:v1', research.id, PLAN_V1, '先取数再清洗，最后复核交付物');
  recordPlan('rdmd_headless:plan:v2', research.id, PLAN_V2, '时间不够，先交核心两步');
  recordPlan('rdmd_headless:plan:writing:v1', writing.id, ['按结论搭大纲', '写文案初稿'], '先大纲后成稿');

  store.updateTaskRunStatus(taskRunId, 'completed', '交付物已提交');
  return { taskRunId, reused, taskNodeIds: { research: research.id, writing: writing.id } };
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

function check(assertions, id, condition, detail = {}) {
  assertions.push({ id, ok: Boolean(condition), ...detail });
  return Boolean(condition);
}

function graphSignature(db) {
  return ['collaboration_graphs', 'collaboration_graph_nodes', 'collaboration_graph_edges', 'collaboration_graph_events']
    .map((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      return `${table}:${row.n}`;
    }).join('|');
}

/** 协作图节点的**内容**签名。只数行数不够：update 不改行数。 */
function graphContentDigest(db) {
  const rows = db.prepare(`
    SELECT node_id, kind, status, title, coalesce(public_summary,'') AS summary, source_revision
    FROM collaboration_graph_nodes ORDER BY node_id`).all();
  return JSON.stringify(rows);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runHeadlessCore({ dbPath = '', keep = false, emitCase = '' } = {}) {
  const report = {
    schema: 'rdmd_headless_core_v1',
    generatedAt: new Date().toISOString(),
    note: '无头内核：真迁移 + 真投影 + 真读取 + 真 record()，一处替身都不留',
    steps: [],
    assertions: [],
  };

  const target = await openTarget({ dbPath });
  report.db = { mode: target.mode, path: target.dbPath, migrate: target.migrate };

  try {
    const { Store } = await import('../src/main/store.js');
    const { createPlanExecDriftService } = await import('../src/main/modules/collaboration/application/planExecDriftService.js');
    const store = new Store(target.db, { root: target.root });

    // --- 1. 灌模拟群任务 ---
    const seeded = seedTaskRun(store);
    report.seeded = seeded;
    report.steps.push({ step: 'seed', taskRunId: seeded.taskRunId, taskNodeIds: seeded.taskNodeIds });

    // --- 2. 投影四层图（真方法，走 projectAgentPlanSteps） ---
    // 注意：投影**本来就会**建图、加节点、推 revision —— 那是它的工作。
    // 所以"图没被动过"这条不变量只能量在**投影之后、record() 之前**，
    // 量的对象是 `record()`：诊断与影子都不许改图（`planExecDriftShadow.test.js` 的核心）。
    const projection = store.projectTaskRunToCollaborationGraph(seeded.taskRunId, { type: 'node_running', afterRevision: 0 });
    if (!projection) throw new Error('projection_returned_null');
    const graphId = String(projection.graphId || '');
    report.graphId = graphId;
    report.steps.push({ step: 'project', graphId, planProjection: projection.planProjection || null,
      changedNodes: projection.changedNodes?.length ?? null, changedEdges: projection.changedEdges?.length ?? null });

    // 投影产出的图，作为"record() 之前"的基线。
    const graphBefore = graphSignature(target.db);
    const contentBefore = graphContentDigest(target.db);

    // --- 2b. 幂等：同一批 plan 事件再投影一次，必须什么都不动 ---
    //
    // 这条不是形式主义。`planExecDriftService.record()` 每次终态都会跑一遍读图、
    // 模拟群任务会一轮接一轮地落同一批事件；如果重投影会重复建 `agent_step` 或
    // 推 revision，那"样本在积累"就会变成"节点在膨胀"，图上再也数不出真实步数。
    // 第一次投影 `appliedNodes: 5`，第二次必须是 `0` —— 这就是幂等的判据。
    const reprojection = store.projectTaskRunToCollaborationGraph(seeded.taskRunId, { type: 'node_running', afterRevision: 0 });
    const reprojectNoop = Number(reprojection?.planProjection?.appliedNodes || 0) === 0
      && Number(reprojection?.planProjection?.appliedEdges || 0) === 0
      && graphBefore === graphSignature(target.db)
      && contentBefore === graphContentDigest(target.db);
    report.reprojection = {
      appliedNodes: reprojection?.planProjection?.appliedNodes ?? null,
      appliedEdges: reprojection?.planProjection?.appliedEdges ?? null,
      graphUnchanged: graphBefore === graphSignature(target.db),
    };
    check(report.assertions, 'A6_reprojection_is_a_noop', reprojectNoop, report.reprojection);

    const nodesByKind = target.db.prepare(
      'SELECT kind, depth, COUNT(*) AS n FROM collaboration_graph_nodes WHERE graph_id=? GROUP BY kind, depth ORDER BY depth').all(graphId);
    const edgesByKind = target.db.prepare(
      'SELECT kind, COUNT(*) AS n FROM collaboration_graph_edges WHERE graph_id=? GROUP BY kind ORDER BY n DESC').all(graphId);
    const stepRows = target.db.prepare(
      "SELECT title, status FROM collaboration_graph_nodes WHERE graph_id=? AND kind='agent_step' ORDER BY title").all(graphId);
    report.graph = {
      nodesByKind: nodesByKind.map((row) => ({ kind: row.kind, depth: row.depth, n: row.n })),
      edgesByKind: edgesByKind.map((row) => ({ kind: row.kind, n: row.n })),
      stepNodes: stepRows.map((row) => ({ title: row.title, status: row.status })),
    };

    const kinds = new Set(nodesByKind.map((row) => row.kind));
    check(report.assertions, 'A1_four_layer_projection',
      kinds.has('root') && kinds.has('agent_task') && kinds.has('agent_step')
        && edgesByKind.some((row) => row.kind === 'sequence_of'),
      { kinds: [...kinds], edgeKinds: edgesByKind.map((row) => row.kind) });

    // --- 3. 读回 G_plan / G_exec（真读取） ---
    const read = store.readPlanExecGraphs({ taskRunId: seeded.taskRunId, viewerUserId: 'headless_owner', skipAuthorization: true });
    const stepsOf = (graph) => (graph?.nodes || []).filter((node) => node.kind === 'agent_step')
      .map((node) => ({ title: node.title, status: node.status })).sort((a, b) => String(a.title).localeCompare(String(b.title)));
    report.read = {
      hasRead: Boolean(read),
      graphRevision: read?.scope?.revision ?? null,
      graphId: read?.scope?.graphId ?? '',
      taskRunIds: read?.scope?.taskRunIds ?? [],
      taskFamilyAnchorKind: read?.scope?.groupId ? 'group' : (read?.scope?.delegationId ? 'delegation' : 'task_run'),
      planSteps: stepsOf(read?.plan),
      execSteps: stepsOf(read?.exec),
      gaps: read?.gaps ?? null,
      gapSummary: read?.gapSummary ?? null,
      metric: read?.metric ?? null,
      constants: read?.constants ?? null,
    };
    check(report.assertions, 'A2_read_gives_two_graphs',
      Boolean(read?.plan?.nodes?.length) && Boolean(read?.exec?.nodes?.length),
      { planNodes: read?.plan?.nodes?.length ?? 0, execNodes: read?.exec?.nodes?.length ?? 0 });
    check(report.assertions, 'A2b_plan_and_exec_actually_differ',
      JSON.stringify(report.read.planSteps) !== JSON.stringify(report.read.execSteps),
      { planSteps: report.read.planSteps, execSteps: report.read.execSteps });

    // --- 4. 真 service.record()：一处替身都不留 ---
    const service = createPlanExecDriftService({
      store,
      root: target.root,
      // 空 env = 桌面端默认状态：没有 RDMD_ADAPTER，所以不会起子进程。这正是我们要验的形状：
      // 判定不依赖模型也能落库，模型只是记录里的一段证据。
      env: {},
      // 两个能力位都打开：`planExecDrift` 是诊断的前提；`planExecDriftApply` 让我们顺便
      // 在真图上验一遍 apply 门（0 条观察 → 门不满足 → 停在 shadow，且**不写**先验）。
      featureFlags: { snapshot: () => ({ planExecDrift: true, planExecDriftApply: true }) },
    });
    const task = store.getTaskRun(seeded.taskRunId);
    const record = await service.record({ task });
    report.record = record ? {
      status: record.status,
      phase: record.phase,
      graphRevision: record.graphRevision,
      decision: record.decision,
      model: record.model,
      applyGate: record.applyGate,
      apply: record.apply,
      shadowProposal: record.shadow?.proposal
        ? { op: record.shadow.proposal.op, nodeId: record.shadow.proposal.nodeId, fields: record.shadow.proposal.fields, score: record.shadow.proposal.score }
        : null,
      taskFamilyId: record.taskFamilyId,
      contractVersion: record.contractVersion,
    } : null;

    check(report.assertions, 'A3_record_status_not_no_graph', record && record.status !== 'no_graph', { status: record?.status ?? null });

    // --- 5. 回读：事件真的落库了吗 ---
    const driftEvents = store.listTaskEvents(seeded.taskRunId).filter((event) => event.eventType === 'rdmd_plan_exec_drift');
    report.persisted = {
      driftEventCount: driftEvents.length,
      eventIds: driftEvents.map((event) => event.eventId),
      payloadPhase: driftEvents.map((event) => event.payload?.phase || ''),
      rawPayloadJsonRoundTrips: driftEvents.map((event) => Boolean(event.payload && typeof event.payload === 'object')),
    };
    // A4 是本脚本最重要的一条：`persist()` 失败只 warn，返回值照样是对的。
    check(report.assertions, 'A4_event_landed_in_task_events', driftEvents.length === 1,
      { count: driftEvents.length, ids: report.persisted.eventIds });

    // 顺手在**原始列**上验一次 camelCase 口径 —— 文档与报告脚本的 SQL 就是照这个写的。
    const rawRow = target.db.prepare(
      "SELECT json_extract(payload_json,'$.phase') AS phase, json_extract(payload_json,'$.status') AS status FROM task_events WHERE event_type='rdmd_plan_exec_drift'").get();
    report.persisted.rawColumns = rawRow ? { phase: rawRow.phase, status: rawRow.status } : null;
    check(report.assertions, 'A4b_raw_column_matches_api', Boolean(rawRow?.phase) && rawRow.phase === record?.phase,
      { raw: rawRow?.phase ?? null, api: record?.phase ?? null });

    // --- 6. 图没被动过 ---
    const contentAfter = graphContentDigest(target.db);
    report.graphMutation = {
      before: graphBefore,
      after: graphSignature(target.db),
      contentUnchanged: contentBefore === contentAfter,
    };
    // `apply` 阶段唯一允许的写是 task_events。这里用**结果**口径再验一次。
    check(report.assertions, 'A5_no_graph_mutation', contentBefore === contentAfter && graphBefore === report.graphMutation.after,
      { before: graphBefore, after: report.graphMutation.after });

    // --- 7. 交接：这条 case 要送进工作流 A 的同一通道 ---
    // 本脚本**不**发请求：云通道的可用性属于工作流 A（盒子侧），这里只保证
    // 「我们自己的代码能产出一条形状合法的 case」。所以把 case 原样交出去。
    //
    // `case` 必须真的**带出去**，而不是只在报告里写一句 `caseReady: true` ——
    // 后者是"我说它能跑"，前者才是工作流 A 能直接喂给 `buildRdmdCloudPayload` 的东西。
    report.handoff = {
      note: '工作流 A（experiments/sim_task_group）拿这条 case 走 privacy 白名单提交 /api/rdmd/jobs，与盒子判定对照',
      taskRunId: seeded.taskRunId,
      caseId: read?.case?.id ?? '',
      caseReady: Boolean(read?.case?.G_star && read?.case?.G_prime),
      gapsBlockingModel: (read?.gaps || []).length,
      privacyFieldsVersion: read?.constants?.version ?? '',
    };
    if (emitCase) {
      // 形状与 `planExecCase()` 一致，外加 gaps：工作流 A 要先看 gaps 决定这条能不能进模型
      // （`planExecContractGaps` 为空才可喂模型），所以它必须跟 case 一起走。
      writeFileSync(resolve(emitCase), `${JSON.stringify({
        schema: 'rdmd_plan_exec_case_v1',
        taskRunId: seeded.taskRunId,
        graphId,
        case: read?.case ?? null,
        gaps: read?.gaps ?? [],
        gapSummary: read?.gapSummary ?? null,
        constants: read?.constants ?? null,
      }, null, 2)}\n`, 'utf8');
      report.handoff.emitted = resolve(emitCase);
    }

    // `gaps.length !== 0` 是**正常**的：本脚本灌的模拟任务只有两个 task node、没有
    // taskGraphProposal，11 个必需字段里的组织层那几个必然缺。这份报告证明的是
    // 「我们自己的链在无 Electron 下走通并落库」，不是「这条 case 能喂模型」。
    // 把它写进报告，免得读报告的人以为 gaps 是 bug。
    report.handoffNote = 'case 可以喂模型的前提是 gaps 为空；模拟任务的 gaps 非空是预期的（缺组织层提案）';
  } finally {
    // `--keep` 只在 fresh 模式下有意义：它保留临时库让人去复查。
    // snapshot 模式永远只关连接，绝不删用户的文件。
    if (target.mode === 'fresh') {
      if (keep) report.tmpKept = target.root;
      target.cleanup({ keep });
    } else {
      target.cleanup();
    }
  }

  const failed = report.assertions.filter((item) => !item.ok);
  report.ok = failed.length === 0;
  report.failedAssertions = failed.map((item) => item.id);
  return report;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const out = arg('out', '');
  const report = await runHeadlessCore({ dbPath: arg('db', ''), keep: process.argv.includes('--keep'), emitCase: arg('emit-case', '') });
  const text = JSON.stringify(report, null, 2);
  if (out) {
    writeFileSync(resolve(out), `${text}\n`, 'utf8');
    console.log(JSON.stringify({ out: resolve(out), ok: report.ok, failed: report.failedAssertions,
      assertions: report.assertions.length, graphId: report.graphId, recordStatus: report.record?.status }, null, 2));
  } else {
    console.log(text);
  }
  // 断言失败必须非零退出：无头内核的价值全在"A4 真的落库了"这几条上，
  // 把它们降级成日志里的一行，等于这个脚本什么都没证明。
  if (!report.ok) process.exit(1);
}
