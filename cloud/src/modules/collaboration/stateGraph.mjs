import {
  capabilitySelectionSnapshotFromDelegation,
  visibleCapabilityProfiles,
} from './capabilitySelection.mjs';
import { normalizeTaskDependencyBundle, taskDependencyBundleHash, taskDependencyBundleTraceFromEvents, taskDependencyBundleReplaySnapshot } from '../../../../src/shared/contracts/uBuddyTaskDependencyBundle.js';
import { createHash } from 'node:crypto';
import { assessDecisionSufficiency } from '../../../../src/shared/contracts/uBuddyDecisionSufficiency.js';
import { assessCrossTaskApplicability } from '../../../../src/shared/contracts/uBuddyCrossTaskApplicability.js';
import { readTdbSnapshot } from './tdbSnapshotRead.mjs';

const GRAPH_VERSION = 'ubuddy_collaboration_state_graph_v1';
const ATTRIBUTION_VERSION = 'ubuddy_process_attribution_v1';

export async function buildCollaborationStateGraph(pool, { viewerUserId = '', groupId = '', delegationId = '', apiError = defaultApiError, tdbSnapshotStore = null, tdbDatabaseAdapter = null } = {}) {
  const scope = await resolveCollaborationScope(pool, { viewerUserId, groupId, delegationId, apiError });
  const delegations = scope.delegations;
  const userIds = unique([
    scope.group?.owner_user_id,
    ...delegations.flatMap((item) => [item.requester_user_id, item.recipient_user_id]),
  ]);
  const users = await usersById(pool, userIds);
  const capabilitySnapshots = await visibleCapabilitySnapshots(pool, { viewerUserId, userIds });
  const nodes = userIds.map((userId) => ({
    id: `ubuddy:${userId}`,
    kind: 'ubuddy',
    userId,
    displayName: users.get(userId)?.display_name || users.get(userId)?.email || userId,
    role: roleForUser(scope, userId),
    capabilityProfile: capabilitySnapshots.find((item) => item.ownerUserId === userId) || null,
    selectionSnapshot: delegations
      .map((item) => capabilitySelectionSnapshotFromDelegation(item))
      .find((item) => item?.recipientProfile?.ownerUserId === userId) || null,
  }));
  const edges = delegations.map((item) => ({
    id: `delegation:${item.id}`,
    kind: 'delegation',
    from: `ubuddy:${item.requester_user_id}`,
    to: `ubuddy:${item.recipient_user_id}`,
    delegationId: item.id,
    dependencyOf: String((jsonObject(item.metadata_json).dependencyOf || jsonObject(item.metadata_json).dependsOn || '') || ''),
    status: normalizeStatus(item.status),
    title: item.title || '',
    updatedAt: toIso(item.updated_at),
  }));
  const stateItems = await stateItemsForDelegations(pool, delegations);
  const resultVersions = await resultVersionsForDelegations(pool, delegations);
  const selectionSnapshots = delegations.map((item) => ({
    delegationId: item.id,
    snapshot: capabilitySelectionSnapshotFromDelegation(item),
  })).filter((item) => item.snapshot);
  const tdbBundles = await Promise.all(delegations.map(async (item) => {
    const metadata = jsonObject(item.metadata_json);
    const raw = metadata.taskDependencyBundle || metadata.dependencyBundle || metadata.tdb || {};
    const bundle = normalizeTaskDependencyBundle({ ...raw, taskId: raw.taskId || item.task_run_id || item.id,
      edgeId: raw.edgeId || `delegation:${item.id}`, sourceNodeId: raw.sourceNodeId || item.requester_user_id,
      targetNodeId: raw.targetNodeId || item.recipient_user_id, sourceAgentId: raw.sourceAgentId || item.requester_user_id,
      targetAgentId: raw.targetAgentId || item.recipient_user_id, relationType: raw.relationType || 'delegates_to' });
    const eventQuery = item.task_run_id ? await optionalManyWithAvailability(pool,
      'SELECT id,task_node_id,event_type,owner_user_id,user_agent_instance_id,payload_json,created_at FROM cloud_task_events WHERE task_run_id=$1 ORDER BY created_at,id', [item.task_run_id]) : { rows: [], available: true, reason: 'no_task_run' };
    const eventRows = eventQuery.rows;
    const replayEvents = eventRows.map((row) => ({
      id: row.id, event_type: row.event_type, task_node_id: row.task_node_id,
      owner_user_id: row.owner_user_id, user_agent_instance_id: row.user_agent_instance_id,
      payload_json: row.payload_json, created_at: row.created_at,
    }));
    const traceBase = taskDependencyBundleTraceFromEvents(replayEvents, bundle);
    const replaySnapshot = taskDependencyBundleReplaySnapshot(replayEvents, bundle);
    const replayStore = await snapshotStoreForGraph(tdbSnapshotStore, tdbDatabaseAdapter, item, replayEvents, bundle, replaySnapshot);
    const eventById = new Map(eventRows.map((row) => [String(row.id || ''), row]));
    const trace = traceBase.map((snapshot) => {
      const source = eventById.get(String(snapshot.eventId || '')) || {};
      return ({
      ...snapshot,
      taskNodeId: String(source.task_node_id || ''),
      actorUserId: String(source.owner_user_id || ''),
      agentInstanceId: String(source.user_agent_instance_id || ''),
      hash: taskDependencyBundleHash(snapshot),
    });
    });
    const current = trace.at(-1) || bundle;
    const latestEventAt = eventRows.map((row) => toIso(row.created_at)).filter(Boolean).at(-1) || '';
    return { ...current, delegationId: item.id, provenance: raw && Object.keys(raw).length ? 'declared_bundle' : 'event_reduced_bundle', hash: taskDependencyBundleHash(current), trace,
      replaySnapshot, replayStore,
      providerAvailability: { source: 'cloud_task_events', available: eventQuery.available, reason: eventQuery.reason,
        taskRunId: String(item.task_run_id || ''), snapshotAt: latestEventAt, eventCount: eventRows.length } };
  }));
  return {
    graphVersion: GRAPH_VERSION,
    viewerUserId,
    scope: { groupId: scope.group?.id || '', delegationId: scope.delegation?.id || '' },
    nodes,
    edges,
    stateItems,
    resultVersions,
    capabilitySnapshots,
    selectionSnapshots,
    tdbBundles,
    tdbProviderAvailability: summarizeTdbProviderAvailability(tdbBundles),
  };
}

