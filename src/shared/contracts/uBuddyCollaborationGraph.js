import crypto from 'node:crypto';

export const UBUDDY_COLLABORATION_GRAPH_VERSION = 'ubuddy_collaboration_graph_v1';
export const UBUDDY_COLLABORATION_MAX_UBUDDY_DEPTH = 1;

export const COLLABORATION_GRAPH_NODE_KINDS = Object.freeze(['root', 'ubuddy', 'agent_task']);
export const COLLABORATION_GRAPH_EDGE_KINDS = Object.freeze([
  'parent_of', 'delegates_to', 'assigned_to', 'dependency_of',
]);

const PRIVATE_KEY_PATTERN = /(?:^|_)(?:prompt|memory|credential|secret|token|password|api_?key|private|workspace_?root|workspace_?path|file_?path|attachment_?path|local_?path|source_?path|cwd|home)(?:$|_)/i;
const PRIVATE_VALUE_PATTERN = /(?:[A-Za-z]:\\|\/(?:Users|home|private|var\/folders)\/|sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i;

export function stableCollaborationGraphId({ groupId = '', delegationId = '', taskRunId = '' } = {}) {
  const source = String(groupId || delegationId || taskRunId || '').trim();
  if (!source) throw new Error('collaboration_graph_source_required');
  const kind = groupId ? 'group' : delegationId ? 'delegation' : 'task';
  return `collab_graph_${kind}_${stableHash(source, 32)}`;
}

export function stableCollaborationNodeId(kind = '', sourceId = '') {
  const normalizedKind = normalizeEnum(kind, COLLABORATION_GRAPH_NODE_KINDS, 'agent_task');
  const source = String(sourceId || '').trim();
  if (!source) throw new Error('collaboration_graph_node_source_required');
  return `collab_node_${normalizedKind}_${stableHash(source, 32)}`;
}

export function stableCollaborationEdgeId(graphId = '', kind = '', fromNodeId = '', toNodeId = '') {
  const normalizedKind = normalizeEnum(kind, COLLABORATION_GRAPH_EDGE_KINDS, 'parent_of');
  return `collab_edge_${stableHash(`${graphId}\u001f${normalizedKind}\u001f${fromNodeId}\u001f${toNodeId}`, 40)}`;
}

export function stableCollaborationEventId(graphId = '', idempotencyKey = '') {
  return `collab_event_${stableHash(`${graphId}\u001f${String(idempotencyKey || '').trim()}`, 40)}`;
}

export function sanitizeCollaborationPublicValue(value, { depth = 0 } = {}) {
  if (depth > 6) return '[redacted_depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ').trim().slice(0, 2_000);
    return PRIVATE_VALUE_PATTERN.test(clean) ? '[redacted]' : clean;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeCollaborationPublicValue(item, { depth: depth + 1 }));
  if (typeof value !== 'object') return String(value).slice(0, 500);
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 100)) {
    const key = String(rawKey || '').trim();
    if (!key || PRIVATE_KEY_PATTERN.test(key)) continue;
    result[key] = sanitizeCollaborationPublicValue(rawValue, { depth: depth + 1 });
  }
  return result;
}

export function normalizeCollaborationStatus(status = '') {
  const value = String(status || '').trim().toLowerCase();
  const aliases = { pending: 'queued', ready: 'queued', accepted: 'queued', working: 'running', verifying: 'running', submitted: 'completed', result_accepted: 'completed', draft_ready: 'completed', withdrawn: 'cancelled', declined: 'cancelled', rejected: 'cancelled' };
  const normalized = aliases[value] || value;
  return ['queued', 'running', 'waiting', 'retry_wait', 'blocked', 'completed', 'failed', 'cancelled'].includes(normalized)
    ? normalized : 'queued';
}

export function collaborationNodeProgress(status = '', progress = null) {
  if (Number.isFinite(Number(progress))) return Math.max(0, Math.min(100, Math.round(Number(progress))));
  return ({ queued: 0, running: 35, waiting: 35, retry_wait: 35, blocked: 35, completed: 100, failed: 100, cancelled: 100 })[
    normalizeCollaborationStatus(status)
  ] ?? 0;
}

export function normalizeCollaborationGraphNode(node = {}) {
  const kind = normalizeEnum(node.kind, COLLABORATION_GRAPH_NODE_KINDS, 'agent_task');
  const status = normalizeCollaborationStatus(node.status);
  return {
    nodeId: String(node.nodeId || node.id || '').trim(),
    parentNodeId: String(node.parentNodeId || '').trim(),
    kind,
    taskRunId: String(node.taskRunId || '').trim(),
    delegationId: String(node.delegationId || '').trim(),
    taskNodeId: String(node.taskNodeId || '').trim(),
    ownerUserId: String(node.ownerUserId || '').trim(),
    ownerAgentId: String(node.ownerAgentId || node.agentId || '').trim(),
    ownerAgentInstanceId: String(node.ownerAgentInstanceId || node.agentInstanceId || '').trim(),
    title: String(node.title || '协作任务').replace(/\s+/g, ' ').trim().slice(0, 240),
    publicSummary: String(node.publicSummary || '').replace(/\s+/g, ' ').trim().slice(0, 2_000),
    status,
    progress: collaborationNodeProgress(status, node.progress),
    depth: Math.max(0, Math.min(2, Number(node.depth || 0))),
    visibility: String(node.visibility || 'participants').trim() || 'participants',
    publicMetadata: sanitizeCollaborationPublicValue(node.publicMetadata || {}),
    sourceRevision: Math.max(0, Number(node.sourceRevision || 0)),
    updatedAt: String(node.updatedAt || '').trim(),
  };
}

export function normalizeCollaborationGraphEdge(edge = {}) {
  return {
    edgeId: String(edge.edgeId || edge.id || '').trim(),
    kind: normalizeEnum(edge.kind, COLLABORATION_GRAPH_EDGE_KINDS, 'parent_of'),
    fromNodeId: String(edge.fromNodeId || '').trim(),
    toNodeId: String(edge.toNodeId || '').trim(),
    publicMetadata: sanitizeCollaborationPublicValue(edge.publicMetadata || {}),
    sourceRevision: Math.max(0, Number(edge.sourceRevision || 0)),
    updatedAt: String(edge.updatedAt || '').trim(),
  };
}

export function publicCollaborationSummary(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function stableHash(value, length) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}
