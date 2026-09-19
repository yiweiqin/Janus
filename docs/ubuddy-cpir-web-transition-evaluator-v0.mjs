/*
 * Research-only executable semantics for CPIR-Web P0/P1.
 *
 * This module does not import or modify Janus/uBuddy runtime code.  It makes
 * repair legality a function of a typed Web snapshot, an action, and a hard
 * contract.  No fixture-level safeByWorld table is accepted.
 */

export const Verdict = Object.freeze({
  SAFE: 'SAFE',
  VIOLATED: 'VIOLATED',
  UNKNOWN: 'UNKNOWN'
});

export const CaceState = Object.freeze({
  CREATED: 'CREATED',
  SESSION_BOUND: 'SESSION_BOUND',
  OAUTH_BOUND: 'OAUTH_BOUND',
  TENANT_BOUND: 'TENANT_BOUND',
  VERSION_FENCED: 'VERSION_FENCED',
  COHERENT: 'COHERENT',
  READY_FOR_EFFECT: 'READY_FOR_EFFECT',
  COMMITTING: 'COMMITTING',
  COMMITTED: 'COMMITTED',
  STALE: 'STALE',
  REJECTED: 'REJECTED'
});

export const RfreState = Object.freeze({
  NONE: 'NONE',
  UNKNOWN: 'UNKNOWN',
  NO_COMMIT: 'NO_COMMIT',
  PENDING: 'PENDING',
  COMMITTED_UNFINALIZED: 'COMMITTED_UNFINALIZED',
  FINAL_VERIFIED: 'FINAL_VERIFIED',
  LOST_AFTER_COMMIT: 'LOST_AFTER_COMMIT',
  STALE: 'STALE',
  REVOKED: 'REVOKED',
  CONFLICT: 'CONFLICT',
  DUPLICATE: 'DUPLICATE'
});

const CACE_ALLOWED = Object.freeze({
  [CaceState.CREATED]: [CaceState.SESSION_BOUND, CaceState.STALE, CaceState.REJECTED],
  [CaceState.SESSION_BOUND]: [CaceState.OAUTH_BOUND, CaceState.STALE, CaceState.REJECTED],
  [CaceState.OAUTH_BOUND]: [CaceState.TENANT_BOUND, CaceState.STALE, CaceState.REJECTED],
  [CaceState.TENANT_BOUND]: [CaceState.VERSION_FENCED, CaceState.STALE, CaceState.REJECTED],
  [CaceState.VERSION_FENCED]: [CaceState.COHERENT, CaceState.STALE, CaceState.REJECTED],
  [CaceState.COHERENT]: [CaceState.READY_FOR_EFFECT, CaceState.STALE, CaceState.REJECTED],
  [CaceState.READY_FOR_EFFECT]: [CaceState.COMMITTING, CaceState.STALE, CaceState.REJECTED],
  [CaceState.COMMITTING]: [CaceState.COMMITTED, CaceState.STALE, CaceState.REJECTED],
  [CaceState.COMMITTED]: [CaceState.COMMITTED],
  [CaceState.STALE]: [CaceState.STALE],
  [CaceState.REJECTED]: [CaceState.REJECTED]
});

