import { methodFeatures } from '../schema.mjs';
import { evaluateEightDimensions } from './eightDimensions.mjs';

export function evaluateEpisode({ scenario, method, graph, events, officialEvaluation = null }) {
  const taskNodes = [...graph.nodes.values()].filter((node) => node.kind !== 'project');
  const internalNodes = taskNodes.filter((node) => node.kind === 'internal_agent_task');
  const completed = internalNodes.filter((node) => node.status === 'done').length;
  const selectedUbuddy = new Set(taskNodes.filter((node) => node.owner !== 'ubuddy_A').map((node) => node.owner));
  const failures = events.filter((event) => event.eventKind === 'execution_failed').length;
  const retries = events.filter((event) => event.eventKind === 'execution_retried').length;
  const reworkCount = events.filter((event) => ['result_rejected', 'task_replanned', 'requirement_revised'].includes(event.eventKind)).length;
  const staleReads = events.filter((event) => event.metadata?.staleRead).length;
  const privateLeaks = events.filter((event) => event.metadata?.privateLeak).length;
  const dependencyViolations = events.filter((event) => event.metadata?.dependencyViolation).length;
  const profileSnapshot = events.filter((event) => event.eventKind === 'selection_snapshot_frozen').length;
  const projectSuccess = internalNodes.length > 0 && completed === internalNodes.length && dependencyViolations === 0 && privateLeaks === 0 && (officialEvaluation?.success ?? true);
  const features = methodFeatures(method);
  const requirementCapabilities = new Set((scenario.requirements || []).map((item) => item.capability));
  const plannedCapabilities = new Set(taskNodes.map((node) => node.capability).filter(Boolean));
  const targetCoverage = requirementCapabilities.size ? [...requirementCapabilities].filter((capability) => plannedCapabilities.has(capability) || (capability === 'execution' && plannedCapabilities.has('web_operation'))).length / requirementCapabilities.size : null;
  const normalizedLeafKeys = internalNodes.map((node) => `${String(node.title || '').trim().toLowerCase()}|${node.capability || ''}`);
  const duplicateTaskRate = normalizedLeafKeys.length ? 1 - new Set(normalizedLeafKeys).size / normalizedLeafKeys.length : 0;
  const internalAssignments = events.filter((event) => event.eventKind === 'internal_agent_selected');
  const regrets = internalAssignments.map((event) => { const node = graph.nodes.get(event.sourceId); const pool = scenario.internalPools?.[event.metadata?.ownerUbuddyId]?.agents || []; const selected = pool.find((agent) => agent.agentInstanceId === event.metadata?.agentInstanceId); const eligible = pool.filter((agent) => agent.capabilities.includes(node?.capability) || agent.capabilities.includes('execution')); const best = Math.max(0, ...(eligible.length ? eligible : pool).map((agent) => agent.strength || 0)); return selected ? Math.max(0, best - (selected.strength || 0)) : 1; });
  const officialCheckpointRate = officialEvaluation?.totalCount ? officialEvaluation.passCount / officialEvaluation.totalCount : null;
  const eightDimensions = evaluateEightDimensions({ scenario, method, graph, events, officialEvaluation, gold: scenario.hiddenTruth, fault: scenario.injectFault ? { faultType: scenario.injectFault } : null });
  return {
    method,
    projectSuccess,
    officialSuccess: officialEvaluation?.success ?? null,
    atomicSuccessRate: officialCheckpointRate,
    officialCheckpointRate,
    officialPassCount: officialEvaluation?.passCount ?? null,
    officialCheckpointCount: officialEvaluation?.totalCount ?? null,
    selectedUbuddyCount: selectedUbuddy.size,
    internalAgentTaskCount: internalNodes.length,
    completedLeafRate: internalNodes.length ? completed / internalNodes.length : 0,
    failureCount: failures,
    retryCount: retries,
    reworkCount,
    staleReadRate: staleReads / Math.max(1, events.length),
    dependencyViolationCount: dependencyViolations,
    privateLeakCount: privateLeaks,
    profileSnapshotCount: profileSnapshot,
    boardUpdateCount: events.filter((event) => event.eventKind === 'progress_published').length,
    delegationCount: events.filter((event) => event.eventKind === 'ubuddy_invited').length,
    replanningCount: events.filter((event) => event.eventKind === 'task_replanned').length,
    targetCoverage,
    duplicateTaskRate,
    meanInternalAllocationRegret: regrets.length ? regrets.reduce((sum, value) => sum + value, 0) / regrets.length : null,
    organizationFormationEventCount: events.findIndex((event) => event.eventKind === 'execution_started') + 1,
    checkpointPerBoardUpdate: officialEvaluation?.passCount != null ? officialEvaluation.passCount / Math.max(1, events.filter((event) => event.eventKind === 'progress_published').length) : null,
    protocolFeatures: features,
    ...eightDimensions,
  };
}

export function aggregateMetrics(rows) {
  const byMethod = {};
  for (const row of rows) {
    const bucket = byMethod[row.method] ||= { n: 0, projectSuccess: 0, completedLeafRate: 0, officialCheckpointRateTotal: 0, officialCheckpointRateN: 0, targetCoverageTotal: 0, targetCoverageN: 0, allocationRegretTotal: 0, allocationRegretN: 0, dependencyViolationCount: 0, privateLeakCount: 0, delegationCount: 0, replanningCount: 0 };
    bucket.n += 1;
    bucket.projectSuccess += Number(row.projectSuccess);
    bucket.completedLeafRate += row.completedLeafRate;
    bucket.dependencyViolationCount += row.dependencyViolationCount;
    bucket.privateLeakCount += row.privateLeakCount;
    bucket.delegationCount += row.delegationCount;
    bucket.replanningCount += row.replanningCount;
    if (row.officialCheckpointRate != null) { bucket.officialCheckpointRateTotal += row.officialCheckpointRate; bucket.officialCheckpointRateN += 1; }
    if (row.targetCoverage != null) { bucket.targetCoverageTotal += row.targetCoverage; bucket.targetCoverageN += 1; }
    if (row.meanInternalAllocationRegret != null) { bucket.allocationRegretTotal += row.meanInternalAllocationRegret; bucket.allocationRegretN += 1; }
  }
  for (const bucket of Object.values(byMethod)) { bucket.projectSuccessRate = bucket.projectSuccess / bucket.n; bucket.meanCompletedLeafRate = bucket.completedLeafRate / bucket.n; bucket.meanOfficialCheckpointRate = bucket.officialCheckpointRateN ? bucket.officialCheckpointRateTotal / bucket.officialCheckpointRateN : null; bucket.meanTargetCoverage = bucket.targetCoverageN ? bucket.targetCoverageTotal / bucket.targetCoverageN : null; bucket.meanInternalAllocationRegret = bucket.allocationRegretN ? bucket.allocationRegretTotal / bucket.allocationRegretN : null; }
  return { episodeCount: rows.length, byMethod };
}
