import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';
import {
  UBUDDY_COLLABORATION_GRAPH_VERSION,
  collaborationNodeProgress,
  normalizeCollaborationGraphEdge,
  normalizeCollaborationGraphNode,
  normalizeCollaborationStatus,
  publicCollaborationSummary,
  sanitizeCollaborationPublicValue,
  stableCollaborationEdgeId,
  stableCollaborationEventId,
  stableCollaborationGraphId,
  stableCollaborationNodeId,
} from '../../../../shared/contracts/uBuddyCollaborationGraph.js';

const STRUCTURAL_EDGE_KINDS = new Set(['parent_of', 'delegates_to', 'assigned_to']);

export function installCollaborationGraphStoreMethods(prototype) {
  Object.assign(prototype, {
    ensureCollaborationGraph({ graphId = '', taskRunId = '', delegationId = '', groupId = '', ownerWorkspaceId = '', ownerUserId = '', title = '' } = {}) {
      const id = String(graphId || '').trim() || stableCollaborationGraphId({ groupId, delegationId, taskRunId });
      const existing = get(this.db, 'SELECT * FROM collaboration_graphs WHERE id=?', [id]);
      const rootSourceId = String(groupId || delegationId || taskRunId).trim();
      const rootNodeId = stableCollaborationNodeId('root', rootSourceId);
      const now = nowIso();
      run(this.db, `INSERT INTO collaboration_graphs(
        id,graph_version,root_task_run_id,root_delegation_id,root_group_id,root_node_id,
        owner_workspace_id,owner_user_id,title,current_revision,lifecycle_status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,0,'active',?,?) ON CONFLICT(id) DO UPDATE SET
        root_task_run_id=CASE WHEN excluded.root_task_run_id!='' THEN excluded.root_task_run_id ELSE collaboration_graphs.root_task_run_id END,
        root_delegation_id=CASE WHEN excluded.root_delegation_id!='' THEN excluded.root_delegation_id ELSE collaboration_graphs.root_delegation_id END,
        root_group_id=CASE WHEN excluded.root_group_id!='' THEN excluded.root_group_id ELSE collaboration_graphs.root_group_id END,
        owner_workspace_id=CASE WHEN excluded.owner_workspace_id!='' THEN excluded.owner_workspace_id ELSE collaboration_graphs.owner_workspace_id END,
        owner_user_id=CASE WHEN excluded.owner_user_id!='' THEN excluded.owner_user_id ELSE collaboration_graphs.owner_user_id END,
        title=CASE WHEN collaboration_graphs.title='' AND excluded.title!='' THEN excluded.title ELSE collaboration_graphs.title END,
        updated_at=excluded.updated_at`, [
        id, UBUDDY_COLLABORATION_GRAPH_VERSION, taskRunId, delegationId, groupId, rootNodeId,
        ownerWorkspaceId || 'workspace_personal', ownerUserId, publicCollaborationSummary(title || '组织协作任务'),
        existing?.created_at || now, now,
      ]);
      if (!get(this.db, 'SELECT 1 FROM collaboration_graph_nodes WHERE graph_id=? AND node_id=?', [id, rootNodeId])) {
        this.upsertCollaborationGraphNode({ graphId: id, idempotencyKey: `root:${rootSourceId}`, node: {
          nodeId: rootNodeId, kind: 'root', taskRunId, delegationId, ownerUserId,
          title: title || '组织协作任务', status: 'queued', progress: 0, depth: 0,
          publicSummary: 'uBuddy 正在组织协作任务。', publicMetadata: { groupId },
        } });
      }
      return normalizeGraphRow(get(this.db, 'SELECT * FROM collaboration_graphs WHERE id=?', [id]));
    },

    ensureCollaborationGraphForDelegation(delegation = {}) {
      const delegationId = String(delegation.id || delegation.delegationId || '').trim();
      if (!delegationId) throw new Error('delegation_required_for_collaboration_graph');
      const groupId = String(delegation.groupId || delegation.group_id || delegation.metadata?.groupId || '').trim();
      const graph = this.ensureCollaborationGraph({
        taskRunId: groupId ? '' : String(delegation.metadata?.rootTaskRunId || '').trim(),
        delegationId: groupId ? '' : delegationId,
        groupId,
        ownerWorkspaceId: delegation.workspaceId || delegation.accountWorkspaceId || 'workspace_personal',
        ownerUserId: delegation.requesterUserId || '',
        title: delegation.metadata?.taskSummary?.objective || delegation.title || '组织协作任务',
      });
      const rootNode = get(this.db, 'SELECT node_id FROM collaboration_graph_nodes WHERE graph_id=? AND kind=\'root\' LIMIT 1', [graph.graphId]);
      const nodeId = stableCollaborationNodeId('ubuddy', delegationId);
      this.upsertCollaborationGraphNode({ graphId: graph.graphId, idempotencyKey: `delegation:${delegationId}`, node: {
        nodeId, parentNodeId: rootNode?.node_id || graph.rootNodeId, kind: 'ubuddy', delegationId,
        taskRunId: delegation.taskRunId || '', ownerUserId: delegation.recipientUserId || '',
        ownerAgentId: delegation.recipientAgentId || 'secretary_agent', title: `${delegation.recipient?.displayName || delegation.recipient?.username || '接收方'} uBuddy`,
        publicSummary: delegation.title || '已接收协作分工', status: normalizeCollaborationStatus(delegation.status), depth: 1,
        publicMetadata: { role: 'recipient_ubuddy', requesterUserId: delegation.requesterUserId || '', groupId },
      } });
      this.upsertCollaborationGraphEdge({ graphId: graph.graphId, edge: {
        kind: 'parent_of', fromNodeId: rootNode?.node_id || graph.rootNodeId, toNodeId: nodeId,
      } });
      this.upsertCollaborationGraphEdge({ graphId: graph.graphId, edge: {
        kind: 'delegates_to', fromNodeId: rootNode?.node_id || graph.rootNodeId, toNodeId: nodeId,
      } });
      return { ...graph, uBuddyNodeId: nodeId };
    },

    upsertCollaborationGraphNode({ graphId = '', node = {}, idempotencyKey = '', eventType = 'node_upserted', actorUserId = '', actorAgentInstanceId = '' } = {}) {
      const normalized = normalizeCollaborationGraphNode(node);
      if (!graphId || !normalized.nodeId) throw new Error('collaboration_graph_node_identity_required');
      if ((normalized.kind === 'ubuddy' && normalized.depth > 1) || (normalized.kind === 'agent_task' && normalized.depth > 2)) {
        const error = new Error('已达到首版协作深度限制');
        error.code = 'UBUDDY_MAX_DEPTH_REACHED';
        throw error;
      }
      const existing = get(this.db, 'SELECT * FROM collaboration_graph_nodes WHERE graph_id=? AND node_id=?', [graphId, normalized.nodeId]);
      if (normalized.sourceRevision && Number(existing?.source_revision || 0) >= normalized.sourceRevision) return { applied: false, stale: true, node: existing ? normalizeGraphNodeRow(existing) : null };
      if (normalized.parentNodeId && normalized.parentNodeId === normalized.nodeId) throw collaborationCycleError();
      if (normalized.parentNodeId && graphParentPathExists(this.db, graphId, normalized.parentNodeId, normalized.nodeId)) throw collaborationCycleError();
      const now = normalized.updatedAt || nowIso();
      run(this.db, `INSERT INTO collaboration_graph_nodes(
        graph_id,node_id,parent_node_id,kind,task_run_id,delegation_id,task_node_id,owner_user_id,
        owner_agent_id,owner_agent_instance_id,title,public_summary,status,progress,depth,visibility,
        public_metadata_json,source_revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(graph_id,node_id) DO UPDATE SET
        parent_node_id=excluded.parent_node_id,kind=excluded.kind,
        task_run_id=CASE WHEN excluded.task_run_id!='' THEN excluded.task_run_id ELSE collaboration_graph_nodes.task_run_id END,
        delegation_id=CASE WHEN excluded.delegation_id!='' THEN excluded.delegation_id ELSE collaboration_graph_nodes.delegation_id END,
        task_node_id=CASE WHEN excluded.task_node_id!='' THEN excluded.task_node_id ELSE collaboration_graph_nodes.task_node_id END,
        owner_user_id=CASE WHEN excluded.owner_user_id!='' THEN excluded.owner_user_id ELSE collaboration_graph_nodes.owner_user_id END,
        owner_agent_id=CASE WHEN excluded.owner_agent_id!='' THEN excluded.owner_agent_id ELSE collaboration_graph_nodes.owner_agent_id END,
        owner_agent_instance_id=CASE WHEN excluded.owner_agent_instance_id!='' THEN excluded.owner_agent_instance_id ELSE collaboration_graph_nodes.owner_agent_instance_id END,
        title=excluded.title,public_summary=excluded.public_summary,status=excluded.status,progress=excluded.progress,
        depth=excluded.depth,visibility=excluded.visibility,public_metadata_json=excluded.public_metadata_json,
        source_revision=MAX(collaboration_graph_nodes.source_revision,excluded.source_revision),updated_at=excluded.updated_at`, [
        graphId, normalized.nodeId, normalized.parentNodeId, normalized.kind, normalized.taskRunId, normalized.delegationId,
        normalized.taskNodeId, normalized.ownerUserId, normalized.ownerAgentId, normalized.ownerAgentInstanceId,
        normalized.title, normalized.publicSummary, normalized.status, normalized.progress, normalized.depth, normalized.visibility,
        JSON.stringify(normalized.publicMetadata), normalized.sourceRevision, existing?.created_at || now, now,
      ]);
      const changed = this.appendCollaborationGraphEvent({
        graphId, eventId: stableCollaborationEventId(graphId, idempotencyKey || `${eventType}:${normalized.nodeId}:${normalized.sourceRevision || 0}`),
        eventType, nodeId: normalized.nodeId, publicPatch: normalized, actorUserId, actorAgentInstanceId,
      });
      return { applied: true, node: normalizeGraphNodeRow(get(this.db, 'SELECT * FROM collaboration_graph_nodes WHERE graph_id=? AND node_id=?', [graphId, normalized.nodeId])), event: changed.event };
    },

    upsertCollaborationGraphEdge({ graphId = '', edge = {}, idempotencyKey = '', actorUserId = '' } = {}) {
      const normalized = normalizeCollaborationGraphEdge(edge);
      if (!graphId || !normalized.fromNodeId || !normalized.toNodeId) throw new Error('collaboration_graph_edge_identity_required');
      if (normalized.fromNodeId === normalized.toNodeId) throw collaborationCycleError();
      if (STRUCTURAL_EDGE_KINDS.has(normalized.kind) && graphPathExists(this.db, graphId, normalized.toNodeId, normalized.fromNodeId)) throw collaborationCycleError();
      const edgeId = normalized.edgeId || stableCollaborationEdgeId(graphId, normalized.kind, normalized.fromNodeId, normalized.toNodeId);
      const existing = get(this.db, 'SELECT * FROM collaboration_graph_edges WHERE graph_id=? AND edge_id=?', [graphId, edgeId]);
      if (normalized.sourceRevision && Number(existing?.source_revision || 0) >= normalized.sourceRevision) return { applied: false, stale: true, edge: existing ? normalizeGraphEdgeRow(existing) : null };
      const now = normalized.updatedAt || nowIso();
      run(this.db, `INSERT INTO collaboration_graph_edges(
        graph_id,edge_id,kind,from_node_id,to_node_id,public_metadata_json,source_revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(graph_id,edge_id) DO UPDATE SET
        public_metadata_json=excluded.public_metadata_json,
        source_revision=MAX(collaboration_graph_edges.source_revision,excluded.source_revision),updated_at=excluded.updated_at`, [
        graphId, edgeId, normalized.kind, normalized.fromNodeId, normalized.toNodeId,
        JSON.stringify(normalized.publicMetadata), normalized.sourceRevision, existing?.created_at || now, now,
      ]);
      const changed = this.appendCollaborationGraphEvent({
        graphId, eventId: stableCollaborationEventId(graphId, idempotencyKey || `edge:${edgeId}:${normalized.sourceRevision || 0}`),
        eventType: 'edge_upserted', nodeId: normalized.toNodeId, publicPatch: { ...normalized, edgeId }, actorUserId,
      });
      return { applied: true, edge: normalizeGraphEdgeRow(get(this.db, 'SELECT * FROM collaboration_graph_edges WHERE graph_id=? AND edge_id=?', [graphId, edgeId])), event: changed.event };
    },

    appendCollaborationGraphEvent({ graphId = '', eventId = '', eventType = '', nodeId = '', publicPatch = {}, actorUserId = '', actorAgentInstanceId = '', createdAt = '' } = {}) {
      const id = String(eventId || '').trim() || newId('collab_event');
      const duplicate = get(this.db, 'SELECT * FROM collaboration_graph_events WHERE event_id=?', [id]);
      if (duplicate) return { applied: false, duplicate: true, event: normalizeGraphEventRow(duplicate) };
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const graph = get(this.db, 'SELECT current_revision FROM collaboration_graphs WHERE id=?', [graphId]);
        if (!graph) throw new Error('collaboration_graph_not_found');
        const revision = Number(graph.current_revision || 0) + 1;
        const now = createdAt || nowIso();
        run(this.db, `INSERT INTO collaboration_graph_events(
          graph_id,graph_revision,event_id,event_type,node_id,public_patch_json,actor_user_id,actor_agent_instance_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`, [graphId, revision, id, String(eventType || 'graph_updated'), nodeId,
          JSON.stringify(sanitizeCollaborationPublicValue(publicPatch || {})), actorUserId, actorAgentInstanceId, now]);
        run(this.db, 'UPDATE collaboration_graphs SET current_revision=?,updated_at=? WHERE id=?', [revision, now, graphId]);
        if (ownsTransaction) this.db.exec('COMMIT');
        return { applied: true, event: normalizeGraphEventRow(get(this.db, 'SELECT * FROM collaboration_graph_events WHERE event_id=?', [id])) };
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        if (/UNIQUE constraint failed: collaboration_graph_events\.event_id/i.test(String(error?.message || ''))) {
          return { applied: false, duplicate: true, event: normalizeGraphEventRow(get(this.db, 'SELECT * FROM collaboration_graph_events WHERE event_id=?', [id])) };
        }
        throw error;
      }
    },

    projectTaskRunToCollaborationGraph(taskRunId = '', change = {}) {
      const task = this.getTaskRun(taskRunId);
      if (!task) return null;
      const delegationId = String(task.metadata?.delegationId || '').trim();
      const groupId = String(task.metadata?.collaborationGroupId || '').trim();
      let delegation = null;
      if (delegationId) delegation = normalizeDelegationProjectionRow(get(this.db, 'SELECT * FROM agent_delegations WHERE id=?', [delegationId])) || {
        id: delegationId, groupId, workspaceId: task.workspaceId, requesterUserId: task.metadata?.externalRequesterUserId || '',
        recipientUserId: task.ownerUserId, recipientAgentId: 'secretary_agent', title: task.title, status: task.status,
        taskRunId: task.id, metadata: task.metadata,
      };
      const graph = delegationId
        ? this.ensureCollaborationGraphForDelegation(delegation)
        : this.ensureCollaborationGraph({ taskRunId: groupId ? '' : task.id, groupId, ownerWorkspaceId: task.workspaceId,
          ownerUserId: task.ownerUserId, title: task.title });
      const rootNodeId = graph.rootNodeId;
      const parentNodeId = delegationId ? graph.uBuddyNodeId : rootNodeId;
      if (delegationId) this.upsertCollaborationGraphNode({ graphId: graph.graphId, idempotencyKey: `bind:${delegationId}:${task.id}`, node: {
        nodeId: parentNodeId, parentNodeId: rootNodeId, kind: 'ubuddy', delegationId, taskRunId: task.id,
        ownerUserId: task.ownerUserId, ownerAgentId: 'secretary_agent', title: `${delegation?.recipientName || '接收方'} uBuddy`,
        publicSummary: task.summary || task.title, status: task.status, progress: taskProgress(task), depth: 1,
        publicMetadata: publicChangeMetadata(change),
      } });
      else this.upsertCollaborationGraphNode({ graphId: graph.graphId, idempotencyKey: `root-task:${task.id}:${task.updatedAt}`, node: {
        nodeId: rootNodeId, kind: 'root', taskRunId: task.id, ownerUserId: task.ownerUserId,
        ownerAgentId: task.leadAgentId, ownerAgentInstanceId: task.leadAgentInstanceId, title: task.title,
        publicSummary: task.summary || task.metadata?.objective?.summary || '', status: task.status,
        progress: taskProgress(task), depth: 0, publicMetadata: publicChangeMetadata(change),
      } });
      const changedNodes = [];
      const changedEdges = [];
      for (const taskNode of task.nodes || []) {
        const nodeId = stableCollaborationNodeId('agent_task', taskNode.id);
        const sourceRevision = timestampRevision(taskNode.updatedAt || task.updatedAt);
        const nodeResult = this.upsertCollaborationGraphNode({ graphId: graph.graphId,
          idempotencyKey: `task-node:${taskNode.id}:${sourceRevision}`, eventType: `task_node_${normalizeCollaborationStatus(taskNode.status)}`, node: {
            nodeId, parentNodeId, kind: 'agent_task', taskRunId: task.id, delegationId, taskNodeId: taskNode.id,
            ownerUserId: task.ownerUserId, ownerAgentId: taskNode.agentId, ownerAgentInstanceId: taskNode.agentInstanceId,
            title: taskNode.title, publicSummary: publicTaskNodeSummary(taskNode), status: taskNode.status,
            progress: collaborationNodeProgress(taskNode.status), depth: delegationId ? 2 : 1,
            publicMetadata: { waitReason: taskNode.waitReason || '', retryReason: taskNode.lastErrorCode || '', attemptCount: taskNode.attemptCount || 0, maxAttempts: taskNode.maxAttempts || 0 },
            sourceRevision, updatedAt: taskNode.updatedAt,
          } });
        if (nodeResult.applied) changedNodes.push(nodeResult.node);
        const parentEdge = this.upsertCollaborationGraphEdge({ graphId: graph.graphId, edge: {
          kind: 'parent_of', fromNodeId: parentNodeId, toNodeId: nodeId, sourceRevision,
        } });
        if (parentEdge.applied) changedEdges.push(parentEdge.edge);
        const assignmentEdge = this.upsertCollaborationGraphEdge({ graphId: graph.graphId, edge: {
          kind: 'assigned_to', fromNodeId: parentNodeId, toNodeId: nodeId, sourceRevision,
        } });
        if (assignmentEdge.applied) changedEdges.push(assignmentEdge.edge);
        for (const dependencyId of taskNode.dependencies || []) {
          const dependencyNodeId = stableCollaborationNodeId('agent_task', dependencyId);
          const dependencyEdge = this.upsertCollaborationGraphEdge({ graphId: graph.graphId, edge: {
            kind: 'dependency_of', fromNodeId: dependencyNodeId, toNodeId: nodeId, sourceRevision,
          } });
          if (dependencyEdge.applied) changedEdges.push(dependencyEdge.edge);
        }
      }
      const snapshot = this.getCollaborationGraph({ graphId: graph.graphId, afterRevision: Math.max(0, Number(change.afterRevision || 0)), skipAuthorization: true });
      return { ...snapshot, changedNodes, changedEdges };
    },

    getCollaborationGraph({ graphId = '', taskRunId = '', delegationId = '', groupId = '', afterRevision = 0, viewerUserId = '', viewerAgentInstanceId = '', skipAuthorization = false } = {}) {
      let row = resolveGraphRow(this.db, { graphId, taskRunId, delegationId, groupId });
      if (!row && taskRunId) {
        this.projectTaskRunToCollaborationGraph(taskRunId, { type: 'lazy_backfill' });
        row = resolveGraphRow(this.db, { graphId, taskRunId, delegationId, groupId });
      }
      if (!row && delegationId) {
        const delegation = normalizeDelegationProjectionRow(get(this.db, 'SELECT * FROM agent_delegations WHERE id=?', [delegationId]));
        if (delegation) this.ensureCollaborationGraphForDelegation(delegation);
        row = resolveGraphRow(this.db, { graphId, taskRunId, delegationId, groupId });
      }
      if (!row) return null;
      const permissions = graphPermissions(this.db, row, viewerUserId, viewerAgentInstanceId);
      if (!skipAuthorization && !permissions.canRead) {
        const error = new Error('collaboration_graph_forbidden');
        error.code = 'COLLABORATION_GRAPH_FORBIDDEN';
        throw error;
      }
      const nodes = all(this.db, 'SELECT * FROM collaboration_graph_nodes WHERE graph_id=? ORDER BY depth,created_at,node_id', [row.id]).map(normalizeGraphNodeRow);
      const edges = all(this.db, 'SELECT * FROM collaboration_graph_edges WHERE graph_id=? ORDER BY created_at,edge_id', [row.id]).map(normalizeGraphEdgeRow);
      const recentEvents = all(this.db, `SELECT * FROM collaboration_graph_events WHERE graph_id=? AND graph_revision>?
        ORDER BY graph_revision,event_id LIMIT 500`, [row.id, Math.max(0, Number(afterRevision || 0))]).map(normalizeGraphEventRow);
      return {
        graphVersion: row.graph_version || UBUDDY_COLLABORATION_GRAPH_VERSION,
        graphId: row.id,
        revision: Number(row.current_revision || 0),
        root: nodes.find((node) => node.nodeId === row.root_node_id) || nodes.find((node) => node.kind === 'root') || null,
        nodes, edges, recentEvents, permissions,
        redactionPolicy: { id: 'ubuddy_public_projection_v1', privateFieldsExcluded: true, visibility: 'participants' },
      };
    },

    getCollaborationGraphDelta({ graphId = '', taskRunId = '', delegationId = '', groupId = '', afterRevision = 0, viewerUserId = '', viewerAgentInstanceId = '', skipAuthorization = false } = {}) {
      const snapshot = this.getCollaborationGraph({ graphId, taskRunId, delegationId, groupId, afterRevision, viewerUserId, viewerAgentInstanceId, skipAuthorization });
      if (!snapshot) return null;
      const events = Array.isArray(snapshot.recentEvents) ? snapshot.recentEvents : [];
      const nodeIds = [...new Set(events.map((event) => String(event.nodeId || event.publicPatch?.nodeId || '').trim()).filter(Boolean))];
      const edgeIds = [...new Set(events.map((event) => String(event.publicPatch?.edgeId || '').trim()).filter(Boolean))];
      const changedNodes = snapshot.nodes.filter((node) => nodeIds.includes(node.nodeId));
      const changedEdges = snapshot.edges.filter((edge) => edgeIds.includes(edge.edgeId));
      return {
        graphVersion: snapshot.graphVersion,
        graphId: snapshot.graphId,
        baseRevision: Math.max(0, Number(afterRevision || 0)),
        targetRevision: snapshot.revision,
        graphEvents: events,
        changedNodes,
        changedEdges,
        permissions: snapshot.permissions,
      };
    },

    rejectNestedUBuddyDelegation({ taskRunId = '', delegationId = '', actorUserId = '' } = {}) {
      const task = taskRunId ? this.getTaskRun(taskRunId) : null;
      const sourceDelegationId = String(delegationId || task?.metadata?.delegationId || '').trim();
      if (!sourceDelegationId && task?.metadata?.taskOrigin !== 'external_delegation') return false;
      const graph = this.getCollaborationGraph({ taskRunId: task?.id || '', delegationId: sourceDelegationId, skipAuthorization: true });
      if (graph) this.appendCollaborationGraphEvent({
        graphId: graph.graphId,
        eventId: stableCollaborationEventId(graph.graphId, `depth-limit:${task?.id || sourceDelegationId}`),
        eventType: 'delegation_depth_blocked', nodeId: graph.nodes.find((node) => node.delegationId === sourceDelegationId)?.nodeId || graph.root?.nodeId || '',
        publicPatch: { status: 'blocked', reason: '已达到首版协作深度限制', recoverable: true, maxUBuddyDepth: 1 }, actorUserId,
      });
      return true;
    },
  });
}

