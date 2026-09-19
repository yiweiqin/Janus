/*
 * Research-only atomic transition model for CPIR-Web admission/finality.
 * It is an executable finite-state specification, not a Janus runtime adapter.
 */
import {createHash} from 'node:crypto';

const clone = value => structuredClone(value);
const known = value => value !== undefined && value !== null && value !== 'UNKNOWN';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function makeSinkState(overrides = {}) {
  return {
    sinkId: 'sink-default',
    issuer: 'sink-authority.example',
    sinkGeneration: 1,
    commitIndex: 0,
    bindingRevision: 1,
    stateRevision: 0,
    tenantId: 'tenant-default',
    tenantRevision: 1,
    browserProfile: 'profile-default',
    sessionEpoch: 1,
    oauthIssuer: 'https://issuer.example',
    oauthSubject: 'subject-default',
    oauthAudience: 'api-default',
    scopeDigest: 'scope-default',
    oauthEpoch: 1,
    apiOrigin: 'https://api.example',
    apiVersion: 'v1',
    versionFence: 'fence-1',
    bootEpoch: 1,
    keyRegistry: {},
    tokenRegistry: {},
    contractRegistry: {},
    effectCardinality: {},
    receiptLedger: [],
    ...clone(overrides)
  };
}

const identityFields = [
  'intentId', 'effectId', 'tenantId', 'tenantRevision', 'browserProfile', 'sessionEpoch',
  'oauthIssuer', 'oauthSubject', 'oauthAudience', 'scopeDigest', 'oauthEpoch',
  'apiOrigin', 'apiVersion', 'versionFence', 'idempotenceKey'
];

function missingFields(value, fields) {
  return fields.filter(field => !known(value?.[field]));
}

function reject(state, reasonCode, witness = {}) {
  return {outcome: 'REJECTED', reasonCode, witness, state};
}

function unknown(state, reasonCode, witness = {}) {
  return {outcome: 'UNKNOWN', reasonCode, witness, state};
}

function bindingMismatch(state, value) {
  return identityFields
    .filter(field => !['intentId', 'effectId', 'idempotenceKey'].includes(field))
    .filter(field => state[field] !== value[field]);
}

function tokenMaterial(request, state) {
  return {
    tokenId: request.tokenId,
    nonce: request.nonce,
    intentId: request.intentId,
    effectId: request.effectId,
    tenantId: request.tenantId,
    tenantRevision: request.tenantRevision,
    browserProfile: request.browserProfile,
    sessionEpoch: request.sessionEpoch,
    oauthIssuer: request.oauthIssuer,
    oauthSubject: request.oauthSubject,
    oauthAudience: request.oauthAudience,
    scopeDigest: request.scopeDigest,
    oauthEpoch: request.oauthEpoch,
    apiOrigin: request.apiOrigin,
    apiVersion: request.apiVersion,
    versionFence: request.versionFence,
    idempotenceKey: request.idempotenceKey,
    contractId: request.contractId,
    contractDigest: request.contractDigest,
    bindingRevision: state.bindingRevision,
    stateRevision: state.stateRevision,
    bootEpoch: state.bootEpoch,
    sinkId: state.sinkId,
    sinkGeneration: state.sinkGeneration,
    issuedAt: request.now,
    expiresAt: request.expiresAt
  };
}

