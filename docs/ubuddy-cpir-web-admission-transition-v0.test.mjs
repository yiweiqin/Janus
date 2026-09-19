#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  auditSinkState, consumeAdmission, createAtomicSinkStore, finalizeReceipt, makeSinkState, mutateBinding, reserveAdmission, step
} from './ubuddy-cpir-web-admission-transition-v0.mjs';

const baseState = () => makeSinkState({
  sinkId: 'orders-sink', issuer: 'orders-sink.example', tenantId: 'tenant-a',
  tenantRevision: 12, browserProfile: 'profile-a', sessionEpoch: 4,
  oauthIssuer: 'https://issuer.example', oauthSubject: 'user-a', oauthAudience: 'orders-api', scopeDigest: 'scope-order-write', oauthEpoch: 9, apiOrigin: 'https://api.example',
  apiVersion: '2026-09', versionFence: 'etag-4', sinkGeneration: 3,
  contractRegistry: {
    'contract-order': {contractDigest: 'contract-digest-order', effectId: 'effect-7', tenantId: 'tenant-a', minCardinality: 1, maxCardinality: 1}
  }
});

const request = (overrides = {}) => ({
  tokenId: 'token-7', nonce: 'nonce-7', intentId: 'intent-7', effectId: 'effect-7',
  tenantId: 'tenant-a', tenantRevision: 12, browserProfile: 'profile-a', sessionEpoch: 4,
  oauthIssuer: 'https://issuer.example', oauthSubject: 'user-a', oauthAudience: 'orders-api', scopeDigest: 'scope-order-write', oauthEpoch: 9,
  apiOrigin: 'https://api.example', apiVersion: '2026-09', versionFence: 'etag-4',
  idempotenceKey: 'idem-7', contractId: 'contract-order', contractDigest: 'contract-digest-order',
  now: 100, expiresAt: 150, expectedStateRevision: 0, ...overrides
});

const action = (overrides = {}) => ({
  intentId: 'intent-7', effectId: 'effect-7', tenantId: 'tenant-a', tenantRevision: 12,
  browserProfile: 'profile-a', sessionEpoch: 4,
  oauthIssuer: 'https://issuer.example', oauthSubject: 'user-a', oauthAudience: 'orders-api', scopeDigest: 'scope-order-write', oauthEpoch: 9, apiOrigin: 'https://api.example',
  apiVersion: '2026-09', versionFence: 'etag-4', idempotenceKey: 'idem-7',
  contractId: 'contract-order', contractDigest: 'contract-digest-order', expectedStateRevision: 1, ...overrides
});

const cases = [];
const record = (name, actual, expected) => {
  assert.equal(actual.outcome, expected, name);
  cases.push({name, outcome: actual.outcome, reasonCode: actual.reasonCode});
};

let reserved = reserveAdmission(baseState(), request());
record('reserve-happy-path', reserved, 'RESERVED');
let committed = consumeAdmission(reserved.state, reserved.token, action(), 110);
record('consume-happy-path', committed, 'COMMITTED');
assert.equal(committed.state.effectCardinality['effect-7'], 1);

const replay = consumeAdmission(committed.state, reserved.token, action(), 111);
record('token-replay-is-no-op', replay, 'NO_OP');
assert.equal(replay.state.effectCardinality['effect-7'], 1);
record('token-replay-wrong-action-rejected', consumeAdmission(committed.state, reserved.token, action({tenantId: 'tenant-b'}), 111), 'REJECTED');

const final = finalizeReceipt(committed.state, committed.receipt.receiptId, {
  authoritative: true, signatureVerified: true, sinkGeneration: 3,
  commitIndex: 1, tokenHash: committed.receipt.tokenHash, verifiedAt: 120, trustedClock: true, expectedStateRevision: 2
});
record('receipt-finalization', final, 'FINAL_VERIFIED');
record('receipt-finalization-monotone', finalizeReceipt(final.state, committed.receipt.receiptId, {}), 'NO_OP');

