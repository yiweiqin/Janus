#!/usr/bin/env node
import assert from 'node:assert/strict';
import {lockedPairOracleManifest as manifest} from './ubuddy-cpir-web-oracle-locked-pairs-v1.mjs';
import {buildCertificateProfiles, compareCertificateInformation, verifyCertificateProfile} from './ubuddy-cpir-web-certificate-information-v1.mjs';

const queryPlan = [
  {id: 'AL', worldIds: ['AL+', 'AL-'], actionIds: ['activation-bound-submit'], probeIds: ['activation-probe'], eventScheduleId: 'none', observationBudget: 4},
  {id: 'PC', worldIds: ['PC+', 'PC-'], actionIds: ['predecessor-bound-submit'], probeIds: ['authority-frontier-probe'], eventScheduleId: 'none', observationBudget: 4},
  {id: 'ER', worldIds: ['ER+', 'ER-FORGED', 'ER-REPLAY'], actionIds: ['consume-evidence-escrow'], probeIds: ['escrow-reconstruction-probe'], eventScheduleId: 'none', observationBudget: 4},
  {id: 'AN', worldIds: ['AN-NO-COMMIT', 'AN-COMMITTED-LOST'], actionIds: ['retry-original-key'], probeIds: ['receipt-finality-probe'], eventScheduleId: 'none', observationBudget: 4}
];

const result = compareCertificateInformation(manifest, queryPlan);
assert.equal(result.reports.cpir.valid, true);
assert.equal(result.reports.generic.valid, true);
assert.equal(result.reports.mature.valid, true);
assert.equal(result.reports.mus.valid, true);
assert.equal(result.semanticEquivalence.cpirVsGenericFullProjection, true);
assert.equal(result.semanticEquivalence.cpirVsMatureFullProjection, true);
assert.equal(result.semanticEquivalence.cpirVsMusFullProjection, false);
assert.equal(result.reports.cpir.evidenceCoverage, 1);
assert.equal(result.reports.generic.evidenceCoverage, 1);
assert.equal(result.reports.mus.evidenceCoverage, 0);
assert.equal(result.reports.nativeGeneric.valid, true);
assert.equal(result.reports.nativeMature.valid, true);
assert(result.reports.cpir.decisionEvidenceCoverage >= result.reports.nativeGeneric.decisionEvidenceCoverage);
assert(result.reports.cpir.decisionEvidenceCoverage >= result.reports.nativeMature.decisionEvidenceCoverage);
assert.equal(result.nativeProfile.interpretation, 'representation-level-gain-only-until-baseline-is-allowed-the-same-typed-fields');
assert.equal(result.conclusion, 'NO_INTRINSIC_INFORMATION_ADVANTAGE_WHEN_BASELINES_RECEIVE_THE_SAME_TYPED_PROJECTION');

const profiles = buildCertificateProfiles(manifest, queryPlan);
const tampered = structuredClone(profiles.cpir);
tampered.cells[0].verdict = tampered.cells[0].verdict === 'SAFE' ? 'VIOLATED' : 'SAFE';
assert.equal(verifyCertificateProfile({certificate: tampered, manifest, queryPlan}).valid, false);
const missing = structuredClone(profiles.cpir);
missing.cells.pop();
assert.equal(verifyCertificateProfile({certificate: missing, manifest, queryPlan}).valid, false);
const changedCommitment = structuredClone(profiles.cpir);
changedCommitment.commitments.transitionVerifierHash = 'tampered';
assert.equal(verifyCertificateProfile({certificate: changedCommitment, manifest, queryPlan}).valid, false);

console.log(JSON.stringify({schemaVersion: 'cpir-web/certificate-information-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 18, result: {fullGenericEquivalent: true, fullMatureAuditEquivalent: true, nativeProfilesReplayable: true, musNotFullReplayable: true, representationGainNotIntrinsic: true, tamperDetected: true, missingCellDetected: true, commitmentMismatchDetected: true}, warning: 'native-profile-gain-is-not-intrinsic-novelty'}, null, 2));
