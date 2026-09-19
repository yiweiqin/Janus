#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createOracle, validateOracleManifest} from './ubuddy-cpir-web-oracle-v1.mjs';
import {doubleFaultOracleManifest as manifest} from './ubuddy-cpir-web-oracle-double-faults-v1.mjs';
import {compareCertificateInformation} from './ubuddy-cpir-web-certificate-information-v1.mjs';

assert.equal(validateOracleManifest(manifest).valid, true);
const oracle = createOracle(manifest);
const action = 'combined-evidence-submit';
assert.equal(oracle.evaluate('DF-CLEAN', action, 'none', 4).verdict, 'SAFE');

const expected = {
  'DF-AL-PC': ['activation', 'predecessor'],
  'DF-AL-AN': ['activation', 'no-commit', 'cardinality'],
  'DF-PC-ER': ['predecessor', 'escrow-refinement'],
  'DF-ER-AN': ['escrow-single-use', 'no-commit', 'cardinality']
};
for (const [worldId, guardIds] of Object.entries(expected)) {
  const result = oracle.evaluate(worldId, action, 'none', 4);
  assert.equal(result.verdict, 'VIOLATED');
  const violated = result.witness.guardWitnesses.filter(item => item.status === 'VIOLATED').map(item => item.guardId);
  assert.deepEqual(violated, guardIds);
}
assert.equal(oracle.evaluate('DF-AL-PC', action, 'timeout', 4).verdict, 'UNKNOWN');

const queryPlan = [{id: 'DOUBLE', worldIds: manifest.worlds.map(world => world.id), actionIds: [action], probeIds: manifest.probes.map(probe => probe.id), eventScheduleId: 'none', observationBudget: 4}];
const comparison = compareCertificateInformation(manifest, queryPlan);
assert.equal(comparison.semanticEquivalence.cpirVsGenericFullProjection, true);
assert.equal(comparison.semanticEquivalence.cpirVsMatureFullProjection, true);
assert.equal(comparison.reports.cpir.valid, true);

console.log(JSON.stringify({schemaVersion: 'cpir-web/oracle-double-faults-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 17, result: {multiObligationWitnessesPreserved: true, timeoutFailClosed: true, fullBaselineProjectionStillEquivalent: true}, warning: 'double-fault-coverage-improves-falsification-not-novelty'}, null, 2));
