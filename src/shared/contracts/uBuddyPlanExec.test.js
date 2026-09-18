import assert from 'node:assert/strict';
import test from 'node:test';

import { stableCollaborationNodeId } from './uBuddyCollaborationGraph.js';
import {
  PLAN_EXEC_NODE_FIELDS,
  PLAN_EXEC_REQUIRED_FIELDS_BY_KIND,
  PLAN_EXEC_RICH_FIELDS,
  buildPlanExecGraphs,
  normalizePlanExecGraph,
  planExecCase,
  planExecContractGaps,
  planExecDeferredRequiredFields,
  planExecFieldExistsOnSide,
  planExecFieldIsIndependent,
  planExecMetricReadiness,
  planExecPublicMemory,
  planExecRequiredFieldsForKind,
  planStepNodeId,
  summarizePlanExecGaps,
} from './uBuddyPlanExec.js';
import { applyPlanEdit, minimalPlanEdits, planExecProximity } from './uBuddyReverseDetective.js';

const execTaskNodeId = (taskNodeId) => stableCollaborationNodeId('agent_task', taskNodeId);

function graphNode(overrides = {}) {
  return {
    nodeId: '', parentNodeId: '', kind: 'agent_task', taskRunId: 'task_1', delegationId: '', taskNodeId: '',
    ownerUserId: 'alice', ownerAgentId: 'research_agent', ownerAgentInstanceId: '', title: '',
    publicSummary: '', status: 'running', progress: 0, depth: 2, publicMetadata: {}, sourceRevision: 1,
    ...overrides,
  };
}

test('the node field list mirrors the python training contract exactly', () => {
  assert.deepEqual([...PLAN_EXEC_NODE_FIELDS], [
    'id', 'title', 'role', 'agentId', 'version', 'acceptance',
    'artifact', 'stage', 'inputs', 'output', 'summary', 'status',
  ]);
  assert.deepEqual([...PLAN_EXEC_RICH_FIELDS], ['artifact', 'stage', 'inputs', 'output', 'summary']);
  // 富文本必须全部是可见字段的子集，否则守卫与契约会分叉。
  assert.equal(PLAN_EXEC_RICH_FIELDS.every((field) => PLAN_EXEC_NODE_FIELDS.includes(field)), true);
});

test('normalizePlanExecGraph drops dangling edges, self loops, and duplicate node/edge identities', () => {
  const graph = normalizePlanExecGraph({
    nodes: [
      { id: 'a', title: 'A' },
      { id: 'a', title: 'A duplicate' },
      { id: 'b', title: 'B' },
      { id: '', title: 'no id' },
    ],
    edges: [
      // 同一对节点之间同时有 parent_of 与 assigned_to 是常态：度量按 from->to 认边，
      // 放任两条同身份边存在会让 drop_edge 一次删两条。
      { id: 'e1', from: 'a', to: 'b', kind: 'parent_of' },
      { id: 'e2', from: 'a', to: 'b', kind: 'assigned_to' },
      { id: 'e3', from: 'a', to: 'a', kind: 'sequence_of' },
      { id: 'e4', from: 'a', to: 'missing', kind: 'parent_of' },
      { id: 'e5', from: '', to: 'b', kind: 'parent_of' },
    ],
  });
  assert.deepEqual(graph.nodes.map((node) => node.id), ['a', 'b']);
  assert.deepEqual(graph.edges, [{ id: 'a->b', from: 'a', to: 'b' }]);
});

test('the contract guard is per kind, and the tier decides which fields are demanded', () => {
  const rich = { artifact: 'artifact', stage: 'stage', inputs: 'inputs', output: 'output', summary: 'summary' };
  const caseValue = planExecCase({
    id: 'c1',
    plan: { nodes: [
      { id: 'n1', title: 'n1', ...rich },
      { id: 'n2', title: 'n2', ...rich, output: '' },
    ] },
    exec: { nodes: [
      { id: 'n1', title: 'n1', ...rich },
      { id: 'n2', title: 'n2', ...rich, output: '' },
    ] },
  });
  // 没有 kind -> 回退到最严的 agent_task 一档（title/summary/output）。
  // 但规划侧的 agent_task 只判 title（准入规则 (c)：规划侧的提案不带 outcome 文本），
  // 所以空的 output 只在**执行侧**成为缺口 —— 这正是让真实群任务能过闸门的那一条。
  assert.deepEqual(planExecContractGaps(caseValue),
    [{ graph: 'G_prime', nodeId: 'n2', field: 'output', kind: 'agent_task', side: 'exec' }]);
  assert.deepEqual(summarizePlanExecGaps(planExecContractGaps(caseValue)),
    { total: 1, byField: { output: 1 }, byKind: { agent_task: 1 }, bySide: { exec: 1 }, emptyRichFieldCount: 1 });
  // 全空图是另一条独立的失败：没有任何节点可以参考，和「节点缺字段」不是同一件事。
  assert.deepEqual(planExecContractGaps(planExecCase({ plan: {}, exec: {} })), [
    { graph: 'G_star', nodeId: '', field: 'nodes', kind: '', side: 'plan' },
    { graph: 'G_prime', nodeId: '', field: 'nodes', kind: '', side: 'exec' },
  ]);
});

