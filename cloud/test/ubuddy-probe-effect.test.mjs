import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessProbeEffect, estimateProbePower, UBUDDY_POWER_ESTIMATOR_VERSION } from '../../src/shared/contracts/uBuddyProbeEffect.js';
import { validateProbeTdbReplayBinding } from '../../src/shared/contracts/uBuddyProbeTdbBinding.js';
import { taskDependencyBundleReplaySnapshot } from '../../src/shared/contracts/uBuddyTaskDependencyBundle.js';
const ev = (id) => ({ evidenceRef: id, validated: true });
const observation = { scope: 'cluster', sourceVersion: 'v1', tdbHash: 'tdb-1', evidenceRefs: [ev('obs-1')], signal: 0.8 };
const intervention = { scope: 'cluster', sourceVersion: 'v1', tdbHash: 'tdb-1', treatment: 0.9, control: 0.6, treatmentSampleCount: 20, controlSampleCount: 20, effectConfidence: 0.99, confidenceInterval: { lower: 0.15, upper: 0.45 }, expiresAt: '2099-01-01T00:00:00Z', evidenceRefs: [ev('probe-1')] };
const replaySeed = { taskId: 'task-1', edgeId: 'edge-1', sourceNodeId: 'n1', targetNodeId: 'n2', sourceAgentId: 'a1', targetAgentId: 'a2', relationType: 'delegates_to' };
const replayEvents = [{ id: 'evt-1', eventType: 'task_started', sequence: 1, createdAt: '2026-01-01T00:00:00Z', payload: {} }];
test('observation alone is blocked from causal attribution', () => { const r = assessProbeEffect({ observation, expectedScope: 'cluster' }); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.attribution, 'BLOCKED'); assert.equal(r.observationalSignal, true); });
test('validated bound intervention/control certifies probe effect', () => { const r = assessProbeEffect({ observation, intervention, expectedScope: 'cluster', expectedSourceVersion: 'v1', expectedTdbHash: 'tdb-1', minEffect: .1, now: '2026-01-01T00:00:00Z' }); assert.equal(r.status, 'CERTIFIED'); assert.equal(r.attribution, 'PROBE_SUPPORTED'); assert.ok(Math.abs(r.effect - .3) < 1e-9); });
test('missing or unvalidated intervention evidence is blocked', () => { const r = assessProbeEffect({ observation, intervention: { ...intervention, evidenceRefs: [{ evidenceRef: 'x', validated: false }] }, expectedScope: 'cluster' }); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.reason, 'intervention_evidence_unvalidated'); });
test('conflicting evidence cannot certify effect', () => { const r = assessProbeEffect({ observation, intervention: { ...intervention, conflict: true }, expectedScope: 'cluster' }); assert.equal(r.status, 'CONFLICT'); assert.equal(r.attribution, 'BLOCKED'); });
test('low sample count and weak confidence remain unknown', () => { const r = assessProbeEffect({ observation, intervention: { ...intervention, treatmentSampleCount: 2 }, expectedScope: 'cluster' }); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.reason, 'sample_count_below_minimum'); const c = assessProbeEffect({ observation, intervention: { ...intervention, effectConfidence: 0.5 }, expectedScope: 'cluster' }); assert.equal(c.reason, 'effect_confidence_below_minimum'); });
test('expired or zero crossing interval cannot certify', () => { const e = assessProbeEffect({ observation, intervention: { ...intervention, expiresAt: '2020-01-01T00:00:00Z' }, expectedScope: 'cluster', now: '2026-01-01T00:00:00Z' }); assert.equal(e.reason, 'probe_effect_expired'); const z = assessProbeEffect({ observation, intervention: { ...intervention, confidenceInterval: { lower: -0.1, upper: 0.4 } }, expectedScope: 'cluster', now: '2026-01-01T00:00:00Z' }); assert.equal(z.reason, 'confidence_interval_crosses_zero'); });
test('power and precision gates are opt-in and conservative', () => {
  const compatible = assessProbeEffect({ observation, intervention, expectedScope: 'cluster' });
  assert.equal(compatible.status, 'CERTIFIED');
  const missing = assessProbeEffect({ observation, intervention, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(missing.reason, 'power_estimate_missing');
  const missingSource = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimate: 0.9 }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(missingSource.reason, 'power_source_missing');
  const missingVersion = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimate: 0.9, powerSource: 'statsmodels' }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(missingVersion.reason, 'power_version_missing');
  const weak = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimate: 0.7, powerSource: 'statsmodels', powerVersion: '0.14.0' }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(weak.reason, 'power_below_minimum');
  const underpowered = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimate: 0.9, powerSource: 'statsmodels', powerVersion: '0.14.0' }, expectedScope: 'cluster', minSampleCountByPower: { treatment: 25, control: 25 } });
  assert.equal(underpowered.reason, 'sample_count_below_power_minimum');
  const imprecise = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimate: 0.9, powerSource: 'statsmodels', powerVersion: '0.14.0' }, expectedScope: 'cluster', minPower: 0.8, maxConfidenceIntervalWidth: 0.1 });
  assert.equal(imprecise.reason, 'confidence_interval_too_wide');
  const strong = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimate: 0.9, powerSource: 'statsmodels', powerVersion: '0.14.0' }, expectedScope: 'cluster', minPower: 0.8, minSampleCountByPower: { treatment: 20, control: 20 }, maxConfidenceIntervalWidth: 0.4 });
  assert.equal(strong.status, 'CERTIFIED');
  assert.equal(strong.powerEstimate, 0.9);
  assert.equal(strong.powerSource, 'statsmodels');
  assert.equal(strong.powerVersion, '0.14.0');
});