const RFRE_ALLOWED = Object.freeze({
  [RfreState.NONE]: [RfreState.NONE, RfreState.UNKNOWN, RfreState.NO_COMMIT, RfreState.PENDING],
  [RfreState.UNKNOWN]: [RfreState.UNKNOWN, RfreState.NO_COMMIT, RfreState.PENDING, RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, RfreState.STALE, RfreState.REVOKED, RfreState.CONFLICT],
  [RfreState.NO_COMMIT]: [RfreState.NO_COMMIT, RfreState.PENDING, RfreState.STALE, RfreState.REVOKED, RfreState.CONFLICT],
  [RfreState.PENDING]: [RfreState.PENDING, RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, RfreState.LOST_AFTER_COMMIT, RfreState.STALE, RfreState.REVOKED, RfreState.CONFLICT, RfreState.DUPLICATE],
  [RfreState.COMMITTED_UNFINALIZED]: [RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, RfreState.LOST_AFTER_COMMIT, RfreState.STALE, RfreState.REVOKED, RfreState.CONFLICT, RfreState.DUPLICATE],
  [RfreState.FINAL_VERIFIED]: [RfreState.FINAL_VERIFIED],
  [RfreState.LOST_AFTER_COMMIT]: [RfreState.LOST_AFTER_COMMIT, RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, RfreState.STALE, RfreState.REVOKED, RfreState.CONFLICT, RfreState.DUPLICATE],
  [RfreState.STALE]: [RfreState.STALE, RfreState.UNKNOWN, RfreState.NO_COMMIT, RfreState.PENDING, RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, RfreState.CONFLICT],
  [RfreState.REVOKED]: [RfreState.REVOKED],
  [RfreState.CONFLICT]: [RfreState.CONFLICT, RfreState.UNKNOWN, RfreState.NO_COMMIT, RfreState.PENDING, RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED],
  [RfreState.DUPLICATE]: [RfreState.DUPLICATE]
});

function advance(machine, current, next) {
  const allowed = machine[current];
  if (!allowed) throw new Error(`UNKNOWN_STATE:${current}`);
  if (!allowed.includes(next)) throw new Error(`ILLEGAL_STATE_TRANSITION:${current}->${next}`);
  return next;
}

export const advanceCace = (current, next) => advance(CACE_ALLOWED, current, next);
export const advanceRfre = (current, next, evidence = {}) => {
  if ([RfreState.NO_COMMIT, RfreState.FINAL_VERIFIED].includes(next) && evidence.authoritative !== true) {
    throw new Error(`MISSING_AUTHORITATIVE_EVIDENCE:${current}->${next}`);
  }
  return advance(RFRE_ALLOWED, current, next);
};

const effectfulKinds = new Set(['COMMIT', 'COMPENSATE']);
const known = value => value !== undefined && value !== null && value !== 'UNKNOWN';
const same = values => values.every(value => value === values[0]);
const array = value => Array.isArray(value) ? value : [];
const isEffectful = action => effectfulKinds.has(action.kind)
  || Number(action.effectDelta ?? 0) > 0
  || array(action.writeSet).length > 0;

const result = (obligationId, verdict, code, expected, actual, evidenceRefs = []) => ({
  obligationId,
  verdict,
  code,
  expected,
  actual,
  evidenceRefs
});

function requireKnown(obligationId, values, code, evidenceRefs = []) {
  const missing = Object.entries(values).filter(([, value]) => !known(value)).map(([key]) => key);
  return missing.length
    ? result(obligationId, Verdict.UNKNOWN, code, Object.keys(values), {missing}, evidenceRefs)
    : null;
}

function validateAction(action) {
  const problems = [];
  if (!known(action?.kind)) problems.push('kind');
  if (action?.kind === 'COMMIT') {
    for (const field of ['intentId', 'effectId', 'idempotenceKey', 'expectedVersionFence']) {
      if (!known(action[field])) problems.push(field);
    }
    if (!Array.isArray(action.requiredScopes)) problems.push('requiredScopes');
    if (!Number.isInteger(action.effectDelta) || action.effectDelta <= 0) problems.push('positiveIntegerEffectDelta');
  }
  if (action?.kind === 'COMPENSATE') {
    if (!action.compensationContract || !action.compensationSnapshot || !action.compensationAction) problems.push('COMPENSATION_REQUIRES_TYPED_FORWARD_EFFECT');
    if (action.compensationAction?.kind === 'COMPENSATE') problems.push('NESTED_COMPENSATION_UNSUPPORTED');
  }
  if (action?.kind === 'RECONCILE' && (Number(action.effectDelta ?? 0) !== 0 || array(action.writeSet).length)) {
    problems.push('RECONCILE_MUST_BE_READ_ONLY');
  }
  if (action?.kind === 'RECONCILE' && action.terminal === true) problems.push('RECONCILE_CANNOT_BE_TERMINAL');
  if (action?.kind === 'CLAIM_SUCCESS' && action.claimSuccess !== true) problems.push('claimSuccess');
  const contradiction = problems.includes('RECONCILE_MUST_BE_READ_ONLY') || problems.includes('RECONCILE_CANNOT_BE_TERMINAL');
  return problems.length
    ? result('ACTION_TYPED', contradiction ? Verdict.VIOLATED : Verdict.UNKNOWN, contradiction ? 'ACTION_KIND_EFFECT_CONTRADICTION' : 'ACTION_SCHEMA_INVALID_OR_INCOMPLETE', 'typed action', {problems}, ['action'])
    : null;
}

