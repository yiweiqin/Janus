/*
 * Research-only adapter from the admission transition relation to the
 * conflict-registry evaluator interface.  It deliberately executes the
 * reserve -> consume -> finalize chain; callers cannot provide a safeByWorld
 * matrix.  This is a finite model adapter, not a Janus/uBuddy runtime hook.
 */
import {auditSinkState, digest, step} from './ubuddy-cpir-web-admission-transition-v0.mjs';

const clone = value => structuredClone(value);
const known = value => value !== undefined && value !== null && value !== 'UNKNOWN';

const obligationFor = reasonCode => {
  if (!known(reasonCode)) return 'ADMISSION_TRANSITION';
  if (/CONTRACT|REGISTRY/.test(reasonCode)) return 'CONTRACT_REGISTRY';
  if (/BINDING|EPOCH|FENCE|REVISION|SINK/.test(reasonCode)) return 'CACE_IL';
  if (/RECEIPT|FINALITY/.test(reasonCode)) return 'RFRE';
  if (/CARDINALITY/.test(reasonCode)) return 'EFFECT_CARDINALITY';
  if (/TOKEN|KEY|IDEMPOTENCE/.test(reasonCode)) return 'IDEM_UNIQUE';
  if (/AUDIT|LEDGER/.test(reasonCode)) return 'EFFECT_LEDGER_AUDIT';
  return 'ADMISSION_TRANSITION';
};

const failedObligation = (result, verdict) => ({
  obligationId: obligationFor(result.reasonCode),
  verdict,
  code: result.reasonCode,
  expected: null,
  actual: result.witness ?? null,
  evidenceRefs: ['admission-transition']
});

export function makeAdmissionPlan({id, request, action, finalityEvidence, finalize = true, revisionSource = 'PLAN_EVIDENCE'}) {
  return {id, request: clone(request), action: clone(action), finalityEvidence: clone(finalityEvidence), finalize, revisionSource};
}

function finalityEvidenceFor(receipt, state, overrides) {
  if (!overrides) return {};
  if (overrides.evidenceMode === 'BIND_OBSERVED_RECEIPT_TEST_ONLY') return {
    authoritative: overrides.authoritative,
    signatureVerified: overrides.signatureVerified,
    trustedClock: overrides.trustedClock,
    sinkGeneration: receipt.sinkGeneration,
    commitIndex: receipt.commitIndex,
    tokenHash: receipt.tokenHash,
    verifiedAt: Math.max(receipt.committedAt, receipt.issuedAt),
    expectedStateRevision: state.stateRevision,
    evidenceMode: overrides.evidenceMode
  };
  if (overrides.evidenceMode !== 'DECLARED_EXTERNAL') return {};
  return clone(overrides);
}

