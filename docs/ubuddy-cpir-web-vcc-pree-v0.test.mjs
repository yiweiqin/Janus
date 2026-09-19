#!/usr/bin/env node
import assert from 'node:assert/strict';
import {advanceActivation, buildCoherenceCut, createEvidenceEscrow, createEvidenceEscrowStore, digest, escrowObservation, makeEvidenceAtom, reserveFromEscrow} from './ubuddy-cpir-web-vcc-pree-v0.mjs';

const activation = {activationRoot: 'root-1', tabEpoch: 1, pageEpoch: 1, swEpoch: 1, partitionEpoch: 1, activationNonce: 'act-1', partitionKeyHash: 'partition-1'};
const atom = (sourceId, overrides = {}) => ({atomId: `${sourceId}-1`, sourceId, authorityId: `${sourceId}-authority`, keyRevision: 1, signatureVerified: true, probeSessionId: 'probe-1', challengeNonce: 'nonce-1', ...activation, intentId: 'intent-1', effectId: 'effect-1', tenantId: 'tenant-a', owner: 'agent-a', scope: 'submit', revision: 1, validFrom: 10, validUntil: 20, payloadDigest: `${sourceId}-payload`, ...overrides});
const expected = {probeSessionId: 'probe-1', challengeNonce: 'nonce-1', activation, intentId: 'intent-1', effectId: 'effect-1', tenantId: 'tenant-a', owner: 'agent-a', scope: 'submit'};
const requiredSources = ['browser', 'oauth', 'tenant', 'api', 'sink'];
const allAtoms = requiredSources.map(sourceId => atom(sourceId));

assert.equal(makeEvidenceAtom(atom('browser')).status, 'ACCEPTED');
assert.equal(buildCoherenceCut({atoms: allAtoms, requiredSources, expected, now: 15}).status, 'SAFE');

const fractured = buildCoherenceCut({atoms: allAtoms.map(item => item.sourceId === 'sink' ? {...item, validFrom: 21, validUntil: 30} : item), requiredSources, expected, now: 15});
assert.equal(fractured.status, 'UNKNOWN');
assert.equal(fractured.reasonCode, 'FRACTURED_VALIDITY_INTERVAL');

const staleRevision = buildCoherenceCut({atoms: allAtoms, requiredSources, expected, now: 15, dependencyRevisions: {api: 2}});
assert.equal(staleRevision.status, 'UNKNOWN');
assert.equal(staleRevision.reasonCode, 'COHERENCE_CONSTRAINT_UNSATISFIED');
assert.equal(buildCoherenceCut({atoms: allAtoms, requiredSources, expected, now: 15, dependencyRevisions: {oauth: 1, api: 1}}).status, 'SAFE');

const escrow = createEvidenceEscrow({probeSessionId: 'probe-1', challengeNonce: 'nonce-1', activation, intentId: 'intent-1', effectId: 'effect-1', tenantId: 'tenant-a', owner: 'agent-a', scope: 'submit', requiredSources, expiresAt: 20});
let stored = escrow;
for (const item of allAtoms) stored = escrowObservation(stored, item).escrow;
const cutResult = buildCoherenceCut({atoms: allAtoms, requiredSources, expected, now: 15});
const reserveRequest = {cut: cutResult.cut, cutDigest: cutResult.cutDigest, evidenceAtomIds: cutResult.cut.evidenceAtomIds, expectedEscrowRevision: stored.escrowRevision, expectedStateRevision: 3, currentStateRevision: 3, currentActivation: activation, now: 15};
const bound = reserveFromEscrow(stored, reserveRequest);
assert.equal(bound.status, 'SAFE');
assert.equal(reserveFromEscrow(stored, {...reserveRequest, expectedStateRevision: 2}).reasonCode, 'STALE_PROBE_RESERVE_REVISION');
assert.equal(reserveFromEscrow(stored, {...reserveRequest, now: 21}).reasonCode, 'ESCROW_EXPIRED');
assert.equal(escrowObservation(escrow, atom('browser', {owner: 'agent-b'})).reasonCode, 'ESCROW_BINDING_MISMATCH');
assert.equal(escrowObservation(stored, atom('browser', {payloadDigest: 'collision'})).reasonCode, 'EVIDENCE_ATOM_ID_COLLISION');
assert.equal(buildCoherenceCut({atoms: [...allAtoms, ...allAtoms.map(item => ({...item, atomId: `${item.atomId}-copy`}))], requiredSources, expected, now: 15, maxCandidateCombinations: 10, enumerationMode: 'CARTESIAN'}).reasonCode, 'CUT_SEARCH_BOUND_EXCEEDED');
const staleAtomCut = buildCoherenceCut({atoms: allAtoms.map(item => item.sourceId === 'sink' ? {...item, validUntil: 12} : item), requiredSources, expected, now: 11});
assert.equal(reserveFromEscrow(stored, {...reserveRequest, cut: staleAtomCut.cut, cutDigest: staleAtomCut.cutDigest, evidenceAtomIds: staleAtomCut.cut.evidenceAtomIds}).reasonCode, 'CUT_NOT_RECONSTRUCTIBLE_FROM_ESCROW');
const forgedCut = {...cutResult.cut, tenantId: 'tenant-evil'};
assert.equal(reserveFromEscrow(stored, {...reserveRequest, cut: forgedCut, cutDigest: digest(forgedCut), evidenceAtomIds: forgedCut.evidenceAtomIds}).reasonCode, 'CUT_EFFECT_TENANT_BINDING_MISMATCH');
const store = createEvidenceEscrowStore(stored);
assert.equal(store.reserve(reserveRequest).status, 'SAFE');
assert.equal(store.reserve(reserveRequest).reasonCode, 'STALE_ESCROW_REVISION');
assert.equal(makeEvidenceAtom(atom('browser', {signatureVerified: false})).reasonCode, 'EVIDENCE_AUTHENTICITY_UNVERIFIED');
assert.equal(reserveFromEscrow(stored, {...reserveRequest, currentActivation: advanceActivation(activation, 'PAGESHOW_BFCACHE')}).reasonCode, 'STALE_ACTIVATION_LINEAGE');
assert.equal(advanceActivation(activation, 'SW_CONTROLLER_CHANGE').swEpoch, 2);

console.log(JSON.stringify({schemaVersion: 'cpir-web/vcc-pree-test/v0', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 18, safeCuts: 3, unknownCuts: 4, reserveBinding: 'SAFE'}, null, 2));
