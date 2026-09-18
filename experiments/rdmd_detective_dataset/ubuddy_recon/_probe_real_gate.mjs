// 探针（不是测试）：P1 的验收条件是「真实群任务的 case 过闸门（gaps 为空）」。这条能不能成立，
// 不能靠读代码断言，得用**真实投影的形状**跑一遍。结果见
// `_real_live/AGENT_PLAN_OBSERVATION.zh-CN.md` 第 3 节：规划侧的 agent_task
// 没有 summary/output 来源，所以真实群任务今天过不了闸门。
//
// 形状来源（逐字对照）：
//   - root      : collaborationGraphStoreMethods.js#ensureCollaborationGraph (:223)
//   - ubuddy    : 同上 :217
//   - agent_task: 同上 :236
//   - agent_step: projectAgentPlanSteps :512
//   - 提案节点  : proposalNodesFromTaskRun :639 -> buildPlanExecGraphs 提案分支 :404
//
// 用法：node _probe_real_gate.mjs
// 前缀 `_` 是刻意的：_rdmd_push_dir.py 会跳过下划线开头的文件，不会推到训练盒 / 云端盒上。
import { buildPlanExecGraphs, planExecCase, planExecContractGaps, summarizePlanExecGaps,
  planStepNodeId } from '../../../src/shared/contracts/uBuddyPlanExec.js';
import { stableCollaborationNodeId } from '../../../src/shared/contracts/uBuddyCollaborationGraph.js';

const taskNodeId = 'tn_research';
const execTaskNode = stableCollaborationNodeId('agent_task', taskNodeId);

// 执行侧：一个**已经成功完成**的群任务（计划说的 truth source 就是这种任务）。
const graphNodes = [
  { nodeId: 'root', parentNodeId: '', kind: 'root', taskRunId: 'tr_1', taskNodeId: '', ownerUserId: 'alice',
    ownerAgentId: 'lead_agent', title: '客户答疑包', publicSummary: '整理客户答疑材料', status: 'completed', depth: 0 },
  { nodeId: 'u1', parentNodeId: 'root', kind: 'ubuddy', taskRunId: 'tr_1', taskNodeId: '', delegationId: 'd1',
    ownerUserId: 'bob', ownerAgentId: 'secretary_agent', title: 'bob uBuddy',
    publicSummary: '已接收协作分工', status: 'completed', depth: 1 },
  { nodeId: execTaskNode, parentNodeId: 'u1', kind: 'agent_task', taskRunId: 'tr_1', taskNodeId,
    delegationId: 'd1', ownerUserId: 'bob', ownerAgentId: 'data_agent_5', title: '缺失值处理',
    // publicTaskNodeSummary(node) = resultSummary || waitReason || errorText || objective
    publicSummary: '对字段做了缺失值处理，输出 12 列', status: 'completed', depth: 2 },
  { nodeId: planStepNodeId(taskNodeId, 0), parentNodeId: execTaskNode, kind: 'agent_step', taskRunId: 'tr_1',
    taskNodeId, delegationId: 'd1', ownerUserId: 'bob', ownerAgentId: 'data_agent_5', title: '拉原始表',
    publicSummary: '', status: 'completed', depth: 3 },
  { nodeId: planStepNodeId(taskNodeId, 1), parentNodeId: execTaskNode, kind: 'agent_step', taskRunId: 'tr_1',
    taskNodeId, delegationId: 'd1', ownerUserId: 'bob', ownerAgentId: 'data_agent_5', title: '缺失值处理',
    publicSummary: '', status: 'completed', depth: 3 },
];

const graphEdges = [
  { edgeId: 'e1', kind: 'delegates_to', fromNodeId: 'root', toNodeId: 'u1' },
  { edgeId: 'e2', kind: 'parent_of', fromNodeId: 'u1', toNodeId: execTaskNode },
  { edgeId: 'e3', kind: 'parent_of', fromNodeId: execTaskNode, toNodeId: planStepNodeId(taskNodeId, 0) },
  { edgeId: 'e4', kind: 'parent_of', fromNodeId: execTaskNode, toNodeId: planStepNodeId(taskNodeId, 1) },
  { edgeId: 'e5', kind: 'sequence_of', fromNodeId: planStepNodeId(taskNodeId, 0), toNodeId: planStepNodeId(taskNodeId, 1) },
];

const graphs = buildPlanExecGraphs({
  graphNodes,
  graphEdges,
  // 规划时的提案（首版计划）。
  proposalNodesByTaskRun: { tr_1: [{ localId: 'a', title: '缺失值处理', agentId: 'data_agent_5', dependencies: [] }] },
  // 首版 plan step（来自 turn/plan/updated）。
  firstPlanStepsByTaskNode: { [taskNodeId]: [
    { index: 0, label: '拉原始表', status: 'queued' },
    { index: 1, label: '缺失值处理', status: 'queued' },
  ] },
  // 执行结果文本（task_nodes.resultText）
  resultTextByTaskNode: { [taskNodeId]: '完成了缺失值处理，产出 12 列宽表，行数 8,412。' },
});

const modelCase = planExecCase({ id: 'real_shaped', plan: graphs.plan, exec: graphs.exec });
const gaps = planExecContractGaps(modelCase);

console.log('=== G_plan nodes ===');
for (const n of graphs.plan.nodes) {
  console.log(`  ${n.kind.padEnd(11)} ${n.id.slice(-22).padEnd(24)} summary=${JSON.stringify(n.summary)} output=${JSON.stringify((n.output || '').slice(0, 20))} status=${n.status || '-'}`);
}
console.log('=== G_exec nodes ===');
for (const n of graphs.exec.nodes) {
  console.log(`  ${n.kind.padEnd(11)} ${n.id.slice(-22).padEnd(24)} summary=${JSON.stringify((n.summary || '').slice(0, 20))} output=${JSON.stringify((n.output || '').slice(0, 20))} status=${n.status || '-'}`);
}
console.log('\n=== gaps ===');
console.log(JSON.stringify(gaps, null, 2));
console.log('=== gapSummary ===');
console.log(JSON.stringify(summarizePlanExecGaps(gaps), null, 2));
console.log(`\nPASSES GATE: ${gaps.length === 0}`);
