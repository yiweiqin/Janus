/*
 * Research-only Versioned Coherence Cut (VCC) and Probe-to-Reserve Evidence
 * Escrow (PREE) model. This is a finite evidence semantics, not a runtime or
 * cryptographic verifier. It refuses fractured, stale, cross-owner, and
 * cross-intent evidence before an admission request can be formed.
 */
import {createHash} from 'node:crypto';

const clone = value => structuredClone(value);
const known = value => value !== undefined && value !== null && value !== 'UNKNOWN';
const sameArray = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const activationFields = ['activationRoot', 'tabEpoch', 'pageEpoch', 'swEpoch', 'partitionEpoch', 'activationNonce', 'partitionKeyHash'];
const requiredAtomFields = ['atomId', 'sourceId', 'authorityId', 'keyRevision', 'signatureVerified', 'probeSessionId', 'challengeNonce', ...activationFields, 'intentId', 'effectId', 'tenantId', 'owner', 'scope', 'revision', 'validFrom', 'validUntil', 'payloadDigest'];

function missing(atom, fields = requiredAtomFields) {
  return fields.filter(field => !known(atom?.[field]));
}

export function makeEvidenceAtom(atom) {
  const missingFields = missing(atom);
  if (missingFields.length) return {status: 'UNKNOWN', reasonCode: 'EVIDENCE_ATOM_INCOMPLETE', missing: missingFields};
  if (atom.signatureVerified !== true) return {status: 'UNKNOWN', reasonCode: 'EVIDENCE_AUTHENTICITY_UNVERIFIED', atomId: atom.atomId};
  if (atom.validUntil < atom.validFrom) return {status: 'VIOLATED', reasonCode: 'EVIDENCE_INTERVAL_INVALID', atomId: atom.atomId};
  return {status: 'ACCEPTED', atom: clone(atom), atomDigest: digest(atom)};
}

function cartesian(groups) {
  return groups.reduce((acc, group) => acc.flatMap(prefix => group.map(value => [...prefix, value])), [[]]);
}

function hasCommonWitnessTime(groups) {
  const points = [...new Set(groups.flatMap(group => group.flatMap(atom => [atom.validFrom, atom.validUntil])))].sort((a, b) => a - b);
  return points.some(point => groups.every(group => group.some(atom => atom.validFrom <= point && point <= atom.validUntil)));
}

export function buildCoherenceCut({atoms, requiredSources, expected, now, dependencyRevisions = {}, authorityRegistry = {}, maxCandidateCombinations = 100000, enumerationMode = 'UNARY_CANONICAL'}) {
  const accepted = [];
  const rejected = [];
  for (const atom of atoms ?? []) {
    const checked = makeEvidenceAtom(atom);
    if (checked.status === 'ACCEPTED') accepted.push(checked.atom);
    else rejected.push({atomId: atom?.atomId, status: checked.status, reasonCode: checked.reasonCode, missing: checked.missing});
  }
  const groups = requiredSources.map(sourceId => accepted.filter(atom => atom.sourceId === sourceId));
  if (groups.some(group => group.length === 0)) return {status: 'UNKNOWN', reasonCode: 'REQUIRED_SOURCE_EVIDENCE_MISSING', missingSources: requiredSources.filter((_, i) => groups[i].length === 0), rejected};
  const candidateUpperBound = groups.reduce((product, group) => product * group.length, 1);
  if (enumerationMode === 'CARTESIAN' && (!Number.isSafeInteger(candidateUpperBound) || candidateUpperBound > maxCandidateCombinations)) return {status: 'UNKNOWN', reasonCode: 'CUT_SEARCH_BOUND_EXCEEDED', candidateUpperBound, maxCandidateCombinations, enumerationMode};
  const admissible = selection => {
    const fields = ['probeSessionId', 'challengeNonce', 'intentId', 'effectId', 'tenantId', 'owner'];
    if (fields.some(field => selection.some(atom => atom[field] !== expected?.[field]))) return false;
    if (activationFields.some(field => selection.some(atom => atom[field] !== expected?.activation?.[field]))) return false;
    if (selection.some(atom => atom.scope !== expected?.scope)) return false;
    if (selection.some(atom => authorityRegistry[atom.sourceId] && (authorityRegistry[atom.sourceId].authorityId !== atom.authorityId || authorityRegistry[atom.sourceId].keyRevision !== atom.keyRevision))) return false;
    if (selection.some(atom => atom.validFrom > now || atom.validUntil < now)) return false;
    const from = Math.max(...selection.map(atom => atom.validFrom));
    const until = Math.min(...selection.map(atom => atom.validUntil));
    if (from > until) return false;
    return Object.entries(dependencyRevisions).every(([sourceId, revision]) => selection.find(atom => atom.sourceId === sourceId)?.revision === revision);
  };
  const unaryAtomAdmissible = atom => {
    const fields = ['probeSessionId', 'challengeNonce', 'intentId', 'effectId', 'tenantId', 'owner'];
    if (fields.some(field => atom[field] !== expected?.[field])) return false;
    if (activationFields.some(field => atom[field] !== expected?.activation?.[field])) return false;
    if (atom.scope !== expected?.scope || atom.validFrom > now || atom.validUntil < now) return false;
    if (authorityRegistry[atom.sourceId] && (authorityRegistry[atom.sourceId].authorityId !== atom.authorityId || authorityRegistry[atom.sourceId].keyRevision !== atom.keyRevision)) return false;
    return !Object.hasOwn(dependencyRevisions, atom.sourceId) || dependencyRevisions[atom.sourceId] === atom.revision;
  };
  const unaryGroups = groups.map(group => group.filter(unaryAtomAdmissible));
  const candidates = enumerationMode === 'CARTESIAN'
    ? cartesian(groups).filter(admissible)
    : unaryGroups.some(group => group.length === 0) ? [] : [unaryGroups.map(group => group.slice().sort((a, b) => digest(a).localeCompare(digest(b)))[0])];
  if (!candidates.length) {
    const reasonCode = hasCommonWitnessTime(groups) ? 'COHERENCE_CONSTRAINT_UNSATISFIED' : 'FRACTURED_VALIDITY_INTERVAL';
    return {status: 'UNKNOWN', reasonCode, rejected, candidateCount: 0};
  }
  const selection = candidates.sort((a, b) => a.map(atom => atom.atomId).join('|').localeCompare(b.map(atom => atom.atomId).join('|')))[0];
  const cut = cutFromSelection(selection, expected);
  return {status: 'SAFE', reasonCode: 'COHERENT_VERSIONED_CUT', cut, cutDigest: digest(cut), selectedAtoms: selection.map(clone), rejected};
}

