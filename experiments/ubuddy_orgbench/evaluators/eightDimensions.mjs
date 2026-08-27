import { DIMENSIONS, LAYERS } from '../schema.mjs';

const n = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const ratio = (a, b) => b > 0 ? a / b : null;
const eventsOf = (events, kind) => events.filter((event) => event.eventKind === kind);
const unique = (items) => new Set(items);

function taskNodes(graph) {
  const nodes = graph?.nodes instanceof Map ? [...graph.nodes.values()] : (graph?.nodes || []);
  return nodes.filter((node) => node.kind !== 'project');
}

function decomposition({ scenario, graph, gold }) {
  const nodes = taskNodes(graph);
  const leaves = nodes.filter((node) => node.kind === 'internal_agent_task');
  const requirements = gold?.requirements || scenario?.requirements || [];
  const planned = new Set(nodes.map((node) => node.capability).filter(Boolean));
  const required = new Set(requirements.map((item) => item.capability).filter(Boolean));
  const covered = [...required].filter((capability) => planned.has(capability) || (capability === 'execution' && planned.has('web_operation'))).length;
  const keys = leaves.map((node) => `${String(node.title || '').trim().toLowerCase()}|${node.capability || ''}`);
  const duplicate = keys.length - unique(keys).size;
  const edges = graph?.edges || [];
  const dependencyEdges = edges.filter((edge) => edge.kind === 'dependency_of');
  const forbidden = new Set((gold?.forbiddenDependencies || []).map((edge) => `${edge.from}->${edge.to}`));
  const invalidDeps = dependencyEdges.filter((edge) => forbidden.has(`${edge.from}->${edge.to}`)).length;
  const expected = gold?.requiredDependencies || [];
  const expectedKeys = new Set(expected.map((edge) => `${edge.from}->${edge.to}`));
  const actualKeys = new Set(dependencyEdges.map((edge) => `${edge.from}->${edge.to}`));
  const dependencyCorrect = expectedKeys.size ? [...expectedKeys].filter((key) => actualKeys.has(key)).length / expectedKeys.size : (invalidDeps ? 0 : 1);
  const depths = new Map([['project_root', 0]]);
  for (const node of nodes) depths.set(node.id, n(depths.get(node.parentNodeId), 0) + 1);
  const depthValues = [...depths.values()];
  const invalidLeaf = leaves.filter((node) => !node.title || !node.description || !node.capability).length;
  return {
    targetCoverage: ratio(covered, required.size), omissionRate: required.size ? 1 - covered / required.size : 0,
    duplicateTaskRate: ratio(duplicate, keys.length) || 0, dependencyCorrectRate: dependencyCorrect,
    meanTaskTreeDepth: ratio(depthValues.reduce((a, b) => a + b, 0), depthValues.length) || 0,
    invalidLeafRate: ratio(invalidLeaf, leaves.length) || 0,
    taskCount: nodes.length, leafCount: leaves.length, dependencyViolationCount: invalidDeps,
  };
}

function allocation({ scenario, graph, events, gold }) {
  const selections = eventsOf(events, 'ubuddy_invited').map((event) => event.metadata?.recipientUbuddyId || event.sourceId).filter(Boolean);
  const internal = eventsOf(events, 'internal_agent_selected');
  const required = gold?.requirements || scenario?.requirements || [];
  const candidateCaps = gold?.candidateCapabilities || scenario?.hiddenTruth?.candidateCapabilities || {};
  const selectedCaps = new Set(selections.flatMap((id) => candidateCaps[id] || []));
  const covered = required.filter((item) => selectedCaps.has(item.capability)).length;
  const ideal = new Set(Object.entries(candidateCaps).filter(([, caps]) => required.some((item) => caps.includes(item.capability))).map(([id]) => id));
  const recipientRegret = Math.max(0, ideal.size - new Set(selections).size) / Math.max(1, ideal.size);
  const pools = scenario?.internalPools || {};
  const regrets = internal.map((event) => {
    const owner = event.metadata?.ownerUbuddyId || event.actorId;
    const pool = pools[owner]?.agents || [];
    const selected = pool.find((agent) => agent.agentInstanceId === event.metadata?.agentInstanceId);
    const node = (graph?.nodes instanceof Map ? graph.nodes.get(event.sourceId) : (graph?.nodes || []).find((item) => item.id === event.sourceId));
    const eligible = pool.filter((agent) => !node?.capability || agent.capabilities?.includes(node.capability) || agent.capabilities?.includes('execution'));
    const best = Math.max(0, ...(eligible.length ? eligible : pool).map((agent) => n(agent.strength)));
    return selected ? Math.max(0, best - n(selected.strength)) : 1;
  });
  const loads = [...new Set(internal.map((event) => event.metadata?.agentInstanceId).filter(Boolean))].map((id) => internal.filter((event) => event.metadata?.agentInstanceId === id).length);
  const mean = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
  const variance = loads.length ? loads.reduce((a, b) => a + (b - mean) ** 2, 0) / loads.length : 0;
  return { recipientCapabilityMatchRate: ratio(covered, required.length), recipientAllocationRegret: recipientRegret, meanInternalAllocationRegret: ratio(regrets.reduce((a, b) => a + b, 0), regrets.length), loadVariance: variance, selectedRecipientCount: new Set(selections).size, internalSelectionCount: internal.length };
}

