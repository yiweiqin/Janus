import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';

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
