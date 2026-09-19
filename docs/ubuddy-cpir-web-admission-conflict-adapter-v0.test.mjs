#!/usr/bin/env node
import assert from 'node:assert/strict';
import {buildConflictRegistry} from './ubuddy-cpir-web-conflict-registry-v0.mjs';
import {makeSinkState, mutateBinding} from './ubuddy-cpir-web-admission-transition-v0.mjs';
import {evaluateAdmissionPlan, makeAdmissionPlan} from './ubuddy-cpir-web-admission-conflict-adapter-v0.mjs';
const matrixWorlds = ids => ids.map(id => ({id}));
const matrixActions = ids => ids.map(id => ({id}));
const matrixEvaluate = matrix => (world, action) => {
  const verdict = matrix[world.id]?.[action.id] ?? 'UNKNOWN';
  return verdict === 'SAFE_TERMINAL' ? {disposition: 'SAFE', terminalDisposition: 'SAFE'}
    : verdict === 'VIOLATED' ? {disposition: 'VIOLATED', terminalDisposition: 'VIOLATED'}
      : {disposition: 'UNKNOWN', terminalDisposition: 'UNKNOWN'};
};

const stateFor = (fence = 'etag-4') => makeSinkState({
  sinkId: 'orders-sink', issuer: 'orders-sink.example', tenantId: 'tenant-a', tenantRevision: 12,
  browserProfile: 'profile-a', sessionEpoch: 4, oauthIssuer: 'https://issuer.example',
  oauthSubject: 'user-a', oauthAudience: 'orders-api', scopeDigest: 'scope-order-write', oauthEpoch: 9,
  apiOrigin: 'https://api.example', apiVersion: '2026-09', versionFence: fence, sinkGeneration: 3,
  contractRegistry: {'contract-order': {contractDigest: 'contract-digest-order', effectId: 'effect-7', tenantId: 'tenant-a', minCardinality: 1, maxCardinality: 1}}
});

const planFor = (fence, overrides = {}) => makeAdmissionPlan({
  id: `submit-${fence}`,
  request: {
    tokenId: `token-${fence}`, nonce: `nonce-${fence}`, intentId: `intent-${fence}`, effectId: 'effect-7',
    tenantId: 'tenant-a', tenantRevision: 12, browserProfile: 'profile-a', sessionEpoch: 4,
    oauthIssuer: 'https://issuer.example', oauthSubject: 'user-a', oauthAudience: 'orders-api', scopeDigest: 'scope-order-write', oauthEpoch: 9,
    apiOrigin: 'https://api.example', apiVersion: '2026-09', versionFence: fence, idempotenceKey: `idem-${fence}`,
    contractId: 'contract-order', contractDigest: 'contract-digest-order', now: 100, expiresAt: 150
  },
  action: {
    intentId: `intent-${fence}`, effectId: 'effect-7', tenantId: 'tenant-a', tenantRevision: 12,
    browserProfile: 'profile-a', sessionEpoch: 4, oauthIssuer: 'https://issuer.example', oauthSubject: 'user-a', oauthAudience: 'orders-api', scopeDigest: 'scope-order-write', oauthEpoch: 9,
    apiOrigin: 'https://api.example', apiVersion: '2026-09', versionFence: fence, idempotenceKey: `idem-${fence}`,
    contractId: 'contract-order', contractDigest: 'contract-digest-order', now: 110
  },
  finalityEvidence: {authoritative: true, signatureVerified: true, trustedClock: true, evidenceMode: 'BIND_OBSERVED_RECEIPT_TEST_ONLY'},
  revisionSource: 'GATEWAY_AT_EVENT',
  ...overrides
});

const w1 = {id: 'w1', state: stateFor('etag-4')};
const w2 = {id: 'w2', state: mutateBinding(stateFor('etag-4'), {versionFence: 'etag-5'}, 'VERSION_DRIFT')};
const actions = [planFor('etag-4'), planFor('etag-5')].map(plan => ({id: plan.id, plan}));
const evaluate = (world, action) => evaluateAdmissionPlan(world.state, action.plan);

let registry = buildConflictRegistry({worlds: [w1, w2], actions, evaluate});
assert.equal(registry.edges.filter(edge => edge.kind === 'HARD_CONFLICT').length, 1);
assert.deepEqual(registry.edges[0].minimalWorldSet, ['w1', 'w2']);
assert.equal(registry.matrix.w1['submit-etag-4'].verdict, 'SAFE_TERMINAL');
assert.equal(registry.matrix.w2['submit-etag-4'].verdict, 'VIOLATED');
assert.equal(registry.matrix.w2['submit-etag-5'].verdict, 'SAFE_TERMINAL');

