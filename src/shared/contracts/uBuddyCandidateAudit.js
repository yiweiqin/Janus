import crypto from 'node:crypto';

/**
 * Shared, versioned summary of the immutable context used to route an
 * attribution candidate.  This contract intentionally contains references
 * and hashes only; it must never carry private graph payloads.
 */
export const UBUDDY_CANDIDATE_AUDIT_VERSION = 'ubuddy_candidate_audit_v1';
export const UBUDDY_EVIDENCE_AUDIT_VERSION = 'ubuddy_evidence_audit_v1';

const text = (value) => String(value ?? '').trim();
const isoOrEmpty = (value) => { const raw = text(value); if (!raw) return ''; const ms = Date.parse(raw); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; };
const correlationOrEmpty = (value) => { const raw = text(value); return raw && raw.length <= 256 ? raw : ''; };
const objectOrNull = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

function normalizeReplay(value) {
  const input = objectOrNull(value);
  if (!input) return null;
  return {
    version: text(input.version),
    replayToken: text(input.replayToken),
    traceHash: text(input.traceHash),
    finalHash: text(input.finalHash),
    initialHash: text(input.initialHash),
  };
}

function normalizeTargetBinding(value) {
  const input = objectOrNull(value);
  if (!input) return null;
  return {
    version: text(input.version),
    status: text(input.status) || 'UNKNOWN',
    targetTaskId: input.targetTaskId == null ? null : text(input.targetTaskId),
    receiverUserId: input.receiverUserId == null ? null : text(input.receiverUserId),
    query: text(input.query),
    tdbHash: text(input.tdbHash),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function normalizeEvidenceAudit(value) {
  const input = objectOrNull(value);
  if (!input) return null;
  const refs = Array.isArray(input.evidenceRefs || input.refs)
    ? (input.evidenceRefs || input.refs).map((ref) => ({
      evidenceId: text(ref?.evidenceId || ref?.evidence_id),
      sourceVersionId: text(ref?.sourceVersionId || ref?.source_version_id),
      validationStatus: text(ref?.validationStatus || ref?.validation_status).toLowerCase(),
    })).filter((ref) => ref.evidenceId)
    : [];
  const summary = {
    version: text(input.version) || UBUDDY_EVIDENCE_AUDIT_VERSION,
    status: text(input.status).toUpperCase() || 'UNKNOWN',
    refs,
    validatedCount: Number.isFinite(Number(input.validatedCount)) ? Number(input.validatedCount) : refs.filter((ref) => ref.validationStatus === 'validated').length,
    totalCount: Number.isFinite(Number(input.totalCount)) ? Number(input.totalCount) : refs.length,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonical(summary))).digest('hex');
  return { ...summary, hash };
}

function normalizeCrossTask(value) {
  const input = objectOrNull(value);
  return {
    status: text(input?.status) || 'UNKNOWN',
    applicability: text(input?.applicability) || 'BLOCKED',
    reason: text(input?.reason) || 'cross_task_binding_missing',
    sourceResolution: text(input?.sourceResolution),
    sourceTaskId: input?.sourceTaskId == null ? null : text(input.sourceTaskId),
    targetTaskId: input?.targetTaskId == null ? null : text(input.targetTaskId),
    sourceHash: input?.sourceHash == null ? null : text(input.sourceHash),
  };
}

/** Return the canonical, privacy-safe candidate audit summary. */
export function normalizeUBuddyCandidateAudit(value = {}, context = {}) {
  const input = objectOrNull(value) || {};
  const replay = normalizeReplay(input.replay ?? context.replay);
  const evidenceAudit = normalizeEvidenceAudit(input.evidenceAudit ?? input.metadata?.evidenceAudit ?? context.evidenceAudit);
  const targetBinding = normalizeTargetBinding(input.targetBinding ?? context.targetBinding);
  const crossTaskApplicability = normalizeCrossTask(
    input.crossTaskApplicability ?? context.crossTaskApplicability,
  );
  const suppliedVersion = text(input.auditVersion);
  const versionIssue = suppliedVersion && suppliedVersion !== UBUDDY_CANDIDATE_AUDIT_VERSION
    ? 'candidate_audit_version_mismatch' : (!suppliedVersion && Object.keys(input).length
      ? 'candidate_audit_version_missing' : null);
  return {
    auditVersion: UBUDDY_CANDIDATE_AUDIT_VERSION,
    validation: {
      status: versionIssue ? 'UNKNOWN' : 'VALIDATED',
      reason: versionIssue || 'candidate_audit_schema_validated',
    },
    correlationId: correlationOrEmpty(input.correlationId ?? context.correlationId),
    issuedAt: isoOrEmpty(input.issuedAt ?? context.issuedAt),
    expiresAt: isoOrEmpty(input.expiresAt ?? context.expiresAt),
    replay,
    evidenceAudit,
    targetBinding,
    crossTaskApplicability: {
      ...crossTaskApplicability,
      targetTaskId: crossTaskApplicability.targetTaskId || targetBinding?.targetTaskId || null,
    },
  };
}

/** Validate a supplied audit before it is accepted as a binding-bearing one. */
export function validateUBuddyCandidateAudit(value, {
  requireVersion = true,
  requireTemporalBinding = false,
  now = new Date(),
  // A bounded grace period for distributed clock drift.  The default is
  // deliberately zero to preserve the original half-open validity window.
  clockSkewMs = 0,
} = {}) {
  const input = objectOrNull(value);
  if (!input) return { valid: !requireVersion, reason: requireVersion ? 'candidate_audit_missing' : null };
  const version = text(input.auditVersion);
  if (requireVersion && !version) return { valid: false, reason: 'candidate_audit_version_missing' };
  if (version && version !== UBUDDY_CANDIDATE_AUDIT_VERSION) {
    return { valid: false, reason: 'candidate_audit_version_mismatch' };
  }
  if (requireTemporalBinding) {
    if (!correlationOrEmpty(input.correlationId)) return { valid: false, reason: 'candidate_audit_correlation_id_missing' };
    const issuedMs = Date.parse(text(input.issuedAt)); const expiresMs = Date.parse(text(input.expiresAt));
    if (!Number.isFinite(issuedMs)) return { valid: false, reason: 'candidate_audit_issued_at_missing_or_invalid' };
    if (!Number.isFinite(expiresMs)) return { valid: false, reason: 'candidate_audit_expires_at_missing_or_invalid' };
    if (expiresMs <= issuedMs) return { valid: false, reason: 'candidate_audit_time_window_invalid' };
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const skew = Number(clockSkewMs);
    if (!Number.isFinite(skew) || skew < 0) return { valid: false, reason: 'candidate_audit_clock_skew_invalid' };
    if (Number.isFinite(nowMs)) {
      // Keep the strict legacy reason when no tolerance was requested.
      if (skew === 0 && (nowMs < issuedMs || nowMs >= expiresMs)) {
        return { valid: false, reason: 'candidate_audit_time_window_expired' };
      }
      // The grace period applies symmetrically at both boundaries.  A
      // timestamp outside it is indeterminate rather than silently expired,
      // because the issuer and verifier clocks cannot be reconciled.
      if (skew > 0 && (nowMs < issuedMs - skew || nowMs >= expiresMs + skew)) {
        return { valid: false, reason: 'candidate_audit_clock_skew_exceeded' };
      }
    }
  }
  return { valid: true, reason: null };
}