export async function buildCollaborationAttribution(pool, { viewerUserId = '', delegationId = '', apiError = defaultApiError } = {}) {
  const scope = await resolveCollaborationScope(pool, { viewerUserId, delegationId, apiError });
  const delegation = scope.delegation;
  const revisions = await many(pool, 'SELECT * FROM agent_delegation_revisions WHERE delegation_id=$1 ORDER BY created_at,id', [delegation.id]);
  const taskEvents = delegation.task_run_id
    ? await many(pool, 'SELECT * FROM cloud_task_events WHERE task_run_id=$1 ORDER BY created_at,id', [delegation.task_run_id])
    : [];
  const attributionTdbSeed = normalizeTaskDependencyBundle({
    taskId: delegation.task_run_id || delegation.id,
    edgeId: `delegation:${delegation.id}`,
    sourceNodeId: delegation.requester_user_id,
    targetNodeId: delegation.recipient_user_id,
    sourceAgentId: delegation.requester_user_id,
    targetAgentId: delegation.recipient_user_id,
    relationType: String(jsonObject(delegation.metadata_json).relationType || 'delegates_to'),
  });
  const tdbReplaySnapshot = taskDependencyBundleReplaySnapshot(taskEvents, attributionTdbSeed);
  const organizationTraceEvents = await optionalMany(pool, `SELECT * FROM ubuddy_org_trace_events
    WHERE delegation_id=$1 ORDER BY created_at,id`, [delegation.id]);
  const groupMessages = delegation.group_id
    ? await many(pool, `SELECT * FROM collaboration_group_messages
      WHERE group_id=$1 AND (metadata_json->>'delegationId'=$2 OR source_event_id LIKE $3)
      ORDER BY created_at,id`, [delegation.group_id, delegation.id, `%${delegation.id}%`])
    : [];
  const capabilitySnapshots = await visibleCapabilitySnapshots(pool, {
    viewerUserId,
    userIds: [delegation.requester_user_id, delegation.recipient_user_id],
  });
  const selectionSnapshot = capabilitySelectionSnapshotFromDelegation(delegation);
  const evidenceRefs = await many(pool, `SELECT e.evidence_id,e.source_kind,e.source_id,e.source_version_id,e.delegation_id,e.owner_user_id,
      e.user_agent_instance_id,e.agent_family_id,e.confidence,e.validation_status,e.occurred_at,
      COALESCE(u.evolution_scope,'') AS evolution_scope,COALESCE(u.status,'') AS usage_status
    FROM cloud_evolution_evidence e
    LEFT JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
    WHERE e.delegation_id=$1 OR e.source_id=$1
    ORDER BY COALESCE(e.occurred_at,e.ingested_at),e.evidence_id`, [delegation.id]);
  const trace = [
    ...(selectionSnapshot ? [{
      eventKind: 'capability_profile_selected',
      sourceKind: 'capability_selection_snapshot',
      sourceId: `${delegation.id}:${selectionSnapshot.recipientProfile?.profileRevision || 0}`,
      actorUserId: selectionSnapshot.selectedByUserId || delegation.requester_user_id,
      occurredAt: selectionSnapshot.selectedAt || toIso(delegation.created_at),
      metadata: {
        queryId: selectionSnapshot.queryId || '',
        selectionMode: selectionSnapshot.selectionMode || '',
        selectionReason: selectionSnapshot.selectionReason || '',
        recipientProfileRevision: selectionSnapshot.recipientProfile?.profileRevision || 0,
        recipientContentHash: selectionSnapshot.recipientProfile?.contentHash || '',
      },
    }] : []),
    {
      eventKind: 'task_created',
      sourceKind: 'agent_delegation',
      sourceId: delegation.id,
      actorUserId: delegation.requester_user_id,
      occurredAt: toIso(delegation.created_at),
    },
    {
      eventKind: 'tdb_replay_snapshot',
      sourceKind: 'tdb_replay_snapshot',
      sourceId: `${delegation.id}:${tdbReplaySnapshot.replayToken}`,
      actorUserId: '',
      occurredAt: tdbReplayOccurredAt(taskEvents, delegation),
      metadata: {
        version: tdbReplaySnapshot.version,
        eventCount: tdbReplaySnapshot.eventCount,
        orderedEventIds: tdbReplaySnapshot.orderedEventIds,
        initialHash: tdbReplaySnapshot.initialHash,
        finalHash: tdbReplaySnapshot.finalHash,
        traceHash: tdbReplaySnapshot.traceHash,
        replayToken: tdbReplaySnapshot.replayToken,
      },
    },
    ...capabilitySnapshots.map((item) => ({
      eventKind: 'capability_snapshot_captured',
      sourceKind: 'ubuddy_capability_profile',
      sourceId: `${item.ownerUserId}:${item.profileRevision}`,
      actorUserId: item.ownerUserId,
      occurredAt: item.publishedAt,
      metadata: {
        ownerUserId: item.ownerUserId,
        accessScope: item.accessScope,
        profileRevision: item.profileRevision,
        visibility: item.visibility,
        contentHash: item.contentHash,
      },
    })),
    ...revisions.map((item) => ({
      eventKind: revisionEventKind(item.action),
      sourceKind: 'delegation_revision',
      sourceId: item.id,
      actorUserId: item.author_user_id,
      occurredAt: toIso(item.created_at),
      metadata: publicTraceMetadata(item.metadata_json),
    })),
    ...taskEvents.map((item) => ({
      eventKind: item.event_type || 'task_event',
      sourceKind: 'task_event',
      sourceId: item.id,
      actorUserId: item.owner_user_id,
      occurredAt: toIso(item.created_at),
      metadata: {
        ...publicTraceMetadata(item.payload_json),
        tdbReplayToken: tdbReplaySnapshot.replayToken,
        tdbTraceHash: tdbReplaySnapshot.traceHash,
      },
    })),
    ...organizationTraceEvents.map((item) => ({
      eventKind: item.event_kind || 'organization_trace',
      sourceKind: 'ubuddy_organization_trace',
      sourceId: item.id,
      actorUserId: jsonObject(item.payload_json).actorUserId || jsonObject(item.payload_json).actorId || item.owner_user_id,
      occurredAt: toIso(item.created_at),
      metadata: publicTraceMetadata(item.payload_json),
    })),
    ...groupMessages.map((item) => ({
      eventKind: jsonObject(item.metadata_json).action || item.kind || 'group_message',
      sourceKind: 'collaboration_message',
      sourceId: item.id,
      actorUserId: item.sender_user_id,
      occurredAt: toIso(item.created_at),
      metadata: publicTraceMetadata(item.metadata_json),
    })),
  ].sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)) || String(left.sourceId).localeCompare(String(right.sourceId)));
  const resultVersions = await resultVersionsForDelegations(pool, [delegation]);
  const officialEvaluation = organizationTraceEvents.map((item) => jsonObject(item.payload_json).officialEvaluation).find((item) => item && typeof item === 'object') || null;
  const organizationSignals = organizationSignalsFor({ delegation, selectionSnapshot, revisions, resultVersions, evidenceRefs, organizationTraceEvents, officialEvaluation });
  const individualSignals = individualSignalsFor({ delegation, capabilitySnapshots, selectionSnapshot, revisions, resultVersions, evidenceRefs, organizationTraceEvents, officialEvaluation });
  const missingProfiles = selectionSnapshot
    ? [delegation.recipient_user_id].filter((userId) => selectionSnapshot.recipientProfile?.ownerUserId !== userId)
    : [delegation.recipient_user_id];
  // Attribution does not have a target decision query, so cross-task reuse is
  // conservatively unknown here.  A caller must attach the certified
  // query-conditioned applicability result before routing an evolution
  // candidate.
  const crossTaskApplicability = {
    status: 'UNKNOWN',
    applicability: 'BLOCKED',
    reason: 'cross_task_binding_missing',
  };
  return {
    attributionVersion: ATTRIBUTION_VERSION,
    viewerUserId,
    scope: { groupId: delegation.group_id || '', delegationId: delegation.id },
    trace,
    organizationSignals,
    individualSignals,
    evolutionEvidenceRefs: evidenceRefs.map((row) => evolutionEvidenceRef(row, tdbReplaySnapshot)),
    tdbReplaySnapshot,
    crossTaskApplicability,
    evolutionRouting: {
      personalCandidates: individualSignals.filter((item) => item.confidence >= 0.5 && item.probeSupport?.supported === true && evidenceRefs.length).map((item) => ({
        userId: item.userId,
        agentInstanceId: item.agentInstanceId || '',
        signalKind: item.kind,
        evidenceRefs: item.evidenceRefs,
      })),
      clusterCandidates: organizationSignals.filter((item) => item.confidence >= 0.6 && item.probeSupport?.supported === true && evidenceRefs.length).map((item) => ({
        signalKind: item.kind,
        evidenceRefs: item.evidenceRefs,
      })),
      blockedReasons: [
        { code: 'cross_task_applicability_unknown', status: crossTaskApplicability.status, reason: crossTaskApplicability.reason },
        ...(!selectionSnapshot ? [{ code: 'capability_selection_snapshot_missing', delegationId: delegation.id }] : []),
        ...(missingProfiles.length ? [{ code: 'capability_snapshot_missing', userIds: missingProfiles }] : []),
        ...(!officialEvaluation ? [{ code: 'official_evaluator_missing', delegationId: delegation.id }] : []),
        ...(!evidenceRefs.length ? [{ code: 'evolution_evidence_missing', delegationId: delegation.id }] : []),
        ...(!evidenceAttributionMeta(evidenceRefs).probeSupport.supported ? [{ code: 'probe_support_missing', delegationId: delegation.id }] : []),
      ],
    },
  };
}

