import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { newDb } from 'pg-mem';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { planExecTaskFamily } from '../../src/main/modules/collaboration/application/planExecDriftService.js';
import { stableCollaborationNodeId } from '../../src/shared/contracts/uBuddyCollaborationGraph.js';
import {
  PLAN_EXEC_NODE_FIELDS,
  PLAN_EXEC_REQUIRED_FIELDS_BY_KIND,
} from '../../src/shared/contracts/uBuddyPlanExec.js';
import { migrate } from '../src/db.mjs';
import { publishCollaborationGraph, readCollaborationGraph } from '../src/modules/collaboration/collaborationGraph.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-graph-'));
  const db = openDatabase(root, { skipMigrationBackup: true, skipMigrationPreflight: true });
  return { root, db, store: new Store(db, { root }) };
}

test('production collaboration graph projects two uBuddy levels with replay, privacy, and depth guard', () => {
  const { root, db, store } = fixture();
  try {
    store.ensureCollaborationGraph({ groupId: 'group_alice', ownerWorkspaceId: 'workspace_personal', ownerUserId: 'alice', title: 'Launch' });
    const bob = store.ensureCollaborationGraphForDelegation({ id: 'del_bob', groupId: 'group_alice', accountWorkspaceId: 'workspace_personal', requesterUserId: 'alice', recipientUserId: 'bob', recipientAgentId: 'secretary_agent', title: 'Research', status: 'running' });
    const carol = store.ensureCollaborationGraphForDelegation({ id: 'del_carol', groupId: 'group_alice', accountWorkspaceId: 'workspace_personal', requesterUserId: 'alice', recipientUserId: 'carol', recipientAgentId: 'secretary_agent', title: 'Prototype', status: 'queued' });
    assert.equal(bob.graphId, carol.graphId);
    const bobTask = store.createTaskRun({ id: 'task_bob', title: 'Bob task', prompt: 'PRIVATE prompt /Users/alice/secret', userId: 'bob', metadata: { taskOrigin: 'external_delegation', delegationId: 'del_bob', collaborationGroupId: 'group_alice' } });
    const b1 = store.createTaskNode({ taskRunId: bobTask.id, title: 'Bob Agent 1', objective: 'private objective', agentId: 'research_agent', status: 'completed' });
    store.createTaskNode({ taskRunId: bobTask.id, title: 'Bob Agent 2', objective: 'dependent', agentId: 'general_agent', dependencies: [b1.id], status: 'running' });
    const graph = store.projectTaskRunToCollaborationGraph(bobTask.id, { type: 'node_running' });
    const kinds = graph.nodes.map((node) => `${node.kind}:${node.depth}`);
    assert.deepEqual(kinds.sort(), ['agent_task:2', 'agent_task:2', 'root:0', 'ubuddy:1', 'ubuddy:1']);
    assert.ok(graph.edges.some((edge) => edge.kind === 'dependency_of'));
    assert.ok(graph.recentEvents.length > 0);
    assert.equal(graph.nodes.some((node) => JSON.stringify(node).includes('PRIVATE prompt')), false);
    const revision = graph.revision;
    const replay = store.projectTaskRunToCollaborationGraph(bobTask.id, { type: 'node_running' });
    assert.equal(replay.revision, revision);
    assert.throws(() => store.getCollaborationGraph({ groupId: 'group_alice', viewerUserId: 'mallory' }), /forbidden/i);
    assert.equal(store.rejectNestedUBuddyDelegation({ delegationId: 'del_bob', actorUserId: 'bob' }), true);
    const afterLimit = store.getCollaborationGraph({ groupId: 'group_alice', viewerUserId: 'alice' });
    assert.ok(afterLimit.recentEvents.some((event) => event.eventType === 'delegation_depth_blocked'));
    assert.throws(() => store.upsertCollaborationGraphNode({ graphId: graph.graphId, node: {
      nodeId: 'too_deep_ubuddy', parentNodeId: bob.uBuddyNodeId, kind: 'ubuddy', title: 'Third level', depth: 2,
    } }), /深度限制/);
    assert.throws(() => store.upsertCollaborationGraphNode({ graphId: graph.graphId, node: {
      ...graph.root, parentNodeId: bob.uBuddyNodeId,
    } }), /cycle/i);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent plan steps project into a depth-3 agent_step chain, stay private, and replay idempotently', () => {
  const { root, db, store } = fixture();
  try {
    store.ensureCollaborationGraph({ groupId: 'group_plan', ownerWorkspaceId: 'workspace_personal', ownerUserId: 'alice', title: 'Plan' });
    const task = store.createTaskRun({ id: 'task_plan', title: 'Plan task', prompt: 'PRIVATE prompt /Users/alice/secret', userId: 'alice', metadata: { collaborationGroupId: 'group_plan' } });
    const node = store.createTaskNode({ taskRunId: task.id, title: 'Research', objective: 'objective', agentId: 'research_agent', status: 'running' });
    // 第一条计划：三步，第一步已完成。
    store.recordTaskEvent({ taskRunId: task.id, taskNodeId: node.id, eventType: 'node_activity',
      payload: { activityType: 'plan', plan: { explanation: '先查资料再写结论', steps: [
        { label: '查资料', detail: 'read /Users/alice/secret/notes.md', status: 'completed' },
        { label: '写结论', status: 'in_progress' },
        { label: '复核', status: 'pending' },
      ] } } });
    // 第二条计划：推进状态，并砍掉第三步。
    store.recordTaskEvent({ taskRunId: task.id, taskNodeId: node.id, eventType: 'node_activity',
      payload: { activityType: 'plan', plan: { explanation: '先查资料再写结论', steps: [
        { label: '查资料', status: 'completed' },
        { label: '写结论', status: 'completed' },
      ] } } });

    const graph = store.projectTaskRunToCollaborationGraph(task.id, { type: 'node_running' });
    const steps = graph.nodes.filter((entry) => entry.kind === 'agent_step');
    const byIndex = new Map(steps.map((entry) => [Number(entry.publicMetadata.planStepIndex), entry]));
    assert.deepEqual([...byIndex.keys()].sort((a, b) => a - b), [0, 1, 2]);
    // 状态取最新一版：第 2 步推进到 completed，被砍掉的第 3 步标 cancelled 而不是留着旧状态。
    assert.deepEqual([byIndex.get(0).title, byIndex.get(0).status], ['查资料', 'completed']);
    assert.deepEqual([byIndex.get(1).title, byIndex.get(1).status], ['写结论', 'completed']);
    assert.deepEqual([byIndex.get(2).title, byIndex.get(2).status], ['复核', 'cancelled']);
    assert.equal(steps.every((entry) => entry.depth === 3), true);
    assert.equal(steps.every((entry) => entry.parentNodeId === stableCollaborationNodeId('agent_task', node.id)), true);
    assert.equal(graph.planProjection.taskNodesWithPlan, 1);
    assert.equal(graph.planProjection.skippedEvents, 0);

    // sequence_of 是图上唯一的真链，且只描述**最终计划**的顺序：
    // 0 -> 1 一条边；被砍掉的第 2 步留在 agent_task 之下但不在链上。
    const sequence = graph.edges.filter((edge) => edge.kind === 'sequence_of');
    assert.equal(sequence.length, 1);
    assert.equal(sequence[0].fromNodeId, byIndex.get(0).nodeId);
    assert.equal(sequence[0].toNodeId, byIndex.get(1).nodeId);
    assert.equal(sequence.some((edge) => edge.fromNodeId === byIndex.get(2).nodeId || edge.toNodeId === byIndex.get(2).nodeId), false);
    const parentEdges = graph.edges.filter((edge) => edge.kind === 'parent_of' && edge.fromNodeId === stableCollaborationNodeId('agent_task', node.id));
    assert.equal(parentEdges.length, 3, '被砍掉的步骤仍属于该 task，只是不在顺序链上');

    // 隐私：step 的 detail 与 plan 的 explanation 都不进公开投影。
    const serialized = JSON.stringify(steps);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('先查资料'), false);
    assert.equal(steps.every((entry) => entry.publicSummary === ''), true);
    assert.equal(graph.nodes.some((entry) => JSON.stringify(entry).includes('PRIVATE prompt')), false);

    // 重放不得推进 revision，也不得产生任何新写入（幂等）。
    const replay = store.projectTaskRunToCollaborationGraph(task.id, { type: 'node_running' });
    assert.equal(replay.revision, graph.revision);
    assert.equal(replay.planProjection.appliedNodes, 0);
    assert.equal(replay.planProjection.appliedEdges, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan projection refuses to guess at truncated or unshaped payloads', () => {
  const { root, db, store } = fixture();
  try {
    store.ensureCollaborationGraph({ groupId: 'group_trunc', ownerWorkspaceId: 'workspace_personal', ownerUserId: 'alice', title: 'Truncated' });
    const task = store.createTaskRun({ id: 'task_trunc', title: 'Trunc', prompt: 'p', userId: 'alice', metadata: { collaborationGroupId: 'group_trunc' } });
    const node = store.createTaskNode({ taskRunId: task.id, title: 'Work', objective: 'o', agentId: 'general_agent', status: 'running' });
    // scheduler 的超长载荷会被换成 { truncated, preview } —— 不可解析，必须跳过而不是猜。
    store.recordTaskEvent({ taskRunId: task.id, taskNodeId: node.id, eventType: 'node_activity',
      payload: { activityType: 'plan', plan: { truncated: true, preview: '{"steps":[{"label":"...' } } });
    store.recordTaskEvent({ taskRunId: task.id, taskNodeId: node.id, eventType: 'node_activity',
      payload: { activityType: 'plan', plan: { unexpected: 'shape' } } });
    const graph = store.projectTaskRunToCollaborationGraph(task.id, { type: 'node_running' });
    assert.equal(graph.nodes.filter((entry) => entry.kind === 'agent_step').length, 0);
    assert.equal(graph.edges.filter((edge) => edge.kind === 'sequence_of').length, 0);
    assert.equal(graph.planProjection.skippedEvents, 2);
    assert.equal(graph.planProjection.taskNodesWithPlan, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the product-side reader assembles G_plan from the proposal and G_exec from the graph', () => {
  const { root, db, store } = fixture();
  try {
    store.ensureCollaborationGraph({ groupId: 'group_pe', ownerWorkspaceId: 'workspace_personal', ownerUserId: 'alice', title: 'Plan/Exec' });
    const task = store.createTaskRun({ id: 'task_pe', title: 'Plan/Exec task', prompt: 'PRIVATE prompt /Users/alice/secret', userId: 'alice', metadata: {
      collaborationGroupId: 'group_pe',
      // planner 的**原始提案**。三个节点里只有一个真的被执行了：
      // 「复核」和「归档」规划了但从未发生 —— 这正是事件 replay 看不见的那类漂移
      // （它们从头到尾没有任何事件）。
      taskGraphProposal: { version: 2, status: 'ready', confidence: 0.9, nodes: [
        { localId: 'a', title: '研究', agentId: 'research_agent', objective: 'o', outputFormat: 'markdown', dependencies: [] },
        { localId: 'b', title: '复核', agentId: 'review_agent', objective: 'o', outputFormat: 'markdown', dependencies: ['a'], isFinal: true },
        { localId: 'c', title: '归档', agentId: 'general_agent', objective: 'o', outputFormat: 'markdown', dependencies: ['b'] },
      ] },
    } });
    // 真跑的其实不是 research_agent。组织层的连接键是 title，所以这个能对上。
    const research = store.createTaskNode({ taskRunId: task.id, title: '研究', objective: 'o', agentId: 'intern_scribe', status: 'completed' });
    // retry 造出来的、提案里没有的节点。
    store.createTaskNode({ taskRunId: task.id, title: '研究（重试）', objective: 'o', agentId: 'general_agent', status: 'running' });
    store.updateTaskNode(research.id, { resultText: '这里是执行结果正文' });
    // 首版计划三步，后续版本把第三步砍掉。
    store.recordTaskEvent({ taskRunId: task.id, taskNodeId: research.id, eventType: 'node_activity',
      payload: { activityType: 'plan', plan: { explanation: '先查资料再写结论', steps: [
        { label: '查资料', status: 'in_progress' },
        { label: '写结论', status: 'pending' },
        { label: '复核', status: 'pending' },
      ] } } });
    store.recordTaskEvent({ taskRunId: task.id, taskNodeId: research.id, eventType: 'node_activity',
      payload: { activityType: 'plan', plan: { explanation: '先查资料再写结论', steps: [
        { label: '查资料', status: 'completed' },
        { label: '写结论', status: 'completed' },
      ] } } });
    store.projectTaskRunToCollaborationGraph(task.id, { type: 'node_running' });

    const read = store.readPlanExecGraphs({ groupId: 'group_pe', viewerUserId: 'alice' });
    assert.equal(read.scope.groupId, 'group_pe');
    assert.equal(read.mapping.organizationalJoinKey, 'title');
    assert.equal(read.mapping.matchedTaskNodeCount, 1);
    assert.deepEqual(read.mapping.unmatchedProposalNodes.map((item) => item.localId).sort(), ['b', 'c']);

    // 规划图：容器 + 提案的三个 agent_task（包括两个从未发生的）+ 首版计划的三步。
    assert.deepEqual(read.plan.nodes.filter((node) => node.kind === 'agent_task').map((node) => node.title).sort(),
      ['复核', '归档', '研究'].sort());
    const planSteps = read.plan.nodes.filter((node) => node.kind === 'agent_step');
    assert.deepEqual(planSteps.map((node) => node.title), ['查资料', '写结论', '复核']);
    assert.deepEqual(planSteps.map((node) => node.status), ['running', 'queued', 'queued'],
      '规划图记的是**规划时**的状态（且已归一化），不是最终状态');

    // 执行图：真跑的两个 task node + 折叠后的两步（第三步 cancelled）。
    assert.deepEqual(read.exec.nodes.filter((node) => node.kind === 'agent_task').map((node) => node.title).sort(),
      ['研究', '研究（重试）']);
    assert.deepEqual(read.exec.nodes.filter((node) => node.kind === 'agent_step').map((node) => node.status),
      ['completed', 'completed', 'cancelled']);

    // 规划图的依赖来自提案（a->b->c），不是照抄执行图 —— 否则 missing_dependency 会被掩盖。
    const planDependencyEdges = read.plan.edges.filter((edge) => edge.to.includes('plan:task_pe:'));
    assert.equal(planDependencyEdges.length, 2);
    assert.equal(read.exec.edges.some((edge) => edge.id.includes('plan:task_pe:')), false);

    // 11 字段：direct 的进得来，missing 的如实为空。
    const researchPlanNode = read.plan.nodes.find((node) => node.title === '研究');
    assert.equal(researchPlanNode.agentId, 'research_agent');
    assert.equal(researchPlanNode.summary, '');
    assert.equal(read.fieldSources.artifact, 'missing');
    assert.equal(read.constants.version, 'v1');

    // 度量能跑（只读 7 个字段 + 边），模型不能跑（富文本有 missing）——这两件事必须分开报。
    assert.deepEqual(read.metric, { ready: true, missing: [] });
    assert.equal(read.gapSummary.emptyRichFieldCount > 0, true);
    // v2：缺口只能落在「该 kind 那一档真的要求」且「模型看得见」的字段上。
    // 这里断言的是**不变量**，不是写死的字段清单 —— 清单会随分档调整而变，
    // 而「契约不许要求模型读不到的字段」这条永远成立，也永远是最该被守住的。
    const requiredByKind = new Set(Object.values(PLAN_EXEC_REQUIRED_FIELDS_BY_KIND).flat());
    const modelVisible = new Set(PLAN_EXEC_NODE_FIELDS);
    for (const gap of read.gaps) {
      if (gap.field === 'nodes') continue;
      assert.equal(requiredByKind.has(gap.field), true, `${gap.kind}.${gap.field} 不在任何必需集里`);
      assert.equal(modelVisible.has(gap.field), true, `${gap.field} 对模型不可见，契约不该要求它`);
      assert.equal(Boolean(gap.kind), true, '每个节点级缺口都要能归因到某一层');
    }
    // v2 的放宽方向：artifact/stage/inputs 在真实数据上没有来源，不该再出现在缺口里。
    // 它们一出现，就说明闸门又退回了 v1 那条「语料判据」——真实数据会永远过不了。
    for (const field of ['artifact', 'stage', 'inputs']) {
      assert.equal(read.gaps.some((gap) => gap.field === field), false,
        `${field} 没有真实来源，不该再被要求`);
    }
    assert.equal(read.gaps.some((gap) => gap.graph === 'G_prime' && gap.field === 'output' && gap.nodeId === ''),
      false, 'output 有真实来源，不该凭空报缺（缺的是 agent_step 那一类节点）');
    const execResearch = read.exec.nodes.find((node) => node.title === '研究');
    assert.equal(execResearch.output, '这里是执行结果正文');
    assert.equal(read.case.id, 'group_pe');
    assert.equal(read.case.G_star.nodes.length, read.plan.nodes.length);

    // 公共记忆那个「已定义但无人填」的槽现在有内容了。
    assert.equal(read.memory.foundation.plan.nodes.length, read.plan.nodes.length);
    assert.deepEqual(read.memory.participantUserIds, ['alice']);
    assert.equal(JSON.stringify(read.plan).includes('PRIVATE prompt'), false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 核实项：`readPlanExecGraphs` 按 taskRunId 读时，群作用域是否还在。
//
// `planExecDriftService.record()` 就是这么调的（`{ taskRunId, viewerUserId, skipAuthorization }`，
// 不带 groupId），而 `scope.groupId` 是 `planExecTaskFamily` 的**第一顺位 anchor**。
// 回抄入参的话它会恒为空串 → 族退化成 `task_run` → `degenerate: true`，于是
// 「提案数在涨」永远变不成「样本在积累」。这条路径此前完全没有被断言过：
// 上面那条读图测试**显式传了** `groupId: 'group_pe'`，所以回抄入参也照样绿。
test('the group scope survives a taskRunId-only read, so the drift task family is not degenerate', () => {
  const { root, db, store } = fixture();
  try {
    store.ensureCollaborationGraph({ groupId: 'group_scope', ownerWorkspaceId: 'workspace_personal', ownerUserId: 'alice', title: 'Scope' });
    const task = store.createTaskRun({ id: 'task_scope', title: 'Scope task', prompt: 'p', userId: 'alice', metadata: { collaborationGroupId: 'group_scope' } });
    const node = store.createTaskNode({ taskRunId: task.id, title: 'Work', objective: 'o', agentId: 'research_agent', status: 'completed' });
    store.recordTaskEvent({ taskRunId: task.id, taskNodeId: node.id, eventType: 'node_activity',
      payload: { activityType: 'plan', plan: { steps: [{ label: '查资料', status: 'completed' }] } } });
    store.projectTaskRunToCollaborationGraph(task.id, { type: 'node_running' });

    // 关键：**不传 groupId**。这正是 `record()` 的形状。
    const read = store.readPlanExecGraphs({ taskRunId: task.id, viewerUserId: 'alice' });
    assert.equal(read.scope.groupId, 'group_scope', '按 taskRunId 读也必须带出真正的群作用域');
    assert.equal(read.case.id, 'group_scope', 'case id 也要落在群上，而不是退化成 run id');

    const family = planExecTaskFamily({ groupId: read.scope.groupId, taskRunId: task.id, plan: read.plan });
    assert.equal(family.anchorKind, 'group');
    assert.equal(family.degenerate, false, '退化族会让每一轮同类任务都换族，样本永远不积累');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a delivered peer-coordination message adds the reverse uBuddy -> root edge, and never invents a graph', () => {
  const { root, db, store } = fixture();
  try {
    store.ensureCollaborationGraph({ groupId: 'group_coord', ownerWorkspaceId: 'workspace_personal', ownerUserId: 'alice', title: 'Coord' });
    const bob = store.ensureCollaborationGraphForDelegation({ id: 'del_bob', groupId: 'group_coord', accountWorkspaceId: 'workspace_personal', requesterUserId: 'alice', recipientUserId: 'bob', recipientAgentId: 'secretary_agent', title: 'Research', status: 'running' });
    const before = store.getCollaborationGraph({ groupId: 'group_coord', viewerUserId: 'alice' });
    // 不做这个断言，云侧的 collaboration_graphs.root_group_id 会永远是空串，
    // 「群成员可读可写」那条分支就成死代码了（本地认为能读、云端 403）。
    assert.equal(before.groupId, 'group_coord');
    assert.equal(before.nodes.filter((node) => node.kind === 'ubuddy').length, 1);
    assert.equal(before.edges.some((edge) => edge.kind === 'coordinates_with'), false, '协调发生前图上只有 root -> ubuddy 的放射边');

    const recorded = store.recordCollaborationCoordinationEdge({ groupId: 'group_coord', delegationId: 'del_bob', reason: 'blocked_dependency', sourceEventId: 'peer-coordination:del_bob:blocked_dependency:7' });
    assert.equal(recorded.applied, true);
    // direction 是「接收方 uBuddy -> 发起方 uBuddy」，和 delegates_to 相反。
    // 这也顺带证明了 coordinates_with 没有进 STRUCTURAL_EDGE_KINDS ——
    // 若进了环检测，root -> ubuddy 已存在时这条反向边会被判成环而抛错。
    assert.equal(recorded.fromNodeId, bob.uBuddyNodeId);
    assert.equal(recorded.toNodeId, before.root.nodeId);
    const after = store.getCollaborationGraph({ groupId: 'group_coord', viewerUserId: 'alice' });
    const coordination = after.edges.filter((edge) => edge.kind === 'coordinates_with');
    assert.equal(coordination.length, 1);
    assert.equal(coordination[0].fromNodeId, bob.uBuddyNodeId);
    assert.equal(coordination[0].toNodeId, after.root.nodeId);
    assert.deepEqual(coordination[0].publicMetadata.reasons, ['blocked_dependency']);
    assert.equal(coordination[0].publicMetadata.source, 'ubuddy_peer_coordination');
    assert.equal(coordination[0].publicMetadata.lastSourceEventId, 'peer-coordination:del_bob:blocked_dependency:7');
    assert.equal(store.getCollaborationGraph({ graphId: bob.graphId, viewerUserId: 'bob' }).graphId, bob.graphId);

    // 同一个 reason 重放：边内容不变。
    store.recordCollaborationCoordinationEdge({ groupId: 'group_coord', delegationId: 'del_bob', reason: 'blocked_dependency' });
    assert.deepEqual(store.getCollaborationGraph({ groupId: 'group_coord', viewerUserId: 'alice' }).edges
      .find((edge) => edge.kind === 'coordinates_with').publicMetadata.reasons, ['blocked_dependency']);

    // 边界身份是结构性的：一对 uBuddy 只有一条 coordinates_with，新 reason 累积进去而不是新开一条边。
    const second = store.recordCollaborationCoordinationEdge({ groupId: 'group_coord', delegationId: 'del_bob', reason: 'input_gap', sourceEventId: 'peer-coordination:del_bob:input_gap:9' });
    assert.deepEqual(second.reasons, ['blocked_dependency', 'input_gap']);
    const merged = store.getCollaborationGraph({ groupId: 'group_coord', viewerUserId: 'alice' });
    assert.equal(merged.edges.filter((edge) => edge.kind === 'coordinates_with').length, 1);
    assert.deepEqual(merged.edges.find((edge) => edge.kind === 'coordinates_with').publicMetadata.reasons,
      ['blocked_dependency', 'input_gap'], '同一个依赖点反复摩擦几次、分别因为什么，都留在这一条边上');

    // 图上没有这个 delegation 的 uBuddy 节点时不许瞎连。
    assert.deepEqual(store.recordCollaborationCoordinationEdge({ groupId: 'group_coord', delegationId: 'del_absent', reason: 'blocked_dependency' }),
      { applied: false, reason: 'coordination_endpoints_missing' });
    // 图不存在时也不许顺手建图。
    assert.deepEqual(store.recordCollaborationCoordinationEdge({ groupId: 'group_absent', delegationId: 'del_bob', reason: 'blocked_dependency' }),
      { applied: false, reason: 'graph_not_found' });
    assert.deepEqual(store.recordCollaborationCoordinationEdge({ groupId: 'group_coord', delegationId: '', reason: 'blocked_dependency' }),
      { applied: false, reason: 'delegation_required' });
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cloud collaboration graph accepts rootless deltas, rejects stale bases, and makes retries idempotent', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(async () => pool.end());
  await migrate(pool);
  const apiError = (status, message) => Object.assign(new Error(message), { status, code: message.toUpperCase() });
  const root = {
    nodeId: 'root_node', parentNodeId: '', kind: 'root', ownerUserId: 'alice', title: 'Launch',
    publicSummary: 'Starting', status: 'queued', progress: 0, depth: 0, sourceRevision: 1,
  };
  const snapshot = {
    graphVersion: 'ubuddy_collaboration_graph_v1', graphId: 'graph_delta_test', revision: 1,
    root, nodes: [root], edges: [], recentEvents: [{
      graphRevision: 1, eventId: 'event_1', eventType: 'node_upserted', nodeId: root.nodeId,
      publicPatch: root, createdAt: new Date().toISOString(),
    }],
  };
  const first = await publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: snapshot, apiError });
  assert.equal(first.revision, 1);
  await assert.rejects(() => publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: {
    ...snapshot, graphId: 'missing_graph', mode: 'delta', baseRevision: 0, root: undefined, nodes: [], graphEvents: [],
  }, apiError }), (error) => error.status === 409 && /base_missing/.test(error.message));

  const runningRoot = { ...root, status: 'running', progress: 50, sourceRevision: 2 };
  const delta = {
    graphVersion: snapshot.graphVersion, graphId: snapshot.graphId, mode: 'delta', baseRevision: first.revision,
    changedNodes: [runningRoot], changedEdges: [], graphEvents: [{
      graphRevision: 2, eventId: 'event_2', eventType: 'node_running', nodeId: root.nodeId,
      publicPatch: runningRoot, createdAt: new Date().toISOString(),
    }],
  };
  const second = await publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: delta, apiError });
  assert.equal(second.revision, 2);
  assert.equal(second.appliedEventCount, 1);

  const duplicate = await publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: delta, apiError });
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.revision, 2);
  await assert.rejects(() => publishCollaborationGraph(pool, { viewerUserId: 'mallory', graph: delta, apiError }),
    (error) => error.status === 403 && /forbidden/.test(error.message));
  await assert.rejects(() => publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: {
    ...delta, baseRevision: 0, graphEvents: [{ ...delta.graphEvents[0], eventId: 'event_stale' }],
  }, apiError }), (error) => error.status === 409 && /revision_conflict/.test(error.message));

  const completedRoot = { ...root, status: 'completed', progress: 100, sourceRevision: 3 };
  const fallback = await publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: {
    ...snapshot, revision: 3, root: completedRoot, nodes: [completedRoot], recentEvents: [{
      graphRevision: 3, eventId: 'event_3', eventType: 'node_completed', nodeId: root.nodeId,
      publicPatch: completedRoot, createdAt: new Date().toISOString(),
    }],
  }, apiError });
  assert.equal(fallback.revision, 3);
  const restored = await readCollaborationGraph(pool, { viewerUserId: 'alice', graphId: snapshot.graphId, apiError });
  assert.equal(restored.root.status, 'completed');
  assert.equal(restored.root.progress, 100);
  assert.deepEqual(restored.recentEvents.map((event) => event.eventId), ['event_1', 'event_2', 'event_3']);

  const boundedRoot = { ...root, nodeId: 'bounded_root', sourceRevision: 700 };
  const bounded = await publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: {
    ...snapshot, graphId: 'graph_bounded_snapshot', revision: 700, root: boundedRoot, nodes: [boundedRoot],
    recentEvents: [{ graphRevision: 700, eventId: 'bounded_event_700', eventType: 'snapshot', nodeId: boundedRoot.nodeId, publicPatch: boundedRoot }],
  }, apiError });
  assert.equal(bounded.revision, 700, 'a bounded snapshot must still advance the cloud cursor to its authoritative revision');
  const afterBounded = await publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: {
    graphVersion: snapshot.graphVersion, graphId: 'graph_bounded_snapshot', mode: 'delta', baseRevision: 700,
    changedNodes: [{ ...boundedRoot, status: 'running', sourceRevision: 701 }], changedEdges: [], graphEvents: [{
      graphRevision: 701, eventId: 'bounded_event_701', eventType: 'node_running', nodeId: boundedRoot.nodeId,
      publicPatch: { status: 'running' },
    }],
  }, apiError });
  assert.equal(afterBounded.revision, 701);
});

