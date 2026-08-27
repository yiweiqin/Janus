const GRAPH_VERSION = 'ubuddy_collaboration_graph_v1';

export async function publishCollaborationGraph(pool, { viewerUserId = '', graph = {}, apiError = defaultApiError } = {}) {
  const graphId = String(graph.graphId || '').trim();
  const root = graph.root || (graph.nodes || []).find((node) => node.kind === 'root') || {};
  if (!graphId || graph.graphVersion !== GRAPH_VERSION || !root.nodeId) throw apiError(400, 'invalid_collaboration_graph');
  const scopeDelegationIds = [...new Set((graph.nodes || []).map((node) => String(node.delegationId || '')).filter(Boolean))];
  const scopeGroupId = String(root.publicMetadata?.groupId || graph.groupId || '').trim();
  const authorized = String(root.ownerUserId || graph.ownerUserId || '') === viewerUserId
    || (scopeDelegationIds.length && (await pool.query(`SELECT 1 FROM agent_delegations WHERE id=ANY($1::text[])
      AND (requester_user_id=$2 OR recipient_user_id=$2) LIMIT 1`, [scopeDelegationIds, viewerUserId])).rowCount > 0)
    || (scopeGroupId && (await pool.query(`SELECT 1 FROM collaboration_group_members WHERE group_id=$1 AND user_id=$2 AND status!='removed' LIMIT 1`, [scopeGroupId, viewerUserId])).rowCount > 0);
  if (!authorized) throw apiError(403, 'collaboration_graph_forbidden');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query('SELECT * FROM collaboration_graphs WHERE id=$1 FOR UPDATE', [graphId])).rows[0];
    const isDelta = String(graph.mode || '').toLowerCase() === 'delta';
    if (isDelta) {
      if (!existing) throw apiError(409, 'collaboration_graph_delta_base_missing');
      const baseRevision = Number(graph.baseRevision || 0);
      const eventIds = (graph.graphEvents || graph.recentEvents || []).map((event) => String(event.eventId || '').trim()).filter(Boolean);
      if (baseRevision !== Number(existing.current_revision || 0)) {
        const present = eventIds.length ? Number((await client.query('SELECT count(*) AS count FROM collaboration_graph_events WHERE event_id=ANY($1::text[])', [eventIds])).rows[0]?.count || 0) : 0;
        if (eventIds.length && present === eventIds.length) {
          await client.query('COMMIT');
          return { ok: true, idempotent: true, mode: 'delta', graphVersion: GRAPH_VERSION, graphId, baseRevision, revision: Number(existing.current_revision || 0) };
        }
        throw apiError(409, 'collaboration_graph_revision_conflict');
      }
      let revision = baseRevision;
      for (const node of (graph.changedNodes || []).slice(0, 500)) await upsertNode(client, graphId, node);
      for (const edge of (graph.changedEdges || []).slice(0, 1000)) await upsertEdge(client, graphId, edge);
      for (const event of (graph.graphEvents || graph.recentEvents || []).slice(0, 500)) {
        const eventId = String(event.eventId || '').trim();
        if (!eventId || (await client.query('SELECT 1 FROM collaboration_graph_events WHERE event_id=$1', [eventId])).rowCount) continue;
        revision += 1;
        await client.query(`INSERT INTO collaboration_graph_events(graph_id,graph_revision,event_id,event_type,node_id,public_patch_json,actor_user_id,actor_agent_instance_id,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now()))`, [graphId, revision, eventId, String(event.eventType || 'graph_updated'), String(event.nodeId || ''), safePublicJson(event.publicPatch), viewerUserId, String(event.actorAgentInstanceId || ''), event.createdAt || null]);
      }
      await client.query('UPDATE collaboration_graphs SET current_revision=$2,updated_at=now() WHERE id=$1', [graphId, revision]);
      await client.query('COMMIT');
      return { ok: true, mode: 'delta', graphVersion: GRAPH_VERSION, graphId, baseRevision, revision, appliedEventCount: revision - baseRevision };
    }
    await client.query(`INSERT INTO collaboration_graphs(id,graph_version,root_task_run_id,root_delegation_id,root_group_id,root_node_id,owner_workspace_id,owner_user_id,title,current_revision,lifecycle_status,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'active',now()) ON CONFLICT(id) DO UPDATE SET updated_at=now()`, [
      graphId, GRAPH_VERSION, String(root.taskRunId || ''), String(root.delegationId || ''), scopeGroupId,
      root.nodeId, String(graph.ownerWorkspaceId || 'workspace_personal'), String(root.ownerUserId || graph.ownerUserId || viewerUserId), String(root.title || '组织协作任务').slice(0, 240),
    ]);
    for (const node of (graph.nodes || []).slice(0, 500)) await client.query(`INSERT INTO collaboration_graph_nodes(
      graph_id,node_id,parent_node_id,kind,task_run_id,delegation_id,task_node_id,owner_user_id,owner_agent_id,owner_agent_instance_id,title,public_summary,status,progress,depth,visibility,public_metadata_json,source_revision,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now()) ON CONFLICT(graph_id,node_id) DO UPDATE SET
      parent_node_id=excluded.parent_node_id,task_run_id=excluded.task_run_id,delegation_id=excluded.delegation_id,task_node_id=excluded.task_node_id,
      owner_user_id=excluded.owner_user_id,owner_agent_id=excluded.owner_agent_id,owner_agent_instance_id=excluded.owner_agent_instance_id,title=excluded.title,
      public_summary=excluded.public_summary,status=excluded.status,progress=excluded.progress,depth=excluded.depth,visibility=excluded.visibility,
      public_metadata_json=excluded.public_metadata_json,source_revision=GREATEST(collaboration_graph_nodes.source_revision,excluded.source_revision),updated_at=now()
      WHERE excluded.source_revision=0 OR collaboration_graph_nodes.source_revision<=excluded.source_revision`, [graphId, String(node.nodeId || ''), String(node.parentNodeId || ''), String(node.kind || 'agent_task'), String(node.taskRunId || ''), String(node.delegationId || ''), String(node.taskNodeId || ''), String(node.ownerUserId || ''), String(node.ownerAgentId || ''), String(node.ownerAgentInstanceId || ''), String(node.title || '').slice(0, 240), String(node.publicSummary || '').slice(0, 2000), String(node.status || 'queued'), Math.max(0, Math.min(100, Number(node.progress || 0))), Math.max(0, Math.min(2, Number(node.depth || 0))), String(node.visibility || 'participants'), safePublicJson(node.publicMetadata), Math.max(0, Number(node.sourceRevision || 0))]);
    for (const edge of (graph.edges || []).slice(0, 1000)) await client.query(`INSERT INTO collaboration_graph_edges(graph_id,edge_id,kind,from_node_id,to_node_id,public_metadata_json,source_revision,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(graph_id,edge_id) DO UPDATE SET public_metadata_json=excluded.public_metadata_json,
      source_revision=GREATEST(collaboration_graph_edges.source_revision,excluded.source_revision),updated_at=now()
      WHERE excluded.source_revision=0 OR collaboration_graph_edges.source_revision<=excluded.source_revision`, [graphId, String(edge.edgeId || ''), String(edge.kind || 'parent_of'), String(edge.fromNodeId || ''), String(edge.toNodeId || ''), safePublicJson(edge.publicMetadata), Math.max(0, Number(edge.sourceRevision || 0))]);
    let revision = Number(existing?.current_revision || 0);
    for (const event of (graph.recentEvents || graph.graphEvents || []).slice(-500)) {
      const eventId = String(event.eventId || '').trim();
      if (!eventId || (await client.query('SELECT 1 FROM collaboration_graph_events WHERE event_id=$1', [eventId])).rowCount) continue;
      revision += 1;
      await client.query(`INSERT INTO collaboration_graph_events(graph_id,graph_revision,event_id,event_type,node_id,public_patch_json,actor_user_id,actor_agent_instance_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now()))`, [graphId, revision, eventId, String(event.eventType || 'graph_updated'), String(event.nodeId || ''), safePublicJson(event.publicPatch), viewerUserId, String(event.actorAgentInstanceId || ''), event.createdAt || null]);
    }
    await client.query('UPDATE collaboration_graphs SET current_revision=$2,updated_at=now() WHERE id=$1', [graphId, revision]);
    await client.query('COMMIT');
    return { ok: true, graphVersion: GRAPH_VERSION, graphId, revision };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function upsertNode(client, graphId, node) {
  await client.query(`INSERT INTO collaboration_graph_nodes(
    graph_id,node_id,parent_node_id,kind,task_run_id,delegation_id,task_node_id,owner_user_id,owner_agent_id,owner_agent_instance_id,title,public_summary,status,progress,depth,visibility,public_metadata_json,source_revision,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now()) ON CONFLICT(graph_id,node_id) DO UPDATE SET
    parent_node_id=excluded.parent_node_id,task_run_id=excluded.task_run_id,delegation_id=excluded.delegation_id,task_node_id=excluded.task_node_id,owner_user_id=excluded.owner_user_id,owner_agent_id=excluded.owner_agent_id,owner_agent_instance_id=excluded.owner_agent_instance_id,title=excluded.title,public_summary=excluded.public_summary,status=excluded.status,progress=excluded.progress,depth=excluded.depth,visibility=excluded.visibility,public_metadata_json=excluded.public_metadata_json,source_revision=GREATEST(collaboration_graph_nodes.source_revision,excluded.source_revision),updated_at=now()
    WHERE excluded.source_revision=0 OR collaboration_graph_nodes.source_revision<=excluded.source_revision`, [graphId, String(node.nodeId || ''), String(node.parentNodeId || ''), String(node.kind || 'agent_task'), String(node.taskRunId || ''), String(node.delegationId || ''), String(node.taskNodeId || ''), String(node.ownerUserId || ''), String(node.ownerAgentId || ''), String(node.ownerAgentInstanceId || ''), String(node.title || '').slice(0, 240), String(node.publicSummary || '').slice(0, 2000), String(node.status || 'queued'), Math.max(0, Math.min(100, Number(node.progress || 0))), Math.max(0, Math.min(2, Number(node.depth || 0))), String(node.visibility || 'participants'), safePublicJson(node.publicMetadata), Math.max(0, Number(node.sourceRevision || 0))]);
}

