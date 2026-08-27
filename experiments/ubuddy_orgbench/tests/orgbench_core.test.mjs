import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario } from '../core/scenario.mjs';
import { applyOrganizationPlaybook, makeEpisode } from '../orgbench_test_exports.mjs';
import { assertActionAllowed } from '../core/permissions.mjs';
import { createEvolutionCoordinator } from '../core/evolutionCoordinator.mjs';

test('scenario creates public uBuddy profiles and private internal pools', () => {
  const scenario = buildScenario({ seed: 20260826 });
  assert.equal(scenario.profiles.length, 6);
  assert.ok(Object.values(scenario.internalPools).every((pool) => pool.count >= 2 && pool.count <= 6));
  assert.ok(Object.values(scenario.internalPools).some((pool) => pool.agents.some((agent) => agent.privateMemory)));
});

test('dynamic episode creates cross-user and internal assignments without private leak', () => {
  const episode = makeEpisode({ taskId: 'test_001', method: 'M3_ours', seed: 20260826 });
  assert.ok(episode.events.some((event) => event.eventKind === 'ubuddy_invited'));
  assert.ok(episode.events.some((event) => event.eventKind === 'internal_agent_selected'));
  assert.ok([...episode.graph.nodes.values()].some((node) => node.kind === 'internal_agent_task'));
  assert.equal(JSON.stringify(episode.graph.project('all')).includes('private-memory-'), false);
});

test('failure is retried and leaves an auditable event', () => {
  const episode = makeEpisode({ taskId: 'test_fault', method: 'M3_ours', seed: 20260826, injectFault: 'internal_agent_failure' });
  assert.ok(episode.events.some((event) => event.eventKind === 'execution_failed'));
  assert.ok(episode.events.some((event) => event.eventKind === 'execution_retried'));
  assert.equal(episode.metrics.privateLeakCount, 0);
});

test('M0 uses requester internal agents instead of silently skipping work', () => {
  const episode = makeEpisode({ taskId: 'test_single', method: 'M0_single_ubuddy', seed: 20260826 });
  assert.ok(episode.events.some((event) => event.eventKind === 'internal_agent_selected' && event.actorLayer === 'requester_ubuddy'));
  assert.equal(episode.metrics.internalAgentTaskCount, 3);
});

test('only uBuddy can organize and cross-user requester cannot dispatch foreign internal agent', () => {
  assert.throws(() => assertActionAllowed({ actorLayer: 'internal_agent', action: 'assign_to_ubuddy' }), /internal_agent/);
  assert.throws(() => assertActionAllowed({ actorLayer: 'requester_ubuddy', action: 'assign_internal_agent', targetLayer: 'internal_agent', targetOwnerUbuddyId: 'ubuddy_B', actorUbuddyId: 'ubuddy_A' }), /foreign_internal_agent/);
  assert.equal(assertActionAllowed({ actorLayer: 'recipient_ubuddy', action: 'assign_internal_agent', targetLayer: 'internal_agent', targetOwnerUbuddyId: 'ubuddy_B', actorUbuddyId: 'ubuddy_B' }), true);
});

test('public board is a versioned tree with live progress history', () => {
  const episode = makeEpisode({ taskId: 'board_contract', method: 'M3_ours', seed: 20260826 });
  const projection = episode.graph.project('all');
  assert.equal(projection.graphVersion, 'ubuddy_global_collaboration_state_graph_v1');
  assert.ok(projection.nodes.some((node) => node.kind === 'project'));
  assert.ok(projection.nodes.some((node) => node.kind === 'ubuddy_task'));
  assert.ok(projection.nodes.some((node) => node.kind === 'internal_agent_task'));
  assert.ok(projection.edges.some((edge) => edge.kind === 'parent_of'));
  assert.ok(projection.edges.some((edge) => edge.kind === 'assigned_to'));
  assert.ok(projection.stateItems.length === projection.nodes.length);
  assert.ok(projection.history.some((item) => item.action === 'node_updated'));
  assert.equal(JSON.stringify(projection).includes('private-memory-'), false);
});

test('M3 records a visible retry path for an internal failure', () => {
  const episode = makeEpisode({ taskId: 'retry_contract', method: 'M3_ours', seed: 20260826, injectFault: 'internal_agent_failure' });
  assert.ok(episode.events.some((event) => event.eventKind === 'execution_failed'));
  assert.ok(episode.events.some((event) => event.eventKind === 'execution_retried'));
  assert.ok(episode.graph.project('all').history.some((item) => item.status === 'running'));
});

test('evolution coordinator gates missing evaluator and evidence', async () => {
  const episode = makeEpisode({ taskId: 'evolution_gate', method: 'M3_ours', seed: 20260826 });
  const coordinator = createEvolutionCoordinator({ method: 'E3_joint_gated', namespace: 'test-evolution' });
  const result = await coordinator.processRound1({ episode, officialEvaluation: null });
  assert.equal(result.attribution.resultEligible, false);
  assert.ok(result.attribution.evolutionRouting.blockedReasons.some((item) => item.code === 'official_evaluator_missing'));
  assert.ok(result.updates.every((item) => item.adoptionStatus === 'blocked'));
});

