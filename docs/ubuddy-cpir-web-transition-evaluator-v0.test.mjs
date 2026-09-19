#!/usr/bin/env node
import assert from 'node:assert/strict';
import {advanceCace, advanceRfre, CaceState, evaluateWebAction, RfreState, Verdict} from './ubuddy-cpir-web-transition-evaluator-v0.mjs';

const clone = value => structuredClone(value);

const contract = {
  intentId: 'intent-7',
  effectId: 'effect-7',
  tenantId: 'tenant-a',
  authority: {
    browserProfile: 'profile-a',
    sessionEpoch: 4,
    oauthIssuer: 'https://issuer.example',
    oauthSubject: 'user-a',
    audience: 'orders-api',
    oauthEpoch: 9
  },
  api: {origin: 'https://api.example', version: '2026-09'},
  sink: {id: 'orders-sink', issuer: 'sink-authority.example'},
  admission: {tokenId: 'token-7', bindingDigest: 'bind-7', nonce: 'nonce-7'},
  effect: {minCardinality: 1, maxCardinality: 1}
};

const snapshot = {
  now: 100,
  session: {browserProfile: 'profile-a', epoch: 4, tenantId: 'tenant-a'},
  oauth: {
    issuer: 'https://issuer.example', subject: 'user-a', audience: 'orders-api',
    epoch: 9, tenantId: 'tenant-a', scopeSet: ['order.write', 'receipt.read'], validUntil: 200
  },
  envelope: {
    browserProfile: 'profile-a', sessionEpoch: 4,
    oauthIssuer: 'https://issuer.example', oauthSubject: 'user-a', audience: 'orders-api', oauthEpoch: 9,
    tenantId: 'tenant-a', apiOrigin: 'https://api.example', apiVersion: '2026-09', versionFence: 'etag-4',
    intentId: 'intent-7', effectId: 'effect-7', idempotenceKey: 'idem-7'
  },
  resource: {tenantId: 'tenant-a', apiOrigin: 'https://api.example', apiVersion: '2026-09', versionFence: 'etag-4'},
  idempotency: {key: 'idem-7', status: 'UNUSED', intentId: 'intent-7', effectId: 'effect-7', tenantId: 'tenant-a'},
  effect: {cardinality: 0, sinkGeneration: 3, commitHighWatermark: 10},
  clock: {trusted: true},
  caceState: CaceState.READY_FOR_EFFECT,
  admissionToken: {tokenId: 'token-7', bindingDigest: 'bind-7', nonce: 'nonce-7', authoritative: true, signatureVerified: true, expiresAt: 180, consumed: false},
  receipt: {state: RfreState.NONE}
};

const commit = {
  id: 'COMMIT_ORDER', kind: 'COMMIT', terminal: true, retry: false,
  requiredScopes: ['order.write'], intentId: 'intent-7', effectId: 'effect-7', idempotenceKey: 'idem-7',
  expectedVersionFence: 'etag-4', effectDelta: 1
  , admissionTokenId: 'token-7', bindingDigest: 'bind-7', admissionNonce: 'nonce-7'
};

const receipt = state => ({
  state, authoritative: true, intentId: 'intent-7', effectId: 'effect-7', idempotenceKey: 'idem-7',
  tenantId: 'tenant-a', sinkId: 'orders-sink', issuer: 'sink-authority.example', signatureVerified: true,
  sinkGeneration: 3, commitIndex: 11, versionFence: 'etag-4', issuedAt: 90, freshUntil: 180
});

const cases = [];
const check = (name, mutate, action, expected, obligation, code) => {
  const state = clone(snapshot);
  mutate(state);
  const actual = evaluateWebAction(contract, state, clone(action));
  assert.equal(actual.disposition, expected, `${name}: disposition`);
  if (obligation) {
    const item = actual.obligations.find(entry => entry.obligationId === obligation);
    assert.ok(item, `${name}: missing ${obligation}`);
    assert.equal(item.code, code, `${name}: reason code`);
  }
  cases.push({name, disposition: actual.disposition, witnessObligations: actual.witnessObligations});
};