test('v2 requires only fields that have a real, independent source at that tier', () => {
  // v2 相对 v1 的**唯一放宽**：artifact/stage/inputs 在任何层都是 missing 来源，
  // 所以它们不再是闸门。清空它们不再产生缺口 —— 否则真实数据永远过不了。
  const caseValue = planExecCase({
    plan: { nodes: [{ id: 'n1', title: 'n1', summary: 's', output: 'o', artifact: '', stage: '', inputs: '' }] },
    exec: { nodes: [{ id: 'n1', title: 'n1', summary: 's', output: 'o' }] },
  });
  assert.deepEqual(planExecContractGaps(caseValue), [], '没有来源的字段不该再拦人');

  // 必需集只能由「有真实来源、是该层独立信号、且该侧写得出来」的字段组成。
  // 这条自检让那张表可复核：谁想把 artifact 加进 agent_task 的必需集，
  // 或者想在规划侧要求 outcome 文本，这里会立刻失败。
  for (const side of ['plan', 'exec']) {
    for (const [kind, fields] of Object.entries(PLAN_EXEC_REQUIRED_FIELDS_BY_KIND)) {
      for (const field of fields) {
        if (!planExecFieldExistsOnSide(field, side)) continue;
        assert.equal(planExecFieldIsIndependent(kind, field, side), true,
          `${side}/${kind}.${field} 没有独立来源，不该进必需集`);
      }
    }
  }
  // inherited：step 的 agentId 就是父 agent_task 的 ownerAgentId，有值但不携带该层信号。
  assert.equal(planExecFieldIsIndependent('agent_step', 'agentId'), false);
  assert.equal(planExecFieldIsIndependent('agent_task', 'artifact'), false);
  // 侧：outcome 文本在执行侧有来源，在规划侧没有。
  assert.equal(planExecFieldExistsOnSide('output', 'exec'), true);
  assert.equal(planExecFieldExistsOnSide('output', 'plan'), false);
  assert.equal(planExecFieldIsIndependent('agent_task', 'output', 'plan'), false);
});

