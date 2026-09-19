/** Conservative Probe effect contract.
 * Observation signals describe correlation only. A causal effect is certified only
 * when an explicit intervention/control comparison is bound to validated evidence,
 * scope, source version and TDB hash. Missing bindings remain UNKNOWN/BLOCKED.
 */
import crypto from 'node:crypto';
import { validateProbeTdbReplayBinding } from './uBuddyProbeTdbBinding.js';
export const UBUDDY_PROBE_EFFECT_VERSION = 'probe-effect-v2';
export const UBUDDY_POWER_ESTIMATOR_VERSION = 'normal-approx-power-v1';

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalValue(value[k])]));
  return value;
};
const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalizeSourceRefs = (value) => Array.from(new Set((Array.isArray(value) ? value : (value == null ? [] : [value]))
  .map((entry) => asText(entry && typeof entry === 'object' ? (entry.eventRef ?? entry.sourceId ?? entry.id ?? entry.ref) : entry))
  .filter(Boolean))).sort();
// Preserve the concrete event identity/version binding separately from the
// legacy string-only refs. A replacement with the same eventRef but a new
// version/content hash therefore changes the immutable digest.
const normalizeSourceRefRecords = (value) => {
  const entries = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return entries.map((entry) => {
    if (entry && typeof entry === 'object') {
      const eventRef = asText(entry.eventRef ?? entry.sourceId ?? entry.id ?? entry.ref);
      const version = asText(entry.eventVersion ?? entry.version ?? entry.sourceVersion);
      const contentHash = asText(entry.contentHash ?? entry.eventHash ?? entry.hash ?? entry.snapshotHash);
      const observedAt = asText(entry.observedAt ?? entry.timestamp ?? entry.createdAt);
      return { eventRef, version, contentHash, observedAt };
    }
    return { eventRef: asText(entry), version: '', contentHash: '', observedAt: '' };
  }).filter((entry) => entry.eventRef).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
};
const sourceRefBindingHash = (value) => sha256(canonicalJson(normalizeSourceRefRecords(value)));
const powerInputSummary = ({ treatmentMean, controlMean, treatmentVariance, controlVariance, treatmentSampleCount, controlSampleCount, alpha = 0.05, alternative = 'two-sided', sourceEventRefs = [], sourceIds = [], sourceEventRefRecords = null } = {}) => ({
  treatmentMean: Number(treatmentMean), controlMean: Number(controlMean), treatmentVariance: Number(treatmentVariance), controlVariance: Number(controlVariance),
  treatmentSampleCount: Number(treatmentSampleCount), controlSampleCount: Number(controlSampleCount), alpha: Number(alpha), alternative: asText(alternative) || 'two-sided',
  sourceEventRefs: normalizeSourceRefs(sourceEventRefs), sourceIds: normalizeSourceRefs(sourceIds),
  sourceEventRefRecords: normalizeSourceRefRecords(sourceEventRefRecords ?? sourceEventRefs),
  sourceEventRefBindingHash: sourceRefBindingHash(sourceEventRefRecords ?? sourceEventRefs),
});
const powerInputHash = (summary) => sha256(canonicalJson(summary));

const asText = (v) => String(v ?? '').trim();
const validEvidence = (e) => e && typeof e === 'object' && e.validated === true && e.quarantined !== true && e.invalidated !== true && asText(e.evidenceRef || e.id);

// Deterministic, dependency-free planning power estimate for a two-arm mean
// comparison. This is deliberately an estimate (not evidence): callers must
// bind its returned source/version to the intervention before a power gate can
// certify an effect. Welch-style variance is used so unequal arm variances are
// handled without silently pooling them.
const normalCdf = (x) => {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * ax);
  const p = 0.3989422804014327 * Math.exp(-ax * ax / 2)
    * (((((1.330274429 * t - 1.821255978) * t) + 1.781477937) * t - 0.356563782) * t + 0.319381530) * t;
  return sign === 1 ? 1 - p : p;
};