async function upsertEdge(client, graphId, edge) {
  await client.query(`INSERT INTO collaboration_graph_edges(graph_id,edge_id,kind,from_node_id,to_node_id,public_metadata_json,source_revision,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(graph_id,edge_id) DO UPDATE SET public_metadata_json=excluded.public_metadata_json,source_revision=GREATEST(collaboration_graph_edges.source_revision,excluded.source_revision),updated_at=now()
    WHERE excluded.source_revision=0 OR collaboration_graph_edges.source_revision<=excluded.source_revision`, [graphId, String(edge.edgeId || ''), String(edge.kind || 'parent_of'), String(edge.fromNodeId || ''), String(edge.toNodeId || ''), safePublicJson(edge.publicMetadata), Math.max(0, Number(edge.sourceRevision || 0))]);
}

export async function readCollaborationGraph(pool, {
  viewerUserId = '', graphId = '', taskRunId = '', delegationId = '', groupId = '', afterRevision = 0, apiError = defaultApiError,
} = {}) {
  const conditions = [];
  const params = [];
  const add = (sql, value) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)); };
  if (graphId) add('cg.id=?', graphId);
  else if (groupId) add('cg.root_group_id=?', groupId);
  else if (delegationId) {
    params.push(delegationId);
    conditions.push(`(cg.root_delegation_id=$${params.length} OR EXISTS(SELECT 1 FROM collaboration_graph_nodes n WHERE n.graph_id=cg.id AND n.delegation_id=$${params.length}))`);
  } else if (taskRunId) {
    params.push(taskRunId);
    conditions.push(`(cg.root_task_run_id=$${params.length} OR EXISTS(SELECT 1 FROM collaboration_graph_nodes n WHERE n.graph_id=cg.id AND n.task_run_id=$${params.length}))`);
  } else throw apiError(400, 'collaboration_graph_scope_required');
  const graph = (await pool.query(`SELECT cg.* FROM collaboration_graphs cg WHERE ${conditions.join(' AND ')} ORDER BY cg.updated_at DESC LIMIT 1`, params)).rows[0];
  if (!graph) throw apiError(404, 'collaboration_graph_not_found');
  const access = (await pool.query(`SELECT (
      cg.owner_user_id=$2 OR EXISTS(SELECT 1 FROM collaboration_graph_nodes n WHERE n.graph_id=cg.id AND n.owner_user_id=$2)
      OR EXISTS(SELECT 1 FROM collaboration_graph_nodes n JOIN agent_delegations d ON d.id=n.delegation_id
        WHERE n.graph_id=cg.id AND (d.requester_user_id=$2 OR d.recipient_user_id=$2))
      OR EXISTS(SELECT 1 FROM collaboration_group_members m WHERE m.group_id=cg.root_group_id AND m.user_id=$2 AND m.status!='removed')
    ) AS allowed FROM collaboration_graphs cg WHERE cg.id=$1`, [graph.id, viewerUserId])).rows[0];
  if (!access?.allowed) throw apiError(403, 'collaboration_graph_forbidden');
  const [nodesResult, edgesResult, eventsResult] = await Promise.all([
    pool.query('SELECT * FROM collaboration_graph_nodes WHERE graph_id=$1 ORDER BY depth,created_at,node_id', [graph.id]),
    pool.query('SELECT * FROM collaboration_graph_edges WHERE graph_id=$1 ORDER BY created_at,edge_id', [graph.id]),
    pool.query('SELECT * FROM collaboration_graph_events WHERE graph_id=$1 AND graph_revision>$2 ORDER BY graph_revision,event_id LIMIT 500', [graph.id, Math.max(0, Number(afterRevision || 0))]),
  ]);
  const nodes = nodesResult.rows.map(nodePayload);
  return {
    graphVersion: graph.graph_version || GRAPH_VERSION, graphId: graph.id, revision: Number(graph.current_revision || 0),
    root: nodes.find((node) => node.nodeId === graph.root_node_id) || nodes.find((node) => node.kind === 'root') || null,
    nodes, edges: edgesResult.rows.map(edgePayload), recentEvents: eventsResult.rows.map(eventPayload),
    permissions: { canRead: true, canSubscribe: true, canWritePublicProgress: graph.owner_user_id === viewerUserId, role: graph.owner_user_id === viewerUserId ? 'owner' : 'participant' },
    redactionPolicy: { id: 'ubuddy_public_projection_v1', privateFieldsExcluded: true, visibility: 'participants' },
  };
}