function taskProgress(task) {
  const nodes = task.nodes || [];
  if (!nodes.length) return collaborationNodeProgress(task.status);
  return Math.round(nodes.reduce((sum, node) => sum + collaborationNodeProgress(node.status), 0) / nodes.length);
}

function publicTaskNodeSummary(node) {
  return publicCollaborationSummary(node.resultSummary || node.waitReason || node.errorText || node.objective || '');
}

function publicChangeMetadata(change = {}) {
  return sanitizeCollaborationPublicValue({ type: change.type || '', milestone: change.milestone || null, blocker: change.blocker || null });
}

function timestampRevision(value = '') {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? Math.max(1, time) : 0;
}

function graphPathExists(db, graphId, startNodeId, targetNodeId) {
  const adjacency = new Map();
  for (const row of all(db, `SELECT from_node_id,to_node_id FROM collaboration_graph_edges
    WHERE graph_id=? AND kind IN ('parent_of','delegates_to','assigned_to')`, [graphId])) {
    const values = adjacency.get(row.from_node_id) || [];
    values.push(row.to_node_id);
    adjacency.set(row.from_node_id, values);
  }
  const queue = [startNodeId];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === targetNodeId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(adjacency.get(current) || []));
  }
  return false;
}

function graphParentPathExists(db, graphId, startNodeId, targetNodeId) {
  let current = String(startNodeId || '');
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (current === targetNodeId) return true;
    seen.add(current);
    current = String(get(db, 'SELECT parent_node_id FROM collaboration_graph_nodes WHERE graph_id=? AND node_id=?', [graphId, current])?.parent_node_id || '');
  }
  return false;
}

