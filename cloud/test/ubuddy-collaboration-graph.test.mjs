import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { newDb } from 'pg-mem';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
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
