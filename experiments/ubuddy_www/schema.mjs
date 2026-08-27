import crypto from 'node:crypto';

// The primary WWW backend is now the public WebArena-Verified release.  The
// WorkArena++ adapter remains available as a legacy backend, but new run
// metadata must not silently claim that a mock/legacy run is WebArena-Verified.
export const BENCHMARK_VERSION = 'ubuddy_webarena_verified_v1';
export const METHODS = ['M0_single_agent', 'M1_static_profile', 'M2_generic_shared', 'M3_ours'];
export const EVENTS = [
  'task_created', 'profile_queried', 'delegation_created', 'profile_snapshot_frozen',
  'browser_action', 'state_checkpoint', 'execution_failed', 'retry_started',
  'requirement_revised', 'dependency_reordered', 'result_submitted',
  'result_superseded', 'result_adopted', 'official_evaluation',
];
export const ARTIFACT_FILES = [
  'config.json', 'official_task.json', 'profiles.json', 'candidate_queries.jsonl',
  'selection_snapshots.jsonl', 'subtasks.json', 'fault_manifest.json', 'events.jsonl',
  'official_evaluation.json', 'agent_responses.jsonl', 'attribution.json', 'evolution_update.json', 'metrics.json',
  'errors.jsonl', 'janus_api.jsonl', 'model_usage.jsonl',
];

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function nowIso() { return new Date().toISOString(); }

export function assertEpisodeConfig(config) {
  if (!config || config.benchmark !== BENCHMARK_VERSION) throw new Error('invalid_benchmark_version');
  if (!config.episodeId || !config.officialTaskId || !Number.isInteger(Number(config.seed))) throw new Error('invalid_episode_identity');
  if (!METHODS.includes(config.method)) throw new Error('invalid_method');
  if (!['natural', 'controlled'].includes(config.condition)) throw new Error('invalid_condition');
  return true;
}

export function assertEvent(event) {
  if (!event || !EVENTS.includes(event.eventKind)) throw new Error(`invalid_event_kind:${event?.eventKind || ''}`);
  if (!event.episodeId || !event.eventId || !event.occurredAt) throw new Error('invalid_event_identity');
  if (event.eventKind === 'browser_action' && !event.actorUbuddyId) throw new Error('browser_action_actor_required');
  return true;
}

export function publicBrowserEvent({ episodeId, eventId, actorUbuddyId, subtaskId = '', action = '', stepIndex = 0, url = '', observedStateHash = '', occurredAt = nowIso() } = {}) {
  return {
    eventKind: 'browser_action', episodeId, eventId, actorUbuddyId, subtaskId,
    action, stepIndex: Number(stepIndex), url: url ? sha256(url).slice(0, 16) : '', observedStateHash,
    occurredAt,
  };
}

export function redactPrivateMetadata(value) {
  const input = value && typeof value === 'object' ? value : {};
  const allowed = ['status', 'summary', 'resultRef', 'coveredRevision', 'visibility', 'sourceKind', 'sourceId'];
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
}

export function makeOfficialEvaluation({ success = false, officialSuccess = success, reward = 0, subtaskRewards = [], evaluator = '', evaluatorVersion = evaluator || 'workarena++:unavailable', unexpectedChanges = [], raw = null } = {}) {
  return { officialSuccess: Boolean(officialSuccess), reward: Number(reward), subtaskRewards: subtaskRewards.map(Number), evaluatorVersion, unexpectedChanges, raw };
}
