/* Research-only AL/ER/AN locked-pair oracle. */
import {advanceActivation, buildCoherenceCut, createEvidenceEscrow, createEvidenceEscrowStore, digest, escrowObservation, reserveFromEscrow} from './ubuddy-cpir-web-vcc-pree-v0.mjs';

export const activation = {activationRoot: 'root-1', tabEpoch: 1, pageEpoch: 1, swEpoch: 1, partitionEpoch: 1, activationNonce: 'act-1', partitionKeyHash: 'partition-1'};

export function runActivationPair() {
  const oldCut = digest(activation);
  const worlds = [
    {id: 'AL+', currentActivation: activation, baseline: 'SAFE'},
    {id: 'AL-', currentActivation: advanceActivation(activation, 'PAGESHOW_BFCACHE'), baseline: 'SAFE'}
  ];
  return worlds.map(world => ({worldId: world.id, baseline: world.baseline, abca: digest(world.currentActivation) === oldCut ? 'SAFE' : 'STALE_ACTIVATION'}));
}

const atom = (sourceId, activationVector = activation) => ({atomId: `${sourceId}-1`, sourceId, authorityId: `${sourceId}-authority`, keyRevision: 1, signatureVerified: true, probeSessionId: 'probe-1', challengeNonce: 'nonce-1', ...activationVector, intentId: 'intent-1', effectId: 'effect-1', tenantId: 'tenant-a', owner: 'agent-a', scope: 'submit', revision: 1, validFrom: 10, validUntil: 20, payloadDigest: `${sourceId}-payload`});

export function runEscrowPair() {
  const requiredSources = ['browser', 'oauth', 'tenant', 'api', 'sink'];
  const expected = {probeSessionId: 'probe-1', challengeNonce: 'nonce-1', activation, intentId: 'intent-1', effectId: 'effect-1', tenantId: 'tenant-a', owner: 'agent-a', scope: 'submit'};
  const atoms = requiredSources.map(sourceId => atom(sourceId));
  const cutResult = buildCoherenceCut({atoms, requiredSources, expected, now: 15});
  let escrow = createEvidenceEscrow({probeSessionId: 'probe-1', challengeNonce: 'nonce-1', activation, intentId: 'intent-1', effectId: 'effect-1', tenantId: 'tenant-a', owner: 'agent-a', scope: 'submit', requiredSources, expiresAt: 20});
  for (const item of atoms) escrow = escrowObservation(escrow, item).escrow;
  const request = {cut: cutResult.cut, cutDigest: cutResult.cutDigest, evidenceAtomIds: cutResult.cut.evidenceAtomIds, expectedEscrowRevision: escrow.escrowRevision, expectedStateRevision: 1, currentStateRevision: 1, currentActivation: activation, now: 15};
  const forged = {...cutResult.cut, tenantId: 'tenant-evil'};
  const serial = reserveFromEscrow(escrow, request);
  const store = createEvidenceEscrowStore(escrow);
  const first = store.reserve(request);
  const second = store.reserve(request);
  return {positive: {verdict: serial.status}, forged: {verdict: reserveFromEscrow(escrow, {...request, cut: forged, cutDigest: digest(forged)}).status}, replay: {first: first.status, second: second.status}};
}

export function runAbstentionPair() {
  const worlds = [
    {id: 'AN-C', publicObservation: {status: 'timeout'}, safeActions: new Set(['ABSTAIN'])},
    {id: 'AN-U', publicObservation: {status: 'timeout'}, safeActions: new Set(['RETRY'])}
  ];
  const actions = ['RETRY', 'ABSTAIN'];
  const matrix = Object.fromEntries(worlds.map(world => [world.id, Object.fromEntries(actions.map(action => [action, world.safeActions.has(action) ? 'SAFE_TERMINAL' : 'VIOLATED']))]));
  return {worlds, actions, matrix, commonSafe: actions.filter(action => worlds.every(world => world.safeActions.has(action))), requiredDecision: 'ABSTAIN_OR_PROBE'};
}

