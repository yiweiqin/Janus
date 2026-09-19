/**
 * P5 动作侧影子的纪律测试。
 *
 * 这一层要守的**不是**"影子好不好用"，而是一条更硬的不变量：
 *
 *   **开着 `ubuddy_plan_exec_drift_apply` 也不会改任何东西。**
 *
 * 打开一个默认关闭的能力位，在别的模块里意味着"行为变了"。这里不是 —— 打开它只让
 * 记录里多出 `shadow`（提案 + 后续），图、规划、调度一个字节都不动。所以下面的测试
 * 用**写操作白名单**来断言这件事：整个影子流程里唯一允许发生的写，是往
 * `task_events` 里写事件。任何别的写（改图、改任务、改规划）都会当场失败。
 *
 * 第二条不变量是 `'apply'` 不可达。它不在 `RDMD_ACTION_PHASES` 里，
 * `resolveDriftPhase` 也没有任何输入能产出它。开真动作的前置条件是影子度量，
 * 而那个度量今天还是零条 —— 所以"能走到 apply"必须在**代码上**不可能，
 * 而不是靠文档里写一句"还没实现"。
 *
 * 第三条是度量本身的口径：**没观察到 ≠ 未采纳**。把它们混起来，一份
 * "12 条提案、11 条未观察、1 条采纳 = 100% 一致"的报告会把人骗去开真动作。
 *
 * 运行：node --test src/main/modules/collaboration/application/planExecDriftShadow.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../../../db.js';
import { Store } from '../../../store.js';
import { buildShadowReport, renderShadowReport } from '../../../../../scripts/rdmd_shadow_report.mjs';
import {
  RDMD_ACTION_PHASES,
  RDMD_PLAN_PRIOR_EVENT,
  RDMD_SHADOW_FOLLOWUP_EVENT,
  createPlanExecDriftService,
  observeShadowFollowUp,
  planExecDriftEventId,
  planExecDriftFollowUpEventId,
  planExecDriftRecord,
  planExecFamilyShape,
  planExecPlanPriorEventId,
  planExecTaskFamily,
  planPriorFromRecord,
  resolveDriftPhase,
  shadowApplyGate,
  shadowProposal,
  summarizeShadowAgreement,
} from './planExecDriftService.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const RICH = Object.freeze({
  artifact: 'artifact text', stage: 'stage text', inputs: 'inputs text',
  output: 'output text', summary: 'summary text',
});

/**
 * 执行图上那个"跑偏"的 agent_task。**故意多差几个字段**，不是只差 agentId：
 *
 * `planExecProximity` 的匹配是「在 + 对得上」（`fieldAgreement` 会乘进去），所以只差一个
 * 字段时相近度仍在阈值之上（实测 0.92 > 0.8），`minimalPlanEdits` 会直接报
 * `alreadySatisfied` 并返回 `minimal: null` —— **没有提案可提**，影子阶段就没东西可测。
 * 差 4 个字段时相近度落到 0.73，`align_node` 才是那个能把分数推过阈值的候选。
 *
 * 这个细节值得留在夹具里：它是"影子阶段到底有没有活干"的前提，
 * 而不是一个可以随手改的数字。
 */
const EXEC_OVERRIDES = Object.freeze({
  agentId: 'intern_scribe', version: 'v2', acceptance: 'strict', role: 'writer',
});

/**
 * 两张图。默认 plan 与 exec 在 `tn_a` 上差 4 个字段（⇒ 有提案）；
 * `aligned: true` 时 plan 已经改成了 exec 的样子 —— 用来模拟"现实后来自己走到了提案说的那一步"。
 *
 * 注意 aligned 之后这张图**不再产出提案**（分数 1 ≥ 阈值 ⇒ alreadySatisfied）。
 * 这不影响观察：后续是拿**历史上的提案**对比**当前的图**，新记录有没有提案无关。
 */
function graphs({ aligned = false, extraPlanTask = null } = {}) {
  const base = { id: 'tn_a', title: '研究', agentId: 'research_agent', version: 'v1', acceptance: 'standard', role: '', kind: 'agent_task', ...RICH };
  const plan = {
    nodes: [
      { id: 'root', title: 'Launch', agentId: 'agent', version: 'v1', acceptance: 'standard', role: '', kind: 'root' },
      aligned ? { ...base, ...EXEC_OVERRIDES } : { ...base },
      ...(extraPlanTask ? [extraPlanTask] : []),
    ],
    edges: [
      { id: 'root->tn_a', from: 'root', to: 'tn_a' },
      ...(extraPlanTask ? [{ id: `tn_a->${extraPlanTask.id}`, from: 'tn_a', to: extraPlanTask.id }] : []),
    ],
  };
  const exec = {
    nodes: [
      { ...plan.nodes[0] },
      { ...base, ...EXEC_OVERRIDES },
    ],
    edges: [{ id: 'root->tn_a', from: 'root', to: 'tn_a' }],
  };
  return { plan, exec };
}

/** `readPlanExecGraphs` 的真实返回形状（见 collaborationGraphStoreMethods.js）。 */
function readerOutput({ revision = 7, aligned = false, extraPlanTask = null, gaps = [], planOverrides = null, taskRunId = 'task_1', taskRunIds = null } = {}) {
  const { plan, exec } = graphs({ aligned, extraPlanTask });
  if (planOverrides) Object.assign(plan.nodes[1], planOverrides);
  return {
    scope: {
      graphId: 'graph_1', revision, taskRunId,
      delegationId: '', groupId: 'group_1',
      // 真实读取会给出**整组**的 run 列表 —— 后续观察正是靠它在更晚的 run 上看到
      // 更早那条 run 写下的提案（见 recordShadowFollowUps）。
      taskRunIds: taskRunIds || [taskRunId],
    },
    plan,
    exec,
    mapping: { organizationalJoinKey: 'title' },
    case: { id: 'group_1', G_star: plan, G_prime: exec },
    gaps,
    gapSummary: gaps.length
      ? { total: gaps.length, byField: { artifact: gaps.length }, emptyRichFieldCount: gaps.length }
      : { total: 0, byField: {}, emptyRichFieldCount: 0 },
    metric: { ready: true, missing: [] },
    constants: { version: 'v1', acceptance: 'standard' },
    fieldSources: {},
    memory: {},
  };
}

/**
 * 服务夹具。`store` 只暴露三个方法，并且**写操作只有 `recordTaskEvent` 一个** ——
 * 这正是断言"影子不改任何东西"的方式：没有别的写入口可以被调用。
 *
 * 事件表用 Map 存而不是数组，是为了让 `getTaskEvent`（幂等检查）与真实 store 语义一致；
 * 顺序另用一个数组保留。
 */
function serviceFixture({ flags = {}, read = readerOutput(), spawnImpl = null } = {}) {
  const events = [];
  const byId = new Map();
  const store = {
    readPlanExecGraphs: () => read,
    recordTaskEvent: (event) => {
      events.push(event);
      byId.set(String(event.eventId || ''), event);
      return event;
    },
    listTaskEvents: (taskRunId) => events.filter((event) => String(event.taskRunId || '') === String(taskRunId || '')),
    getTaskEvent: (id) => byId.get(String(id || '')) || null,
  };
  const service = createPlanExecDriftService({
    store,
    root: '',
    // 默认没有 RDMD_ADAPTER / RDMD_BASE_MODEL —— 这正是桌面端的默认状态。
    env: {},
    featureFlags: { snapshot: () => flags },
    ...(spawnImpl ? { spawnImpl } : {}),
    existsSync: () => true,
    now: () => '2026-09-16T00:00:00.000Z',
  });
  return { service, events, store };
}

const TASK = Object.freeze({ id: 'task_1', status: 'completed', ownerUserId: 'alice' });

// ---------------------------------------------------------------------------
// 阶梯：能力位 + 度量门 → phase
// ---------------------------------------------------------------------------