test('a layered group task built from the real projections passes the gate', () => {
  // P1 的验收条件：真实群任务的 case 必须过闸门。
  // 形状逐字对照真实投影（见 ubuddy_recon/_probe_real_gate.mjs）：
  //   root/ubuddy  : publicSummary 有值
  //   agent_task   : 执行侧有 summary(public_summary)/output(result_text)，
  //                  规划侧来自提案节点，只有 title/agentId（proposalNodesFromTaskRun 只带这几个）
  //   agent_step   : 两侧的 publicSummary 都是空串（projectAgentPlanSteps 刻意不投影详细文本）
  const taskNodeId = 'tn_research';
  const execTaskNode = execTaskNodeId(taskNodeId);
  const graphs = buildPlanExecGraphs({
    graphNodes: [
      graphNode({ nodeId: 'root', kind: 'root', title: '客户答疑包', publicSummary: '整理客户答疑材料', depth: 0 }),
      graphNode({ nodeId: 'u1', kind: 'ubuddy', title: 'bob uBuddy', publicSummary: '已接收协作分工', depth: 1 }),
      graphNode({ nodeId: execTaskNode, taskNodeId, title: '缺失值处理', ownerAgentId: 'data_agent_5',
        publicSummary: '对字段做了缺失值处理，输出 12 列', status: 'completed' }),
      graphNode({ nodeId: planStepNodeId(taskNodeId, 0), kind: 'agent_step', taskNodeId, title: '拉原始表',
        status: 'completed', depth: 3 }),
      graphNode({ nodeId: planStepNodeId(taskNodeId, 1), kind: 'agent_step', taskNodeId, title: '缺失值处理',
        status: 'completed', depth: 3 }),
    ],
    graphEdges: [
      { edgeId: 'e1', kind: 'delegates_to', fromNodeId: 'root', toNodeId: 'u1' },
      { edgeId: 'e2', kind: 'parent_of', fromNodeId: 'u1', toNodeId: execTaskNode },
      { edgeId: 'e3', kind: 'sequence_of', fromNodeId: planStepNodeId(taskNodeId, 0), toNodeId: planStepNodeId(taskNodeId, 1) },
    ],
    proposalNodesByTaskRun: { task_1: [{ localId: 'a', title: '缺失值处理', agentId: 'data_agent_5', dependencies: [] }] },
    firstPlanStepsByTaskNode: { [taskNodeId]: [
      { index: 0, label: '拉原始表', status: 'queued' },
      { index: 1, label: '缺失值处理', status: 'queued' },
    ] },
    resultTextByTaskNode: { [taskNodeId]: '完成了缺失值处理，产出 12 列宽表。' },
  });
  // 规划侧的 agent_task 确实没有 outcome 文本 —— 不是断言「缺口存在」，而是断言
  // 「规划侧本来就写不出这两个字段」，所以契约不该在那里要求它们。
  const planTask = graphs.plan.nodes.find((node) => node.kind === 'agent_task');
  assert.deepEqual({ summary: planTask.summary, output: planTask.output }, { summary: '', output: '' });
  // 执行侧有 outcome 文本，所以它在执行侧必须被要求（也确实齐全）。
  const execTask = graphs.exec.nodes.find((node) => node.kind === 'agent_task');
  assert.notEqual(execTask.summary, '');
  assert.notEqual(execTask.output, '');

  const gaps = planExecContractGaps(planExecCase({ id: 'real_shaped', plan: graphs.plan, exec: graphs.exec }));
  assert.deepEqual(gaps, [], '真实形状的群任务必须能过闸门，否则产品路径永远出不了 record_only');
  // step 层是真的在判，不是被 (c) 顺手放过：缺 title 仍然报。
  const stepWithoutTitle = { nodes: [{ id: 's1', title: '', kind: 'agent_step', status: 'running' }], edges: [] };
  assert.deepEqual(planExecContractGaps(planExecCase({ plan: stepWithoutTitle, exec: stepWithoutTitle })).map((gap) => gap.field),
    ['title', 'title']);
});

test('the contract never demands a field the model cannot see', () => {
  // v2 最要紧的结构性不变量：生效必需集只能是「声明必需集 ∩ 模型可见字段 ∩ 该侧写得出的字段」。
  // 没有它，契约会要求一个模型读不到的字段 —— 那种守卫只会把合法输入判死，
  // 而且判死得毫无理由。
  for (const side of ['plan', 'exec']) {
    for (const [kind, fields] of Object.entries(PLAN_EXEC_REQUIRED_FIELDS_BY_KIND)) {
      for (const field of planExecRequiredFieldsForKind(kind, side)) {
        assert.equal(PLAN_EXEC_NODE_FIELDS.includes(field), true,
          `${side}/${kind}.${field} 生效了但它不在模型可见字段里`);
      }
      assert.equal(fields.length >= planExecRequiredFieldsForKind(kind, side).length, true);
    }
  }
  // status 是 step 层唯一真正的漂移信号（后续计划版本砍掉的 step 会变成 cancelled）。
  // P1 里它是**声明了但延后生效**的，因为 prompt 还没带它。P2 已把两侧 prompt 同步加上，
  // 所以延后队列现在是空的 —— 这正是 P1 那句"P2 之后这两条断言会失败"要兑现的事。
  assert.equal(PLAN_EXEC_NODE_FIELDS.includes('status'), true, 'P2 之后 status 必须对模型可见');
  assert.deepEqual([...PLAN_EXEC_REQUIRED_FIELDS_BY_KIND.agent_step], ['title', 'status']);
  for (const side of ['plan', 'exec']) {
    assert.deepEqual([...planExecRequiredFieldsForKind('agent_step', side)], ['title', 'status']);
  }
  assert.deepEqual(planExecDeferredRequiredFields(), {},
    'P2 之后没有"声明了但看不见"的必需字段；非空就说明两侧 prompt 又分叉了');

  // step 一档现在**两个字段都真在判** —— 这是真的在判，不是空转。
  const missingTitle = { nodes: [{ id: 's1', title: '', kind: 'agent_step', status: 'completed' }], edges: [] };
  assert.deepEqual(planExecContractGaps(planExecCase({ plan: missingTitle, exec: missingTitle })).map((gap) => gap.field),
    ['title', 'title']);
  // 光有 title 不够了：status 空同样落在支持集外，而且它是被砍掉步骤的唯一信号。
  const missingStatus = { nodes: [{ id: 's1', title: '第 1 步', kind: 'agent_step', status: '' }], edges: [] };
  assert.deepEqual(planExecContractGaps(planExecCase({ plan: missingStatus, exec: missingStatus })).map((gap) => gap.field),
    ['status', 'status']);
  const complete = { nodes: [{ id: 's1', title: '第 1 步', kind: 'agent_step', status: 'completed' }], edges: [] };
  assert.deepEqual(planExecContractGaps(planExecCase({ plan: complete, exec: complete })), [],
    'title 与 status 都齐了就该放行');
});