function evaluateAuthority(contract, snapshot, action) {
  const values = {
    expectedProfile: contract.authority?.browserProfile,
    sessionProfile: snapshot.session?.browserProfile,
    envelopeProfile: snapshot.envelope?.browserProfile,
    expectedSessionEpoch: contract.authority?.sessionEpoch,
    sessionEpoch: snapshot.session?.epoch,
    envelopeSessionEpoch: snapshot.envelope?.sessionEpoch,
    expectedIssuer: contract.authority?.oauthIssuer,
    oauthIssuer: snapshot.oauth?.issuer,
    envelopeIssuer: snapshot.envelope?.oauthIssuer,
    expectedSubject: contract.authority?.oauthSubject,
    oauthSubject: snapshot.oauth?.subject,
    envelopeSubject: snapshot.envelope?.oauthSubject,
    expectedAudience: contract.authority?.audience,
    oauthAudience: snapshot.oauth?.audience,
    envelopeAudience: snapshot.envelope?.audience,
    expectedOauthEpoch: contract.authority?.oauthEpoch,
    oauthEpoch: snapshot.oauth?.epoch,
    envelopeOauthEpoch: snapshot.envelope?.oauthEpoch,
    oauthValidUntil: snapshot.oauth?.validUntil,
    evaluationTime: snapshot.now
  };
  const unknown = requireKnown('AUTH_CONTINUOUS', values, 'AUTHORITY_EVIDENCE_MISSING', ['session', 'oauth', 'envelope']);
  if (unknown) return unknown;
  const groups = [
    [values.expectedProfile, values.sessionProfile, values.envelopeProfile],
    [values.expectedSessionEpoch, values.sessionEpoch, values.envelopeSessionEpoch],
    [values.expectedIssuer, values.oauthIssuer, values.envelopeIssuer],
    [values.expectedSubject, values.oauthSubject, values.envelopeSubject],
    [values.expectedAudience, values.oauthAudience, values.envelopeAudience],
    [values.expectedOauthEpoch, values.oauthEpoch, values.envelopeOauthEpoch]
  ];
  if (groups.some(group => !same(group))) {
    return result('AUTH_CONTINUOUS', Verdict.VIOLATED, 'AUTHORITY_CHAIN_MISMATCH', contract.authority, values, ['session', 'oauth', 'envelope']);
  }
  if (snapshot.oauth.validUntil < snapshot.now) {
    return result('AUTH_CONTINUOUS', Verdict.VIOLATED, 'OAUTH_EXPIRED', {validAfter: snapshot.now}, snapshot.oauth.validUntil, ['oauth']);
  }
  const scopes = new Set(array(snapshot.oauth?.scopeSet));
  const missingScopes = array(action.requiredScopes).filter(scope => !scopes.has(scope));
  if (missingScopes.length) {
    return result('AUTH_CONTINUOUS', Verdict.VIOLATED, 'REQUIRED_SCOPE_MISSING', action.requiredScopes, {missingScopes}, ['oauth']);
  }
  return result('AUTH_CONTINUOUS', Verdict.SAFE, 'AUTHORITY_CHAIN_CONTINUOUS', contract.authority, values, ['session', 'oauth', 'envelope']);
}

