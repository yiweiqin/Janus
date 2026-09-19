import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';
import {
  UBUDDY_AGENT_PLAN_STEP_VERSION,
  agentPlanEventsFromTaskEvents,
  firstAgentPlan,
  foldAgentPlanEvents,
} from '../../../../shared/contracts/uBuddyAgentPlanSteps.js';
import {
  PLAN_EXEC_CONSTANTS,
  PLAN_EXEC_FIELD_SOURCES,
  buildPlanExecGraphs,
  planExecCase,
  planExecContractGaps,
  planExecMetricReadiness,
  planExecPublicMemory,
  summarizePlanExecGaps,
} from '../../../../shared/contracts/uBuddyPlanExec.js';
import {
  COLLABORATION_GRAPH_MAX_DEPTH,
  UBUDDY_COLLABORATION_GRAPH_VERSION,
  UBUDDY_COLLABORATION_MAX_UBUDDY_DEPTH,
  collaborationMaxDepth,
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

// 参与环检测的边类型（`graphPathExists` 的邻接表来源）。
// `sequence_of` 也在其中：它是有向顺序关系，顺序链上出现环同样是坏图。
const STRUCTURAL_EDGE_KINDS = new Set(['parent_of', 'delegates_to', 'assigned_to', 'sequence_of']);

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
      // 深度上限按 kind 分级判定，且必须看**归一化之前**的请求值：
      // normalizeCollaborationGraphNode 会把越界深度钳到该 kind 的上限，
      // 若用钳后的值判定，越界输入会被静默接受（旧代码就是这个盲区）。
      const requestedDepth = Math.max(0, Math.floor(Number(node.depth || 0)));
      const maxDepth = collaborationMaxDepth(normalized.kind);
      if (requestedDepth > maxDepth) {
        const error = new Error(`已达到协作深度限制：${normalized.kind} 最多 depth ${maxDepth}`);
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
      const taskNodeParents = new Map();
      for (const taskNode of task.nodes || []) {
        const nodeId = stableCollaborationNodeId('agent_task', taskNode.id);
        const sourceRevision = timestampRevision(taskNode.updatedAt || task.updatedAt);
        taskNodeParents.set(taskNode.id, { nodeId, agentId: taskNode.agentId || '', agentInstanceId: taskNode.agentInstanceId || '' });
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
      const planProjection = projectAgentPlanSteps(this, { graphId: graph.graphId, task, taskNodeParents });
      changedNodes.push(...planProjection.nodes);
      changedEdges.push(...planProjection.edges);
      const snapshot = this.getCollaborationGraph({ graphId: graph.graphId, afterRevision: Math.max(0, Number(change.afterRevision || 0)), skipAuthorization: true });
      return { ...snapshot, changedNodes, changedEdges, planProjection: planProjection.summary };
    },

    // uBuddy <-> uBuddy 的协调边。
    //
    // 群任务图上原本只有 root -> ubuddy 的放射边（delegates_to / parent_of），看不出
    // 「接收方的 uBuddy 向发起方的 uBuddy 请求对齐」这件事。而依赖阻塞导致的返工恰恰是
    // 最值钱的漂移信号：规划图上这是一条顺滑的依赖，执行图上它逼出了一次跨人协调。
    //
    // 数据来源是**真实发生过的协调动作**（createDelegationRuntimeApi 里
    // `metadata.type === 'ubuddy_peer_coordination'` 那条消息成功发出之后），不是从库里猜的。
    // 方向固定为「接收方 uBuddy → 发起方 uBuddy」，也就是反向的那一条，
    // 两个方向合起来才说明这两个 uBuddy 真的打过交道。
    //
    // 刻意**只在图已存在时补边**：协调是图上的新信息，不该顺手把图建出来。
    // 也因此刻意**不把 coordinates_with 放进 STRUCTURAL_EDGE_KINDS** ——
    // 它的方向和 delegates_to 正好相反，算进环检测会把正常的 root->ubuddy 误判成环。
    //
    // 边界身份是结构性的（graphId + kind + from + to，见 stableCollaborationEdgeId），
    // 所以一对 uBuddy 之间**只有一条** coordinates_with。多次协调不是多条边，而是把
    // reason 累积进 `reasons` —— 这反而更贴近 RDMD 要的信号：同一个依赖点反复摩擦了几次、
    // 分别因为什么。纯重放不会改变这条边（幂等），只有新 reason 才会。
    recordCollaborationCoordinationEdge({ groupId = '', delegationId = '', reason = '', sourceEventId = '' } = {}) {
      const cleanDelegationId = String(delegationId || '').trim();
      if (!cleanDelegationId) return { applied: false, reason: 'delegation_required' };
      const graph = resolveGraphRow(this.db, { groupId: String(groupId || '').trim(), delegationId: cleanDelegationId });
      if (!graph) return { applied: false, reason: 'graph_not_found' };
      const nodes = all(this.db, 'SELECT node_id,kind,delegation_id FROM collaboration_graph_nodes WHERE graph_id=?', [graph.id]);
      const fromNodeId = String(nodes.find((node) => node.kind === 'ubuddy' && node.delegation_id === cleanDelegationId)?.node_id || '');
      const toNodeId = String(nodes.find((node) => node.kind === 'root')?.node_id || graph.root_node_id || '');
      if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return { applied: false, reason: 'coordination_endpoints_missing' };
      const edgeId = stableCollaborationEdgeId(graph.id, 'coordinates_with', fromNodeId, toNodeId);
      const previous = safeJsonParse(get(this.db, 'SELECT public_metadata_json FROM collaboration_graph_edges WHERE graph_id=? AND edge_id=?', [graph.id, edgeId])?.public_metadata_json, {});
      const cleanReason = String(reason || '').trim();
      const reasons = [...new Set([...(Array.isArray(previous.reasons) ? previous.reasons : []), cleanReason].filter(Boolean))];
      const edge = this.upsertCollaborationGraphEdge({ graphId: graph.id,
        idempotencyKey: `peer-coordination:${cleanDelegationId}:${cleanReason}`,
        edge: { kind: 'coordinates_with', fromNodeId, toNodeId,
          publicMetadata: { reasons, source: 'ubuddy_peer_coordination', lastSourceEventId: String(sourceEventId || '') } } });
      return { ...edge, fromNodeId, toNodeId, reasons };
    },

    // 产品侧的 (G_plan, G_exec) 读取通路。
    //
    // 语义与字段来源见 `src/shared/contracts/uBuddyPlanExec.js` 与
    // `ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md`。这里只负责把四份数据凑齐喂给纯函数：
    //   1. collaboration graph 快照                    -> 执行层骨架
    //   2. task_runs.metadata_json.taskGraphProposal   -> 组织层规划
    //   3. task_events 的**首版** plan                 -> agent 层规划
    //   4. task_nodes.result_text                      -> 11 字段里的 output
    //
    // ## 为什么不用事件 replay 还原「第 N 版图」（计划里留的那个待决问题）
    //
    // 因为 G_plan 与 G_exec 的差异**不是同一张图的第几版**，而是两个不同来源：
    // 组织层是 planner 的提案 vs 真实 task_nodes，agent 层是首版 plan vs 折叠后的最终状态。
    //
    // 事件 replay 只能给出一张图的演化轨迹。它给不出「规划了但从未发生」——
    // 提案里有、执行里没有的节点**从头到尾就没有任何事件**，replay 再多次也看不见它。
    // 而「规划了一个永远不会发生的节点」恰恰是最值钱的那类漂移。
    // 所以 replay 在这里是错工具：它恰好对最有价值的信号盲。
    readPlanExecGraphs({ taskRunId = '', delegationId = '', groupId = '', viewerUserId = '', skipAuthorization = false } = {}) {
      const snapshot = this.getCollaborationGraph({ taskRunId, delegationId, groupId, viewerUserId, skipAuthorization });
      if (!snapshot) return null;
      const taskRunIds = [...new Set(snapshot.nodes.map((node) => String(node.taskRunId || '')).filter(Boolean))];
      const proposalNodesByTaskRun = {};
      const resultTextByTaskNode = {};
      const planEventsByTaskNode = new Map();
      for (const runId of taskRunIds) {
        const task = this.getTaskRun(runId);
        if (!task) continue;
        const proposalNodes = proposalNodesFromTaskRun(task);
        if (proposalNodes.length) proposalNodesByTaskRun[runId] = proposalNodes;
        for (const node of task.nodes || []) {
          if (node.resultText) resultTextByTaskNode[node.id] = node.resultText;
        }
        for (const event of agentPlanEventsFromTaskEvents(task.events)) {
          const taskNodeId = String(event.taskNodeId || '').trim();
          if (!taskNodeId) continue;
          const list = planEventsByTaskNode.get(taskNodeId) || [];
          list.push(event);
          planEventsByTaskNode.set(taskNodeId, list);
        }
      }
      const firstPlanStepsByTaskNode = {};
      for (const [taskNodeId, events] of planEventsByTaskNode) {
        const first = firstAgentPlan(events);
        if (first.supported) firstPlanStepsByTaskNode[taskNodeId] = first.steps;
      }
      const graphs = buildPlanExecGraphs({ graphNodes: snapshot.nodes, graphEdges: snapshot.edges,
        proposalNodesByTaskRun, firstPlanStepsByTaskNode, resultTextByTaskNode });
      // case id 与 scope 同源：群作用域取**解析出来的**那个，而不是回抄入参。
      // 回抄的话按 taskRunId 读会得到 run id —— 同一类任务的 case 身份每轮都不同，
      // 而 scope 里明明写着真正的群 id。两处口径不一致比两处都错更难查。
      const resolvedGroupId = String(snapshot.groupId || groupId || '');
      const caseId = String(resolvedGroupId || delegationId || taskRunId || snapshot.graphId);
      const modelCase = planExecCase({ id: caseId, plan: graphs.plan, exec: graphs.exec });
      const gaps = planExecContractGaps(modelCase);
      const participantUserIds = [...new Set([
        String(snapshot.root?.ownerUserId || ''),
        ...snapshot.nodes.map((node) => String(node.ownerUserId || '')),
      ].filter(Boolean))];
      return {
        scope: { graphId: snapshot.graphId, revision: snapshot.revision,
          taskRunId: String(taskRunId || ''),
          delegationId: String(delegationId || ''),
          // 群作用域必须取**快照解析出来的**那一个，而不是回抄调用方的入参。
          //
          // 回抄是一个静默失败：`planExecDriftService.record()` 是按 taskRunId 调进来的
          // （不带 groupId），于是 `scope.groupId` 恒为空串 → `planExecTaskFamily` 的 anchor
          // 退化成 `task_run` → 记录里的 `taskFamily.degenerate` 恒为 true。后果是
          // 「提案数在涨」永远不可能变成「样本在积累」，而且**不会报任何错**。
          // 这与 `getCollaborationGraph` 里那句「群作用域必须随快照出去」是同一个坑。
          groupId: String(snapshot.groupId || groupId || ''),
          taskRunIds },
        plan: graphs.plan,
        exec: graphs.exec,
        mapping: graphs.mapping,
        // 模型输入：11 字段 + kind，可以直接喂 `detectMinimalDrift` / `planExecProximity`，
        // `planExecContractGaps(case)` 为空时才可以喂模型。
        case: modelCase,
        gaps,
        gapSummary: summarizePlanExecGaps(gaps),
        // 「相近效果」度量与模型契约**分开报**：度量今天就能跑，模型还不能。
        metric: planExecMetricReadiness(graphs.plan, graphs.exec),
        constants: PLAN_EXEC_CONSTANTS,
        fieldSources: PLAN_EXEC_FIELD_SOURCES,
        memory: planExecPublicMemory({ taskId: caseId, ownerUserId: String(snapshot.root?.ownerUserId || ''),
          participantUserIds, plan: graphs.plan, exec: graphs.exec }),
      };
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
        // 群作用域必须随快照出去。
        //
        // 云侧 publishCollaborationGraph 的第一版是拿 `graph.groupId` 算 scopeGroupId、
        // 并把它写进 collaboration_graphs.root_group_id；而云侧读授权
        // （storedGraphParticipant）与后续每个 delta 的写授权都用那一列去查
        // collaboration_group_members。云侧从来不自己能从别处推出这个 id。
        //
        // 之前这里不返回 groupId，于是 root_group_id 永远是空串，云侧那条
        // 「群成员可读可写」的分支成了死代码：本地（graphPermissions 用本地
        // root_group_id）认为群成员能读，云端却会 403。两边口径不一致。
        groupId: String(row.root_group_id || ''),
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
        publicPatch: { status: 'blocked', reason: '已达到首版协作深度限制', recoverable: true, maxUBuddyDepth: UBUDDY_COLLABORATION_MAX_UBUDDY_DEPTH }, actorUserId,
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

// 把 agent 自己规划的执行步骤（plan steps）投影成 `agent_step` 节点 + `sequence_of` 顺序链。
//
// 为什么需要它：root / ubuddy / agent_task 之间只有包含与指派关系，没有任何顺序关系，
// 所以三级以内的图**不可能**表达「漂移的后果要 >=3 跳后才可见」—— 没有链，就没有级联。
// `sequence_of` 是整张图上唯一的真链来源。
//
// 隐私边界：`public_summary` 对参与者可见，所以这里**只投影步骤名（title）与状态**，
// 不投影 `step.detail`（可能是工具原始输出、文件内容）也不投影 `plan.explanation`。
// 本地比对（G_plan/G_exec）需要这些内容时直接从 `task_events` 读，不进公开投影。
// 步骤名本身仍过一遍 `sanitizeCollaborationPublicValue`，命中路径/密钥特征就记成 [redacted]。
function projectAgentPlanSteps(store, { graphId = '', task = {}, taskNodeParents = new Map() } = {}) {
  const summary = { appliedNodes: 0, appliedEdges: 0, taskNodesWithPlan: 0, revisions: 0, skippedEvents: 0 };
  const nodes = [];
  const edges = [];
  const planEvents = agentPlanEventsFromTaskEvents(task.events);
  if (!planEvents.length) return { nodes, edges, summary };
  const eventsByTaskNode = new Map();
  for (const event of planEvents) {
    const taskNodeId = String(event.taskNodeId || '').trim();
    if (!taskNodeId || !taskNodeParents.has(taskNodeId)) continue;
    const list = eventsByTaskNode.get(taskNodeId) || [];
    list.push(event);
    eventsByTaskNode.set(taskNodeId, list);
  }
  for (const [taskNodeId, nodeEvents] of eventsByTaskNode) {
    const parent = taskNodeParents.get(taskNodeId);
    const folded = foldAgentPlanEvents(nodeEvents, { revisionOf: (event) => timestampRevision(event.createdAt) });
    summary.revisions += folded.revisions;
    summary.skippedEvents += folded.skipped;
    if (!folded.steps.length && !folded.cancelled.length) continue;
    summary.taskNodesWithPlan += 1;
    const upsertStep = ({ index, label, status, revision, updatedAt = '' }) => {
      const nodeId = stableCollaborationNodeId('agent_step', `${taskNodeId}:${index}`);
      const result = store.upsertCollaborationGraphNode({ graphId,
        idempotencyKey: `agent-step:${taskNodeId}:${index}:${revision}:${status}`,
        eventType: `agent_step_${status}`, node: {
          nodeId, parentNodeId: parent.nodeId, kind: 'agent_step', taskRunId: task.id, taskNodeId,
          ownerUserId: task.ownerUserId, ownerAgentId: parent.agentId, ownerAgentInstanceId: parent.agentInstanceId,
          title: sanitizeCollaborationPublicValue(label), publicSummary: '', status,
          progress: collaborationNodeProgress(status), depth: COLLABORATION_GRAPH_MAX_DEPTH.agent_step,
          publicMetadata: { planStepIndex: index, planRevision: revision, planStepVersion: UBUDDY_AGENT_PLAN_STEP_VERSION },
          sourceRevision: revision, updatedAt,
        } });
      if (result.applied) { nodes.push(result.node); summary.appliedNodes += 1; }
      // 归属边是节点自身的属性（包含关系），和它是第几步、在不在顺序链上无关，
      // 所以放在这里：被砍掉的步骤也仍然属于这个 task。
      const parentEdge = store.upsertCollaborationGraphEdge({ graphId, edge: {
        kind: 'parent_of', fromNodeId: parent.nodeId, toNodeId: nodeId, sourceRevision: revision,
      } });
      if (parentEdge.applied) { edges.push(parentEdge.edge); summary.appliedEdges += 1; }
      return nodeId;
    };
    let previousStepNodeId = '';
    for (const step of folded.steps) {
      const nodeId = upsertStep(step);
      if (previousStepNodeId) {
        const sequenceEdge = store.upsertCollaborationGraphEdge({ graphId, edge: {
          kind: 'sequence_of', fromNodeId: previousStepNodeId, toNodeId: nodeId, sourceRevision: step.revision,
        } });
        if (sequenceEdge.applied) { edges.push(sequenceEdge.edge); summary.appliedEdges += 1; }
      }
      previousStepNodeId = nodeId;
    }
    // 后续版本把某个 step 砍掉了 -> 标成 cancelled，而不是留着它上一版的 running 状态骗人。
    // 用 lastRevision 作为源版本，保证这次修正不会被 source_revision 守卫判成过期。
    for (const step of folded.cancelled) {
      upsertStep({ ...step, status: 'cancelled', updatedAt: '', revision: folded.lastRevision });
    }
  }
  return { nodes, edges, summary };
}

function graphPathExists(db, graphId, startNodeId, targetNodeId) {
  const adjacency = new Map();
  const kinds = [...STRUCTURAL_EDGE_KINDS];
  for (const row of all(db, `SELECT from_node_id,to_node_id FROM collaboration_graph_edges
    WHERE graph_id=? AND kind IN (${kinds.map(() => '?').join(',')})`, [graphId, ...kinds])) {
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

// planner 提案 -> 纯函数要的形状。
//
// `metadata_json.taskGraphProposal` 的形状见
// `src/main/modules/orchestration/application/uBuddyTaskGraphPlanner.js#validateUBuddyTaskGraphProposal`：
// 每个节点带 localId / title / objective / agentId / dependencies[] / outputFormat / isFinal ...
// 这里只取组图用得上的四个。`localId` 缺失时退回 `node_<i>` —— 提案校验本来就会补，
// 但读到一条历史脏数据不该让整条读取通路炸掉。
function proposalNodesFromTaskRun(task = {}) {
  const source = task.metadata?.taskGraphProposal;
  const nodes = Array.isArray(source?.nodes) ? source.nodes : [];
  return nodes.map((node, index) => {
    const item = node && typeof node === 'object' ? node : {};
    return {
      localId: String(item.localId || item.id || `node_${index + 1}`).trim(),
      title: String(item.title || item.objective || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      agentId: String(item.agentId || '').trim(),
      dependencies: [...new Set((Array.isArray(item.dependencies) ? item.dependencies : [])
        .map((dependency) => String(dependency || '').trim()).filter(Boolean))],
    };
  }).filter((node) => node.localId);
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
