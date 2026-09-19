import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMinimumDisclosure } from '../../src/shared/contracts/uBuddyDisclosureFrontier.js';

test('finite disclosure frontier finds minimum cost subset by brute force', () => {
  const result = findMinimumDisclosure({
    binding: { scope: 'task-1', version: 'v1', query: 'accept_result' }, currentWorldId: 'w1', epsilon: 0,
    worlds: [
      { id: 'w1', support: true, values: { quality: 'good', unused: null }, utilities: { accept: 1, retry: 0 }, safe: { accept: true, retry: true } },
      { id: 'w2', support: true, values: { quality: 'bad', unused: null }, utilities: { accept: 0, retry: 1 }, safe: { accept: true, retry: true } },
    ],
    initial: {}, units: [{ id: 'quality', cost: 2, allowed: true }, { id: 'unused', cost: 5, allowed: true }],
  });
  assert.deepEqual(result.selectedUnits, ['quality']);
  assert.equal(result.disclosureCost, 2);
  assert.equal(result.status, 'CERTIFIED');
  assert.equal(Object.hasOwn(result, 'currentWorldId'), false);
});

test('unknown on invalid, unsupported, or no frontier', () => {
  assert.equal(findMinimumDisclosure({ binding: {}, worlds: [], units: [] }).status, 'UNKNOWN');
  assert.equal(findMinimumDisclosure({ binding: {}, currentWorldId: 'w', worlds: [{ id: 'w', values: {}, utilities: { a: 1 }, safe: { a: false } }], units: [] }).status, 'UNKNOWN');
});

test('dominance reduction preserves oracle optimum and reports eliminated equivalent units', () => {
  const input = {
    binding: { scope: 'task-1', version: 'v1', query: 'accept_result' }, currentWorldId: 'w1', epsilon: 0,
    worlds: [
      { id: 'w1', support: true, values: { cheap: 'a', duplicate: 'a', split: 0 }, utilities: { accept: 1, retry: 0 }, safe: { accept: true, retry: true } },
      { id: 'w2', support: true, values: { cheap: 'b', duplicate: 'b', split: 1 }, utilities: { accept: 0, retry: 1 }, safe: { accept: true, retry: true } },
    ], initial: {},
    units: [
      { id: 'cheap', cost: 1, allowed: true },
      { id: 'duplicate', cost: 4, allowed: true },
      { id: 'split', cost: 9, allowed: true },
    ],
  };
  const result = findMinimumDisclosure(input);
  assert.equal(result.status, 'CERTIFIED');
  assert.deepEqual(result.selectedUnits, ['cheap']);
  assert.equal(result.disclosureCost, 1);
  assert.equal(result.diagnostics.dominatedUnits, 1);
});

