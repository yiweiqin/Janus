import { taskDependencyBundleReplaySnapshot } from '../../../../src/shared/contracts/uBuddyTaskDependencyBundle.js';

/**
 * Read and verify a persisted TDB replay snapshot without exposing storage
 * schema to graph code.  The helper is deliberately read only: callers may
 * pass a pool adapter or an in-memory adapter, but no mutation is performed.
 */
export async function readTdbSnapshot(adapter, { key, events = [], seed = {} } = {}) {
  if (!adapter || typeof adapter.load !== 'function') return { ok: false, reason: 'adapter_load_required' };
  const snapshotKey = String(key || '').trim();
  if (!snapshotKey) return { ok: false, reason: 'key_required' };
  const expected = taskDependencyBundleReplaySnapshot(events, seed);
  let stored;
  try { stored = await adapter.load(snapshotKey); } catch (error) {
    return { ok: false, reason: 'persistence_unavailable', key: snapshotKey, errorCode: String(error?.code || 'unknown') };
  }
  if (!stored) return { ok: false, reason: 'snapshot_missing', key: snapshotKey, expectedReplayToken: expected.replayToken };
  // Read exactly once: a second load in verifyReplayToken could see a newer
  // version. Recompute from the immutable replay input, never a claimed token.
  if (String(stored.key || '') !== snapshotKey || !Number.isSafeInteger(stored.version) || stored.version < 1) {
    return { ok: false, reason: 'snapshot_identity_invalid', key: snapshotKey };
  }
  if (!stored.seed || typeof stored.seed !== 'object' || Array.isArray(stored.seed) || !Array.isArray(stored.events)) {
    return { ok: false, reason: 'replay_input_missing', key: snapshotKey };
  }
  const actual = taskDependencyBundleReplaySnapshot(stored.events, stored.seed);
  if (stored.snapshot && ['replayToken', 'initialHash', 'finalHash', 'traceHash'].some((field) => stored.snapshot[field] !== actual[field])) {
    return { ok: false, reason: 'stored_snapshot_divergent', key: snapshotKey };
  }
  if (actual.replayToken !== expected.replayToken) {
    return { ok: false, reason: 'replay_token_mismatch', key: snapshotKey,
      expectedReplayToken: expected.replayToken, actualReplayToken: actual.replayToken };
  }
  const snapshot = Object.fromEntries(['version', 'initialHash', 'finalHash', 'traceHash', 'replayToken', 'eventCount'].map((field) => [field, actual[field]]));
  return { ok: true, key: snapshotKey, replayToken: expected.replayToken,
    storageVersion: stored.version, snapshot };
}