// Query-conditioned public semantic projection.  The graph remains the
// backwards-compatible source of truth; this helper exposes only the
// relation state needed by a receiver's current decision.  It is deliberately
// deterministic. This is an authorized-field view, not a sufficiency proof:
// changing a receiver requires rebuilding the source graph under that identity.
export function projectDecisionRelativeGraph(graph = {}, {
  receiverUserId = '',
  decision = 'accept_result',
  requestedFields = [],
  maxItems = 200,
  finiteModel = null,
  modelProvider = null,
  binding = null,
  crossTaskBinding = null,
  sourceBundle = null,
  now = new Date(),
} = {}) {
  const receiver = String(receiverUserId || '').trim();
  const authorizedViewer = String(graph.viewerUserId || '').trim();
  if (!authorizedViewer || !receiver || receiver !== authorizedViewer) {
    throw new TypeError('projection receiver must match the authorized graph viewer');
  }
  const limit = Number.isInteger(maxItems) && maxItems > 0 ? Math.min(maxItems, 1000) : 200;
  const supportedQueries = { accept_result: ['nodes', 'edges', 'resultVersions', 'tdbBundles'], retry_task: ['nodes', 'edges', 'stateItems', 'tdbBundles'] };
  const queryFields = supportedQueries[String(decision || '')];
  if (!queryFields) throw new TypeError(`unsupported decision query: ${String(decision || '')}`);
  const requested = Array.isArray(requestedFields) && requestedFields.length ? requestedFields : queryFields;
  const allowed = new Set(requested.map((field) => String(field || '').trim()));
  if ([...allowed].some((field) => !queryFields.includes(field))) throw new TypeError('requested field is not supported for decision query');
  const include = (field) => allowed.has(field);
  const isParticipant = (id) => String(id || '') === receiver;
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter((edge) =>
    isParticipant(String(edge.to || '').replace(/^ubuddy:/, ''))
    || isParticipant(String(edge.from || '').replace(/^ubuddy:/, '')))
    .slice(0, limit);
  const edgeIds = new Set(edges.map((edge) => String(edge.delegationId || edge.id || '')));
  const stateItems = (Array.isArray(graph.stateItems) ? graph.stateItems : [])
    .filter((item) => !item.owner || edgeIds.has(String(item.owner).replace(/^delegation:/, '')) || isParticipant(String(item.owner).replace(/^ubuddy:/, '')))
    .filter(() => include('stateItems'))
    .slice(0, limit);
  const resultVersions = (Array.isArray(graph.resultVersions) ? graph.resultVersions : [])
    .filter((item) => edgeIds.has(String(item.delegationId || '')))
    .filter((item) => include('resultVersions'))
    .slice(0, limit);
  const tdbBundles = (Array.isArray(graph.tdbBundles) ? graph.tdbBundles : [])
    .filter((item) => edgeIds.has(String(item.delegationId || '').replace(/^delegation:/, ''))
      || edgeIds.has(String(item.edgeId || '').replace(/^delegation:/, '')))
    .map((item) => ({
      taskId: String(item.taskId || ''), edgeId: String(item.edgeId || ''), state: String(item.state || ''),
      sequence: Number.isInteger(item.sequence) ? item.sequence : 0, observedAt: item.observedAt || null,
      dimensions: item.dimensions || {}, evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [],
      owner: item.owner || null, obligationStatus: item.obligationStatus || null,
      contractHash: String(item.contractHash || ''), hash: String(item.hash || taskDependencyBundleHash(item)),
      replaySnapshot: item.replaySnapshot && typeof item.replaySnapshot === 'object' ? {
        version: String(item.replaySnapshot.version || ''), eventCount: Number(item.replaySnapshot.eventCount || 0),
        orderedEventIds: Array.isArray(item.replaySnapshot.orderedEventIds) ? item.replaySnapshot.orderedEventIds.map((id) => String(id || '')).filter(Boolean).slice(0, 1000) : [],
        initialHash: String(item.replaySnapshot.initialHash || ''), finalHash: String(item.replaySnapshot.finalHash || ''),
        traceHash: String(item.replaySnapshot.traceHash || ''), replayToken: String(item.replaySnapshot.replayToken || ''),
      } : null,
    })).slice(0, limit);
  const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
  const tdbCanonical = JSON.stringify(canonicalize(tdbBundles));
  const tdbHash = createHash('sha256').update(tdbCanonical).digest('hex');
  // Target identity is caller supplied and intentionally remains a draft.  A
  // target id alone cannot establish applicability or decision sufficiency;
  // keeping this binding in the projection hash makes later target changes
  // invalidate any model/evidence bound to the previous projection.
  const cross = crossTaskBinding && typeof crossTaskBinding === 'object' ? crossTaskBinding : {};
  const explicitTargetTaskId = String(cross.targetTaskId || '').trim();
  const targetBinding = {
    version: 'ubuddy_target_binding_v1',
    status: 'UNKNOWN',
    reason: explicitTargetTaskId ? 'target_binding_draft_only' : 'target_task_missing',
    receiverUserId: receiver,
    query: String(decision || ''),
    scope: canonicalize(graph.scope || {}),
    tdbHash,
    targetTaskId: explicitTargetTaskId || null,
  };
  const fields = {
    nodes: include('nodes') ? (graph.nodes || []).filter((node) => isParticipant(node.userId)) : [],
    edges: include('edges') ? edges : [], stateItems, resultVersions,
    tdbBundles: include('tdbBundles') ? tdbBundles : [],
  };
  const disclosureCost = Object.values(fields).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  let crossTaskApplicability = { status: 'UNKNOWN', applicability: 'BLOCKED', reason: 'cross_task_binding_missing' };
  if (crossTaskBinding !== null || sourceBundle !== null) {
    const cross = crossTaskBinding && typeof crossTaskBinding === 'object' ? crossTaskBinding : {};
    // A caller may omit the source object when the graph already carries TDBs,
    // but we only resolve one when the binding explicitly identifies that
    // source (task id and/or hash).  Target-only bindings never imply that the
    // target is its own source; ambiguity therefore remains UNKNOWN.
    let resolvedSource = sourceBundle ?? cross.sourceBundle ?? null;
    let sourceResolution = 'explicit';
    if (!resolvedSource) {
      const sourceTaskId = String(cross.expectedSourceTaskId || cross.sourceTaskId || '').trim();
      const sourceHash = String(cross.expectedSourceHash || cross.sourceHash || '').trim();
      if (sourceTaskId || sourceHash) {
        const candidates = (Array.isArray(graph.tdbBundles) ? graph.tdbBundles : [])
          .map((item) => ({ item, normalized: normalizeTaskDependencyBundle(item) }))
          .filter(({ item, normalized }) => {
            const hash = String(item.hash || taskDependencyBundleHash(normalized));
            return (!sourceTaskId || normalized.taskId === sourceTaskId)
              && (!sourceHash || hash === sourceHash);
          });
        if (candidates.length === 1) {
          resolvedSource = candidates[0].normalized;
          sourceResolution = 'graph_tdb_explicit_source_binding';
        } else if (candidates.length > 1) {
          sourceResolution = 'graph_tdb_source_ambiguous';
        } else {
          sourceResolution = 'graph_tdb_source_not_found';
        }
      } else {
        sourceResolution = 'source_identity_missing';
      }
    }
    crossTaskApplicability = assessCrossTaskApplicability({
      sourceBundle: resolvedSource,
      targetTaskId: cross.targetTaskId,
      targetScope: cross.targetScope || String(decision || ''),
      requiredDimensions: cross.requiredDimensions,
      now: cross.now || now,
      maxAgeMs: cross.maxAgeMs,
      expectedSourceHash: cross.expectedSourceHash,
      expectedSourceTaskId: cross.expectedSourceTaskId,
      relationType: cross.relationType,
    });
    crossTaskApplicability.sourceResolution = sourceResolution;
  }
  const canonical = JSON.stringify(canonicalize({ scope: graph.scope || {}, graphVersion: graph.graphVersion || '', receiverUserId: receiver, decision: String(decision || ''), projectionVersion: 'decision_relative_tdb_projection_v1', tdbHash, targetBinding, fields, crossTaskApplicability }));
  const projectionHash = createHash('sha256').update(canonical).digest('hex');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  let sufficiency = { status: 'UNKNOWN', reason: 'no_decision_model' };
  let model = finiteModel;
  if (!model && typeof modelProvider === 'function') {
    try { model = modelProvider({ graph, fields, receiverUserId: receiver, decision: String(decision || ''), projectionHash }); }
    catch { model = null; sufficiency = { status: 'UNKNOWN', reason: 'model_provider_failed' }; }
  }
  if (model && typeof model === 'object') {
    const expected = { receiverUserId: receiver, decision: String(decision || ''), projectionHash, tdbHash };
    const b = model.binding || binding;
    const bindingValid = b && b.projectionHash === expected.projectionHash
      && b.receiverUserId === expected.receiverUserId && b.query === expected.decision
      && b.tdbHash === expected.tdbHash
      && Array.isArray(b.actionSet) && b.actionSet.length
      && b.scope && String(b.scope.graphId || graph.scope?.delegationId || graph.scope?.groupId || '').length
      && b.modelVersion && b.evaluatorVersion
      && Number.isFinite(Date.parse(b.issuedAt)) && Number.isFinite(Date.parse(b.expiresAt))
      && Date.parse(b.issuedAt) <= nowMs && nowMs < Date.parse(b.expiresAt);
    if (!bindingValid) sufficiency = { status: 'UNKNOWN', reason: 'model_binding_invalid', binding: b || null };
    else {
      sufficiency = assessDecisionSufficiency({ ...model, query: expected.decision, allowedActions: b.actionSet });
      sufficiency.binding = {
        projectionHash: b.projectionHash, tdbHash: b.tdbHash, receiverUserId: b.receiverUserId, query: b.query,
        actionSet: [...b.actionSet], scope: b.scope, modelVersion: b.modelVersion,
        evaluatorVersion: b.evaluatorVersion, issuedAt: b.issuedAt, expiresAt: b.expiresAt,
      };
    }
  }
  return {
    projectionVersion: 'decision_relative_tdb_projection_v1',
    receiverUserId: receiver,
    decision: String(decision || 'accept_result'),
    fields,
    disclosureCost,
    contentHash: projectionHash,
    tdbHash,
    targetBinding,
    crossTaskApplicability,
    sufficiency,
  };
}

