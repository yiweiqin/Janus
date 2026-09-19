#!/usr/bin/env node
import assert from 'node:assert/strict';
import {buildConflictRegistry} from './ubuddy-cpir-web-conflict-registry-v0.mjs';

const matrixEvaluate = matrix => (world, action) => {
  const verdict = matrix[world.id][action.id];
  return verdict === 'SAFE_TERMINAL'
    ? {disposition: 'SAFE', terminalDisposition: 'SAFE'}
    : verdict === 'VIOLATED'
      ? {disposition: 'VIOLATED', terminalDisposition: 'VIOLATED', obligations: [{obligationId: 'O_TEST', verdict: 'VIOLATED', code: `FAIL_${action.id}`}]} 
      : {disposition: 'UNKNOWN', terminalDisposition: 'UNKNOWN', obligations: [{obligationId: 'O_UNKNOWN', verdict: 'UNKNOWN', code: `MISSING_${action.id}`}]};
};
const worlds = ids => ids.map(id => ({id}));
const actions = ids => ids.map(id => ({id}));
const edge = (registry, kind, set) => registry.edges.find(item => item.kind === kind && item.minimalWorldSet.join('|') === set.join('|'));

let registry = buildConflictRegistry({
  worlds: worlds(['w1', 'w2']), actions: actions(['a', 'b']),
  evaluate: matrixEvaluate({w1: {a: 'SAFE_TERMINAL', b: 'VIOLATED'}, w2: {a: 'VIOLATED', b: 'SAFE_TERMINAL'}})
});
assert.ok(edge(registry, 'HARD_CONFLICT', ['w1', 'w2']));
assert.deepEqual(registry.infeasibleSingletons, []);

registry = buildConflictRegistry({
  worlds: worlds(['w1', 'w2', 'w3']), actions: actions(['a', 'b', 'c']),
  evaluate: matrixEvaluate({
    w1: {a: 'SAFE_TERMINAL', b: 'SAFE_TERMINAL', c: 'VIOLATED'},
    w2: {a: 'VIOLATED', b: 'SAFE_TERMINAL', c: 'SAFE_TERMINAL'},
    w3: {a: 'SAFE_TERMINAL', b: 'VIOLATED', c: 'SAFE_TERMINAL'}
  })
});
assert.equal(registry.edges.filter(item => item.kind === 'HARD_CONFLICT').length, 1);
assert.ok(edge(registry, 'HARD_CONFLICT', ['w1', 'w2', 'w3']));
assert.equal(registry.edges.filter(item => item.kind === 'HARD_CONFLICT' && item.minimalWorldSet.length === 2).length, 0);

registry = buildConflictRegistry({
  worlds: worlds(['w1', 'w2']), actions: actions(['probe']),
  evaluate: matrixEvaluate({w1: {probe: 'UNKNOWN'}, w2: {probe: 'SAFE_TERMINAL'}})
});
assert.ok(edge(registry, 'EPISTEMIC_BLOCKAGE', ['w1']));

registry = buildConflictRegistry({
  worlds: worlds(['w-infeasible']), actions: actions(['a', 'b']),
  evaluate: matrixEvaluate({ 'w-infeasible': {a: 'VIOLATED', b: 'VIOLATED'} })
});
assert.deepEqual(registry.infeasibleSingletons, ['w-infeasible']);
assert.equal(registry.edges.length, 0);

const duplicated = buildConflictRegistry({
  worlds: worlds(['w1', 'w1-copy', 'w2']), actions: actions(['a', 'b']),
  evaluate: matrixEvaluate({
    w1: {a: 'SAFE_TERMINAL', b: 'VIOLATED'},
    'w1-copy': {a: 'SAFE_TERMINAL', b: 'VIOLATED'},
    w2: {a: 'VIOLATED', b: 'SAFE_TERMINAL'}
  })
});
assert.ok(edge(duplicated, 'HARD_CONFLICT', ['w1', 'w2']));
assert.deepEqual(duplicated.equivalenceClasses, [['w1', 'w1-copy'], ['w2']]);

console.log(JSON.stringify({
  schemaVersion: 'cpir-web/conflict-registry-test/v0',
  implementationStatus: 'research-prototype/unverified',
  allPassed: true,
  caseCount: 5,
  edgeKinds: [...new Set(registry.edges.map(item => item.kind))]
}, null, 2));