const unknownWorld = {id: 'w-unknown', state: makeSinkState({contractRegistry: {}})};
registry = buildConflictRegistry({worlds: [unknownWorld], actions: [actions[0]], evaluate});
assert.equal(registry.edges[0].kind, 'EPISTEMIC_BLOCKAGE');
assert.deepEqual(registry.edges[0].minimalWorldSet, ['w-unknown']);

const badPlan = planFor('etag-4', {request: {...planFor('etag-4').request, contractDigest: 'evil'}});
const infeasible = buildConflictRegistry({worlds: [{id: 'w-bad', state: stateFor('etag-4')}], actions: [{id: badPlan.id, plan: badPlan}], evaluate});
assert.deepEqual(infeasible.infeasibleSingletons, ['w-bad']);
assert.equal(infeasible.edges.length, 0);

const safe = evaluateAdmissionPlan(stateFor('etag-4'), planFor('etag-4'));
assert.equal(safe.disposition, 'SAFE');
assert.equal(safe.terminalDisposition, 'SAFE');
assert.equal(safe.audit.disposition, 'SAFE');
assert.ok(safe.trace.some(item => item.outcome === 'COMMITTED'));

const noOracle = evaluateAdmissionPlan(stateFor('etag-4'), makeAdmissionPlan({
  id: 'no-finality', request: planFor('etag-4').request, action: planFor('etag-4').action, revisionSource: 'GATEWAY_AT_EVENT'
}));
assert.equal(noOracle.disposition, 'UNKNOWN');
assert.equal(noOracle.terminalDisposition, 'UNKNOWN');
assert.equal(noOracle.witnessObligations[0], 'RFRE');

const missingRevision = evaluateAdmissionPlan(stateFor('etag-4'), makeAdmissionPlan({
  id: 'missing-revision', request: planFor('etag-4').request, action: planFor('etag-4').action,
  finalityEvidence: planFor('etag-4').finalityEvidence
}));
assert.equal(missingRevision.disposition, 'UNKNOWN');
assert.equal(missingRevision.obligations[0].code, 'EXPECTED_STATE_REVISION_MISSING');

const corruptedInitial = stateFor('etag-4');
corruptedInitial.commitIndex = 3;
const initialAudit = evaluateAdmissionPlan(corruptedInitial, planFor('etag-4'));
assert.equal(initialAudit.disposition, 'VIOLATED');
assert.equal(initialAudit.obligations[0].code, 'INITIAL_SINK_INVARIANT_AUDIT_FAILED');

const mixed = buildConflictRegistry({
  worlds: matrixWorlds(['wm1', 'wm2']), actions: matrixActions(['a', 'b']),
  evaluate: matrixEvaluate({wm1: {a: 'UNKNOWN', b: 'VIOLATED'}, wm2: {a: 'VIOLATED', b: 'UNKNOWN'}})
});
assert.equal(mixed.edges[0].kind, 'EPISTEMIC_BLOCKAGE');
assert.equal(mixed.mixedObstructions.length, 1);
assert.deepEqual(mixed.mixedObstructions[0].worldSet, ['wm1', 'wm2']);

const mixedHard = buildConflictRegistry({
  worlds: matrixWorlds(['wx1', 'wx2']), actions: matrixActions(['a', 'b']),
  evaluate: matrixEvaluate({wx1: {a: 'SAFE_TERMINAL', b: 'VIOLATED'}, wx2: {a: 'UNKNOWN', b: 'SAFE_TERMINAL'}})
});
assert.equal(mixedHard.edges.some(item => item.kind === 'HARD_CONFLICT'), false);
assert.ok(mixedHard.edges.some(item => item.kind === 'EPISTEMIC_BLOCKAGE'));

assert.throws(() => buildConflictRegistry({
  worlds: matrixWorlds(Array.from({length: 21}, (_, i) => `w${i}`)), actions: matrixActions(['a']),
  evaluate: world => ({disposition: 'UNKNOWN', terminalDisposition: 'UNKNOWN', obligations: [{obligationId: 'O_BOUND', verdict: 'UNKNOWN', code: `MISSING_${world.id}`}]})
}), /WORLD_CLASS_BOUND_EXCEEDED/);

console.log(JSON.stringify({schemaVersion: 'cpir-web/admission-conflict-adapter-test/v0', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 10, hardConflictEdges: 1, blockageEdges: 1, infeasibleSingletons: 1}, null, 2));
