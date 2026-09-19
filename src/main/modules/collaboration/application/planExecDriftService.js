// 反向侦探模型（RDMD）与 uBuddy 之间的接线层。
//
// 这一层只做四件事，别的一概不做：
//   1. 进程边界：把一条 case 送进 `deploy/predict.py`，把判定拿回来；
//   2. 真值判定：只有**成功收口**的 run 才是真值（见 ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md）；
//   3. 守卫：输入落在训练支持集外时，不许进模型；
//   4. 路由：判定交给 `routeEvolution`，产出 `record_only` / `minimal_plan_edit` / `similar_swap`。
//
// 它**不改任何图**。本阶段的产物是一条诊断事件（`task_events` 里一行），
// 不是一次自动改图 —— 理由见下面「为什么这一版只记录」。
//
// ---------------------------------------------------------------------------
// 为什么是「文件进文件出」的子进程，而不是常驻服务
// ---------------------------------------------------------------------------
//
// `deploy/predict.py` 是批处理 CLI：`--input <path> --output <path>`，退出码
// 0/1/2 分别表示「全部有效」「存在 invalid 判定」「输入或环境错误」。没有服务模式，
// 也没有 stdin 通路（`read_cases(Path(args.input))` 只认路径）。所以要选一种形态：
//
//   - 常驻 Python 进程放着一个加载了 LoRA 的 8B 模型 = 桌面端永远占着几 GB 显存；
//   - 每次调用冷启动一次 Python + 加载权重 = 一次要几十秒；
//   - 子进程 + 单 case 临时文件 = 接受加载开销，但显存不常驻，且「模型不可用」
//     退化成一次可控的超时，而不是产品起不来。
//
// 之所以能接受这个开销：调用点是**任务终态**，一个 task run 至多一次，
// 不是每次工具调用一次。低频 + 高价值，这是子进程形态的合理区间。
//
// ---------------------------------------------------------------------------
// 进程边界：三态通道
// ---------------------------------------------------------------------------
//
//   cloud       —— 生产。桌面端把（**已过隐私白名单**的）case 提交给云 API，由云侧作业
//                  队列 + GPU 盒上的出站 worker 产出判定（见 cloud/src/modules/rdmd/）。
//   local_spawn —— 离线 / 开发。今天的实现：起一个 python 子进程跑 predict.py。
//   none        —— 什么都没有。判定不可用，动作恒为 record_only。
//
// 为什么必须是"三态"而不是"有没有 adapter"：云通道下，**桌面端没有 adapter、没有
// predict.py、没有 GPU**。用 `RDMD_ADAPTER` 存不存在来判可用性，会把生产路径判成不可用。
// 反过来说，云通道可用时本地那几个字段一个都不该被读 —— 它们是 local_spawn 的属性。
//
// 优先级：显式 `RDMD_TRANSPORT` > 云可用 > 本地可用 > none。
// **云不可用不会自动回退到本地（反之亦然）**：回退会让"这条判定出自哪个模型"变得
// 看不出来，而出处恰恰是本阶段要保证的东西。换通道必须显式换。
//
// ---------------------------------------------------------------------------
// fail-closed：任何不确定都退化成 record_only
// ---------------------------------------------------------------------------
//
//   1. 契约守卫判定输入落在训练支持集外（缺富文本字段）。这正是 predict.py 里
//      `input_contract_violation:` 那条路：模型会拿空字段给出一个**自信的**答案，
//      而那个答案不再代表任何已测得的准确率（INTEGRATION.zh-CN.md 第 3 节）。
//   2. 没配 `RDMD_ADAPTER` / `RDMD_BASE_MODEL`（本地通道的默认状态：桌面端没有 GPU）。
//   3. 子进程超时 / 非零退出 / 输出缺失 / 输出无法解析。
//   4. 模型自己给了 `valid:false`（含节点幻觉：`nodeId_not_in_graph`）。
//   5. 判定里的 `type` 不在 `RDMD_DRIFT_TYPES` 里。这条是 JS 侧自己加的防线：
//      `routeEvolution` 对未知 type 是**兜底成** `minimal_plan_edit`，
//      所以不在这里拦，一个概念外的 type 会变成一次改图动作。
//   6. 云通道：没登录（`cloud_auth_required`）、连不上、HTTP 报错、轮询到 deadline 仍无
//      终态判定（`cloud_verdict_timeout`）、云侧回 `not_eligible`（隐私边界拒绝）、
//      或判定本身是 `UNKNOWN`。**一条都不许变成"那就本地跑一个吧"**。
//
// **不回退到 `detectMinimalDrift`。** 按用户要求，规则检测器不作为产品候选路径。
// 「模型不能用」的正确含义是「这一轮不产出动作」，而不是「换一个更弱的检测器悄悄顶上」。
// 所以下面每一条失败路径都产出 `record_only`，并且把原因写清楚。
//
// ---------------------------------------------------------------------------
// 为什么这一版只记录
// ---------------------------------------------------------------------------
//
// 因为底料还没被观测到。`agent_step` 节点与 `sequence_of` 链是本轮才进图的
// （`projectAgentPlanSteps`）。
//
// 更正（2026-09-19）：这里原来写的是「本地真实库上 `activityType='plan'` 的事件数目前是 0
// —— 也就是说这条链路一次都没有在真实数据上跑过」。**那句话是错的**，它是被一个探针 bug
// 误导的结论：`_probe_task_events_plan.mjs` 在 WHERE 里用了 SELECT 别名
// （`WHERE activityType = 'plan'`），SQLite 直接抛 `no such column: activityType`，
// 而探针的 `q()` 把异常吞成 `[]` —— 于是「查询写错了」被读成了「数据里没有」。
//
// 实测（`C:\Users\zhang\.janus-test\data\janus.db`，只读）：`payload.activityType='plan'`
// 的事件有 **6 条 / 25 个 step**，落在 3 个 task run 上，生产者是 `codex/codex_app_server`，
// step 形状恰好是 `{step, status}`（status ∈ completed / inProgress / pending）。
// `agentPlanEventsFromTaskEvents` 的判据（`activityType === 'plan' && plan !== undefined`）
// 对这批数据**成立**，`normalizeAgentPlan` 也吃得下（`step` → label，`status` 归一化）。
//
// 所以真正挡着这条链路的是**发布缺口**，不是数据缺口：已安装构建的 `app.asar` 里
// 没有 `ensureUBuddyCollaborationGraphSchema` / `collaboration_graph_nodes`
// / `collaborationGraphStoreMethods`（同一个 asar 里 `ensureUBuddyCoordinationContractV2`
// 是有的，而活库也确实记录了 `ubuddy_coordination_contract_v2` 却没记录
// `ubuddy_collaboration_graph_v1` —— 两边对得上）。见
// `experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md` §11。
//
// 结论没变、理由变了：底料**依然没有被观测到**（表不存在 → 一次都没物化过），
// 但缺的是「装一个含该迁移的构建」，不是「等数据长出来」。
//
// 所以本阶段的契约是：**度量与归因必须落库，动作一律 record_only**。
// 记录里同时保留「模型怎么说」与「JS 度量怎么算」，两者的差值就是下一轮重训要看的。
// 动作开关留给 `planExecDrift` 之后的第二个 flag（`ubuddy_plan_exec_drift_apply`），
// 在真实底料被观测到之后再谈。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  RDMD_DRIFT_TYPES,
  RDMD_PROXIMITY_DEFAULTS,
  minimalPlanEdits,
  planExecProximity,
  routeEvolution,
} from '../../../../shared/contracts/uBuddyReverseDetective.js';

export const RDMD_PLAN_EXEC_RECORD_VERSION = 'rdmd_plan_exec_drift_v1';

/**
 * 推理通道。见文件头「进程边界：三态通道」。
 * 顺序即优先级（显式 `RDMD_TRANSPORT` 之外，云 > 本地 > 无）。
 */
export const RDMD_TRANSPORTS = Object.freeze(['cloud', 'local_spawn', 'none']);

/**
 * 动作侧的阶梯。三级，**默认停在最低一级**：
 *
 *   `record_only` —— 能力位关着。今天的产品行为，一字不变。
 *   `shadow`      —— 能力位开着，但**度量门不满足**。记提案、记真实后续，不改图。
 *   `apply`       —— 能力位开着 **且** 度量门满足。把提案落成"下一轮规划的先验"。
 *
 * 为什么 `'apply'` 现在可以出现在这个数组里（P5 时它被刻意排除在外）：
 * 那时唯一的门是"能力位"，而能力位是个开关 —— 常量的存在与否就是全部防线。
 * 现在多了一道**度量门**，而且是在这里**代码上**判的（`shadowApplyGate`）：
 * 没有足够多、足够一致的已观察提案，`resolveDriftPhase` 就产不出 `apply`。
 * 所以"能走到 apply"仍然不是一个靠文档约定的性质，而是没有输入能满足它的性质。
 *
 * 但要说清这一版的真实状态：**真实环境里 apply 依旧不可达**，因为
 * `SHADOW_MIN_OBSERVATIONS` 是 30、而真实已观察提案数是 **0**（底料一次都没被观测到，
 * 见 PLAN_EXEC_TRUTH §12.7）。闭环接好且**可证被闸住**，这是预期结果。
 */
