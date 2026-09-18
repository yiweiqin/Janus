import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { buildCollaborationAttribution, buildCollaborationStateGraph, projectDecisionRelativeGraph } from '../src/modules/collaboration/stateGraph.mjs';
import { createInMemoryTdbSnapshotStore } from '../../src/shared/contracts/uBuddyTdbSnapshotStore.js';
import { taskDependencyBundleTraceFromEvents, taskDependencyBundleReplaySnapshot, replayTaskDependencyBundleTrace } from '../../src/shared/contracts/uBuddyTaskDependencyBundle.js';

test('TDB replay snapshot is deterministic across input order and exposes divergence hashes', () => {
  const seed = { taskId: 'run-1', edgeId: 'delegation:d1', sourceNodeId: 'alice', targetNodeId: 'bob' };
  const events = [
    { id: 'e2', task_run_id: 'run-1', event_type: 'execution_completed', created_at: '2026-09-05T10:02:00Z', payload_json: JSON.stringify({ dimensions: { quality: { score: .9 } } }) },
    { id: 'e1', task_run_id: 'run-1', event_type: 'task_assigned', created_at: '2026-09-05T10:01:00Z' },
  ];
  const first = taskDependencyBundleReplaySnapshot(events, seed);
  const second = taskDependencyBundleReplaySnapshot([...events].reverse(), seed);
  assert.deepEqual(second, first);
  assert.equal(first.eventCount, 2);
  assert.deepEqual(first.orderedEventIds, ['e1', 'e2']);
  assert.notEqual(first.initialHash, first.finalHash);
  assert.equal(first.replayToken.length, 64);
  assert.equal(first.traceHash.length, 64);
  assert.deepEqual(replayTaskDependencyBundleTrace(events, seed), taskDependencyBundleTraceFromEvents(events, seed));
  const changed = taskDependencyBundleReplaySnapshot(events.map((event) => event.id === 'e2' ? { ...event, id: 'e3' } : event), seed);
  assert.notEqual(changed.replayToken, first.replayToken);
});

test('runtime task events fold into task-relation-time TDB trace', () => {
  const trace = taskDependencyBundleTraceFromEvents([
    { id: 'e2', task_run_id: 'run-1', task_node_id: 'node-1', event_type: 'execution_failed', owner_user_id: 'bob', created_at: '2026-08-19T10:02:00Z' },
    { id: 'e1', task_run_id: 'run-1', task_node_id: 'node-1', event_type: 'task_assigned', owner_user_id: 'alice', created_at: '2026-08-19T10:01:00Z' },
  ], { taskId: 'run-1', edgeId: 'delegation:d1', sourceNodeId: 'alice', targetNodeId: 'bob', relationType: 'delegates_to' });
  assert.equal(trace.length, 2);
  assert.equal(trace[0].eventId, 'e1');
  assert.equal(trace[0].state, 'planned');
  assert.equal(trace[1].eventId, 'e2');
  assert.equal(trace[1].state, 'failed');
  assert.equal(trace[1].taskId, 'run-1');
  assert.equal(trace[1].edgeId, 'delegation:d1');
  assert.equal(trace[1].evidenceRefs[0].kind, 'task_event');
});

test('decision-relative projection is receiver and query conditioned', () => {
  const projection = projectDecisionRelativeGraph({
    viewerUserId: 'bob',
    nodes: [{ userId: 'alice' }, { userId: 'bob' }],
    edges: [
      { id: 'e1', delegationId: 'd1', from: 'ubuddy:alice', to: 'ubuddy:bob' },
      { id: 'e2', delegationId: 'd2', from: 'ubuddy:carol', to: 'ubuddy:dave' },
    ],
    stateItems: [{ kind: 'delegation_status', owner: 'delegation:d1' }, { kind: 'private_workspace_activity', owner: 'ubuddy:bob' }],
    resultVersions: [{ delegationId: 'd1' }, { delegationId: 'd2' }],
  }, { receiverUserId: 'bob', decision: 'accept_result', requestedFields: ['edges'] });
  assert.equal(projection.projectionVersion, 'decision_relative_tdb_projection_v1');
  assert.equal(projection.fields.tdbBundles.length, 0);
  assert.equal(typeof projection.tdbHash, 'string');
  assert.equal(projection.fields.edges.length, 1);
  assert.equal(projection.fields.stateItems.length, 0);
  assert.equal(projection.fields.resultVersions.length, 0);
  assert.equal(projection.sufficiency.status, 'UNKNOWN');
  assert.equal(projection.crossTaskApplicability.reason, 'cross_task_binding_missing');
  assert.throws(() => projectDecisionRelativeGraph({ viewerUserId: 'alice' }, { receiverUserId: 'bob' }), /authorized graph viewer/);
  const altered = projectDecisionRelativeGraph({ viewerUserId: 'bob', scope: { delegationId: 'd2' }, nodes: [], edges: [], stateItems: [], resultVersions: [] }, { receiverUserId: 'bob', decision: 'accept_result' });
  assert.notEqual(projection.contentHash, altered.contentHash);
  assert.throws(() => projectDecisionRelativeGraph({ viewerUserId: 'bob' }, { receiverUserId: 'bob', decision: 'unknown' }), /unsupported decision query/);
  assert.throws(() => projectDecisionRelativeGraph({ viewerUserId: 'bob' }, { receiverUserId: 'bob', requestedFields: ['secret'] }), /requested field/);
  const sameSize = (decision) => projectDecisionRelativeGraph({ viewerUserId: 'bob', edges: [{ delegationId: 'd1', from: 'ubuddy:bob' }], resultVersions: [{ delegationId: 'd1', decision }] }, { receiverUserId: 'bob' });
  assert.equal(sameSize('adopted').disclosureCost, sameSize('rejected').disclosureCost);
  assert.notEqual(sameSize('adopted').contentHash, sameSize('rejected').contentHash);
});