export function reserveAdmission(state, request) {
  const missing = missingFields(request, [...identityFields, 'tokenId', 'nonce', 'now', 'expiresAt', 'expectedStateRevision', 'contractId', 'contractDigest']);
  if (missing.length) return unknown(state, 'ADMISSION_REQUEST_INCOMPLETE', {missing});
  if (request.expectedStateRevision !== state.stateRevision) return reject(state, 'STATE_REVISION_STALE', {expected: request.expectedStateRevision, actual: state.stateRevision});
  if (request.expiresAt < request.now) return reject(state, 'ADMISSION_REQUEST_ALREADY_EXPIRED', {now: request.now, expiresAt: request.expiresAt});
  const contract = state.contractRegistry[request.contractId];
  if (!contract) return unknown(state, 'CONTRACT_NOT_REGISTERED', {contractId: request.contractId});
  if (contract.contractDigest !== request.contractDigest) return reject(state, 'CONTRACT_DIGEST_MISMATCH', {expected: contract.contractDigest, actual: request.contractDigest});
  if (contract.effectId !== request.effectId || contract.tenantId !== request.tenantId) return reject(state, 'CONTRACT_EFFECT_BINDING_MISMATCH', {contract, request});
  if (!Number.isInteger(contract.maxCardinality) || contract.maxCardinality < 1) return unknown(state, 'REGISTRY_MAX_CARDINALITY_INVALID', {contract});
  const mismatches = bindingMismatch(state, request);
  if (mismatches.length) return reject(state, 'ADMISSION_BINDING_MISMATCH', {mismatches});
  if (state.tokenRegistry[request.tokenId]) return reject(state, 'TOKEN_ID_ALREADY_EXISTS', {tokenId: request.tokenId});
  const key = state.keyRegistry[request.idempotenceKey];
  if (key) return reject(state, key.status === 'COMMITTED' ? 'IDEMPOTENCE_KEY_ALREADY_COMMITTED' : 'IDEMPOTENCE_KEY_ALREADY_RESERVED', {key});

  const material = tokenMaterial(request, state);
  const token = {...material, minCardinality: contract.minCardinality, maxCardinality: contract.maxCardinality, tokenHash: digest({...material, minCardinality: contract.minCardinality, maxCardinality: contract.maxCardinality}), status: 'RESERVED'};
  const next = clone(state);
  next.stateRevision += 1;
  next.tokenRegistry[token.tokenId] = token;
  next.keyRegistry[token.idempotenceKey] = {
    status: 'RESERVED', tokenId: token.tokenId, intentId: token.intentId,
    effectId: token.effectId, tenantId: token.tenantId, bindingRevision: token.bindingRevision
  };
  return {
    outcome: 'RESERVED',
    reasonCode: 'ATOMIC_KEY_RESERVATION_CREATED',
    state: next,
    token,
    witness: {preBindingRevision: state.bindingRevision, postBindingRevision: next.bindingRevision}
  };
}

function sameIdentity(left, right) {
  return identityFields.every(field => left[field] === right[field]);
}

