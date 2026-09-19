#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createOracle, validateOracleManifest} from './ubuddy-cpir-web-oracle-v1.mjs';
import {lockedPairOracleManifest as manifest} from './ubuddy-cpir-web-oracle-locked-pairs-v1.mjs';

assert.equal(validateOracleManifest(manifest).valid, true);
const oracle = createOracle(manifest);
const check = (world, action, verdict, reasonCode) => {
  const result = oracle.evaluate(world, action, 'none', 4);
  assert.equal(result.verdict, verdict);
  if (reasonCode) assert.equal(result.reasonCode, reasonCode);
  assert.deepEqual(result, oracle.evaluate(world, action, 'none', 4));
  return result;
};

check('AL+', 'activation-bound-submit', 'SAFE', 'ACTIVATION_BOUND_COMMIT');
check('AL-', 'activation-bound-submit', 'VIOLATED', 'STALE_ACTIVATION_LINEAGE');
check('PC+', 'predecessor-bound-submit', 'SAFE', 'PREDECESSOR_CLOSURE_COMMIT');
check('PC-', 'predecessor-bound-submit', 'VIOLATED', 'PREDECESSOR_REVOKED');
check('ER+', 'consume-evidence-escrow', 'SAFE', 'ESCROW_RECONSTRUCTED_AND_CONSUMED');
check('ER-FORGED', 'consume-evidence-escrow', 'VIOLATED', 'CUT_NOT_RECONSTRUCTIBLE');
check('ER-REPLAY', 'consume-evidence-escrow', 'VIOLATED', 'ESCROW_ALREADY_CONSUMED');
check('AN-NO-COMMIT', 'retry-original-key', 'SAFE', 'NO_COMMIT_CONFIRMED_RETRY');
check('AN-COMMITTED-LOST', 'retry-original-key', 'VIOLATED', 'COMMIT_AMBIGUITY_FORBIDS_RETRY');

for (const [left, right] of [['AL+', 'AL-'], ['PC+', 'PC-'], ['AN-NO-COMMIT', 'AN-COMMITTED-LOST']]) {
  const a = manifest.worlds.find(world => world.id === left).publicObservation;
  const b = manifest.worlds.find(world => world.id === right).publicObservation;
  assert.deepEqual(a, b);
}
assert.equal(oracle.evaluate('AN-NO-COMMIT', 'receipt-finality-probe', 'none', 4).canonicalObservation.signal, 'NO_COMMIT');
assert.equal(oracle.evaluate('AN-COMMITTED-LOST', 'receipt-finality-probe', 'none', 4).canonicalObservation.signal, 'COMMITTED_RECEIPT_LOST');
assert.equal(oracle.evaluate('PC+', 'predecessor-bound-submit', 'incomplete-authority', 4).verdict, 'UNKNOWN');
assert.equal(oracle.evaluate('AL+', 'activation-bound-submit', 'response-timeout', 4).verdict, 'UNKNOWN');

console.log(JSON.stringify({schemaVersion: 'cpir-web/oracle-locked-pairs-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 26, pairs: {AL: 'guard-derived', PC: 'authority-log-derived', ER: 'reconstruction-and-single-use-derived', AN: 'finality-derived'}, warning: 'finite-manifest-only; strong-baseline-equivalence-not-yet-tested'}, null, 2));