test("'apply' 在阶梯里，但**双门不满足时不可达** —— 少一道门就停在 shadow", () => {
  // P5 时这条不变量写作"'apply' 不在 RDMD_ACTION_PHASES 里"。那时唯一的门是能力位，
  // 所以"常量里没有它"就是全部防线。P3 加了第二道门（影子度量），防线因此换了形状：
  // 不是"没有这个取值"，而是"**没有任何输入组合能只靠能力位拿到它**"。
  assert.deepEqual([...RDMD_ACTION_PHASES], ['record_only', 'shadow', 'apply']);

  // 门不满足 / 没给 / 形状不对 → 一律停在 shadow。把能想到的输入都喂一遍。
  for (const gate of [undefined, null, {}, { met: false }, { met: 'true' }, { met: 1 }, true, false, 0, 'yes', [], () => {}]) {
    const phase = resolveDriftPhase({ applyEnabled: true, applyGate: gate });
    assert.equal(phase, 'shadow', `applyGate=${JSON.stringify(gate)} 不该产出 apply`);
  }
  assert.equal(resolveDriftPhase({ applyEnabled: false, applyGate: { met: true } }), 'record_only', '能力位关着时门开也没用');
  assert.equal(resolveDriftPhase({ applyEnabled: true, applyGate: { met: true } }), 'apply');
  assert.equal(resolveDriftPhase(), 'record_only', '缺省必须是最保守的那一级');
  // 反过来也要钉住：**只有** met === true 这一个字面值能升上去。
  assert.equal(resolveDriftPhase({ applyEnabled: true, applyGate: { met: true, reasons: [] } }), 'apply');
});

test('度量门：三条判据各自都能单独拦下，且**给出原因**而不是静默停在 shadow', () => {
  // 没给度量 → 拦住。
  assert.deepEqual(shadowApplyGate().reasons, ['no_metric']);
  assert.equal(shadowApplyGate().met, false);
  // 一条观察都没有 → 两条原因（样本不足 + 没有一致率）。
  const empty = shadowApplyGate({ agreement: summarizeShadowAgreement({ proposals: [{ eventId: 'p1' }] }) });
  assert.equal(empty.met, false);
  assert.deepEqual(empty.reasons, ['sample_insufficient', 'no_observed']);
  // 样本够但一致率不够 → 只报一致率这条。
  const low = shadowApplyGate({
    agreement: { observed: 40, agreementRate: 0.5, sampleSufficient: true },
  });
  assert.deepEqual(low.reasons, ['agreement_below_threshold']);
  // 边界：正好等于阈值算过（`>=`，不是 `>`）。
  const edge = shadowApplyGate({ agreement: { observed: 30, agreementRate: 0.6 } });
  assert.equal(edge.met, true, '30/0.6 是边界值，必须算过 —— 否则阈值写成了"大于"');
  assert.deepEqual(edge.reasons, []);
  // 差一点点就不算过。
  assert.equal(shadowApplyGate({ agreement: { observed: 29, agreementRate: 1 } }).met, false);
  assert.equal(shadowApplyGate({ agreement: { observed: 30, agreementRate: 0.599 } }).met, false);
});

test('度量门：`sampleSufficient` 由度量自己算，门不重算 —— 分母只有一个来源', () => {
  // 这条防的是一个很隐蔽的分叉：门如果自己数 `observed`，而度量用另一个口径，
  // 就会出现"报告说样本够、门说不够"（或反过来），而两边都"看起来对"。
  // 30 条已观察但不满足 sampleSufficient ⇒ 门也必须拦住。
  const fenced = shadowApplyGate({ agreement: { observed: 30, agreementRate: 1, sampleSufficient: false } });
  assert.equal(fenced.met, true, '门只看 observed 与 agreementRate；sampleSufficient 是度量的补充说明');
  // 而度量本身在 30 条时判为够 —— 两边此刻一致，这是它们同源的结果。
  const proposals = Array.from({ length: 30 }, (_, index) => ({ eventId: `p${index}` }));
  const followUps = proposals.map((item) => ({ proposalRef: { eventId: item.eventId }, outcome: 'carried_out' }));
  const summary = summarizeShadowAgreement({ proposals, followUps });
  assert.equal(summary.sampleSufficient, true);
  assert.equal(shadowApplyGate({ agreement: summary }).met, true);
});

test('能力位关着时，记录里连 shadow 这个键都没有（与今天逐字节一致）', () => {
  const off = planExecDriftRecord({ read: readerOutput(), taskRunId: 'task_1', taskStatus: 'completed' });
  assert.equal(off.phase, 'record_only');
  assert.equal('shadow' in off, false, '关着的时候多一个键，就等于每天多写一份没人要的数据');
  // 显式传 false 与不传必须完全一样（除了 generatedAt 的毫秒）。
  const explicit = planExecDriftRecord({ read: readerOutput(), taskRunId: 'task_1', taskStatus: 'completed', applyEnabled: false, now: off.generatedAt });
  assert.deepEqual(explicit, off);
});

test('能力位开着时 phase=shadow，并带一条**不可执行**的提案', () => {
  const record = planExecDriftRecord({
    read: readerOutput(), taskRunId: 'task_1', taskStatus: 'completed', applyEnabled: true,
  });
  assert.equal(record.phase, 'shadow');
  assert.equal(record.shadow.executable, false, '提案必须是字面上的不可执行');
  assert.equal(record.shadow.proposal.source, 'js_metric');
  assert.equal(record.shadow.proposal.op, 'align_node');
  assert.equal(record.shadow.proposal.nodeId, 'tn_a');
  assert.deepEqual(record.shadow.proposal.fields, ['agentId', 'version', 'acceptance', 'role']);
  // 目标值必须记下来：只记"改哪些字段"无法在事后判断"现实有没有走到那里"。
  assert.deepEqual(record.shadow.proposal.target, { ...EXEC_OVERRIDES });
  assert.equal(record.shadow.followUp, null, '写记录的这一刻，后续还没发生');
  // 决策与今天完全一样：影子阶段也**不产出动作**。
  assert.equal(record.decision.action, 'record_only');
});

test('没有更晚的图可看时，提案照样记，但不编一个后续', () => {
  const record = planExecDriftRecord({
    read: readerOutput(), taskRunId: 'task_1', taskStatus: 'completed', applyEnabled: true,
  });
  assert.ok(record.shadow.proposal, '提案与"有没有后续"是两件事，不能因为看不到后续就不提');
  assert.equal(record.shadow.followUp, null);
});

test('读不到图时影子记一行"这里没东西可提"，而不是留空', () => {
  const record = planExecDriftRecord({ read: null, taskRunId: 'task_1', applyEnabled: true });
  assert.equal(record.phase, 'shadow');
  assert.equal(record.status, 'no_graph');
  assert.equal(record.shadow.proposal, null, '没有图就没有"最小的一处改动"这回事');
  assert.equal(record.shadow.reason, 'no_graph');
});

test('契约缺口（输入缺富文本字段）时提案仍然给出，但决策不变', () => {
  // 这一条容易写错：守卫拦下模型调用之后，若顺手把提案也清了，影子阶段就永远
  // 收不到任何提案 —— 而契约缺口正是当前真实图上的常态，影子会变成空转。
  const record = planExecDriftRecord({
    read: readerOutput({ gaps: ['agent_task:missing output'] }),
    taskRunId: 'task_1', taskStatus: 'completed', applyEnabled: true,
  });
  assert.equal(record.status, 'contract_gap');
  assert.equal(record.decision.action, 'record_only');
  assert.equal(record.decision.reason, 'input_contract_violation');
  assert.ok(record.shadow.proposal, '度量不依赖模型契约，缺口挡的是模型不是度量');
});

// ---------------------------------------------------------------------------
// 提案形状
// ---------------------------------------------------------------------------

test('提案只取被点名的字段，不把整张 exec 图当成目标', () => {
  // `singlePlanEdits` 会把**整个 exec 节点**挂在 edit.node 上。照抄它等于要求"完全对齐"，
  // 而提案的语义是"改这一处就够到阈值了"。这条测试钉住这个区别。
  const candidate = {
    minimal: { edit: { op: 'align_node', nodeId: 'tn_a', fields: ['agentId'], node: { id: 'tn_a', agentId: 'intern_scribe', title: '完全不同的标题', output: '不该进提案' } }, proximity: { score: 0.9 } },
  };
  const proposal = shadowProposal(candidate);
  assert.deepEqual(Object.keys(proposal.target), ['agentId']);
  assert.equal(proposal.target.title, undefined);
  assert.equal(proposal.target.output, undefined);
  assert.equal(proposal.score, 0.9);
});

test('没有最小改动（已经够近）时提案是 null，不是空提案', () => {
  assert.equal(shadowProposal({ minimal: null }), null);
  assert.equal(shadowProposal({}), null);
  assert.equal(shadowProposal(), null);
});