function communication({ events }) {
  const updates = events.filter((event) => ['progress_published', 'handoff_published', 'handoff_superseded'].includes(event.eventKind));
  const stale = events.filter((event) => event.metadata?.staleRead).length;
  const conflicts = events.filter((event) => event.metadata?.conflict || event.metadata?.stateConflict).length;
  const latencies = events.map((event) => n(event.metadata?.updateLatencyMs, NaN)).filter(Number.isFinite);
  const tokens = events.reduce((sum, event) => sum + n(event.metadata?.boardTokens), 0);
  const effective = updates.filter((event) => event.metadata?.useful !== false).length;
  return { boardUpdateCount: updates.length, effectiveStateCoverage: ratio(effective, updates.length), staleReadRate: ratio(stale, events.length), conflictStateRate: ratio(conflicts, events.length), boardTokenCost: tokens, meanUpdateLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null, redundantUpdateRate: updates.length ? 1 - effective / updates.length : 0 };
}

function recovery({ events, fault }) {
  const injected = fault?.faultType || events.find((event) => event.metadata?.fault)?.metadata?.fault || null;
  const failures = events.filter((event) => event.eventKind === 'execution_failed' || event.eventKind === 'execution_blocked');
  const recoveries = events.filter((event) => ['execution_retried', 'task_replanned', 'evolution_adopted'].includes(event.eventKind));
  const discovered = failures.filter((event) => event.metadata?.detectedAt || event.metadata?.fault || event.eventKind === 'execution_failed').length;
  const recoveryTime = events.map((event) => n(event.metadata?.recoveryTimeMs, NaN)).filter(Number.isFinite);
  const propagated = events.filter((event) => event.metadata?.errorPropagated || event.metadata?.continuedFromError).length;
  return { faultType: injected, faultInjected: Boolean(injected), faultDiscoveryRate: failures.length ? discovered / failures.length : null, recoverySuccessRate: failures.length ? Math.min(1, recoveries.length / failures.length) : null, meanRecoveryTimeMs: recoveryTime.length ? recoveryTime.reduce((a, b) => a + b, 0) / recoveryTime.length : null, errorPropagationRate: ratio(propagated, Math.max(1, failures.length)), reworkRange: events.filter((event) => ['result_rejected', 'task_replanned', 'requirement_revised'].includes(event.eventKind)).length, unnecessaryReplanRate: ratio(events.filter((event) => event.eventKind === 'task_replanned' && event.metadata?.unnecessary).length, events.filter((event) => event.eventKind === 'task_replanned').length) || 0 };
}

function attribution({ attribution }) {
  if (!attribution) return { available: false, reason: 'attribution_artifact_missing' };
  return { available: true, ...attribution };
}

export function evaluateEightDimensions({ scenario, graph, events = [], officialEvaluation = null, gold = null, fault = null, attribution: attributionArtifact = null }) {
  const org = { officialSuccess: officialEvaluation?.success ?? null, officialCheckpointRate: officialEvaluation?.totalCount ? officialEvaluation.passCount / officialEvaluation.totalCount : null };
  return { benchmarkDimensions: { projectOrganization: org, atomicExecution: { officialCheckpointRate: org.officialCheckpointRate }, feedbackEvolution: {}, decompositionDependency: decomposition({ scenario, graph, gold }), crossUbuddyAllocation: allocation({ scenario, graph, events, gold }), boardCommunication: communication({ events }), faultRecovery: recovery({ events, fault }), layeredAttribution: attribution({ attribution: attributionArtifact }) }, dimensionOrder: DIMENSIONS };
}