export const RDMD_ACTION_PHASES = Object.freeze(['record_only', 'shadow', 'apply']);

// 影子"后续"事件。**单独一种事件类型**，不去改写原记录：
// 原记录说的是"我在 T 时刻提了什么"，后续说的是"T2 时刻图变成了什么样"。
// 两件事各有各的时间戳，合并进一行会让"这条提案当时说了什么"变成可变的。
export const RDMD_SHADOW_FOLLOWUP_EVENT = 'rdmd_plan_exec_drift_followup';

// apply 阶段唯一写出来的东西：**下一轮规划的"先验"**，不是一次改图。
//
// 它是一行事件（与这个文件里其它产物一致），按**任务族**取 id，所以下一轮同类任务
// 在规划时能按族把它读出来。刻意不复用 `rdmd_plan_exec_drift`：那条记录的语义是
// "我诊断到了什么"，可以被反复 upsert；而"我因此建议下一轮怎么改"是另一个事实，
// 混进同一行会让"这条诊断当时说了什么"随动作阶段变化而变。
export const RDMD_PLAN_PRIOR_EVENT = 'rdmd_plan_exec_drift_plan_prior';

/**
 * 能力位 + 度量门 → `record.phase`。**纯函数**。
 *
 *   applyEnabled=false                     → `record_only`（今天的产品行为）
 *   applyEnabled=true, gate 不满足/没给     → `shadow`
 *   applyEnabled=true, gate.met === true    → `apply`
 *
 * `applyGate` 缺省、为 `null`、或任何非 `{met:true}` 的形状都**退化成 `shadow`**。
 * 这是 fail-closed 的关键：调用方忘记算度量、算错了、或者将来有人"顺手"传个
 * `true` 进来，都只会停在影子阶段，而不是直接去改用户的规划。
 */
export function resolveDriftPhase({ applyEnabled = false, applyGate = null } = {}) {
  if (!applyEnabled) return 'record_only';
  return applyGate?.met === true ? 'apply' : 'shadow';
}

/**
 * 影子提案：把 JS 度量给出的那**一处**最小改动记成一条不会被执行的提案。
 *
 * 为什么要连目标值一起记：只记「改 n_step 的 agentId」在事后无法回答"它想改成什么"，
 * 也就无法判断"现实后来是不是走到了那里"。度量的一致性全靠这个对比。
 *
 * `source: 'js_metric'` 是刻意的：提案来自**度量**（差多少），不是模型的归因（谁造成的）。
 * 影子阶段先度量这个更弱但更便宜的信号；模型判定在 `model` 字段里另有出处，两者不混。
 */
export function shadowProposal(candidate = {}, { taskFamily = null } = {}) {
  const edit = candidate?.minimal?.edit || null;
  if (!edit) return null;
  const fields = Array.isArray(edit.fields) ? edit.fields.map((field) => String(field)).slice(0, 12) : [];
  const target = {};
  // 目标值取自执行图上的那个节点（`singlePlanEdits` 会把 exec 节点挂在 edit.node 上）。
  // **只抄 `fields` 里列到的字段**：把整个 exec 节点当成目标等于要求"完全对齐"，
  // 而提案的语义是"改这一处就够到阈值了"。
  const source = edit.node || edit.edge || {};
  for (const field of fields) {
    if (source[field] !== undefined) target[field] = String(source[field] ?? '').slice(0, 200);
  }
  return {
    op: String(edit.op || ''),
    nodeId: String(edit.nodeId || '').slice(0, 200),
    edgeId: String(edit.edgeId || '').slice(0, 160),
    fields,
    target,
    // 任务族随提案一起走：没有它，后续按族分区/统计时只能回到记录顶层去猜，
    // 而提案一旦被复制到 follow-up 事件里，顶层字段是不跟着走的。
    ...(taskFamily && taskFamily.id ? {
      taskFamily: {
        version: taskFamily.version, id: taskFamily.id, anchor: taskFamily.anchor,
        anchorKind: taskFamily.anchorKind, shape: taskFamily.shape,
        degenerate: taskFamily.degenerate === true,
      },
    } : {}),
    // 提案**没有被执行**。这个字段是字面断言而不是注释：读记录的人、以及将来写聚合
    // 脚本的人，可以直接判断"这条记录有没有可能改过图"。
    executable: false,
    source: 'js_metric',
    score: candidate?.minimal?.proximity?.score === undefined ? null : round(candidate.minimal.proximity.score),
  };
}

/**
 * 影子后续：图后来**自己**走到了提案说的那一步吗？
 *
 * 这是唯一能回答"我们的提案是不是废话"的证据。`minimal_plan_edit` 的真实目标只能是
 * **下一轮同类任务的规划先验**（提案在执行完成时已不可回改，见 PLAN_EXEC_TRUTH），
 * 所以这里观察的是：**规划的演化是否与提案一致**。
 *
 * 说清楚它的边界，免得被读成比实际更强的证据：理想形态是"下一轮同类任务的规划是否采纳了它"，
 * 而那需要一个**任务族标识**，今天没有。所以这里只统计同一张图上后续可观测到的部分：
 * 后续 revision 的规划有没有走到提案说的那一步。看不到后续（图不再变）就报 `observed:false`
 * —— 既不算同意也不算反对。把"没看到"算成同意是这类度量最容易犯的错。
 */
export function observeShadowFollowUp({ proposal = null, plan = null, metric = null } = {}) {
  if (!proposal || !proposal.op) return null;
  // 没有规划图 = 没有可观察的对象。此时返回 null（未观测），
  // **不能**默认成 node_gone：那是在没有证据的情况下断言"节点没了"。
  if (!plan || !Array.isArray(plan.nodes)) return null;
  const nodes = plan.nodes;
  const edges = Array.isArray(plan.edges) ? plan.edges : [];
  const outcome = proposalOutcome(proposal, nodes, edges);
  return {
    observed: true,
    outcome,
    // 到了这个 revision，漂移还剩多少。用来区分"我们的提案对但已有人做"（分数改善）
    // 与"漂移真实存在且无人处理"（分数没变或更差）。
    metricScore: metric?.score === undefined ? null : round(metric.score),
    threshold: metric?.threshold === undefined ? null : metric.threshold,
    carriedOut: outcome === 'carried_out',
  };
}

function proposalOutcome(proposal = {}, nodes = [], edges = []) {
  const op = String(proposal.op || '');
  if (op === 'align_node') {
    const node = nodes.find((item) => String(item.id) === String(proposal.nodeId));
    if (!node) return 'node_gone';
    const fields = Object.keys(proposal.target || {});
    if (!fields.length) return 'not_carried_out';
    const matched = fields.filter((field) => String(node[field] ?? '') === String(proposal.target[field] ?? ''));
    if (matched.length === fields.length) return 'carried_out';
    return matched.length ? 'partially_carried_out' : 'not_carried_out';
  }
  if (op === 'add_node') {
    return nodes.some((item) => String(item.id) === String(proposal.nodeId)) ? 'carried_out' : 'not_carried_out';
  }
  if (op === 'drop_node') {
    return nodes.some((item) => String(item.id) === String(proposal.nodeId)) ? 'not_carried_out' : 'node_gone';
  }
  if (op === 'add_edge') {
    return edges.some((item) => String(item.id) === String(proposal.edgeId)) ? 'carried_out' : 'not_carried_out';
  }
  if (op === 'drop_edge') {
    return edges.some((item) => String(item.id) === String(proposal.edgeId)) ? 'not_carried_out' : 'edge_gone';
  }
  return 'unsupported_op';
}

/**
 * 累计一致性度量。**纯函数**：给一批影子记录 + 后续事件，算出能不能开真动作。
 *
 * 分母的口径是这里唯一重要的事：`observed` 才进分母。没观察到后续的提案
 * （图不再变，这在产品里是常态）既不算同意也不算反对 —— 把它们算成同意会让
 * "少量样本 + 大量未观察"看起来像"高度一致"，而那正是最危险的读数。
 * 所以这里把三类计数分开返回，并且**不给出**任何"未观察也算进比率"的字段。
 */
