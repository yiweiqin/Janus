import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UBUDDY_TDB_DATABASE_ADAPTER_VERSION,
  createFakeTdbDatabaseAdapter,
  isTdbDatabaseAdapter,
  validateTdbDatabaseAdapter,
  withTdbTransaction,
  createTdbDatabaseAdapterFromPool,
  mapTdbSnapshotRow,
} from '../../src/shared/contracts/uBuddyTdbDatabaseAdapter.js';

const seed = { taskId: 'task-db', edgeId: 'edge-db', sourceNodeId: 'a', targetNodeId: 'b' };
const events = [{ id: 'e1', event_type: 'task_created', created_at: '2026-09-05T00:00:00Z' }];

test('database adapter contract validates required schema-agnostic methods', () => {
  assert.equal(validateTdbDatabaseAdapter(null).reason, 'adapter_required');
  const missing = validateTdbDatabaseAdapter({ load() {} });
  assert.equal(missing.reason, 'adapter_method_missing');
  assert.deepEqual(missing.missing.sort(), ['getVersion', 'transact', 'verifyReplayToken']);
  const adapter = createFakeTdbDatabaseAdapter();
  assert.equal(isTdbDatabaseAdapter(adapter), true);
  assert.equal(validateTdbDatabaseAdapter(adapter).adapterVersion, UBUDDY_TDB_DATABASE_ADAPTER_VERSION);
});

test('fake database adapter preserves transaction conflict, idempotency and replay verification', async () => {
  const adapter = createFakeTdbDatabaseAdapter();
  const first = await adapter.transact('task-db', { seed, events, expectedVersion: 0, operationId: 'op-db' });
  assert.equal(first.ok, true);
  assert.equal(first.version, 1);
  const retry = await adapter.transact('task-db', { seed, events: [], expectedVersion: 0, operationId: 'op-db' });
  assert.equal(retry.idempotentReplay, true);
  const conflict = await adapter.transact('task-db', { seed, events: [], expectedVersion: 0, operationId: 'op-other' });
  assert.equal(conflict.reason, 'version_conflict');
  assert.equal((await adapter.verifyReplayToken('task-db')).ok, true);
});

test('withTdbTransaction uses adapter transaction boundary when available', async () => {
  const adapter = createFakeTdbDatabaseAdapter();
  const result = await withTdbTransaction(adapter, async (tx) => tx.transact('task-db', { seed, events }));
  assert.equal(result.ok, true);
});

test('pool adapter maps rows and exposes conservative transaction errors', async () => {
  const rows = [];
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      if (sql.startsWith('SELECT *')) return { rows };
      if (sql.startsWith('SELECT "version"')) return { rows };
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('INSERT')) { rows.push({ snapshot_key: params[0], version: params[1], payload_json: params[2], operation_id: params[3] }); return { rows: [] }; }
      return { rows: [] };
    }, release() {},
  };
  const pool = { query: client.query.bind(client), async connect() { return client; } };
  const adapter = createTdbDatabaseAdapterFromPool(pool);
  assert.deepEqual(mapTdbSnapshotRow({ snapshot_key: 'k', version: 2, payload_json: '{"snapshot":{"replayToken":"r"}}' }).snapshot.replayToken, 'r');
  assert.equal((await adapter.transact('k', { expectedVersion: 0, operationId: 'op' })).ok, true);
  assert.equal((await adapter.transact('k', { expectedVersion: 0, operationId: 'other' })).reason, 'version_conflict');
  rows[0].payload_json = JSON.stringify({ snapshot: { replayToken: 'expected' } });
  assert.equal((await adapter.verifyReplayToken('k', { replayToken: 'bad' })).reason, 'replay_token_mismatch');
  assert.ok(queries.some((sql) => sql === 'BEGIN'));
});
