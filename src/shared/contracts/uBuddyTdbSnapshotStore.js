import {
  normalizeTaskDependencyBundle,
  taskDependencyBundleReplaySnapshot,
} from './uBuddyTaskDependencyBundle.js';

/**
 * Small persistence boundary for TDB replay snapshots.
 *
 * The adapter is deliberately storage agnostic: production callers can wrap
 * the same contract with a database later, while tests and graph builders can
 * use this deterministic in-memory implementation today. Events are retained
 * only inside the adapter so verifyReplayToken can replay the exact input.
 */
export class InMemoryTdbSnapshotStore {
  #records = new Map();
  #operations = new Map();

  save(key, payload = {}, options = {}) {
    const input = payload && typeof payload === 'object' ? payload : {};
    return this.transact(key, { ...input, ...options });
  }

  /**
   * Atomic, storage-agnostic write boundary. `expectedVersion` provides
   * optimistic concurrency; `operationId` makes retries idempotent.
   * Adapters backed by SQL/KV stores can implement this same contract with a
   * compare-and-swap transaction without exposing their schema here.
   */
  transact(key, { events = [], seed = {}, metadata = {}, expectedVersion, operationId = '' } = {}) {
    const id = normalizeKey(key);
    if (!id) return { ok: false, reason: 'key_required' };
    const op = normalizeOperation(operationId);
    if (op) {
      const prior = this.#operations.get(`${id}:${op}`);
      if (prior) return { ...clone(prior), idempotentReplay: true };
    }
    const previous = this.#records.get(id);
    const currentVersion = Number(previous?.version || 0);
    if (expectedVersion !== undefined && Number(expectedVersion) !== currentVersion) {
      return { ok: false, reason: 'version_conflict', key: id, expectedVersion: Number(expectedVersion), currentVersion };
    }
    const normalizedSeed = normalizeTaskDependencyBundle(seed);
    const retainedEvents = clone(Array.isArray(events) ? events : []);
    const snapshot = taskDependencyBundleReplaySnapshot(retainedEvents, normalizedSeed);
    const record = Object.freeze({
      key: id,
      version: currentVersion + 1,
      snapshot,
      seed: clone(normalizedSeed),
      events: retainedEvents,
      metadata: cloneObject(metadata),
      savedAt: new Date().toISOString(),
    });
    this.#records.set(id, record);
    const result = { ok: true, record: clone(record), version: record.version };
    if (op) this.#operations.set(`${id}:${op}`, clone(result));
    return result;
  }

  getVersion(key) { return Number(this.#records.get(normalizeKey(key))?.version || 0); }

  load(key) {
    const record = this.#records.get(normalizeKey(key));
    return record ? clone(record) : null;
  }

  verifyReplayToken(key, { events, seed, replayToken = '' } = {}) {
    const id = normalizeKey(key);
    const record = this.#records.get(id);
    if (!record) return { ok: false, reason: 'snapshot_missing', key: id };
    const suppliedEvents = events === undefined ? record.events : events;
    const suppliedSeed = seed === undefined ? record.seed : seed;
    const replay = taskDependencyBundleReplaySnapshot(suppliedEvents, suppliedSeed);
    const expected = String(record.snapshot.replayToken || '');
    const actual = String(replay.replayToken || replayToken || '');
    if (!actual) return { ok: false, reason: 'replay_token_missing', key: id, expected };
    if (actual !== expected) {
      return { ok: false, reason: 'replay_token_mismatch', key: id, expected, actual };
    }
    return { ok: true, key: id, replayToken: actual, snapshot: clone(record.snapshot) };
  }

  delete(key) { return this.#records.delete(normalizeKey(key)); }
  clear() { this.#records.clear(); }
  get size() { return this.#records.size; }
}

export function createInMemoryTdbSnapshotStore() {
  return new InMemoryTdbSnapshotStore();
}

function normalizeKey(value) { return String(value || '').trim().slice(0, 240); }
function normalizeOperation(value) { return String(value || '').trim().slice(0, 240); }

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cloneObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
}
