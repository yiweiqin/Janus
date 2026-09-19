import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEvolutionEvidenceGate } from '../src/modules/collaboration/evolutionEvidenceGate.mjs';
import { routeCollaborationAttributionToEvolution } from '../src/server.mjs';

const evidence = {
  evidence_id: 'ev-1', source_version_id: 'rev-1', owner_user_id: 'alice',
  user_agent_instance_id: 'agent-1', delegation_id: 'task-1',
  validation_status: 'validated', quarantine_reason: '', historical_inactive: false,
};
const reference = {
  evidenceId: 'ev-1', sourceVersionId: 'rev-1', ownerUserId: 'alice',
  agentInstanceId: 'agent-1', validationStatus: 'validated',
};

test('verified evidence is eligible only with matching scope and identity bindings', () => {
  assert.deepEqual(evaluateEvolutionEvidenceGate([evidence], {
    delegationId: 'task-1', expectedRefs: [reference], ownerUserId: 'alice', agentInstanceId: 'agent-1',
  }), { ok: true, reasons: [] });
});

test('optional replay bindings are enforced when supplied and ignored for legacy refs', () => {
  const withReplay = { ...reference, tdbReplayToken: 'r-1', tdbTraceHash: 't-1' };
  const actual = { ...evidence, metadata_json: JSON.stringify({ tdbReplayToken: 'r-1', tdbTraceHash: 't-1' }) };
  assert.equal(evaluateEvolutionEvidenceGate([actual], { delegationId: 'task-1', expectedRefs: [withReplay] }).ok, true);
  const mismatch = evaluateEvolutionEvidenceGate([{ ...actual, metadata_json: JSON.stringify({ tdbReplayToken: 'r-2', tdbTraceHash: 't-1' }) }], { delegationId: 'task-1', expectedRefs: [withReplay] });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.reasons.some((reason) => reason.field === 'replayToken'));
  assert.equal(evaluateEvolutionEvidenceGate([evidence], { delegationId: 'task-1', expectedRefs: [reference] }).ok, true);
});

for (const [name, patch, expectedCode] of [
  ['missing authoritative evidence', null, 'evolution_evidence_missing'],
  ['invalidated evidence', { historical_inactive: true }, 'evolution_evidence_invalidated'],
  ['quarantined evidence', { validation_status: 'quarantined', quarantine_reason: 'privacy' }, 'evolution_evidence_quarantined'],
  ['pending validation', { validation_status: 'pending_validation' }, 'evolution_evidence_not_validated'],
  ['wrong delegation scope', { delegation_id: 'task-other' }, 'evolution_evidence_scope_mismatch'],
  ['missing delegation scope', { delegation_id: '' }, 'evolution_evidence_scope_mismatch'],
  ['wrong source version', { source_version_id: 'rev-2' }, 'evolution_evidence_reference_binding_mismatch'],
  ['wrong owner', { owner_user_id: 'mallory' }, 'evolution_evidence_reference_binding_mismatch'],
  ['wrong agent instance', { user_agent_instance_id: 'agent-other' }, 'evolution_evidence_reference_binding_mismatch'],
]) {
  test(`actual evolution route rejects ${name} before any mutation`, async () => {
    const queries = [];
    const pool = { async query(sql) {
      queries.push(sql);
      assert.match(sql, /^SELECT evidence_id/);
      return { rows: patch === null ? [] : [{ ...evidence, ...patch }] };
    } };
    const result = await routeCollaborationAttributionToEvolution(pool, {
      actorUserId: 'alice',
      attribution: {
        scope: { delegationId: 'task-1' }, trace: [{ eventKind: 'task_created', actorUserId: 'alice' }],
        evolutionEvidenceRefs: [reference], evolutionRouting: { blockedReasons: [] },
        individualSignals: [{ kind: 'delivery', confidence: 0.95, userId: 'alice', agentInstanceId: 'agent-1', evidenceRefs: ['ev-1'] }],
      },
    });
    assert.equal(result.status, 'blocked');
    assert.ok(result.blockedReasons.some((reason) => reason.code === expectedCode));
    assert.deepEqual(result.routedEvidence, []);
    assert.deepEqual(result.personalRuns, []);
    assert.equal(queries.length, 1);
  });
}