function collaborationCycleError() {
  const error = new Error('collaboration_graph_cycle_detected');
  error.code = 'COLLABORATION_GRAPH_CYCLE';
  return error;
}

function resolveGraphRow(db, { graphId = '', taskRunId = '', delegationId = '', groupId = '' } = {}) {
  if (graphId) return get(db, 'SELECT * FROM collaboration_graphs WHERE id=?', [graphId]);
  if (groupId) return get(db, 'SELECT * FROM collaboration_graphs WHERE root_group_id=? ORDER BY updated_at DESC LIMIT 1', [groupId]);
  if (delegationId) return get(db, `SELECT cg.* FROM collaboration_graphs cg LEFT JOIN collaboration_graph_nodes cgn ON cgn.graph_id=cg.id
    WHERE cg.root_delegation_id=? OR cgn.delegation_id=? ORDER BY cg.updated_at DESC LIMIT 1`, [delegationId, delegationId]);
  if (taskRunId) return get(db, `SELECT cg.* FROM collaboration_graphs cg LEFT JOIN collaboration_graph_nodes cgn ON cgn.graph_id=cg.id
    WHERE cg.root_task_run_id=? OR cgn.task_run_id=? ORDER BY cg.updated_at DESC LIMIT 1`, [taskRunId, taskRunId]);
  return null;
}