test('deterministic power estimator returns auditable source and version', () => {
  const input = { treatmentMean: 0.9, controlMean: 0.6, treatmentVariance: 0.04, controlVariance: 0.04, treatmentSampleCount: 40, controlSampleCount: 40, alpha: 0.05 };
  const a = estimateProbePower(input); const b = estimateProbePower(input);
  assert.equal(a.status, 'ESTIMATED');
  assert.equal(a.source, 'ubuddy-normal-approx');
  assert.equal(a.version, UBUDDY_POWER_ESTIMATOR_VERSION);
  assert.equal(a.estimate, b.estimate);
  assert.ok(a.inputHash);
  assert.deepEqual(a.inputSummary, b.inputSummary);
  assert.ok(a.estimate > 0.8);
});

test('estimated power can be explicitly bound to the opt-in gate', () => {
  const p = estimateProbePower({ treatmentMean: 0.9, controlMean: 0.6, treatmentVariance: 0.04, controlVariance: 0.04, treatmentSampleCount: 40, controlSampleCount: 40 });
  const r = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: p }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(r.status, 'CERTIFIED');
  assert.equal(r.powerSource, p.source); assert.equal(r.powerVersion, p.version);
});

test('power input hash binds the estimate to its canonical statistics', () => {
  const p = estimateProbePower({ treatmentMean: 0.9, controlMean: 0.6, treatmentVariance: 0.04, controlVariance: 0.04, treatmentSampleCount: 40, controlSampleCount: 40 });
  const ok = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: p }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(ok.status, 'CERTIFIED');
  const changed = { ...p, inputSummary: { ...p.inputSummary, treatmentMean: 0.7 } };
  const bad = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: changed }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(bad.status, 'UNKNOWN');
  assert.equal(bad.reason, 'power_input_hash_mismatch');
});

test('explicit power statistics cannot change after hash binding', () => {
  const p = estimateProbePower({ treatmentMean: 0.9, controlMean: 0.6, treatmentVariance: 0.04, controlVariance: 0.04, treatmentSampleCount: 40, controlSampleCount: 40 });
  const bad = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: p, powerInputSummary: { ...p.inputSummary, controlSampleCount: 41 } }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(bad.status, 'UNKNOWN');
  assert.equal(bad.reason, 'power_input_changed');
});

test('invalid power inputs remain unknown', () => {
  const r = estimateProbePower({ treatmentMean: 1, controlMean: 0, treatmentVariance: 0, controlVariance: 0, treatmentSampleCount: 10, controlSampleCount: 10 });
  assert.equal(r.status, 'UNKNOWN');
});

