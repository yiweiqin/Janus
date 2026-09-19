import { createInMemoryTdbSnapshotStore } from './uBuddyTdbSnapshotStore.js';

/**
 * Schema agnostic database boundary for task dependency bundle (TDB)
 * snapshots.  The application depends on this small capability contract;
 * a PostgreSQL/SQLite/KV implementation can be supplied without exposing
 * its tables or migration details to graph/projection code.
 *
 * Methods may be synchronous or Promise returning.  `transact` is the sole
 * mutation primitive and must provide optimistic version and idempotency
 * semantics.  `verifyReplayToken` must never silently accept a missing or
 * divergent replay.
 */
export const UBUDDY_TDB_DATABASE_ADAPTER_VERSION = 'ubuddy_tdb_database_adapter_v1';

export const TDB_DATABASE_ADAPTER_METHODS = Object.freeze([
  'transact', 'load', 'getVersion', 'verifyReplayToken',
]);

export function isTdbDatabaseAdapter(value) {
  return Boolean(value && typeof value === 'object'
    && TDB_DATABASE_ADAPTER_METHODS.every((method) => typeof value[method] === 'function'));
}

/** Return a structured result rather than throwing so callers can gate writes. */
export function validateTdbDatabaseAdapter(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'adapter_required', adapterVersion: UBUDDY_TDB_DATABASE_ADAPTER_VERSION };
  }
  const missing = TDB_DATABASE_ADAPTER_METHODS.filter((method) => typeof value[method] !== 'function');
  return missing.length
    ? { ok: false, reason: 'adapter_method_missing', missing, adapterVersion: UBUDDY_TDB_DATABASE_ADAPTER_VERSION }
    : { ok: true, adapterVersion: UBUDDY_TDB_DATABASE_ADAPTER_VERSION };
}

/**
 * Wrap an adapter call in an explicit transaction callback.  Database backed
 * adapters can override this with a real BEGIN/COMMIT implementation; the
 * fallback preserves the contract for adapters whose `transact` is atomic.
 */
export async function withTdbTransaction(adapter, callback) {
  const check = validateTdbDatabaseAdapter(adapter);
  if (!check.ok) return check;
  if (typeof adapter.withTransaction === 'function') return adapter.withTransaction(callback);
  return callback(adapter);
}

/**
 * A deterministic fake database adapter for contract tests and local graph
 * construction. It intentionally uses the existing in-memory snapshot store
 * and exposes asynchronous methods, matching a real database client.
 */
export function createFakeTdbDatabaseAdapter(options = {}) {
  const store = options.store || (typeof options.createStore === 'function'
    ? options.createStore() : createInMemoryTdbSnapshotStore());
  const adapter = {
    adapterVersion: UBUDDY_TDB_DATABASE_ADAPTER_VERSION,
    async transact(key, payload = {}) { return store.transact(key, payload); },
    async save(key, payload = {}, options = {}) { return store.save(key, payload, options); },
    async load(key) { return store.load(key); },
    async getVersion(key) { return store.getVersion(key); },
    async verifyReplayToken(key, options = {}) { return store.verifyReplayToken(key, options); },
    async withTransaction(callback) { return callback(adapter); },
    get size() { return store.size; },
    _store: store,
  };
  return adapter;
}

/**
 * Build a schema-agnostic adapter over a pool exposing `query()` and (for
 * writes) `connect()`.  SQL is intentionally kept in this boundary: callers
 * only see the TDB contract and no migration is performed.  Deployments can
 * override table/column identifiers to match an existing persistence schema.
 */