function graphPermissions(db, graph, viewerUserId = '', viewerAgentInstanceId = '') {
  const userId = String(viewerUserId || '').trim();
  const agentInstanceId = String(viewerAgentInstanceId || '').trim();
  const owner = userId && userId === graph.owner_user_id;
  const nodeParticipant = userId && get(db, 'SELECT 1 FROM collaboration_graph_nodes WHERE graph_id=? AND owner_user_id=? LIMIT 1', [graph.id, userId]);
  const delegationParticipant = userId && get(db, `SELECT 1 FROM agent_delegations ad
    JOIN collaboration_graph_nodes cgn ON cgn.delegation_id=ad.id AND cgn.graph_id=?
    WHERE ad.requester_user_id=? OR ad.recipient_user_id=? LIMIT 1`, [graph.id, userId, userId]);
  const groupParticipant = userId && graph.root_group_id && get(db, `SELECT 1 FROM collaboration_group_members
    WHERE group_id=? AND user_id=? AND status!='removed' LIMIT 1`, [graph.root_group_id, userId]);
  const agentParticipant = agentInstanceId && get(db, 'SELECT 1 FROM collaboration_graph_nodes WHERE graph_id=? AND owner_agent_instance_id=? LIMIT 1', [graph.id, agentInstanceId]);
  const canRead = Boolean(owner || nodeParticipant || delegationParticipant || groupParticipant || agentParticipant);
  return { canRead, canSubscribe: canRead, canWritePublicProgress: Boolean(owner || nodeParticipant || agentParticipant), role: owner ? 'owner' : agentParticipant ? 'agent' : canRead ? 'participant' : 'none' };
}