test('power gate requires concrete source event refs or source ids', () => {
  const p = estimateProbePower({ treatmentMean: 0.9, controlMean: 0.6, treatmentVariance: 0.04, controlVariance: 0.04, treatmentSampleCount: 40, controlSampleCount: 40, sourceEventRefs: ['evt-2', 'evt-1'] });
  assert.deepEqual(p.inputSummary.sourceEventRefs, ['evt-1', 'evt-2']);
  const ok = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: p }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(ok.status, 'CERTIFIED');
  const noSource = { ...p, inputSummary: { ...p.inputSummary, sourceEventRefs: [], sourceIds: [] } };
  const blocked = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: noSource }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(blocked.status, 'UNKNOWN');
  assert.ok(['power_input_source_missing', 'power_input_hash_mismatch'].includes(blocked.reason));
});

test('power source event identity/version binding is immutable across replacement or deletion', () => {
  const p = estimateProbePower({
    treatmentMean: 0.9, controlMean: 0.6, treatmentVariance: 0.04, controlVariance: 0.04,
    treatmentSampleCount: 40, controlSampleCount: 40,
    sourceEventRefs: ['evt-1'], sourceEventRefRecords: [{ eventRef: 'evt-1', eventVersion: 'v1', contentHash: 'hash-a', observedAt: '2026-01-01T00:00:00Z' }],
  });
  const baseIntervention = { ...intervention, powerEstimateResult: p };
  assert.equal(assessProbeEffect({ observation, intervention: baseIntervention, expectedScope: 'cluster', minPower: 0.8 }).status, 'CERTIFIED');
  const replaced = { ...p, inputSummary: { ...p.inputSummary, sourceEventRefRecords: [{ eventRef: 'evt-1', eventVersion: 'v2', contentHash: 'hash-b', observedAt: '2026-01-01T00:00:00Z' }] } };
  const replacementResult = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: replaced }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(replacementResult.status, 'UNKNOWN');
  assert.equal(replacementResult.reason, 'power_input_source_changed');
  const deleted = { ...p, inputSummary: { ...p.inputSummary, sourceEventRefs: [], sourceEventRefRecords: [], sourceEventRefBindingHash: '' } };
  const deletionResult = assessProbeEffect({ observation, intervention: { ...intervention, powerEstimateResult: deleted }, expectedScope: 'cluster', minPower: 0.8 });
  assert.equal(deletionResult.status, 'UNKNOWN');
  assert.ok(['power_input_source_changed', 'power_input_source_missing', 'power_input_hash_mismatch'].includes(deletionResult.reason));
});

test('Probe/TDB replay binding requires the same event identity set and hashes in both directions', () => {
  const snapshot = taskDependencyBundleReplaySnapshot(replayEvents, replaySeed);
  const matched = validateProbeTdbReplayBinding({ sourceEventRefs: ['evt-1'], replaySnapshot: snapshot });
  assert.equal(matched.status, 'CERTIFIED');
  const wrongEvents = validateProbeTdbReplayBinding({ sourceEventRefs: ['evt-2'], replaySnapshot: snapshot });
  assert.equal(wrongEvents.status, 'UNKNOWN');
  assert.equal(wrongEvents.reason, 'tdb_probe_event_set_mismatch');
  const stale = validateProbeTdbReplayBinding({ sourceEventRefs: ['evt-1'], replaySnapshot: { ...snapshot, traceHash: 'stale' }, expectedTraceHash: snapshot.traceHash });
  assert.equal(stale.reason, 'tdb_traceHash_mismatch');
});

test('assessProbeEffect propagates strict TDB replay binding and blocks changed replay', () => {
  const snapshot = taskDependencyBundleReplaySnapshot(replayEvents, replaySeed);
  const bound = assessProbeEffect({ observation: { ...observation, tdbHash: snapshot.finalHash }, intervention: { ...intervention, tdbHash: snapshot.finalHash, powerInputSummary: { sourceEventRefs: ['evt-1'] } }, expectedScope: 'cluster', expectedTdbHash: snapshot.finalHash, tdbReplaySnapshot: snapshot });
  assert.equal(bound.status, 'CERTIFIED');
  assert.equal(bound.tdbBinding.replayToken, snapshot.replayToken);
  const changed = assessProbeEffect({ observation: { ...observation, tdbHash: snapshot.finalHash }, intervention: { ...intervention, tdbHash: snapshot.finalHash, powerInputSummary: { sourceEventRefs: ['evt-2'] } }, expectedScope: 'cluster', expectedTdbHash: snapshot.finalHash, tdbReplaySnapshot: snapshot });
  assert.equal(changed.status, 'UNKNOWN');
  assert.equal(changed.reason, 'tdb_probe_event_set_mismatch');
});