test('route preserves upstream hard blockers even when evidence is verified', async () => {
  const result = await routeCollaborationAttributionToEvolution({ async query() { return { rows: [evidence] }; } }, {
    attribution: { scope: { delegationId: 'task-1' }, evolutionEvidenceRefs: [reference],
      evolutionRouting: { blockedReasons: [{ code: 'evolution_evidence_missing' }] } },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockedReasons.some((reason) => reason.code === 'evolution_evidence_missing'));
});

test('evolution route blocks observational or unbound Probe effects by default', async () => {
  let queries = 0;
  const result = await routeCollaborationAttributionToEvolution({ async query() { queries += 1; return { rows: [] }; } }, {
    actorUserId: 'alice',
    attribution: {
      scope: { delegationId: 'task-1' }, attributionVersion: 'ubuddy_process_attribution_v1',
      evolutionEvidenceRefs: [reference], evolutionRouting: { blockedReasons: [] },
      // A status-like hint without the explicit delegation binding is not
      // sufficient to authorize an evolution write.
      probeEffect: { status: 'CERTIFIED', attribution: 'PROBE_SUPPORTED', tdbHash: 'tdb-1',
        sourceVersion: 'ubuddy_process_attribution_v1', evidenceRefs: ['ev-1'] },
    },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockedReasons.some((reason) => reason.code === 'probe_effect_binding_mismatch'));
  assert.equal(queries, 1);
});

test('evolution route requires certified cross-task applicability', async () => {
  const result = await routeCollaborationAttributionToEvolution({ async query() { return { rows: [evidence] }; } }, {
    actorUserId: 'alice',
    attribution: {
      scope: { delegationId: 'task-1' },
      evolutionEvidenceRefs: [reference],
      crossTaskApplicability: { status: 'UNKNOWN', applicability: 'BLOCKED', reason: 'cross_task_binding_missing' },
      evolutionRouting: { blockedReasons: [] },
    },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockedReasons.some((reason) => reason.code === 'cross_task_applicability_unknown'));
});

test('evolution route surfaces replay binding mismatch from authoritative metadata', async () => {
  const replayReference = { ...reference, tdbReplayToken: 'expected-replay', tdbTraceHash: 'expected-trace' };
  const result = await routeCollaborationAttributionToEvolution({ async query() { return { rows: [{ ...evidence, metadata_json: JSON.stringify({ tdbReplayToken: 'actual-replay', tdbTraceHash: 'expected-trace' }) }] }; } }, {
    actorUserId: 'alice', attribution: {
      scope: { delegationId: 'task-1' }, evolutionEvidenceRefs: [replayReference], evolutionRouting: { blockedReasons: [] },
      crossTaskApplicability: { status: 'CERTIFIED', applicability: 'APPLICABLE' },
    },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockedReasons.some((reason) => reason.code === 'evolution_evidence_reference_binding_mismatch' && reason.field === 'replayToken'));
});

test('certified cross-task applicability clears only that gate', async () => {
  const result = await routeCollaborationAttributionToEvolution({ async query() { return { rows: [evidence] }; } }, {
    actorUserId: 'alice',
    attribution: {
      scope: { delegationId: 'task-1' },
      evolutionEvidenceRefs: [reference],
      crossTaskApplicability: { status: 'CERTIFIED', applicability: 'APPLICABLE', reason: 'explicit_binding_and_freshness_verified' },
      evolutionRouting: { blockedReasons: [{ code: 'probe_support_missing' }] },
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockedReasons.some((reason) => reason.code === 'cross_task_applicability_unknown'), false);
  assert.equal(result.blockedReasons.some((reason) => reason.code === 'probe_support_missing'), true);
});

test('evolution route carries replay, target, and applicability binding into candidate audit output', async () => {
  const result = await routeCollaborationAttributionToEvolution({ async query() { return { rows: [] }; } }, {
    actorUserId: 'alice',
    attribution: {
      scope: { delegationId: 'task-1' },
      tdbReplaySnapshot: { version: 'tdb-v1', replayToken: 'r'.repeat(64), traceHash: 't'.repeat(64), finalHash: 'f'.repeat(64), initialHash: 'i'.repeat(64) },
      targetBinding: { version: 'ubuddy_target_binding_v1', status: 'UNKNOWN', targetTaskId: 'task-2', receiverUserId: 'bob', query: 'accept_result', tdbHash: 'h'.repeat(64) },
      crossTaskApplicability: { status: 'UNKNOWN', applicability: 'BLOCKED', reason: 'cross_task_binding_missing', sourceResolution: 'source_identity_missing' },
      evolutionEvidenceRefs: [], evolutionRouting: { blockedReasons: [] },
      individualSignals: [{ userId: 'alice', kind: 'delivery', confidence: 0.9 }],
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.candidateAudit.replay.replayToken.length, 64);
  assert.equal(result.candidateAudit.targetBinding.targetTaskId, 'task-2');
  assert.equal(result.candidateAudit.crossTaskApplicability.sourceResolution, 'source_identity_missing');
  assert.equal(result.personalCandidates[0].audit.crossTaskApplicability.targetTaskId, 'task-2');
  assert.equal(result.candidateAudit.auditVersion, 'ubuddy_candidate_audit_v1');
  assert.equal(result.candidateAudit.validation.status, 'VALIDATED');
});

test('evolution route blocks legacy candidate audits without an audit version', async () => {
  const result = await routeCollaborationAttributionToEvolution({ async query() { return { rows: [] }; } }, {
    actorUserId: 'alice',
    attribution: {
      scope: { delegationId: 'task-legacy' },
      candidateAudit: { replay: null, targetBinding: null, crossTaskApplicability: { status: 'UNKNOWN' } },
      evolutionEvidenceRefs: [], evolutionRouting: { blockedReasons: [] },
      individualSignals: [{ userId: 'alice', kind: 'delivery', confidence: 0.9 }],
    },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockedReasons.some((reason) => reason.code === 'candidate_audit_version_missing'));
  assert.equal(result.candidateAudit.auditVersion, 'ubuddy_candidate_audit_v1');
  assert.equal(result.candidateAudit.validation.status, 'UNKNOWN');
});

test('evolution route blocks candidate audits from an incompatible schema version', async () => {
  const result = await routeCollaborationAttributionToEvolution({ async query() { return { rows: [] }; } }, {
    actorUserId: 'alice',
    attribution: {
      scope: { delegationId: 'task-old' }, candidateAudit: { auditVersion: 'ubuddy_candidate_audit_v0' },
      evolutionEvidenceRefs: [], evolutionRouting: { blockedReasons: [] },
      individualSignals: [{ userId: 'alice', kind: 'delivery', confidence: 0.9 }],
    },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockedReasons.some((reason) => reason.code === 'candidate_audit_version_mismatch'));
  assert.equal(result.candidateAudit.validation.reason, 'candidate_audit_version_mismatch');
});