function cutFromSelection(selection, expected) {
  return {
    probeSessionId: expected.probeSessionId, challengeNonce: expected.challengeNonce,
    activation: Object.fromEntries(activationFields.map(field => [field, expected.activation[field]])),
    intentId: expected.intentId, effectId: expected.effectId, tenantId: expected.tenantId, owner: expected.owner, scope: expected.scope,
    evidenceAtomIds: selection.map(atom => atom.atomId).sort(),
    atomsBySource: Object.fromEntries(selection.slice().sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map(atom => [atom.sourceId, {atomId: atom.atomId, authorityId: atom.authorityId, keyRevision: atom.keyRevision, revision: atom.revision, validFrom: atom.validFrom, validUntil: atom.validUntil, payloadDigest: atom.payloadDigest}])),
    validFrom: Math.max(...selection.map(atom => atom.validFrom)), validUntil: Math.min(...selection.map(atom => atom.validUntil))
  };
}

export function createEvidenceEscrow({probeSessionId, challengeNonce, activation, intentId, effectId, tenantId, owner, scope, requiredSources = [], expiresAt}) {
  return {schemaVersion: 'cpir-web/evidence-escrow/v0', escrowRevision: 0, probeSessionId, challengeNonce, activation: clone(activation), intentId, effectId, tenantId, owner, scope, requiredSources: [...new Set(requiredSources)].sort(), expiresAt, atoms: {}, consumedCutDigests: []};
}

export function escrowObservation(escrow, observation) {
  const atom = makeEvidenceAtom(observation);
  if (atom.status !== 'ACCEPTED') return {status: atom.status, reasonCode: atom.reasonCode, escrow};
  if (observation.probeSessionId !== escrow.probeSessionId || observation.challengeNonce !== escrow.challengeNonce || observation.intentId !== escrow.intentId || observation.effectId !== escrow.effectId || observation.tenantId !== escrow.tenantId || observation.owner !== escrow.owner || observation.scope !== escrow.scope) return {status: 'VIOLATED', reasonCode: 'ESCROW_BINDING_MISMATCH', escrow};
  if (activationFields.some(field => observation[field] !== escrow.activation?.[field])) return {status: 'VIOLATED', reasonCode: 'ESCROW_ACTIVATION_BINDING_MISMATCH', escrow};
  if (observation.validUntil > escrow.expiresAt) return {status: 'VIOLATED', reasonCode: 'ESCROW_EXPIRY_EXCEEDS_SESSION', escrow};
  const existing = escrow.atoms[observation.atomId];
  if (existing && digest(existing) !== digest(observation)) return {status: 'VIOLATED', reasonCode: 'EVIDENCE_ATOM_ID_COLLISION', escrow};
  const next = clone(escrow); next.atoms[observation.atomId] = clone(observation); next.escrowRevision += 1;
  return {status: 'ACCEPTED', reasonCode: 'EVIDENCE_ESCROWED', escrow: next};
}

