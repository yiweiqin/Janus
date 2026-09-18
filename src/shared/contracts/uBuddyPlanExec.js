// G_plan / G_exec 的产品侧读取契约。
//
// 语义定义见 experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md。
// 本模块**不做 IO**：调用方（store）把 collaboration graph 的行、每个 task run 的
// `metadata_json.taskGraphProposal`、以及 task_events 里的 plan 事件喂进来，这里只负责
// 「形状」和「规则」，所以可以脱离数据库单测。
//
// ## 为什么要出两份投影（11 字段 vs 公共记忆的 foundation）
//
// 模型输入契约（`deploy/rdmd_detective.py#NODE_FIELDS`）是 11 个字段，
// 而公共记忆契约（`uBuddyTaskPublicMemory.js#normalizeTaskGraph`）只保留 7 个。
// 两者不能互相代替：
//   - `planExecCase()` 出 11 字段 → 喂模型
//   - `planExecPublicMemory()` 出 `foundation.plan` / `foundation.exec` → 填那个「已定义但无人填」的槽
//
// ## kind 是第 12 个字段
//
// `kind`（root / ubuddy / agent_task / agent_step）**不在** 11 字段里，
// Python 侧 `public_graph` 会把它丢掉。但 JS 侧的「相近效果」度量
// （`uBuddyReverseDetective.js#planExecProximity`）要用它按层加权。
// 所以图上带 `kind`：对模型是无害的多余字段，对度量是承重字段。
//
// ## 边只按 `from->to` 认
//
// `uBuddyReverseDetective.js` 的 `edgeKey(edge)` 就是 `${from}->${to}`，边的 kind 与 id
// 都不参与度量。所以这里把边归一成 `{ id: '<from>-><to>', from, to }` 并**去重**：
// 一张图上同一对节点之间同时有 `parent_of` 和 `assigned_to` 是常态，
// 若放任两条同 id 的边存在，`drop_edge` 会一次删掉两条，度量也会重复计数。

import { stableCollaborationNodeId } from './uBuddyCollaborationGraph.js';

export const UBUDDY_PLAN_EXEC_VERSION = 'ubuddy_plan_exec_v1';

// 与 deploy/rdmd_detective.py#NODE_FIELDS 逐字一致。
//
// P2 把 `status` 加进这里（此前只有 11 个字段）。这一处改动同时做三件事，
// 而且是**结构性**同时生效，不靠人去两边各改一遍：
//   1. prompt 开始带节点的执行状态（`lib/sft.mjs#publicGraph` / Python `public_graph`）；
//   2. `planExecModelView` 开始把 status 交给契约判 —— 于是 agent_step 一档
//      自动从「只判 title」收紧成「title + status」（`planExecRequiredFieldsForKind`
//      的取值只从这张表里取，所以「声明了但看不见」的中间态不可能存在）；
//   3. `planExecDeferredRequiredFields()` 里的 step 条目清空。
export const PLAN_EXEC_NODE_FIELDS = Object.freeze([
  'id', 'title', 'role', 'agentId', 'version', 'acceptance',
  'artifact', 'stage', 'inputs', 'output', 'summary', 'status',
]);
export const PLAN_EXEC_EDGE_FIELDS = Object.freeze(['id', 'from', 'to']);

// 与 deploy/rdmd_detective.py#RICH_NODE_FIELDS 一致。
// 这五个字段在训练集上是 0/207356 的硬不变量。**v2 之后它们不再是 fail-closed 的闸门**
// （真实 uBuddy 节点上一个都没有来源，拿它们当闸门等于把整条链路恒关），
// 但它们仍是「模型相对规则基线的全部优势来自哪里」的记录，也是语料不变量的依据。
export const PLAN_EXEC_RICH_FIELDS = Object.freeze(['artifact', 'stage', 'inputs', 'output', 'summary']);