export function summarizeShadowAgreement({ proposals = [], followUps = [] } = {}) {
  const outcomeByProposal = new Map();
  for (const event of followUps) {
    const key = String(event?.proposalRef?.eventId || '');
    if (!key) continue;
    // 同一提案的多次观察：后到的覆盖先到的（越晚的图越是"最终形态"）。
    outcomeByProposal.set(key, event);
  }
  const counts = { carried_out: 0, partially_carried_out: 0, not_carried_out: 0, node_gone: 0, edge_gone: 0, unsupported_op: 0 };
  let observed = 0;
  let unobserved = 0;
  // 任务族口径（P3 新增）。**只做分区与报告，不进比率**：把一个族拆开算
  // 会得到一堆各自都"样本不足"的小比率，合起来算又会把不同类的任务混成一个数。
  const familyIds = new Set();
  let degenerateFamilyProposals = 0;
  for (const proposal of proposals) {
    const eventId = String(proposal?.eventId || '');
    const family = proposal?.taskFamily || {};
    if (family.id) familyIds.add(String(family.id));
    // 退化的族 = anchor 落到了 task_run 上（既没有 groupId 也没有 delegationId）。
    // 这种族只有这一次运行，下一轮同类任务必然换族 —— 它的提案**结构上**无法收敛，
    // 单独计数就是为了不让它们悄悄把"样本在积累"读成真的。
    if (family.degenerate === true) degenerateFamilyProposals += 1;
    const followUp = eventId ? outcomeByProposal.get(eventId) : null;
    if (!followUp) { unobserved += 1; continue; }
    observed += 1;
    const outcome = String(followUp.outcome || '');
    if (counts[outcome] !== undefined) counts[outcome] += 1;
  }
  const carriedOut = counts.carried_out;
  return {
    proposals: proposals.length,
    observed,
    unobserved,
    carriedOut,
    partiallyCarriedOut: counts.partially_carried_out,
    notCarriedOut: counts.not_carried_out,
    nodeGone: counts.node_gone,
    edgeGone: counts.edge_gone,
    unsupportedOp: counts.unsupported_op,
    // 分母是 observed，不是 proposals —— 见上面的注释。写成字段而不是只写在注释里，
    // 是因为报告脚本要能**断言**自己用的分母：读错分母是这类度量最贵的错。
    denominator: 'observed',
    denominatorNote: 'agreementRate = carriedOut / observed；unobserved 既不算同意也不算反对',
    // 分区信息：族数、族 id（截断）、以及结构上无法收敛的提案数。
    families: familyIds.size,
    familyIds: [...familyIds].slice(0, 16),
    degenerateFamilyProposals,
    agreementRate: observed ? round(carriedOut / observed) : null,
    // 低于这个观察量时不给结论。不是统计上的显著性，而是产品上的诚实：
    // 5 条观察出来的 100% 不足以支撑"去改用户的规划"。
    sampleSufficient: observed >= SHADOW_MIN_OBSERVATIONS,
    minObservations: SHADOW_MIN_OBSERVATIONS,
  };
}

// 开真动作所需的最少**已观察**提案数。定这个数的理由不是统计功效，
// 而是"提案按 op 分布还算看得过来"：影子阶段真正要判断的是每一类 op
// （align_node / add_edge / …）各自的一致性，而不是一个总数。
const SHADOW_MIN_OBSERVATIONS = 30;

// 开真动作所需的**最低一致率**。同样不是统计阈值：它要回答的是
// "我们的最小改动建议，现实里大多数时候真的走过去了么"。低于这个数，
// 说明我们在建议一件现实反复不选的事 —— 那改的是用户的规划，代价不对称。
const SHADOW_MIN_AGREEMENT_RATE = 0.6;

// ---------------------------------------------------------------------------
// 任务族标识（P3）
// ---------------------------------------------------------------------------
//
// 为什么需要它：影子度量要回答的是"**下一轮同类任务**是否采纳了上轮建议"，
// 而 `observeShadowFollowUp` 今天只能在**一张图**的后续 revision 上观察
// （`readPlanExecGraphs` 的 `scope.taskRunIds` 只覆盖当前图里的 run）。
// 没有"族"这个概念，就无法回答"两次运行算不算同一类任务"，
// 也无法在报告里说清"分母为什么是这个数"。
//
// 定义刻意**保守且可解释**：
//   anchor = groupId || delegationId || taskRunId
//     —— 协作单元本身。**不跨组合并**：两个不同的组即使形状一样，也是两个团队、两种上下文。
//   shape  = 规划侧的结构指纹（kind×depth 计数 + 边种类计数）
//     —— 同一个组里的不同任务形状差很远（3 个 agent_task vs 10 个），所以组内需要再分一次。
//   id     = anchor::shape
//
// 诚实交代这个定义的边界：理想形态是"按任务**类型**聚类"（一个语义信号），
// 而那是方案二（能力画像 / 依赖集束）的事，用户明确说先不做。所以这一版用的是
// **结构**代理：形状相同 + 同一个协作单元 = 同类任务。它会在两种情况下失真
// （同形状不同任务、更常见的：同任务因 planner 输出条数不同而形状不同），
// 所以 `degenerate` 与族计数都会如实报出来，而不是让读者以为分区是准的。
export const RDMD_TASK_FAMILY_VERSION = 'rdmd_task_family_v1';

/** 规划侧的**结构指纹**。只取 kind/边种类与计数，不取标题、文本或 id。 */
export function planExecFamilyShape(plan = {}) {
  const nodes = Array.isArray(plan?.nodes) ? plan.nodes : [];
  const edges = Array.isArray(plan?.edges) ? plan.edges : [];
  const nodeCounts = new Map();
  for (const node of nodes) {
    const kind = String(node?.kind || 'unknown');
    const depth = Number.isFinite(Number(node?.depth)) ? Number(node.depth) : -1;
    const key = `${kind}@${depth}`;
    nodeCounts.set(key, (nodeCounts.get(key) || 0) + 1);
  }
  const edgeCounts = new Map();
  for (const edge of edges) {
    const kind = String(edge?.kind || 'unknown');
    edgeCounts.set(kind, (edgeCounts.get(kind) || 0) + 1);
  }
  const part = (map) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, n]) => `${key}:${n}`).join(',');
  return `n[${part(nodeCounts)}]e[${part(edgeCounts)}]`;
}

/**
 * 一次运行属于哪个任务族。**纯函数**，只读 `scope` 与规划图。
 *
 * `degenerate: true` 表示 anchor 落到了 `taskRunId`（这条 run 既不在协作组里、
 * 也没有 delegation）。这种族只有这一次运行，**结构上不可能收敛** ——
 * 报告必须把它单独计数，否则"分母在涨"会是个假象。
 */
export function planExecTaskFamily({ groupId = '', delegationId = '', taskRunId = '', plan = null } = {}) {
  const group = text(groupId, 200);
  const delegation = text(delegationId, 200);
  const run = text(taskRunId, 200);
  const anchor = group || delegation || run;
  const anchorKind = group ? 'group' : delegation ? 'delegation' : run ? 'task_run' : 'none';
  // 没有规划图时形状是空串：族 id 仍然可用（anchor 部分），但**不能**声称
  // "形状相同所以同类"。把形状留空比给一个 `n[]e[]` 的假形状诚实。
  const shape = plan && Array.isArray(plan.nodes) ? planExecFamilyShape(plan) : '';
  return {
    version: RDMD_TASK_FAMILY_VERSION,
    anchor,
    anchorKind,
    shape,
    id: anchor ? `${anchor}::${shape || '-'}` : '',
    degenerate: anchorKind === 'task_run' || anchorKind === 'none',
  };
}

/**
 * 影子度量的**闸门**：能不能从 `shadow` 升到 `apply`。**纯函数，fail-closed**。
 *
 * 三条都要满足，缺一条就给出原因（不是静默停在 shadow）：
 *   1. 有度量；
 *   2. 已观察提案数 ≥ `SHADOW_MIN_OBSERVATIONS`；
 *   3. 一致率 ≥ `SHADOW_MIN_AGREEMENT_RATE`。
 *
 * 注意 `sampleSufficient` 用的是 `observed`（不是 `proposals`）—— 报告脚本、
 * 这里的判据、`summarizeShadowAgreement` 三处必须同一个分母，所以这里不重算，
 * 而是直接读它给出的字段。分母口径只有一个来源。
 */
export function shadowApplyGate({
  agreement = null,
  minObservations = SHADOW_MIN_OBSERVATIONS,
  minAgreementRate = SHADOW_MIN_AGREEMENT_RATE,
} = {}) {
  const reasons = [];
  if (!agreement || typeof agreement !== 'object') {
    reasons.push('no_metric');
  } else {
    const observed = Number(agreement.observed || 0);
    if (!(observed >= minObservations)) reasons.push('sample_insufficient');
    if (agreement.agreementRate === null || agreement.agreementRate === undefined) reasons.push('no_observed');
    else if (!(Number(agreement.agreementRate) >= minAgreementRate)) reasons.push('agreement_below_threshold');
  }
  return {
    met: reasons.length === 0,
    reasons,
    observed: Number(agreement?.observed || 0),
    agreementRate: agreement?.agreementRate ?? null,
    minObservations,
    minAgreementRate,
  };
}

/**
 * `apply` 阶段唯一允许写出去的东西：**下一轮规划的先验**。
 *
 * 三条硬约束，全部在代码里而不是注释里：
 *   1. **只处理 `minimal_plan_edit`**。`similar_swap`（换人）是方案二的事，这里 no-op；
 *      其余 action（`record_only`）也 no-op。
 *   2. **只写规划侧**。产物是一行 `RDMD_PLAN_PRIOR_EVENT` 事件，键是任务族；
 *      这个函数**不可能**改执行图 —— 它不引入任何写图的方法，也不调用
 *      `applyPlanEdit`（契约里那个纯函数改的是"图对象"，一旦被调用就说明有一条路
 *      在内存里改图，那正是要避免的形状）。
 *   3. **`target` 没给全就 no-op**。一个只说了"改哪个节点"却没说"改成什么"的提案
 *      去执行就是瞎改，所以宁可不写，并把原因记下来。
 */