export function consumeAdmission(state, suppliedToken, action, now) {
  const missingToken = missingFields(suppliedToken, [...identityFields, 'tokenId', 'nonce', 'bindingRevision', 'stateRevision', 'bootEpoch', 'sinkId', 'sinkGeneration', 'issuedAt', 'expiresAt', 'contractId', 'contractDigest', 'minCardinality', 'maxCardinality', 'tokenHash']);
  if (missingToken.length) return unknown(state, 'ADMISSION_TOKEN_INCOMPLETE', {missing: missingToken});
  const missingAction = missingFields(action, [...identityFields, 'contractId', 'contractDigest', 'expectedStateRevision']);
  if (missingAction.length) return unknown(state, 'EFFECT_ACTION_INCOMPLETE', {missing: missingAction});
  if (!known(now)) return unknown(state, 'CONSUME_TIME_MISSING');

  const stored = state.tokenRegistry[suppliedToken.tokenId];
  if (!stored) return reject(state, 'TOKEN_NOT_RESERVED', {tokenId: suppliedToken.tokenId});
  const expectedHash = digest(Object.fromEntries(Object.entries(stored).filter(([key]) => !['status', 'tokenHash', 'receiptId'].includes(key))));
  const suppliedHash = digest(Object.fromEntries(Object.entries(suppliedToken).filter(([key]) => !['status', 'tokenHash', 'receiptId'].includes(key))));
  if (suppliedToken.tokenHash !== suppliedHash || suppliedToken.tokenHash !== stored.tokenHash || stored.tokenHash !== expectedHash) {
    return reject(state, 'TOKEN_HASH_MISMATCH', {declared: suppliedToken.tokenHash, suppliedHash, stored: stored.tokenHash, expectedHash});
  }
  if (!sameIdentity(stored, action)) return reject(state, 'ACTION_TOKEN_IDENTITY_MISMATCH', {token: stored, action});
  if (stored.contractId !== action.contractId || stored.contractDigest !== action.contractDigest) return reject(state, 'ACTION_CONTRACT_BINDING_MISMATCH', {token: stored, action});
  if (stored.status === 'CONSUMED') {
    const receipt = state.receiptLedger.find(item => item.receiptId === stored.receiptId);
    return {outcome: 'NO_OP', reasonCode: 'TOKEN_ALREADY_CONSUMED', state, receipt, witness: {tokenId: stored.tokenId}};
  }
  if (action.expectedStateRevision !== state.stateRevision) return reject(state, 'STATE_REVISION_STALE', {expected: action.expectedStateRevision, actual: state.stateRevision});
  if (stored.status !== 'RESERVED') return reject(state, 'TOKEN_NOT_CONSUMABLE', {status: stored.status});
  if (now < stored.issuedAt || stored.expiresAt < now) return reject(state, 'TOKEN_OUTSIDE_VALID_TIME_WINDOW', {now, issuedAt: stored.issuedAt, expiresAt: stored.expiresAt});
  if (stored.bindingRevision !== state.bindingRevision) {
    return reject(state, 'BINDING_REVISION_CHANGED', {reservedAt: stored.bindingRevision, current: state.bindingRevision});
  }
  if (stored.stateRevision >= state.stateRevision || stored.bootEpoch !== state.bootEpoch || stored.sinkId !== state.sinkId || stored.sinkGeneration !== state.sinkGeneration) {
    return reject(state, 'TOKEN_SINK_EPOCH_OR_REVISION_CHANGED', {token: {stateRevision: stored.stateRevision, bootEpoch: stored.bootEpoch, sinkId: stored.sinkId, sinkGeneration: stored.sinkGeneration}, state: {stateRevision: state.stateRevision, bootEpoch: state.bootEpoch, sinkId: state.sinkId, sinkGeneration: state.sinkGeneration}});
  }
  const mismatches = bindingMismatch(state, stored);
  if (mismatches.length) return reject(state, 'SINK_BINDING_CHANGED', {mismatches});
  const contract = state.contractRegistry[stored.contractId];
  if (!contract || contract.contractDigest !== stored.contractDigest || contract.maxCardinality !== stored.maxCardinality) {
    return reject(state, 'LOCKED_CONTRACT_REGISTRY_MISMATCH', {contract, token: stored});
  }
  const key = state.keyRegistry[stored.idempotenceKey];
  if (!key || key.status !== 'RESERVED' || key.tokenId !== stored.tokenId) {
    return reject(state, 'KEY_RESERVATION_LOST', {key});
  }
  const cardinality = state.effectCardinality[stored.effectId] ?? 0;
  if (cardinality + 1 > stored.maxCardinality) {
    return reject(state, 'EFFECT_CARDINALITY_WOULD_EXCEED_BOUND', {cardinality, maxCardinality: stored.maxCardinality});
  }

  const next = clone(state);
  next.stateRevision += 1;
  next.commitIndex += 1;
  next.effectCardinality[stored.effectId] = cardinality + 1;
  const receiptId = `receipt:${next.sinkGeneration}:${next.commitIndex}`;
  const receipt = {
    receiptId,
    state: 'COMMITTED_UNFINALIZED',
    sinkId: next.sinkId,
    issuer: next.issuer,
    sinkGeneration: next.sinkGeneration,
    commitIndex: next.commitIndex,
    tokenHash: stored.tokenHash,
    intentId: stored.intentId,
    effectId: stored.effectId,
    tenantId: stored.tenantId,
    versionFence: stored.versionFence,
    idempotenceKey: stored.idempotenceKey,
    cardinalityAfter: next.effectCardinality[stored.effectId],
    issuedAt: stored.issuedAt,
    committedAt: now,
    bootEpoch: next.bootEpoch
  };
  next.receiptLedger.push(receipt);
  next.tokenRegistry[stored.tokenId] = {...stored, status: 'CONSUMED', receiptId};
  next.keyRegistry[stored.idempotenceKey] = {...key, status: 'COMMITTED', receiptId, commitIndex: next.commitIndex};
  return {
    outcome: 'COMMITTED',
    reasonCode: 'TOKEN_ATOMICALLY_CONSUMED',
    state: next,
    receipt,
    witness: {tokenHash: stored.tokenHash, bindingRevision: stored.bindingRevision, commitIndex: next.commitIndex}
  };
}