export function reserveFromEscrow(escrow, {cut, cutDigest, evidenceAtomIds, expectedEscrowRevision, expectedStateRevision, currentStateRevision, currentActivation, now}) {
  if (expectedEscrowRevision !== escrow.escrowRevision) return {status: 'REJECTED', reasonCode: 'STALE_ESCROW_REVISION'};
  if (currentStateRevision !== expectedStateRevision) return {status: 'REJECTED', reasonCode: 'STALE_PROBE_RESERVE_REVISION'};
  if (!cut || digest(cut) !== cutDigest) return {status: 'REJECTED', reasonCode: 'CUT_DIGEST_MISMATCH'};
  if (cut.probeSessionId !== escrow.probeSessionId || cut.challengeNonce !== escrow.challengeNonce || cut.intentId !== escrow.intentId || cut.owner !== escrow.owner || cut.scope !== escrow.scope) return {status: 'REJECTED', reasonCode: 'CUT_ESCROW_BINDING_MISMATCH'};
  if (cut.effectId !== escrow.effectId || cut.tenantId !== escrow.tenantId) return {status: 'REJECTED', reasonCode: 'CUT_EFFECT_TENANT_BINDING_MISMATCH'};
  if (!currentActivation) return {status: 'UNKNOWN', reasonCode: 'CURRENT_ACTIVATION_UNAVAILABLE'};
  if (digest(currentActivation) !== digest(cut.activation)) return {status: 'REJECTED', reasonCode: 'STALE_ACTIVATION_LINEAGE'};
  if (escrow.expiresAt < now) return {status: 'REJECTED', reasonCode: 'ESCROW_EXPIRED'};
  if (escrow.consumedCutDigests.includes(cutDigest)) return {status: 'REJECTED', reasonCode: 'CUT_ALREADY_CONSUMED'};
  const missingAtoms = evidenceAtomIds.filter(atomId => !escrow.atoms[atomId]);
  if (missingAtoms.length) return {status: 'UNKNOWN', reasonCode: 'ESCROW_ATOM_NOT_FOUND', missingAtoms};
  if (!sameArray(cut.evidenceAtomIds.slice().sort(), evidenceAtomIds.slice().sort())) return {status: 'REJECTED', reasonCode: 'CUT_EVIDENCE_SET_MISMATCH'};
  if (new Set(evidenceAtomIds).size !== evidenceAtomIds.length) return {status: 'REJECTED', reasonCode: 'CUT_EVIDENCE_SET_DUPLICATED'};
  if (escrow.requiredSources.length && (new Set(evidenceAtomIds.map(atomId => escrow.atoms[atomId].sourceId)).size !== escrow.requiredSources.length || escrow.requiredSources.some(sourceId => !evidenceAtomIds.some(atomId => escrow.atoms[atomId].sourceId === sourceId)))) return {status: 'REJECTED', reasonCode: 'CUT_REQUIRED_SOURCE_COVERAGE_MISMATCH'};
  const selectedAtoms = evidenceAtomIds.map(atomId => escrow.atoms[atomId]);
  if (selectedAtoms.some(atom => atom.validFrom > now || atom.validUntil < now)) return {status: 'REJECTED', reasonCode: 'CUT_ATOM_NOT_CURRENT_AT_RESERVE'};
  const rebuilt = cutFromSelection(selectedAtoms, escrow);
  if (digest(rebuilt) !== cutDigest) return {status: 'REJECTED', reasonCode: 'CUT_NOT_RECONSTRUCTIBLE_FROM_ESCROW'};
  const next = clone(escrow); next.consumedCutDigests.push(cutDigest); next.escrowRevision += 1;
  return {status: 'SAFE', reasonCode: 'CUT_ESCROW_BOUND_TO_RESERVE', escrow: next, reserveBinding: {cutDigest, evidenceAtomIds: evidenceAtomIds.slice().sort(), expectedStateRevision}};
}

export function advanceActivation(vector, event) {
  const next = clone(vector);
  if (event === 'PAGEHIDE_BFCACHE') next.pageEpoch += 1;
  if (event === 'PAGESHOW_BFCACHE' || event === 'SW_CONTROLLER_CHANGE' || event === 'PARTITION_SWITCH') {
    next.pageEpoch += 1;
    if (event === 'SW_CONTROLLER_CHANGE') next.swEpoch += 1;
    if (event === 'PARTITION_SWITCH') { next.tabEpoch += 1; next.partitionEpoch += 1; }
    next.activationNonce = `${next.activationNonce}:${event}:${next.pageEpoch}:${next.swEpoch}:${next.tabEpoch}:${next.partitionEpoch}`;
  }
  return next;
}

export function createEvidenceEscrowStore(initialEscrow) {
  let current = clone(initialEscrow);
  return {
    snapshot: () => clone(current),
    observe: observation => {
      const result = escrowObservation(current, observation);
      if (result.status === 'ACCEPTED') current = result.escrow;
      return result;
    },
    reserve: request => {
      const result = reserveFromEscrow(current, request);
      if (result.status === 'SAFE') current = result.escrow;
      return result;
    }
  };
}