function evaluateTenant(contract, snapshot) {
  const values = {
    expectedTenant: contract.tenantId,
    sessionTenant: snapshot.session?.tenantId,
    oauthTenant: snapshot.oauth?.tenantId,
    envelopeTenant: snapshot.envelope?.tenantId,
    resourceTenant: snapshot.resource?.tenantId
  };
  const unknown = requireKnown('TENANT_BOUND', values, 'TENANT_EVIDENCE_MISSING', ['session', 'oauth', 'envelope', 'resource']);
  if (unknown) return unknown;
  return same(Object.values(values))
    ? result('TENANT_BOUND', Verdict.SAFE, 'TENANT_CHAIN_BOUND', contract.tenantId, values, ['session', 'oauth', 'envelope', 'resource'])
    : result('TENANT_BOUND', Verdict.VIOLATED, 'CROSS_TENANT_BINDING', contract.tenantId, values, ['session', 'oauth', 'envelope', 'resource']);
}

function evaluateVersion(contract, snapshot, action) {
  if (!isEffectful(action)) {
    return result('VERSION_FRESH', Verdict.SAFE, 'NO_EFFECT_VERSION_FENCE_NOT_CONSUMED', null, null, []);
  }
  const values = {
    expectedApiOrigin: contract.api?.origin,
    resourceApiOrigin: snapshot.resource?.apiOrigin,
    envelopeApiOrigin: snapshot.envelope?.apiOrigin,
    expectedApiVersion: contract.api?.version,
    resourceApiVersion: snapshot.resource?.apiVersion,
    envelopeApiVersion: snapshot.envelope?.apiVersion,
    resourceFence: snapshot.resource?.versionFence,
    envelopeFence: snapshot.envelope?.versionFence,
    actionFence: action.expectedVersionFence
  };
  const unknown = requireKnown('VERSION_FRESH', values, 'VERSION_EVIDENCE_MISSING', ['resource', 'envelope', 'action']);
  if (unknown) return unknown;
  const coherent = same([values.expectedApiOrigin, values.resourceApiOrigin, values.envelopeApiOrigin])
    && same([values.expectedApiVersion, values.resourceApiVersion, values.envelopeApiVersion])
    && same([values.resourceFence, values.envelopeFence, values.actionFence]);
  return coherent
    ? result('VERSION_FRESH', Verdict.SAFE, 'VERSION_FENCE_CURRENT', {origin: contract.api.origin, version: contract.api.version, fence: values.resourceFence}, values, ['resource', 'envelope', 'action'])
    : result('VERSION_FRESH', Verdict.VIOLATED, 'STALE_OR_MISMATCHED_VERSION_FENCE', {origin: contract.api.origin, version: contract.api.version, fence: values.resourceFence}, values, ['resource', 'envelope', 'action']);
}