test('the proximity metric and the model contract fail independently', () => {
  // 真实 uBuddy 图就是这个样子：id/title/agentId 都有，五个富文本全空。
  const plan = { nodes: [{ id: 'n1', title: '研究', kind: 'agent_task' }], edges: [] };
  const exec = { nodes: [{ id: 'n1', title: '研究', agentId: 'research_agent', kind: 'agent_task' }], edges: [] };
  assert.equal(planExecContractGaps(planExecCase({ plan, exec })).length > 0, true, '模型这条路必须 fail-closed');
  assert.deepEqual(planExecMetricReadiness(plan, exec), { ready: true, missing: [] },
    '度量只读 7 个字段 + 边，真实数据上今天就能跑');
  assert.equal(typeof planExecProximity(plan, exec).score, 'number');
});

test('the organizational join key is title, and a proposal-only node is real drift rather than a match failure', () => {
  const graphs = buildPlanExecGraphs({
    graphNodes: [
      graphNode({ nodeId: 'root', kind: 'root', taskNodeId: '', title: 'Launch', depth: 0 }),
      graphNode({ nodeId: execTaskNodeId('tn_a'), taskNodeId: 'tn_a', title: '研究' }),
      // retry 造出来的、提案里没有的节点
      graphNode({ nodeId: execTaskNodeId('tn_fallback'), taskNodeId: 'tn_fallback', title: '研究（重试）' }),
    ],
    graphEdges: [
      { edgeId: 'e1', kind: 'parent_of', fromNodeId: 'root', toNodeId: execTaskNodeId('tn_a') },
      { edgeId: 'e2', kind: 'dependency_of', fromNodeId: execTaskNodeId('tn_a'), toNodeId: execTaskNodeId('tn_fallback') },
    ],
    proposalNodesByTaskRun: {
      task_1: [
        { localId: 'a', title: '研究', agentId: 'research_agent', dependencies: [] },
        // 规划了但从未发生：没有对应 task_node，也没有任何事件
        { localId: 'b', title: '复核', agentId: 'review_agent', dependencies: ['a'] },
      ],
    },
  });
  assert.equal(graphs.mapping.organizationalJoinKey, 'title');
  assert.equal(graphs.mapping.matchedTaskNodeCount, 1);
  assert.deepEqual(graphs.mapping.unmatchedProposalNodes, [{ taskRunId: 'task_1', localId: 'b', title: '复核' }]);
  assert.deepEqual(graphs.mapping.execExtraTaskNodeIds, [execTaskNodeId('tn_fallback')]);

  // 匹配上的提案节点复用执行图的 node id，否则每个节点都会变成「加一个 + 删一个」两处漂移。
  assert.equal(graphs.plan.nodes.some((node) => node.id === execTaskNodeId('tn_a')), true);
  assert.equal(graphs.plan.nodes.some((node) => node.id === 'plan:task_1:b'), true);

  // 规划图的依赖来自提案，**不是**照抄执行图 —— 否则 missing_dependency 会被完全掩盖。
  assert.deepEqual(new Set(graphs.plan.edges.map((edge) => edge.id)), new Set([
    `${execTaskNodeId('tn_a')}->plan:task_1:b`,   // 提案里 b 依赖 a
    `root->${execTaskNodeId('tn_a')}`,            // 归属边两端都在规划图上，保留
  ]));
  assert.equal(graphs.exec.edges.some((edge) => edge.from === execTaskNodeId('tn_a') && edge.to === execTaskNodeId('tn_fallback')), true);
});