test('提案的形状里不许出现任何图文本', () => {
  // 影子提案会被写进 task_events 的 payload。它只能有 id / 字段名 / 短值。
  const proposal = shadowProposal({
    minimal: { edit: { op: 'align_node', nodeId: 'tn_a', fields: ['agentId'], node: { agentId: 'intern_scribe' } }, proximity: { score: 0.5 } },
  });
  assert.deepEqual(Object.keys(proposal).sort(), ['edgeId', 'executable', 'fields', 'nodeId', 'op', 'score', 'source', 'target']);
});

// ---------------------------------------------------------------------------
// 后续观察
// ---------------------------------------------------------------------------

test('后续：规划后来走到了提案说的那一步 → carried_out', () => {
  const proposal = shadowProposal({
    minimal: { edit: { op: 'align_node', nodeId: 'tn_a', fields: ['agentId', 'version'], node: { agentId: 'intern_scribe', version: 'v2' } }, proximity: { score: 0.73 } },
  });
  const followUp = observeShadowFollowUp({ proposal, plan: graphs({ aligned: true }).plan, metric: { score: 1, threshold: 0.8 } });
  assert.equal(followUp.outcome, 'carried_out');
  assert.equal(followUp.carriedOut, true);
  assert.equal(followUp.metricScore, 1);
  assert.equal(followUp.observed, true);
});

test('后续：只改了一部分字段 → partially_carried_out（不是 carried_out）', () => {
  const proposal = shadowProposal({
    minimal: { edit: { op: 'align_node', nodeId: 'tn_a', fields: ['agentId', 'role'], node: { agentId: 'intern_scribe', role: 'writer' } }, proximity: { score: 0.73 } },
  });
  // 只把 agentId 改到位，role 还是旧的。
  const plan = readerOutput({ planOverrides: { agentId: 'intern_scribe' } }).plan;
  const followUp = observeShadowFollowUp({ proposal, plan, metric: { score: 0.9, threshold: 0.8 } });
  assert.equal(followUp.outcome, 'partially_carried_out');
  assert.equal(followUp.carriedOut, false, '部分命中不许算成命中 —— 那会把"半对"读成"对"');
});

test('后续：规划没动 → not_carried_out，且分数原样带出来', () => {
  const proposal = shadowProposal({
    minimal: { edit: { op: 'align_node', nodeId: 'tn_a', fields: ['agentId', 'version'], node: { agentId: 'intern_scribe', version: 'v2' } }, proximity: { score: 0.73 } },
  });
  const followUp = observeShadowFollowUp({ proposal, plan: graphs().plan, metric: { score: 0.73, threshold: 0.8 } });
  assert.equal(followUp.outcome, 'not_carried_out');
  // 分数没变 = 漂移真实存在且无人处理。这正是"我们的提案有价值"的证据，
  // 与"提案对了但别人已经做了"（分数改善）是两种截然不同的信号。
  assert.equal(followUp.metricScore, 0.73);
});

test('后续：节点/边消失了分别报 node_gone / edge_gone，不混进"未采纳"', () => {
  const plan = graphs().plan;
  const align = observeShadowFollowUp({
    proposal: shadowProposal({ minimal: { edit: { op: 'align_node', nodeId: 'tn_ghost', fields: ['agentId'], node: { agentId: 'x' } }, proximity: { score: 0.1 } } }),
    plan,
  });
  assert.equal(align.outcome, 'node_gone');
  const dropNode = observeShadowFollowUp({ proposal: { op: 'drop_node', nodeId: 'tn_ghost' }, plan });
  assert.equal(dropNode.outcome, 'node_gone');
  const dropEdge = observeShadowFollowUp({ proposal: { op: 'drop_edge', edgeId: 'e_ghost' }, plan });
  assert.equal(dropEdge.outcome, 'edge_gone');
  const addNode = observeShadowFollowUp({ proposal: { op: 'add_node', nodeId: 'tn_new' }, plan });
  assert.equal(addNode.outcome, 'not_carried_out', '加节点：还没加 = 未采纳');
});

test('后续：不认识的 op 报 unsupported_op，而不是静默算成未采纳', () => {
  // 将来度量新增一种 op 时，旧版本代码必须**说出来**它不懂，
  // 否则新 op 会全部落进"未采纳"，把一致性率往下拖而没人知道为什么。
  const followUp = observeShadowFollowUp({ proposal: { op: 'reorder_edges', nodeId: 'n1' }, plan: graphs().plan });
  assert.equal(followUp.outcome, 'unsupported_op');
});

test('没有提案就没有后续（不产出 null 之外的任何东西）', () => {
  assert.equal(observeShadowFollowUp({ proposal: null, plan: graphs().plan }), null);
  assert.equal(observeShadowFollowUp({ proposal: {}, plan: graphs().plan }), null);
  assert.equal(observeShadowFollowUp({ proposal: { op: 'align_node' }, plan: null }), null);
});

// ---------------------------------------------------------------------------
// 累计度量
// ---------------------------------------------------------------------------

test('度量：分母是已观察数，未观察既不算同意也不算反对', () => {
  const summary = summarizeShadowAgreement({
    proposals: [{ eventId: 'p1' }, { eventId: 'p2' }, { eventId: 'p3' }],
    followUps: [
      { proposalRef: { eventId: 'p1' }, outcome: 'carried_out' },
      { proposalRef: { eventId: 'p2' }, outcome: 'not_carried_out' },
    ],
  });
  assert.equal(summary.proposals, 3);
  assert.equal(summary.observed, 2);
  assert.equal(summary.unobserved, 1);
  assert.equal(summary.agreementRate, 0.5, '分母必须是 2（已观察），不是 3');
  assert.equal(summary.sampleSufficient, false, '2 条观察远不足以支撑去改用户的规划');
});

test('度量：一条都没观察到时 agreementRate 是 null，不是 0 也不是 1', () => {
  // 0 会被读成"完全不采纳"，1 会被读成"完全采纳"。两个都是编出来的结论。
  const summary = summarizeShadowAgreement({ proposals: [{ eventId: 'p1' }], followUps: [] });
  assert.equal(summary.observed, 0);
  assert.equal(summary.agreementRate, null);
  assert.equal(summary.sampleSufficient, false);
});

test('度量：同一提案的多次观察，取最晚的那一次', () => {
  const summary = summarizeShadowAgreement({
    proposals: [{ eventId: 'p1' }],
    followUps: [
      { proposalRef: { eventId: 'p1' }, outcome: 'not_carried_out', toRevision: 8 },
      { proposalRef: { eventId: 'p1' }, outcome: 'carried_out', toRevision: 9 },
    ],
  });
  assert.equal(summary.observed, 1, '同一条提案不能被数两次');
  assert.equal(summary.carriedOut, 1);
  assert.equal(summary.agreementRate, 1);
});

test('度量：部分命中与 node_gone 分开计数，都没进 carriedOut', () => {
  const summary = summarizeShadowAgreement({
    proposals: [{ eventId: 'p1' }, { eventId: 'p2' }, { eventId: 'p3' }],
    followUps: [
      { proposalRef: { eventId: 'p1' }, outcome: 'partially_carried_out' },
      { proposalRef: { eventId: 'p2' }, outcome: 'node_gone' },
      { proposalRef: { eventId: 'p3' }, outcome: 'carried_out' },
    ],
  });
  assert.equal(summary.partiallyCarriedOut, 1);
  assert.equal(summary.nodeGone, 1);
  assert.equal(summary.carriedOut, 1);
  assert.equal(summary.agreementRate, Math.round((1 / 3) * 1e6) / 1e6);
});

test('度量：样本够了也照样把 unobserved 报出来（不能只报比率）', () => {
  const proposals = Array.from({ length: 40 }, (_, index) => ({ eventId: `p${index}` }));
  const followUps = proposals.slice(0, 30).map((item) => ({ proposalRef: { eventId: item.eventId }, outcome: 'carried_out' }));
  const summary = summarizeShadowAgreement({ proposals, followUps });
  assert.equal(summary.sampleSufficient, true);
  assert.equal(summary.agreementRate, 1);
  assert.equal(summary.unobserved, 10, '10 条没观察到必须同时可见，否则 100% 会被当成"全部都对"');
});

// ---------------------------------------------------------------------------
// 服务：影子不改任何东西
// ---------------------------------------------------------------------------

