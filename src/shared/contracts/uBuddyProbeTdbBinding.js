/**
 * Bidirectional binding between Probe source events and a TDB replay snapshot.
 * A replay may only support a Probe when both sides commit to the same event
 * identity set and the same deterministic snapshot hashes. Missing or stale
 * material is deliberately UNKNOWN; this helper does not infer causality.
 */
import crypto from 'node:crypto';
import { taskDependencyBundleReplaySnapshot } from './uBuddyTaskDependencyBundle.js';

export const UBUDDY_PROBE_TDB_BINDING_VERSION = 'probe-tdb-binding-v1';
const text = (v) => String(v ?? '').trim();
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const refs = (v) => Array.from(new Set((Array.isArray(v) ? v : (v == null ? [] : [v]))
  .map((x) => text(x && typeof x === 'object' ? (x.eventRef ?? x.sourceId ?? x.id ?? x.ref) : x)).filter(Boolean))).sort();
const idsHash = (ids) => sha256(canonical(refs(ids)));

/** Validate Probe event refs against an expected or recomputed TDB replay. */
export function validateProbeTdbReplayBinding({
  sourceEventRefs = [], sourceIds = [], sourceEventRefBindingHash = '',
  replaySnapshot = null, replayEvents = null, tdbSeed = null,
  expectedReplayToken = '', expectedTraceHash = '', expectedInitialHash = '', expectedFinalHash = '',
  requireExactEventSet = true,
} = {}) {
  const fail = (reason, extra = {}) => ({ status: 'UNKNOWN', ok: false, reason, ...extra });
  const supplied = refs([...refs(sourceEventRefs), ...refs(sourceIds)]);
  if (!supplied.length) return fail('tdb_probe_source_events_missing');
  let snapshot = replaySnapshot && typeof replaySnapshot === 'object' ? replaySnapshot : null;
  if (!snapshot) {
    if (!Array.isArray(replayEvents) || !tdbSeed || typeof tdbSeed !== 'object') return fail('tdb_replay_snapshot_missing');
    snapshot = taskDependencyBundleReplaySnapshot(replayEvents, tdbSeed);
  }
  const ordered = refs(snapshot.orderedEventIds);
  if (!ordered.length) return fail('tdb_replay_events_missing', { replayToken: text(snapshot.replayToken) || null });
  const probeRefsHash = idsHash(supplied);
  const replayRefsHash = idsHash(ordered);
  if (requireExactEventSet ? probeRefsHash !== replayRefsHash : !supplied.every((id) => ordered.includes(id))) {
    return fail('tdb_probe_event_set_mismatch', { probeEventRefsHash: probeRefsHash, replayEventRefsHash: replayRefsHash, probeEventCount: supplied.length, replayEventCount: ordered.length });
  }
  if (sourceEventRefBindingHash && text(sourceEventRefBindingHash) !== probeRefsHash) return fail('tdb_probe_event_hash_mismatch', { probeEventRefsHash: probeRefsHash });
  const checks = [['replayToken', expectedReplayToken], ['traceHash', expectedTraceHash], ['initialHash', expectedInitialHash], ['finalHash', expectedFinalHash]];
  for (const [field, expected] of checks) if (text(expected) && text(snapshot[field]) !== text(expected)) return fail(`tdb_${field}_mismatch`, { expected: text(expected), actual: text(snapshot[field]) });
  return { status: 'CERTIFIED', ok: true, contractVersion: UBUDDY_PROBE_TDB_BINDING_VERSION, replayToken: text(snapshot.replayToken), traceHash: text(snapshot.traceHash), initialHash: text(snapshot.initialHash), finalHash: text(snapshot.finalHash), orderedEventIds: ordered, probeEventRefsHash: probeRefsHash, replayEventRefsHash: replayRefsHash };
}

