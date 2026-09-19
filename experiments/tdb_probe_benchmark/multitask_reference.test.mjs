import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './multitask_reference.mjs';

test('finite-world projection reference is independent and solver agrees', () => {
  const result = run({ families: 24, seed: 20260907 });
  assert.equal(result.counts.test, 7);
  assert.equal(result.metrics.testProjectionAccuracy, 1);
  assert.equal(result.metrics.testPrivacySafeRate, 1);
  assert.ok(result.rows.every(row => row.projectionCorrect));
});

test('ambiguous state is UNKNOWN instead of fabricated certainty', () => {
  const result = run({ families: 24, seed: 20260907 });
  const ambiguous = result.rows.filter(row => !row.stateKnown);
  assert.ok(ambiguous.length > 0);
  assert.ok(ambiguous.every(row => row.statePrediction.status === 'UNKNOWN'));
});

test('finite-world metrics are explicitly not real-world claims', () => {
  const result = run({ families: 24, seed: 20260907 });
  assert.equal(result.evidenceLevel, 'SYNTHETIC_FINITE_WORLD_ONLY');
  assert.match(result.limitations.join(' '), /human gold/);
});
