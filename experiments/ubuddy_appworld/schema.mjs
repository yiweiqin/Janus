import crypto from 'node:crypto';

export const BENCHMARK_VERSION = 'ubuddy_appworld_hybrid_v1';
export const APPWORLD_VERSION = 'appworld_acl24';
export const METHODS = ['M0_single_agent', 'M1_static_profile', 'M2_generic_shared', 'M3_ours'];
export const EVENT_KINDS = [
  'task_created', 'profile_query', 'selection_confirmed', 'subtask_created',
  'dependency_created', 'execution_started', 'state_published', 'result_submitted',
  'result_superseded', 'execution_failed', 'execution_retried', 'official_evaluated',
  'attribution_generated', 'evolution_routed', 'evolution_adopted', 'evolution_blocked',
];

export function nowIso() { return new Date().toISOString(); }
export function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
export function makeEvent({ eventKind, episodeId, actorUserId = 'requester', sourceKind, sourceId, metadata = {} }) {
  if (!EVENT_KINDS.includes(eventKind)) throw new Error(`unknown event kind: ${eventKind}`);
  return { eventKind, episodeId, actorUserId, sourceKind, sourceId, metadata, occurredAt: nowIso() };
}
