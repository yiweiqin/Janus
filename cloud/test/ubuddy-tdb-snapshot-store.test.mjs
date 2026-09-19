import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryTdbSnapshotStore } from '../../src/shared/contracts/uBuddyTdbSnapshotStore.js';

const seed = { taskId: 'task-1', edgeId: 'edge-1', sourceNodeId: 'alice', targetNodeId: 'bob' };
const events = [
  { id: 'e1', event_type: 'task_created', created_at: '2026-09-05T00:00:00.000Z' },
  { id: 'e2', event_type: 'completed', created_at: '2026-09-05T00:00:01.000Z' },
];

test('in-memory TDB snapshot save/load is immutable and replay-verifiable', () => {
  const store = createInMemoryTdbSnapshotStore();
  const saved = store.save('task-1', { seed, events, metadata: { source: 'test' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.record.snapshot.replayToken.length, 64);
  const loaded = store.load('task-1');
  loaded.events[0].id = 'tampered';
  loaded.snapshot.replayToken = 'tampered';
  assert.equal(store.load('task-1').events[0].id, 'e1');
  assert.equal(store.load('task-1').snapshot.replayToken.length, 64);
  assert.equal(store.verifyReplayToken('task-1').ok, true);
});

test('replay token verification detects changed event identity or seed', () => {
  const store = createInMemoryTdbSnapshotStore();
  store.save('task-2', { seed, events });
  const changed = [{ ...events[0] }, { ...events[1], id: 'e3' }];
  const mismatch = store.verifyReplayToken('task-2', { events: changed });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'replay_token_mismatch');
  assert.equal(store.verifyReplayToken('missing').reason, 'snapshot_missing');
});

test('save rejects empty keys and replaces a key deterministically', () => {
  const store = createInMemoryTdbSnapshotStore();
  assert.equal(store.save('', { events }).reason, 'key_required');
  store.save('task-3', { seed, events });
  store.save('task-3', { seed, events: [] });
  assert.equal(store.size, 1);
  assert.equal(store.verifyReplayToken('task-3').ok, true);
});

test('transaction enforces optimistic version and exposes monotonic versions', () => {
  const store = createInMemoryTdbSnapshotStore();
  const first = store.transact('task-v', { seed, events, expectedVersion: 0 });
  assert.equal(first.ok, true);
  assert.equal(first.version, 1);
  assert.equal(store.getVersion('task-v'), 1);
  const conflict = store.transact('task-v', { seed, events: [], expectedVersion: 0 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'version_conflict');
  assert.equal(conflict.currentVersion, 1);
  const second = store.transact('task-v', { seed, events: [], expectedVersion: 1 });
  assert.equal(second.version, 2);
});

test('operation id makes transaction retries idempotent', () => {
  const store = createInMemoryTdbSnapshotStore();
  const request = { seed, events, expectedVersion: 0, operationId: 'op-1' };
  const first = store.transact('task-idem', request);
  const retry = store.transact('task-idem', { ...request, events: [] });
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotentReplay, true);
  assert.equal(retry.version, first.version);
  assert.equal(store.getVersion('task-idem'), 1);
});