test('decision projection evaluates cross-task applicability only with explicit binding', () => {
  const sourceBundle = {
    taskId: 'task-a', relationType: 'depends_on', state: 'completed',
    observedAt: '2026-09-05T00:00:00.000Z',
    dimensions: { quality: { version: 'q-v1', value: 'verified' } },
    evidenceRefs: [{ kind: 'task_event', id: 'evt-a' }],
  };
  const graph = { viewerUserId: 'bob', edges: [{ delegationId: 'd1', from: 'ubuddy:alice', to: 'ubuddy:bob' }] };
  const projection = projectDecisionRelativeGraph(graph, {
    receiverUserId: 'bob', decision: 'accept_result', sourceBundle,
    crossTaskBinding: {
      targetTaskId: 'task-b', targetScope: 'accept_result', expectedSourceTaskId: 'task-a',
      relationType: 'depends_on', requiredDimensions: ['quality'], maxAgeMs: 3600000,
    }, now: '2026-09-05T00:30:00.000Z',
  });
  assert.equal(projection.crossTaskApplicability.status, 'CERTIFIED');
  assert.equal(projection.crossTaskApplicability.applicability, 'APPLICABLE');
  assert.equal(projection.crossTaskApplicability.targetTaskId, 'task-b');
  assert.deepEqual(projection.targetBinding, {
    version: 'ubuddy_target_binding_v1', status: 'UNKNOWN',
    reason: 'target_binding_draft_only', receiverUserId: 'bob',
    query: 'accept_result', scope: {}, tdbHash: projection.tdbHash,
    targetTaskId: 'task-b',
  });
  const blocked = projectDecisionRelativeGraph(graph, {
    receiverUserId: 'bob', decision: 'accept_result', sourceBundle,
    crossTaskBinding: { targetTaskId: 'task-b', targetScope: 'accept_result', maxAgeMs: 1 },
    now: '2026-09-05T00:30:00.000Z',
  });
  assert.equal(blocked.crossTaskApplicability.status, 'UNKNOWN');
});

test('decision projection resolves a uniquely identified graph TDB source without inferring target-only bindings', () => {
  const graph = {
    viewerUserId: 'bob',
    edges: [{ delegationId: 'd1', from: 'ubuddy:alice', to: 'ubuddy:bob' }],
    tdbBundles: [{
      delegationId: 'd1', taskId: 'task-a', edgeId: 'delegation:d1', relationType: 'depends_on',
      state: 'completed', sequence: 2, observedAt: '2026-09-05T00:00:00.000Z',
      dimensions: { quality: { version: 'q-v1', value: 'verified' } },
      evidenceRefs: [{ kind: 'task_event', id: 'evt-a' }],
    }],
  };
  const resolved = projectDecisionRelativeGraph(graph, {
    receiverUserId: 'bob', decision: 'accept_result',
    crossTaskBinding: {
      targetTaskId: 'task-b', targetScope: 'accept_result', expectedSourceTaskId: 'task-a',
      relationType: 'depends_on', requiredDimensions: ['quality'], maxAgeMs: 3600000,
    }, now: '2026-09-05T00:30:00.000Z',
  });
  assert.equal(resolved.crossTaskApplicability.status, 'CERTIFIED');
  assert.equal(resolved.crossTaskApplicability.sourceResolution, 'graph_tdb_explicit_source_binding');

  const targetOnly = projectDecisionRelativeGraph(graph, {
    receiverUserId: 'bob', decision: 'accept_result',
    crossTaskBinding: { targetTaskId: 'task-b', targetScope: 'accept_result', maxAgeMs: 3600000 },
    now: '2026-09-05T00:30:00.000Z',
  });
  assert.equal(targetOnly.crossTaskApplicability.status, 'UNKNOWN');
  assert.equal(targetOnly.crossTaskApplicability.reason, 'source_bundle_missing');
  assert.equal(targetOnly.crossTaskApplicability.sourceResolution, 'source_identity_missing');
  assert.equal(targetOnly.targetBinding.targetTaskId, 'task-b');
  assert.equal(targetOnly.targetBinding.status, 'UNKNOWN');
});

