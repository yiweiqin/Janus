import { sanitizeCollaborationPublicValue } from './uBuddyCollaborationGraph.js';

export const UBUDDY_TPM_VERSION = 'ubuddy_task_public_memory_v1';
export const TPM_LAYERS = Object.freeze(['foundation', 'elevation', 'raw']);
export const TPM_AI_REVIEW_DECISIONS = Object.freeze(['pass', 'reject', 'need_human']);
export const TPM_OWNER_REVIEW_DECISIONS = Object.freeze(['approve', 'deny']);

const SECRET_PATTERN = /(?:sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----|(?:api[_ -]?key|password|passwd|secret|token)\s*[:=：]|[A-Za-z]:\\|(?:^|[\s("'`])\/(?:Users|home)\b)/i;
const WIDE_SCOPE_NODE_LIMIT = 8;
const DEFAULT_GRANT_TTL_MS = 2 * 60 * 60 * 1000;

export function normalizeTaskGraph(value = {}) {
  const source = objectValue(value);
  const nodes = array(source.nodes).map((node) => ({
    id: text(node.id || node.nodeId),
    title: text(node.title, 240),
    agentId: text(node.agentId || node.ownerAgentId, 160),
    version: text(node.version || node.resultVersion, 80) || 'v1',
    acceptance: text(node.acceptance, 160) || 'standard',
    role: text(node.role, 80),
    status: text(node.status, 40) || 'planned',
  })).filter((node) => node.id);
  const edges = array(source.edges).map((edge) => ({
    id: text(edge.id || edge.edgeId) || `${text(edge.from || edge.fromNodeId)}->${text(edge.to || edge.toNodeId)}`,
    from: text(edge.from || edge.fromNodeId),
    to: text(edge.to || edge.toNodeId),
  })).filter((edge) => edge.from && edge.to);
  return { nodes, edges };
}

export function normalizeTaskPublicMemory(value = {}) {
  const source = objectValue(value);
  const foundation = objectValue(source.foundation);
  return {
    version: text(source.version, 80) || UBUDDY_TPM_VERSION,
    taskId: text(source.taskId || source.task_id, 160),
    ownerUserId: text(source.ownerUserId || source.owner_user_id, 160),
    participantUserIds: unique(source.participantUserIds || source.participant_user_ids),
    foundation: {
      plan: normalizeTaskGraph(foundation.plan || source.plan || source.G_plan),
      exec: normalizeTaskGraph(foundation.exec || source.exec || source.G_exec),
    },
    elevation: array(source.elevation).map(normalizeElevationItem).filter((item) => item.id),
    raw: array(source.raw).map(normalizeRawItem).filter((item) => item.id),
  };
}

export function inspectElevationItems(rawItems = [], { now = new Date().toISOString() } = {}) {
  const accepted = [];
  const rejected = [];
  for (const item of array(rawItems)) {
    const raw = normalizeRawItem(item);
    const blob = `${raw.title}\n${raw.content}`;
    if (!raw.id || SECRET_PATTERN.test(blob)) {
      rejected.push({ id: raw.id, reason: 'inspect_failed_secret_or_empty' });
      continue;
    }
    accepted.push({
      id: `elev_${raw.id}`,
      sourceRawId: raw.id,
      kind: raw.kind || 'summary',
      title: raw.title,
      summary: sanitizeCollaborationPublicValue(raw.content).slice(0, 500),
      resultVersion: raw.resultVersion,
      inspectedAt: now,
    });
  }
  return { accepted, rejected };
}

export function projectTaskPublicMemory(value = {}, viewer = {}) {
  const memory = normalizeTaskPublicMemory(value);
  const view = normalizeViewer(viewer);
  const participant = isParticipant(memory, view);
  const grant = validGrant(view.grant, memory, view);
  const projected = {
    version: memory.version,
    taskId: memory.taskId,
    layers: [],
    foundation: null,
    elevation: [],
    raw: [],
    denied: [],
  };
  if (!participant && !grant) {
    projected.denied.push('not_participant_and_no_grant');
    return projected;
  }
  projected.layers.push('foundation', 'elevation');
  projected.foundation = memory.foundation;
  projected.elevation = memory.elevation;
  if (!grant) {
    projected.denied.push('raw_requires_grant');
    return projected;
  }
  projected.layers.push('raw');
  projected.raw = sliceRaw(memory.raw, grant);
  return projected;
}

export function createRawAccessRequest(value = {}) {
  const source = objectValue(value);
  return {
    requestId: text(source.requestId, 160) || `tpm_req_${Date.now()}`,
    sourceTaskId: text(source.sourceTaskId, 160),
    targetTaskId: text(source.targetTaskId, 160),
    requesterUserId: text(source.requesterUserId, 160),
    purpose: text(source.purpose, 500),
    nodeIds: unique(source.nodeIds).slice(0, 64),
    excerptOnly: source.excerptOnly !== false,
    createdAt: iso(source.createdAt) || new Date().toISOString(),
  };
}

export function reviewRawAccessByAi(request = {}, memory = {}) {
  const req = createRawAccessRequest(request);
  const tpm = normalizeTaskPublicMemory(memory);
  const reasons = [];
  if (!req.sourceTaskId || !req.targetTaskId) reasons.push('missing_task_scope');
  if (!req.purpose) reasons.push('missing_purpose');
  if (req.targetTaskId && tpm.taskId && req.targetTaskId !== tpm.taskId) reasons.push('target_task_mismatch');
  if (!req.nodeIds.length) reasons.push('empty_node_window');
  if (req.nodeIds.length > WIDE_SCOPE_NODE_LIMIT && !req.excerptOnly) reasons.push('scope_too_wide');
  const rawBlob = tpm.raw.map((item) => item.content).join('\n');
  if (SECRET_PATTERN.test(rawBlob) && !req.excerptOnly) reasons.push('raw_contains_secrets');
  if (req.purpose && tpm.elevation.length) {
    const haystack = tpm.elevation.map((item) => `${item.title} ${item.summary}`).join(' ');
    if (!purposeGrounded(req.purpose, haystack)) reasons.push('purpose_not_grounded');
  }
  const hard = reasons.filter((code) => code !== 'purpose_not_grounded');
  const decision = hard.length ? 'reject' : reasons.length ? 'need_human' : 'pass';
  return { decision, reasons, request: req };
}

export function reviewRawAccessByOwner(request = {}, ownerDecision = 'deny', { actorUserId = '', now = Date.now() } = {}) {
  const req = createRawAccessRequest(request);
  const decision = TPM_OWNER_REVIEW_DECISIONS.includes(ownerDecision) ? ownerDecision : 'deny';
  if (decision !== 'approve') {
    return { decision: 'deny', grant: null, request: req };
  }
  return {
    decision: 'approve',
    grant: {
      grantId: `tpm_grant_${req.requestId}`,
      requestId: req.requestId,
      targetTaskId: req.targetTaskId,
      granteeUserId: req.requesterUserId,
      nodeIds: req.nodeIds,
      excerptOnly: req.excerptOnly,
      readOnly: true,
      revocable: true,
      expiresAt: new Date(now + DEFAULT_GRANT_TTL_MS).toISOString(),
      approvedBy: actorUserId,
    },
    request: req,
  };
}

export function applyRawAccessPipeline(request = {}, memory = {}, { ownerDecision = 'deny', actorUserId = '', now = Date.now() } = {}) {
  const ai = reviewRawAccessByAi(request, memory);
  if (ai.decision === 'reject') {
    return { stage: 'ai', ai, owner: null, projection: projectTaskPublicMemory(memory, viewerFromRequest(request)) };
  }
  const owner = reviewRawAccessByOwner(request, ownerDecision, { actorUserId, now });
  const viewer = viewerFromRequest(request, owner.grant);
  return {
    stage: 'owner',
    ai,
    owner,
    projection: projectTaskPublicMemory(memory, viewer),
  };
}

function normalizeElevationItem(value = {}) {
  const source = objectValue(value);
  return {
    id: text(source.id),
    sourceRawId: text(source.sourceRawId),
    kind: text(source.kind, 80) || 'summary',
    title: text(source.title, 240),
    summary: text(source.summary, 500),
    resultVersion: text(source.resultVersion, 80),
    inspectedAt: iso(source.inspectedAt),
  };
}

function normalizeRawItem(value = {}) {
  const source = objectValue(value);
  return {
    id: text(source.id),
    kind: text(source.kind, 80) || 'context',
    title: text(source.title, 240),
    content: String(source.content || source.body || ''),
    resultVersion: text(source.resultVersion, 80),
    nodeId: text(source.nodeId, 160),
  };
}

function normalizeViewer(value = {}) {
  const source = objectValue(value);
  return {
    userId: text(source.userId, 160),
    taskId: text(source.taskId, 160),
    grant: source.grant && typeof source.grant === 'object' ? source.grant : null,
  };
}

function isParticipant(memory, viewer) {
  return Boolean(viewer.userId) && (
    viewer.userId === memory.ownerUserId
    || memory.participantUserIds.includes(viewer.userId)
  ) && (!viewer.taskId || viewer.taskId === memory.taskId);
}

function validGrant(grant, memory, viewer) {
  if (!grant || typeof grant !== 'object') return null;
  if (grant.targetTaskId && grant.targetTaskId !== memory.taskId) return null;
  if (grant.granteeUserId && grant.granteeUserId !== viewer.userId) return null;
  if (grant.expiresAt && Date.parse(grant.expiresAt) < Date.now()) return null;
  if (grant.revoked) return null;
  return grant;
}

function sliceRaw(rawItems, grant) {
  const allowed = new Set(array(grant.nodeIds).map((id) => String(id)));
  return rawItems.filter((item) => !allowed.size || allowed.has(item.id) || allowed.has(item.nodeId))
    .map((item) => (grant.excerptOnly ? { ...item, content: String(item.content || '').slice(0, 280) } : item));
}

function purposeGrounded(purpose, haystack) {
  const p = String(purpose || '').toLowerCase();
  const h = String(haystack || '').toLowerCase();
  if (!p || !h) return true;
  const tokens = p.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
  if (tokens.some((token) => h.includes(token))) return true;
  for (let index = 0; index < p.length - 1; index += 1) {
    const gram = p.slice(index, index + 2);
    if (/[\u4e00-\u9fff]/.test(gram) && h.includes(gram)) return true;
  }
  return false;
}

function viewerFromRequest(request, grant = null) {
  const req = createRawAccessRequest(request);
  return { userId: req.requesterUserId, taskId: req.sourceTaskId, grant };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(value) {
  return [...new Set(array(value).map((item) => text(item)).filter(Boolean))];
}

function text(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function iso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