function nodePayload(row) { return { nodeId: row.node_id, parentNodeId: row.parent_node_id, kind: row.kind, taskRunId: row.task_run_id, delegationId: row.delegation_id, taskNodeId: row.task_node_id, ownerUserId: row.owner_user_id, ownerAgentId: row.owner_agent_id, ownerAgentInstanceId: row.owner_agent_instance_id, title: row.title, publicSummary: row.public_summary, status: row.status, progress: Number(row.progress || 0), depth: Number(row.depth || 0), visibility: row.visibility, publicMetadata: row.public_metadata_json || {}, sourceRevision: Number(row.source_revision || 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }
function edgePayload(row) { return { edgeId: row.edge_id, kind: row.kind, fromNodeId: row.from_node_id, toNodeId: row.to_node_id, publicMetadata: row.public_metadata_json || {}, sourceRevision: Number(row.source_revision || 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }
function eventPayload(row) { return { graphId: row.graph_id, graphRevision: Number(row.graph_revision || 0), eventId: row.event_id, eventType: row.event_type, nodeId: row.node_id, publicPatch: row.public_patch_json || {}, actorUserId: row.actor_user_id, actorAgentInstanceId: row.actor_agent_instance_id, createdAt: iso(row.created_at) }; }
function iso(value) { return value instanceof Date ? value.toISOString() : String(value || ''); }
function safePublicJson(value) {
  const blocked = /(?:prompt|memory|credential|secret|token|password|api_?key|workspace_?root|file_?path|attachment_?path|local_?path|source_?path|cwd)/i;
  const visit = (input, depth = 0) => {
    if (depth > 6 || input === null || input === undefined || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, 2000) : input;
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => visit(item, depth + 1));
    return Object.fromEntries(Object.entries(input).filter(([key]) => !blocked.test(key)).slice(0, 100).map(([key, item]) => [key, visit(item, depth + 1)]));
  };
  return visit(value || {});
}
function defaultApiError(status, message) { const error = new Error(message); error.status = status; return error; }
