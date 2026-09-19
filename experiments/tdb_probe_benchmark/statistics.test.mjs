import test from 'node:test';
import assert from 'node:assert/strict';
import { benjaminiHochberg, bootstrapCI, comparePolicies, pairedEffect } from './statistics.mjs';

function row(familyId, heuristic, learned, noop = 0, oracle = 1) {
  return { familyId, outcomes: {
    heuristic: { netGain: heuristic }, learned: { netGain: learned }, noop: { netGain: noop }, oracle: { netGain: oracle }
  } };
}

test('family paired effect collapses repeated rows before inference', () => {
  const predictions = [row('f1', .2, .8), row('f1', .4, .6), row('f2', .1, .3)];
  const effect = pairedEffect(predictions, 'learned', 'heuristic');
  assert.equal(effect.length, 2); assert.equal(effect[0].familyId, 'f1'); assert.ok(Math.abs(effect[0].difference - .4) < 1e-12); assert.ok(Math.abs(effect[1].difference - .2) < 1e-12);
});

test('bootstrap is family clustered and deterministic', () => {
  const a = bootstrapCI([1, 2, 3], 9, 1000);
  const b = bootstrapCI([1, 2, 3], 9, 1000);
  assert.deepEqual(a, b); assert.equal(a.clusters, 3); assert.ok(a.lower <= 2 && a.upper >= 2);
});

test('FDR correction is monotonic and preserves comparison order', () => {
  const out = benjaminiHochberg([{ name: 'a', pValue: .01 }, { name: 'b', pValue: .2 }, { name: 'c', pValue: .03 }]);
  assert.deepEqual(out.map(x => x.name), ['a', 'b', 'c']); assert.ok(out[0].qValue <= out[2].qValue); assert.ok(out[1].qValue >= out[2].qValue);
});

test('policy comparison reports effect, paired CI and adjusted q values', () => {
  const rows = [row('f1', .2, .8), row('f2', .1, .4), row('f3', .3, .7)];
  const out = comparePolicies(rows, [['learned', 'heuristic'], ['learned', 'noop']]);
  assert.equal(out.length, 2); assert.ok(out.every(x => Number.isFinite(x.meanDifference) && x.ci95.clusters === 3 && x.qValue >= 0));
});