function evaluateIdempotence(contract, snapshot, action) {
  if (!isEffectful(action)) {
    return result('IDEM_UNIQUE', Verdict.SAFE, 'NO_NEW_EFFECT_IDEMPOTENCE_NOT_CONSUMED', null, null, []);
  }
  const values = {
    contractIntent: contract.intentId,
    envelopeIntent: snapshot.envelope?.intentId,
    actionIntent: action.intentId,
    contractEffect: contract.effectId,
    envelopeEffect: snapshot.envelope?.effectId,
    actionEffect: action.effectId,
    envelopeKey: snapshot.envelope?.idempotenceKey,
    actionKey: action.idempotenceKey,
    registryKey: snapshot.idempotency?.key,
    registryStatus: snapshot.idempotency?.status,
    registryIntent: snapshot.idempotency?.intentId,
    registryEffect: snapshot.idempotency?.effectId,
    registryTenant: snapshot.idempotency?.tenantId
  };
  const unknown = requireKnown('IDEM_UNIQUE', values, 'IDEMPOTENCE_EVIDENCE_MISSING', ['envelope', 'idempotency', 'action']);
  if (unknown) return unknown;
  if (!same([values.contractIntent, values.envelopeIntent, values.actionIntent])
      || !same([values.contractEffect, values.envelopeEffect, values.actionEffect])
      || !same([values.envelopeKey, values.actionKey, values.registryKey])) {
    return result('IDEM_UNIQUE', Verdict.VIOLATED, 'INTENT_EFFECT_KEY_LINEAGE_MISMATCH', {intentId: contract.intentId, effectId: contract.effectId}, values, ['envelope', 'idempotency', 'action']);
  }
  if (values.registryIntent !== contract.intentId || values.registryEffect !== contract.effectId || values.registryTenant !== contract.tenantId) {
    return result('IDEM_UNIQUE', Verdict.VIOLATED, 'IDEMPOTENCY_REGISTRY_BINDING_MISMATCH', {intentId: contract.intentId, effectId: contract.effectId, tenantId: contract.tenantId}, values, ['idempotency']);
  }
  if (['USED_OTHER_INTENT', 'COMMITTED_SAME_EFFECT', 'DUPLICATE'].includes(values.registryStatus)) {
    return result('IDEM_UNIQUE', Verdict.VIOLATED, 'IDEMPOTENCE_KEY_ALREADY_CONSUMED', ['UNUSED', 'RESERVED_SAME_INTENT'], values.registryStatus, ['idempotency']);
  }
  if (!['UNUSED', 'RESERVED_SAME_INTENT'].includes(values.registryStatus)) {
    return result('IDEM_UNIQUE', Verdict.UNKNOWN, 'IDEMPOTENCE_REGISTRY_INDETERMINATE', ['UNUSED', 'RESERVED_SAME_INTENT'], values.registryStatus, ['idempotency']);
  }
  return result('IDEM_UNIQUE', Verdict.SAFE, 'IDEMPOTENCE_KEY_AVAILABLE_FOR_INTENT', {intentId: contract.intentId, effectId: contract.effectId}, values, ['idempotency']);
}

function evaluateAdmissionToken(contract, snapshot, action) {
  if (!isEffectful(action)) return result('ADMISSION_TOKEN_FRESH', Verdict.SAFE, 'NO_EFFECT_TOKEN_NOT_CONSUMED', null, null, []);
  const token = snapshot.admissionToken ?? {};
  const values = {
    caceState: snapshot.caceState,
    expectedTokenId: contract.admission?.tokenId,
    tokenId: token.tokenId,
    actionTokenId: action.admissionTokenId,
    expectedBindingDigest: contract.admission?.bindingDigest,
    tokenBindingDigest: token.bindingDigest,
    actionBindingDigest: action.bindingDigest,
    expectedNonce: contract.admission?.nonce,
    tokenNonce: token.nonce,
    actionNonce: action.admissionNonce,
    authoritative: token.authoritative,
    signatureVerified: token.signatureVerified,
    expiresAt: token.expiresAt,
    now: snapshot.now,
    consumed: token.consumed
  };
  const unknown = requireKnown('ADMISSION_TOKEN_FRESH', values, 'ADMISSION_TOKEN_EVIDENCE_MISSING', ['admission-token']);
  if (unknown) return unknown;
  if (values.caceState !== CaceState.READY_FOR_EFFECT) {
    return result('ADMISSION_TOKEN_FRESH', Verdict.VIOLATED, 'CACE_NOT_READY_FOR_EFFECT', CaceState.READY_FOR_EFFECT, values.caceState, ['admission-token']);
  }
  if (values.authoritative !== true || values.signatureVerified !== true) {
    return result('ADMISSION_TOKEN_FRESH', Verdict.UNKNOWN, 'ADMISSION_TOKEN_UNVERIFIED', true, {authoritative: values.authoritative, signatureVerified: values.signatureVerified}, ['admission-token']);
  }
  if (values.consumed === true) return result('ADMISSION_TOKEN_FRESH', Verdict.VIOLATED, 'ADMISSION_TOKEN_REPLAYED', false, true, ['admission-token']);
  if (values.expiresAt < values.now) return result('ADMISSION_TOKEN_FRESH', Verdict.VIOLATED, 'ADMISSION_TOKEN_EXPIRED', {freshAt: values.now}, values.expiresAt, ['admission-token']);
  const bound = same([values.expectedTokenId, values.tokenId, values.actionTokenId])
    && same([values.expectedBindingDigest, values.tokenBindingDigest, values.actionBindingDigest])
    && same([values.expectedNonce, values.tokenNonce, values.actionNonce]);
  return bound
    ? result('ADMISSION_TOKEN_FRESH', Verdict.SAFE, 'ADMISSION_TOKEN_BOUND_UNCONSUMED', contract.admission, values, ['admission-token'])
    : result('ADMISSION_TOKEN_FRESH', Verdict.VIOLATED, 'ADMISSION_TOKEN_BINDING_MISMATCH', contract.admission, values, ['admission-token']);
}