export function finalizeReceipt(state, receiptId, evidence) {
  const index = state.receiptLedger.findIndex(item => item.receiptId === receiptId);
  if (index < 0) return unknown(state, 'RECEIPT_NOT_FOUND', {receiptId});
  const receipt = state.receiptLedger[index];
  if (receipt.state === 'FINAL_VERIFIED') return {outcome: 'NO_OP', reasonCode: 'RECEIPT_ALREADY_FINAL', state, receipt};
  if (receipt.state !== 'COMMITTED_UNFINALIZED') return reject(state, 'RECEIPT_NOT_PENDING_FINALITY', {state: receipt.state});
  const missing = missingFields(evidence, ['authoritative', 'signatureVerified', 'sinkGeneration', 'commitIndex', 'tokenHash', 'verifiedAt', 'expectedStateRevision', 'trustedClock']);
  if (missing.length) return unknown(state, 'FINALITY_EVIDENCE_INCOMPLETE', {missing});
  if (evidence.expectedStateRevision !== state.stateRevision) return reject(state, 'STATE_REVISION_STALE', {expected: evidence.expectedStateRevision, actual: state.stateRevision});
  const token = Object.values(state.tokenRegistry).find(item => item.receiptId === receipt.receiptId);
  const coherent = evidence.authoritative === true
    && evidence.signatureVerified === true
    && evidence.trustedClock === true
    && token?.status === 'CONSUMED'
    && token?.receiptId === receipt.receiptId
    && evidence.sinkGeneration === receipt.sinkGeneration
    && evidence.commitIndex === receipt.commitIndex
    && evidence.tokenHash === receipt.tokenHash
    && evidence.verifiedAt >= receipt.committedAt
    && evidence.verifiedAt >= receipt.issuedAt;
  if (!coherent) return reject(state, 'FINALITY_EVIDENCE_MISMATCH', {receipt, evidence});
  const next = clone(state);
  next.stateRevision += 1;
  next.receiptLedger[index] = {...receipt, state: 'FINAL_VERIFIED', verifiedAt: evidence.verifiedAt};
  return {outcome: 'FINAL_VERIFIED', reasonCode: 'AUTHORITATIVE_FINALITY_BOUND', state: next, receipt: next.receiptLedger[index]};
}

export function mutateBinding(state, patch, reason = 'ENVIRONMENT_STEP') {
  const next = clone(state);
  for (const field of ['tenantRevision', 'sessionEpoch', 'oauthEpoch', 'sinkGeneration', 'bootEpoch']) {
    if (Object.hasOwn(patch, field) && patch[field] < state[field]) throw new Error(`NON_MONOTONIC_EPOCH:${field}`);
  }
  for (const field of ['tenantId', 'tenantRevision', 'browserProfile', 'sessionEpoch', 'oauthIssuer', 'oauthSubject', 'oauthAudience', 'scopeDigest', 'oauthEpoch', 'apiOrigin', 'apiVersion', 'versionFence', 'sinkGeneration', 'bootEpoch']) {
    if (Object.hasOwn(patch, field)) next[field] = patch[field];
  }
  next.bindingRevision += 1;
  next.stateRevision += 1;
  next.lastBindingMutation = {reason, revision: next.bindingRevision};
  return next;
}