async function resolveCollaborationScope(pool, { viewerUserId = '', groupId = '', delegationId = '', apiError = defaultApiError } = {}) {
  const cleanGroupId = String(groupId || '').trim();
  const cleanDelegationId = String(delegationId || '').trim();
  if (!cleanGroupId && !cleanDelegationId) throw apiError('collaboration_scope_required', 'groupId or delegationId is required.', 400);
  let group = null;
  let delegation = null;
  let delegations = [];
  if (cleanGroupId) {
    group = await one(pool, 'SELECT * FROM collaboration_groups WHERE id=$1', [cleanGroupId]);
    const membership = group ? await one(pool, `SELECT * FROM collaboration_group_members
      WHERE group_id=$1 AND user_id=$2 AND status IN ('active','closed')`, [cleanGroupId, viewerUserId]) : null;
    if (!group || !membership) throw apiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
    delegations = await many(pool, 'SELECT * FROM agent_delegations WHERE group_id=$1 ORDER BY created_at,id', [cleanGroupId]);
    if (cleanDelegationId) {
      delegation = delegations.find((item) => item.id === cleanDelegationId) || null;
      if (!delegation) throw apiError('delegation_not_found', '委托任务不存在。', 404);
      delegations = [delegation];
    }
  } else {
    delegation = await one(pool, 'SELECT * FROM agent_delegations WHERE id=$1', [cleanDelegationId]);
    if (!delegation || ![delegation.requester_user_id, delegation.recipient_user_id].includes(viewerUserId)) {
      throw apiError('delegation_not_found', '委托任务不存在。', 404);
    }
    if (delegation.group_id) {
      group = await one(pool, 'SELECT * FROM collaboration_groups WHERE id=$1', [delegation.group_id]);
      const membership = await one(pool, `SELECT * FROM collaboration_group_members
        WHERE group_id=$1 AND user_id=$2 AND status IN ('active','closed')`, [delegation.group_id, viewerUserId]);
      if (!membership) throw apiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
    }
    delegations = [delegation];
  }
  return { group, delegation, delegations };
}