function evaluateCardinality(contract, snapshot, action) {
  const current = snapshot.effect?.cardinality;
  const delta = action.effectDelta ?? 0;
  if (!known(current)) {
    return result('EFFECT_CARDINALITY_WITHIN_BOUND', Verdict.UNKNOWN, 'EFFECT_CARDINALITY_UNKNOWN', {min: contract.effect.minCardinality, max: contract.effect.maxCardinality}, current, ['effect-ledger']);
  }
  if (!Number.isInteger(current) || !Number.isInteger(delta) || current < 0 || delta < 0) {
    return result('EFFECT_CARDINALITY_WITHIN_BOUND', Verdict.UNKNOWN, 'EFFECT_CARDINALITY_NOT_A_NONNEGATIVE_INTEGER', 'nonnegative integers', {current, delta}, ['effect-ledger', 'action']);
  }
  const projected = current + delta;
  const within = projected >= 0 && projected <= contract.effect.maxCardinality;
  const terminalGoalMet = !action.terminal || projected >= contract.effect.minCardinality;
  return within && terminalGoalMet
    ? result('EFFECT_CARDINALITY_WITHIN_BOUND', Verdict.SAFE, 'EFFECT_CARDINALITY_IN_RANGE', {min: contract.effect.minCardinality, max: contract.effect.maxCardinality}, {current, delta, projected}, ['effect-ledger', 'action'])
    : result('EFFECT_CARDINALITY_WITHIN_BOUND', Verdict.VIOLATED, within ? 'TERMINAL_EFFECT_REQUIREMENT_MISSING' : 'EFFECT_CARDINALITY_EXCEEDED', {min: contract.effect.minCardinality, max: contract.effect.maxCardinality}, {current, delta, projected}, ['effect-ledger', 'action']);
}

