#!/usr/bin/env node
import assert from 'node:assert/strict';
import {digest} from './ubuddy-cpir-web-oracle-v1.mjs';
import {compareOracleConsumers} from './ubuddy-cpir-web-oracle-baseline-comparison-v1.mjs';
import {lockedPairOracleManifest} from './ubuddy-cpir-web-oracle-locked-pairs-v1.mjs';

const manifest = {
  schemaVersion: 'cpir-web/oracle/v1', manifestId: 'baseline-equivalence-v1',
  contractRegistryHash: digest('contract/v1', {id: 'c'}), observationProjectorHash: digest('projector/v1', {fields: ['side']}), transitionVerifierHash: digest('transition/v1', {ops: ['EQ']}), trustRootHashes: ['root-1'], observationProjector: {fields: ['side']}, budget: {maxCost: 1},
  actions: [
    {id: 'submit-left', cost: 0, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'left', op: 'EQ', left: {path: 'world.side'}, right: {value: 'left'}}]}},
    {id: 'submit-right', cost: 0, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'right', op: 'EQ', left: {path: 'world.side'}, right: {value: 'right'}}]}}
  ],
  probes: [{id: 'side-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'side', path: 'world.side'}]}], faultSchedules: [{id: 'none', events: []}],
  worlds: [{id: 'left', side: 'left', publicObservation: {side: 'hidden'}, initialState: {}}, {id: 'right', side: 'right', publicObservation: {side: 'hidden'}, initialState: {}}]
};

const result = compareOracleConsumers(manifest, {eventScheduleId: 'none', observationBudget: 1});
assert.equal(result.policyEquivalent, true);
assert.equal(result.traceEquivalentWithStrongestMatureVerifier, true);
assert.equal(result.aoc.projection.probeId, 'side-probe');
assert.equal(result.robust.projection.probeId, 'side-probe');
assert.equal(result.aoc.stats.memoStates, result.robust.stats.memoStates);
assert.equal(result.oracleCalls, 6);
assert.equal(result.traceRows.length, 4);

const locked = compareOracleConsumers(lockedPairOracleManifest, {eventScheduleId: 'none', observationBudget: 4});
assert.equal(locked.policyEquivalent, true);
assert.equal(locked.aoc.status, undefined);
assert.equal(locked.aoc.projection.status, 'LOSE');

console.log(JSON.stringify({schemaVersion: 'cpir-web/oracle-baseline-comparison-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 10, result: {aocAndRobustPolicyEquivalent: true, lockedPairsEquivalent: true, sameVerifierTraceEquivalent: true, sameMemoStateCount: true}, warning: 'negative-novelty-evidence-on-finite-fixtures'}, null, 2));