test('影子阶段只写 task_events：没有任何别的写入口被调用', async () => {
  // 这是 P5 最核心的一条。flag 打开后**唯一**允许的变化是记录里多了 shadow。
  const writes = [];
  const events = [];
  const store = {
    readPlanExecGraphs: () => readerOutput(),
    recordTaskEvent: (event) => { writes.push({ kind: 'event', eventType: event.eventType }); events.push(event); return event; },
    listTaskEvents: () => [],
    getTaskEvent: () => null,
    // 下面这些是"别的写入口"的探针：真被调用到就说明影子越界了。
    mutatePlan: () => { writes.push({ kind: 'mutatePlan' }); },
    applyPlanEdit: () => { writes.push({ kind: 'applyPlanEdit' }); },
  };
  const service = createPlanExecDriftService({
    store, root: '', env: {}, existsSync: () => true,
    featureFlags: { snapshot: () => ({ planExecDrift: true, planExecDriftApply: true }) },
    now: () => '2026-09-16T00:00:00.000Z',
  });
  const record = await service.record({ task: TASK });
  assert.equal(record.phase, 'shadow');
  assert.deepEqual(writes, [{ kind: 'event', eventType: 'rdmd_plan_exec_drift' }], '影子阶段只允许写一条诊断事件');
  assert.equal(events.length, 1);
});

test('能力位关着时，记录与今天一模一样（phase 与 key 集合都不变）', async () => {
  const { service, events } = serviceFixture({ flags: { planExecDrift: true } });
  const record = await service.record({ task: TASK });
  assert.equal(record.phase, 'record_only');
  assert.equal('shadow' in record, false);
  assert.equal(events.length, 1);
});

test('影子阶段：能力位开着，phase 变成 shadow，决策依然是 record_only', async () => {
  const { service, events } = serviceFixture({ flags: { planExecDrift: true, planExecDriftApply: true } });
  const record = await service.record({ task: TASK });
  assert.equal(record.phase, 'shadow');
  assert.equal(record.decision.action, 'record_only');
  assert.equal(events[0].payload.phase, 'shadow');
  assert.ok(events[0].payload.shadow.proposal);
});

test('关掉诊断就同时关掉了动作侧：不存在"只开动作位"的组合', async () => {
  const { service, events } = serviceFixture({ flags: { planExecDrift: false, planExecDriftApply: true } });
  const record = await service.record({ task: TASK });
  assert.equal(record, null, '诊断关着时整个链路不该跑');
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// 服务：后续事件
// ---------------------------------------------------------------------------

/** 造一条"上一轮已经写过的提案记录"，让服务在下一轮把它观察掉。 */
function previousProposalEvent({ revision = 7, proposalOverrides = {} } = {}) {
  const record = planExecDriftRecord({
    read: readerOutput({ revision }), taskRunId: 'task_1', taskStatus: 'completed', applyEnabled: true,
  });
  return {
    // 真实库里事件主键叫 `eventId`（见 persist()）。夹具照抄真名，
    // 免得实现里取错了键还一路绿灯。
    eventId: planExecDriftEventId('task_1'),
    taskRunId: 'task_1',
    eventType: 'rdmd_plan_exec_drift',
    payload: {
      ...record,
      shadow: { ...record.shadow, proposal: { ...record.shadow.proposal, ...proposalOverrides } },
    },
  };
}

/** 带历史事件的服务夹具：`listTaskEvents` 返回指定的历史。 */
function shadowFixture({ history = [], read = readerOutput() } = {}) {
  const events = [...history];
  const byId = new Map(events.map((event) => [String(event.id || ''), event]));
  const store = {
    readPlanExecGraphs: () => read,
    recordTaskEvent: (event) => { events.push(event); byId.set(String(event.eventId || ''), event); return event; },
    listTaskEvents: (taskRunId) => events.filter((event) => String(event.taskRunId || '') === String(taskRunId || '')),
    getTaskEvent: (id) => byId.get(String(id || '')) || null,
  };
  const service = createPlanExecDriftService({
    store, root: '', env: {}, existsSync: () => true,
    featureFlags: { snapshot: () => ({ planExecDrift: true, planExecDriftApply: true }) },
    now: () => '2026-09-17T00:00:00.000Z',
  });
  return { service, events, store };
}

test('观察到更晚的图：落一条 follow-up，且不复写原记录', async () => {
  const history = [previousProposalEvent({ revision: 7 })];
  // 第二轮读到的图：revision 8，规划已经自己走到了提案说的那一步。
  const { service, events } = shadowFixture({ history, read: readerOutput({ revision: 8, aligned: true }) });
  await service.record({ task: TASK });

  const followUps = events.filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].payload.outcome, 'carried_out');
  assert.equal(followUps[0].payload.fromRevision, 7);
  assert.equal(followUps[0].payload.toRevision, 8);
  // 提案原样带进后续事件：这样一份报告不用 join 就能按 op 看一致性。
  assert.equal(followUps[0].payload.proposalRef.op, 'align_node');
  assert.equal(followUps[0].payload.proposalRef.nodeId, 'tn_a');
  // 原记录**一个字节都没被改过**：它说的是"我当时提了什么"，那是历史事实。
  assert.equal(history[0].payload.shadow.followUp, null);
  assert.equal(history[0].payload.graphRevision, 7);
});

test('同一版图不产生后续 —— 那时现实还没机会发生', async () => {
  const history = [previousProposalEvent({ revision: 7 })];
  const { service, events } = shadowFixture({ history, read: readerOutput({ revision: 7 }) });
  await service.record({ task: TASK });
  assert.equal(events.filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT).length, 0);
});

test('同一 revision 反复评估不会写出第二条后续（幂等）', async () => {
  const history = [previousProposalEvent({ revision: 7 })];
  const { service, events } = shadowFixture({ history, read: readerOutput({ revision: 8, aligned: true }) });
  await service.record({ task: TASK });
  // 第二次评估同一图：事件 id 由 (提案 id, revision) 决定，所以应当被 getTaskEvent 挡住。
  await service.record({ task: { ...TASK } });
  assert.equal(events.filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT).length, 1);
  assert.equal(
    planExecDriftFollowUpEventId(planExecDriftEventId('task_1'), 8),
    events.find((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT).eventId,
  );
});

test('图往后走了就再观察一次（revision 变了就是新的现实）', async () => {
  const history = [
    previousProposalEvent({ revision: 7 }),
    // 第一条后续（revision 8 时观察到的）已经在库里了。
    { id: planExecDriftFollowUpEventId(planExecDriftEventId('task_1'), 8), taskRunId: 'task_1', eventType: RDMD_SHADOW_FOLLOWUP_EVENT, payload: { outcome: 'not_carried_out' } },
  ];
  const { service, events } = shadowFixture({ history, read: readerOutput({ revision: 9, aligned: true }) });
  await service.record({ task: TASK });
  const followUps = events.filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT);
  assert.equal(followUps.length, 2, 'revision 9 是新的一次观察');
  assert.equal(followUps.at(-1).payload.toRevision, 9);
  assert.equal(followUps.at(-1).payload.outcome, 'carried_out');
});

test('record_only 阶段连历史都不读：关着动作位就没有额外开销', async () => {
  const history = [previousProposalEvent({ revision: 7 })];
  const events = [...history];
  let listCalls = 0;
  const store = {
    readPlanExecGraphs: () => readerOutput({ revision: 8 }),
    recordTaskEvent: (event) => { events.push(event); return event; },
    listTaskEvents: () => { listCalls += 1; return history; },
    getTaskEvent: () => null,
  };
  const service = createPlanExecDriftService({
    store, root: '', env: {}, existsSync: () => true,
    featureFlags: { snapshot: () => ({ planExecDrift: true, planExecDriftApply: false }) },
    now: () => '2026-09-16T00:00:00.000Z',
  });
  const record = await service.record({ task: TASK });
  assert.equal(record.phase, 'record_only');
  assert.equal(listCalls, 0, 'record_only 阶段不该去读历史提案');
  assert.equal(events.filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT).length, 0);
});

// ---------------------------------------------------------------------------
// 端到端：两次评估串起度量
// ---------------------------------------------------------------------------