test('evidence-gated evolution adopts validated candidates and rolls back on regression', async () => {
  const episode = makeEpisode({ taskId: 'evolution_adopt', method: 'M3_ours', seed: 20260826 });
  episode.events.push({ eventKind: 'selection_snapshot_frozen', actorLayer: 'requester_ubuddy', actorId: 'ubuddy_A', sourceKind: 'orgbench', sourceId: 'snapshot_1', occurredAt: new Date().toISOString(), metadata: {} });
  episode.executions = [{ ownerUbuddyId: 'ubuddy_B', agentInstanceId: Object.values(episode.scenario.internalPools)[1].agents[0].agentInstanceId }];
  const coordinator = createEvolutionCoordinator({ method: 'E3_joint_gated', namespace: 'test-adopt' });
  const result = await coordinator.processRound1({ episode, officialEvaluation: { success: true, passPercentage: 100, totalCount: 1, passCount: 1 } });
  assert.ok(result.updates.some((item) => item.adoptionStatus === 'adopted'));
  const rollback = await coordinator.finalizeRound2({ round1: { episode: { metrics: { officialSuccess: 1, officialCheckpointRate: 1 } } }, round2Episode: {}, round2Metrics: { officialSuccess: 0, officialCheckpointRate: 0 } });
  assert.equal(rollback.rollback.triggered, true);
});

test('personal candidate response accepts Cloud candidatePersonalSkillVersionId payloads', async () => {
  const calls = [];
  const client = {
    enabled: true,
    personalRun: async () => ({ payload: { status: 'available', candidatePersonalSkillVersionId: 'cloud-skill-v2', agentInstanceId: 'agent-1', memoryOperations: [] } }),
    personalVersions: async () => ({ payload: { items: [{ id: 'cloud-skill-v1', status: 'active' }] } }),
    activatePersonalVersion: async (...args) => { calls.push(['activate', ...args]); return { status: 'activated' }; },
  };
  const coordinator = createEvolutionCoordinator({ client, method: 'E3_joint_gated', namespace: 'candidate-shape' });
  coordinator.state.agents.set('agent-1', { activeSkillVersion: 'cloud-skill-v1', memoryVersion: 'memory-v1' });
  const result = await coordinator.applyCloudCandidates({
    updates: [{ scope: 'individual', adopted: true, candidate: { agentInstanceId: 'agent-1' } }],
    routed: { payload: { personalRuns: [{ id: 'run-1' }] } },
    namespace: 'candidate-shape',
  });
  assert.equal(result.personal[0].status, 'activated');
  assert.equal(calls[0][1], 'cloud-skill-v2');
});

test('rollback invokes Cloud disable and personal rollback when active versions are real IDs', async () => {
  const calls = [];
  const client = {
    enabled: true,
    disableOrganizationPolicy: async (body) => { calls.push(['disable', body]); return { status: 'disabled' }; },
    rollbackPersonal: async (body) => { calls.push(['rollback', body]); return { status: 'rolled_back' }; },
  };
  const coordinator = createEvolutionCoordinator({ client, method: 'E3_joint_gated', namespace: 'rollback-cloud' });
  coordinator.state.policy = { policyVersionId: 'policy-v2' };
  coordinator.state.baseline = { policyVersionId: 'policy-v1', agents: [{ agentInstanceId: 'agent-1', activeSkillVersion: 'skill-v1', memoryVersion: 'memory-v1' }] };
  coordinator.state.agents = new Map([['agent-1', { activeSkillVersion: 'skill-v2', memoryVersion: 'memory-v2' }]]);
  const result = await coordinator.finalizeRound2({ round1: { episode: { metrics: { officialSuccess: 1, officialCheckpointRate: 1, reworkCount: 0 } } }, round2Metrics: { officialSuccess: 0, officialCheckpointRate: 0, reworkCount: 0 } });
  assert.equal(result.rollback.triggered, true);
  assert.deepEqual(calls.map((item) => item[0]), ['disable', 'rollback']);
  assert.equal(result.rollback.recovered, true);
  assert.equal(result.activeAgents[0].activeSkillVersion, 'skill-v1');
});

test('Round 2 organization playbook changes the observable task tree and records applied rules', () => {
  const base = [{ id: 'research', title: 'Research', description: 'Collect evidence', capability: 'research', assigneeUbuddyId: 'ubuddy_B', dependsOn: [] }];
  const result = applyOrganizationPlaybook(base, {
    decompositionRules: [
      { id: 'review_after_execution', operator: 'require_synthesis_stage', taskTypes: ['appworld'], objectiveIncludes: [], role: 'review' },
    ],
  }, { taskType: 'appworld', objective: 'Any task' });
  assert.deepEqual(result.applied, ['review_after_execution']);
  assert.ok(result.tasks.some((task) => task.id === 'policy_review' && task.capability === 'review'));
  assert.deepEqual(base, [{ id: 'research', title: 'Research', description: 'Collect evidence', capability: 'research', assigneeUbuddyId: 'ubuddy_B', dependsOn: [] }]);
});