test('plan steps reuse the projection node id so a dropped step is one drift, not an add plus a drop', () => {
  const taskNodeId = 'tn_a';
  const graphs = buildPlanExecGraphs({
    graphNodes: [
      graphNode({ nodeId: 'root', kind: 'root', title: 'Launch', depth: 0 }),
      graphNode({ nodeId: execTaskNodeId(taskNodeId), taskNodeId, title: '研究' }),
      // 投影后的最终状态：第 3 步被后续版本砍掉，所以标成 cancelled 而不是消失
      graphNode({ nodeId: planStepNodeId(taskNodeId, 0), kind: 'agent_step', taskNodeId, title: '查资料', status: 'completed', depth: 3 }),
      graphNode({ nodeId: planStepNodeId(taskNodeId, 1), kind: 'agent_step', taskNodeId, title: '写结论', status: 'completed', depth: 3 }),
      graphNode({ nodeId: planStepNodeId(taskNodeId, 2), kind: 'agent_step', taskNodeId, title: '复核', status: 'cancelled', depth: 3 }),
    ],
    graphEdges: [
      { edgeId: 'e1', kind: 'parent_of', fromNodeId: 'root', toNodeId: execTaskNodeId(taskNodeId) },
      { edgeId: 'e2', kind: 'parent_of', fromNodeId: execTaskNodeId(taskNodeId), toNodeId: planStepNodeId(taskNodeId, 0) },
      { edgeId: 'e3', kind: 'parent_of', fromNodeId: execTaskNodeId(taskNodeId), toNodeId: planStepNodeId(taskNodeId, 1) },
      { edgeId: 'e4', kind: 'parent_of', fromNodeId: execTaskNodeId(taskNodeId), toNodeId: planStepNodeId(taskNodeId, 2) },
      { edgeId: 'e5', kind: 'sequence_of', fromNodeId: planStepNodeId(taskNodeId, 0), toNodeId: planStepNodeId(taskNodeId, 1) },
      // 现实里才发生的协调：只在执行图上 → 会体现为 add_edge 漂移
      { edgeId: 'e6', kind: 'coordinates_with', fromNodeId: execTaskNodeId(taskNodeId), toNodeId: 'root' },
    ],
    proposalNodesByTaskRun: { task_1: [{ localId: 'a', title: '研究', agentId: 'research_agent', dependencies: [] }] },
    firstPlanStepsByTaskNode: {
      [taskNodeId]: [
        { index: 0, label: '查资料', status: 'queued' },
        { index: 1, label: '写结论', status: 'queued' },
        { index: 2, label: '复核', status: 'queued' },
      ],
    },
  });

  // 首版计划的三步都在规划图上（包括后来被砍掉的第 3 步），且状态是**规划时**的状态。
  const planSteps = graphs.plan.nodes.filter((node) => node.kind === 'agent_step');
  assert.deepEqual(planSteps.map((node) => node.id), [0, 1, 2].map((index) => planStepNodeId(taskNodeId, index)));
  assert.deepEqual(planSteps.map((node) => node.status), ['queued', 'queued', 'queued']);
  assert.deepEqual(planSteps.map((node) => node.title), ['查资料', '写结论', '复核']);

  // 执行图上是折叠后的最终状态：第三步 cancelled，且不在顺序链上。
  const execSteps = graphs.exec.nodes.filter((node) => node.kind === 'agent_step');
  assert.deepEqual(execSteps.map((node) => node.status), ['completed', 'completed', 'cancelled']);

  // 规划图的顺序链来自首版计划；执行图的 sequence_of 由投影写入、这里是图上的那条。
  assert.deepEqual(graphs.plan.edges.filter((edge) => edge.from.startsWith('collab_node_agent_step')).map((edge) => edge.id),
    [`${planStepNodeId(taskNodeId, 0)}->${planStepNodeId(taskNodeId, 1)}`, `${planStepNodeId(taskNodeId, 1)}->${planStepNodeId(taskNodeId, 2)}`]);

  // 状态与顺序都不参与度量，所以这一步的「漂移」只是被砍掉的那一步 —— 一处，不是两处。
  // 顺序链的长度才是这一步的真正差异：规划是 0->1->2（两条边），执行是 0->1（一条边）。
  assert.equal(graphs.plan.edges.filter((edge) => edge.from.startsWith('collab_node_agent_step')).length, 2);
  assert.equal(graphs.exec.edges.filter((edge) => edge.from.startsWith('collab_node_agent_step')).length, 1);
  const proximity = planExecProximity(graphs.plan, graphs.exec);
  assert.equal(proximity.nodeScore, 1, '节点集合相同：首版的三步与最终的三步是同一批 id');
});