check('valid-first-commit', () => {}, commit, Verdict.SAFE);
check('wrong-tenant', state => { state.resource.tenantId = 'tenant-b'; }, commit, Verdict.VIOLATED, 'TENANT_BOUND', 'CROSS_TENANT_BINDING');
check('stale-version', state => { state.resource.versionFence = 'etag-5'; }, commit, Verdict.VIOLATED, 'VERSION_FRESH', 'STALE_OR_MISMATCHED_VERSION_FENCE');
check('missing-scope', state => { state.oauth.scopeSet = ['receipt.read']; }, commit, Verdict.VIOLATED, 'AUTH_CONTINUOUS', 'REQUIRED_SCOPE_MISSING');
check('unknown-effect-cardinality', state => { state.effect.cardinality = null; }, commit, Verdict.UNKNOWN, 'EFFECT_CARDINALITY_WITHIN_BOUND', 'EFFECT_CARDINALITY_UNKNOWN');
check('duplicate-intent', state => {
  state.effect.cardinality = 1;
  state.idempotency.status = 'COMMITTED_SAME_EFFECT';
  state.receipt = receipt(RfreState.FINAL_VERIFIED);
}, commit, Verdict.VIOLATED, 'IDEM_UNIQUE', 'IDEMPOTENCE_KEY_ALREADY_CONSUMED');

const retry = {...commit, retry: true};
check('retry-with-authoritative-no-commit', state => { state.receipt = receipt(RfreState.NO_COMMIT); }, retry, Verdict.SAFE);
check('retry-with-unknown-receipt', state => { state.receipt = {state: RfreState.UNKNOWN}; }, retry, Verdict.UNKNOWN, 'RECEIPT_POLICY_SATISFIED', 'RECEIPT_EVIDENCE_MISSING');
check('retry-after-lost-receipt-known-commit', state => {
  state.effect.cardinality = 1;
  state.idempotency.status = 'RESERVED_SAME_INTENT';
  state.receipt = receipt(RfreState.LOST_AFTER_COMMIT);
}, retry, Verdict.VIOLATED, 'RECEIPT_POLICY_SATISFIED', 'RETRY_AFTER_POSSIBLE_OR_KNOWN_COMMIT');

const claimSuccess = {id: 'CLAIM_SUCCESS', kind: 'CLAIM_SUCCESS', terminal: true, claimSuccess: true, requiredScopes: [], effectDelta: 0};
check('claim-final-success', state => { state.effect.cardinality = 1; state.receipt = receipt(RfreState.FINAL_VERIFIED); }, claimSuccess, Verdict.SAFE);
check('claim-before-finality', state => { state.effect.cardinality = 1; state.receipt = receipt(RfreState.COMMITTED_UNFINALIZED); }, claimSuccess, Verdict.UNKNOWN, 'RECEIPT_POLICY_SATISFIED', 'FINALITY_NOT_ESTABLISHED');
check('false-success-no-commit', state => { state.receipt = receipt(RfreState.NO_COMMIT); }, claimSuccess, Verdict.VIOLATED, 'RECEIPT_POLICY_SATISFIED', 'FALSE_SUCCESS_NO_COMMIT');
check('missing-oauth-expiry', state => { delete state.oauth.validUntil; }, commit, Verdict.UNKNOWN, 'AUTH_CONTINUOUS', 'AUTHORITY_EVIDENCE_MISSING');
check('bare-final-state-is-not-evidence', state => { state.effect.cardinality = 1; state.receipt = {state: RfreState.FINAL_VERIFIED}; }, claimSuccess, Verdict.UNKNOWN, 'RECEIPT_POLICY_SATISFIED', 'RECEIPT_EVIDENCE_MISSING');
check('stale-sink-generation', state => {
  state.effect.cardinality = 1;
  state.receipt = receipt(RfreState.FINAL_VERIFIED);
  state.receipt.sinkGeneration = 2;
}, claimSuccess, Verdict.VIOLATED, 'RECEIPT_POLICY_SATISFIED', 'RECEIPT_EFFECT_BINDING_MISMATCH');
check('idempotency-registry-other-intent', state => { state.idempotency.intentId = 'intent-other'; }, commit, Verdict.VIOLATED, 'IDEM_UNIQUE', 'IDEMPOTENCY_REGISTRY_BINDING_MISMATCH');

const incompleteCommit = clone(commit);
delete incompleteCommit.requiredScopes;
check('commit-action-missing-required-scopes', () => {}, incompleteCommit, Verdict.UNKNOWN, 'ACTION_TYPED', 'ACTION_SCHEMA_INVALID_OR_INCOMPLETE');