export function estimateProbePower({
  treatmentMean,
  controlMean,
  treatmentVariance,
  controlVariance,
  treatmentSampleCount,
  controlSampleCount,
  alpha = 0.05,
  alternative = 'two-sided',
  sourceEventRefs = [],
  sourceIds = [],
  sourceEventRefRecords = null,
  source = 'ubuddy-normal-approx',
  version = UBUDDY_POWER_ESTIMATOR_VERSION,
} = {}) {
  const n1 = Number(treatmentSampleCount); const n0 = Number(controlSampleCount);
  const v1 = Number(treatmentVariance); const v0 = Number(controlVariance);
  const m1 = Number(treatmentMean); const m0 = Number(controlMean);
  const a = Number(alpha);
  const alt = asText(alternative) || 'two-sided';
  const inputSummary = powerInputSummary({ treatmentMean: m1, controlMean: m0, treatmentVariance: v1, controlVariance: v0, treatmentSampleCount: n1, controlSampleCount: n0, alpha: a, alternative: alt, sourceEventRefs, sourceIds, sourceEventRefRecords });
  const inputHash = powerInputHash(inputSummary);
  if (![n1, n0].every((n) => Number.isInteger(n) && n >= 2)
    || ![v1, v0, m1, m0].every(Number.isFinite)
    || v1 < 0 || v0 < 0 || !Number.isFinite(a) || a <= 0 || a >= 1
    || !['two-sided', 'greater', 'less'].includes(alt)) {
    return { status: 'UNKNOWN', reason: 'power_input_invalid', estimate: null, source: asText(source), version: asText(version), inputSummary, inputHash };
  }
  const delta = m1 - m0;
  const se = Math.sqrt(v1 / n1 + v0 / n0);
  if (!(se > 0)) return { status: 'UNKNOWN', reason: 'power_variance_zero', estimate: null, source: asText(source), version: asText(version), inputSummary, inputHash };
  const z = (p) => { // inverse normal CDF (Acklam), deterministic
    const A=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924];
    const B=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857];
    const C=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878];
    const D=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];
    if (p <= 0 || p >= 1) return p === 0 ? -Infinity : Infinity;
    if (p < 0.02425) { const q=Math.sqrt(-2*Math.log(p)); return (((((C[0]*q+C[1])*q+C[2])*q+C[3])*q+C[4])*q+C[5])/((((D[0]*q+D[1])*q+D[2])*q+D[3])*q+1); }
    if (p > 0.97575) return -z(1-p);
    const q=p-.5, r=q*q;
    const num = (((((A[0]*r+A[1])*r+A[2])*r+A[3])*r+A[4])*r+A[5]) * q;
    const den = ((((B[0]*r+B[1])*r+B[2])*r+B[3])*r+B[4])*r+1;
    return num / den;
  };
  const critical = alt === 'two-sided' ? z(1 - a / 2) : z(1 - a);
  const mu = Math.abs(delta) / se;
  let power;
  if (alt === 'two-sided') power = normalCdf(-critical - mu) + (1 - normalCdf(critical - mu));
  else { const signed = alt === 'greater' ? delta / se : -delta / se; power = 1 - normalCdf(critical - signed); }
  const estimate = Math.max(0, Math.min(1, power));
  return { status: 'ESTIMATED', estimate, powerEstimate: estimate, source: asText(source), version: asText(version), method: 'two-arm-normal-approx', alpha: a, alternative: alt, treatmentSampleCount: n1, controlSampleCount: n0, inputSummary, inputHash };
}