export function createTdbDatabaseAdapterFromPool(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function') return null;
  const table = quoteIdent(options.table || 'cloud_tdb_snapshots');
  const columns = {
    key: quoteIdent(options.keyColumn || 'snapshot_key'),
    version: quoteIdent(options.versionColumn || 'version'),
    payload: quoteIdent(options.payloadColumn || 'payload_json'),
    operation: quoteIdent(options.operationColumn || 'operation_id'),
    updatedAt: quoteIdent(options.updatedAtColumn || 'updated_at'),
  };
  const parse = options.parseRow || mapTdbSnapshotRow;
  const adapter = {
    adapterVersion: UBUDDY_TDB_DATABASE_ADAPTER_VERSION,
    async load(key) {
      const result = await pool.query(`SELECT * FROM ${table} WHERE ${columns.key} = $1 LIMIT 1`, [String(key || '')]);
      return result?.rows?.[0] ? parse(result.rows[0]) : null;
    },
    async getVersion(key) {
      const result = await pool.query(`SELECT ${columns.version} AS version FROM ${table} WHERE ${columns.key} = $1 LIMIT 1`, [String(key || '')]);
      return Number(result?.rows?.[0]?.version || 0);
    },
    async verifyReplayToken(key, input = {}) {
      const row = await adapter.load(key);
      if (!row) return { ok: false, reason: 'snapshot_missing', key: String(key || '') };
      const token = String(input.replayToken || input.snapshot?.replayToken || row.snapshot?.replayToken || '');
      const expected = String(row.snapshot?.replayToken || row.replayToken || '');
      if (!token) return { ok: false, reason: 'replay_token_missing', key: String(key || ''), expected };
      if (expected && token !== expected) return { ok: false, reason: 'replay_token_mismatch', key: String(key || ''), expected, actual: token };
      return { ok: true, key: String(key || ''), replayToken: token, snapshot: row.snapshot || row };
    },
    async transact(key, payload = {}) {
      const id = String(key || '').trim();
      if (!id) return { ok: false, reason: 'key_required' };
      if (typeof pool.connect !== 'function') return { ok: false, reason: 'transaction_unavailable' };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(`SELECT * FROM ${table} WHERE ${columns.key} = $1 FOR UPDATE`, [id]);
        const row = current?.rows?.[0];
        const currentVersion = Number(row?.[columns.version.replaceAll('"', '')] ?? row?.version ?? 0);
        if (payload.expectedVersion !== undefined && Number(payload.expectedVersion) !== currentVersion) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'version_conflict', key: id, expectedVersion: Number(payload.expectedVersion), currentVersion };
        }
        if (payload.operationId && row && String(row[columns.operation.replaceAll('"', '')] ?? row.operation_id ?? '') === String(payload.operationId)) {
          await client.query('COMMIT');
          return { ok: true, idempotentReplay: true, version: currentVersion, record: parse(row) };
        }
        const nextVersion = currentVersion + 1;
        const json = JSON.stringify({ seed: payload.seed || {}, events: payload.events || [], metadata: payload.metadata || {} });
        const sql = row
          ? `UPDATE ${table} SET ${columns.version}=$2, ${columns.payload}=$3, ${columns.operation}=$4, ${columns.updatedAt}=CURRENT_TIMESTAMP WHERE ${columns.key}=$1`
          : `INSERT INTO ${table} (${columns.key},${columns.version},${columns.payload},${columns.operation},${columns.updatedAt}) VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`;
        await client.query(sql, [id, nextVersion, json, String(payload.operationId || '')]);
        await client.query('COMMIT');
        return { ok: true, version: nextVersion, record: { key: id, version: nextVersion, payload: JSON.parse(json) } };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        return { ok: false, reason: 'persistence_error', errorCode: String(error?.code || 'unknown') };
      } finally { client.release?.(); }
    },
  };
  return adapter;
}

export function mapTdbSnapshotRow(row = {}) {
  let payload = row.payload_json ?? row.payload ?? {};
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
  return { key: String(row.snapshot_key ?? row.key ?? ''), version: Number(row.version || 0), ...payload, payload };
}

function quoteIdent(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new TypeError('invalid SQL identifier');
  return `"${text}"`;
}
