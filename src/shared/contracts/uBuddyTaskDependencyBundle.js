import crypto from 'node:crypto';

export const UBUDDY_TDB_VERSION = 'ubuddy_task_dependency_bundle_v1';
export const TDB_DIMENSIONS = Object.freeze([
  'data', 'logic', 'quality', 'freshness', 'review', 'capability',
  'resource', 'risk', 'downstreamImpact', 'uncertainty',
]);
export const TDB_EVENT_KINDS = Object.freeze([
  'planned', 'published', 'consumed', 'reviewed', 'timeout', 'retry',
  'handoff', 'version_changed', 'resource_changed', 'failed', 'completed',
]);

// Runtime event names are intentionally kept outside the persistence schema.
// This adapter gives old task_events/cloud_task_events rows a stable, typed
// relation-time interpretation while retaining their original event ids.
export const RUNTIME_EVENT_TO_TDB_KIND = Object.freeze({
  task_created: 'planned', task_assigned: 'planned', delegation_assigned: 'planned',
  task_published: 'published', result_published: 'published', submitted: 'published',
  result_consumed: 'consumed', task_consumed: 'consumed',
  reviewed: 'reviewed', review_started: 'reviewed', validation_passed: 'reviewed',
  timeout: 'timeout', task_timeout: 'timeout',
  retry: 'retry', execution_retried: 'retry', retry_started: 'retry',
  handoff: 'handoff', delegation_handoff: 'handoff',
  version_changed: 'version_changed', result_superseded: 'version_changed',
  resource_changed: 'resource_changed',
  failed: 'failed', execution_failed: 'failed', task_failed: 'failed',
  completed: 'completed', task_completed: 'completed', execution_completed: 'completed',
});

/** Fold persisted runtime events into relation-and-time bound TDB snapshots. */
export function taskDependencyBundleTraceFromEvents(events = [], seed = {}) {
  const ordered = (Array.isArray(events) ? events : []).map((event, index) => ({ event, index }))
    .sort((a, b) => String(a.event?.createdAt || a.event?.created_at || '').localeCompare(String(b.event?.createdAt || b.event?.created_at || ''))
      || String(a.event?.id || '').localeCompare(String(b.event?.id || '')) || a.index - b.index);
  let current = normalizeTaskDependencyBundle(seed);
  const trace = [];
  for (const { event } of ordered) {
    const payload = objectValue(event?.payload || event?.payload_json);
    const rawKind = clean(event?.eventType || event?.event_type || payload.eventType || payload.event_type, 80);
    const kind = RUNTIME_EVENT_TO_TDB_KIND[rawKind] || (TDB_EVENT_KINDS.includes(rawKind) ? rawKind : '');
    if (!kind) continue;
    const result = applyTaskDependencyBundleEvent(current, {
      kind,
      sequence: event?.sequence,
      observedAt: event?.createdAt || event?.created_at,
      evidenceRefs: [{ kind: 'task_event', id: event?.id }],
      dimensions: payload.dimensions || payload.dependencyDimensions || payload.tdbDimensions,
      bundle: {
        taskId: current.taskId || event?.taskRunId || event?.task_run_id,
        edgeId: current.edgeId || event?.edgeId || event?.edge_id,
        sourceNodeId: current.sourceNodeId || event?.sourceNodeId || event?.source_node_id || event?.taskNodeId || event?.task_node_id,
        targetNodeId: current.targetNodeId || event?.targetNodeId || event?.target_node_id,
        sourceAgentId: current.sourceAgentId || event?.ownerUserId || event?.owner_user_id,
        targetAgentId: current.targetAgentId || event?.userAgentInstanceId || event?.user_agent_instance_id,
        relationType: current.relationType || event?.relationType || event?.relation_type || 'delegates_to',
        ownerUserId: current.ownerUserId || event?.ownerUserId || event?.owner_user_id,
      },
    });
    current = result.bundle;
    trace.push({ ...current, eventId: clean(event?.id, 240), eventType: rawKind, eventPayloadKeys: Object.keys(payload).sort() });
  }
  return trace;
}

/**
 * Produce a deterministic replay snapshot for audit and reproducibility.
 * The token commits to the normalized seed and canonically ordered runtime
 * events; the trace/final hashes make divergence detectable without exposing
 * private event payloads to callers.
 */
export function taskDependencyBundleReplaySnapshot(events = [], seed = {}) {
  const normalizedSeed = normalizeTaskDependencyBundle(seed);
  const normalizedEvents = canonicalReplayEvents(events);
  const trace = taskDependencyBundleTraceFromEvents(events, normalizedSeed);
  const finalBundle = trace.length ? normalizeTaskDependencyBundle(trace[trace.length - 1]) : normalizedSeed;
  const traceHash = sha256(canonicalJson(trace.map((item) => normalizeTaskDependencyBundle(item))));
  const replayToken = sha256(canonicalJson({ version: UBUDDY_TDB_VERSION, seed: normalizedSeed, events: normalizedEvents }));
  return Object.freeze({
    version: UBUDDY_TDB_VERSION,
    eventCount: normalizedEvents.length,
    orderedEventIds: normalizedEvents.map((event) => event.id).filter(Boolean),
    initialHash: taskDependencyBundleHash(normalizedSeed),
    finalHash: taskDependencyBundleHash(finalBundle),
    traceHash,
    replayToken,
  });
}

