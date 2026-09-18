import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPlanEdit,
  contrastDriftGraphs,
  detectMinimalDrift,
  injectMinimalDrift,
  minimalPlanEdits,
  normalizeDriftGraph,
  planExecProximity,
  reachesProximity,
  routeEvolution,
  singlePlanEdits,
} from './uBuddyReverseDetective.js';

function chain() {
  return {
    nodes: [
      { id: 'collect', title: '收集', agentId: 'a1', version: 'v1', acceptance: 'standard' },
      { id: 'verify', title: '验证', agentId: 'a2', version: 'v1', acceptance: 'standard' },
      { id: 'write', title: '写作', agentId: 'a3', version: 'v1', acceptance: 'standard' },
      { id: 'ppt', title: 'PPT', agentId: 'a4', version: 'v1', acceptance: 'standard' },
    ],
    edges: [
      { id: 'e1', from: 'collect', to: 'verify' },
      { id: 'e2', from: 'verify', to: 'write' },
      { id: 'e3', from: 'write', to: 'ppt' },
    ],
  };
}

test('single injection is recoverable while all diffs are larger than the gold node', () => {
  const plan = chain();
  const { graph, gold } = injectMinimalDrift(plan, { type: 'wrong_agent', nodeId: 'verify' });
  const detective = detectMinimalDrift(plan, graph);
  const contrast = contrastDriftGraphs(plan, graph);
  assert.equal(gold.nodeId, 'verify');
  assert.equal(detective.status, 'drift');
  assert.equal(detective.nodeId, 'verify');
  assert.equal(detective.type, 'wrong_agent');
  assert.ok(contrast.involvedNodeIds.length > 1);
  assert.equal(detective.evidenceNodeIds.length, 1);
});

test('missing dependency and local replan do not collapse into terminal blame', () => {
  const plan = chain();
  const missing = injectMinimalDrift(plan, { type: 'missing_dependency', nodeId: 'write' });
  const missingDetect = detectMinimalDrift(plan, missing.graph);
  assert.equal(missingDetect.nodeId, 'write');
  assert.equal(missingDetect.type, 'missing_dependency');

  const replan = injectMinimalDrift(plan, { type: 'local_replan', nodeId: 'verify' });
  const replanDetect = detectMinimalDrift(plan, replan.graph);
  assert.equal(replanDetect.nodeId, 'verify');
  assert.notEqual(replanDetect.nodeId, 'ppt');
});

function fork() {
  return {
    nodes: [
      { id: 'intake', title: 'intake', agentId: 'a0', version: 'v1', acceptance: 'standard' },
      { id: 'research', title: 'research', agentId: 'a1', version: 'v1', acceptance: 'standard' },
      { id: 'data', title: 'data', agentId: 'a2', version: 'v1', acceptance: 'standard' },
      { id: 'write', title: 'write', agentId: 'a3', version: 'v1', acceptance: 'standard' },
    ],
    edges: [
      { id: 'e1', from: 'intake', to: 'research' },
      { id: 'e2', from: 'intake', to: 'data' },
      { id: 'e3', from: 'research', to: 'write' },
      { id: 'e4', from: 'data', to: 'write' },
    ],
  };
}

test('no drift and multi-root stay conservative; routing matches V4 gates', () => {
  const plan = chain();
  assert.equal(detectMinimalDrift(plan, plan).status, 'no_drift');
  const branched = fork();
  const first = injectMinimalDrift(branched, { type: 'wrong_version', nodeId: 'research' });
  const second = injectMinimalDrift(first.graph, { type: 'wrong_agent', nodeId: 'data' });
  const multi = detectMinimalDrift(branched, second.graph);
  assert.equal(multi.status, 'UNKNOWN');
  assert.equal(routeEvolution(multi).action, 'record_only');
  assert.equal(routeEvolution({ status: 'drift', type: 'wrong_agent' }).action, 'similar_swap');
  assert.equal(routeEvolution({ status: 'drift', type: 'missing_dependency' }).action, 'minimal_plan_edit');
});

// ---------- 相近效果度量与「改一处即停」 ----------

