import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMinimumDisclosure } from '../../src/shared/contracts/uBuddyDisclosureFrontier.js';

const base = { binding: { scope: 's', version: 'v1', query: 'q' }, currentWorldId: 'w1', epsilon: 0, initial: {} };

test('triple-world conflict is solved by one splitting disclosure', () => {
  const result = findMinimumDisclosure({ ...base, worlds: [
    { id: 'w1', support: true, values: { quality: 'a' }, utilities: { a: 3, b: 0, c: 2 }, safe: { a: true, b: true, c: true } },
    { id: 'w2', support: true, values: { quality: 'b' }, utilities: { a: 0, b: 3, c: 2 }, safe: { a: true, b: true, c: true } },
    { id: 'w3', support: true, values: { quality: 'c' }, utilities: { a: 2, b: 0, c: 3 }, safe: { a: true, b: true, c: true } },
  ], units: [{ id: 'quality', cost: 2, allowed: true }] });
  assert.equal(result.status, 'CERTIFIED'); assert.deepEqual(result.selectedUnits, ['quality']);
});

test('unsafe high utility is excluded from regret baseline', () => {
  const result = findMinimumDisclosure({ ...base, worlds: [{ id: 'w1', support: true, values: {}, utilities: { safe: 4, bad: 100 }, safe: { safe: true, bad: false } }], units: [] });
  assert.equal(result.status, 'CERTIFIED'); assert.deepEqual(result.selectedUnits, []);
});

test('missing disclosed values and no safe action are conservative', () => {
  const missing = findMinimumDisclosure({ ...base, worlds: [{ id: 'w1', support: true, values: {}, utilities: { a: 1 }, safe: { a: true } }], units: [{ id: 'x', cost: 1, allowed: true }] });
  assert.equal(missing.status, 'UNKNOWN'); assert.equal(missing.reason, 'observable_value_invalid');
  const none = findMinimumDisclosure({ ...base, worlds: [{ id: 'w1', support: true, values: { x: 1 }, utilities: { a: 1 }, safe: { a: false } }], units: [{ id: 'x', cost: 1, allowed: true }] });
  assert.equal(none.status, 'UNKNOWN');
});

test('zero-cost ties choose the empty disclosure and expose bounded diagnostics', () => {
  const result = findMinimumDisclosure({ ...base, worlds: [{ id: 'w1', support: true, values: { a: 1, b: 1 }, utilities: { ok: 1 }, safe: { ok: true } }], units: [{ id: 'b', cost: 0, allowed: true }, { id: 'a', cost: 0, allowed: true }] });
  assert.deepEqual(result.selectedUnits, []); assert.equal(result.disclosureCost, 0);
  assert.ok(result.diagnostics.visitedSubsets >= 1); assert.ok(result.diagnostics.evaluatedPartitions >= 1);
});

test('conflict branching respects undecided units and preserves lower-cost optimum', () => {
  const result = findMinimumDisclosure({ ...base, worlds: [
    { id: 'w1', support: true, values: { a: 0, b: 'x' }, utilities: { a: 1, b: 0 }, safe: { a: true, b: false } },
    { id: 'w2', support: true, values: { a: 1, b: 'y' }, utilities: { a: 0, b: 1 }, safe: { a: false, b: true } },
  ], units: [
    { id: 'a', cost: 10, allowed: true },
    { id: 'b', cost: 1, allowed: true },
  ] });
  assert.equal(result.status, 'CERTIFIED');
  assert.deepEqual(result.selectedUnits, ['b']);
  assert.equal(result.diagnostics.dominatedUnits, 0);
  assert.equal(result.disclosureCost, 1);
});


test('interval utilities can invalidate a point-certified disclosure and require disclosure', () => {
  const point = findMinimumDisclosure({ ...base, worlds: [
    { id: 'w1', support: true, values: { quality: 'a' }, utilities: { a: 1, b: 0 }, safe: { a: true, b: true } },
    { id: 'w2', support: true, values: { quality: 'b' }, utilities: { a: 1, b: 0 }, safe: { a: true, b: true } },
  ], units: [{ id: 'quality', cost: 1, allowed: true }] });
  assert.equal(point.status, 'CERTIFIED'); assert.deepEqual(point.selectedUnits, []);
  const interval = findMinimumDisclosure({ ...base, worlds: [
    { id: 'w1', support: true, values: { quality: 'a' }, utilityInterval: { a: [0, 1], b: [0, 0] }, safe: { a: true, b: true } },
    { id: 'w2', support: true, values: { quality: 'b' }, utilityInterval: { a: [0, 1], b: [2, 2] }, safe: { a: true, b: true } },
  ], units: [{ id: 'quality', cost: 1, allowed: true }] });
  assert.equal(interval.status, 'CERTIFIED'); assert.deepEqual(interval.selectedUnits, ['quality']);
});

test('invalid utility intervals fail closed', () => {
  const result = findMinimumDisclosure({ ...base, worlds: [{ id: 'w1', support: true, values: {}, utilityInterval: { a: { lower: 2, upper: 1 } }, safe: { a: true } }], units: [] });
  assert.equal(result.status, 'UNKNOWN'); assert.equal(result.reason, 'utility_interval_invalid');
});

test('initial observations condition the disclosure world model', () => {
  const input = { ...base, initial: { phase: 'ready' }, worlds: [
    { id: 'w1', support: true, values: { phase: 'ready' }, utilities: { a: 1, b: 0 }, safe: { a: true, b: false } },
    { id: 'w2', support: true, values: { phase: 'stale' }, utilities: { a: 0, b: 1 }, safe: { a: false, b: true } },
  ], units: [] };
  const got = findMinimumDisclosure(input); assert.equal(got.status, 'CERTIFIED'); assert.deepEqual(got.selectedUnits, []); assert.equal(got.reason, undefined);
  assert.equal(findMinimumDisclosure({ ...input, initial: {} }).status, 'UNKNOWN');
  assert.equal(findMinimumDisclosure({ ...input, initial: { phase: 'impossible' } }).reason, 'initial_observation_inconsistent');
  assert.equal(findMinimumDisclosure({ ...input, currentWorldId: 'w2' }).reason, 'current_world_initial_inconsistent');
});

test('disclosure risk budget constrains admissible actions', () => {
  const got = findMinimumDisclosure({ ...base, riskBudget: 0, worlds: [{ id: 'w1', support: true, values: {}, utilities: { a: 2, b: 1 }, safe: { a: true, b: true }, risk: { a: 4, b: 0 } }], units: [] });
  assert.equal(got.status, 'UNKNOWN');
  const impossible = findMinimumDisclosure({ ...base, riskBudget: 0, worlds: [{ id: 'w1', support: true, values: {}, utilities: { a: 2 }, safe: { a: true }, risk: { a: 4 } }], units: [] });
  assert.equal(impossible.status, 'UNKNOWN');
});
