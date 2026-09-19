#!/usr/bin/env node
import assert from 'node:assert/strict';
import {findOneMinimalObstruction} from './ubuddy-cpir-web-aoc-deletion-baseline-v0.mjs';
import {buildConflictRegistry} from './ubuddy-cpir-web-conflict-registry-v0.mjs';

const worlds = ['w1', 'w2', 'w3'].map(id => ({id}));
const actions = ['a', 'b', 'c'].map(id => ({id}));
const table = {
  w1: {a: 'SAFE_TERMINAL', b: 'SAFE_TERMINAL', c: 'VIOLATED'},
  w2: {a: 'VIOLATED', b: 'SAFE_TERMINAL', c: 'SAFE_TERMINAL'},
  w3: {a: 'SAFE_TERMINAL', b: 'VIOLATED', c: 'SAFE_TERMINAL'}
};
const evaluate = (world, action) => table[world.id][action.id] === 'SAFE_TERMINAL'
  ? {disposition: 'SAFE', terminalDisposition: 'SAFE'} : {disposition: 'VIOLATED', terminalDisposition: 'VIOLATED'};

const deletion = findOneMinimalObstruction({worlds, actions, evaluate, targetKind: 'HARD_CONFLICT'});
const exhaustive = buildConflictRegistry({worlds, actions, evaluate});
assert.equal(deletion.status, 'FOUND');
assert.deepEqual(deletion.minimalWorldSet, ['w1', 'w2', 'w3']);
assert.deepEqual(deletion.minimalWorldSet, exhaustive.edges[0].minimalWorldSet);
assert.equal(deletion.oracleCalls, 9);
assert.equal(deletion.completenessScope, 'NOT_ALL_CORES');
assert.equal(findOneMinimalObstruction({worlds: [{id: 'w1'}, {id: 'w1'}], actions, evaluate}).reasonCode, 'DUPLICATE_WORLD_ID');

console.log(JSON.stringify({schemaVersion: 'cpir-web/aoc-deletion-baseline-test/v0', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 6, result: 'GENERIC_DELETION_BASELINE_MATCHES_EXHAUSTIVE_CORE', warning: 'negative-novelty-evidence'}, null, 2));