// 真实 uBuddy 数据上**没有语义来源**的字段，用常量而不是留空。
// 理由：Python 侧 `public_graph` 本来就会补这两个默认值
// （`version or "v1"`、`acceptance or "standard"`）。与其两边各补一次、
// 让 JS 度量看到的图和模型看到的图悄悄分叉，不如在源头就写死。
export const PLAN_EXEC_CONSTANTS = Object.freeze({ version: 'v1', acceptance: 'standard' });

// 11 字段逐个的来源强度：UBUDDY_RECON.zh-CN.md 第 6 节结论的代码化。
// 调用方不许声称比这张表更强的可用性。
export const PLAN_EXEC_FIELD_SOURCES = Object.freeze({
  id: 'direct',                       // collaboration_graph_nodes.node_id
  title: 'direct',                    // collaboration_graph_nodes.title
  role: 'missing',                    // 只有 kind，不是角色名
  agentId: 'direct',                  // collaboration_graph_nodes.owner_agent_id
  version: 'constant',                // source_revision 是修订计数，不是语义版本
  acceptance: 'constant',             // 无对应列
  artifact: 'missing',                // 无对应列
  stage: 'missing',                   // 无对应列（depth 语义不同）
  inputs: 'missing',                  // 无对应列
  output: 'task_nodes.result_text',   // task_node_result_versions.result_text 的同源列
  summary: 'direct',                  // collaboration_graph_nodes.public_summary
  // status 不在模型的 11 字段里，但它是 collaboration_graph_nodes 的真实列，
  // 而且是 agent 层漂移**唯一**的可观测信号（projectAgentPlanSteps 把被砍掉的 step 标成
  // cancelled，于是 G_plan 与 G_exec 的差异恰好落在 status 上）。见 v2 的准入规则。
  status: 'direct',                   // collaboration_graph_nodes.status
});

// ---------------------------------------------------------------------------
// 分层契约 v2：必需字段按 kind 分
// ---------------------------------------------------------------------------
//
// v1 的判据是「每个节点 5 个富文本全非空」一刀切。它在语料上是 0/207356 的硬不变量，
// 但在真实 uBuddy 数据上**永远不可能满足**：真实节点只有 id/title/agentId/status，
// 那 5 个字段一个都没有来源。于是整条链路恒定 fail-closed 到 record_only ——
// 守卫本身没错，是它守错了地方：拿「富文本语料」的判据去判「窄字段的真实图」。
//
// v2 把判据按 kind 分级，而且**取值不是口味**，由两条准入规则算出来：
//
//   (a) `PLAN_EXEC_FIELD_SOURCES` 里该字段对该层有真实来源，且不是
//       `missing`（无来源）/ `constant`（常量，如 step 的 version='v1'）/
//       `inherited`（继承自父节点，见下）；
//   (b) 该字段对模型**可见**（在 `PLAN_EXEC_NODE_FIELDS` 里）—— 契约不能要求一个
//       模型读不到的东西，那种守卫只会把合法输入判死。
//
// `inherited` 是 v2 新加的一类：`agent_step.agentId` 就是 `ownerAgentId = parent.agentId`
// （plan 侧与 exec 侧逐行确认过）。它有值、也有来源，但**不携带该层自己的信号** ——
// 父节点没变它就一定不变。把这种字段收进必需集，会做出一个「看起来通过、实际什么都没验证」
// 的假契约，比没有契约更糟。
//
// 推出来的结论：只有 `title` / `status` 在 step 层同时满足 (a)(b)；`artifact`/`stage`/`inputs`
// 在**任何**层都是 `missing`，所以不再出现在任何必需集里。
export const PLAN_EXEC_CONTRACT_VERSION = 'ubuddy_plan_exec_v2';

export const PLAN_EXEC_REQUIRED_FIELDS_BY_KIND = Object.freeze({
  root: Object.freeze(['title']),
  ubuddy: Object.freeze(['title']),
  // output ← task_nodes.result_text，summary ← public_summary，title ← title：三个都有真实来源。
  agent_task: Object.freeze(['title', 'summary', 'output']),
  // status 是 step 层唯一真正的漂移信号（被砍掉的 step 会被 projectAgentPlanSteps 标成
  // cancelled），但它要等 P2 与两侧 prompt 一起进可见集。写在这里的是 v4 的**完整意图**；
  // 真正生效的集合还要过一遍可见性（见 planExecRequiredFieldsForKind）。
  agent_step: Object.freeze(['title', 'status']),
});