test('target binding draft is hash-bound and never inferred from graph data', () => {
  const graph = {
    viewerUserId: 'bob', scope: { delegationId: 'd1' },
    edges: [{ delegationId: 'd1', from: 'ubuddy:alice', to: 'ubuddy:bob' }],
    tdbBundles: [{ delegationId: 'd1', taskId: 'task-a', state: 'completed', sequence: 1 }],
  };
  const absent = projectDecisionRelativeGraph(graph, { receiverUserId: 'bob' });
  assert.equal(absent.targetBinding.targetTaskId, null);
  assert.equal(absent.targetBinding.reason, 'target_task_missing');
  const explicit = projectDecisionRelativeGraph(graph, {
    receiverUserId: 'bob', crossTaskBinding: { targetTaskId: 'task-b' },
  });
  assert.equal(explicit.targetBinding.status, 'UNKNOWN');
  assert.equal(explicit.targetBinding.targetTaskId, 'task-b');
  assert.notEqual(explicit.contentHash, absent.contentHash);
  const changed = projectDecisionRelativeGraph(graph, {
    receiverUserId: 'bob', crossTaskBinding: { targetTaskId: 'task-c' },
  });
  assert.notEqual(changed.contentHash, explicit.contentHash);
});

test('decision projection only certifies with a hash-bound, live finite model', () => {
  const graph = { viewerUserId: 'bob', scope: { delegationId: 'd1' }, edges: [{ delegationId: 'd1', from: 'ubuddy:alice', to: 'ubuddy:bob' }], tdbBundles: [{ delegationId: 'd1', taskId: 'run-1', edgeId: 'delegation:d1', state: 'completed', sequence: 2, hash: 'bundle-hash-1', dimensions: { quality: 'verified' }, evidenceRefs: [{ kind: 'task_event', id: 'e2' }] }] };
  const base = projectDecisionRelativeGraph(graph, { receiverUserId: 'bob', decision: 'accept_result' });
  const model = {
    worlds: [{ id: 'w1', support: true, utility: { accept: 1, reject: 0 }, safe: { accept: true, reject: true } }],
    coverage: { complete: true, basisRef: 'trace:d1:v1' },
    utility: (world, action) => world.utility[action],
    hardContract: (world, action) => world.safe[action],
    binding: {
      projectionHash: base.contentHash, tdbHash: base.tdbHash, receiverUserId: 'bob', query: 'accept_result', actionSet: ['accept', 'reject'],
      scope: { graphId: 'd1' }, modelVersion: 'finite-v1', evaluatorVersion: 'eval-v1',
      issuedAt: '2026-08-19T10:00:00.000Z', expiresAt: '2026-08-19T11:00:00.000Z',
    },
  };
  const certified = projectDecisionRelativeGraph(graph, { receiverUserId: 'bob', decision: 'accept_result', finiteModel: model, now: '2026-08-19T10:30:00.000Z' });
  assert.equal(certified.sufficiency.status, 'CERTIFIED');
  assert.equal(certified.sufficiency.action, 'accept');
  assert.equal(certified.sufficiency.binding.projectionHash, base.contentHash);
  assert.equal(certified.sufficiency.binding.tdbHash, base.tdbHash);
  const expired = projectDecisionRelativeGraph(graph, { receiverUserId: 'bob', decision: 'accept_result', finiteModel: model, now: '2026-08-19T11:00:00.000Z' });
  assert.equal(expired.sufficiency.status, 'UNKNOWN');
  assert.equal(expired.sufficiency.reason, 'model_binding_invalid');
  const tampered = projectDecisionRelativeGraph({ ...graph, edges: [{ ...graph.edges[0], status: 'changed' }] }, { receiverUserId: 'bob', decision: 'accept_result', finiteModel: model, now: '2026-08-19T10:30:00.000Z' });
  assert.equal(tampered.sufficiency.status, 'UNKNOWN');
  const tdbTampered = projectDecisionRelativeGraph({ ...graph, tdbBundles: [{ ...graph.tdbBundles[0], state: 'failed' }] }, { receiverUserId: 'bob', decision: 'accept_result', finiteModel: model, now: '2026-08-19T10:30:00.000Z' });
  assert.equal(tdbTampered.sufficiency.status, 'UNKNOWN');
  assert.equal(tdbTampered.sufficiency.reason, 'model_binding_invalid');
});
import {
  captureCapabilitySelectionSnapshot,
  createCapabilitySelectionToken,
  queryCollaborationCandidates,
  verifyCapabilitySelectionToken,
} from '../src/modules/collaboration/capabilitySelection.mjs';
import { evolutionModelProviderStatus } from '../src/modules/evolution/modelProvider.mjs';

