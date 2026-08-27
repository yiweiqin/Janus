import crypto from 'node:crypto';

export const BENCHMARK_VERSION = 'ubuddy_orgbench_v1';
export const METHODS = ['M0_single_ubuddy', 'M1_static_profile', 'M2_generic_shared', 'M3_ours'];
export const LAYERS = ['requester_ubuddy', 'recipient_ubuddy', 'internal_agent', 'environment'];
export const EVENT_KINDS = [
  'project_created', 'profile_queried', 'ubuddy_invited', 'selection_snapshot_frozen',
  'task_node_created', 'dependency_created', 'task_assigned', 'internal_agent_selected',
  'execution_started', 'progress_published', 'handoff_published', 'handoff_superseded',
  'execution_failed', 'execution_retried', 'requirement_revised', 'task_replanned',
  'result_accepted', 'result_rejected', 'project_evaluated', 'attribution_generated',
  'evolution_routed', 'evolution_adopted', 'evolution_blocked', 'evolution_rolled_back',
  'organization_policy_applied',
];

export function nowIso() { return new Date().toISOString(); }
export function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
export function seededId(prefix, seed, index = 0) { return `${prefix}_${sha256(`${prefix}:${seed}:${index}`).slice(0, 10)}`; }

export function makeEvent({ eventKind, episodeId, actorId, actorLayer, sourceKind, sourceId, metadata = {} }) {
  if (!EVENT_KINDS.includes(eventKind)) throw new Error(`unknown_event_kind:${eventKind}`);
  if (!LAYERS.includes(actorLayer)) throw new Error(`unknown_actor_layer:${actorLayer}`);
  return { eventKind, episodeId, actorId, actorLayer, sourceKind, sourceId, metadata, occurredAt: nowIso() };
}

export function methodFeatures(method) {
  return {
    M0_single_ubuddy: { multiUbuddy: false, profileVersioning: false, sharedState: false, resultVersioning: false, attributionGate: false },
    M1_static_profile: { multiUbuddy: true, profileVersioning: false, sharedState: false, resultVersioning: false, attributionGate: false },
    M2_generic_shared: { multiUbuddy: true, profileVersioning: false, sharedState: 'plain', resultVersioning: false, attributionGate: false },
    M3_ours: { multiUbuddy: true, profileVersioning: true, sharedState: 'gcsG', resultVersioning: true, attributionGate: true },
  }[method];
}

export function publicProfile(profile, method) {
  const base = {
    ubuddyId: profile.ubuddyId,
    ownerUserId: profile.ownerUserId,
    displayName: profile.displayName,
    capabilities: [...profile.capabilities],
    supportedTaskTypes: [...profile.supportedTaskTypes],
    availability: profile.availability,
    visibility: profile.visibility,
  };
  if (method === 'M1_static_profile' || method === 'M2_generic_shared') return base;
  return { ...base, revision: profile.revision, contentHash: profile.contentHash, confidence: profile.confidence, evidenceSupport: profile.evidenceSupport };
}

export function redactPrivate(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (['memory', 'skill', 'privateBody', 'localPath', 'cookie', 'privateConversation', 'hiddenTruth'].includes(key)) return undefined;
    return item;
  }));
}
