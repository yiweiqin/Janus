import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  UBUDDY_ORG_PLAYBOOK_VERSION,
  uBuddyOrganizationPolicyHash,
  validateUBuddyOrganizationPlaybook,
} from '../../../src/shared/contracts/uBuddyOrganizationEvolution.js';

/**
 * Coordinates the two-round OrgBench evolution protocol.  The coordinator is
 * deliberately dependency-injected: a real Janus client can be supplied in a
 * PostgreSQL deployment, while the same code produces an explicitly marked
 * fallback result for local/offline canaries.
 */
export class EvolutionCoordinator {
  constructor({ client = null, artifactDir = '', namespace = '', method = '', gateThreshold = 0.7, logger = null } = {}) {
    this.client = client;
    this.artifactDir = artifactDir;
    this.namespace = namespace || `orgbench-${crypto.randomUUID()}`;
    this.method = method;
    this.gateThreshold = Math.max(0, Math.min(1, Number(gateThreshold)));
    this.logger = logger;
    this.state = { policy: null, agents: new Map(), profileConfidence: new Map(), baseline: null };
    this.requests = [];
  }

  async save(name, value) {
    if (!this.artifactDir) return '';
    const target = path.join(this.artifactDir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return target;
  }

  async saveJsonl(name, rows = []) {
    if (!this.artifactDir) return '';
    const target = path.join(this.artifactDir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    return target;
  }

  baselineSnapshot({ episode = {}, round = 1 } = {}) {
    const scenario = episode.scenario || {};
    const profiles = Array.isArray(episode.publicProfiles) ? episode.publicProfiles : (scenario.profiles || []);
    const agents = [];
    for (const pool of Object.values(scenario.internalPools || {})) {
      for (const agent of pool.agents || []) {
        agents.push({
          agentInstanceId: String(agent.agentInstanceId || ''),
          ownerUbuddyId: String(agent.ownerUbuddyId || ''),
          baseSkillVersion: String(agent.baseSkillVersion || agent.skillVersion || 'base-v1'),
          activeSkillVersion: String(agent.activeSkillVersion || agent.skillVersion || 'base-v1'),
          memoryVersion: String(agent.memoryVersion || 'memory-v1'),
        });
      }
    }
    const snapshot = {
      namespace: this.namespace,
      method: this.method,
      round,
      capturedAt: new Date().toISOString(),
      policyVersionId: this.state.policy?.policyVersionId || 'org-policy-baseline-v1',
      profiles: profiles.map((profile) => ({
        ubuddyId: profile.ubuddyId, ownerUserId: profile.ownerUserId,
        revision: profile.revision || 1, contentHash: profile.contentHash || '',
      })),
      agents,
    };
    this.state.baseline = snapshot;
    this.state.agents = new Map(agents.map((agent) => [agent.agentInstanceId, { ...agent }]));
    this.state.profileConfidence = new Map(profiles.map((profile) => [profile.ubuddyId, Number(profile.confidence || 0.7)]));
    return snapshot;
  }

  attribute({ episode = {}, officialEvaluation = null } = {}) {
    const events = Array.isArray(episode.events) ? episode.events : [];
    const refs = (predicate) => events.filter(predicate).map((event) => String(event.eventId || event.sourceId || `${event.eventKind}:${event.occurredAt || ''}`));
    const trace = events.map((event) => ({
      eventKind: String(event.eventKind || ''),
      sourceKind: String(event.sourceKind || ''),
      sourceId: String(event.sourceId || event.eventId || ''),
      actorUserId: String(event.actorUserId || event.actorId || ''),
      occurredAt: String(event.occurredAt || ''),
    }));
    const hasEvaluator = Boolean(officialEvaluation && typeof officialEvaluation === 'object' && Number.isFinite(Number(officialEvaluation.totalCount)));
    const hasSnapshots = events.some((event) => event.eventKind === 'selection_snapshot_frozen');
    const evidenceRefs = trace.filter((item) => item.sourceId).map((item) => item.sourceId);
    const organizationEvidence = refs((event) => ['task_node_created', 'task_assigned', 'task_replanned', 'dependency_created', 'ubuddy_invited'].includes(event.eventKind));
    const individualEvidence = refs((event) => ['execution_failed', 'execution_retried', 'progress_published', 'handoff_published'].includes(event.eventKind));
    const failed = events.some((event) => event.eventKind === 'execution_failed');
    const succeeded = hasEvaluator ? Boolean(officialEvaluation.success) : events.some((event) => event.eventKind === 'result_accepted');
    const organizationSignals = organizationEvidence.length ? [{
      kind: failed ? 'organization_replanning_required' : 'collaboration_route_validated',
      confidence: hasEvaluator ? (succeeded ? 0.82 : 0.62) : 0.55,
      evidenceRefs: organizationEvidence,
      recommendation: failed ? '调整拆解、依赖或重新分配策略。' : '保留本次选人、拆解和依赖路径作为候选组织策略。',
    }] : [];
    const individualSignals = individualEvidence.length ? [{
      userId: String(episode.executions?.[0]?.ownerUbuddyId || ''),
      agentInstanceId: String(episode.executions?.[0]?.agentInstanceId || ''),
      kind: failed ? 'execution_capability_gap' : 'execution_capability_supported',
      confidence: hasEvaluator ? (succeeded ? 0.78 : 0.58) : 0.5,
      evidenceRefs: individualEvidence,
      recommendation: failed ? '将失败原因作为 Skill/Memory 缺口候选，等待验证。' : '将成功执行作为个体能力正向证据。',
    }] : [];
    const blockedReasons = [];
    if (!hasEvaluator) blockedReasons.push({ code: 'official_evaluator_missing' });
    if (!hasSnapshots) blockedReasons.push({ code: 'capability_selection_snapshot_missing' });
    if (!evidenceRefs.length) blockedReasons.push({ code: 'event_evidence_missing' });
    return {
      attributionVersion: 'ubuddy_process_attribution_v2',
      resultEligible: blockedReasons.length === 0,
      trace,
      organizationSignals,
      individualSignals,
      evolutionEvidenceRefs: evidenceRefs.map((sourceId) => ({ sourceKind: 'orgbench_event', sourceId, validationStatus: hasEvaluator ? 'validated' : 'unvalidated' })),
      evolutionRouting: { personalCandidates: individualSignals, clusterCandidates: organizationSignals, blockedReasons },
    };
  }

  buildOrganizationCandidate({ attribution, taskType = 'appworld', parentPolicyVersionId = '' } = {}) {
    const signal = attribution.organizationSignals?.[0];
    const playbook = validateUBuddyOrganizationPlaybook({
      version: UBUDDY_ORG_PLAYBOOK_VERSION,
      policyVersionId: `org-policy-${crypto.randomUUID()}`,
      parentPolicyVersionId: parentPolicyVersionId || this.state.policy?.policyVersionId || 'org-policy-baseline-v1',
      stage: 'decomposition',
      taskScopes: [{ id: 'orgbench-scope', taskTypes: [taskType], objectiveIncludes: [] }],
      assignmentRules: [],
      decompositionRules: [{ id: signal?.kind || 'evidence_decomposition', operator: 'require_synthesis_stage', taskTypes: [taskType], objectiveIncludes: [], role: 'review', minimumConfidence: this.gateThreshold, evidenceCount: signal?.evidenceRefs?.length || 0, rationale: signal?.recommendation || '' }],
      hardConstraints: { preserveMentionedAgents: true },
      provenance: { algorithmVersion: 'ubuddy_org_policy_miner_v1', evidenceTraceIds: signal?.evidenceRefs || [], evidenceCount: signal?.evidenceRefs?.length || 0, summary: signal?.recommendation || '' },
      createdAt: new Date().toISOString(),
    });
    const policyHash = uBuddyOrganizationPolicyHash(playbook);
    return {
      policyVersionId: playbook.policyVersionId,
      parentPolicyVersionId: playbook.parentPolicyVersionId,
      playbook,
      policyHash,
      candidateHash: sha256(JSON.stringify({ policyHash, namespace: this.namespace })),
      namespace: this.namespace,
      validationStatus: 'validated',
      baselineScore: 0,
    };
  }

  buildIndividualCandidates({ attribution, episode = {} } = {}) {
    return (attribution.individualSignals || []).filter((signal) => signal.agentInstanceId).map((signal) => ({
      candidateVersion: `skill-candidate-${crypto.randomUUID()}`,
      agentInstanceId: signal.agentInstanceId,
      sourceEvidenceIds: signal.evidenceRefs || [],
      candidateHash: sha256(JSON.stringify({ signal, namespace: this.namespace })),
      validationStatus: 'validated',
      candidateContentHash: sha256(signal.recommendation || ''),
      confidence: Number(signal.confidence || 0),
      ownerUbuddyId: String(episode.executions?.find((item) => item.agentInstanceId === signal.agentInstanceId)?.ownerUbuddyId || ''),
      profileConfidenceDelta: signal.kind.includes('gap') ? -0.05 : 0.05,
      skillSummary: signal.recommendation || '',
      memorySummary: `evidence:${(signal.evidenceRefs || []).join(',')}`,
      adoptionStatus: 'pending',
      baseSkillVersion: this.state.agents.get(signal.agentInstanceId)?.activeSkillVersion || 'base-v1',
      episodeId: episode.episodeId || '',
    }));
  }

  gate({ officialEvaluation = null, attribution = {}, candidate = {}, shadowScore = 0, privacyFindings = [] } = {}) {
    const reasons = [];
    if (!officialEvaluation || !Number.isFinite(Number(officialEvaluation.totalCount))) reasons.push('official_evaluator_missing');
    if (Number(officialEvaluation?.passPercentage || 0) < 50) reasons.push('checkpoint_threshold_not_met');
    if (!attribution.resultEligible) reasons.push(...(attribution.evolutionRouting?.blockedReasons || []).map((item) => item.code));
    if (Number(candidate.confidence || 0) < this.gateThreshold) reasons.push('confidence_below_threshold');
    if (!candidate.sourceEvidenceIds?.length) reasons.push('evidence_refs_missing');
    if (privacyFindings.length) reasons.push('privacy_risk');
    if (candidate.validationStatus && candidate.validationStatus !== 'validated') reasons.push('evidence_not_validated');
    if (candidate.candidateHash && candidate.expectedCandidateHash && candidate.candidateHash !== candidate.expectedCandidateHash) reasons.push('candidate_hash_mismatch');
    if (candidate.namespace && candidate.namespace !== this.namespace) reasons.push('candidate_namespace_mismatch');
    if (Number(shadowScore || 0) < 0) reasons.push('shadow_replay_regression');
    const uniqueReasons = [...new Set(reasons.filter(Boolean))];
    return { adopted: uniqueReasons.length === 0, blockedReason: uniqueReasons[0] || '', reasons: uniqueReasons, checkedAt: new Date().toISOString() };
  }

  async routeAttribution({ delegationId = '', attribution = {} } = {}) {
    if (!this.client || typeof this.client.routeAttribution !== 'function') return { status: 'fallback', resultEligible: false, reason: 'janus_client_unavailable' };
    try {
      // In production Cloud, a personal evolution route is owner-scoped.  A
      // requester token can therefore route the organization signal, but it
      // must not silently impersonate recipient users.  For controlled
      // experiments, optional owner grants allow one route per signal owner.
      const ownerTokens = (() => {
        try { return JSON.parse(process.env.UBUDDY_ORGBENCH_EVOLUTION_OWNER_TOKENS || '{}') || {}; } catch { return {}; }
      })();
      const owners = [...new Set((attribution.individualSignals || []).map((item) => String(item.userId || '')).filter(Boolean))];
      const responses = [];
      const requesterResponse = await this.client.routeAttribution(delegationId, attribution);
      responses.push(requesterResponse);
      for (const owner of owners) {
        const token = String(ownerTokens[owner] || '');
        if (!token || typeof this.client.routeAttributionAs !== 'function') continue;
        responses.push(await this.client.routeAttributionAs(delegationId, attribution, token));
      }
      for (const response of responses) this.requests.push(response);
      const runs = responses.flatMap((response) => response?.payload?.personalRuns || response?.personalRuns || []);
      const blockedReasons = responses.flatMap((response) => response?.payload?.blockedReasons || response?.blockedReasons || []);
      const first = responses[0] || {};
      if (first?.status === 'skipped') return { ...first, status: 'fallback', resultEligible: false };
      return { ...first, payload: { ...(first.payload || {}), personalRuns: runs, blockedReasons }, personalRuns: runs, blockedReasons };
    } catch (error) {
      const failure = { status: 'fallback', resultEligible: false, reason: String(error?.message || error) };
      this.requests.push(failure);
      return failure;
    }
  }

  async processRound1({ episode = {}, officialEvaluation = null, taskType = 'appworld', delegationId = '' } = {}) {
    const baseline = this.baselineSnapshot({ episode, round: 1 });
    const attribution = this.attribute({ episode, officialEvaluation });
    const organizationCandidate = this.buildOrganizationCandidate({ attribution, taskType, parentPolicyVersionId: baseline.policyVersionId });
    const individualCandidates = this.buildIndividualCandidates({ attribution, episode });
    const updates = [];
    if (this.method !== 'E2_individual_only' && this.method !== 'E0_static') {
      const gate = this.method === 'E4_joint_no_gate'
        ? { adopted: true, reasons: [], blockedReason: '', checkedAt: new Date().toISOString() }
        : this.gate({ officialEvaluation, attribution, candidate: { ...organizationCandidate, confidence: attribution.organizationSignals?.[0]?.confidence || 0, sourceEvidenceIds: attribution.organizationSignals?.[0]?.evidenceRefs || [] }, shadowScore: 0 });
      updates.push({ scope: 'organization', candidate: organizationCandidate, ...gate, adoptionStatus: gate.adopted ? 'adopted' : 'blocked' });
      if (gate.adopted) this.state.policy = organizationCandidate;
    }
    if (this.method === 'E2_individual_only' || this.method === 'E3_joint_gated' || this.method === 'E4_joint_no_gate') {
      for (const candidate of individualCandidates) {
        const gate = this.method === 'E4_joint_no_gate' ? { adopted: true, reasons: [], blockedReason: '' } : this.gate({ officialEvaluation, attribution, candidate, shadowScore: 0 });
        const update = { scope: 'individual', candidate, ...gate, adoptionStatus: gate.adopted ? 'adopted' : 'blocked' };
        updates.push(update);
        if (gate.adopted) {
          const previous = this.state.agents.get(candidate.agentInstanceId) || { activeSkillVersion: 'base-v1', memoryVersion: 'memory-v1' };
          this.state.agents.set(candidate.agentInstanceId, { ...previous, activeSkillVersion: candidate.candidateVersion, candidateVersion: candidate.candidateVersion, memoryVersion: `memory-${candidate.candidateVersion}`, capabilityConfidenceDelta: candidate.profileConfidenceDelta });
          if (candidate.ownerUbuddyId) this.state.profileConfidence.set(candidate.ownerUbuddyId, Math.max(0, Math.min(1, Number(this.state.profileConfidence.get(candidate.ownerUbuddyId) || 0.7) + candidate.profileConfidenceDelta)));
        }
      }
    }
    const routed = ['E2_individual_only', 'E3_joint_gated', 'E4_joint_no_gate'].includes(this.method)
      ? await this.routeAttribution({ delegationId, attribution })
      : { status: 'skipped', resultEligible: false, reason: 'method_does_not_update_personal_state', method: this.method };
    const cloudUpdates = await this.applyCloudCandidates({ updates, routed, namespace: this.namespace });
    // A local gate pass is not equivalent to Cloud activation.  Keep the
    // artifact honest when the production API rejects or cannot materialize a
    // candidate (permissions, missing grant, worker failure, etc.).
    for (const failed of [...(cloudUpdates.organization || []), ...(cloudUpdates.personal || [])].filter((item) => ['failed', 'blocked'].includes(item.status))) {
      const candidateId = failed.policyVersionId || failed.candidateVersion || '';
      const update = updates.find((item) => item.candidate?.policyVersionId === candidateId || item.candidate?.candidateVersion === candidateId);
      if (update && update.adoptionStatus === 'adopted') {
        update.adoptionStatus = 'cloud_blocked';
        update.cloudBlockedReason = failed.error || failed.reasons || 'cloud_candidate_not_activated';
      }
    }
    if (this.client?.enabled) {
      const activatedPersonal = new Set((cloudUpdates.personal || []).filter((item) => item.status === 'activated').map((item) => item.agentInstanceId));
      for (const update of updates.filter((item) => item.scope === 'individual' && item.adoptionStatus === 'adopted')) {
        if (activatedPersonal.has(update.candidate.agentInstanceId)) continue;
        update.adoptionStatus = 'cloud_blocked';
        update.cloudBlockedReason = 'personal_candidate_not_activated';
        const original = baseline.agents.find((item) => item.agentInstanceId === update.candidate.agentInstanceId);
        if (original) this.state.agents.set(original.agentInstanceId, { ...original });
      }
    }
    await this.save('evolution_baseline.json', baseline);
    await this.save('attribution.json', attribution);
    await this.saveJsonl('evolution_candidates.jsonl', updates.map((item) => item.candidate));
    await this.saveJsonl('evolution_updates.jsonl', updates);
    await this.save('profile_updates.json', { namespace: this.namespace, profileConfidence: Object.fromEntries(this.state.profileConfidence), agentVersions: [...this.state.agents.values()] });
    await this.save('evolution_route.json', routed);
    await this.save('cloud_evolution_updates.json', cloudUpdates);
    await this.saveJsonl('api_requests.jsonl', this.client?.audit || this.requests);
    return { baseline, attribution, updates, routed, cloudUpdates, activePolicy: this.state.policy, activeAgents: [...this.state.agents.values()], activeProfileConfidence: Object.fromEntries(this.state.profileConfidence) };
  }

  async applyCloudCandidates({ updates = [], routed = {}, namespace = 'default' } = {}) {
    if (!this.client?.enabled) return { status: 'fallback', resultEligible: false, reason: 'janus_cloud_disabled', organization: [], personal: [] };
    const organization = [];
    const personal = [];
    for (const update of updates.filter((item) => item.scope === 'organization')) {
      if (!update.adopted) { organization.push({ status: 'blocked', policyVersionId: update.candidate.policyVersionId, reasons: update.reasons }); continue; }
      try {
        const created = await this.client.createOrganizationPolicy({ evolutionNamespace: namespace, playbook: update.candidate.playbook, baselineScore: update.candidate.baselineScore });
        const activated = await this.client.activateOrganizationPolicy(update.candidate.policyVersionId, { evolutionNamespace: namespace, expectedActivePolicyVersionId: update.candidate.parentPolicyVersionId, commandId: `orgbench-activate-${crypto.randomUUID()}` });
        organization.push({ status: 'activated', created, activated, policyVersionId: update.candidate.policyVersionId });
      } catch (error) { organization.push({ status: 'failed', policyVersionId: update.candidate.policyVersionId, error: String(error?.message || error) }); }
    }
    const routePayload = routed?.payload || routed;
    const runs = Array.isArray(routePayload?.personalRuns) ? routePayload.personalRuns : [];
    for (const queued of runs) {
      const runId = queued?.run?.id || queued?.id || '';
      if (!runId) continue;
      try {
        const runResponse = await this.pollPersonalRun(runId);
        const run = runResponse?.payload || runResponse;
        const rawCandidate = run.candidateVersion || run.candidateVersionId || run.candidatePersonalSkillVersionId || run.candidate_personal_skill_version_id;
        const candidate = typeof rawCandidate === 'string' ? { id: rawCandidate } : rawCandidate;
        if (!candidate?.id) { personal.push({ runId, status: run.status || 'candidate_unavailable' }); continue; }
        const localUpdate = updates.find((item) => item.scope === 'individual' && item.candidate.agentInstanceId === run.agentInstanceId);
        if (!localUpdate?.adopted) { personal.push({ runId, status: 'blocked', candidateVersion: candidate.id, reasons: localUpdate?.reasons || ['local_evidence_gate_failed'] }); continue; }
        const versionsResponse = await this.client.personalVersions(run.agentInstanceId);
        const versions = versionsResponse?.payload?.items || [];
        const active = versions.find((item) => item.status === 'active');
        const memoryDecisions = (run.memoryOperations || []).map((item) => ({ operationId: item.id, decision: 'accept' }));
        if (memoryDecisions.length) await this.client.decidePersonalRun(runId, { memoryDecisions });
        const activated = await this.client.activatePersonalVersion(candidate.id, { agentInstanceId: run.agentInstanceId, expectedActiveVersionId: active?.id || '', commandId: `orgbench-personal-activate-${crypto.randomUUID()}` });
        const current = this.state.agents.get(run.agentInstanceId) || { agentInstanceId: run.agentInstanceId, activeSkillVersion: active?.id || 'base-v1', memoryVersion: 'memory-v1' };
        this.state.agents.set(run.agentInstanceId, { ...current, activeSkillVersion: candidate.id, candidateVersion: candidate.id, skillSummary: candidate.overlayText || current.skillSummary || '', effectiveSkillHash: candidate.effectiveSkillHash || '' });
        personal.push({ runId, status: 'activated', agentInstanceId: run.agentInstanceId, candidateVersion: candidate.id, previousVersion: active?.id || '', activated });
      } catch (error) { personal.push({ runId, status: 'failed', error: String(error?.message || error) }); }
    }
    return { status: organization.some((item) => item.status === 'failed') || personal.some((item) => item.status === 'failed') ? 'partial' : 'completed', resultEligible: true, organization, personal };
  }

  async pollPersonalRun(runId) {
    const timeoutMs = Math.max(1_000, Number(process.env.UBUDDY_ORGBENCH_EVOLUTION_POLL_TIMEOUT_MS || 180_000));
    const intervalMs = Math.max(250, Number(process.env.UBUDDY_ORGBENCH_EVOLUTION_POLL_INTERVAL_MS || 2_000));
    const startedAt = Date.now();
    let latest = null;
    while (Date.now() - startedAt < timeoutMs) {
      latest = await this.client.personalRun(runId);
      const status = String(latest?.payload?.status || latest?.status || '');
      if (['available', 'applied', 'evaluated_rejected', 'failed_terminal'].includes(status)) return latest;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`personal_evolution_poll_timeout:${runId}:${latest?.payload?.status || ''}`);
  }

  evaluateRollback({ round1Metrics = {}, round2Metrics = {} } = {}) {
    const delta = (key) => Number(round2Metrics[key] ?? 0) - Number(round1Metrics[key] ?? 0);
    const reasons = [];
    if (delta('officialSuccess') < -0.1 || delta('officialCheckpointRate') < -0.1) reasons.push('official_performance_regression');
    const round1Rework = Number(round1Metrics.reworkCount ?? round1Metrics.retryCount ?? 0);
    const round2Rework = Number(round2Metrics.reworkCount ?? round2Metrics.retryCount ?? 0);
    if (round2Rework - round1Rework > 0.1 || delta('dependencyViolationCount') > 0.1) reasons.push('coordination_regression');
    return { triggered: reasons.length > 0, reasons, fromPolicyVersion: this.state.policy?.policyVersionId || '', toPolicyVersion: this.state.baseline?.policyVersionId || '', recovered: reasons.length === 0 };
  }

  async finalizeRound2({ round1 = {}, round2Episode = {}, round2Metrics = {} } = {}) {
    const rollback = this.evaluateRollback({ round1Metrics: round1.episode?.metrics || {}, round2Metrics });
    const cloudRollback = [];
    if (rollback.triggered) {
      if (this.client?.enabled) {
        if (this.state.policy?.policyVersionId) {
          try {
            cloudRollback.push({ scope: 'organization', action: 'disable', result: await this.client.disableOrganizationPolicy({ evolutionNamespace: this.namespace, policyVersionId: this.state.policy.policyVersionId, reason: rollback.reasons.join(',') }) });
          } catch (error) { cloudRollback.push({ scope: 'organization', action: 'disable', status: 'failed', error: String(error?.message || error) }); }
        }
      }
      this.state.policy = null;
      for (const [id, baseline] of this.state.agents.entries()) {
        const original = this.state.baseline?.agents?.find((item) => item.agentInstanceId === id);
        if (original) {
          if (this.client?.enabled && baseline.activeSkillVersion && baseline.activeSkillVersion !== original.activeSkillVersion && original.activeSkillVersion !== 'base-v1') {
            try {
              cloudRollback.push({ scope: 'individual', agentInstanceId: id, action: 'rollback', result: await this.client.rollbackPersonal({ agentInstanceId: id, targetVersionId: original.activeSkillVersion, expectedActiveVersionId: baseline.activeSkillVersion, commandId: `orgbench-rollback-${crypto.randomUUID()}` }) });
            } catch (error) { cloudRollback.push({ scope: 'individual', agentInstanceId: id, action: 'rollback', status: 'failed', error: String(error?.message || error) }); }
          }
          this.state.agents.set(id, { ...baseline, activeSkillVersion: original.activeSkillVersion, memoryVersion: original.memoryVersion, candidateVersion: '' });
        }
      }
    }
    rollback.cloudActions = cloudRollback;
    rollback.recovered = rollback.triggered && cloudRollback.some((item) => item.status === 'failed') ? false : true;
    await this.save('rollback.json', { ...rollback, round2Metrics, recoveredState: { policy: this.state.policy, agents: [...this.state.agents.values()] } });
    return { rollback, activePolicy: this.state.policy, activeAgents: [...this.state.agents.values()], round2Episode };
  }
}

function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }

export function createEvolutionCoordinator(options = {}) { return new EvolutionCoordinator(options); }