function receiptCoherent(contract, snapshot, action) {
  const receipt = snapshot.receipt ?? {};
  const required = {
    authoritative: receipt.authoritative,
    intentId: receipt.intentId,
    effectId: receipt.effectId,
    idempotenceKey: receipt.idempotenceKey,
    tenantId: receipt.tenantId,
    sinkId: receipt.sinkId,
    issuer: receipt.issuer,
    signatureVerified: receipt.signatureVerified,
    sinkGeneration: receipt.sinkGeneration,
    commitIndex: receipt.commitIndex,
    versionFence: receipt.versionFence,
    issuedAt: receipt.issuedAt,
    freshUntil: receipt.freshUntil,
    now: snapshot.now,
    trustedClock: snapshot.clock?.trusted,
    ledgerGeneration: snapshot.effect?.sinkGeneration,
    ledgerHighWatermark: snapshot.effect?.commitHighWatermark
  };
  const unknown = requireKnown('RECEIPT_POLICY_SATISFIED', required, 'RECEIPT_EVIDENCE_MISSING', ['receipt']);
  if (unknown) return unknown;
  if (receipt.authoritative !== true) {
    return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'RECEIPT_NOT_AUTHORITATIVE', true, receipt.authoritative, ['receipt']);
  }
  if (receipt.signatureVerified !== true) {
    return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'RECEIPT_SIGNATURE_UNVERIFIED', true, receipt.signatureVerified, ['receipt']);
  }
  if (snapshot.clock.trusted !== true || receipt.issuedAt > snapshot.now || receipt.freshUntil < snapshot.now) {
    return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'RECEIPT_STALE', {freshAt: snapshot.now}, receipt.freshUntil, ['receipt']);
  }
  const expectedKey = action.idempotenceKey ?? snapshot.envelope?.idempotenceKey;
  const coherent = receipt.intentId === contract.intentId
    && receipt.effectId === contract.effectId
    && receipt.idempotenceKey === expectedKey
    && receipt.tenantId === contract.tenantId
    && receipt.sinkId === contract.sink?.id
    && receipt.issuer === contract.sink?.issuer
    && receipt.versionFence === snapshot.envelope?.versionFence
    && receipt.sinkGeneration === snapshot.effect?.sinkGeneration
    && receipt.commitIndex >= snapshot.effect?.commitHighWatermark;
  return coherent
    ? null
    : result('RECEIPT_POLICY_SATISFIED', Verdict.VIOLATED, 'RECEIPT_EFFECT_BINDING_MISMATCH', {intentId: contract.intentId, effectId: contract.effectId, idempotenceKey: expectedKey, tenantId: contract.tenantId}, receipt, ['receipt']);
}

function evaluateReceipt(contract, snapshot, action) {
  const state = snapshot.receipt?.state ?? RfreState.UNKNOWN;
  if (action.kind === 'RECONCILE' && isEffectful(action)) {
    return result('RECEIPT_POLICY_SATISFIED', Verdict.VIOLATED, 'RECONCILE_CANNOT_ADMIT_EFFECT', 0, action.effectDelta ?? action.writeSet, ['action']);
  }
  if (action.kind === 'RECONCILE' && !action.claimSuccess) {
    return result('RECEIPT_POLICY_SATISFIED', Verdict.SAFE, 'RECONCILIATION_DOES_NOT_ASSERT_FINALITY', null, state, ['receipt']);
  }
  if (action.kind === 'CLAIM_SUCCESS' || action.claimSuccess) {
    const coherent = receiptCoherent(contract, snapshot, action);
    if (coherent) return coherent;
    if (state === RfreState.FINAL_VERIFIED) {
      return result('RECEIPT_POLICY_SATISFIED', Verdict.SAFE, 'FINAL_RECEIPT_VERIFIED', RfreState.FINAL_VERIFIED, state, ['receipt']);
    }
    if (state === RfreState.NO_COMMIT) {
      return result('RECEIPT_POLICY_SATISFIED', Verdict.VIOLATED, 'FALSE_SUCCESS_NO_COMMIT', RfreState.FINAL_VERIFIED, state, ['receipt']);
    }
    return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'FINALITY_NOT_ESTABLISHED', RfreState.FINAL_VERIFIED, state, ['receipt']);
  }
  if (action.kind === 'COMMIT' && action.retry === true) {
    const coherent = receiptCoherent(contract, snapshot, action);
    if (coherent) return coherent;
    if (state === RfreState.NO_COMMIT) {
      return result('RECEIPT_POLICY_SATISFIED', Verdict.SAFE, 'AUTHORITATIVE_NO_COMMIT_ALLOWS_SAME_KEY_RETRY', RfreState.NO_COMMIT, state, ['receipt']);
    }
    if ([RfreState.PENDING, RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, RfreState.LOST_AFTER_COMMIT, RfreState.DUPLICATE].includes(state)) {
      return result('RECEIPT_POLICY_SATISFIED', Verdict.VIOLATED, 'RETRY_AFTER_POSSIBLE_OR_KNOWN_COMMIT', RfreState.NO_COMMIT, state, ['receipt']);
    }
    return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'RETRY_REQUIRES_FRESH_AUTHORITATIVE_NO_COMMIT', RfreState.NO_COMMIT, state, ['receipt']);
  }
  if (action.kind === 'COMMIT') {
    if (state === RfreState.NONE) {
      return result('RECEIPT_POLICY_SATISFIED', Verdict.SAFE, 'FIRST_ATTEMPT_HAS_NO_PRIOR_RECEIPT', RfreState.NONE, state, ['receipt']);
    }
    if ([RfreState.PENDING, RfreState.COMMITTED_UNFINALIZED, RfreState.FINAL_VERIFIED, RfreState.LOST_AFTER_COMMIT, RfreState.DUPLICATE].includes(state)) {
      return result('RECEIPT_POLICY_SATISFIED', Verdict.VIOLATED, 'NEW_COMMIT_WITH_PRIOR_EFFECT_EVIDENCE', RfreState.NONE, state, ['receipt']);
    }
    return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'PRIOR_EFFECT_STATUS_INDETERMINATE', RfreState.NONE, state, ['receipt']);
  }
  if (action.kind === 'COMPENSATE') return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'COMPENSATION_EVALUATED_AS_SEPARATE_FORWARD_EFFECT', null, null, ['action']);
  return result('RECEIPT_POLICY_SATISFIED', Verdict.UNKNOWN, 'ACTION_RECEIPT_SEMANTICS_UNDECLARED', null, action.kind, ['action']);
}