export function scoreAttributionRows(rows = []) {
  const labels = LAYERS;
  const matrix = Object.fromEntries(labels.map((label) => [label, Object.fromEntries(labels.map((other) => [other, 0]))]));
  let correct = 0; let total = 0; let evidenceTP = 0; let evidenceFP = 0; let evidenceFN = 0; let causeIou = 0; let causeN = 0;
  for (const row of rows) {
    if (labels.includes(row.goldLayer) && labels.includes(row.predictedLayer)) matrix[row.goldLayer][row.predictedLayer] += 1;
    if (row.goldLayer) { total += 1; if (row.goldLayer === row.predictedLayer) correct += 1; }
    const goldEvidence = new Set(row.goldEvidenceRefs || []); const predEvidence = new Set(row.evidenceRefs || []);
    evidenceTP += [...predEvidence].filter((item) => goldEvidence.has(item)).length; evidenceFP += [...predEvidence].filter((item) => !goldEvidence.has(item)).length; evidenceFN += [...goldEvidence].filter((item) => !predEvidence.has(item)).length;
    const goldCause = new Set(row.goldCause || []); const predCause = new Set(row.predictedCause || []); const union = new Set([...goldCause, ...predCause]);
    if (union.size) { causeIou += [...goldCause].filter((item) => predCause.has(item)).length / union.size; causeN += 1; }
  }
  const perLabelF1 = labels.map((label) => { const tp = matrix[label][label]; const fp = labels.filter((other) => other !== label).reduce((sum, other) => sum + matrix[other][label], 0); const fn = labels.filter((other) => other !== label).reduce((sum, other) => sum + matrix[label][other], 0); return (2 * tp) / Math.max(1, 2 * tp + fp + fn); });
  const bins = Array.from({ length: 10 }, () => []); rows.forEach((row) => { if (Number.isFinite(Number(row.confidence))) bins[Math.min(9, Math.floor(Number(row.confidence) * 10))].push(row); });
  const ece = bins.reduce((sum, bin) => { if (!bin.length) return sum; const confidence = bin.reduce((a, row) => a + Number(row.confidence), 0) / bin.length; const accuracy = bin.filter((row) => row.goldLayer === row.predictedLayer).length / bin.length; return sum + bin.length / Math.max(1, rows.length) * Math.abs(confidence - accuracy); }, 0);
  return { accuracy: ratio(correct, total), macroF1: perLabelF1.reduce((a, b) => a + b, 0) / perLabelF1.length, multiCauseIoU: ratio(causeIou, causeN), evidencePrecision: ratio(evidenceTP, evidenceTP + evidenceFP), evidenceRecall: ratio(evidenceTP, evidenceTP + evidenceFN), responsibilityConfusionRate: total ? 1 - correct / total : null, confidenceECE: ece, insufficientEvidenceBlockRate: ratio(rows.filter((row) => row.blocked && !(row.evidenceRefs || []).length).length, rows.length), confusionMatrix: matrix, sampleCount: rows.length };
}

export function scoreEvolutionPairs(rows = []) {
  const eligible = rows.filter((row) => row.round1 && row.round2);
  const gains = eligible.map((row) => n(row.round2.officialCheckpointRate) - n(row.round1.officialCheckpointRate));
  return { pairCount: eligible.length, meanTransferGain: ratio(gains.reduce((a, b) => a + b, 0), gains.length), negativeTransferRate: ratio(gains.filter((value) => value < 0).length, gains.length), erroneousExperienceAdoptionRate: ratio(eligible.filter((row) => row.update?.adopted && row.update?.goldValid === false).length, eligible.filter((row) => row.update?.adopted).length), rollbackRecoveryRate: ratio(eligible.filter((row) => row.rollbackTriggered && row.rollbackRecovered).length, eligible.filter((row) => row.rollbackTriggered).length) };
}