async function stateItemsForDelegations(pool, delegations = []) {
  const result = [];
  for (const item of delegations) {
    const metadata = jsonObject(item.metadata_json);
    result.push({
      kind: 'delegation_status',
      owner: `delegation:${item.id}`,
      visibility: 'participants',
      status: normalizeStatus(item.status),
      updatedAt: toIso(item.updated_at),
      summary: { title: item.title || '', hasLatestResult: Boolean(metadata.latestResult) },
    });
    const workspaceRows = await many(pool, `SELECT user_id,COUNT(*)::int AS message_count,MAX(updated_at) AS updated_at
      FROM agent_delegation_workspace_messages WHERE delegation_id=$1 GROUP BY user_id ORDER BY user_id`, [item.id]);
    for (const row of workspaceRows) {
      result.push({
        kind: 'private_workspace_activity',
        owner: `ubuddy:${row.user_id}`,
        visibility: 'private_activity_summary',
        status: Number(row.message_count || 0) > 0 ? 'has_activity' : 'empty',
        updatedAt: toIso(row.updated_at),
        summary: { messageCount: Number(row.message_count || 0) },
      });
    }
  }
  return result;
}

async function resultVersionsForDelegations(pool, delegations = []) {
  const result = [];
  for (const item of delegations) {
    const latestInvalidatingRevision = await one(pool, `SELECT created_at,revision_no FROM agent_delegation_revisions
      WHERE delegation_id=$1 AND action IN ('request_revision','update_requirements') ORDER BY created_at DESC,id DESC LIMIT 1`, [item.id]);
    const submissions = await many(pool, `SELECT * FROM agent_delegation_revisions
      WHERE delegation_id=$1 AND action IN ('submit','publish','accept_result','request_revision','update_requirements','blocked')
      ORDER BY created_at,id`, [item.id]);
    for (const row of submissions) {
      const revisionNo = Number(row.revision_no || 0);
      const rowRevisionNo = Number(row.revision_no || 0);
      const invalidatingRevisionNo = Number(latestInvalidatingRevision?.revision_no || 0);
      const createdBeforeInvalidation = latestInvalidatingRevision
        && Date.parse(row.created_at) < Date.parse(latestInvalidatingRevision.created_at);
      const superseded = row.action === 'submit' && latestInvalidatingRevision
        && (rowRevisionNo > 0 && invalidatingRevisionNo > 0
          ? rowRevisionNo < invalidatingRevisionNo
          : createdBeforeInvalidation);
      result.push({
        sourceId: row.id,
        delegationId: item.id,
        sourceKind: 'delegation_revision',
        action: row.action,
        decision: superseded ? 'superseded' : row.action === 'accept_result' ? 'adopted' : row.action === 'blocked' ? 'rejected' : 'pending',
        status: superseded ? 'superseded' : normalizeStatus(item.status),
        coveredRevision: revisionNo,
        publishedAt: ['submit', 'publish', 'accept_result'].includes(row.action) ? toIso(row.created_at) : '',
      });
    }
    if (!item.task_run_id) continue;
    const taskVersions = await many(pool, `SELECT * FROM task_node_result_versions
      WHERE task_run_id=$1 ORDER BY created_at,id`, [item.task_run_id]);
    for (const row of taskVersions) {
      result.push({
        sourceId: row.id,
        delegationId: item.id,
        sourceKind: 'task_node_result_version',
        action: 'task_result',
        decision: row.decision || 'pending',
        status: row.decision === 'superseded' ? 'superseded' : row.decision === 'rejected' ? 'failed' : row.decision === 'adopted' ? 'complete' : 'pending',
        coveredRevision: Number(row.version_no || 0),
        publishedAt: row.decided_at ? toIso(row.decided_at) : '',
      });
    }
  }
  return result;
}

async function visibleCapabilitySnapshots(pool, { viewerUserId = '', userIds = [] } = {}) {
  return visibleCapabilityProfiles(pool, { viewerUserId, userIds });
}

async function capabilityAccessScope(pool, { viewerUserId = '', ownerUserId = '', visibility = 'friends' } = {}) {
  if (!viewerUserId || !ownerUserId) return '';
  if (viewerUserId === ownerUserId) return 'owner';
  const blocked = await one(pool, `SELECT 1 FROM user_blocks
    WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`, [viewerUserId, ownerUserId]);
  if (blocked) return '';
  const [userA, userB] = orderedUserPair(viewerUserId, ownerUserId);
  const friendship = await one(pool, "SELECT 1 FROM friendships WHERE user_a_id=$1 AND user_b_id=$2 AND status='accepted' LIMIT 1", [userA, userB]);
  if (friendship) return 'friends';
  if (visibility !== 'organization') return '';
  const organization = await one(pool, `SELECT 1 FROM contact_organization_members viewer
    JOIN contact_organization_members owner ON owner.organization_id=viewer.organization_id
    WHERE viewer.user_id=$1 AND owner.user_id=$2 LIMIT 1`, [viewerUserId, ownerUserId]);
  return organization ? 'organization' : '';
}