// ---------------------------------------------------------------------------
// 准入规则 (c)：字段还分**哪一侧**写得出来
// ---------------------------------------------------------------------------
//
// 两条准入规则 (a)(b) 只说了「这个字段在这一层有没有独立来源」和「模型看不看得见」，
// 但真实投影里还有第三个维度：**G_plan 与 G_prime 的字段来源不一样**。
//
// 规划图的两个来源是：
//   - `proposalNodesFromTaskRun`（collaborationGraphStoreMethods.js:639）：提案节点只带
//     `localId` / `title` / `agentId` / `dependencies`；
//   - 首版 plan step（`turn/plan/updated`）：只有 `label` 与 `status`。
// 两者都**没有 outcome 文本**。执行图才有：`summary ← public_summary`
// （`publicTaskNodeSummary`）、`output ← task_nodes.result_text`。
//
// 所以在规划侧要求 `summary`/`output`，就是要求一个那一侧的投影写不出的字段 ——
// 后果不是「更严」，而是**每一个真实群任务都恒 fail-closed**：每个提案节点稳定产生
// 两条缺口（G_star: summary、G_star: output），产品路径永远出不了 record_only。
// 实测见 ubuddy_recon/_probe_real_gate.mjs。
//
// 语义上也说得通：规划图是**意图**（谁、做什么、什么顺序），执行图是**结果**（真的产出了什么）。
// 两者本来就不该在 outcome 文本上对称。
export const PLAN_EXEC_SIDES = Object.freeze(['plan', 'exec']);

export const PLAN_EXEC_FIELD_SIDES = Object.freeze({
  // 执行侧独有：publicTaskNodeSummary 与 task_nodes.result_text 都只在执行投影里写。
  summary: Object.freeze(['exec']),
  output: Object.freeze(['exec']),
  title: Object.freeze(['plan', 'exec']),
  agentId: Object.freeze(['plan', 'exec']),
  role: Object.freeze(['plan', 'exec']),
  version: Object.freeze(['plan', 'exec']),
  acceptance: Object.freeze(['plan', 'exec']),
  status: Object.freeze(['plan', 'exec']),
  artifact: Object.freeze(['plan', 'exec']),
  stage: Object.freeze(['plan', 'exec']),
  inputs: Object.freeze(['plan', 'exec']),
});

/** 某一侧（plan / exec）的合法取值；非法值按最严的 exec 处理，不静默放宽。 */
export function planExecSide(value) {
  return PLAN_EXEC_FIELD_SIDES.title.includes(text(value, 16)) ? text(value, 16) : 'exec';
}

/** 该字段在该侧有没有来源（准入规则 (c)）。未登记的字段按「两侧都有」处理。 */
export function planExecFieldExistsOnSide(field, side) {
  const sides = PLAN_EXEC_FIELD_SIDES[field];
  if (!sides) return true;
  return sides.includes(planExecSide(side));
}

/**
 * 声明必需集（v4 的完整意图，可能包含尚未对模型可见的字段）。
 *
 * 不要直接拿它当闸门 —— 用 `planExecRequiredFieldsForKind`。
 */
export function planExecDeclaredRequiredFields(kind, side = 'exec') {
  const key = text(kind, 40);
  const declared = PLAN_EXEC_REQUIRED_FIELDS_BY_KIND[key]
    || PLAN_EXEC_REQUIRED_FIELDS_BY_KIND[PLAN_EXEC_CONTRACT_FALLBACK_KIND];
  // 准入规则 (c)：规划侧写不出的字段不进规划侧的必需集。
  return declared.filter((field) => planExecFieldExistsOnSide(field, side));
}