const compensation = {...commit, id: 'COMPENSATE_ORDER', kind: 'COMPENSATE', compensationContractId: undefined};
check('compensation-needs-own-contract', () => {}, compensation, Verdict.UNKNOWN, 'ACTION_TYPED', 'ACTION_SCHEMA_INVALID_OR_INCOMPLETE');
const compensationContract = clone(contract);
compensationContract.intentId = 'intent-comp-7';
compensationContract.effectId = 'effect-comp-7';
const compensationSnapshot = clone(snapshot);
compensationSnapshot.envelope.intentId = 'intent-comp-7';
compensationSnapshot.envelope.effectId = 'effect-comp-7';
compensationSnapshot.envelope.idempotenceKey = 'idem-comp-7';
compensationSnapshot.idempotency = {key: 'idem-comp-7', status: 'UNUSED', intentId: 'intent-comp-7', effectId: 'effect-comp-7', tenantId: 'tenant-a'};
const compensationAction = {...commit, id: 'COMMIT_COMPENSATION', intentId: 'intent-comp-7', effectId: 'effect-comp-7', idempotenceKey: 'idem-comp-7'};
const validCompensation = evaluateWebAction(contract, clone(snapshot), {
  id: 'COMPENSATE_ORDER', kind: 'COMPENSATE',
  compensationContract, compensationSnapshot, compensationAction
});
assert.equal(validCompensation.disposition, Verdict.SAFE);
assert.equal(validCompensation.forwardEffectId, 'effect-comp-7');
assert.equal(validCompensation.historicalViolationsPreserved, true);
cases.push({name: 'compensation-is-recursive-forward-effect', disposition: validCompensation.disposition, witnessObligations: []});
check('reconcile-cannot-write', () => {}, {...commit, id: 'BAD_RECONCILE', kind: 'RECONCILE'}, Verdict.VIOLATED, 'ACTION_TYPED', 'ACTION_KIND_EFFECT_CONTRADICTION');
check('reconcile-cannot-claim-terminal', () => {}, {id: 'BAD_TERMINAL_RECONCILE', kind: 'RECONCILE', requiredScopes: [], effectDelta: 0, terminal: true}, Verdict.VIOLATED, 'ACTION_TYPED', 'ACTION_KIND_EFFECT_CONTRADICTION');

const reconcile = {id: 'READ_ONLY_RECONCILE', kind: 'RECONCILE', requiredScopes: ['receipt.read'], effectDelta: 0, terminal: false};
const reconcileEvaluation = evaluateWebAction(contract, clone(snapshot), reconcile);
assert.equal(reconcileEvaluation.disposition, Verdict.SAFE);
assert.equal(reconcileEvaluation.terminalDisposition, Verdict.UNKNOWN);
cases.push({name: 'safe-reconcile-is-not-terminal-completion', disposition: reconcileEvaluation.disposition, terminalDisposition: reconcileEvaluation.terminalDisposition, witnessObligations: []});

const commitEvaluation = evaluateWebAction(contract, clone(snapshot), clone(commit));
assert.equal(commitEvaluation.disposition, Verdict.SAFE);
assert.equal(commitEvaluation.terminalDisposition, Verdict.UNKNOWN);
cases.push({name: 'commit-admission-is-not-terminal-completion', disposition: commitEvaluation.disposition, terminalDisposition: commitEvaluation.terminalDisposition, witnessObligations: []});

check('admission-token-replay', state => { state.admissionToken.consumed = true; }, commit, Verdict.VIOLATED, 'ADMISSION_TOKEN_FRESH', 'ADMISSION_TOKEN_REPLAYED');
check('admission-token-fence-not-ready', state => { state.caceState = CaceState.STALE; }, commit, Verdict.VIOLATED, 'ADMISSION_TOKEN_FRESH', 'CACE_NOT_READY_FOR_EFFECT');

assert.equal(advanceCace(CaceState.COHERENT, CaceState.READY_FOR_EFFECT), CaceState.READY_FOR_EFFECT);
assert.throws(() => advanceCace(CaceState.READY_FOR_EFFECT, CaceState.SESSION_BOUND), /ILLEGAL_STATE_TRANSITION/);
assert.equal(advanceRfre(RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, {authoritative: true}), RfreState.FINAL_VERIFIED);
assert.throws(() => advanceRfre(RfreState.FINAL_VERIFIED, RfreState.NO_COMMIT, {authoritative: true}), /ILLEGAL_STATE_TRANSITION/);
assert.throws(() => advanceRfre(RfreState.UNKNOWN, RfreState.FINAL_VERIFIED), /MISSING_AUTHORITATIVE_EVIDENCE/);
cases.push({name: 'state-machine-monotonicity', disposition: 'PASS', witnessObligations: []});

console.log(JSON.stringify({
  schemaVersion: 'cpir-web/transition-evaluator-test/v0',
  implementationStatus: 'research-prototype/unverified',
  allPassed: true,
  caseCount: cases.length,
  cases
}, null, 2));