function layered() {
  return {
    nodes: [
      { id: 'root', title: 'uBuddy', kind: 'root', agentId: 'sender', version: 'v1', acceptance: 'standard' },
      { id: 'task', title: '调研', kind: 'agent_task', agentId: 'a1', version: 'v1', acceptance: 'standard' },
      { id: 's1', title: '读文档', kind: 'agent_step', agentId: 'a1', version: 'v1', acceptance: 'standard' },
      { id: 's2', title: '写结论', kind: 'agent_step', agentId: 'a1', version: 'v1', acceptance: 'standard' },
    ],
    edges: [
      { id: 'e0', from: 'root', to: 'task' },
      { id: 'e1', from: 'task', to: 's1' },
      { id: 'e2', from: 's1', to: 's2' },
    ],
  };
}

test('normalizeDriftGraph carries the layer kind and identical graphs score 1', () => {
  const plan = layered();
  const normalized = normalizeDriftGraph(plan);
  assert.deepEqual(normalized.nodes.map((node) => node.kind), ['root', 'agent_task', 'agent_step', 'agent_step']);
  const proximity = planExecProximity(plan, layered());
  assert.equal(proximity.score, 1);
  assert.equal(proximity.nodeScore, 1);
  assert.equal(proximity.edgeScore, 1);
});

test('layer weights make a coarse-layer change cheaper than a fine-layer change', () => {
  const plan = layered();
  const extraRoot = { nodes: [...layered().nodes, { id: 'x1', title: '另一个 root', kind: 'root' }], edges: layered().edges };
  const extraStep = { nodes: [...layered().nodes, { id: 'x2', title: '另一个 step', kind: 'agent_step' }], edges: layered().edges };
  const coarse = planExecProximity(plan, extraRoot);
  const fine = planExecProximity(plan, extraStep);
  assert.ok(fine.score < coarse.score, `expected fine-layer deviation to cost more: ${fine.score} vs ${coarse.score}`);
});

test('proximity stops short of equality: near-miss graphs already count as close enough', () => {
  const plan = chain();
  const withExtra = {
    nodes: [...chain().nodes, { id: 'fallback', title: 'Fallback', agentId: 'a1', version: 'v1', acceptance: 'standard' }],
    edges: chain().edges,
  };
  assert.equal(planExecProximity(plan, withExtra).score < 1, true);
  assert.equal(reachesProximity(plan, withExtra).reached, true);
});

test('a single missing dependency edge is the minimal sufficient edit', () => {
  const plan = layered();
  const exec = {
    nodes: layered().nodes,
    edges: [...layered().edges, { id: 'e3', from: 'task', to: 's2' }],
  };
  const result = minimalPlanEdits(plan, exec, { threshold: 0.97 });
  assert.equal(result.alreadySatisfied, false);
  assert.equal(result.reached, true);
  assert.equal(result.minimal.edit.op, 'add_edge');
  const repaired = applyPlanEdit(plan, result.minimal.edit);
  assert.equal(planExecProximity(repaired, exec).score, 1);
});

test('a single added work unit is preferred over dropping it, and stopping is threshold-driven', () => {
  const plan = layered();
  const exec = {
    nodes: [...layered().nodes, { id: 's3', title: '补交付检查', kind: 'agent_step', agentId: 'a1', version: 'v1', acceptance: 'standard' }],
    edges: [...layered().edges, { id: 'e4', from: 's2', to: 's3' }],
  };
  // 阈值很低时：当前状态已经「相近」，一处都不改
  assert.equal(minimalPlanEdits(plan, exec, { threshold: 0.5 }).alreadySatisfied, true);
  // 阈值提高后：补一条边就够（0.933），补一个节点不够（0.875）—— 取更省的那一处
  const strict = minimalPlanEdits(plan, exec, { threshold: 0.9 });
  assert.equal(strict.alreadySatisfied, false);
  assert.equal(strict.reached, true);
  assert.equal(strict.minimal.edit.op, 'add_edge');
  // 阈值继续提高到单处改动达不到时：如实报「一处不够」，不要伪装成功
  assert.equal(minimalPlanEdits(plan, exec, { threshold: 0.99 }).reached, false);
});

test('singlePlanEdits never invents material that the execution graph does not contain', () => {
  const plan = layered();
  const exec = { nodes: layered().nodes.slice(0, 3), edges: layered().edges.slice(0, 2) };
  const edits = singlePlanEdits(plan, exec);
  const execIds = new Set(exec.nodes.map((node) => node.id));
  for (const edit of edits) {
    if (edit.node) assert.ok(execIds.has(edit.node.id), `edit invented node ${edit.node.id}`);
  }
  assert.equal(edits.every((edit) => ['add_node', 'align_node', 'drop_node', 'add_edge', 'drop_edge'].includes(edit.op)), true);
});
