import crypto from 'node:crypto';

export const UBUDDY_FORMAL_CHAIN_SCHEMA = 'ubuddy_formal_chain_v1';
export const UBUDDY_FORMAL_ENTITIES = Object.freeze([
  'requirement', 'plan', 'epoch', 'replan', 'dependency_bundle', 'lineage',
  'consumption', 'diagnostic', 'certificate', 'evolution_proposal', 'hdbp_prior',
]);
export const UBUDDY_CAPABILITIES = Object.freeze([
  'read', 'read:L2', 'read:L3', 'publish:evidence', 'accept:replan',
  'trigger:evolution', 'write:hdbp',
]);

const PRIVATE_KEY = /(?:prompt|private.?memory|credential|secret|token|password|api.?key|workspace.?root|file.?path|local.?path|source.?path|cwd|cookie|raw.?evidence)/i;
const CAPABILITY_LEVEL = { 'read:L3': 3, 'read:L2': 2, read: 1 };

export function stableFormalHash(value = {}) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

export function stableFormalId(kind, key = '') {
  return `ubuddy_${String(kind).replace(/[^a-z0-9_]/gi, '_')}_${stableFormalHash({ kind, key }).slice(0, 32)}`;
}

export function normalizeFormalEnvelope(value = {}, entityType = '') {
  const source = object(value);
  const kind = String(entityType || source.entityType || '').trim();
  const payload = sanitize(source.payload ?? source, 0);
  const envelope = {
    schemaVersion: UBUDDY_FORMAL_CHAIN_SCHEMA,
    entityType: kind,
    id: text(source.id || source.entityId || stableFormalId(kind, `${source.taskRunId || ''}:${source.idempotencyKey || ''}`)),
    taskRunId: text(source.taskRunId || source.task_run_id),
    versionNo: integer(source.versionNo ?? source.version_no, 1),
    parentVersionId: text(source.parentVersionId || source.parent_version_id),
    contentHash: text(source.contentHash || source.content_hash),
    actorId: text(source.actorId || source.actor_id || source.actor),
    evidenceRefs: normalizeRefs(source.evidenceRefs || source.evidence_refs),
    idempotencyKey: text(source.idempotencyKey || source.idempotency_key),
    createdAt: text(source.createdAt || source.created_at),
    payload,
  };
  envelope.contentHash = stableFormalHash({ ...envelope, contentHash: '' });
  return envelope;
}

export function validateFormalEnvelope(value = {}, entityType = '') {
  const envelope = normalizeFormalEnvelope(value, entityType);
  const errors = [];
  if (!UBUDDY_FORMAL_ENTITIES.includes(envelope.entityType)) errors.push('entity_type_invalid');
  if (!envelope.taskRunId) errors.push('task_run_id_required');
  if (!envelope.idempotencyKey) errors.push('idempotency_key_required');
  if (!Number.isInteger(envelope.versionNo) || envelope.versionNo < 1) errors.push('version_no_invalid');
  if (envelope.entityType === 'certificate') errors.push(...validateCertificate(envelope.payload).errors);
  if (envelope.entityType === 'evolution_proposal') errors.push(...validateEvolutionProposal(envelope.payload).errors);
  return { valid: errors.length === 0, errors, value: envelope };
}

export function authorizeUBuddy({ subject = {}, capability = 'read', scope = {}, resource = {}, resourceVersion = '', policyVersion = 'ubuddy_policy_v1', disclosurePolicy = {}, risk = 0, uncertainty = 0 } = {}) {
  const capabilities = new Set([...(subject.capabilities || []), ...(subject.scopes || [])].map(String));
  const requested = String(capability || 'read');
  const granted = capabilities.has(requested) || capabilities.has('*') || (requested.startsWith('read:') && capabilities.has('read') && Number(CAPABILITY_LEVEL[requested] || 1) <= Number(disclosurePolicy.maxLevel || 1));
  const sameScope = !scope.id || !resource.scopeId || String(scope.id) === String(resource.scopeId);
  const owner = !resource.ownerUserId || !subject.userId || String(resource.ownerUserId) === String(subject.userId);
  const highRiskNeedsEvidence = Number(risk) > 0.65 || Number(uncertainty) > 0.55;
  const evidenceReady = !highRiskNeedsEvidence || Boolean(resource.evidenceReady);
  const decision = granted && sameScope && (owner || Boolean(subject.roles || []).includes('participant')) && evidenceReady ? 'allowed' : 'denied';
  return { decision, allowed: decision === 'allowed', reason: decision === 'allowed' ? 'policy_satisfied' : !granted ? 'capability_denied' : !sameScope ? 'scope_mismatch' : !owner ? 'subject_not_owner_or_participant' : 'evidence_required', policyVersion, capability: requested, scope, resourceVersion: text(resourceVersion), obligations: highRiskNeedsEvidence && !resource.evidenceReady ? ['evidence'] : [], auditRef: stableFormalId('auth', `${subject.userId || ''}:${requested}:${resourceVersion}`) };
}