test('planExecPublicMemory fills the foundation slot that was defined but never written', () => {
  const memory = planExecPublicMemory({
    taskId: 'task_1', ownerUserId: 'alice', participantUserIds: ['alice', 'bob'],
    plan: { nodes: [{ id: 'n1', title: 'A', kind: 'agent_task' }], edges: [] },
    exec: { nodes: [{ id: 'n1', title: 'A', kind: 'agent_task' }], edges: [] },
  });
  assert.equal(memory.taskId, 'task_1');
  assert.equal(memory.ownerUserId, 'alice');
  assert.deepEqual(memory.participantUserIds, ['alice', 'bob']);
  assert.equal(memory.foundation.plan.nodes.length, 1);
  assert.equal(memory.foundation.exec.nodes.length, 1);
  assert.deepEqual(memory.elevation, []);
  assert.deepEqual(memory.raw, []);
});

test('the reader output is directly consumable by the minimal-edit solver', () => {
  const graphs = buildPlanExecGraphs({
    graphNodes: [
      graphNode({ nodeId: 'root', kind: 'root', title: 'Launch', depth: 0 }),
      graphNode({ nodeId: execTaskNodeId('tn_a'), taskNodeId: 'tn_a', title: '研究', ownerAgentId: 'intern_scribe' }),
    ],
    graphEdges: [{ edgeId: 'e1', kind: 'parent_of', fromNodeId: 'root', toNodeId: execTaskNodeId('tn_a') }],
    proposalNodesByTaskRun: { task_1: [{ localId: 'a', title: '研究', agentId: 'research_agent', dependencies: [] }] },
  });
  // 规划说是 research_agent，现实是 intern_scribe —— 正是 wrong_agent。
  const proximity = planExecProximity(graphs.plan, graphs.exec);
  assert.ok(proximity.score < 1, 'actor 层面的漂移必须能被度量看见');
  // 默认阈值 0.8 下这一处 actor 差异仍然算「相近」：这正是防过拟合该有的样子，
  // 而不是缺陷。只有把要求提高，求解器才会指名道姓说出该改哪个字段。
  assert.equal(minimalPlanEdits(graphs.plan, graphs.exec).alreadySatisfied, true);
  const strict = minimalPlanEdits(graphs.plan, graphs.exec, { threshold: 0.95 });
  assert.equal(strict.alreadySatisfied, false);
  assert.equal(strict.reached, true);
  assert.equal(strict.minimal.edit.op, 'align_node');
  assert.equal(strict.minimal.edit.nodeId, execTaskNodeId('tn_a'));
  assert.deepEqual(strict.minimal.edit.fields, ['agentId']);
});

test('a field-level drift is visible to the metric, not just to the drift detector', () => {
  const node = { id: 'n1', title: '研究', agentId: 'research_agent', version: 'v1', acceptance: 'standard', role: '' };
  const plan = { nodes: [node], edges: [] };
  // 结构完全相同，只有 actor 不同。若度量只按 id 匹配，这里会得 1.0 ——
  // 于是无论阈值提到多高都不会有候选，wrong_agent 就永远修不了。
  const exec = { nodes: [{ ...node, agentId: 'intern_scribe' }], edges: [] };
  const proximity = planExecProximity(plan, exec);
  assert.equal(proximity.matchedNodeCount, 1);
  assert.equal(proximity.score < 1, true, '同一个节点、不同的 actor 必须扣分');
  assert.equal(Math.round(proximity.score * 1e6) / 1e6, 0.9, '5 个比较字段里错 1 个：节点 F1 = 0.8，与满分边分数各占一半');

  const result = minimalPlanEdits(plan, exec, { threshold: 0.95 });
  assert.equal(result.alreadySatisfied, false);
  assert.deepEqual(result.minimal.edit.fields, ['agentId']);
  assert.equal(planExecProximity(applyPlanEdit(plan, result.minimal.edit), exec).score, 1);
});