export function createAtomicSinkStore(initialState) {
  let current = clone(initialState);
  return {
    snapshot: () => clone(current),
    reserve: request => {
      const result = reserveAdmission(current, request);
      if (result.outcome === 'RESERVED') current = result.state;
      return result;
    },
    consume: (token, action, now) => {
      const result = consumeAdmission(current, token, action, now);
      if (result.outcome === 'COMMITTED') current = result.state;
      return result;
    },
    finalize: (receiptId, evidence) => {
      const result = finalizeReceipt(current, receiptId, evidence);
      if (result.outcome === 'FINAL_VERIFIED') current = result.state;
      return result;
    },
    mutate: (patch, reason) => {
      current = mutateBinding(current, patch, reason);
      return clone(current);
    }
  };
}

export function auditSinkState(state) {
  const violations = [];
  const receiptIds = new Set();
  const tokenHashes = new Set();
  const commitIndices = new Set();
  const receiptCountByEffect = new Map();

  for (const receipt of state.receiptLedger) {
    if (!['COMMITTED_UNFINALIZED', 'FINAL_VERIFIED'].includes(receipt.state)) violations.push({code: 'RECEIPT_STATE_INVALID_OR_FORGED', receiptId: receipt.receiptId, state: receipt.state});
    if (receiptIds.has(receipt.receiptId)) violations.push({code: 'DUPLICATE_RECEIPT_ID', receiptId: receipt.receiptId});
    receiptIds.add(receipt.receiptId);
    if (commitIndices.has(receipt.commitIndex)) violations.push({code: 'DUPLICATE_COMMIT_INDEX', commitIndex: receipt.commitIndex});
    commitIndices.add(receipt.commitIndex);
    if (tokenHashes.has(receipt.tokenHash)) violations.push({code: 'DUPLICATE_TOKEN_HASH', receiptId: receipt.receiptId});
    tokenHashes.add(receipt.tokenHash);
    receiptCountByEffect.set(receipt.effectId, (receiptCountByEffect.get(receipt.effectId) ?? 0) + 1);
    const token = Object.values(state.tokenRegistry).find(item => item.tokenHash === receipt.tokenHash);
    if (!token || token.status !== 'CONSUMED' || token.receiptId !== receipt.receiptId) {
      violations.push({code: 'RECEIPT_WITHOUT_CONSUMED_TOKEN', receiptId: receipt.receiptId});
    }
    if (token) {
      const expectedHash = digest(Object.fromEntries(Object.entries(token).filter(([key]) => !['status', 'tokenHash', 'receiptId'].includes(key))));
      if (expectedHash !== token.tokenHash) violations.push({code: 'TOKEN_HASH_NOT_REPRODUCIBLE', tokenId: token.tokenId});
      for (const field of ['intentId', 'effectId', 'tenantId', 'versionFence', 'idempotenceKey', 'sinkId', 'sinkGeneration', 'bootEpoch']) {
        if (receipt[field] !== token[field]) violations.push({code: 'RECEIPT_TOKEN_BINDING_MISMATCH', field, receiptId: receipt.receiptId});
      }
      const contract = state.contractRegistry[token.contractId];
      if (!contract || contract.contractDigest !== token.contractDigest || contract.effectId !== token.effectId || contract.tenantId !== token.tenantId || contract.maxCardinality !== token.maxCardinality) {
        violations.push({code: 'TOKEN_CONTRACT_REGISTRY_MISMATCH', tokenId: token.tokenId});
      }
      const priorCount = state.receiptLedger.filter(item => item.effectId === receipt.effectId && item.commitIndex <= receipt.commitIndex).length;
      if (receipt.cardinalityAfter !== priorCount) violations.push({code: 'RECEIPT_CARDINALITY_AFTER_MISMATCH', receiptId: receipt.receiptId, cardinalityAfter: receipt.cardinalityAfter, priorCount});
    }
  }

  for (const [keyValue, key] of Object.entries(state.keyRegistry)) {
    const token = state.tokenRegistry[key.tokenId];
    if (!token) {
      violations.push({code: 'KEY_WITHOUT_TOKEN', key: keyValue});
      continue;
    }
    if (token.idempotenceKey !== keyValue || token.intentId !== key.intentId || token.effectId !== key.effectId || token.tenantId !== key.tenantId) {
      violations.push({code: 'KEY_TOKEN_IDENTITY_MISMATCH', key: keyValue});
    }
    if (key.status === 'RESERVED' && token.status !== 'RESERVED') violations.push({code: 'RESERVED_KEY_TOKEN_STATUS_MISMATCH', key: keyValue});
    if (key.status === 'COMMITTED' && (token.status !== 'CONSUMED' || token.receiptId !== key.receiptId)) {
      violations.push({code: 'COMMITTED_KEY_TOKEN_STATUS_MISMATCH', key: keyValue});
    }
  }

  for (const [effectId, cardinality] of Object.entries(state.effectCardinality)) {
    if (cardinality !== (receiptCountByEffect.get(effectId) ?? 0)) {
      violations.push({code: 'CARDINALITY_RECEIPT_COUNT_MISMATCH', effectId, cardinality, receipts: receiptCountByEffect.get(effectId) ?? 0});
    }
  }
  const maxCommit = state.receiptLedger.reduce((max, receipt) => Math.max(max, receipt.commitIndex), 0);
  if (state.commitIndex !== maxCommit) violations.push({code: 'COMMIT_INDEX_HIGH_WATERMARK_MISMATCH', commitIndex: state.commitIndex, maxCommit});

  return {
    disposition: violations.length ? 'VIOLATED' : 'SAFE',
    stateHash: digest(state),
    violations
  };
}