export function createAuditableCertificate({ taskRunId = '', scope = '', version = '', inputStateHash = '', policyVersion = 'ubuddy_policy_v1', authorizationSnapshot = {}, claims = [], evidenceRefs = [], confidence = 0, unknowns = [], nextAction = 'wait', status = 'UNKNOWN', validUntil = '', invalidatedBy = [] } = {}) {
  const certificate = { certificateId: stableFormalId('certificate', `${taskRunId}:${scope}:${version}:${inputStateHash}`), taskRunId: text(taskRunId), scope: text(scope), version: text(version || 'unknown'), inputStateHash: text(inputStateHash), policyVersion: text(policyVersion), authorizationSnapshot: sanitize(authorizationSnapshot, 0), claims: publicList(claims), evidenceRefs: normalizeRefs(evidenceRefs), confidence: clamp(confidence), unknowns: publicList(unknowns), nextAction: ['wait', 'request', 'retry', 'reassign', 'replan', 'terminate', 'probe'].includes(nextAction) ? nextAction : 'wait', status: ['CERTIFIED', 'CONFLICT', 'UNKNOWN'].includes(status) ? status : 'UNKNOWN', validUntil: text(validUntil), invalidatedBy: publicList(invalidatedBy) };
  if (certificate.status !== 'CERTIFIED') certificate.nextAction = certificate.nextAction === 'wait' ? 'request' : certificate.nextAction;
  return certificate;
}

export function validateCertificate(value = {}, { evidenceResolver = null, taskRunId = '', scope = '', resourceVersion = '' } = {}) {
  const c = object(value); const errors = [];
  for (const key of ['certificateId', 'taskRunId', 'scope', 'version', 'inputStateHash', 'policyVersion']) if (!text(c[key])) errors.push(`${key}_required`);
  if (!['CERTIFIED', 'CONFLICT', 'UNKNOWN'].includes(c.status)) errors.push('status_invalid');
  if (!Array.isArray(c.evidenceRefs)) errors.push('evidence_refs_required');
  if (c.status === 'CERTIFIED' && (!c.inputStateHash || !c.evidenceRefs.length || c.unknowns?.length)) errors.push('certified_evidence_or_unknowns_invalid');
  if (taskRunId && c.taskRunId !== taskRunId) errors.push('certificate_task_scope_mismatch');
  if (scope && c.scope !== scope) errors.push('certificate_scope_mismatch');
  if (resourceVersion && c.version !== resourceVersion) errors.push('certificate_version_mismatch');
  if (typeof evidenceResolver === 'function' && c.evidenceRefs.length) {
    for (const ref of c.evidenceRefs) {
      const evidence = evidenceResolver(ref);
      if (!evidence) errors.push(`evidence_not_found:${ref}`);
      else {
        if (evidence.taskRunId && c.taskRunId && String(evidence.taskRunId) !== String(c.taskRunId)) errors.push(`evidence_task_mismatch:${ref}`);
        if (evidence.contentHash && evidence.expectedContentHash && evidence.contentHash !== evidence.expectedContentHash) errors.push(`evidence_hash_mismatch:${ref}`);
      }
    }
  }
  return { valid: errors.length === 0, errors, value: c };
}

