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
  RDMD_SHADOW_FOLLOWUP_EVENT,
  createPlanExecDriftService,
  observeShadowFollowUp,
  planExecDriftEventId,
  planExecDriftFollowUpEventId,
  planExecDriftRecord,
  resolveDriftPhase,
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
// 阶梯：能力位 → phase
// ---------------------------------------------------------------------------

test("'apply' 不在阶梯里 —— 开真动作必须在代码上不可能，而不是在文档上不可能", () => {
  assert.deepEqual([...RDMD_ACTION_PHASES], ['record_only', 'shadow']);
  assert.equal(RDMD_ACTION_PHASES.includes('apply'), false, 'apply 一旦进了这个数组，resolveDriftPhase 就会有分支能产出它');
  // `resolveDriftPhase` 是纯函数、只有两个取值：把能想到的输入都喂一遍。
  for (const value of [true, false, 1, 0, 'yes', 'apply', null, undefined, {}, []]) {
    const phase = resolveDriftPhase({ applyEnabled: value });
    assert.ok(RDMD_ACTION_PHASES.includes(phase), `applyEnabled=${JSON.stringify(value)} 产出了阶梯外的 phase: ${phase}`);
  }
  assert.equal(resolveDriftPhase({ applyEnabled: false }), 'record_only');
  assert.equal(resolveDriftPhase({ applyEnabled: true }), 'shadow');
  assert.equal(resolveDriftPhase(), 'record_only', '缺省必须是最保守的那一级');
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
