/** Conservative cross-task applicability contract.
 * A source TDB can be reused only when its identity, relation, scope and freshness
 * are explicitly bound to the target query. Missing or stale bindings remain UNKNOWN
 * (blocked for downstream evolution); this helper never infers transferability.
 */
import { taskDependencyBundleHash, normalizeTaskDependencyBundle } from './uBuddyTaskDependencyBundle.js';

export const UBUDDY_CROSS_TASK_APPLICABILITY_VERSION = 'cross-task-applicability-v1';

export function assessCrossTaskApplicability({
  sourceBundle,
  targetTaskId = '',
  targetScope = '',
  requiredDimensions = [],
  now,
  maxAgeMs,
  expectedSourceHash = '',
  expectedSourceTaskId = '',
  relationType = '',
} = {}) {
  const base = { contractVersion: UBUDDY_CROSS_TASK_APPLICABILITY_VERSION, sourceHash: null, targetTaskId: String(targetTaskId || ''), targetScope: String(targetScope || '') };
  const unknown = (reason, extra = {}) => ({ status: 'UNKNOWN', applicability: 'BLOCKED', reason, ...base, ...extra });
  if (!sourceBundle || typeof sourceBundle !== 'object') return unknown('source_bundle_missing');
  const normalized = normalizeTaskDependencyBundle(sourceBundle);
  const sourceHash = taskDependencyBundleHash(normalized);
  base.sourceHash = sourceHash;
  if (!normalized.taskId) return unknown('source_task_missing');
  if (expectedSourceTaskId && normalized.taskId !== expectedSourceTaskId) return unknown('source_task_mismatch');
  if (!targetTaskId || !targetScope) return unknown('target_binding_missing');
  if (expectedSourceHash && sourceHash !== expectedSourceHash) return unknown('source_hash_mismatch');
  if (relationType && normalized.relationType && normalized.relationType !== relationType) return unknown('relation_type_mismatch');
  if (normalized.state === 'conflict' || normalized.state === 'CONFLICT' || normalized.obligationStatus === 'conflict') return { status: 'CONFLICT', applicability: 'BLOCKED', reason: 'source_bundle_conflict', ...base };
  const observed = new Date(normalized.observedAt || '').getTime();
  const nowMs = new Date(now || '').getTime();
  if (!Number.isFinite(observed) || !Number.isFinite(nowMs) || !Number.isFinite(Number(maxAgeMs)) || Number(maxAgeMs) < 0) return unknown('freshness_binding_invalid');
  if (nowMs - observed > Number(maxAgeMs)) return unknown('source_bundle_expired', { expiredAt: new Date(observed + Number(maxAgeMs)).toISOString() });
  const dims = Array.isArray(requiredDimensions) ? requiredDimensions.filter(Boolean).map(String) : [];
  for (const dimension of dims) {
    const value = normalized.dimensions?.[dimension];
    if (!value || typeof value !== 'object' || typeof value.version !== 'string' || !value.version || !Array.isArray(normalized.evidenceRefs) || !normalized.evidenceRefs.length) return unknown('dimension_evidence_incomplete', { dimension });
  }
  return { status: 'CERTIFIED', applicability: 'APPLICABLE', reason: 'explicit_binding_and_freshness_verified', ...base, requiredDimensions: dims, observedAt: normalized.observedAt, maxAgeMs: Number(maxAgeMs) };
}