/**
 * **生效**必需集 = 声明必需集 ∩ 模型可见字段 ∩ 该侧写得出的字段。
 *
 * 准入规则 (b) 在这里被**结构性**保证，而不是靠注释和自觉：判据不可能要求一个模型读不到的
 * 字段，因为取不到。(c) 同理：不可能要求一侧投影写不出的字段。
 * P2 把 `status` 加进 `PLAN_EXEC_NODE_FIELDS` 时，step 一档会自动从「只判 title」收紧成
 * 「title + status」—— 一处改动，两侧同时生效，中间不存在
 * 「契约要求了一个看不见的字段」那种既不该通过也不该拒绝的状态。
 */
export function planExecRequiredFieldsForKind(kind, side = 'exec') {
  return planExecDeclaredRequiredFields(kind, side).filter((field) => PLAN_EXEC_NODE_FIELDS.includes(field));
}

/**
 * 声明了、但因为对模型不可见而**暂时不生效**的必需字段，按 `侧/kind` 列出。
 *
 * 存在的意义是让「故意延后」可见：过滤本身是安全的，但如果不把它报出来，
 * 一个忘记同步 prompt 的人会以为 step 层已经在判 status 了。
 */
export function planExecDeferredRequiredFields() {
  const deferred = {};
  for (const side of PLAN_EXEC_SIDES) {
    for (const kind of Object.keys(PLAN_EXEC_REQUIRED_FIELDS_BY_KIND)) {
      const pending = planExecDeclaredRequiredFields(kind, side)
        .filter((field) => !PLAN_EXEC_NODE_FIELDS.includes(field));
      if (pending.length) deferred[`${side}/${kind}`] = pending;
    }
  }
  return deferred;
}

// kind 缺失时按**最严**一档判，不静默放宽。
// 旧平铺图的节点没有 kind，它们语义上就是 agent_task，所以这个回退既最严也最贴切。
export const PLAN_EXEC_CONTRACT_FALLBACK_KIND = 'agent_task';

// 某一层上「有值、但不是该层独立信号」的字段 —— 准入规则 (a) 里的 inherited。
export const PLAN_EXEC_INHERITED_FIELDS_BY_KIND = Object.freeze({
  agent_step: Object.freeze([
    'agentId', 'role', 'version', 'acceptance', 'artifact', 'stage', 'inputs', 'output', 'summary',
  ]),
});

/**
 * 该字段在该层是不是「独立且有来源」的信号 —— 准入规则 (a) 的代码化。
 *
 * 存在的意义是让必需字段表**可复核**：有人想把 `artifact` 加进 agent_task 的必需集时，
 * 自检用例会立刻失败，而不是等上线后拿真实数据才发现那个字段永远为空。
 *
 * 注意这里**不**判可见性：那是 (b)，由 `planExecRequiredFieldsForKind` 结构性保证。
 * 两条规则分开判，出问题时才分得清是「没有来源」还是「没同步 prompt」。
 */
export function planExecFieldIsIndependent(kind, field, side = 'exec') {
  const key = text(kind, 40) || PLAN_EXEC_CONTRACT_FALLBACK_KIND;
  const source = PLAN_EXEC_FIELD_SOURCES[field] || 'missing';
  if (source === 'missing' || source === 'constant') return false;
  if (!planExecFieldExistsOnSide(field, side)) return false;
  return !(PLAN_EXEC_INHERITED_FIELDS_BY_KIND[key] || []).includes(field);
}

/**
 * 模型真正看到的那一份节点。**契约只能在它上面判**。
 *
 * 这是整个 v2 的结构性保证：判据不可能越过 prompt 的可见范围去要求一个字段，
 * 因为取值只从 `PLAN_EXEC_NODE_FIELDS` 里取。P2 把 `status` 加进那个列表时，
 * step 层会自动从「恒 fail-closed」变成「可判」—— 一处改动，两侧同时生效。
 */