function organizationSignalsFor({ delegation, selectionSnapshot = null, revisions = [], resultVersions = [], evidenceRefs = [], organizationTraceEvents = [], officialEvaluation = null } = {}) {
  const evidenceIds = evidenceRefs.map((item) => item.evidence_id);
  const attributionMeta = evidenceAttributionMeta(evidenceRefs);
  const actions = revisions.map((item) => item.action);
  const accepted = ['result_accepted', 'closed', 'completed'].includes(normalizeStatus(delegation.status)) || actions.includes('accept_result');
  const submitted = actions.includes('submit') || resultVersions.some((item) => ['adopted', 'pending'].includes(item.decision));
  const reworked = actions.some((item) => ['request_revision', 'update_requirements'].includes(item));
  const signals = [];
  const officialObserved = officialEvaluation && Number.isFinite(Number(officialEvaluation.totalCount));
  const officialSuccess = Boolean(officialEvaluation?.success);
  if (accepted || submitted || officialObserved) {
    signals.push({
      kind: accepted || officialSuccess ? 'collaboration_route_validated' : 'collaboration_route_candidate',
      confidence: accepted || officialSuccess ? 0.8 : officialObserved ? 0.62 : 0.6,
      evidenceRefs: [...evidenceIds, ...organizationTraceEvents.map((item) => item.id)],
      evidenceBinding: attributionMeta.evidenceBinding,
      probeSupport: attributionMeta.probeSupport,
      attributionMode: attributionMeta.probeSupport.supported ? 'probe_supported' : 'observational',
      recommendation: accepted || officialSuccess
        ? '将本次 uBuddy 委派路径作为同类任务的候选编排经验。'
        : '保留本次委派路径，等待验收后再提升为高置信度经验。',
    });
  }
  if (selectionSnapshot && accepted) {
    signals.push({
      kind: 'capability_selection_validated',
      confidence: 0.8,
      evidenceRefs: evidenceIds,
      evidenceBinding: attributionMeta.evidenceBinding,
      probeSupport: attributionMeta.probeSupport,
      attributionMode: attributionMeta.probeSupport.supported ? 'probe_supported' : 'observational',
      recommendation: '保留本次画像版本、任务需求与接收方之间的匹配关系，作为后续候选排序的正向经验。',
      selectionRef: {
        queryId: selectionSnapshot.queryId || '',
        recipientUserId: selectionSnapshot.recipientProfile?.ownerUserId || delegation.recipient_user_id,
        profileRevision: selectionSnapshot.recipientProfile?.profileRevision || 0,
        contentHash: selectionSnapshot.recipientProfile?.contentHash || '',
      },
    });
  }
  if (reworked) {
    signals.push({
      kind: 'requirement_revision_pattern',
      confidence: 0.65,
      evidenceRefs: evidenceIds,
      evidenceBinding: attributionMeta.evidenceBinding,
      probeSupport: attributionMeta.probeSupport,
      attributionMode: attributionMeta.probeSupport.supported ? 'probe_supported' : 'observational',
      recommendation: '后续同类任务在委派前增加需求版本确认，降低返工概率。',
    });
  }
  if (!signals.length) {
    signals.push({
      kind: 'collaboration_signal_insufficient',
      confidence: 0.3,
      evidenceRefs: evidenceIds,
      evidenceBinding: attributionMeta.evidenceBinding,
      probeSupport: attributionMeta.probeSupport,
      attributionMode: 'observational',
      recommendation: '当前轨迹尚不足以固化为组织层协作策略。',
    });
  }
  return signals;
}

function individualSignalsFor({ delegation, capabilitySnapshots = [], selectionSnapshot = null, revisions = [], resultVersions = [], evidenceRefs = [], organizationTraceEvents = [], officialEvaluation = null } = {}) {
  const evidenceIds = evidenceRefs.map((item) => item.evidence_id);
  const attributionMeta = evidenceAttributionMeta(evidenceRefs);
  const actions = revisions.map((item) => item.action);
  const recipientProfile = selectionSnapshot?.recipientProfile || capabilitySnapshots.find((item) => item.ownerUserId === delegation.recipient_user_id);
  const requesterProfile = selectionSnapshot?.requesterProfile || capabilitySnapshots.find((item) => item.ownerUserId === delegation.requester_user_id);
  const resultAccepted = ['result_accepted', 'closed', 'completed'].includes(normalizeStatus(delegation.status)) || actions.includes('accept_result') || Boolean(officialEvaluation?.success);
  const failed = ['failed', 'blocked', 'declined', 'rejected'].includes(normalizeStatus(delegation.status)) || actions.some((item) => ['blocked', 'decline'].includes(item)) || (officialEvaluation && !officialEvaluation.success);
  const executionTrace = organizationTraceEvents.find((item) => ['execution_failed', 'execution_started', 'progress_published', 'handoff_published'].includes(item.event_kind));
  const executionMetadata = jsonObject(executionTrace?.payload_json);
  return [
    {
      userId: delegation.recipient_user_id,
      // Execution evidence must identify the actual internal Agent instance.
      // Do not fall back to the recipient's secretary/uBuddy instance: doing
      // so would attribute an execution failure to the wrong layer.
      agentInstanceId: executionMetadata.agentInstanceId || '',
      kind: failed ? 'delivery_capability_gap' : resultAccepted ? 'delivery_capability_supported' : 'delivery_capability_observed',
      confidence: recipientProfile ? (resultAccepted ? 0.75 : failed ? 0.65 : 0.5) : 0.35,
      evidenceRefs: [...evidenceIds, ...organizationTraceEvents.map((item) => item.id)],
      evidenceBinding: attributionMeta.evidenceBinding,
      probeSupport: attributionMeta.probeSupport,
      attributionMode: attributionMeta.probeSupport.supported ? 'probe_supported' : 'observational',
      recommendation: recipientProfile
        ? resultAccepted
          ? '可将本次交付作为接收方 uBuddy 能力画像或个体能力更新的正向证据。'
          : failed
            ? '将失败或受阻原因作为接收方 uBuddy 能力缺口候选，进入人工审核。'
            : '等待结果验收后再决定是否进入个体能力更新。'
        : '缺少接收方能力画像快照，暂不将结果直接归因到个体能力。',
    },
    {
      userId: delegation.requester_user_id,
      agentInstanceId: requesterProfile?.uBuddyAgentInstanceId || requesterProfile?.profile?.uBuddyAgentInstanceId || '',
      kind: 'coordination_behavior_observed',
      confidence: requesterProfile ? 0.55 : 0.35,
      evidenceRefs: evidenceIds,
      evidenceBinding: attributionMeta.evidenceBinding,
      probeSupport: attributionMeta.probeSupport,
      attributionMode: 'observational',
      recommendation: requesterProfile
        ? '可将需求组织、修改请求和验收行为作为发起方 uBuddy 协调能力的候选证据。'
        : '缺少发起方能力画像快照，暂不生成高置信度协调能力更新。',
    },
  ];
}

