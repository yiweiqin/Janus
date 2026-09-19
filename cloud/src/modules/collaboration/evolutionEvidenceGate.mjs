/** Pure eligibility gate for collaboration attribution evidence. */
export function evaluateEvolutionEvidenceGate(refs = [], {
  delegationId = '', ownerUserId = '', agentInstanceId = '', expectedRefs = [],
} = {}) {
  const reasons = [];
  const items = Array.isArray(refs) ? refs : [];
  if (!items.length) reasons.push({ code: 'evolution_evidence_missing' });
  for (const ref of items) {
    const evidenceId = ref?.evidenceId || ref?.evidence_id || '';
    if (!evidenceId) reasons.push({ code: 'evolution_evidence_id_missing' });
    const status = String(ref?.validationStatus || ref?.validation_status || '').toLowerCase();
    if (status !== 'validated') reasons.push({ code: status === 'quarantined' ? 'evolution_evidence_quarantined' : 'evolution_evidence_not_validated', evidenceId: ref?.evidenceId || ref?.evidence_id || '' });
    if (ref?.historical_inactive === true || ref?.historicalInactive === true || ref?.invalidated === true) reasons.push({ code: 'evolution_evidence_invalidated', evidenceId });
    if (ref?.quarantine_reason || ref?.quarantineReason) reasons.push({ code: 'evolution_evidence_quarantined', evidenceId });
    const version = String(ref?.sourceVersionId || ref?.source_version_id || '').trim();
    if (!version) reasons.push({ code: 'evolution_evidence_source_version_missing', evidenceId });
    const scope = String(ref?.delegationId || ref?.delegation_id || ref?.metadata?.delegationId || '').trim();
    if (!delegationId || scope !== String(delegationId)) reasons.push({ code: 'evolution_evidence_scope_mismatch', evidenceId });
    const owner = String(ref?.ownerUserId || ref?.owner_user_id || '').trim();
    const instance = String(ref?.agentInstanceId || ref?.user_agent_instance_id || '').trim();
    if (!owner || !instance) reasons.push({ code: 'evolution_evidence_identity_missing', evidenceId });
    if (ownerUserId && String(ref?.ownerUserId || ref?.owner_user_id || '').trim() !== String(ownerUserId)) reasons.push({ code: 'evolution_evidence_owner_mismatch', evidenceId: ref?.evidenceId || '' });
    if (agentInstanceId && String(ref?.agentInstanceId || ref?.user_agent_instance_id || '').trim() !== String(agentInstanceId)) reasons.push({ code: 'evolution_evidence_agent_instance_mismatch', evidenceId: ref?.evidenceId || '' });
  }
  for (const expected of expectedRefs) {
    const evidenceId = expected.evidenceId || expected.evidence_id || '';
    const actual = items.find((ref) => (ref?.evidenceId || ref?.evidence_id) === evidenceId);
    if (!actual) { reasons.push({ code: 'evolution_evidence_reference_unverified', evidenceId }); continue; }
    for (const [camel, snake, ...aliases] of [['sourceVersionId', 'source_version_id'], ['ownerUserId', 'owner_user_id'], ['agentInstanceId', 'user_agent_instance_id'], ['replayToken', 'replay_token', 'tdbReplayToken'], ['traceHash', 'trace_hash', 'tdbTraceHash']]) {
      // Replay bindings are optional for legacy evidence. When a caller
      // supplies one, however, the authoritative row must carry the same
      // value (directly or in metadata_json). This prevents an evidence ref
      // from being replayed against a different TDB trace.
      const expectedValue = expected[camel] || aliases.map((key) => expected[key]).find(Boolean);
      if (!expectedValue) continue;
      const metadata = actual?.metadata && typeof actual.metadata === 'object' ? actual.metadata : (() => {
        try { return actual?.metadata_json ? JSON.parse(actual.metadata_json) : {}; } catch { return {}; }
      })();
      const actualValue = actual[camel] || actual[snake] || aliases.map((key) => actual[key]).find(Boolean)
        || metadata[camel] || metadata[snake]
        || aliases.map((key) => metadata[key]).find(Boolean);
      if (String(expectedValue) !== String(actualValue || '')) reasons.push({ code: 'evolution_evidence_reference_binding_mismatch', evidenceId, field: camel });
    }
  }
  return { ok: reasons.length === 0, reasons };
}