function normalizeGraphRow(row) {
  return row ? { graphId: row.id, graphVersion: row.graph_version, rootTaskRunId: row.root_task_run_id, rootDelegationId: row.root_delegation_id,
    rootGroupId: row.root_group_id, rootNodeId: row.root_node_id, ownerWorkspaceId: row.owner_workspace_id,
    ownerUserId: row.owner_user_id, title: row.title, revision: Number(row.current_revision || 0), status: row.lifecycle_status,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function normalizeGraphNodeRow(row) {
  return row ? { nodeId: row.node_id, parentNodeId: row.parent_node_id, kind: row.kind, taskRunId: row.task_run_id,
    delegationId: row.delegation_id, taskNodeId: row.task_node_id, ownerUserId: row.owner_user_id,
    ownerAgentId: row.owner_agent_id, ownerAgentInstanceId: row.owner_agent_instance_id, title: row.title,
    publicSummary: row.public_summary, status: row.status, progress: Number(row.progress || 0), depth: Number(row.depth || 0),
    visibility: row.visibility, publicMetadata: safeJsonParse(row.public_metadata_json, {}), sourceRevision: Number(row.source_revision || 0),
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function normalizeGraphEdgeRow(row) {
  return row ? { edgeId: row.edge_id, kind: row.kind, fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
    publicMetadata: safeJsonParse(row.public_metadata_json, {}), sourceRevision: Number(row.source_revision || 0),
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function normalizeGraphEventRow(row) {
  return row ? { graphId: row.graph_id, graphRevision: Number(row.graph_revision || 0), eventId: row.event_id,
    eventType: row.event_type, nodeId: row.node_id, publicPatch: safeJsonParse(row.public_patch_json, {}),
    actorUserId: row.actor_user_id, actorAgentInstanceId: row.actor_agent_instance_id, createdAt: row.created_at } : null;
}

function normalizeDelegationProjectionRow(row) {
  if (!row) return null;
  const metadata = safeJsonParse(row.metadata_json, {});
  return { id: row.id, workspaceId: row.account_workspace_id, requesterUserId: row.requester_user_id,
    recipientUserId: row.recipient_user_id, senderAgentId: row.sender_agent_id, recipientAgentId: row.recipient_agent_id,
    title: row.title, instruction: row.instruction, status: row.status, groupId: row.group_id,
    taskRunId: row.task_run_id, metadata };
}