async function usersById(pool, userIds = []) {
  if (!userIds.length) return new Map();
  const placeholders = userIds.map((_, index) => `$${index + 1}`).join(',');
  const rows = await many(pool, `SELECT id,email,display_name,username,avatar_url,email_verified,role,updated_at
    FROM users WHERE id IN (${placeholders})`, userIds);
  return new Map(rows.map((row) => [row.id, row]));
}

function roleForUser(scope, userId) {
  if (scope.group?.owner_user_id === userId) return 'group_owner';
  if (scope.delegations.some((item) => item.requester_user_id === userId)) return 'requester';
  if (scope.delegations.some((item) => item.recipient_user_id === userId)) return 'recipient';
  return 'participant';
}

function revisionEventKind(action = '') {
  return ({
    publish: 'task_published',
    update_requirements: 'task_revision',
    request_revision: 'rework_requested',
    submit: 'result_submitted',
    accept_result: 'result_accepted',
    working: 'execution_started',
    blocked: 'execution_blocked',
    decline: 'task_declined',
  })[String(action || '')] || String(action || 'delegation_revision');
}

function evolutionEvidenceRef(row = {}, replaySnapshot = null) {
  return {
    evidenceId: row.evidence_id || '',
    sourceKind: row.source_kind || '',
    sourceId: row.source_id || '',
    sourceVersionId: row.source_version_id || '',
    ownerUserId: row.owner_user_id || '',
    agentInstanceId: row.user_agent_instance_id || '',
    agentFamilyId: row.agent_family_id || '',
    confidence: Number(row.confidence || 0),
    validationStatus: row.validation_status || '',
    evolutionScope: row.evolution_scope || '',
    usageStatus: row.usage_status || '',
    occurredAt: toIso(row.occurred_at),
    ...(replaySnapshot ? {
      tdbReplayToken: replaySnapshot.replayToken,
      tdbTraceHash: replaySnapshot.traceHash,
      tdbFinalHash: replaySnapshot.finalHash,
    } : {}),
  };
}

// Export a training-ready, authorized episode without exposing private storage.
// The caller must already be authorized for viewerUserId; content is redacted
// with the same policy used by public graph/attribution projections.
export async function buildTdbTrainingEpisode(pool, { viewerUserId = '', delegationId = '', taskFamilyId = '', taskInstanceId = '', decisionQuery = 'accept_result', apiError = defaultApiError } = {}) {
  const graph = await buildCollaborationStateGraph(pool, { viewerUserId, delegationId, apiError });
  const attribution = await buildCollaborationAttribution(pool, { viewerUserId, delegationId, apiError });
  const delegation = await one(pool, 'SELECT * FROM agent_delegations WHERE id=$1', [delegationId]);
  if (!delegation) throw apiError('delegation_not_found', 'Delegation not found.', 404);
  const messages = await optionalMany(pool, `SELECT id,delegation_id,user_id,role,content,metadata_json,created_at
    FROM agent_delegation_workspace_messages WHERE delegation_id=$1 ORDER BY created_at,id`, [delegationId]);
  const groupMessages = delegation.group_id ? await optionalMany(pool, `SELECT id,sender_user_id,kind,content,metadata_json,created_at
    FROM collaboration_group_messages WHERE group_id=$1 AND (metadata_json->>'delegationId'=$2 OR source_event_id LIKE $3) ORDER BY created_at,id`, [delegation.group_id, delegationId, `%${delegationId}%`]) : [];
  const conversation = [
    ...messages.map((item) => ({ id: item.id, role: item.role || 'user', actorUserId: item.user_id || '', content: redactSensitiveText(String(item.content || '')), metadata: publicTraceMetadata(item.metadata_json), occurredAt: toIso(item.created_at), sourceKind: 'workspace_message' })),
    ...groupMessages.map((item) => ({ id: item.id, role: item.kind || 'agent', actorUserId: item.sender_user_id || '', content: redactSensitiveText(String(item.content || '')), metadata: publicTraceMetadata(item.metadata_json), occurredAt: toIso(item.created_at), sourceKind: 'group_message' })),
  ].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || String(a.id).localeCompare(String(b.id)));
  const bundle = graph.tdbBundles?.find((item) => String(item.delegationId) === String(delegationId)) || {};
  const plan = bundle.replaySnapshot?.initialHash ? { hash: bundle.replaySnapshot.initialHash } : {};
  const exec = bundle.replaySnapshot?.finalHash ? { hash: bundle.replaySnapshot.finalHash } : {};
  const delegationMetadata = jsonObject(delegation.metadata_json);
  return {
    schemaVersion: 'tdb-episode-contract-v1', taskFamilyId: String(taskFamilyId || delegationMetadata.taskFamilyId || 'real_task_family'),
    taskInstanceId: String(taskInstanceId || delegation.task_run_id || delegation.id), episodeId: String(delegation.id), delegationId: String(delegation.id),
    agentPair: [String(delegation.requester_user_id || ''), String(delegation.recipient_user_id || '')], conversation,
    toolTrace: attribution.trace.filter((item) => /tool|function|api/i.test(String(item.eventKind || ''))), eventTrace: attribution.trace,
    gPlan: { nodes: graph.nodes, edges: graph.edges }, gExec: { nodes: graph.nodes, edges: graph.edges, trace: attribution.trace },
    tdbPlan: plan, tdbActiveTrace: bundle.trace || [], tdbExec: { ...bundle, replaySnapshot: undefined }, receiverScope: { viewerUserId }, decisionQuery,
    privacyPolicy: { redaction: 'publicTraceMetadata-v1' }, hardContract: { independentCheckerRequired: true }, dependencyGold: {}, disclosureGold: {}, evolutionGold: {},
    evaluatorVersion: String(delegationMetadata.evaluatorVersion || ''), sourceProvenance: { kind: 'real_authorized_episode', database: 'janus_postgres', delegationId: String(delegation.id), authorizedViewer: String(viewerUserId), redactionPolicy: 'publicTraceMetadata-v1' }, replayToken: String(bundle.replaySnapshot?.replayToken || ''), traceHash: String(bundle.replaySnapshot?.traceHash || ''), labelMask: { dependency: false, disclosure: false, evolution: false }
  };
}