export function certificateValidity(value = {}, context = {}) {
  const validation = validateCertificate(value, context);
  if (!validation.valid) return { valid: false, status: 'INVALIDATED', reasons: validation.errors };
  if (context.currentInputStateHash && String(value.inputStateHash) !== String(context.currentInputStateHash)) return { valid: false, status: 'INVALIDATED', reasons: ['input_state_hash_changed'] };
  if (context.currentPolicyVersion && String(value.policyVersion) !== String(context.currentPolicyVersion)) return { valid: false, status: 'INVALIDATED', reasons: ['policy_version_changed'] };
  if (value.validUntil && Date.parse(value.validUntil) < Date.now()) return { valid: false, status: 'INVALIDATED', reasons: ['certificate_expired'] };
  return { valid: true, status: value.status || 'UNKNOWN', reasons: [] };
}

export function createEvolutionProposal({ taskRunId = '', baseStateHash = '', scope = '', interventionKind = '', targetId = '', beforeStateRefs = [], afterStateRefs = [], preservedInvariants = [], budget = 0, executor = '', status = 'proposed', resultRefs = [], rollbackPolicy = 'discard_candidate_state' } = {}) {
  return { proposalId: stableFormalId('proposal', `${taskRunId}:${baseStateHash}:${interventionKind}:${targetId}`), taskRunId: text(taskRunId), baseStateHash: text(baseStateHash), scope: text(scope), interventionKind: text(interventionKind), targetId: text(targetId), beforeStateRefs: normalizeRefs(beforeStateRefs), afterStateRefs: normalizeRefs(afterStateRefs), preservedInvariants: publicList(preservedInvariants), budget: Math.max(0, Number(budget) || 0), executor: text(executor), status: ['proposed', 'running', 'accepted', 'downweighted', 'rolled_back', 'rejected'].includes(status) ? status : 'proposed', resultRefs: normalizeRefs(resultRefs), rollbackPolicy: text(rollbackPolicy || 'discard_candidate_state') };
}

export function validateEvolutionProposal(value = {}) {
  const p = object(value); const errors = [];
  for (const key of ['proposalId', 'taskRunId', 'baseStateHash', 'scope', 'interventionKind']) if (!text(p[key])) errors.push(`${key}_required`);
  if (!Array.isArray(p.preservedInvariants) || !p.preservedInvariants.length) errors.push('preserved_invariants_required');
  return { valid: errors.length === 0, errors, value: p };
}

export function invariantDiagnostics({ certificate = null, previousTaskId = '', currentTaskId = '', tdbExec = null, tdbActive = null, evidenceRefs = [], currentEvidenceRefs = [], projectionTriggeredAction = false, dependencyScoreUsedAsExecutionGate = false } = {}) {
  const errors = [];
  if (certificate) errors.push(...validateCertificate(certificate).errors);
  if (previousTaskId && currentTaskId && previousTaskId === currentTaskId && tdbExec && tdbActive && tdbExec.bundleVersionId === tdbActive.bundleVersionId) errors.push('historical_exec_reused_as_active');
  if (projectionTriggeredAction) errors.push('projection_execution_side_effect');
  if (dependencyScoreUsedAsExecutionGate) errors.push('dependency_score_execution_gate');
  if (currentEvidenceRefs.some((ref) => !evidenceRefs.includes(ref))) errors.push('evidence_scope_mismatch');
  return { valid: errors.length === 0, errors };
}

function normalizeRefs(value) { return [...new Set((Array.isArray(value) ? value : value ? [value] : []).map((item) => text(item?.id || item?.evidenceId || item?.versionId || item)).filter(Boolean))].slice(0, 100); }
function publicList(value) { return (Array.isArray(value) ? value : value ? [value] : []).map((item) => sanitize(item, 0)).filter(Boolean).slice(0, 100); }
function sanitize(value, depth) { if (depth > 6 || value == null || typeof value !== 'object') return typeof value === 'string' && PRIVATE_KEY.test(value) ? '[redacted]' : value; if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1)); return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key)).map(([key, item]) => [key, sanitize(item, depth + 1)])); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function text(value, limit = 500) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function integer(value, fallback = 1) { const n = Math.floor(Number(value)); return Number.isFinite(n) ? n : fallback; }
function clamp(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function stableStringify(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'; return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'; }