/** Alias emphasizing that replay uses the same canonical fold as runtime. */
export function replayTaskDependencyBundleTrace(events = [], seed = {}) {
  return taskDependencyBundleTraceFromEvents(events, seed);
}

/**
 * Canonical task-scoped relation state. This is an in-memory/shared-contract
 * primitive; persistence and transport layers may wrap it without changing
 * its identity or evidence semantics.
 */
export function normalizeTaskDependencyBundle(value = {}) {
  const source = objectValue(value);
  const dimensions = Object.fromEntries(TDB_DIMENSIONS.map((key) => [key, normalizeDimension(source.dimensions?.[key] || source[key]) ]));
  return {
    version: clean(source.version) || UBUDDY_TDB_VERSION,
    taskId: clean(source.taskId || source.task_id, 200),
    edgeId: clean(source.edgeId || source.edge_id, 200),
    sourceNodeId: clean(source.sourceNodeId || source.source_node_id, 200),
    targetNodeId: clean(source.targetNodeId || source.target_node_id, 200),
    sourceAgentId: clean(source.sourceAgentId || source.source_agent_id, 200),
    targetAgentId: clean(source.targetAgentId || source.target_agent_id, 200),
    relationType: clean(source.relationType || source.relation_type, 100),
    state: clean(source.state || 'planned', 40),
    sequence: nonNegativeInt(source.sequence),
    observedAt: iso(source.observedAt || source.observed_at),
    dimensions,
    evidenceRefs: normalizeRefs(source.evidenceRefs || source.evidence_refs),
    ownerUserId: clean(source.ownerUserId || source.owner_user_id, 200),
    obligationStatus: clean(source.obligationStatus || source.obligation_status || 'unresolved', 40),
    contractHash: clean(source.contractHash || source.contract_hash, 200),
  };
}

export function applyTaskDependencyBundleEvent(current = null, event = {}) {
  const incoming = objectValue(event);
  const kind = clean(incoming.kind || incoming.eventKind || incoming.event_kind, 40);
  if (!TDB_EVENT_KINDS.includes(kind)) return { changed: false, action: 'invalid_event', bundle: normalizeTaskDependencyBundle(current || {}) };
  const previous = normalizeTaskDependencyBundle(current || {});
  const next = normalizeTaskDependencyBundle({
    ...previous,
    ...(objectValue(incoming.bundle) || {}),
    state: kind,
    sequence: Math.max(previous.sequence + 1, nonNegativeInt(incoming.sequence)),
    observedAt: incoming.observedAt || incoming.observed_at || new Date().toISOString(),
    evidenceRefs: [...previous.evidenceRefs, ...normalizeRefs(incoming.evidenceRefs || incoming.evidence_refs)],
    dimensions: { ...previous.dimensions, ...objectValue(incoming.dimensions) },
  });
  return { changed: JSON.stringify(previous) !== JSON.stringify(next), action: 'applied', bundle: next };
}

export function taskDependencyBundleHash(value = {}) {
  const normalized = normalizeTaskDependencyBundle(value);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function canonicalReplayEvents(events) {
  return (Array.isArray(events) ? events : []).map((event, index) => {
    const payload = objectValue(event?.payload || event?.payload_json);
    return {
      id: clean(event?.id, 240),
      eventType: clean(event?.eventType || event?.event_type || payload.eventType || payload.event_type, 80),
      sequence: nonNegativeInt(event?.sequence),
      createdAt: iso(event?.createdAt || event?.created_at),
      taskRunId: clean(event?.taskRunId || event?.task_run_id, 200),
      edgeId: clean(event?.edgeId || event?.edge_id, 200),
      payload,
      _index: index,
    };
  }).sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
    : a.id < b.id ? -1 : a.id > b.id ? 1 : a._index - b._index)
    .map(({ _index, ...event }) => event);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function normalizeDimension(value = {}) {
  const source = typeof value === 'number' ? { score: value } : objectValue(value);
  const raw = Number(source.score ?? source.value ?? 0);
  return {
    score: Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0,
    version: clean(source.version || source.revision, 120),
    confidence: bounded(source.confidence, 0, 1),
    explanation: clean(source.explanation || source.reason, 400),
  };
}

function normalizeRefs(value = []) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item) => {
    const source = typeof item === 'string' ? { id: item } : objectValue(item);
    const id = clean(source.id || source.refId || source.ref_id, 240);
    if (!id || seen.has(id)) return null;
    seen.add(id);
    return { kind: clean(source.kind || source.type || 'evidence', 80), id, label: clean(source.label || source.title, 240) };
  }).filter(Boolean).slice(0, 50);
}
function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}
function clean(value = '', max = 240) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function bounded(value, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0; }
function nonNegativeInt(value) { const n = Math.floor(Number(value || 0)); return Number.isFinite(n) ? Math.max(0, n) : 0; }
function iso(value = '') { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : ''; }