export function planPriorFromRecord(record = {}) {
  const action = String(record?.decision?.action || '');
  if (action !== 'minimal_plan_edit') {
    return { eligible: false, reason: action ? `action_${action}` : 'action_missing', op: '', edit: null };
  }
  const proposal = record?.shadow?.proposal || null;
  if (!proposal) return { eligible: false, reason: 'no_proposal', op: '', edit: null };
  const op = String(proposal.op || '');
  const nodeId = String(proposal.nodeId || '');
  const edgeId = String(proposal.edgeId || '');
  const fields = Array.isArray(proposal.fields) ? proposal.fields : [];
  const target = proposal.target && typeof proposal.target === 'object' ? proposal.target : {};
  const incomplete = 'target_incomplete';
  if (op === 'align_node') {
    if (!nodeId || !fields.length) return { eligible: false, reason: incomplete, op, edit: null };
    // 每一个要改的字段都必须有目标值。少一个就整条 no-op（不是"改能改的那几个"）。
    const missing = fields.filter((field) => target[field] === undefined);
    if (missing.length) return { eligible: false, reason: incomplete, op, edit: null, missing };
    return { eligible: true, reason: '', op, edit: { op, nodeId, fields: [...fields], target: { ...target } } };
  }
  if (op === 'add_node' || op === 'drop_node') {
    if (!nodeId) return { eligible: false, reason: incomplete, op, edit: null };
    return { eligible: true, reason: '', op, edit: { op, nodeId } };
  }
  if (op === 'add_edge' || op === 'drop_edge') {
    if (!edgeId) return { eligible: false, reason: incomplete, op, edit: null };
    return { eligible: true, reason: '', op, edit: { op, edgeId } };
  }
  return { eligible: false, reason: op ? 'unsupported_op' : 'op_missing', op, edit: null };
}

// 规划先验的 id = **任务族 + 写它的那条 run**。
//
// 为什么带 `taskRunId` 而不是一族一行：`recordTaskEvent` 把事件 id 绑在一条 run 上
// （同 id 换 run 会抛 `Task event identity conflict`，这是 store 的既有不变量）。
// 硬做成"一族一行"只有两条路，两条都不能走：改写上一条 run 的行（等于伪造它写下的时间
// 与内容），或者后来的先验直接丢弃。所以一族**多条**是有意的 —— 它本来就是一条时间线。
//
// 消费者（下一轮同类任务在规划时）按族查询、取最新的一条，而不是按 id 取唯一一条。
export function planExecPlanPriorEventId(taskFamilyId = '', taskRunId = '') {
  return `rdmd_plan_prior:${String(taskFamilyId || '').trim()}:${String(taskRunId || '').trim()}`;
}

// 诊断记录恒定使用的事件 id。`notifyTaskUpdated` 在终态上会被调用多次
// （任何后续事件都会再报一次同一个 status），带 id 的 recordTaskEvent 是 upsert 语义，
// 所以同一个 task run 反复进入终态只会覆盖同一行，不会写出一串重复记录。
export function planExecDriftEventId(taskRunId = '') {
  return `rdmd_plan_exec:${String(taskRunId || '').trim()}`;
}

/**
 * 影子后续事件的 id。带上 `revision` 是**幂等**的关键：同一个提案在同一个 revision 上
 * 只会有一条后续，反复评估不会写出一串重复；而图真的往后走了（revision 变了）
 * 就会再观察一次 —— 后到的观察覆盖先到的（见 summarizeShadowAgreement）。
 */
export function planExecDriftFollowUpEventId(proposalEventId = '', revision = 0) {
  return `rdmd_plan_exec_followup:${String(proposalEventId || '').trim()}:${Number(revision) || 0}`;
}

// ---------------------------------------------------------------------------
// 进程边界
// ---------------------------------------------------------------------------

/**
 * 模型推理的可用性 + 通道选择。**纯函数**（除了注入的 `existsSync`），
 * 便于单测覆盖每种不可用原因。
 *
 * `configured:false` 不是错误，是默认状态：桌面端默认既没有 GPU 也没有 adapter，
 * 这时应该静默降级成 `record_only`，而不是报错。
 *
 * `cloud` 由调用方注入，可以是对象 `{ serverUrl, infer }`，也可以是**返回该对象的函数**
 * （serverUrl 会随登录/换服务器变化，所以生产里传函数）。`infer` 是已经带认证的提交函数
 * （见 cloudSync.rdmdInfer）。这里只做"通不通"的判断，不发请求 —— 探测登录态是 IO，
 * 会把这个纯函数变得不可测；拿不到凭据时 `infer` 自己会抛，落到
 * `record_only` + `cloud_auth_required`，语义一样是 fail-closed。
 */
export function resolveRdmdInferenceConfig({ root = '', env = process.env, existsSync = fs.existsSync, cloud = null } = {}) {
  const cloudValue = typeof cloud === 'function' ? (cloud() || {}) : (cloud || {});
  const adapter = text(env.RDMD_ADAPTER);
  const model = text(env.RDMD_BASE_MODEL);
  const override = text(env.RDMD_PREDICT_PY);
  // 默认位置是仓库布局。`experiments/` 不会进安装包（package.json 的 build.files 只有
  // `src/**`），所以真实安装上这里必然不存在 —— 那正是 `model_script_missing`，
  // 也是本阶段预期的状态。
  const script = override || (root ? path.join(String(root), 'experiments', 'rdmd_detective_dataset', 'deploy', 'predict.py') : '');
  const python = text(env.RDMD_PYTHON) || (process.platform === 'win32' ? 'python' : 'python3');
  const device = text(env.RDMD_DEVICE) || 'cuda:0';
  const timeoutMs = boundedNumber(env.RDMD_TIMEOUT_MS, 120_000, 1_000, 30 * 60_000);

  // 本地通道：今天的实现，字段含义都没变。
  const localReason = !adapter && !model
    ? 'model_not_configured'
    : !script || !existsSync(script) ? 'model_script_missing' : '';
  const localReady = !localReason;

  // 云通道：必须**两者都有** —— 一个能提交的通道，和一个知道往哪儿提交的地址。
  // 只有通道没有地址 = 不知道把数据发去哪，不算可用。
  const cloudUrl = text(env.RDMD_CLOUD_URL) || text(cloudValue.serverUrl);
  const cloudInfer = typeof cloudValue.infer === 'function' ? cloudValue.infer : null;
  const cloudReady = Boolean(cloudUrl && cloudInfer);

  const explicit = text(env.RDMD_TRANSPORT).toLowerCase();
  const transport = RDMD_TRANSPORTS.includes(explicit)
    ? explicit
    : cloudReady ? 'cloud' : localReady ? 'local_spawn' : 'none';

  // 每个通道各自说清"为什么不能用"。三条路各有各的排查方向，不要用一条笼统的原因盖住。
  // 注意 `local_spawn` 这一格**不能**再写 `|| 'model_not_configured'`：本地就绪时
  // `localReason` 本来就是空串，补一个默认值会把"可用"变成"不可用"。
  const reason = {
    cloud: cloudReady ? '' : 'cloud_not_configured',
    local_spawn: localReason,
    // 显式关掉通道（`RDMD_TRANSPORT=none`）和"什么都没配"是两件事：
    // 前者是运维决定，后者是缺配置。混成一条，排查时就会去查错方向。
    none: explicit === 'none' ? 'transport_disabled' : (localReason || 'model_not_configured'),
  }[transport];
  return {
    transport,
    configured: !reason,
    reason,
    // 本地通道字段。云通道下这些值不参与任何决策，保留只是为了不破坏既有调用方。
    python, script, adapter, model, device, timeoutMs,
    cloudUrl,
    // 云通道下这个函数**原样**被用来提交；本地通道下是 null。
    cloudInfer: transport === 'cloud' ? cloudInfer : null,
  };
}

/** predict.py 的参数。抽出来是为了让测试能断言「有没有把 adapter 传进去」。 */
export function rdmdInferenceArgs({ script = '', casePath = '', outputPath = '', adapter = '', model = '', device = '' } = {}) {
  const args = [String(script), '--input', String(casePath), '--output', String(outputPath)];
  if (adapter) args.push('--adapter', String(adapter));
  if (model) args.push('--model', String(model));
  args.push('--device', String(device || 'cuda:0'));
  return args;
}

/**
 * 跑一条 case。**永远 resolve，永远不抛**。
 *
 * 调用点在 `queueMicrotask` 里、在任务终态的路径上，一次未捕获的拒绝会污染
 * 整个终态收尾（`recordTerminal` / `finalizeUBuddyTaskRun` 都在同一个 microtask 里）。
 *
 * 按 `config.transport` 分派：`cloud` 走 HTTP，其余（含老调用方没给 transport 的情况）
 * 走本地子进程 —— 保持既有行为，不因为新增通道而改变本地语义。
 *
 * @returns {Promise<{invoked: boolean, ok: boolean, reason: string, verdict?: object, warnings?: string[], exitCode?: number}>}
 */