export function planExecModelView(node = {}) {
  const source = objectValue(node);
  const view = {};
  for (const field of PLAN_EXEC_NODE_FIELDS) view[field] = source[field];
  return view;
}

// JS 侧度量需要的字段。**全都在真实数据上可得** —— 这是本模块最重要的区分：
// 「相近效果」度量与「改一处即停」今天就能在真实 uBuddy 数据上跑，
// 而模型调用必须 fail-closed 到 record_only，直到那几个 missing 有来源。
export const PLAN_EXEC_METRIC_FIELDS = Object.freeze([
  'id', 'title', 'agentId', 'version', 'acceptance', 'role', 'kind',
]);

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

export function normalizePlanExecNode(value = {}) {
  const source = objectValue(value);
  const node = {
    id: text(source.id || source.nodeId, 80),
    title: text(source.title, 240),
    role: text(source.role, 80),
    agentId: text(source.agentId, 160) || 'agent',
    version: text(source.version, 80) || PLAN_EXEC_CONSTANTS.version,
    acceptance: text(source.acceptance, 80) || PLAN_EXEC_CONSTANTS.acceptance,
    artifact: text(source.artifact, 240),
    stage: text(source.stage, 80),
    inputs: text(source.inputs, 600),
    output: text(source.output, 600),
    summary: text(source.summary, 600),
  };
  const kind = text(source.kind, 40);
  if (kind) node.kind = kind;
  const status = text(source.status, 40);
  if (status) node.status = status;
  return node;
}

