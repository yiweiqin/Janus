#!/usr/bin/env node
import assert from 'node:assert/strict';
import {digest} from './ubuddy-cpir-web-oracle-v1.mjs';
import {solveObservationAwareAocFromOracle} from './ubuddy-cpir-web-aoc-dp-oracle-v1.mjs';

const manifest = {
  schemaVersion: 'cpir-web/oracle/v1', manifestId: 'dp-oracle-fixture-v1',
  contractRegistryHash: digest('contract-registry/v1', {id: 'c'}), observationProjectorHash: digest('projector/v1', {fields: ['side']}), transitionVerifierHash: digest('transition/v1', {id: 1}), trustRootHashes: ['root-oauth'], observationProjector: {fields: ['side']}, budget: {maxCost: 1},
  actions: [{id: 'a-left', cost: 0, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'left', op: 'EQ', left: {path: 'world.side'}, right: {value: 'left'}}]}}, {id: 'a-right', cost: 0, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'right', op: 'EQ', left: {path: 'world.side'}, right: {value: 'right'}}]}}],
  probes: [{id: 'p-side', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'side', path: 'world.side'}]}], faultSchedules: [{id: 'none', events: []}],
  worlds: [
    {id: 'left', side: 'left', publicObservation: {cause: 'hidden'}, initialState: {}},
    {id: 'right', side: 'right', publicObservation: {cause: 'hidden'}, initialState: {}}
  ]
};

const solved = solveObservationAwareAocFromOracle(manifest, {eventScheduleId: 'none', observationBudget: 1});
assert.equal(solved.oracleOnly, true);
assert.equal(solved.status, 'WIN');
assert.equal(solved.root.probeId, 'p-side');
assert.equal(solved.oracleCallCount, 6);
const abstain = solveObservationAwareAocFromOracle(manifest, {eventScheduleId: 'none', observationBudget: 0});
assert.equal(abstain.status, 'LOSE');
console.log(JSON.stringify({schemaVersion: 'cpir-web/aoc-dp-oracle-v1-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 6, result: {onlyOracleTables: true, contingentPolicyRecovered: true, budgetFailClosed: true}, warning: 'DP remains candidate-equivalent-to-bounded-pomdp-until-proven-otherwise'}, null, 2));