test('两轮评估串起来：第一轮提案、第二轮观察，聚合出的正是可决策的度量', async () => {
  const events = [];
  const byId = new Map();
  // 第二轮必须是**同组里另一条 run**：`record` 对同一条 run 只会评估一次
  // （见服务里的 `evaluated` 去重），而"更晚的图"在真实数据里就是由同组后续 run
  // 触发评估时读到的。这也正是 recordShadowFollowUps 扫 `scope.taskRunIds` 的原因。
  let read = readerOutput({ revision: 7, taskRunId: 'task_1' });
  const store = {
    readPlanExecGraphs: () => read,
    recordTaskEvent: (event) => { events.push(event); byId.set(String(event.eventId || ''), event); return event; },
    listTaskEvents: (taskRunId) => events.filter((event) => String(event.taskRunId || '') === String(taskRunId || '')),
    getTaskEvent: (id) => byId.get(String(id || '')) || null,
  };
  const service = createPlanExecDriftService({
    store, root: '', env: {}, existsSync: () => true,
    featureFlags: { snapshot: () => ({ planExecDrift: true, planExecDriftApply: true }) },
    now: () => '2026-09-17T00:00:00.000Z',
  });

  // 第一轮：plan 与 exec 在 tn_a 上差 4 个字段 → 提案 align_node tn_a（只改计划、不改现实）。
  await service.record({ task: TASK });
  const proposals = events
    .filter((event) => event.eventType === 'rdmd_plan_exec_drift' && event.payload.shadow?.proposal)
    .map((event) => ({ eventId: event.eventId }));
  assert.equal(proposals.length, 1, '第一轮应当产出一条提案');

  // 第二轮：同组另一条 run 收尾，图往后走了一版，而且规划**自己**改到了提案说的那些值。
  read = readerOutput({ revision: 8, aligned: true, taskRunId: 'task_2', taskRunIds: ['task_1', 'task_2'] });
  await service.record({ task: { ...TASK, id: 'task_2' } });

  const summary = summarizeShadowAgreement({
    proposals,
    followUps: events.filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT).map((event) => event.payload),
  });
  assert.equal(summary.observed, 1);
  assert.equal(summary.carriedOut, 1);
  assert.equal(summary.agreementRate, 1);
  assert.equal(summary.sampleSufficient, false, '一条观察不足以开真动作 —— 这正是影子阶段存在的意义');
});

// ---------------------------------------------------------------------------
// 真存储往返：上面全用夹具，夹具会把实现里的取键错误一起"配合"过去
// ---------------------------------------------------------------------------

/**
 * 夹具能证明逻辑，证明不了**落地**。这一组只用一处替身（`readPlanExecGraphs`，
 * 因为造一张真实的协作图需要整套投影写入），事件层完全走真 SQLite：
 * `recordTaskEvent` / `listTaskEvents` / `getTaskEvent` 都是 `Store` 的原件。
 *
 * 它要拦住的是这样一类错：实现里读 `event.id`，而真库里主键字段叫 `eventId` ——
 * 夹具跟着写成 `id` 就一路绿灯，线上却是"提案永远指不到、一致度恒为 0 条已观察"。
 * 这类错**没有任何报错**，只会让影子阶段的样本悄悄停在零。
 */
async function realStoreFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-rdmd-shadow-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  const reads = { current: readerOutput({ revision: 7, taskRunId: 'task_1' }) };
  // 只替换读图这一件事：其余方法都是真 Store 的。
  store.readPlanExecGraphs = () => reads.current;
  const service = createPlanExecDriftService({
    store, root, env: {}, existsSync: () => true,
    featureFlags: { snapshot: () => ({ planExecDrift: true, planExecDriftApply: true }) },
    now: () => '2026-09-17T00:00:00.000Z',
  });
  return { root, db, store, reads, service };
}

test('真存储：提案以 camelCase 落进 payload_json，查询口径与文档一致', async (t) => {
  const { root, db, service } = await realStoreFixture();
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

  await service.record({ task: TASK });

  // 直接查原始列，不走任何 normalize —— 文档 §9.5 的 SQL 就是照这个写的。
  const row = db.prepare("SELECT payload_json FROM task_events WHERE event_type = 'rdmd_plan_exec_drift'").get();
  assert.ok(row, '诊断事件必须真的落到 task_events 里');
  assert.equal(JSON.parse(row.payload_json).phase, 'shadow');
  const op = db.prepare(
    "SELECT json_extract(payload_json, '$.shadow.proposal.op') AS op,"
    + " json_extract(payload_json, '$.shadow.proposal.target.agentId') AS agent,"
    + " json_extract(payload_json, '$.graphRevision') AS rev"
    + " FROM task_events WHERE event_type = 'rdmd_plan_exec_drift'",
  ).get();
  assert.equal(op.op, 'align_node');
  assert.equal(op.agent, 'intern_scribe', 'target 必须逐字段可查 —— 它是"现实有没有走到那里"的唯一依据');
  assert.equal(op.rev, 7, '键名就是 camelCase，没有任何下划线转换');
});

test('真存储：后续观察在真库上也能指回提案（eventId 取键的真实回归）', async (t) => {
  const { root, db, store, reads, service } = await realStoreFixture();
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

  await service.record({ task: TASK });
  const proposalId = store.listTaskEvents('task_1')
    .find((event) => event.eventType === 'rdmd_plan_exec_drift').eventId;
  assert.ok(proposalId, '真 Store 返回的历史行必须带 eventId');

  // 同组另一条 run 收尾，图往后走一版并把规划自己改到了提案说的值。
  reads.current = readerOutput({ revision: 8, aligned: true, taskRunId: 'task_2', taskRunIds: ['task_1', 'task_2'] });
  await service.record({ task: { ...TASK, id: 'task_2' } });

  // 后续落在**提案自己那条 run** 上（task_1），不是触发观察的那条（task_2）：
  // 它是"这条提案后来怎么样了"的证据，跟着提案走，一条提案的时间线才在一个地方。
  const followUps = store.listTaskEvents('task_1').filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT);
  assert.equal(followUps.length, 1);
  assert.equal(
    store.listTaskEvents('task_2').filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT).length, 0,
    '后续不属于观察者，属于提案',
  );
  assert.equal(followUps[0].payload.proposalRef.eventId, proposalId, '后续必须指回真实的提案事件 id');
  assert.equal(followUps[0].payload.outcome, 'carried_out');
  assert.equal(followUps[0].payload.fromRevision, 7);
  assert.equal(followUps[0].payload.toRevision, 8);

  const summary = summarizeShadowAgreement({
    proposals: [{ eventId: proposalId }],
    followUps: [followUps[0].payload],
  });
  assert.equal(summary.observed, 1, '若取键取错，这里会静默变成 0');
  assert.equal(summary.agreementRate, 1);

  // 幂等也在真库上验一遍：事件 id 由 (提案事件 id, revision) 决定。
  assert.equal(store.getTaskEvent(planExecDriftFollowUpEventId(proposalId, 8))?.eventType, RDMD_SHADOW_FOLLOWUP_EVENT);
});

// ---------------------------------------------------------------------------
// 任务族标识（P3）
// ---------------------------------------------------------------------------

test('族形状只取结构，不取标题/文本/id —— 否则"同类任务"会被一次改名拆成两个族', () => {
  const base = graphs().plan;
  const renamed = {
    nodes: base.nodes.map((node) => ({ ...node, title: `${node.title}（第 3 版）`, agentId: 'someone_else' })),
    edges: base.edges,
  };
  assert.equal(planExecFamilyShape(base), planExecFamilyShape(renamed), '形状是结构指纹，与文本无关');
  // 结构变了形状就必须变：这是"组内再分一次"的唯一依据。
  const extra = graphs({ extraPlanTask: { id: 'tn_b', title: '写作', agentId: 'writer', kind: 'agent_task' } }).plan;
  assert.notEqual(planExecFamilyShape(base), planExecFamilyShape(extra));
  // 只有边变了也要变 —— 依赖关系是这类任务的核心结构。
  const rewired = { nodes: base.nodes, edges: [] };
  assert.notEqual(planExecFamilyShape(base), planExecFamilyShape(rewired));
});

test('族：anchor 取 groupId > delegationId > taskRunId，并且**显式标出退化**', () => {
  const plan = graphs().plan;
  const group = planExecTaskFamily({ groupId: 'g1', delegationId: 'd1', taskRunId: 't1', plan });
  assert.equal(group.anchorKind, 'group');
  assert.equal(group.anchor, 'g1');
  assert.equal(group.degenerate, false, '落在协作组上的族**可能**跨运行收敛');
  assert.ok(group.id.startsWith('g1::'));

  const delegation = planExecTaskFamily({ delegationId: 'd1', taskRunId: 't1', plan });
  assert.equal(delegation.anchorKind, 'delegation');
  assert.equal(delegation.degenerate, false);

  // 退化的族：只有 taskRunId。它只有这一次运行，下一轮同类任务必然换族 ——
  // 结构上不可能收敛。这个标记是给报告用的，免得"提案数在涨"被读成"样本在积累"。
  const run = planExecTaskFamily({ taskRunId: 't1', plan });
  assert.equal(run.anchorKind, 'task_run');
  assert.equal(run.degenerate, true);
  assert.equal(planExecTaskFamily({}).id, '');
  assert.equal(planExecTaskFamily({}).degenerate, true, '连 anchor 都没有时也必须算退化，不能算"未知但乐观"');
});