export function evaluateWebAction(contract, snapshot, action) {
  if (action.kind === 'ABSTAIN') {
    return {
      disposition: Verdict.UNKNOWN,
      policyDecision: 'ABSTAIN',
      obligations: [],
      historicalViolationsPreserved: true,
      reason: 'NO_EFFECT_ADMITTED'
    };
  }
  const actionType = validateAction(action);
  if (actionType) {
    return {
      disposition: actionType.verdict,
      terminalDisposition: actionType.verdict,
      policyDecision: 'ABSTAIN',
      obligations: [actionType],
      historicalViolationsPreserved: true,
      witnessObligations: ['ACTION_TYPED']
    };
  }
  if (action.kind === 'COMPENSATE') {
    const forward = evaluateWebAction(action.compensationContract, action.compensationSnapshot, action.compensationAction);
    return {
      ...forward,
      compensationOf: contract.effectId,
      forwardEffectId: action.compensationContract.effectId,
      historicalViolationsPreserved: true
    };
  }
  const obligations = [
    evaluateAuthority(contract, snapshot, action),
    evaluateTenant(contract, snapshot),
    evaluateVersion(contract, snapshot, action),
    evaluateIdempotence(contract, snapshot, action),
    evaluateAdmissionToken(contract, snapshot, action),
    evaluateCardinality(contract, snapshot, action),
    evaluateReceipt(contract, snapshot, action)
  ];
  const disposition = obligations.some(item => item.verdict === Verdict.VIOLATED)
    ? Verdict.VIOLATED
    : obligations.some(item => item.verdict === Verdict.UNKNOWN)
      ? Verdict.UNKNOWN
      : Verdict.SAFE;
  return {
    disposition,
    terminalDisposition: action.kind === 'CLAIM_SUCCESS' ? disposition : Verdict.UNKNOWN,
    policyDecision: disposition === Verdict.SAFE ? 'ADMIT' : 'ABSTAIN',
    obligations,
    historicalViolationsPreserved: true,
    witnessObligations: obligations.filter(item => item.verdict !== Verdict.SAFE).map(item => item.obligationId)
  };
}

export function evaluateBelief(contract, worlds, action) {
  const byWorld = worlds.map(world => ({worldId: world.id, evaluation: evaluateWebAction(contract, world.snapshot, action)}));
  const disposition = byWorld.some(item => item.evaluation.disposition === Verdict.VIOLATED)
    ? Verdict.VIOLATED
    : byWorld.some(item => item.evaluation.disposition === Verdict.UNKNOWN)
      ? Verdict.UNKNOWN
      : Verdict.SAFE;
  return {disposition, byWorld};
}
