/*
 * Shared-oracle certificate information comparison.
 * This deliberately gives strong baselines access to the same raw oracle
 * projection; any remaining advantage must come from semantics, not withholding
 * evidence from the baseline.
 */
import {createOracle, digest} from './ubuddy-cpir-web-oracle-v1.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const bytes = value => Buffer.byteLength(stable(value), 'utf8');

const obligationByReason = {
  STALE_ACTIVATION_LINEAGE: ['ACTIVATION_CONTINUITY'],
  PREDECESSOR_REVOKED: ['AUTHORITY_PREDECESSOR_CLOSURE'],
  CUT_NOT_RECONSTRUCTIBLE: ['ESCROW_REFINEMENT'],
  ESCROW_ALREADY_CONSUMED: ['ESCROW_SINGLE_USE'],
  COMMIT_AMBIGUITY_FORBIDS_RETRY: ['RECEIPT_FINALITY', 'EFFECT_CARDINALITY']
};

export const FULL_EVIDENCE_FIELDS = [
  'verdict', 'reasonCode', 'canonicalObservation', 'transitionTrace',
  'preStateHash', 'postStateHash', 'linearizationWitness', 'activationVector',
  'authorityAtoms', 'authorityFrontiers', 'escrowBinding', 'sinkLedgerDelta',
  'witness', 'cost'
];

function projectOracleCell(result, queryId) {
  return {
    queryId,
    worldId: result.worldId,
    subjectId: result.selectedActionOrProbeId,
    subjectKind: result.selectedKind,
    obligationIds: obligationByReason[result.reasonCode] ?? [],
    ...Object.fromEntries(FULL_EVIDENCE_FIELDS.map(field => [field, result[field] ?? null]))
  };
}

function commitments(manifest, queryPlan) {
  return {
    manifestId: manifest.manifestId,
    contractRegistryHash: manifest.contractRegistryHash,
    observationProjectorHash: manifest.observationProjectorHash,
    transitionVerifierHash: manifest.transitionVerifierHash,
    trustRootHashes: [...manifest.trustRootHashes].sort(),
    queryPlanHash: digest('cpir-web/certificate-query-plan/v1', queryPlan)
  };
}

function materializeCells(manifest, queryPlan) {
  const oracle = createOracle(manifest);
  const cells = [];
  for (const query of queryPlan) {
    for (const worldId of query.worldIds) {
      for (const actionId of query.actionIds ?? []) cells.push(projectOracleCell(oracle.evaluate(worldId, actionId, query.eventScheduleId ?? 'none', query.observationBudget), query.id));
      for (const probeId of query.probeIds ?? []) cells.push(projectOracleCell(oracle.evaluate(worldId, probeId, query.eventScheduleId ?? 'none', query.observationBudget), query.id));
    }
  }
  return cells.sort((a, b) => `${a.queryId}|${a.worldId}|${a.subjectKind}|${a.subjectId}`.localeCompare(`${b.queryId}|${b.worldId}|${b.subjectKind}|${b.subjectId}`));
}

function fullCertificate(kind, manifest, queryPlan, cells) {
  return {
    schemaVersion: `cpir-web/${kind}/v1`,
    implementationStatus: 'research-prototype/unverified',
    kind,
    commitments: commitments(manifest, queryPlan),
    closure: queryPlan.map(query => ({queryId: query.id, worldIds: [...query.worldIds].sort(), actionIds: [...(query.actionIds ?? [])].sort(), probeIds: [...(query.probeIds ?? [])].sort(), eventScheduleId: query.eventScheduleId ?? 'none', observationBudget: query.observationBudget})),
    cells
  };
}

function nativeTraceCell(cell) {
  return Object.fromEntries(['queryId', 'worldId', 'subjectId', 'subjectKind', 'verdict', 'reasonCode', 'transitionTrace', 'preStateHash', 'postStateHash', 'linearizationWitness', 'witness', 'cost'].map(field => [field, cell[field] ?? null]));
}

function nativeAuditCell(cell) {
  return Object.fromEntries(['queryId', 'worldId', 'subjectId', 'subjectKind', 'verdict', 'reasonCode', 'authorityFrontiers', 'sinkLedgerDelta', 'transitionTrace', 'cost'].map(field => [field, cell[field] ?? null]));
}