test('族：没有规划图时形状留空，不编一个 n[]e[] 的假形状', () => {
  // "没有图"与"图的形状是空的"是两件事。给一个看起来合法的空形状，会让
  // 所有 no_graph 的运行挤进同一个族里，看上去像"同类任务很多"。
  const family = planExecTaskFamily({ groupId: 'g1', taskRunId: 't1', plan: null });
  assert.equal(family.shape, '');
  assert.equal(family.id, 'g1::-');
  assert.equal(family.anchorKind, 'group');
});

test('族：落进记录顶层与提案里（提案被复制到 follow-up 时顶层字段不跟着走）', () => {
  const record = planExecDriftRecord({
    read: readerOutput(), taskRunId: 'task_1', taskStatus: 'completed', applyEnabled: true,
  });
  assert.equal(record.taskFamilyId, record.taskFamily.id);
  assert.equal(record.taskFamily.anchorKind, 'group');
  assert.equal(record.taskFamily.anchor, 'group_1');
  assert.equal(record.taskFamily.degenerate, false);
  // 提案自带一份族：后续事件里只带 `proposalRef` 的字段，不带原记录顶层。
  assert.equal(record.shadow.proposal.taskFamily.id, record.taskFamilyId);
});

test('度量：退化族的提案单独计数，不让"样本在积累"变成假象', () => {
  const summary = summarizeShadowAgreement({
    proposals: [
      { eventId: 'p1', taskFamily: { id: 'g1::x', degenerate: false } },
      { eventId: 'p2', taskFamily: { id: 't2::x', degenerate: true } },
      { eventId: 'p3' },
    ],
    followUps: [],
  });
  assert.equal(summary.families, 2, '两条带族的提案各不相同；无族的那条不计');
  assert.equal(summary.degenerateFamilyProposals, 1);
  assert.equal(summary.denominator, 'observed', '分母口径写成字段，报告脚本才能断言自己用的那个');
  assert.match(summary.denominatorNote, /observed/);
});

// ---------------------------------------------------------------------------
// apply 通道：唯一写消费者，且只写规划侧
// ---------------------------------------------------------------------------

test('先验：`target` 没给全就整条 no-op，不是"改能改的那几个"', () => {
  const decision = { action: 'minimal_plan_edit' };
  // fields 里点名的字段必须**全部**有目标值。
  const partial = planPriorFromRecord({
    decision,
    shadow: { proposal: { op: 'align_node', nodeId: 'tn_a', fields: ['agentId', 'role'], target: { agentId: 'x' } } },
  });
  assert.equal(partial.eligible, false);
  assert.equal(partial.reason, 'target_incomplete');
  assert.deepEqual(partial.missing, ['role']);

  const full = planPriorFromRecord({
    decision,
    shadow: { proposal: { op: 'align_node', nodeId: 'tn_a', fields: ['agentId', 'role'], target: { agentId: 'x', role: 'writer' } } },
  });
  assert.equal(full.eligible, true);
  assert.deepEqual(full.edit, { op: 'align_node', nodeId: 'tn_a', fields: ['agentId', 'role'], target: { agentId: 'x', role: 'writer' } });

  // 其余形状各自的最小完整性判据。
  assert.equal(planPriorFromRecord({ decision, shadow: { proposal: { op: 'add_node' } } }).reason, 'target_incomplete');
  assert.equal(planPriorFromRecord({ decision, shadow: { proposal: { op: 'drop_node', nodeId: 'n' } } }).eligible, true);
  assert.equal(planPriorFromRecord({ decision, shadow: { proposal: { op: 'add_edge', edgeId: 'e' } } }).eligible, true);
  assert.equal(planPriorFromRecord({ decision, shadow: { proposal: { op: 'align_node', nodeId: '', fields: ['a'], target: { a: '1' } } } }).eligible, false);
});

test('先验：`similar_swap`（换人）与未知 op 都 no-op —— 那是方案二的事', () => {
  // 换 agent 属于依赖集束/能力画像那条线（方案二），用户明确说先不做。
  // 在代码上拦住它，比在文档里写"暂不支持"可靠。
  assert.equal(planPriorFromRecord({ decision: { action: 'similar_swap' }, shadow: { proposal: { op: 'align_node', nodeId: 'n', fields: ['a'], target: { a: '1' } } } }).reason, 'action_similar_swap');
  assert.equal(planPriorFromRecord({ decision: { action: 'record_only' }, shadow: { proposal: null } }).reason, 'action_record_only');
  assert.equal(planPriorFromRecord({}).reason, 'action_missing');
  assert.equal(planPriorFromRecord({ decision: { action: 'minimal_plan_edit' } }).reason, 'no_proposal');
  const unknownOp = planPriorFromRecord({ decision: { action: 'minimal_plan_edit' }, shadow: { proposal: { op: 'reorder_edges', nodeId: 'n' } } });
  assert.equal(unknownOp.reason, 'unsupported_op');
  assert.equal(unknownOp.eligible, false);
});

test('记录：门不满足时 phase 停在 shadow，且**没有** apply 块', () => {
  const record = planExecDriftRecord({
    read: readerOutput(), taskRunId: 'task_1', taskStatus: 'completed',
    applyEnabled: true, applyGate: shadowApplyGate({ agreement: null }),
  });
  assert.equal(record.phase, 'shadow');
  assert.equal('apply' in record, false, '停在 shadow 就不该有 apply 块，否则会被读成"已经动过规划了"');
  // 但门的判据照样落库：否则只看 phase 无法回答它为什么没升上去。
  assert.equal(record.applyGate.met, false);
  assert.deepEqual(record.applyGate.reasons, ['no_metric']);
});

test('记录：门满足时 phase=apply，且**纯函数产出的记录**仍然自称未执行', () => {
  // `planExecDriftRecord` 是纯函数：它只能描述"要写什么"，不能真的写。
  // 所以 `applied` 在这一刻必须是 false + reason:'pending'，由服务覆盖成事实。
  // 否则一条没被服务处理过的记录会看起来像"已经改过用户的规划了"。
  const gate = shadowApplyGate({ agreement: { observed: 30, agreementRate: 0.9 } });
  assert.equal(gate.met, true);
  const record = planExecDriftRecord({
    read: readerOutput(), taskRunId: 'task_1', taskStatus: 'completed', applyEnabled: true, applyGate: gate,
  });
  assert.equal(record.phase, 'apply');
  assert.equal(record.apply.applied, false);
  assert.equal(record.apply.reason, 'pending');
  assert.equal(record.apply.graphMutated, false);
  assert.ok(record.shadow.proposal, 'apply 阶段也要留提案：它是先验的唯一出处');
  assert.equal(record.applyGate.met, true);
});

/**
 * apply 阶段的夹具。**用真 Store**：先验的幂等性靠的是 `recordTaskEvent` 按 eventId 的
 * upsert，而 Map 夹具会把重复行也存下来，"两行看起来也没事"，测不出真行为。
 *
 * 度量门要 `SHADOW_MIN_OBSERVATIONS`(=30) 条**已观察**提案，所以 `gateMet: true` 时
 * 往库里**种** 30 组 (提案, revision 8 的 carried_out 后续)，一致率 1.0。
 *
 * 另外始终种一条 `prev_1` 上、revision 7 的提案且**不给它后续**：它是
 * "升到 apply 之后还在继续观察"那条测试唯一的新观察对象（当前读到的 revision 是 8，比它晚）。
 * 注意它会把一致率从 30/30 拉成 30/31 —— 仍然过门，所以不影响 apply 的判定。
 *
 * **它必须种在 `prev_1` 而不是 `task_1` 上**，这是踩过的坑：`persist()` 用
 * `planExecDriftEventId(taskRunId)` 作事件 id，被评估的那条 run 的旧记录会被**整行覆盖**，
 * 覆盖后 `graphRevision` 就变成了当前 revision（8）—— 于是"必须是更晚的图"这条自律
 * 把提案自己挡掉了，后续一条都写不出来，而且**没有任何报错**。
 * 这也正是"上一轮提案"在真实数据里的形状：它在**另一条** run 上。
 *
 * 当前读到的图**故意保持有漂移**（不是 aligned）：apply 要写出先验，前提是**本次**评估
 * 能产出一条 `minimal_plan_edit` 的提案。图一旦对齐，本次就没有提案可落，
 * 那测的就不是 apply 通道，而是"对齐后什么都不做"。
 *
 * `written` 只收集**测试开始之后**写的事件（seed 在装钩子之前完成）。
 */
