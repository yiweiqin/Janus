#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createOracle, digest, evaluate, materializeOracleTables, validateOracleManifest} from './ubuddy-cpir-web-oracle-v1.mjs';

const manifest = {
  schemaVersion: 'cpir-web/oracle/v1', manifestId: 'locked-pairs-v1',
  contractRegistryHash: digest('contract-registry/v1', {id: 'c1'}),
  observationProjectorHash: digest('observation-projector/v1', {fields: ['cause', 'status']}),
  transitionVerifierHash: digest('transition-verifier/v1', {version: 'finite-step-v1'}),
  trustRootHashes: [digest('trust-root/v1', {id: 'oauth'}), digest('trust-root/v1', {id: 'sink'})],
  observationProjector: {fields: ['status', 'cause']}, budget: {maxCost: 5},
  actions: [
    {id: 'retry', cost: 2, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'precommit', op: 'EQ', left: {path: 'world.hiddenCause'}, right: {value: 'pre-commit'}, violationReason: 'DUPLICATE_EFFECT'}], increments: [{path: 'effectCount', by: {value: 1}}]}},
    {id: 'abstain', cost: 0, effectClass: 'READ_ONLY', transition: {guards: []}}
  ],
  probes: [{id: 'status-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'cause', path: 'world.hiddenCause'}], guards: []}],
  faultSchedules: [{id: 'clean', events: []}, {id: 'timeout', events: [{id: 'drop-1', fault: 'TIMEOUT'}]}],
  worlds: [
    {id: 'w-safe', publicObservation: {status: 'timeout', cause: 'hidden'}, hiddenCause: 'pre-commit', initialState: {activationVector: {pageEpoch: 1}, version: 'v1', effectCount: 0}},
    {id: 'w-committed', publicObservation: {status: 'timeout', cause: 'hidden'}, hiddenCause: 'post-commit', initialState: {activationVector: {pageEpoch: 1}, version: 'v1', effectCount: 1}}
  ]
};

assert.equal(validateOracleManifest(manifest).valid, true);
const oracle = createOracle(manifest);
const first = oracle.evaluate('w-safe', 'retry', 'clean', 5);
const second = oracle.evaluate('w-safe', 'retry', 'clean', 5);
assert.equal(first.verdict, 'SAFE');
assert.deepEqual(first, second);
assert.equal(first.canonicalObservation.status, 'timeout');
assert.equal(first.cost, 2);
assert.equal(first.linearizationWitness.actionId, 'retry');
assert.notEqual(first.preStateHash, first.postStateHash);

assert.equal(oracle.evaluate('w-safe', 'retry', 'timeout', 5).verdict, 'UNKNOWN');
assert.equal(oracle.evaluate('w-safe', 'retry', 'missing', 5).reasonCode, 'FAULT_SCHEDULE_NOT_DECLARED');
assert.equal(oracle.evaluate('missing-world', 'retry', 'clean', 5).reasonCode, 'WORLD_NOT_DECLARED');
assert.equal(oracle.evaluate('w-safe', 'missing-action', 'clean', 5).reasonCode, 'ACTION_OR_PROBE_NOT_DECLARED');
assert.equal(oracle.evaluate('w-safe', 'retry', 'clean', 1).reasonCode, 'OBSERVATION_BUDGET_EXCEEDED');

const dependent = structuredClone(manifest); dependent.worlds[0].policy = 'cpir';
assert.equal(validateOracleManifest(dependent).valid, false);
assert.match(oracle.evaluate('w-safe', 'retry', 'clean', 5).schemaVersion, /oracle\/v1/);

const duplicate = structuredClone(manifest); duplicate.actions.push({...duplicate.actions[0]});
assert.equal(validateOracleManifest(duplicate).valid, false);
assert.equal(evaluate(duplicate, 'w-safe', 'retry').verdict, 'UNKNOWN');

const tables = materializeOracleTables(manifest, {eventScheduleId: 'clean', observationBudget: 5});
assert.equal(tables.tables.actionResults['w-committed'].retry.verdict, 'VIOLATED');
assert.equal(tables.tables.probeResults['w-safe']['status-probe'].canonicalObservation.cause, 'pre-commit');

console.log(JSON.stringify({schemaVersion: 'cpir-web/oracle-v1-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 16, result: {deterministic: true, candidateIndependentValidation: true, unknownOnFaultOrBound: true, duplicateIdRejected: true, tablesMaterialized: true}, warning: 'finite-declared-manifest-only; no-real-browser-authority-or-durable-sink'}, null, 2));