test('collaboration state graph and attribution prototype', async (t) => {
  assert.deepEqual(evolutionModelProviderStatus({ env: {
    OPENAI_BASE_URL: 'https://provider.example/v1',
    CRS_OAI_KEY: 'test-key',
  } }), {
    available: true,
    source: 'environment',
    code: 'ok',
    model: 'gpt-5.4-mini',
    reviewModel: 'gpt-5.4-mini',
  });
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  t.after(async () => {
    await pool.end();
  });

  db.public.none(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      email text,
      display_name text,
      username text,
      avatar_url text,
      email_verified boolean,
      role text,
      updated_at text
    );

    CREATE TABLE collaboration_groups (
      id text PRIMARY KEY,
      owner_user_id text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      title text NOT NULL DEFAULT '',
      created_at text NOT NULL DEFAULT '',
      updated_at text NOT NULL DEFAULT ''
    );

    CREATE TABLE collaboration_group_members (
      group_id text NOT NULL,
      user_id text NOT NULL,
      status text NOT NULL DEFAULT 'active'
    );

    CREATE TABLE agent_delegations (
      id text PRIMARY KEY,
      group_id text NOT NULL DEFAULT '',
      requester_user_id text NOT NULL,
      recipient_user_id text NOT NULL,
      task_run_id text NOT NULL DEFAULT '',
      title text NOT NULL DEFAULT '',
      instruction text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft',
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at text NOT NULL DEFAULT '',
      updated_at text NOT NULL DEFAULT ''
    );

    CREATE TABLE agent_delegation_revisions (
      id text PRIMARY KEY,
      delegation_id text NOT NULL,
      author_user_id text NOT NULL,
      revision_no integer NOT NULL DEFAULT 1,
      action text NOT NULL DEFAULT 'draft',
      content text NOT NULL DEFAULT '',
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at text NOT NULL DEFAULT ''
    );

    CREATE TABLE agent_delegation_workspace_messages (
      id text PRIMARY KEY,
      delegation_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL DEFAULT 'user',
      content text NOT NULL DEFAULT '',
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_event_id text NOT NULL DEFAULT '',
      source_group_message_id text NOT NULL DEFAULT '',
      created_at text NOT NULL DEFAULT '',
      updated_at text NOT NULL DEFAULT ''
    );

    CREATE TABLE collaboration_group_messages (
      id text PRIMARY KEY,
      group_id text NOT NULL,
      sender_user_id text NOT NULL,
      sender_agent_id text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT 'friend',
      content text NOT NULL DEFAULT '',
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at text NOT NULL DEFAULT '',
      updated_at text NOT NULL DEFAULT '',
      source_event_id text NOT NULL DEFAULT '',
      account_workspace_id text NOT NULL DEFAULT 'workspace_personal'
    );

    CREATE TABLE social_ubuddy_capability_profiles (
      owner_user_id text NOT NULL,
      ubuddy_agent_instance_id text NOT NULL,
      profile_revision bigint NOT NULL,
      profile_version text NOT NULL DEFAULT 'ubuddy_capability_profile_v1',
      visibility text NOT NULL,
      publication_state text NOT NULL DEFAULT 'active',
      source_effective_skill_hash text NOT NULL,
      content_hash text NOT NULL,
      profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      state_revision bigint NOT NULL DEFAULT 1,
      last_command_id text NOT NULL DEFAULT '',
      published_at text NOT NULL DEFAULT '',
      archived_at text NOT NULL DEFAULT '',
      created_at text NOT NULL DEFAULT '',
      updated_at text NOT NULL DEFAULT ''
    );

    CREATE TABLE friendships (
      user_a_id text NOT NULL,
      user_b_id text NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE contact_organization_members (
      organization_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL DEFAULT 'member'
    );

    CREATE TABLE user_blocks (
      blocker_id text NOT NULL,
      blocked_id text NOT NULL
    );

    CREATE TABLE cloud_task_events (
      id text PRIMARY KEY,
      task_run_id text NOT NULL,
      event_type text NOT NULL,
      owner_user_id text NOT NULL DEFAULT '',
      payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at text NOT NULL DEFAULT ''
    );

    CREATE TABLE cloud_evolution_evidence (
      evidence_id text PRIMARY KEY,
      owner_user_id text NOT NULL,
      user_agent_instance_id text NOT NULL,
      agent_family_id text NOT NULL,
      source_kind text NOT NULL,
      source_id text NOT NULL,
      source_version_id text NOT NULL DEFAULT '',
      delegation_id text NOT NULL DEFAULT '',
      confidence double precision NOT NULL DEFAULT 1,
      validation_status text NOT NULL DEFAULT 'validated',
      occurred_at text NOT NULL DEFAULT '',
      ingested_at text NOT NULL DEFAULT '',
      content_hash text NOT NULL DEFAULT ''
    );

    CREATE TABLE cloud_evolution_evidence_usage (
      evidence_id text NOT NULL,
      evolution_scope text NOT NULL,
      consumer_id text NOT NULL,
      status text NOT NULL DEFAULT 'available'
    );

    CREATE TABLE task_node_result_versions (
      id text PRIMARY KEY,
      task_run_id text NOT NULL,
      task_node_id text NOT NULL,
      graph_revision_id text NOT NULL DEFAULT '',
      version_no integer NOT NULL DEFAULT 1,
      result_text text NOT NULL DEFAULT '',
      result_summary text NOT NULL DEFAULT '',
      evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      decision text NOT NULL DEFAULT 'pending',
      decision_reason text NOT NULL DEFAULT '',
      created_at text NOT NULL DEFAULT '',
      decided_at text NOT NULL DEFAULT ''
    );
  `);

  const j = (value) => JSON.stringify(value);
  const now = (offset) => `2026-08-19T10:${String(offset).padStart(2, '0')}:00.000Z`;

  for (const [id, email, name, username] of [
    ['alice', 'alice@example.test', 'Alice', 'alice'],
    ['bob', 'bob@example.test', 'Bob', 'bob'],
    ['carol', 'carol@example.test', 'Carol', 'carol'],
    ['dave', 'dave@example.test', 'Dave', 'dave'],
    ['eve', 'eve@example.test', 'Eve', 'eve'],
    ['frank', 'frank@example.test', 'Frank', 'frank'],
  ]) {
    await pool.query(
      'INSERT INTO users(id,email,display_name,username,email_verified,role,updated_at) VALUES ($1,$2,$3,$4,true,\'user\',$5)',
      [id, email, name, username, now(0)],
    );
  }

  await pool.query("INSERT INTO collaboration_groups(id,owner_user_id,status,title,created_at,updated_at) VALUES ('group_1','alice','active','Group One', $1, $1)", [now(1)]);
  for (const userId of ['alice', 'bob', 'carol', 'dave']) {
    await pool.query("INSERT INTO collaboration_group_members(group_id,user_id,status) VALUES ('group_1',$1,'active')", [userId]);
  }

  await pool.query("INSERT INTO friendships(user_a_id,user_b_id,status) VALUES ('alice','bob','accepted')");
  await pool.query("INSERT INTO contact_organization_members(organization_id,user_id,role) VALUES ('org_1','alice','owner'),('org_1','carol','member')");

  for (const [ownerUserId, visibility, profileRevision, intro] of [
    ['alice', 'friends', 1, 'Alice profile'],
    ['bob', 'friends', 1, 'Bob profile'],
    ['carol', 'organization', 1, 'Carol profile'],
    ['dave', 'organization', 1, 'Dave profile'],
  ]) {
    await pool.query(
      `INSERT INTO social_ubuddy_capability_profiles(
        owner_user_id,ubuddy_agent_instance_id,profile_revision,visibility,publication_state,
        source_effective_skill_hash,content_hash,profile_json,state_revision,published_at,created_at,updated_at
      ) VALUES ($1,'ubuddy-agent',$2,$3,'active','skill-hash',$4,$5::jsonb,1,$6,$6,$6)`,
      [
        ownerUserId,
        profileRevision,
        visibility,
        `${ownerUserId}-content-hash`,
        j({
          ownerUserId,
          introduction: intro,
          supportedTaskTypes: ownerUserId === 'dave' ? ['coding'] : ['research'],
          deliverableTypes: ownerUserId === 'dave' ? ['code'] : ['report'],
          capabilityTags: ownerUserId === 'dave' ? ['开发'] : ['研究'],
          preferredTasks: ['结构化任务'],
          evidenceSummary: '仅包含公开能力概述',
          uBuddyAgentInstanceId: 'ubuddy-agent',
          visibility,
        }),
        now(2 + profileRevision),
      ],
    );
  }

  const baselineCandidateQuery = await queryCollaborationCandidates(pool, {
    viewerUserId: 'alice',
    userIds: ['bob', 'carol', 'dave'],
    requirement: {
      supportedTaskTypes: ['research'],
      deliverableTypes: ['report'],
      capabilityTags: ['研究', '可视化'],
    },
  });
  assert.equal(baselineCandidateQuery.candidates.find((item) => item.ownerUserId === 'bob')?.ranking.evolutionApplied, false);
  const selectedBob = baselineCandidateQuery.candidates.find((item) => item.ownerUserId === 'bob');
  const selectionSnapshot = await captureCapabilitySelectionSnapshot(pool, {
    viewerUserId: 'alice',
    recipientUserId: 'bob',
    selection: {
      queryId: baselineCandidateQuery.queryId,
      profileRevision: selectedBob.profileRevision,
      contentHash: selectedBob.contentHash,
      requirement: baselineCandidateQuery.requirement,
      consideredCandidateUserIds: ['bob', 'carol', 'dave'],
      selectionReason: '研究和报告交付能力匹配',
    },
  });
  assert.equal(selectionSnapshot.version, 'ubuddy_capability_selection_snapshot_v1');
  assert.equal(selectionSnapshot.recipientProfile.profileRevision, 1);
  assert.equal(selectionSnapshot.recipientProfile.contentHash, 'bob-content-hash');
  const selectionToken = createCapabilitySelectionToken(selectionSnapshot, 'test-selection-secret');
  assert.equal(verifyCapabilitySelectionToken(selectionToken, 'test-selection-secret')?.recipientProfile?.ownerUserId, 'bob');
  assert.equal(verifyCapabilitySelectionToken(`${selectionToken}tampered`, 'test-selection-secret'), null);

  await pool.query(
    `INSERT INTO agent_delegations(
      id,group_id,requester_user_id,recipient_user_id,task_run_id,title,instruction,status,metadata_json,created_at,updated_at
    ) VALUES
      ('delegation_1','group_1','alice','bob','run_1','季度汇报','整理季度汇报','result_accepted',$1::jsonb,$2,$2),
      ('delegation_2','group_1','alice','carol','','方案评审','整理评审材料','assigned',$3::jsonb,$4,$4),
      ('delegation_3','group_1','alice','dave','','联络事项','跟进跨人协作','assigned',$5::jsonb,$6,$6),
      ('delegation_4','','eve','frank','','独立委派','没有能力画像的归因样本','submitted',$7::jsonb,$8,$8)`,
    [
      j({ dependencyOf: 'task_root', latestResult: 'submitted', capabilitySelectionSnapshot: selectionSnapshot }),
      now(3),
      j({ dependencyOf: 'task_root' }),
      now(4),
      j({ dependencyOf: 'task_root' }),
      now(5),
      j({ dependencyOf: 'standalone_task' }),
      now(6),
    ],
  );

  await pool.query(
    `INSERT INTO agent_delegation_revisions(id,delegation_id,author_user_id,revision_no,action,content,metadata_json,created_at) VALUES
      ('rev_1','delegation_1','alice',1,'draft','初稿',$1::jsonb,$2),
      ('rev_2','delegation_1','bob',1,'submit','Bob 私有初稿',$3::jsonb,$4),
      ('rev_3','delegation_1','alice',2,'request_revision','请补充图表',$5::jsonb,$6),
      ('rev_4','delegation_1','bob',2,'submit','Bob 修订后版本',$7::jsonb,$8),
      ('rev_5','delegation_1','alice',2,'accept_result','通过',$9::jsonb,$10)`,
    [
      j({ draft: true, localPath: '/home/alice/private/draft.md' }),
      now(10),
      j({ attachments: [{ path: '/home/bob/private/report.md', source_path: '/home/bob/private/report.md' }] }),
      now(11),
      j({ localPath: '/home/alice/private/review.md', reason: 'need_more_charts' }),
      now(12),
      j({ attachments: [{ path: '/home/bob/private/report-v2.md', source_path: '/home/bob/private/report-v2.md' }] }),
      now(13),
      j({ sourceSecretarySessionId: 'secret-session-1', privateTaskWorkspace: 'hidden' }),
      now(14),
    ],
  );

  await pool.query(
    `INSERT INTO agent_delegation_workspace_messages(
      id,delegation_id,user_id,role,content,metadata_json,source_event_id,source_group_message_id,created_at,updated_at
    ) VALUES
      ('wm_1','delegation_1','alice','user','Alice 私有草稿',$1::jsonb,'event_a','', $2, $2),
      ('wm_2','delegation_1','bob','assistant','Bob 的 uBuddy 私有初稿',$3::jsonb,'event_b','', $4, $4)`,
    [
      j({ preliminaryResult: 'Alice 私有草稿', path: '/home/alice/private/draft.md' }),
      now(11),
      j({ preliminaryResult: 'Bob 的 uBuddy 私有初稿', source_path: '/home/bob/private/report.md' }),
      now(12),
    ],
  );

  await pool.query(
    `INSERT INTO collaboration_group_messages(
      id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,created_at,updated_at,source_event_id,account_workspace_id
    ) VALUES
      ('msg_1','group_1','bob','','friend','Bob 的 uBuddy 私有初稿',$1::jsonb,$2,$2,'event_submit_1','workspace_personal')`,
    [j({ delegationId: 'delegation_1', action: 'submit', attachments: [{ path: '/home/bob/private/report.md', source_path: '/home/bob/private/report.md' }] }), now(13)],
  );

  await pool.query(
    `INSERT INTO cloud_task_events(id,task_run_id,event_type,owner_user_id,payload_json,created_at) VALUES
      ('evt_1','run_1','execution_failed','bob',$1::jsonb,$2),
      ('evt_2','run_1','execution_retried','bob',$3::jsonb,$4)`,
    [
      j({ currentAction: '正在读取 /home/bob/private/report.md', localPath: '/home/bob/private/report.md' }),
      now(11),
      j({ sourceSecretarySessionId: 'secret-session-1', taskWorkspaceRoot: '/home/bob/private' }),
      now(12),
    ],
  );

  await pool.query(
    `INSERT INTO cloud_evolution_evidence(
      evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,source_version_id,
      delegation_id,confidence,validation_status,occurred_at,ingested_at,content_hash
    ) VALUES
      ('evidence_1','bob','bob-instance','family','delegation_event','rev_4','version_4','delegation_1',0.9,'validated',$1,$1,'hash-1'),
      ('evidence_2','bob','bob-instance','family','collaboration_message','msg_1','version_5','delegation_1',0.8,'validated',$2,$2,'hash-2')`,
    [now(13), now(13)],
  );
  await pool.query(
    `INSERT INTO cloud_evolution_evidence_usage(evidence_id,evolution_scope,consumer_id,status) VALUES
      ('evidence_1','personal','bob-instance','available'),
      ('evidence_2','cluster','bob-instance','available')`,
  );

  await pool.query(
    `INSERT INTO task_node_result_versions(
      id,task_run_id,task_node_id,graph_revision_id,version_no,result_text,result_summary,evidence_json,decision,decision_reason,created_at,decided_at
    ) VALUES
      ('result_1','run_1','node_1','graph_1',1,'旧版本','旧摘要',$1::jsonb,'superseded','被后续修改覆盖',$2,$2),
      ('result_2','run_1','node_1','graph_2',2,'最终版本','最终摘要',$3::jsonb,'adopted','通过验收',$4,$4)`,
    [j([{ evidenceId: 'evidence_1' }]), now(11), j([{ evidenceId: 'evidence_2' }]), now(14)],
  );

  const candidateQuery = await queryCollaborationCandidates(pool, {
    viewerUserId: 'alice',
    userIds: ['bob', 'carol', 'dave'],
    requirement: {
      supportedTaskTypes: ['research'],
      deliverableTypes: ['report'],
      capabilityTags: ['研究', '可视化'],
    },
  });
  assert.equal(candidateQuery.queryVersion, 'ubuddy_collaboration_candidate_query_v1');
  assert.equal(candidateQuery.candidates[0].ownerUserId, 'bob');
  assert.equal(candidateQuery.unavailableUserIds.includes('dave'), true);
  const baselineBob = baselineCandidateQuery.candidates.find((item) => item.ownerUserId === 'bob');
  const evolvedBob = candidateQuery.candidates.find((item) => item.ownerUserId === 'bob');
  assert.equal(evolvedBob.ranking.baseScore, baselineBob.ranking.baseScore);
  assert.equal(evolvedBob.ranking.evolvedScore > evolvedBob.ranking.baseScore, true);
  assert.equal(evolvedBob.experienceSupport.evidenceCount, 2);

  await pool.query("UPDATE social_ubuddy_capability_profiles SET publication_state='archived' WHERE owner_user_id='bob' AND profile_revision=1");
  await pool.query(
    `INSERT INTO social_ubuddy_capability_profiles(
      owner_user_id,ubuddy_agent_instance_id,profile_revision,visibility,publication_state,
      source_effective_skill_hash,content_hash,profile_json,state_revision,published_at,created_at,updated_at
    ) VALUES ('bob','ubuddy-agent',2,'friends','active','skill-hash','bob-content-hash-v2',$1::jsonb,2,$2,$2,$2)`,
    [j({ ownerUserId: 'bob', uBuddyAgentInstanceId: 'ubuddy-agent', version: 'ubuddy_capability_profile_v1', profileRevision: 2, supportedTaskTypes: ['research'], deliverableTypes: ['report'], capabilityTags: ['研究', '新版'], visibility: 'friends' }), now(15)],
  );

  const snapshotStore = createInMemoryTdbSnapshotStore();
  const graph = await buildCollaborationStateGraph(pool, { viewerUserId: 'alice', groupId: 'group_1', tdbSnapshotStore: snapshotStore });
  assert.equal(graph.graphVersion, 'ubuddy_collaboration_state_graph_v1');
  assert.equal(graph.scope.groupId, 'group_1');
  assert.equal(graph.nodes.find((item) => item.userId === 'bob')?.capabilityProfile?.accessScope, 'friends');
  assert.equal(graph.nodes.find((item) => item.userId === 'bob')?.capabilityProfile?.profileRevision, 2);
  assert.equal(graph.nodes.find((item) => item.userId === 'bob')?.selectionSnapshot?.recipientProfile?.profileRevision, 1);
  assert.equal(graph.nodes.find((item) => item.userId === 'carol')?.capabilityProfile?.accessScope, 'organization');
  assert.equal(graph.nodes.find((item) => item.userId === 'dave')?.capabilityProfile, null);
  assert.equal(graph.stateItems.some((item) => item.kind === 'private_workspace_activity' && item.owner === 'ubuddy:bob' && item.summary.messageCount === 1), true);
  assert.equal(graph.resultVersions.some((item) => item.action === 'submit' && item.decision === 'superseded'), true);
  assert.equal(graph.resultVersions.some((item) => item.sourceKind === 'task_node_result_version' && item.decision === 'adopted'), true);
  assert.equal(graph.tdbProviderAvailability.source, 'cloud_task_events');
  assert.equal(graph.tdbProviderAvailability.available, true);
  assert.equal(graph.tdbBundles.find((item) => item.delegationId === 'delegation_1')?.providerAvailability?.available, true);
  assert.equal(graph.tdbBundles.find((item) => item.delegationId === 'delegation_1')?.providerAvailability?.eventCount > 0, true);
  const graphTdb = graph.tdbBundles.find((item) => item.delegationId === 'delegation_1');
  assert.equal(graphTdb?.replaySnapshot?.replayToken?.length, 64);
  assert.equal(graphTdb?.replaySnapshot?.traceHash?.length, 64);
  assert.equal(graphTdb?.replayStore?.enabled, true);
  assert.equal(graphTdb?.replayStore?.action, 'saved');
  const graphReloaded = await buildCollaborationStateGraph(pool, { viewerUserId: 'alice', groupId: 'group_1', tdbSnapshotStore: snapshotStore });
  const reloadedTdb = graphReloaded.tdbBundles.find((item) => item.delegationId === 'delegation_1');
  assert.equal(reloadedTdb?.replayStore?.action, 'loaded');
  assert.equal(reloadedTdb?.replayStore?.verification?.ok, true);
  const graphNoStore = await buildCollaborationStateGraph(pool, { viewerUserId: 'alice', groupId: 'group_1' });
  assert.equal(graphNoStore.tdbBundles.find((item) => item.delegationId === 'delegation_1')?.replayStore?.enabled, false);
  assert.equal(JSON.stringify(graph).includes('/home/bob/private/report.md'), false);
  assert.equal(JSON.stringify(graph).includes('Bob 的 uBuddy 私有初稿'), false);
  await assert.rejects(
    () => buildCollaborationStateGraph(pool, { viewerUserId: 'mallory', groupId: 'group_1' }),
    (error) => error.code === 'collaboration_group_not_found' && error.status === 404,
  );

  const attribution = await buildCollaborationAttribution(pool, { viewerUserId: 'alice', delegationId: 'delegation_1' });
  assert.equal(attribution.attributionVersion, 'ubuddy_process_attribution_v1');
  assert.equal(attribution.trace.some((item) => item.eventKind === 'capability_snapshot_captured' && item.sourceKind === 'ubuddy_capability_profile'), true);
  assert.equal(attribution.trace.some((item) => item.eventKind === 'capability_profile_selected' && item.sourceKind === 'capability_selection_snapshot'), true);
  assert.equal(attribution.trace.some((item) => item.eventKind === 'execution_failed'), true);
  assert.equal(attribution.trace.some((item) => item.eventKind === 'result_accepted'), true);
  assert.equal(attribution.organizationSignals.some((item) => item.kind === 'collaboration_route_validated'), true);
  assert.equal(attribution.organizationSignals.some((item) => item.kind === 'capability_selection_validated'), true);
  assert.equal(attribution.individualSignals.some((item) => item.userId === 'bob' && item.kind === 'delivery_capability_supported'), true);
  assert.equal(attribution.individualSignals.every((item) => item.attributionMode === 'observational'), true);
  assert.equal(attribution.evolutionRouting.personalCandidates.length, 0);
  assert.equal(attribution.evolutionRouting.blockedReasons.some((item) => item.code === 'probe_support_missing'), true);
  assert.equal(attribution.evolutionEvidenceRefs.some((item) => item.sourceKind === 'delegation_event'), true);
  assert.equal(attribution.evolutionEvidenceRefs.some((item) => item.sourceKind === 'collaboration_message'), true);
  assert.equal(attribution.tdbReplaySnapshot?.replayToken?.length, 64);
  assert.equal(attribution.trace.some((item) => item.eventKind === 'tdb_replay_snapshot' && item.metadata?.replayToken?.length === 64), true);
  assert.equal(attribution.evolutionEvidenceRefs.every((item) => item.tdbReplayToken?.length === 64), true);
  assert.equal(attribution.evolutionRouting.blockedReasons.some((item) => item.code === 'capability_selection_snapshot_missing'), false);
  assert.equal(JSON.stringify(attribution).includes('/home/bob/private/report.md'), false);
  assert.equal(JSON.stringify(attribution).includes('Bob 的 uBuddy 私有初稿'), false);

  const blocked = await buildCollaborationAttribution(pool, { viewerUserId: 'eve', delegationId: 'delegation_4' });
  assert.equal(blocked.evolutionRouting.blockedReasons.some((item) => item.code === 'capability_snapshot_missing'), true);
  assert.equal(blocked.evolutionRouting.blockedReasons.some((item) => item.code === 'evolution_evidence_missing'), true);

  t.diagnostic(JSON.stringify({
    architectureData: {
      candidateQuery: {
        queryId: candidateQuery.queryId,
        visibleCandidateUserIds: candidateQuery.candidates.map((item) => item.ownerUserId),
        unavailableUserIds: candidateQuery.unavailableUserIds,
        requirement: candidateQuery.requirement,
      },
      immutableSelection: {
        recipientUserId: selectionSnapshot.recipientProfile.ownerUserId,
        selectedProfileRevision: selectionSnapshot.recipientProfile.profileRevision,
        currentProfileRevision: graph.nodes.find((item) => item.userId === 'bob')?.capabilityProfile?.profileRevision,
        queryId: selectionSnapshot.queryId,
      },
      stateProjection: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        stateItemKinds: [...new Set(graph.stateItems.map((item) => item.kind))],
        resultDecisions: [...new Set(graph.resultVersions.map((item) => item.decision))],
      },
      attribution: {
        traceEventKinds: [...new Set(attribution.trace.map((item) => item.eventKind))],
        organizationSignalKinds: attribution.organizationSignals.map((item) => item.kind),
        individualSignalKinds: attribution.individualSignals.map((item) => item.kind),
        evidenceSourceKinds: attribution.evolutionEvidenceRefs.map((item) => item.sourceKind),
      },
      evolutionEffect: {
        userId: 'bob',
        baseScore: evolvedBob.ranking.baseScore,
        evolvedScore: evolvedBob.ranking.evolvedScore,
        validatedEvidenceCount: evolvedBob.experienceSupport.evidenceCount,
      },
    },
  }));
});