reserved = reserveAdmission(baseState(), request());
const fenceBumped = mutateBinding(reserved.state, {versionFence: 'etag-5'}, 'VERSION_BUMP');
record('fence-bump-rejects-token', consumeAdmission(fenceBumped, reserved.token, action({expectedStateRevision: fenceBumped.stateRevision}), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
const sessionRotated = mutateBinding(reserved.state, {sessionEpoch: 5}, 'SESSION_ROTATION');
record('session-rotation-rejects-token', consumeAdmission(sessionRotated, reserved.token, action({expectedStateRevision: sessionRotated.stateRevision}), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
const oauthRotated = mutateBinding(reserved.state, {oauthEpoch: 10}, 'OAUTH_ROTATION');
record('oauth-rotation-rejects-token', consumeAdmission(oauthRotated, reserved.token, action({expectedStateRevision: oauthRotated.stateRevision}), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
let aba = mutateBinding(reserved.state, {versionFence: 'etag-5'}, 'ABA_OUT');
aba = mutateBinding(aba, {versionFence: 'etag-4'}, 'ABA_BACK');
record('fence-aba-rejects-old-token', consumeAdmission(aba, reserved.token, action({expectedStateRevision: aba.stateRevision}), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
record('concurrent-same-key-reservation', reserveAdmission(reserved.state, request({tokenId: 'token-8', nonce: 'nonce-8', intentId: 'intent-8'})), 'REJECTED');

record('cross-tenant-reservation', reserveAdmission(baseState(), request({tenantId: 'tenant-b'})), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
const tampered = {...reserved.token, effectId: 'effect-other'};
record('tampered-token', consumeAdmission(reserved.state, tampered, action(), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request({expiresAt: 105}));
record('expired-before-consume', consumeAdmission(reserved.state, reserved.token, action(), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
committed = consumeAdmission(reserved.state, reserved.token, action(), 110);
record('blind-rereserve-after-lost-observation', reserveAdmission(committed.state, request({tokenId: 'token-9', nonce: 'nonce-9'})), 'REJECTED');

record('finality-evidence-mismatch', finalizeReceipt(committed.state, committed.receipt.receiptId, {
  authoritative: true, signatureVerified: true, sinkGeneration: 4,
  commitIndex: 1, tokenHash: committed.receipt.tokenHash, verifiedAt: 120, trustedClock: true, expectedStateRevision: committed.state.stateRevision
}), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
record('future-issued-token', consumeAdmission(reserved.state, reserved.token, action(), 99), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
const firstForBound = consumeAdmission(reserved.state, reserved.token, action(), 110);
const secondRequest = request({tokenId: 'token-second', nonce: 'nonce-second', intentId: 'intent-second', idempotenceKey: 'idem-second', expectedStateRevision: firstForBound.state.stateRevision});
const secondReserved = reserveAdmission(firstForBound.state, secondRequest);
record('second-key-may-reserve-under-same-contract', secondReserved, 'RESERVED');
record('registry-bound-cardinality-rejects-second-effect', consumeAdmission(secondReserved.state, secondReserved.token, action({intentId: 'intent-second', idempotenceKey: 'idem-second', expectedStateRevision: secondReserved.state.stateRevision, maxCardinality: 99}), 120), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
const generationBumped = mutateBinding(reserved.state, {sinkGeneration: 4, bootEpoch: 2}, 'SINK_RESTART');
record('generation-bump-rejects-token', consumeAdmission(generationBumped, reserved.token, action({expectedStateRevision: generationBumped.stateRevision}), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
const principalRotated = mutateBinding(reserved.state, {oauthSubject: 'user-b'}, 'SUBJECT_ROTATION');
record('oauth-subject-rotation-rejects-token', consumeAdmission(principalRotated, reserved.token, action({expectedStateRevision: principalRotated.stateRevision}), 110), 'REJECTED');

reserved = reserveAdmission(baseState(), request());
const committedForForge = consumeAdmission(reserved.state, reserved.token, action(), 110);
const forgedState = structuredClone(committedForForge.state);
forgedState.receiptLedger[0].state = 'NO_COMMIT';
record('forged-no-commit-cannot-finalize', finalizeReceipt(forgedState, committedForForge.receipt.receiptId, {
  authoritative: true, signatureVerified: true, trustedClock: true, sinkGeneration: 3,
  commitIndex: 1, tokenHash: committedForForge.receipt.tokenHash, verifiedAt: 120, expectedStateRevision: forgedState.stateRevision
}), 'REJECTED');

const store = createAtomicSinkStore(baseState());
const raceReserved = store.reserve(request());
record('store-first-reserve-wins', raceReserved, 'RESERVED');
record('store-stale-concurrent-reserve-loses', store.reserve(request({tokenId: 'token-race-2', nonce: 'nonce-race-2'})), 'REJECTED');
const raceCommitted = store.consume(raceReserved.token, action(), 110);
record('store-first-consume-linearizes', raceCommitted, 'COMMITTED');
record('store-second-consume-stutters', store.consume(raceReserved.token, action(), 111), 'NO_OP');

assert.equal(auditSinkState(raceCommitted.state).disposition, 'SAFE');
cases.push({name: 'sink-invariant-audit-happy-path', outcome: 'SAFE', reasonCode: 'ALL_INVARIANTS_HOLD'});
const crossBound = structuredClone(raceCommitted.state);
crossBound.receiptLedger[0].effectId = 'effect-evil';
assert.equal(auditSinkState(crossBound).disposition, 'VIOLATED');
cases.push({name: 'sink-audit-rejects-cross-bound-receipt', outcome: 'VIOLATED', reasonCode: 'RECEIPT_TOKEN_BINDING_MISMATCH'});
const cardinalityForged = structuredClone(raceCommitted.state);
cardinalityForged.effectCardinality['effect-7'] = 2;
assert.equal(auditSinkState(cardinalityForged).disposition, 'VIOLATED');
cases.push({name: 'sink-audit-rejects-cardinality-forgery', outcome: 'VIOLATED', reasonCode: 'CARDINALITY_RECEIPT_COUNT_MISMATCH'});

const forgedReceiptState = structuredClone(raceCommitted.state);
forgedReceiptState.receiptLedger[0].state = 'NO_COMMIT';
assert.equal(auditSinkState(forgedReceiptState).disposition, 'VIOLATED');
cases.push({name: 'sink-audit-rejects-receipt-state-forgery', outcome: 'VIOLATED', reasonCode: 'RECEIPT_STATE_INVALID_OR_FORGED'});
const forgedRegistry = structuredClone(raceCommitted.state);
forgedRegistry.contractRegistry['contract-order'].contractDigest = 'evil-contract';
assert.equal(auditSinkState(forgedRegistry).disposition, 'VIOLATED');
cases.push({name: 'sink-audit-rejects-registry-replacement', outcome: 'VIOLATED', reasonCode: 'TOKEN_CONTRACT_REGISTRY_MISMATCH'});
const forgedCardinalityAfter = structuredClone(raceCommitted.state);
forgedCardinalityAfter.receiptLedger[0].cardinalityAfter = 99;
assert.equal(auditSinkState(forgedCardinalityAfter).disposition, 'VIOLATED');
cases.push({name: 'sink-audit-rejects-receipt-cardinality-after', outcome: 'VIOLATED', reasonCode: 'RECEIPT_CARDINALITY_AFTER_MISMATCH'});

const stepInitial = baseState();
const stepReserve = step(stepInitial, {type: 'RESERVE', request: request()});
assert.equal(stepReserve.transition, 'APPLY');
assert.equal(stepReserve.stateRevision.after, stepReserve.stateRevision.before + 1);
const stepUnknown = step(stepReserve.state, {type: 'UNDECLARED'});
assert.equal(stepUnknown.transition, 'UNKNOWN');
assert.equal(stepUnknown.preStateHash, stepUnknown.postStateHash);
cases.push({name: 'unified-step-witness-and-unknown-stutter', outcome: 'SAFE', reasonCode: 'STEP_HASH_INVARIANT'});

assert.throws(() => mutateBinding(baseState(), {sinkGeneration: 2}, 'ILLEGAL_ROLLBACK'), /NON_MONOTONIC_EPOCH/);
cases.push({name: 'epoch-generation-cannot-roll-back', outcome: 'REJECTED', reasonCode: 'NON_MONOTONIC_EPOCH'});

console.log(JSON.stringify({
  schemaVersion: 'cpir-web/admission-transition-test/v0',
  implementationStatus: 'research-prototype/unverified',
  allPassed: true,
  caseCount: cases.length,
  cases
}, null, 2));
