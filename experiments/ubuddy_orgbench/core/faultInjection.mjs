export const FAULT_TYPES = ['internal_agent_failure', 'recipient_timeout', 'stale_profile', 'tool_unavailable', 'superseded_result', 'requirement_revision', 'board_conflict', 'agent_overload'];

export function validateFaultManifest(manifest) {
  if (!manifest || !FAULT_TYPES.includes(manifest.faultType)) throw new Error('invalid_fault_type');
  if (!manifest.injectionPoint || !manifest.expectedRecoveryPolicy) throw new Error('fault_manifest_missing_contract');
  return true;
}

export function faultEventMetadata(manifest, clock = Date.now()) {
  validateFaultManifest(manifest);
  return { injected: true, fault: manifest.faultType, injectionPoint: manifest.injectionPoint, expectedRecoveryPolicy: manifest.expectedRecoveryPolicy, injectedAt: new Date(clock).toISOString(), seed: manifest.seed ?? null };
}