export function step(state, event, registry = state.contractRegistry) {
  const preState = clone({...state, contractRegistry: registry});
  const preStateHash = digest(preState);
  let result;
  if (event.type === 'RESERVE') result = reserveAdmission(preState, {...event.request, expectedStateRevision: event.request.expectedStateRevision ?? preState.stateRevision});
  else if (event.type === 'CONSUME') result = consumeAdmission(preState, event.token, event.action, event.now);
  else if (event.type === 'FINALIZE') result = finalizeReceipt(preState, event.receiptId, event.evidence);
  else if (event.type === 'MUTATE_BINDING') {
    try { result = {outcome: 'APPLIED', reasonCode: event.reason ?? 'ENVIRONMENT_STEP', state: mutateBinding(preState, event.patch, event.reason)}; }
    catch (error) { result = reject(preState, error.message, {patch: event.patch}); }
  } else result = unknown(preState, 'EVENT_TYPE_UNDECLARED', {type: event.type});
  const nextState = result.state ?? preState;
  const postStateHash = digest(nextState);
  const transition = ['RESERVED', 'COMMITTED', 'FINAL_VERIFIED', 'APPLIED'].includes(result.outcome)
    ? 'APPLY'
    : result.outcome === 'NO_OP' ? 'STUTTER' : result.outcome;
  return {
    ...result,
    transition,
    preStateHash,
    postStateHash,
    stateRevision: {before: preState.stateRevision, after: nextState.stateRevision},
    linearizationWitness: transition === 'APPLY'
      ? {eventType: event.type, preStateHash, postStateHash, stateRevision: {before: preState.stateRevision, after: nextState.stateRevision}}
      : undefined
  };
}