function tdbReplayOccurredAt(events = [], delegation = {}) {
  const times = (Array.isArray(events) ? events : [])
    .map((event) => toIso(event?.created_at || event?.createdAt))
    .filter(Boolean);
  return times.at(-1) || toIso(delegation.updated_at || delegation.created_at);
}

// Attribution deliberately distinguishes observational traces from evidence
// produced by a declared, supported intervention.  A high confidence log
// signal alone is never eligible for evolution routing.
function evidenceAttributionMeta(rows = []) {
  const refs = Array.isArray(rows) ? rows : [];
  const binding = refs.map((row) => ({
    evidenceId: row.evidence_id || '',
    sourceKind: row.source_kind || '',
    sourceId: row.source_id || '',
    sourceVersionId: row.source_version_id || '',
    delegationId: row.delegation_id || row.delegationId || '',
  })).filter((item) => item.evidenceId);
  const probes = refs.filter((row) => /(^|_)(probe|intervention|counterfactual)(_|$)/i.test(String(row.source_kind || '')))
    .filter((row) => String(row.validation_status || '').toLowerCase() === 'validated')
    .filter((row) => Boolean(row.source_version_id) && Boolean(row.source_id));
  return {
    evidenceBinding: { count: binding.length, refs: binding },
    probeSupport: {
      supported: probes.length > 0,
      count: probes.length,
      evidenceIds: probes.map((row) => row.evidence_id),
      effectEstimateAvailable: probes.some((row) => /effect|outcome|result/i.test(String(row.source_kind || ''))),
    },
  };
}

export function publicTraceMetadata(value = {}) {
  return redactPrivateMetadata(jsonObject(value));
}

const PRIVATE_METADATA_KEYS = new Set([
  'privateTaskWorkspace',
  'taskWorkspaceRoot',
  'workspaceRoot',
  'sourceSecretarySessionId',
  'preliminaryResult',
  'localPath',
  'path',
  'source_path',
]);

function redactPrivateMetadata(value) {
  if (Array.isArray(value)) return value.map((item) => redactPrivateMetadata(item));
  if (typeof value === 'string') return redactSensitiveText(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_METADATA_KEYS.has(key))
    .map(([key, nested]) => [key, redactPrivateMetadata(nested)]));
}

function redactSensitiveText(value = '') {
  return String(value || '')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\\\s"'`]+[\\\/]?)*[^\\\s"'`]*/g, '[redacted-path]')
    .replace(/\bfile:\/\/[^\s"'`]+/gi, '[redacted-path]');
}

async function one(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function many(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows || [];
}

async function optionalMany(pool, sql, params = []) {
  try { return await many(pool, sql, params); }
  catch (error) {
    if (error?.code === '42P01' || /relation .* does not exist|does not exist/i.test(String(error?.message || ''))) return [];
    throw error;
  }
}

// Like optionalMany, but preserves whether the provider/table was available.
// This avoids treating an unavailable evidence provider as an empty trace.
async function optionalManyWithAvailability(pool, sql, params = []) {
  try {
    return { rows: await many(pool, sql, params), available: true, reason: 'ok' };
  } catch (error) {
    if (error?.code === '42P01' || /relation .* does not exist|does not exist/i.test(String(error?.message || ''))) {
      // A present table with an older schema may lack optional trace columns.
      // Retry the stable subset before declaring the provider unavailable.
      if (/column .* does not exist|column .* not found/i.test(String(error?.message || ''))) {
        try {
          const fallback = sql.replace('id,task_node_id,event_type,owner_user_id,user_agent_instance_id,payload_json,created_at', 'id,event_type,owner_user_id,payload_json,created_at');
          return { rows: await many(pool, fallback, params), available: true, reason: 'schema_partial' };
        } catch { /* fall through to unavailable */ }
      }
      return { rows: [], available: false, reason: 'provider_unavailable' };
    }
    throw error;
  }
}

function summarizeTdbProviderAvailability(bundles = []) {
  const items = Array.isArray(bundles) ? bundles : [];
  const unavailable = items.filter((item) => item?.providerAvailability?.available === false);
  const noRun = items.filter((item) => item?.providerAvailability?.reason === 'no_task_run');
  return {
    source: 'cloud_task_events',
    available: unavailable.length === 0,
    reason: unavailable.length ? 'provider_unavailable' : (items.length && noRun.length === items.length ? 'no_task_run' : 'ok'),
    bundles: items.length,
    unavailableBundles: unavailable.length,
    snapshotAt: items.map((item) => item?.providerAvailability?.snapshotAt || '').filter(Boolean).sort().at(-1) || '',
  };
}

function jsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function unique(values = []) {
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function orderedUserPair(leftId, rightId) {
  return [String(leftId || ''), String(rightId || '')].sort();
}

function normalizeStatus(value = '') {
  return String(value || '').trim().toLowerCase();
}

function toIso(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function defaultApiError(code, message, status = 500, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

/** Optional replay snapshot persistence hook for graph construction. */
async function snapshotStoreForGraph(store, databaseAdapter, delegation, events, seed, replaySnapshot) {
  if (databaseAdapter) {
    const key = String(delegation?.task_run_id || delegation?.id || '').trim();
    const read = await readTdbSnapshot(databaseAdapter, { key, events, seed });
    return { enabled: true, source: 'database_adapter', key, action: 'loaded', verification: read,
      storedSnapshot: read.snapshot || null };
  }
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.verifyReplayToken !== 'function') {
    return { enabled: false };
  }
  const key = String(delegation?.task_run_id || delegation?.id || '').trim();
  if (!key) return { enabled: false, reason: 'key_missing' };
  try {
    const existing = await store.load(key);
    if (existing) {
      const verification = await store.verifyReplayToken(key, { events, seed, replayToken: replaySnapshot.replayToken });
      return { enabled: true, key, action: 'loaded', verification,
        storedSnapshot: existing.snapshot || null };
    }
    const saved = await store.save(key, { events, seed,
      metadata: { delegationId: String(delegation?.id || ''), taskRunId: String(delegation?.task_run_id || ''), source: 'collaboration_state_graph' } });
    return { enabled: true, key, action: 'saved',
      saveResult: { ok: Boolean(saved?.ok), reason: saved?.reason || '', replayToken: saved?.record?.snapshot?.replayToken || '' },
      storedSnapshot: saved?.record?.snapshot || null };
  } catch (error) {
    return { enabled: true, key, action: 'error', error: String(error?.message || error) };
  }
}