function nativeCertificate(kind, manifest, queryPlan, cells, projector) {
  return {...fullCertificate(kind, manifest, queryPlan, cells.map(projector)), nativeProjection: true};
}

export function buildCertificateProfiles(manifest, queryPlan) {
  const cells = materializeCells(manifest, queryPlan);
  const cpir = fullCertificate('cpir-obstruction-certificate', manifest, queryPlan, cells);
  const generic = fullCertificate('generic-model-checker-counterexample', manifest, queryPlan, structuredClone(cells));
  const mature = fullCertificate('mature-stack-structured-audit', manifest, queryPlan, structuredClone(cells));
  const nativeGeneric = nativeCertificate('generic-native-trace', manifest, queryPlan, cells, nativeTraceCell);
  const nativeMature = nativeCertificate('mature-native-audit', manifest, queryPlan, cells, nativeAuditCell);
  const musCells = cells.filter(cell => cell.subjectKind === 'ACTION' && cell.verdict !== 'SAFE').map(cell => ({queryId: cell.queryId, worldId: cell.worldId, subjectId: cell.subjectId, verdict: cell.verdict, reasonCode: cell.reasonCode, obligationIds: cell.obligationIds}));
  const mus = {schemaVersion: 'cpir-web/generic-mus-core/v1', implementationStatus: 'research-prototype/unverified', kind: 'generic-mus-core', commitments: commitments(manifest, queryPlan), cells: musCells};
  return {cpir, generic, mature, nativeGeneric, nativeMature, mus};
}

function cellKey(cell) { return `${cell.queryId}|${cell.worldId}|${cell.subjectKind ?? 'ACTION'}|${cell.subjectId}`; }

export function verifyCertificateProfile({certificate, manifest, queryPlan, requireFullReplay = true}) {
  const expectedCommitments = commitments(manifest, queryPlan);
  const expectedCells = new Map(materializeCells(manifest, queryPlan).map(cell => [cellKey(cell), cell]));
  const errors = [];
  if (stable(certificate.commitments) !== stable(expectedCommitments)) errors.push({code: 'COMMITMENT_MISMATCH'});
  const supplied = new Map((certificate.cells ?? []).map(cell => [cellKey(cell), cell]));
  if (requireFullReplay) {
    for (const [key, expected] of expectedCells) {
      const actual = supplied.get(key);
      if (!actual) errors.push({code: 'CELL_MISSING', key});
      else if (stable(actual) !== stable(expected)) errors.push({code: 'CELL_REPLAY_MISMATCH', key});
    }
    for (const key of supplied.keys()) if (!expectedCells.has(key)) errors.push({code: 'CELL_UNEXPECTED', key});
  } else {
    for (const cell of certificate.cells ?? []) {
      const candidates = [...expectedCells.values()].filter(expected => expected.queryId === cell.queryId && expected.worldId === cell.worldId && expected.subjectId === cell.subjectId);
      const expected = candidates[0];
      if (!expected || cell.verdict !== expected.verdict || cell.reasonCode !== expected.reasonCode) errors.push({code: 'CORE_VERDICT_NOT_REPLAYABLE', key: cellKey(cell)});
    }
  }
  return {valid: errors.length === 0, errors};
}

function evidenceCoverage(certificate) {
  const fullCells = (certificate.cells ?? []).filter(cell => cell.subjectKind);
  if (!fullCells.length) return 0;
  const total = fullCells.length * FULL_EVIDENCE_FIELDS.length;
  const present = fullCells.reduce((count, cell) => count + FULL_EVIDENCE_FIELDS.filter(field => Object.hasOwn(cell, field)).length, 0);
  return present / total;
}

const DECISION_EVIDENCE_FIELDS = ['activationVector', 'authorityFrontiers', 'escrowBinding', 'linearizationWitness', 'sinkLedgerDelta'];
function decisionEvidenceCoverage(certificate) {
  const actionCells = (certificate.cells ?? []).filter(cell => cell.subjectKind === 'ACTION');
  if (!actionCells.length) return 0;
  const total = actionCells.length * DECISION_EVIDENCE_FIELDS.length;
  const present = actionCells.reduce((count, cell) => count + DECISION_EVIDENCE_FIELDS.filter(field => cell[field] !== undefined && cell[field] !== null).length, 0);
  return present / total;
}