export async function runRdmdInference({ case: caseValue = {}, config = {}, spawnImpl = spawn, cloudInfer = null, workDir = '' } = {}) {
  if (!config?.configured) return { invoked: false, ok: false, reason: config?.reason || 'model_not_configured' };
  if (config.transport === 'cloud') {
    // 与 `spawnImpl` 对称：通道实现在调用点可注入，缺省用配置里带的那个。
    return runCloudRdmdInference({ case: caseValue, config, cloudInfer });
  }
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(workDir || os.tmpdir(), 'janus-rdmd-'));
    const casePath = path.join(dir, 'case.json');
    const outputPath = path.join(dir, 'verdict.jsonl');
    fs.writeFileSync(casePath, JSON.stringify(caseValue), 'utf-8');
    const child = await spawnWithTimeout(spawnImpl, config.python, rdmdInferenceArgs({
      script: config.script, casePath, outputPath,
      adapter: config.adapter, model: config.model, device: config.device,
    }), { cwd: path.dirname(config.script), timeoutMs: config.timeoutMs });
    if (child.timedOut) return { invoked: true, ok: false, reason: 'model_timeout', exitCode: -1 };
    if (child.spawnError) return { invoked: true, ok: false, reason: 'model_spawn_failed', detail: child.spawnError };
    // 退出码 2 = predict.py 自己的输入/环境错误（读不进输入、adapter 目录不对）。
    // 0/1 都可能带出可用的判定记录，所以这里只分流 2。
    if (child.code === 2) {
      return { invoked: true, ok: false, reason: 'model_environment_error', exitCode: 2, detail: child.stderr };
    }
    return readVerdictRecord(outputPath, child);
  } catch (error) {
    return { invoked: true, ok: false, reason: 'model_spawn_failed', detail: String(error?.message || error) };
  } finally {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * 读并校验 predict.py 的那一行输出。
 *
 * 这里做 JS 侧的二次校验（而不是无条件信 `valid:true`）：`valid` 由 Python 的
 * `validate_verdict` 给出，它保证 `nodeId` 真的在图上；但 `type` 的**枚举**是
 * JS 契约（`RDMD_DRIFT_TYPES`）的东西，而 `routeEvolution` 对未知 type 会兜底成
 * `minimal_plan_edit`。所以「type 不在枚举里」必须在进路由**之前**拦下来。
 */
function readVerdictRecord(outputPath = '', child = {}) {
  let parsed = null;
  try {
    if (fs.existsSync(outputPath)) {
      const line = fs.readFileSync(outputPath, 'utf-8').split('\n').find((item) => item.trim());
      if (line) parsed = JSON.parse(line);
    }
  } catch (error) {
    return { invoked: true, ok: false, reason: 'model_output_unparseable', exitCode: child.code, detail: String(error?.message || error) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { invoked: true, ok: false, reason: 'model_output_missing', exitCode: child.code, detail: child.stderr };
  }
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((item) => text(item, 300)).filter(Boolean) : [];
  const verdict = {
    status: text(parsed.verdict?.status, 40),
    nodeId: text(parsed.verdict?.nodeId, 160),
    edgeId: text(parsed.verdict?.edgeId, 160),
    type: text(parsed.verdict?.type, 60),
    evidenceNodeIds: (Array.isArray(parsed.verdict?.evidenceNodeIds) ? parsed.verdict.evidenceNodeIds : [])
      .map((item) => text(item, 160)).filter(Boolean).slice(0, 32),
  };
  if (parsed.valid !== true) {
    // 输入契约违规与运行时故障要分开报：前者要去补字段，后者要去查环境。
    const contractViolation = warnings.some((item) => item.startsWith('input_contract_violation:'));
    return {
      invoked: true, ok: false,
      reason: contractViolation ? 'model_contract_violation' : 'model_invalid_verdict',
      exitCode: child.code, verdict, warnings,
    };
  }
  if (verdict.status === 'drift' && !RDMD_DRIFT_TYPES.includes(verdict.type)) {
    return { invoked: true, ok: false, reason: 'model_unknown_drift_type', exitCode: child.code, verdict, warnings };
  }
  return { invoked: true, ok: true, reason: '', exitCode: child.code, verdict, warnings };
}

/**
 * 云通道：把 case 交给注入了认证的 `config.cloudInfer`（见 cloudSync.rdmdInfer）。
 *
 * 这里**不做轮询**。轮询、超时、租约等待都在 cloudInfer 里 —— 因为它要用的凭据、
 * 服务器地址、HTTP 客户端都是那一侧的东西，在这里重写一遍只会得到两份会分叉的实现。
 * 本函数的职责只有一个：把"通话结果"归一成与本地通道**同一个**返回形状，
 * 好让 `planExecDriftRecord` 完全不需要知道判定是从哪来的。
 *
 * `cloudInfer` 的入参/出参契约（cloudSync.rdmdInfer 保证）：
 *   入：`{ case, taskRunId, conversationKind }`
 *   出：`{ status, reason, jobId, verdict, errorCode }`，其中 status ∈
 *       `not_eligible` | `unavailable` | `completed` | `queued`（详见云侧 rdmd/index.mjs）
 */
export async function runCloudRdmdInference({ case: caseValue = {}, config = {}, cloudInfer = null } = {}) {
  const infer = cloudInfer || config.cloudInfer;
  if (typeof infer !== 'function') {
    // 配置说走云，但没人给它通道。这不是"降级成本地"，是配置错误。
    return { invoked: false, ok: false, reason: 'cloud_transport_unavailable' };
  }
  let outcome = null;
  try {
    outcome = await infer({
      case: caseValue,
      taskRunId: String(config.taskRunId || ''),
      conversationKind: String(config.conversationKind || ''),
    });
  } catch (error) {
    // 每一条失败都要能被指认：没登录、连不上、HTTP 5xx、超时，修的地方不一样。
    return { invoked: true, ok: false, reason: cloudFailureReason(error), detail: text(error?.message || error, 300) };
  }
  return normalizeCloudOutcome(outcome);
}

function cloudFailureReason(error = {}) {
  const code = text(error?.code, 60);
  const status = Number(error?.status || 0);
  if (code === 'cloud_auth_required') return 'cloud_auth_required';
  if (code === 'rdmd_cloud_timeout') return 'cloud_verdict_timeout';
  if (code === 'rdmd_cloud_unreachable') return 'cloud_unreachable';
  if (status) return `cloud_http_${status}`;
  return 'cloud_request_failed';
}

/**
 * 云侧结果的归一化。**每条非成功路径都有独立的原因，且都不产出动作。**
 */
function normalizeCloudOutcome(outcome = null) {
  const value = outcome && typeof outcome === 'object' ? outcome : {};
  const status = text(value.status, 40);
  if (status === 'not_eligible') {
    // 隐私边界拒绝了这条 case（例如 private_assistant 会话）。这是**设计**，不是故障，
    // 所以原因原样带出去，让人看见是哪条边界起的作用。
    return { invoked: true, ok: false, reason: text(value.reason, 80) || 'cloud_not_eligible', verdict: null, warnings: [] };
  }
  if (status === 'queued') {
    // 走到这里说明 cloudInfer 没把轮询做完。宁可报超时，也不要拿一个"还没有判定"当判定。
    return { invoked: true, ok: false, reason: 'cloud_verdict_timeout', verdict: null, warnings: [] };
  }
  const raw = value.verdict;
  if (!raw || typeof raw !== 'object') {
    return { invoked: true, ok: false, reason: 'model_output_missing', verdict: null, warnings: [], errorCode: text(value.errorCode, 120) };
  }
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((item) => text(item, 300)).filter(Boolean).slice(0, 20) : [];
  // 云侧判定是**扁平**的（publicVerdict），形状与 predict.py 的记录不同，所以不能共用
  // 一个解析函数。`edgeId`/`evidenceNodeIds` 云侧没有：那两个字段只有本地 predict.py
  // 会算（它手上才有图）。这里给空值而不是编一个，缺什么就是缺什么。
  const verdict = {
    status: text(raw.status, 40),
    nodeId: text(raw.nodeId, 200),
    edgeId: text(raw.edgeId, 160),
    type: text(raw.type, 60),
    evidenceNodeIds: (Array.isArray(raw.evidenceNodeIds) ? raw.evidenceNodeIds : [])
      .map((item) => text(item, 160)).filter(Boolean).slice(0, 32),
  };
  // `UNKNOWN` 是云侧的一等状态（没配模型时 null 后端就回它）。它**不是**可用判定：
  // 拿它去路由只会得到 record_only，但原因会变成一句空话，所以在这里就说清楚。
  if (verdict.status !== 'drift' && verdict.status !== 'no_drift') {
    return {
      invoked: true, ok: false, verdict, warnings,
      reason: text(raw.reason, 120) || (verdict.status ? `model_status_${verdict.status.toLowerCase()}` : 'model_status_missing'),
    };
  }
  // 与本地通道同一条 JS 侧防线：未知 type 会让 `routeEvolution` 兜底成改图动作。
  if (verdict.status === 'drift' && !RDMD_DRIFT_TYPES.includes(verdict.type)) {
    return { invoked: true, ok: false, reason: 'model_unknown_drift_type', verdict, warnings };
  }
  // 云侧 `normalizeVerdict` 已经要求 drift 必须带 nodeId，所以走到这里说明两侧契约分叉了。
  // 单独报一条，不要把它混进 `model_unknown_drift_type` —— 前者要查契约，后者要查模型。
  if (verdict.status === 'drift' && !verdict.nodeId) {
    return { invoked: true, ok: false, reason: 'model_incomplete_verdict', verdict, warnings };
  }
  return { invoked: true, ok: true, reason: '', verdict, warnings };
}

function spawnWithTimeout(spawnImpl, command, args, { cwd = '', timeoutMs = 0, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      child = spawnImpl(command, args, { cwd: cwd || undefined, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: -1, timedOut: false, spawnError: String(error?.message || error), stdout, stderr });
      return;
    }
    // 只留尾部：Python 侧会把每条判定写一行 stderr 进度，几百行没必要全留。
    const append = (current, chunk) => {
      const next = current + String(chunk || '');
      return next.length > 4_000 ? next.slice(-4_000) : next;
    };
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      // SIGKILL 在 Windows 上被 Node 映射成 TerminateProcess，语义一致。
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs) : null;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      finish({ code: -1, timedOut, spawnError: String(error?.message || error), stdout, stderr });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      finish({ code: Number.isFinite(Number(code)) ? Number(code) : -1, timedOut, spawnError: '', stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// 诊断记录（纯函数）
// ---------------------------------------------------------------------------

/** 真值资格。只有成功收口的 run 才是真值；失败/取消只留诊断。 */
export function truthQualification(taskStatus = '') {
  const status = text(taskStatus, 40);
  if (status === 'completed') return { accepted: true, reason: 'run_completed' };
  if (!status) return { accepted: false, reason: 'run_status_unknown' };
  return { accepted: false, reason: `run_${status}` };
}

/**
 * 把「读取到的两张图 + 模型结果」折成一条可落库的记录。**纯函数**，不碰 IO。
 *
 * 刻意把 `model` 与 `metric` 分开报：模型判定的是「凶手是谁」，
 * JS 度量的是「差了多少、改哪一处能到相近」。两者不一致时，
 * 那条记录就是下一轮重训最有价值的样本 —— 混成一个字段就看不出来了。
 *
 * 记录里**不含任何图文本**（只留 id、计数、分数、字段名），
 * 所以它可以安全落进 `task_events`。
 */
export function planExecDriftRecord({
  read = null, taskRunId = '', taskStatus = '', model = null, config = null,
  threshold = RDMD_PROXIMITY_DEFAULTS.threshold, now = '', applyEnabled = false, applyGate = null,
} = {}) {
  const scope = read?.scope || {};
  // 动作侧的**能力位 + 度量门** → phase。**只能在这里推导**，不接受调用方传 phase：
  // 那样就存在一条"传 'apply' 进来"的路，而 apply 必须由 `shadowApplyGate` 才能打开。
  // 注意 `applyGate` 缺省时 `resolveDriftPhase` 停在 shadow —— 少传参数不会变成改图。
  const phase = resolveDriftPhase({ applyEnabled, applyGate });
  // 任务族：一次运行属于哪一类任务。落在记录顶层（`taskFamilyId`）便于按族查询/分区，
  // 完整定义放在 `taskFamily` 里，"这个 id 是怎么算出来的"不需要去读代码。
  const taskFamily = planExecTaskFamily({
    groupId: scope.groupId, delegationId: scope.delegationId,
    taskRunId: String(taskRunId || scope.taskRunId || ''), plan: read?.plan || null,
  });
  const record = {
    version: RDMD_PLAN_EXEC_RECORD_VERSION,
    generatedAt: now || new Date().toISOString(),
    // `record_only`（能力位关）/ `shadow`（能力位开、度量门不满足）/ `apply`（两道门都过）。
    // 前两者都**不改图**；区别是影子会把"本来想改哪一处"和"现实后来做了什么"记下来。
    phase,
    taskRunId: String(taskRunId || scope.taskRunId || ''),
    graphId: String(scope.graphId || ''),
    graphRevision: Number(scope.revision || 0),
    groupId: String(scope.groupId || ''),
    delegationId: String(scope.delegationId || ''),
    taskRunIds: (Array.isArray(scope.taskRunIds) ? scope.taskRunIds : []).map((item) => String(item)).slice(0, 32),
    taskFamilyId: taskFamily.id,
    taskFamily,
    // 升到 apply 的判据，与 phase 同源落库：只看 `phase: 'apply'` 无法回答
    // "它是靠什么数升上去的"。度量门没算时这里是 null，也是事实。
    applyGate: applyGate && typeof applyGate === 'object' ? {
      met: applyGate.met === true,
      reasons: (applyGate.reasons || []).map((item) => String(item)).slice(0, 8),
      observed: Number(applyGate.observed || 0),
      agreementRate: applyGate.agreementRate ?? null,
      minObservations: Number(applyGate.minObservations || 0),
      minAgreementRate: applyGate.minAgreementRate ?? null,
    } : null,
    truth: truthQualification(taskStatus),
  };
  if (!read) {
    return {
      ...record,
      status: 'no_graph',
      metric: null,
      gaps: null,
      candidate: null,
      model: model && typeof model === 'object' ? model : { invoked: false, reason: 'no_graph' },
      decision: { action: 'record_only', reason: 'no_graph' },
      // 影子阶段也要如实记一行"这里没东西可提"，否则"提案数"会被读成"评估数"。
      // proposal 为 null 而不是空提案：没有图就没有"最小的一处改动"这回事。
      ...(phase !== 'record_only' ? { shadow: { executable: false, proposal: null, followUp: null, reason: 'no_graph' } } : {}),
      // `apply` 阶段没图 → 不写先验。原因写清楚，别让 `apply` + 无产物看起来像漏了。
      ...(phase === 'apply' ? { apply: { applied: false, reason: 'no_graph', priorEventId: '', edit: null } } : {}),
    };
  }
  const proximity = planExecProximity(read.plan, read.exec, { threshold });
  const candidate = minimalPlanEdits(read.plan, read.exec, { threshold });
  // `read.gaps` 是产品侧守卫的判据（与 predict.py 的 check_case_contract 同源）。
  // 走到这里是「输入缺富文本字段」，属于预期状态而不是异常：
  // 真实 uBuddy 图今天**必然**缺这五个字段（没有专属列），所以模型今天必然不被调用。
  const guardFailed = Boolean(read.gaps?.length);
  // 这里**不改写** `model.reason`：记录要说实话。「模型没配」与「输入不合契约」是两条
  // 并存的事实，把后者盖到前者身上只会让人以为配了就能跑。契约问题体现在
  // `decision.reason` 与 `gaps` 上。
  const modelOutcome = model && typeof model === 'object' ? model : { invoked: false, reason: 'model_not_configured' };
  const decision = resolveDecision({ model: modelOutcome, guardFailed });
  // 提案与"能不能落先验"在这里算**一次**，供下面三个分支共用：
  // 记录里的 `shadow.proposal`、`apply.eligibility`、以及服务里真正写先验时读的是同一份。
  // 算两次会让"记录说可落、写的时候又判成不可落"这种自相矛盾变成可能。
  const proposal = phase !== 'record_only' ? shadowProposal(candidate, { taskFamily }) : null;
  const eligibility = planPriorFromRecord({ decision, shadow: { proposal } });
  return {
    ...record,
    status: guardFailed ? 'contract_gap' : 'evaluated',
    metric: {
      score: round(proximity.score),
      nodeScore: round(proximity.nodeScore),
      edgeScore: round(proximity.edgeScore),
      threshold,
      alreadyCloseEnough: candidate.alreadySatisfied,
      planNodeCount: proximity.planNodeCount,
      execNodeCount: proximity.execNodeCount,
      planEdgeCount: proximity.planEdgeCount,
      execEdgeCount: proximity.execEdgeCount,
    },
    gaps: {
      total: Number(read.gapSummary?.total || 0),
      emptyRichFieldCount: Number(read.gapSummary?.emptyRichFieldCount || 0),
      byField: read.gapSummary?.byField || {},
    },
    // JS 度量给出的候选，**是证据不是判定**。字段名写成 `candidate` 而不是 `edit`，
    // 免得将来有人把它当成模型的结论去执行。
    candidate: {
      reached: candidate.reached,
      evaluated: candidate.evaluated,
      op: candidate.minimal?.edit?.op || '',
      nodeId: candidate.minimal?.edit?.nodeId || '',
      fields: candidate.minimal?.edit?.fields || [],
      score: candidate.minimal ? round(candidate.minimal.proximity.score) : null,
    },
    model: {
      // 出处：这条判定是哪条通道、哪个模型给的。缺了它，`model.reason` 里那句
      // `model_not_configured` 就说不清是"本地没配 adapter"还是"云侧没挂 worker"。
      transport: String(config?.transport || ''),
      invoked: Boolean(modelOutcome.invoked),
      reason: String(modelOutcome.reason || ''),
      ok: modelOutcome.invoked ? modelOutcome.ok === true : null,
      // 没调用模型时 `valid` 是 `null`（不适用）而不是 `false`（无效）——
      // 这两者在排查时指向完全不同的动作：一个是「没跑」，一个是「跑了但判定不可信」。
      valid: modelOutcome.invoked ? modelOutcome.ok === true : null,
      status: modelOutcome.verdict?.status || '',
      nodeId: modelOutcome.verdict?.nodeId || '',
      edgeId: modelOutcome.verdict?.edgeId || '',
      type: modelOutcome.verdict?.type || '',
      evidenceNodeIds: modelOutcome.verdict?.evidenceNodeIds || [],
      warnings: (modelOutcome.warnings || []).slice(0, 8),
    },
    decision,
    ...(phase !== 'record_only' ? {
      // 影子：**记下本来想改的那一处，但不改**。`apply` 阶段也保留这一块 ——
      // 它是"这次本来想改什么"的唯一出处，而 apply 的产物（下一轮先验）正是从这里来的。
      //
      // 为什么提案只取 `candidate`（JS 度量）而不取模型判定：P5 要度量的是
      // "度量给出的最小改动能不能预测现实"。模型给的 `type`/`nodeId` 是归因
      // （谁造成的），它没有"改成什么"这回事，因此不存在可被后续验证的提案形状。
      // 模型判定在 `model` 字段里有独立出处，两者不混。
      shadow: {
        executable: false,
        proposal,
        // 写这条记录的时刻，后续还没发生，所以恒为 null。
        // 后续由**下一次**同图评估写成 `rdmd_plan_exec_drift_followup` 事件
        // （见服务里的 recordShadowFollowUps），不去改写这条记录。
        followUp: null,
        reason: '',
      },
    } : {}),
    // `apply` 阶段：**这一版里 `applied` 永远是 `false`**，因为服务在写库前会用真实结果
    // 覆盖它。留一个 `reason: 'pending'` 在这里，是为了让"纯函数产出的记录"也自洽：
    // 没被服务处理过的记录不该看起来像"已经改过用户的规划了"。
    ...(phase === 'apply' ? {
      apply: {
        applied: false,
        reason: 'pending',
        priorEventId: '',
        eligibility,
        edit: eligibility.eligible ? eligibility.edit : null,
        // 契约里那个纯函数 `applyPlanEdit`（改图对象）**一次都没被调用**，这是字形断言：
        // 这里只产出"要写一行什么事件"的描述，路径上不存在改图的代码。
        graphMutated: false,
      },
    } : {}),
  };
}

/**
 * 路由。三种证据强度，三条出口：
 *   - 有可用模型判定 → `routeEvolution` 的输出（`minimal_plan_edit` / `similar_swap` / `record_only`）；
 *   - 守卫拦下 → `record_only` + `input_contract_violation`；
 *   - 模型不可用 → `record_only`，原因就是不可用的原因。
 *
 * **不因为「JS 度量找到了候选」就产出动作**：度量只回答「差多少」，
 * 不回答「是谁导致的」。归因是模型的职责，没有模型就没有归因。
 */
function resolveDecision({ model = {}, guardFailed = false } = {}) {
  if (guardFailed && !model.invoked) {
    return { action: 'record_only', reason: 'input_contract_violation' };
  }
  if (!model.invoked) return { action: 'record_only', reason: String(model.reason || 'model_not_configured') };
  if (!model.ok) return { action: 'record_only', reason: String(model.reason || 'model_invalid_verdict') };
  const routed = routeEvolution(model.verdict || {}, {});
  return { action: routed.action, reason: routed.reason || '', swapDecision: routed.swapDecision || '' };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

// 去重集合的上界。超了就整体清空 —— 代价是最多重复评估一轮，
// 换的是长会话不无限增长。
const EVALUATED_LIMIT = 500;

/**
 * 任务终态上的漂移诊断。
 *
 * 调用点见 `runtime.js`：与 `recordTerminal` / `finalizeUBuddyTaskRun` 同一个
 * `queueMicrotask`，即「run 已经收口、图不再变」之后。
 */
export function createPlanExecDriftService({
  store = null, root = '', env = process.env, featureFlags = null, cloud = null,
  spawnImpl = spawn, existsSync = fs.existsSync, logger = null, now = () => new Date().toISOString(),
} = {}) {
  // 通道**每次评估时重新解析**，不在构造时快照：云通道的可用性取决于那时的登录状态与
  // 服务器地址，而任务终态可能发生在登录之前（那就该是 record_only）。
  // 这个函数是纯函数 + 一次 existsSync，重算的代价可以忽略。
  const resolveConfig = ({ conversationKind = '', taskRunId = '' } = {}) => ({
    ...resolveRdmdInferenceConfig({ root, env, existsSync, cloud }),
    conversationKind,
    taskRunId,
  });
  // 同一个 task run 只评估一次：终态会被反复通知，重复评估只会重复读库 + 重复起子进程。
  const evaluated = new Set();

  const enabledFor = (task = {}) => {
    if (!store?.readPlanExecGraphs) return false;
    if (!featureFlags?.snapshot) return false;
    return Boolean(featureFlags.snapshot({ userId: String(task?.ownerUserId || '') })?.planExecDrift);
  };

  // 动作侧能力位独立解析。它只在 `planExecDrift` 也开着时才有意义：
  // 关掉诊断就一起关掉了动作侧，不存在"只开动作侧"的组合。
  const applyEnabledFor = (task = {}) => {
    if (!featureFlags?.snapshot) return false;
    return Boolean(featureFlags.snapshot({ userId: String(task?.ownerUserId || '') })?.planExecDriftApply);
  };

  /**
   * 把当前图里的**提案事件**与**后续事件**读出来，算一次影子一致性度量。
   *
   * 读取范围说明（P3 的口径澄清，也是 `denominatorNote` 的由来）：只能覆盖
   * `read.scope.taskRunIds`，即**当前这一张图**里的 run。这不是偷懒 ——
   * `observeShadowFollowUp` 判的是"提案说的那个 nodeId 有没有变成 target 的样子"，
   * 而 nodeId 是**图内**标识：跨图比较节点 id 没有意义（两张图各有一套 id）。
   * 所以"下一轮同类任务是否采纳"这件事，在**有跨图节点标识**之前无法被诚实地度量。
   *
   * 这也正是要落 `taskFamilyId` 的原因：分区先建起来，等身份问题解决后
   * 就能直接按族汇总，而不必回填历史。
   */
  const readShadowAgreement = ({ read } = {}) => {
    if (!read || !store?.listTaskEvents) return null;
    const proposals = [];
    const followUps = [];
    for (const runId of read.scope?.taskRunIds || []) {
      for (const event of store.listTaskEvents(runId) || []) {
        const payload = event.payload || {};
        if (event.eventType === 'rdmd_plan_exec_drift' && payload.shadow?.proposal) {
          proposals.push({
            eventId: String(event.eventId || event.id || ''),
            taskRunId: String(runId),
            graphRevision: Number(payload.graphRevision || 0),
            // 提案自带族（见 shadowProposal）；老记录没有这个字段，回落到记录顶层的
            // `taskFamily`，再没有就是"未知族"—— 未知族不计入 `families`，
            // 但提案本身仍进分母口径的分子/分母（`observed` 是图的属性，不是族的）。
            taskFamily: payload.shadow.proposal.taskFamily || payload.taskFamily || null,
            op: String(payload.shadow.proposal.op || ''),
          });
        }
        if (event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT) {
          followUps.push({ proposalRef: payload.proposalRef || null, outcome: payload.outcome || '', toRevision: Number(payload.toRevision || 0) });
        }
      }
    }
    return { ...summarizeShadowAgreement({ proposals, followUps }), proposals: proposals.length };
  };

  /**
   * 观察历史提案的现实结局，落成 follow-up 事件。
   *
   * 只在动作侧开着时跑（`shadow` / `apply` 都算）：能力位关着时连读都不读，
   * `record_only` 路径的开销与今天完全一致。
   *
   * **`apply` 阶段也必须继续观察** —— 这是 P3 修掉的一个真 bug：此前判据是
   * `phase === 'shadow'`，于是一旦升到 `apply`，后续观察就停了，度量被冻在
   * 升级那一刻的数字上。而 apply 恰恰是最需要继续盯着的时候。
   *
   * 三条自律，都是为了让这个度量**不会被读成比实际更强**：
   *   1. 只观察**更晚的** revision（`revision > proposalRevision`）。同一版图上说
   *      "提案没被采纳"是废话 —— 那时现实还没机会发生。
   *   2. 幂等（eventId 带 revision），反复评估不重复计数。
   *   3. 找不到更晚的图就什么都不写：**没观察到不是"未采纳"**，两者必须分得开。
   */
  const recordShadowFollowUps = ({ read, threshold = RDMD_PROXIMITY_DEFAULTS.threshold } = {}) => {
    if (!read || !store?.listTaskEvents) return 0;
    const revision = Number(read.scope?.revision || 0);
    const metric = planExecProximity(read.plan, read.exec, { threshold });
    let written = 0;
    for (const runId of read.scope?.taskRunIds || []) {
      for (const event of store.listTaskEvents(runId) || []) {
        if (event.eventType !== 'rdmd_plan_exec_drift') continue;
        const proposal = event.payload?.shadow?.proposal;
        if (!proposal) continue;
        // 事件主键在库里叫 `eventId`（见 persist()）。这里同时容忍 `id`：不同调用方
        // （含测试夹具）传进来的历史行可能只带 `id`，取错了会静默变成空串 —— 那样
        // 后续事件全都指不到提案，度量永远算作 0 条已观察，且不会有任何报错。
        const sourceEventId = String(event.eventId || event.id || '');
        if (!sourceEventId) continue;
        const proposalRevision = Number(event.payload?.graphRevision || 0);
        if (revision <= proposalRevision) continue; // 自律 1：必须是更晚的图
        const followUpId = planExecDriftFollowUpEventId(sourceEventId, revision);
        if (typeof store.getTaskEvent === 'function' && store.getTaskEvent(followUpId)) continue; // 自律 2
        const followUp = observeShadowFollowUp({ proposal, plan: read.plan, metric });
        if (!followUp) continue;
        try {
          store.recordTaskEvent({
            eventId: followUpId,
            taskRunId: runId,
            eventType: RDMD_SHADOW_FOLLOWUP_EVENT,
            actorId: 'reverse_detective',
            summary: `rdmd shadow follow-up: ${followUp.outcome} (${proposal.op} ${proposal.nodeId || proposal.edgeId || ''})`,
            // 把提案原样带进来：这样一份报告不需要 join 就能按 op 分布看一致性，
            // 而"按 op 分布"才是开真动作时真正要看的（见 summarizeShadowAgreement）。
            payload: {
              version: RDMD_PLAN_EXEC_RECORD_VERSION,
              observedAt: now(),
              graphId: String(read.scope?.graphId || ''),
              taskRunId: runId,
              proposalRef: {
                eventId: sourceEventId, taskRunId: runId, graphRevision: proposalRevision,
                op: proposal.op, nodeId: proposal.nodeId, edgeId: proposal.edgeId,
                fields: proposal.fields, target: proposal.target, score: proposal.score,
              },
              fromRevision: proposalRevision,
              toRevision: revision,
              ...followUp,
            },
          });
          written += 1;
        } catch (error) {
          logger?.warn('rdmd-shadow-followup-failed', { error, data: { taskRunId: runId } });
        }
      }
    }
    return written;
  };

  const evaluate = async (task = {}) => {
    const taskRunId = String(task.id || '');
    const read = store.readPlanExecGraphs({
      taskRunId, viewerUserId: String(task.ownerUserId || ''), skipAuthorization: true,
    });
    // 会话种类**由频道/部门推断**，不是新加的字段：`private_assistant` 会话在库里就是以
    // `department_id='private_assistant'` 标记的（与 cloudSync 里过滤这类会话用的是同一个判据）。
    // 云侧的隐私白名单要它来决定这条 case 能不能出本机。
    const conversationKind = String(task.departmentId || '') === 'private_assistant' ? 'private_assistant' : '';
    const config = resolveConfig({ conversationKind, taskRunId });
    // 读不到图 = 没有可判定的对象；缺富文本字段 = 输入落在训练支持集外。
    // 两种都不许起子进程/发请求：前者无从判起，后者会让模型拿空字段给出自信答案。
    const blockedReason = !read ? 'no_graph' : read.gaps?.length ? 'input_contract_violation' : '';
    const model = blockedReason
      ? { invoked: false, ok: false, reason: blockedReason }
      : await runRdmdInference({ case: read.case, config, spawnImpl });
    // 度量门在**评估时**算，而且只在动作侧开着时才算（关着时连读都不读）。
    // 门不满足时 `resolveDriftPhase` 停在 `shadow` —— 少算一次度量不会变成 apply。
    const applyEnabled = applyEnabledFor(task);
    const agreement = applyEnabled ? readShadowAgreement({ read }) : null;
    const applyGate = applyEnabled ? shadowApplyGate({ agreement }) : null;
    // 能力位与度量门要传进**纯函数**，而不是先算出来再贴到记录上：记录里的 `phase`、
    // 有没有影子块、apply 的判据必须同源，否则会出现"phase=apply 却没有门"这种自相矛盾的行。
    return planExecDriftRecord({
      read, taskRunId, taskStatus: String(task.status || ''),
      model, config, now: now(), applyEnabled, applyGate,
    });
  };

  /**
   * apply 阶段**唯一**的写消费者：把提案落成"下一轮规划的先验"。
   *
   * 它写什么、不写什么是这个阶段的核心约束（详见 `planPriorFromRecord`）：
   *   - 只处理 `minimal_plan_edit`（`similar_swap` 是方案二的事，no-op）；
   *   - 只写一行 `RDMD_PLAN_PRIOR_EVENT` 事件，**不碰任何图**；
   *   - `target` 没给全就 no-op，并把原因记进记录。
   *
   * 事件 id 是**任务族 + 写它的那条 run**（见 `planExecPlanPriorEventId`）：一族多条是有意的
   * —— 先验本来就是一条时间线。读者（下一个同类任务的规划轮）按族查询、取**最新**一条，
   * 因为那时它自己的 run id 还不存在，按 id 取唯一一条是取不到的。
   */
  const writePlanPrior = (record = {}) => {
    const eligibility = record?.apply?.eligibility || planPriorFromRecord(record);
    if (!eligibility.eligible || !eligibility.edit) {
      return { applied: false, reason: eligibility.reason || 'not_eligible', priorEventId: '', edit: null };
    }
    const familyId = String(record.taskFamilyId || '');
    if (!familyId) return { applied: false, reason: 'no_task_family', priorEventId: '', edit: null };
    const eventId = planExecPlanPriorEventId(familyId, record.taskRunId);
    try {
      store.recordTaskEvent({
        eventId,
        taskRunId: record.taskRunId,
        eventType: RDMD_PLAN_PRIOR_EVENT,
        actorId: 'reverse_detective',
        summary: `rdmd plan prior: ${eligibility.op} ${eligibility.edit.nodeId || eligibility.edit.edgeId || ''}`,
        payload: {
          version: RDMD_PLAN_EXEC_RECORD_VERSION,
          recordedAt: now(),
          taskFamilyId: familyId,
          taskFamily: record.taskFamily || null,
          sourceTaskRunId: String(record.taskRunId || ''),
          sourceGraphRevision: Number(record.graphRevision || 0),
          // 判据随产物一起落库：读这条先验的人应该能看见"它是凭什么被写下来的"。
          gate: record.applyGate || null,
          edit: eligibility.edit,
          op: eligibility.op,
          // 字面断言：这条先验**没有**改过任何图。写它的函数在代码里也不具备改图的能力。
          graphMutated: false,
        },
      });
    } catch (error) {
      logger?.warn('rdmd-plan-prior-write-failed', { error, data: { taskRunId: record.taskRunId } });
      return { applied: false, reason: 'write_failed', priorEventId: '', edit: eligibility.edit };
    }
    return { applied: true, reason: '', priorEventId: eventId, edit: eligibility.edit };
  };

  const persist = (record = {}) => {
    try {
      store.recordTaskEvent({
        eventId: planExecDriftEventId(record.taskRunId),
        taskRunId: record.taskRunId,
        eventType: 'rdmd_plan_exec_drift',
        actorId: 'reverse_detective',
        summary: `plan/exec drift: ${record.decision?.action || 'record_only'} (${record.decision?.reason || ''})`,
        payload: record,
      });
    } catch (error) {
      logger?.warn('rdmd-plan-exec-record-failed', { error, data: { taskRunId: record.taskRunId } });
    }
  };

  return {
    // 通道解析是**实时**的（见 `resolveConfig` 的注释）。返回值里不含 cloudInfer：
    // 那是个函数，把它塞进一个会被序列化/打日志的对象里没有好处。
    config: () => {
      const { cloudInfer, ...rest } = resolveConfig({});
      return { ...rest, cloudInfer: typeof cloudInfer === 'function' };
    },
    /** 只读诊断，供诊断面板/测试用：返回一条记录但不落库。 */
    async inspect(task = {}) {
      return evaluate(task);
    },
    /** 终态入口。吞掉一切异常 —— 它跑在别人的收尾路径里。 */
    async record({ task = null } = {}) {
      try {
        if (!task?.id || !enabledFor(task)) return null;
        const taskRunId = String(task.id);
        if (evaluated.has(taskRunId)) return null;
        if (evaluated.size >= EVALUATED_LIMIT) evaluated.clear();
        evaluated.add(taskRunId);
        const record = await evaluate(task);
        // 没有协作图 = 这个 run 根本没进过 uBuddy 的图（普通任务）。
        // 为它落一行 no_graph 只会把真正有图的诊断淹掉。
        if (record.status === 'no_graph') return record;
        // apply 的写入放在 persist **之前**：这样落库的那条记录里的 `apply` 说的是
        // **事实**（到底有没有写出先验、写成了什么 id），而不是一个事后补写的猜测。
        // 这也是 `planExecDriftRecord` 里把 `applied` 先写成 false + `reason:'pending'` 的原因。
        if (record.phase === 'apply') {
          record.apply = { ...(record.apply || {}), ...writePlanPrior(record) };
        }
        persist(record);
        // 影子后续在**落完本次记录之后**观察历史提案的结局。放在这里而不是 evaluate 里，
        // 是因为它是动作侧的事：诊断（record_only）路径不该因为"没人开动作位"而多读一次库。
        // 本次刚写的记录不会被自己观察到 —— 它的 revision 等于当前 revision，
        // 被 `revision <= proposalRevision` 挡住（见 recordShadowFollowUps 自律 1）。
        //
        // `apply` 阶段**同样要观察**：一旦升到 apply 就停掉观察，等于把度量冻在升级那一刻，
        // 而升级之后恰恰是最需要继续盯着的时期（此前这里判的是 `=== 'shadow'`）。
        if (record.phase !== 'record_only') {
          const read = store.readPlanExecGraphs({
            taskRunId: record.taskRunId, viewerUserId: String(task?.ownerUserId || ''), skipAuthorization: true,
          });
          recordShadowFollowUps({ read });
        }
        return record;
      } catch (error) {
        logger?.warn('rdmd-plan-exec-evaluate-failed', { error, data: { taskRunId: String(task?.id || '') } });
        return null;
      }
    },
  };
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function round(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1e6) / 1e6 : 0;
}

function text(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