export function runAdmissionPlan(initialState, plan) {
  let state = clone(initialState);
  const trace = [];
  const initialAudit = auditSinkState(state);
  if (initialAudit.disposition === 'VIOLATED') {
    const preStateHash = digest(state);
    const rejectedInitial = {outcome: 'REJECTED', reasonCode: 'INITIAL_SINK_INVARIANT_AUDIT_FAILED', witness: {violations: initialAudit.violations}, state, preStateHash, postStateHash: preStateHash};
    return {state, trace: [rejectedInitial], terminal: false, final: rejectedInitial, audit: initialAudit};
  }
  if (!['PLAN_EVIDENCE', 'GATEWAY_AT_EVENT'].includes(plan.revisionSource)) {
    const preStateHash = digest(state);
    const unknownRevision = {outcome: 'UNKNOWN', reasonCode: 'EXPECTED_STATE_REVISION_SOURCE_UNDECLARED', witness: {revisionSource: plan.revisionSource}, state, preStateHash, postStateHash: preStateHash};
    return {state, trace: [unknownRevision], terminal: false, final: unknownRevision};
  }
  if (plan.revisionSource === 'PLAN_EVIDENCE' && !known(plan.request.expectedStateRevision)) {
    const preStateHash = digest(state);
    const unknownRevision = {outcome: 'UNKNOWN', reasonCode: 'EXPECTED_STATE_REVISION_MISSING', witness: {eventType: 'RESERVE'}, state, preStateHash, postStateHash: preStateHash};
    return {state, trace: [unknownRevision], terminal: false, final: unknownRevision};
  }
  const reserveRequest = {...clone(plan.request), expectedStateRevision: plan.revisionSource === 'GATEWAY_AT_EVENT' ? state.stateRevision : plan.request.expectedStateRevision};
  const reserved = step(state, {type: 'RESERVE', request: reserveRequest});
  trace.push(reserved);
  state = reserved.state;
  if (reserved.outcome !== 'RESERVED') return {state, trace, terminal: false, final: reserved};

  if (plan.revisionSource === 'PLAN_EVIDENCE' && !known(plan.action.expectedStateRevision)) {
    const preStateHash = digest(state);
    const unknownRevision = {outcome: 'UNKNOWN', reasonCode: 'EXPECTED_STATE_REVISION_MISSING', witness: {eventType: 'CONSUME'}, state, preStateHash, postStateHash: preStateHash};
    trace.push(unknownRevision);
    return {state, trace, terminal: false, final: unknownRevision};
  }
  const consumeAction = {...clone(plan.action), expectedStateRevision: plan.revisionSource === 'GATEWAY_AT_EVENT' ? state.stateRevision : plan.action.expectedStateRevision};
  const consumed = step(state, {type: 'CONSUME', token: reserved.token, action: consumeAction, now: plan.action.now ?? reserveRequest.now});
  trace.push(consumed);
  state = consumed.state;
  if (consumed.outcome !== 'COMMITTED' || plan.finalize === false) {
    return {state, trace, terminal: false, final: consumed};
  }

  const evidence = finalityEvidenceFor(consumed.receipt, state, plan.finalityEvidence);
  const finalized = step(state, {type: 'FINALIZE', receiptId: consumed.receipt.receiptId, evidence});
  trace.push(finalized);
  state = finalized.state;
  return {state, trace, terminal: finalized.outcome === 'FINAL_VERIFIED', final: finalized, audit: auditSinkState(state)};
}

export function evaluateAdmissionPlan(initialState, plan) {
  const run = runAdmissionPlan(initialState, plan);
  const rejected = run.trace.filter(item => item.outcome === 'REJECTED');
  const unknown = run.trace.filter(item => item.outcome === 'UNKNOWN');
  const auditFailure = run.audit?.disposition === 'VIOLATED' ? {outcome: 'REJECTED', reasonCode: 'SINK_INVARIANT_AUDIT_FAILED', witness: {violations: run.audit.violations}, state: run.state} : null;
  const rejectedWithAudit = auditFailure ? [...rejected, auditFailure] : rejected;
  const disposition = rejectedWithAudit.length ? 'VIOLATED' : unknown.length ? 'UNKNOWN' : 'SAFE';
  const failed = [...rejectedWithAudit, ...unknown];
  const obligations = failed.map(item => failedObligation(item, item.outcome === 'REJECTED' ? 'VIOLATED' : 'UNKNOWN'));
  const terminalDisposition = run.terminal && run.audit?.disposition === 'SAFE' ? 'SAFE' : 'UNKNOWN';
  return {
    disposition,
    terminalDisposition,
    policyDecision: disposition === 'SAFE' ? 'ADMIT' : 'ABSTAIN',
    obligations,
    trace: run.trace.map(item => ({eventType: item.linearizationWitness?.eventType ?? item.transition, outcome: item.outcome, reasonCode: item.reasonCode, preStateHash: item.preStateHash, postStateHash: item.postStateHash})),
    terminal: run.terminal,
    audit: run.audit,
    evidenceMode: plan.finalityEvidence?.evidenceMode ?? 'NONE',
    witnessObligations: obligations.map(item => item.obligationId)
  };
}
