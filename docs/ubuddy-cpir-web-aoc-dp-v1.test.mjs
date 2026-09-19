#!/usr/bin/env node
import assert from 'node:assert/strict';
import {solveObservationAwareAoc} from './ubuddy-cpir-web-aoc-dp-v1.mjs';

const worldIds = ['w1', 'w2'];
const actionIds = ['left-submit', 'right-submit'];
const probes = [{id: 'identity-probe', cost: 1}];
const oracleTables = {
  actionResults: {w1: {'left-submit': {verdict: 'SAFE'}, 'right-submit': {verdict: 'VIOLATED'}}, w2: {'left-submit': {verdict: 'VIOLATED'}, 'right-submit': {verdict: 'SAFE'}}},
  probeResults: {w1: {'identity-probe': {verdict: 'SAFE', canonicalObservation: {side: 'left'}}, noop: {verdict: 'SAFE', canonicalObservation: {side: 'same'}}}, w2: {'identity-probe': {verdict: 'SAFE', canonicalObservation: {side: 'right'}}, noop: {verdict: 'SAFE', canonicalObservation: {side: 'same'}}}}
};

const withProbe = solveObservationAwareAoc({worldIds, actionIds, probes, oracleTables, budget: 1});
assert.equal(withProbe.status, 'WIN');
assert.equal(withProbe.root.probeId, 'identity-probe');
assert.equal(withProbe.root.children.length, 2);

const withoutProbe = solveObservationAwareAoc({worldIds, actionIds, probes, oracleTables, budget: 0});
assert.equal(withoutProbe.status, 'LOSE');
assert.equal(withoutProbe.root.reasonCode, 'NO_UNIVERSALLY_SAFE_ACTION_OR_SEPARATING_PROBE');

const uninformative = solveObservationAwareAoc({worldIds, actionIds, probes: [{id: 'noop', cost: 1}], oracleTables, budget: 1});
assert.equal(uninformative.status, 'LOSE');

const skipBadProbe = solveObservationAwareAoc({worldIds, actionIds, probes: [{id: 'noop', cost: 1}, ...probes], oracleTables, budget: 1});
assert.equal(skipBadProbe.status, 'WIN');
assert.equal(skipBadProbe.root.probeId, 'identity-probe');

assert.throws(() => solveObservationAwareAoc({worldIds, actionIds, probes, oracleTables, evaluate: () => ({verdict: 'SAFE'}), budget: 1}), /FORBIDDEN/);

console.log(JSON.stringify({schemaVersion: 'cpir-web/aoc-dp-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 8, result: {separatingProbeFindsContingentPolicy: true, noProbeAbstains: true, uninformativeProbeAbstains: true, badProbeDoesNotMaskWinningProbe: true}, warning: 'candidate-equivalent-to-bounded-pomdp-until-proven-otherwise'}, null, 2));
