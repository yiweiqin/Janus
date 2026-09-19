import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCrossTaskApplicability } from '../../src/shared/contracts/uBuddyCrossTaskApplicability.js';

const bundle = () => ({ taskId: 'task-a', relationType: 'depends_on', state: 'active', observedAt: '2026-09-05T00:00:00.000Z', dimensions: { quality: { score: .9, version: 'q1' } }, evidenceRefs: [{ id: 'ev-1' }] });

test('certifies explicitly bound fresh cross-task evidence', () => {
  const b = bundle();
  const r = assessCrossTaskApplicability({ sourceBundle: b, targetTaskId: 'task-b', targetScope: 'query:accept', expectedSourceTaskId: 'task-a', relationType: 'depends_on', requiredDimensions: ['quality'], now: '2026-09-05T00:30:00.000Z', maxAgeMs: 3600000 });
  assert.equal(r.status, 'CERTIFIED'); assert.equal(r.applicability, 'APPLICABLE'); assert.equal(r.targetTaskId, 'task-b');
});

test('stale or missing bindings remain unknown and blocked', () => {
  const b = bundle();
  assert.equal(assessCrossTaskApplicability({ sourceBundle: b, targetTaskId: 'task-b', targetScope: 'q', now: '2026-09-06T00:00:00Z', maxAgeMs: 3600000 }).reason, 'source_bundle_expired');
  assert.equal(assessCrossTaskApplicability({ sourceBundle: b, targetTaskId: '', targetScope: 'q', now: '2026-09-05T00:00:00Z', maxAgeMs: 1 }).applicability, 'BLOCKED');
});

test('conflicting source bundle is never certified', () => {
  const b = { ...bundle(), state: 'conflict' };
  assert.equal(assessCrossTaskApplicability({ sourceBundle: b, targetTaskId: 'task-b', targetScope: 'q', now: '2026-09-05T00:00:00Z', maxAgeMs: 3600000 }).status, 'CONFLICT');
});