// 核实项：云侧发布/读取授权对群成员是否成立。
//
// 结论是「成立，但依赖快照把 groupId 带出来」。云侧第一版发布用
// `graph.groupId` 算 scopeGroupId，并把它写进 collaboration_graphs.root_group_id；
// 之后每个 delta 的写授权和每次读取授权都拿那一列去查 collaboration_group_members。
// 云侧没有别的地方能推出这个 id —— 所以本地 `getCollaborationGraph` 必须返回它。
test('cloud publish authorizes every graph participant, and the group scope survives the snapshot', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(async () => pool.end());
  await migrate(pool);
  const apiError = (status, message) => Object.assign(new Error(message), { status, code: message.toUpperCase() });
  const graphVersion = 'ubuddy_collaboration_graph_v1';
  await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash) VALUES
    ('alice','alice@example.test','Alice','alice','h'),('bob','bob@example.test','Bob','bob','h'),('dave','dave@example.test','Dave','dave','h')`);
  await pool.query("INSERT INTO collaboration_groups(id,owner_user_id,title) VALUES('group_members','alice','Members')");
  for (const userId of ['alice', 'bob', 'dave']) {
    await pool.query("INSERT INTO collaboration_group_members(group_id,user_id,status) VALUES('group_members',$1,'active')", [userId]);
  }
  const rootNode = {
    nodeId: 'root_node', parentNodeId: '', kind: 'root', ownerUserId: 'alice', title: 'Launch',
    publicSummary: 's', status: 'running', progress: 10, depth: 0, sourceRevision: 1,
  };
  const bobNode = {
    nodeId: 'ubuddy_bob', parentNodeId: 'root_node', kind: 'ubuddy', delegationId: 'del_bob', ownerUserId: 'bob',
    title: 'Bob uBuddy', publicSummary: '', status: 'running', progress: 10, depth: 1, sourceRevision: 1,
  };
  await publishCollaborationGraph(pool, { viewerUserId: 'alice', graph: {
    graphVersion, graphId: 'graph_members', groupId: 'group_members', revision: 1,
    root: rootNode, nodes: [rootNode, bobNode], edges: [],
  }, apiError });
  const deltaFor = (revision, status) => ({
    graphVersion, graphId: 'graph_members', mode: 'delta', baseRevision: revision,
    changedNodes: [{ ...bobNode, status, sourceRevision: revision + 1 }], changedEdges: [],
    graphEvents: [{ graphRevision: revision + 1, eventId: `members_event_${revision + 1}`, eventType: 'node_running', nodeId: bobNode.nodeId, publicPatch: { status } }],
  });
  // 接收方（同时是图上 ubuddy 节点的 owner）推进自己那层。
  assert.equal((await publishCollaborationGraph(pool, { viewerUserId: 'bob', graph: deltaFor(1, 'completed'), apiError })).revision, 2);
  // dave 在图上既没有节点、也没有委托，只能靠 root_group_id + 群成员身份通过 —— 这正是被验的分支。
  assert.equal((await publishCollaborationGraph(pool, { viewerUserId: 'dave', graph: deltaFor(2, 'running'), apiError })).revision, 3);
  assert.equal((await readCollaborationGraph(pool, { viewerUserId: 'dave', graphId: 'graph_members', apiError })).graphId, 'graph_members');
  await assert.rejects(() => publishCollaborationGraph(pool, { viewerUserId: 'mallory', graph: deltaFor(3, 'failed'), apiError }),
    (error) => error.status === 403 && /forbidden/.test(error.message));
  await assert.rejects(() => readCollaborationGraph(pool, { viewerUserId: 'mallory', graphId: 'graph_members', apiError }),
    (error) => error.status === 403 && /forbidden/.test(error.message));
});