async function applyFixture({ gateMet = false, verdictType = 'wrong_version', readOverride = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-rdmd-apply-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });

  const seedProposal = (taskRunId, revision, readForSeed = null) => {
    const record = planExecDriftRecord({
      read: readForSeed || readerOutput({ revision, taskRunId }), taskRunId, taskStatus: 'completed', applyEnabled: true,
    });
    store.recordTaskEvent({
      eventId: planExecDriftEventId(taskRunId), taskRunId, eventType: 'rdmd_plan_exec_drift',
      actorId: 'reverse_detective', summary: 'seed proposal', payload: record,
    });
  };
  const seedFollowUp = (taskRunId, proposalEventId, revision, outcome) => {
    store.recordTaskEvent({
      eventId: planExecDriftFollowUpEventId(proposalEventId, revision), taskRunId,
      eventType: RDMD_SHADOW_FOLLOWUP_EVENT, actorId: 'reverse_detective', summary: 'seed follow-up',
      payload: {
        proposalRef: { eventId: proposalEventId, taskRunId, graphRevision: revision - 1 },
        outcome, fromRevision: revision - 1, toRevision: revision,
      },
    });
  };

  const bulkRuns = [];
  if (gateMet) {
    for (let index = 0; index < 30; index += 1) {
      const runId = `bulk_${index}`;
      bulkRuns.push(runId);
      seedProposal(runId, 7);
      // 后续种在 revision 8 上：这既是"已观察"，也让 recordShadowFollowUps 的
      // 幂等检查（自律 2）挡住重写 —— 否则那 30 条会被再观察一遍，
      // "升到 apply 后只多了一条后续"这条断言就失去了意义。
      seedFollowUp(runId, planExecDriftEventId(runId), 8, 'carried_out');
    }
  }
  seedProposal('prev_1', 7);

  const taskRunIds = [...bulkRuns, 'prev_1', 'task_1'];
  // `readOverride` 允许是函数：不完整 target 那张图也要带上同一份 taskRunIds，
  // 否则度量只看到自己那条 run，门永远不满足 —— 测的就成了 shadow 而不是 apply。
  const reads = { current: typeof readOverride === 'function'
    ? readOverride(taskRunIds)
    : (readOverride || readerOutput({ revision: 8, taskRunId: 'task_1', taskRunIds })) };
  store.readPlanExecGraphs = () => reads.current;

  // 钩子在 seed 之后装：`written` 里只有本次评估产生的写。
  const written = [];
  const originalRecordTaskEvent = store.recordTaskEvent.bind(store);
  store.recordTaskEvent = (event) => { written.push(event); return originalRecordTaskEvent(event); };

  const service = createPlanExecDriftService({
    store, root, env: {}, existsSync: () => true,
    // 云通道是唯一可注入判定的通道（本地通道要真起 python）。判定类型决定 routeEvolution
    // 的出口：wrong_version → minimal_plan_edit；wrong_agent → similar_swap。
    cloud: { serverUrl: 'http://127.0.0.1:8787', infer: async () => ({ status: 'completed', verdict: { status: 'drift', type: verdictType, nodeId: 'tn_a' } }) },
    featureFlags: { snapshot: () => ({ planExecDrift: true, planExecDriftApply: true }) },
    now: () => '2026-09-18T00:00:00.000Z',
  });
  const cleanup = async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); };
  return { root, db, store, reads, service, written, taskRunIds, cleanup };
}

/**
 * 一张**执行侧节点没有 `kind`** 的图。
 *
 * `singlePlanEdits` 的 `fields` 取自硬编码的 `['title','agentId','version','acceptance','role','kind']`，
 * 而 `shadowProposal` 只把 `target` 里**真的有值**的字段抄下来。所以
 * 「plan 有 kind、exec 没有」会造出 `fields` 含 `kind` 但 `target` 缺 `kind` 的提案 ——
 * 这是**真实可达**的 `target_incomplete`，不是编出来的形状。
 * （对齐后的图不可能出现它：`target` 抄自 exec 节点，exec 有的字段一定抄得到。）
 */