export function normalizePlanExecGraph(value = {}) {
  const source = objectValue(value);
  const nodes = [];
  const seenNodeIds = new Set();
  for (const raw of array(source.nodes)) {
    const node = normalizePlanExecNode(raw);
    if (!node.id || seenNodeIds.has(node.id)) continue;
    seenNodeIds.add(node.id);
    nodes.push(node);
  }
  const edges = [];
  const seenEdgeKeys = new Set();
  for (const raw of array(source.edges)) {
    const edge = objectValue(raw);
    const from = text(edge.from || edge.fromNodeId, 80);
    const to = text(edge.to || edge.toNodeId, 80);
    // 端点不存在的边与自环都丢掉：它们进不了任何一张真实图，留着只会制造假漂移。
    if (!from || !to || from === to || !seenNodeIds.has(from) || !seenNodeIds.has(to)) continue;
    const key = `${from}->${to}`;
    if (seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    edges.push({ id: key, from, to });
  }
  return { nodes, edges };
}

/** 模型输入的一条 case：`{ id, G_star: 规划图, G_prime: 执行图 }`。 */
export function planExecCase({ id = '', plan = {}, exec = {} } = {}) {
  return {
    id: text(id, 160),
    G_star: normalizePlanExecGraph(plan),
    G_prime: normalizePlanExecGraph(exec),
  };
}

/**
 * 这条 case 是否落在训练支持集内。空数组 = 可以推理。
 *
 * 与 `deploy/rdmd_detective.py#check_case_contract` 同一判据：**按 kind 取必需集**，
 * 且只在模型看得见的字段上判（`planExecModelView`）。返回结构化的问题列表而不只是字符串 ——
 * 调用方要能按字段、按层汇报「缺哪几个」，否则 fail-closed 就退化成一句「不能跑」。
 */
export function planExecContractGaps(caseValue = {}) {
  const gaps = [];
  // graphKey 是 case 里的字段名（G_star/G_prime），side 决定用哪一份必需集。
  for (const [name, side] of [['G_star', 'plan'], ['G_prime', 'exec']]) {
    const graph = normalizePlanExecGraph(objectValue(caseValue)[name]);
    if (!graph.nodes.length) {
      gaps.push({ graph: name, nodeId: '', field: 'nodes', kind: '', side });
      continue;
    }
    for (const node of graph.nodes) {
      const kind = text(node.kind, 40) || PLAN_EXEC_CONTRACT_FALLBACK_KIND;
      const view = planExecModelView(node);
      for (const field of planExecRequiredFieldsForKind(kind, side)) {
        if (!view[field]) gaps.push({ graph: name, nodeId: node.id, field, kind, side });
      }
    }
  }
  return gaps;
}

/**
 * 按字段与按层汇总缺口，便于写进 record_only 的说明。
 *
 * `byKind` 是 v2 加的：缺口分布在不同层上时，「补什么」的答案完全不同
 * （step 层缺 status 是投影问题，agent_task 层缺 output 是没有执行结果），
 * 只看 byField 两个场景长得一模一样。
 *
 * `bySide` 是 v2 的 (c) 加上的：规划侧与执行侧的来源不同，所以「缺在哪一侧」直接决定
 * 是「该补投影」还是「该等结果」。混在一起看会把「规划侧本来就写不出 output」
 * 误报成「这条任务缺数据」。
 */
export function summarizePlanExecGaps(gaps = []) {
  const byField = {};
  const byKind = {};
  const bySide = {};
  for (const gap of array(gaps)) {
    byField[gap.field] = (byField[gap.field] || 0) + 1;
    const kind = gap.kind || PLAN_EXEC_CONTRACT_FALLBACK_KIND;
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (gap.side) bySide[gap.side] = (bySide[gap.side] || 0) + 1;
  }
  return {
    total: array(gaps).length,
    byField,
    byKind,
    bySide,
    emptyRichFieldCount: array(gaps).filter((gap) => PLAN_EXEC_RICH_FIELDS.includes(gap.field)).length,
  };
}

/**
 * 「相近效果」度量能不能跑。
 *
 * 与模型契约无关：度量只读 7 个字段 + 边，真实数据上全都有。
 * 单独给一个判定，是为了让调用方**不要**把「模型不能跑」误报成「度量不能跑」——
 * 这两件事的可用性差别很大，混在一起会让人以为整条链路都废了。
 */
export function planExecMetricReadiness(plan = {}, exec = {}) {
  const missing = [];
  for (const [name, graph] of [['G_star', normalizePlanExecGraph(plan)], ['G_prime', normalizePlanExecGraph(exec)]]) {
    if (!graph.nodes.length) missing.push({ graph: name, nodeId: '', field: 'nodes' });
  }
  return { ready: missing.length === 0, missing };
}

/** 同一份图 → 公共记忆契约的 foundation 槽（那个「已定义但无人填」的位置）。 */
export function planExecPublicMemory({ taskId = '', ownerUserId = '', participantUserIds = [], plan = {}, exec = {} } = {}) {
  return {
    version: UBUDDY_PLAN_EXEC_VERSION,
    taskId: text(taskId, 160),
    ownerUserId: text(ownerUserId, 160),
    participantUserIds: unique(participantUserIds),
    foundation: { plan: normalizePlanExecGraph(plan), exec: normalizePlanExecGraph(exec) },
    elevation: [],
    raw: [],
  };
}

// ---------------------------------------------------------------------------
// 组图：graph 行 + proposal + 首版 plan 事件 -> (G_plan, G_exec)
// ---------------------------------------------------------------------------

/**
 * 组织层的连接键是 **title**，不是 localId。
 *
 * planner 的 `localId` 从来没有落库到 `task_nodes`（sqliteSchema 里没有这一列），
 * scheduler 只是 `title: node.title` 原样搬过去。所以提案节点与真实节点之间唯一稳定的
 * 连接就是 title。这不是偷懒，是现有数据的物理上限 —— 也正因为如此，下面把
 * 「提案里有、执行里没有」当成**真漂移**（规划了但从未发生），而不是当匹配失败丢掉。
 *
 * @param {{graphNodes?: Array, graphEdges?: Array,
 *          proposalNodesByTaskRun?: Record<string, Array>,
 *          firstPlanStepsByTaskNode?: Record<string, Array>,
 *          resultTextByTaskNode?: Record<string, string>}} input
 */
export function buildPlanExecGraphs({
  graphNodes = [],
  graphEdges = [],
  proposalNodesByTaskRun = {},
  firstPlanStepsByTaskNode = {},
  resultTextByTaskNode = {},
} = {}) {
  const execNodes = [];
  const planNodes = [];
  const planEdges = [];
  const graphNodeById = new Map();
  const taskNodeIdByGraphNodeId = new Map();

  for (const raw of array(graphNodes)) {
    const node = objectValue(raw);
    const id = text(node.nodeId || node.id, 80);
    if (!id || graphNodeById.has(id)) continue;
    graphNodeById.set(id, node);
    execNodes.push(execNodeOf(node, resultTextByTaskNode));
    const taskNodeId = text(node.taskNodeId, 120);
    if (text(node.kind, 40) === 'agent_task' && taskNodeId) taskNodeIdByGraphNodeId.set(id, taskNodeId);
  }

  // 容器层（root / ubuddy）在两张图上**完全一致**。容器本身不携带归因信息
  // （planExecProximity 给它们的权重是 1/2，工作单元是 4），
  // 让它们漂移只会往 involvedNodeIds 里灌噪声。
  for (const raw of array(graphNodes)) {
    const kind = text(objectValue(raw).kind, 40);
    if (kind === 'agent_task' || kind === 'agent_step') continue;
    const node = execNodes.find((item) => item.id === text(objectValue(raw).nodeId || objectValue(raw).id, 80));
    if (node) planNodes.push({ ...node });
  }

  // 组织层规划：每个 task run 的提案节点，按 title 匹配到真实 agent_task 节点。
  const planNodeIdByTaskRunLocal = new Map();
  const matchedExecNodeIds = new Set();
  const unmatchedProposalNodes = [];
  const proposalByTaskRun = objectValue(proposalNodesByTaskRun);
  for (const [taskRunId, proposalNodes] of Object.entries(proposalByTaskRun)) {
    const localIds = new Map();
    planNodeIdByTaskRunLocal.set(taskRunId, localIds);
    for (const raw of array(proposalNodes)) {
      const localId = text(objectValue(raw).localId, 80);
      if (!localId) continue;
      const title = text(objectValue(raw).title, 240);
      const match = execNodes.find((item) => (
        item.kind === 'agent_task' && !matchedExecNodeIds.has(item.id) && title && item.title === title
      ));
      const nodeId = match?.id || `plan:${taskRunId}:${localId}`;
      localIds.set(localId, nodeId);
      if (match) matchedExecNodeIds.add(match.id);
      else unmatchedProposalNodes.push({ taskRunId, localId, title });
      planNodes.push(normalizePlanExecNode({
        id: nodeId,
        title: title || localId,
        agentId: text(objectValue(raw).agentId, 160),
        kind: 'agent_task',
        status: match?.status || 'planned',
      }));
    }
  }

  // agent 层规划：每个 task node 的**首版** plan step。
  // id 公式与 `projectAgentPlanSteps` 完全一致（stableCollaborationNodeId('agent_step', `${taskNodeId}:${index}`)），
  // 所以规划的第 N 步和执行的第 N 步是同一个节点 id ——
  // 否则「第 3 步被砍掉」会被度量看成「加了一个节点 + 删了一个节点」两处漂移。
  const stepsByTaskNode = objectValue(firstPlanStepsByTaskNode);
  for (const [graphNodeId, taskNodeId] of taskNodeIdByGraphNodeId) {
    const steps = array(stepsByTaskNode[taskNodeId]);
    if (!steps.length) continue;
    let previousStepNodeId = '';
    for (const raw of steps) {
      const stepNodeId = planStepNodeId(taskNodeId, Number(objectValue(raw).index || 0));
      planNodes.push(normalizePlanExecNode({
        id: stepNodeId,
        title: text(objectValue(raw).label, 240),
        agentId: text(graphNodeById.get(graphNodeId)?.ownerAgentId, 160),
        kind: 'agent_step',
        status: text(objectValue(raw).status, 40),
      }));
      if (previousStepNodeId) {
        planEdges.push({ from: previousStepNodeId, to: stepNodeId });
      }
      previousStepNodeId = stepNodeId;
    }
  }

  // 边。
  // - 容器/归属类（parent_of / delegates_to / assigned_to）：两端都在规划图里时才保留。
  // - 依赖与顺序（dependency_of / sequence_of）**执行图独有**：
  //   规划图的依赖必须来自提案（下面那段），顺序必须来自首版 plan。
  //   若这里照抄执行图的依赖，最有价值的 missing_dependency 漂移就会被掩盖，那就白做了。
  // - 协调（coordinates_with）：现实里才发生的，天然只在执行图上 → 体现为 add_edge 漂移。这是对的。
  const planNodeIds = new Set(planNodes.map((node) => node.id));
  const REBUILT_KINDS = new Set(['dependency_of', 'sequence_of', 'coordinates_with']);
  for (const raw of array(graphEdges)) {
    const edge = objectValue(raw);
    const kind = text(edge.kind, 40);
    const from = text(edge.fromNodeId || edge.from, 80);
    const to = text(edge.toNodeId || edge.to, 80);
    if (!from || !to || from === to) continue;
    if (REBUILT_KINDS.has(kind)) continue;
    if (planNodeIds.has(from) && planNodeIds.has(to)) planEdges.push({ from, to });
  }
  for (const [taskRunId, localIds] of planNodeIdByTaskRunLocal) {
    for (const raw of array(proposalByTaskRun[taskRunId])) {
      const to = text(localIds.get(text(objectValue(raw).localId, 80)), 80);
      if (!to) continue;
      for (const dependency of array(objectValue(raw).dependencies)) {
        const from = text(localIds.get(text(dependency, 80)), 80);
        if (!from || from === to) continue;
        planEdges.push({ from, to });
      }
    }
  }

  return {
    version: UBUDDY_PLAN_EXEC_VERSION,
    plan: normalizePlanExecGraph({ nodes: planNodes, edges: planEdges }),
    exec: normalizePlanExecGraph({ nodes: execNodes, edges: array(graphEdges) }),
    mapping: {
      matchedTaskNodeCount: matchedExecNodeIds.size,
      // 规划了但从未发生：drop_node 候选，也是「规划图改一处」的合法目标。
      unmatchedProposalNodes,
      // 执行里多出来的 agent_task（retry / fallback 造出来的）：add_node 候选。
      execExtraTaskNodeIds: execNodes
        .filter((node) => node.kind === 'agent_task' && !matchedExecNodeIds.has(node.id))
        .map((node) => node.id),
      comparedFields: PLAN_EXEC_METRIC_FIELDS,
      // 组织层的连接键。写出来是为了让「匹配不上」可归因，而不是看起来像 bug。
      organizationalJoinKey: 'title',
    },
  };
}

/** 与 `projectAgentPlanSteps` 使用同一个 id 公式。 */
export function planStepNodeId(taskNodeId, index) {
  return stableCollaborationNodeId('agent_step', `${text(taskNodeId, 120)}:${Number(index) || 0}`);
}

function execNodeOf(node, resultTextByTaskNode) {
  const kind = text(node.kind, 40);
  const taskNodeId = text(node.taskNodeId, 120);
  const resultText = taskNodeId ? text(objectValue(resultTextByTaskNode)[taskNodeId], 600) : '';
  return normalizePlanExecNode({
    id: text(node.nodeId || node.id, 80),
    title: text(node.title, 240),
    agentId: text(node.ownerAgentId, 160),
    kind,
    status: text(node.status, 40),
    // summary ← public_summary：唯一被设计成「可以公开读」的富文本。
    summary: text(node.publicSummary, 600),
    // output ← 执行结果。agent_step 没有独立结果列，而且 scheduler 的公开投影刻意
    // 不带 plan step 文本，所以只有 agent_task 这一层拿得到。
    output: kind === 'agent_task' ? resultText : '',
  });
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(value) {
  return [...new Set(array(value).map((item) => text(item)).filter(Boolean))];
}

function text(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