function verifyNativeCertificate({certificate, manifest, queryPlan, kind}) {
  const expectedCells = new Map(materializeCells(manifest, queryPlan).map(cell => [cellKey(cell), cell]));
  const errors = [];
  const required = kind === 'generic-native-trace' ? ['verdict', 'reasonCode', 'transitionTrace', 'preStateHash', 'postStateHash'] : ['verdict', 'reasonCode'];
  for (const cell of certificate.cells ?? []) {
    const expected = expectedCells.get(cellKey(cell));
    if (!expected) { errors.push({code: 'CELL_UNEXPECTED', key: cellKey(cell)}); continue; }
    for (const field of required) if (cell[field] === undefined || cell[field] === null) errors.push({code: 'NATIVE_FIELD_MISSING', field, key: cellKey(cell)});
    if (cell.verdict !== expected.verdict || cell.reasonCode !== expected.reasonCode) errors.push({code: 'NATIVE_VERDICT_MISMATCH', key: cellKey(cell)});
    if (kind === 'generic-native-trace' && (stable(cell.transitionTrace) !== stable(expected.transitionTrace) || cell.preStateHash !== expected.preStateHash || cell.postStateHash !== expected.postStateHash)) errors.push({code: 'NATIVE_TRACE_MISMATCH', key: cellKey(cell)});
  }
  if ((certificate.cells ?? []).length !== expectedCells.size) errors.push({code: 'NATIVE_CELL_COUNT_MISMATCH'});
  return {valid: errors.length === 0, errors};
}

function normalizedSemantics(certificate) {
  return (certificate.cells ?? []).filter(cell => cell.subjectKind).map(cell => Object.fromEntries(['queryId', 'worldId', 'subjectId', 'subjectKind', 'obligationIds', ...FULL_EVIDENCE_FIELDS].map(field => [field, cell[field] ?? null]))).sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
}

export function compareCertificateInformation(manifest, queryPlan) {
  const profiles = buildCertificateProfiles(manifest, queryPlan);
  const reports = {};
  for (const [name, certificate] of Object.entries(profiles)) {
    const full = ['cpir', 'generic', 'mature'].includes(name);
    const native = ['nativeGeneric', 'nativeMature'].includes(name);
    const verification = native
      ? verifyNativeCertificate({certificate, manifest, queryPlan, kind: certificate.kind})
      : verifyCertificateProfile({certificate, manifest, queryPlan, requireFullReplay: full});
    reports[name] = {valid: verification.valid, errors: verification.errors, fullTransitionReplay: full && verification.valid, verdictReplay: verification.valid, evidenceCoverage: evidenceCoverage(certificate), decisionEvidenceCoverage: decisionEvidenceCoverage(certificate), encodedBytes: bytes(certificate), cellCount: certificate.cells.length};
  }
  const cpirSemantics = stable(normalizedSemantics(profiles.cpir));
  return {
    schemaVersion: 'cpir-web/certificate-information-comparison/v1',
    implementationStatus: 'research-prototype/unverified',
    reports,
    semanticEquivalence: {
      cpirVsGenericFullProjection: cpirSemantics === stable(normalizedSemantics(profiles.generic)),
      cpirVsMatureFullProjection: cpirSemantics === stable(normalizedSemantics(profiles.mature)),
      cpirVsMusFullProjection: cpirSemantics === stable(normalizedSemantics(profiles.mus))
    },
    nativeProfile: {
      cpirVsNativeGenericDecisionEvidenceGain: reports.cpir.decisionEvidenceCoverage - reports.nativeGeneric.decisionEvidenceCoverage,
      cpirVsNativeMatureDecisionEvidenceGain: reports.cpir.decisionEvidenceCoverage - reports.nativeMature.decisionEvidenceCoverage,
      interpretation: 'representation-level-gain-only-until-baseline-is-allowed-the-same-typed-fields'
    },
    conclusion: 'NO_INTRINSIC_INFORMATION_ADVANTAGE_WHEN_BASELINES_RECEIVE_THE_SAME_TYPED_PROJECTION',
    profiles
  };
}