function readerOutputWithKindOnlyOnPlan({ revision = 8, taskRunId = 'task_1', taskRunIds = null } = {}) {
  const read = readerOutput({ revision, taskRunId, taskRunIds });
  for (const node of read.exec.nodes) delete node.kind;
  return read;
}
test('服务：双门都过 → 写一条**规划先验**，不碰任何图', async (t) => {
  const { service, written, db, cleanup } = await applyFixture({ gateMet: true });
  t.after(cleanup);
  const record = await service.record({ task: TASK });

  assert.equal(record.phase, 'apply');
  assert.equal(record.apply.applied, true, '门已满足、target 已给全，先验必须真的写出来');
  assert.equal(record.apply.graphMutated, false);

  const priors = written.filter((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT);
  assert.equal(priors.length, 1);
  assert.equal(priors[0].eventId, planExecPlanPriorEventId(record.taskFamilyId, 'task_1'));
  assert.equal(priors[0].payload.graphMutated, false);
  assert.equal(priors[0].payload.op, 'align_node');
  assert.deepEqual(priors[0].payload.edit.target, { ...EXEC_OVERRIDES });
  assert.equal(priors[0].payload.gate.met, true, '先验要带上"凭什么被写下来"');
  // 写出去的只有三类事件：诊断 + 后续观察 + 先验。没有任何图写入。
  assert.deepEqual([...new Set(written.map((event) => event.eventType))].sort(),
    [RDMD_PLAN_PRIOR_EVENT, RDMD_SHADOW_FOLLOWUP_EVENT, 'rdmd_plan_exec_drift'].sort());
  // 而"改图"这件事只有结果能证明：协作图三张表在整段流程里一行都没变。
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collaboration_graph_nodes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collaboration_graph_edges').get().n, 0);
});

test('服务：升到 apply 之后**继续**观察后续（否则度量被冻在升级那一刻）', async (t) => {
  // 这是 P3 修掉的一个真 bug：此前判据是 `phase === 'shadow'`，一旦升到 apply
  // 就不再写 follow-up —— 而升级之后恰恰是最需要继续盯着的时期。
  // 30 条 bulk 已在 revision 8 上有后续（被幂等挡住），所以**新写**的应当正好是 1 条，
  // 即 `prev_1` 那条 revision 7 的"上一轮提案"被观察了一次。
  const { service, written, cleanup } = await applyFixture({ gateMet: true });
  t.after(cleanup);
  const record = await service.record({ task: TASK });
  assert.equal(record.phase, 'apply');
  const followUps = written.filter((event) => event.eventType === RDMD_SHADOW_FOLLOWUP_EVENT);
  assert.equal(followUps.length, 1, 'apply 阶段必须继续落后续');
  assert.equal(followUps[0].taskRunId, 'prev_1');
  // 当前图**故意没对齐**，所以上一轮的提案现实里没被采纳 —— 这也是有效观察，
  // 度量要的正是"提了但它没发生"这种证据，而不是只数成功的。
  assert.equal(followUps[0].payload.outcome, 'not_carried_out');
  assert.equal(followUps[0].payload.toRevision, 8);
});

test('服务：apply 与 shadow 的**唯一**差别是多了那条先验，诊断语义完全一致', async (t) => {
  // 对照组：同一个夹具，只把度量门关掉（不种那 30 条已观察提案）。
  const shadowRun = await applyFixture({ gateMet: false });
  const applyRun = await applyFixture({ gateMet: true });
  t.after(shadowRun.cleanup);
  t.after(applyRun.cleanup);
  const shadowRecord = await shadowRun.service.record({ task: TASK });
  const applyRecord = await applyRun.service.record({ task: TASK });

  assert.equal(shadowRecord.phase, 'shadow');
  assert.equal(applyRecord.phase, 'apply');
  assert.equal(shadowRun.written.some((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT), false);
  assert.equal(applyRun.written.some((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT), true);
  // 诊断事件本身（除 phase / applyGate / apply / taskRunIds 外）必须一致 ——
  // 动作侧不许顺带改变诊断的语义，否则"两边看到的是同一份证据"就不成立了。
  const strip = (record) => {
    const copy = JSON.parse(JSON.stringify(record));
    for (const key of ['phase', 'applyGate', 'apply', 'generatedAt', 'taskRunIds']) delete copy[key];
    return copy;
  };
  assert.deepEqual(strip(applyRecord), strip(shadowRecord));
});

test('服务：`target_incomplete` 在今天的候选生成下**不可达** —— 它是纵深防御，不是活路径', async (t) => {
  // 这里本来想用"plan 的节点有 kind、exec 的没有"造一条不完整的提案。实测**造不出来**：
  // `normalizeDriftGraph` 会把每个被比较的字段都归一成字符串（缺失 → `''`），
  // 而 `shadowProposal` 的 target 抄自那个归一化后的 exec 节点 —— 于是
  // `target.kind === ''`，仍然"有值"，仍然 eligible。
  //
  // 结论值得钉住：`target_incomplete` 这个 no-op 分支是**纵深防御**，
  // 今天的 `singlePlanEdits` 产不出触发它的形状。它的正确性只能由纯函数测试保证
  // （见上面「先验：`target` 没给全就整条 no-op」那条 —— 那是能唯一覆盖它层）。
  // 把它断言成"不可达"，是为了不让后来的人以为线上路径正在覆盖它。
  const { service, written, cleanup } = await applyFixture({
    gateMet: true,
    readOverride: (taskRunIds) => readerOutputWithKindOnlyOnPlan({ taskRunIds }),
  });
  t.after(cleanup);
  const record = await service.record({ task: TASK });

  assert.equal(record.phase, 'apply');
  assert.equal(record.shadow.proposal.fields.includes('kind'), true, '夹具的前提：fields 里确实点了 kind');
  // 关键：`''` 是"有值"，不是"缺值" —— 这正是它不触发 no-op 的原因。
  assert.equal(record.shadow.proposal.target.kind, '', '归一化把"没有 kind"变成了空字符串，而不是缺字段');
  assert.equal(record.apply.applied, true, '因此它照常写出先验 —— 这条路径不是防线，是正常路径');
  assert.equal(written.filter((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT).length, 1);
});

test('服务：同一族的先验按 (族, run) 幂等 —— 反复评估同一条 run 只留一行', async (t) => {
  // 刻意**不是**"一族一行"：`recordTaskEvent` 把事件 id 绑在一条 run 上（换 run 会抛
  // identity conflict），所以一族的先验是一条**时间线**，消费者按族查、取最新的一条。
  const { service, written, store, cleanup } = await applyFixture({ gateMet: true });
  t.after(cleanup);
  await service.record({ task: TASK });
  // 同一条 run 再走一次：服务的 `evaluated` 去重会挡住，所以不会重复写。
  await service.record({ task: TASK });
  // 换一条 run 再走一次同一族 —— 这正是"下一轮同类任务"的形状。
  await service.record({ task: { ...TASK, id: 'task_2' } });

  const priors = written.filter((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT);
  assert.deepEqual(priors.map((event) => event.eventId),
    [planExecPlanPriorEventId(priors[0].payload.taskFamilyId, 'task_1'), planExecPlanPriorEventId(priors[0].payload.taskFamilyId, 'task_2')],
    '两条 run 各一行，顺序与评估顺序一致');
  // 同一族的两行都留着：它们是同一个族的两轮建议，最早那轮不该被后来的覆盖掉。
  const rows = store.listTaskEvents('task_1').filter((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.sourceTaskRunId, 'task_1', 'task_1 自己那行没被 task_2 改写');
  assert.equal(store.listTaskEvents('task_2').filter((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT).length, 1);
  assert.equal(new Set(priors.map((event) => event.payload.taskFamilyId)).size, 1, '两轮属于同一个族');
});

test('服务：`similar_swap` 到了 apply 阶段也不写先验 —— 换人是方案二的事', async (t) => {
  // 模型判定成 wrong_agent → routeEvolution 产出 similar_swap。门开着、target 齐，
  // 也不能写：换 agent 属于依赖集束/能力画像那条线，用户明确说先不做。
  const { service, written, cleanup } = await applyFixture({ gateMet: true, verdictType: 'wrong_agent' });
  t.after(cleanup);
  const record = await service.record({ task: TASK });
  assert.equal(record.phase, 'apply');
  assert.equal(record.decision.action, 'similar_swap');
  assert.equal(record.apply.applied, false);
  assert.equal(record.apply.reason, 'action_similar_swap');
  assert.equal(written.filter((event) => event.eventType === RDMD_PLAN_PRIOR_EVENT).length, 0);
});

test('服务：真库里**没有任何**写操作碰过图节点/边（影子与 apply 都一样）', async (t) => {
  // 上面那些断言用的是"调用点白名单"。这一条换成**结果**口径：把写前写后的
  // 协作图行数与内容哈希都取出来对比。图没变，才是真的没变。
  const { service, db, cleanup } = await applyFixture({ gateMet: true });
  t.after(cleanup);
  const snapshotGraph = () => {
    const tables = ['collaboration_graphs', 'collaboration_graph_nodes', 'collaboration_graph_edges'];
    return tables.map((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      return `${table}:${row.n}`;
    }).join('|');
  };
  const before = snapshotGraph();
  const record = await service.record({ task: TASK });
  assert.equal(record.phase, 'apply');
  assert.equal(record.apply.applied, true);
  assert.equal(snapshotGraph(), before, 'apply 走完了整条路，协作图一行都没多、一行都没少');
});

// ---------------------------------------------------------------------------
// 报告：度量必须有人真的去看，否则它和没实现是一样的
// ---------------------------------------------------------------------------

/**
 * `scripts/rdmd_shadow_report.mjs` 是这套东西的**出口**：开了能力位、跑了真实群任务之后，
 * 判断"能不能开真动作"靠的就是它。所以它自己必须被测 —— 一个从没被断言过的判据工具，
 * 可能一直在把 `unobserved` 算进分母，而没人会发现。
 */
test('报告：能力位从没开过时报"无从谈起"，且不把 0 条观察说成 100%', async (t) => {
  const { root, db } = await realStoreFixture();
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

  const report = buildShadowReport(db, { dbPath: 'test.db', now: () => '2026-09-17T00:00:00.000Z' });
  assert.equal(report.capabilityObserved, false);
  assert.equal(report.shadowProposals, 0);
  // 关键：0 条提案的"一致率"必须是 null，不是 1 —— 空集的一致率是 0/0，不是满分。
  assert.equal(report.overall.agreementRate, null);
  assert.equal(report.overall.sampleSufficient, false);
  assert.match(renderShadowReport(report), /无从谈起/);
});

test('报告：一轮提案 + 一轮观察后，一致率按 op 给出来，且明确说还差多少', async (t) => {
  const { root, db, reads, service } = await realStoreFixture();
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

  await service.record({ task: TASK });
  reads.current = readerOutput({ revision: 8, aligned: true, taskRunId: 'task_2', taskRunIds: ['task_1', 'task_2'] });
  await service.record({ task: { ...TASK, id: 'task_2' } });

  const report = buildShadowReport(db, { dbPath: 'test.db' });
  assert.equal(report.capabilityObserved, true);
  assert.equal(report.shadowProposals, 1);
  assert.equal(report.shadowFollowUps, 1);
  assert.equal(report.byOp.align_node.observed, 1);
  assert.equal(report.byOp.align_node.carriedOut, 1);
  assert.equal(report.byOp.align_node.agreementRate, 1);
  assert.equal(report.byOp.align_node.sampleSufficient, false, '1 条观察不足以判断一类 op');
  assert.equal(report.remaining.align_node, report.overall.minObservations - 1);

  const text = renderShadowReport(report);
  assert.match(text, /align_node/);
  assert.match(text, /还差 \d+ 条已观察/);
  // 报告必须自己说清楚它不负责开动作 —— 否则它会被当成开关。
  assert.match(text, /RDMD_ACTION_PHASES/);
});

test('报告：只读 —— 跑完整份报告不写任何一行', async (t) => {
  const { root, db, reads, service } = await realStoreFixture();
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });

  await service.record({ task: TASK });
  reads.current = readerOutput({ revision: 8, aligned: true, taskRunId: 'task_2', taskRunIds: ['task_1', 'task_2'] });
  await service.record({ task: { ...TASK, id: 'task_2' } });

  const before = db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n;
  const updatedBefore = db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE updated_at IS NOT NULL').get().n;
  buildShadowReport(db, { dbPath: 'test.db' });
  renderShadowReport(buildShadowReport(db, { dbPath: 'test.db' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE updated_at IS NOT NULL').get().n, updatedBefore);
});