export function assessProbeEffect({
  observation,
  intervention,
  expectedScope = '',
  expectedSourceVersion = '',
  expectedTdbHash = '',
  minEffect = 0,
  minSampleCount = 10,
  minConfidence = 0.95,
  // Power/precision gates are opt-in so existing callers remain compatible.
  // When configured, an effect without an explicit power estimate is UNKNOWN.
  minPower = null,
  minSampleCountByPower = null,
  maxConfidenceIntervalWidth = null,
  // Optional strict replay context. When supplied, Probe source events are
  // checked bidirectionally against the deterministic TDB snapshot.
  tdbReplaySnapshot = null,
  tdbReplayEvents = null,
  tdbSeed = null,
  expectedTdbReplayToken = '',
  expectedTdbTraceHash = '',
  expectedTdbInitialHash = '',
  expectedTdbFinalHash = '',
  requireExactTdbEventSet = true,
  now = new Date().toISOString(),
} = {}) {
  const base = { contractVersion: UBUDDY_PROBE_EFFECT_VERSION, scope: asText(expectedScope), sourceVersion: asText(expectedSourceVersion), tdbHash: asText(expectedTdbHash) || null };
  const unknown = (reason, extra = {}) => ({ status: 'UNKNOWN', attribution: 'BLOCKED', reason, ...base, ...extra });
  if (!observation || typeof observation !== 'object') return unknown('observation_missing');
  const obsEvidence = Array.isArray(observation.evidenceRefs) ? observation.evidenceRefs : [];
  if (!obsEvidence.length || obsEvidence.some((e) => !validEvidence(e))) return unknown('observation_evidence_unvalidated');
  if (observation.scope && expectedScope && asText(observation.scope) !== asText(expectedScope)) return unknown('observation_scope_mismatch');
  if (expectedSourceVersion && asText(observation.sourceVersion) !== asText(expectedSourceVersion)) return unknown('observation_version_mismatch');
  if (expectedTdbHash && asText(observation.tdbHash) !== asText(expectedTdbHash)) return unknown('observation_tdb_mismatch');
  // An observation can never establish a causal effect.
  if (!intervention || typeof intervention !== 'object') return unknown('intervention_missing', { observationalSignal: true });
  const required = ['scope', 'sourceVersion', 'tdbHash', 'treatment', 'control'];
  if (required.some((k) => !asText(intervention[k]) && !['treatment', 'control'].includes(k))) return unknown('intervention_binding_incomplete');
  if (expectedScope && asText(intervention.scope) !== asText(expectedScope)) return unknown('intervention_scope_mismatch');
  if (expectedSourceVersion && asText(intervention.sourceVersion) !== asText(expectedSourceVersion)) return unknown('intervention_version_mismatch');
  if (expectedTdbHash && asText(intervention.tdbHash) !== asText(expectedTdbHash)) return unknown('intervention_tdb_mismatch');
  const intEvidence = Array.isArray(intervention.evidenceRefs) ? intervention.evidenceRefs : [];
  if (!intEvidence.length || intEvidence.some((e) => !validEvidence(e))) return unknown('intervention_evidence_unvalidated');
  const t = Number(intervention.treatment); const c = Number(intervention.control);
  if (!Number.isFinite(t) || !Number.isFinite(c)) return unknown('comparison_outcomes_missing');
  const treatmentSampleCount = Number(intervention.treatmentSampleCount ?? intervention.treatmentSamples);
  const controlSampleCount = Number(intervention.controlSampleCount ?? intervention.controlSamples);
  if (!Number.isInteger(treatmentSampleCount) || !Number.isInteger(controlSampleCount)) return unknown('sample_counts_missing');
  if (treatmentSampleCount < Number(minSampleCount) || controlSampleCount < Number(minSampleCount)) return unknown('sample_count_below_minimum', { treatmentSampleCount, controlSampleCount, minSampleCount: Number(minSampleCount) });
  const powerGateConfigured = (minPower != null && Number.isFinite(Number(minPower))) || minSampleCountByPower != null;
  const powerRecord = intervention.powerEstimateResult && typeof intervention.powerEstimateResult === 'object'
    ? intervention.powerEstimateResult : null;
  let tdbBinding = null;
  if (tdbReplaySnapshot || Array.isArray(tdbReplayEvents)) {
    const summary = intervention.powerInputSummary ?? intervention.powerProvenance?.inputSummary ?? powerRecord?.inputSummary ?? {};
    const binding = validateProbeTdbReplayBinding({
      sourceEventRefs: summary.sourceEventRefs ?? intervention.sourceEventRefs ?? intervention.powerSourceEventRefs ?? powerRecord?.sourceEventRefs,
      sourceIds: summary.sourceIds ?? intervention.sourceIds ?? intervention.powerSourceIds ?? powerRecord?.sourceIds,
      sourceEventRefBindingHash: summary.sourceEventRefBindingHash ?? intervention.sourceEventRefBindingHash ?? powerRecord?.inputSummary?.sourceEventRefBindingHash,
      replaySnapshot: tdbReplaySnapshot, replayEvents: tdbReplayEvents, tdbSeed,
      expectedReplayToken: expectedTdbReplayToken, expectedTraceHash: expectedTdbTraceHash,
      expectedInitialHash: expectedTdbInitialHash, expectedFinalHash: expectedTdbFinalHash,
      requireExactEventSet: requireExactTdbEventSet,
    });
    if (!binding.ok) return unknown(binding.reason, { tdbBinding: binding });
    tdbBinding = binding;
  }
  const powerEstimate = Number(intervention.powerEstimate ?? intervention.estimatedPower ?? intervention.power ?? powerRecord?.estimate ?? powerRecord?.powerEstimate);
  let sourceEventRefs = [];
  let sourceIds = [];
  let sourceEventRefRecords = [];
  let sourceEventRefBindingHash = null;
  if (powerGateConfigured) {
    if (!Number.isFinite(powerEstimate) || powerEstimate < 0 || powerEstimate > 1) return unknown('power_estimate_missing', { powerEstimate: null, minPower: Number.isFinite(Number(minPower)) ? Number(minPower) : null });
    // A configured power gate must be backed by a reproducible estimator.  A
    // bare numeric value is not auditable (and can be hand-entered), so bind it
    // to an explicit provider/source and version.  Keep this requirement
    // opt-in with the gate to preserve compatibility for legacy callers.
    const powerSource = asText(intervention.powerSource ?? intervention.powerEstimator ?? intervention.powerProvenance?.source ?? powerRecord?.source);
    const powerVersion = asText(intervention.powerVersion ?? intervention.powerEstimatorVersion ?? intervention.powerProvenance?.version ?? powerRecord?.version);
    if (!powerSource) return unknown('power_source_missing', { powerEstimate, minPower: Number.isFinite(Number(minPower)) ? Number(minPower) : null });
    if (!powerVersion) return unknown('power_version_missing', { powerEstimate, powerSource, minPower: Number.isFinite(Number(minPower)) ? Number(minPower) : null });
    const boundHash = asText(intervention.powerInputHash ?? intervention.powerProvenance?.inputHash ?? powerRecord?.inputHash);
    const suppliedSummary = intervention.powerInputSummary ?? intervention.powerProvenance?.inputSummary;
    const hasStats = suppliedSummary && typeof suppliedSummary === 'object';
    // A reproducible estimate must identify the concrete observations used to
    // derive it. Event references or stable source ids are required whenever a
    // structured input summary is supplied under the opt-in gate.
    sourceEventRefs = normalizeSourceRefs(suppliedSummary?.sourceEventRefs ?? intervention.powerSourceEventRefs ?? intervention.powerProvenance?.sourceEventRefs ?? powerRecord?.sourceEventRefs);
    sourceIds = normalizeSourceRefs(suppliedSummary?.sourceIds ?? intervention.powerSourceIds ?? intervention.powerProvenance?.sourceIds ?? powerRecord?.sourceIds);
    sourceEventRefRecords = normalizeSourceRefRecords(suppliedSummary?.sourceEventRefRecords ?? intervention.powerSourceEventRefs ?? intervention.powerProvenance?.sourceEventRefs ?? powerRecord?.inputSummary?.sourceEventRefRecords ?? powerRecord?.sourceEventRefs);
    const declaredSourceEventRefBindingHash = asText(suppliedSummary?.sourceEventRefBindingHash ?? intervention.powerSourceEventRefBindingHash ?? intervention.powerProvenance?.sourceEventRefBindingHash ?? powerRecord?.inputSummary?.sourceEventRefBindingHash);
    const calculatedSourceEventRefBindingHash = sourceRefBindingHash(sourceEventRefRecords);
    if (declaredSourceEventRefBindingHash && declaredSourceEventRefBindingHash !== calculatedSourceEventRefBindingHash) return unknown('power_input_source_changed', { powerEstimate, powerInputHash: boundHash || null, powerSourceEventRefBindingHash: calculatedSourceEventRefBindingHash });
    sourceEventRefBindingHash = declaredSourceEventRefBindingHash || calculatedSourceEventRefBindingHash;
    if (hasStats && powerRecord?.inputSummary && (sourceEventRefs.join('|') !== normalizeSourceRefs(powerRecord.inputSummary.sourceEventRefs).join('|') || sourceIds.join('|') !== normalizeSourceRefs(powerRecord.inputSummary.sourceIds).join('|'))) return unknown('power_input_source_changed', { powerEstimate, powerInputHash: boundHash || null });
    if (hasStats && powerRecord?.inputSummary && sourceEventRefBindingHash !== (asText(powerRecord.inputSummary.sourceEventRefBindingHash) || sourceRefBindingHash(powerRecord.inputSummary.sourceEventRefRecords ?? powerRecord.inputSummary.sourceEventRefs))) return unknown('power_input_source_changed', { powerEstimate, powerInputHash: boundHash || null, powerSourceEventRefBindingHash: sourceEventRefBindingHash || null });
    if (hasStats && powerRecord?.inputSummary && powerInputHash(powerInputSummary(suppliedSummary)) !== powerInputHash(powerInputSummary(powerRecord.inputSummary))) return unknown('power_input_changed', { powerEstimate, powerInputHash: boundHash || null });
    if (boundHash && hasStats && powerInputHash(powerInputSummary(suppliedSummary)) !== boundHash) return unknown('power_input_hash_mismatch', { powerEstimate, powerInputHash: boundHash });
    if (boundHash && powerRecord?.inputSummary && powerInputHash(powerInputSummary(powerRecord.inputSummary)) !== boundHash) return unknown('power_input_hash_mismatch', { powerEstimate, powerInputHash: boundHash });
    if (hasStats && !sourceEventRefs.length && !sourceIds.length) return unknown('power_input_source_missing', { powerEstimate, powerInputHash: boundHash || null });
    if (Number.isFinite(Number(minPower)) && powerEstimate < Number(minPower)) return unknown('power_below_minimum', { powerEstimate, minPower: Number(minPower) });
    const byPower = minSampleCountByPower && typeof minSampleCountByPower === 'object'
      ? minSampleCountByPower : { treatment: minSampleCountByPower, control: minSampleCountByPower };
    const minTreatmentByPower = Number(byPower.treatment ?? byPower.treatmentSampleCount ?? byPower.min ?? 0);
    const minControlByPower = Number(byPower.control ?? byPower.controlSampleCount ?? byPower.min ?? 0);
    if ((Number.isFinite(minTreatmentByPower) && treatmentSampleCount < minTreatmentByPower)
      || (Number.isFinite(minControlByPower) && controlSampleCount < minControlByPower)) {
      return unknown('sample_count_below_power_minimum', { treatmentSampleCount, controlSampleCount, minSampleCountByPower: { treatment: minTreatmentByPower, control: minControlByPower }, powerEstimate });
    }
  }
  const effectConfidence = Number(intervention.effectConfidence ?? intervention.confidence);
  const ci = intervention.confidenceInterval || intervention.effectConfidenceInterval;
  const lower = Number(ci?.lower); const upper = Number(ci?.upper);
  if (!Number.isFinite(effectConfidence) || effectConfidence < 0 || effectConfidence > 1) return unknown('effect_confidence_missing');
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return unknown('confidence_interval_missing');
  if (maxConfidenceIntervalWidth != null) {
    const maxWidth = Number(maxConfidenceIntervalWidth);
    if (!Number.isFinite(maxWidth) || maxWidth < 0) return unknown('precision_constraint_invalid');
    const width = upper - lower;
    if (width > maxWidth) return unknown('confidence_interval_too_wide', { confidenceInterval: { lower, upper }, intervalWidth: width, maxConfidenceIntervalWidth: maxWidth });
  }
  const expiresAt = asText(intervention.expiresAt || intervention.expiry);
  if (!expiresAt) return unknown('expiry_missing');
  const expiryMs = Date.parse(expiresAt); const nowMs = Date.parse(now);
  if (!Number.isFinite(expiryMs) || !Number.isFinite(nowMs)) return unknown('expiry_invalid');
  if (expiryMs <= nowMs) return unknown('probe_effect_expired', { expiresAt });
  const effect = t - c;
  if (intervention.conflict === true || observation.conflict === true) return { status: 'CONFLICT', attribution: 'BLOCKED', reason: 'evidence_conflict', ...base };
  if (Math.abs(effect) < Number(minEffect || 0)) return unknown('effect_below_threshold', { effect, treatment: t, control: c });
  if (effectConfidence < Number(minConfidence)) return unknown('effect_confidence_below_minimum', { effectConfidence, minConfidence: Number(minConfidence) });
  if (lower <= 0 && upper >= 0) return unknown('confidence_interval_crosses_zero', { effect, confidenceInterval: { lower, upper } });
  const powerProvenance = powerGateConfigured
    ? { powerEstimate, powerSource: asText(intervention.powerSource ?? intervention.powerEstimator ?? intervention.powerProvenance?.source ?? powerRecord?.source), powerVersion: asText(intervention.powerVersion ?? intervention.powerEstimatorVersion ?? intervention.powerProvenance?.version ?? powerRecord?.version), powerInputHash: asText(intervention.powerInputHash ?? intervention.powerProvenance?.inputHash ?? powerRecord?.inputHash) || null, powerInputSummary: intervention.powerInputSummary ?? intervention.powerProvenance?.inputSummary ?? powerRecord?.inputSummary ?? null, powerSourceEventRefs: sourceEventRefs, powerSourceIds: sourceIds, powerSourceEventRefRecords: sourceEventRefRecords, powerSourceEventRefBindingHash: sourceEventRefBindingHash }
    : {};
  return { status: 'CERTIFIED', attribution: 'PROBE_SUPPORTED', reason: 'validated_intervention_control_comparison', effect, treatment: t, control: c, treatmentSampleCount, controlSampleCount, ...powerProvenance, ...(tdbBinding ? { tdbBinding } : {}), effectConfidence, confidenceInterval: { lower, upper }, expiresAt, evidenceRefs: intEvidence.map((e) => asText(e.evidenceRef || e.id)), ...base };
}

