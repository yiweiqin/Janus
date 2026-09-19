/* Independent bounded robust belief-state model checker over oracle tables. */

const observationKey = value => JSON.stringify(value ?? {status: 'UNKNOWN'});

export function checkRobustPolicy({worldIds, actionIds, probes, oracleTables, budget = 0}) {
  const memo = new Map();
  let expansions = 0;
  const solve = (belief, remainingBudget) => {
    const ordered = [...belief].sort();
    const key = JSON.stringify([ordered, remainingBudget]);
    if (memo.has(key)) return memo.get(key);
    expansions += 1;
    const safeActions = [...actionIds].sort().filter(actionId => ordered.every(worldId => oracleTables.actionResults?.[worldId]?.[actionId]?.verdict === 'SAFE'));
    if (safeActions.length) {
      const result = {status: 'WIN', worldIds: ordered, remainingBudget, safeActions};
      memo.set(key, result);
      return result;
    }
    const rejectedProbes = [];
    for (const probe of [...probes].sort((a, b) => a.id.localeCompare(b.id))) {
      if (probe.cost > remainingBudget) continue;
      const cells = new Map();
      for (const worldId of ordered) {
        const oracleCell = oracleTables.probeResults?.[worldId]?.[probe.id];
        const observation = oracleCell?.verdict === 'SAFE' ? oracleCell.canonicalObservation : {status: 'UNKNOWN', reasonCode: oracleCell?.reasonCode ?? 'ORACLE_CELL_MISSING'};
        const obsKey = observationKey(observation);
        if (!cells.has(obsKey)) cells.set(obsKey, {observation: obsKey, worldIds: []});
        cells.get(obsKey).worldIds.push(worldId);
      }
      if (cells.size <= 1) continue;
      const children = [...cells.values()].map(cell => ({...cell, worldIds: cell.worldIds.sort(), result: solve(cell.worldIds, remainingBudget - probe.cost)}));
      if (children.every(child => child.result.status === 'WIN')) {
        const result = {status: 'WIN', worldIds: ordered, remainingBudget, probeId: probe.id, cost: probe.cost, children};
        memo.set(key, result);
        return result;
      }
      rejectedProbes.push({probeId: probe.id, losingChildren: children.filter(child => child.result.status !== 'WIN').map(child => ({observation: child.observation, worldIds: child.worldIds}))});
    }
    const result = {status: 'LOSE', worldIds: ordered, remainingBudget, reasonCode: 'ROBUST_NO_SAFE_ACTION_OR_WINNING_INFORMATION_ACTION', rejectedProbes};
    memo.set(key, result);
    return result;
  };
  const root = solve(worldIds, budget);
  return {schemaVersion: 'cpir-web/robust-model-checker/v1', implementationStatus: 'research-prototype/unverified', status: root.status, root, stats: {memoStates: memo.size, stateExpansions: expansions, budget}};
}

export function projectPolicy(node) {
  if (!node) return null;
  if (node.status === 'LOSE') return {status: 'LOSE', worldIds: node.worldIds};
  if (node.safeActions) return {status: 'WIN', worldIds: node.worldIds, safeActions: [...node.safeActions].sort()};
  return {status: 'WIN', worldIds: node.worldIds, probeId: node.probeId, children: (node.children ?? []).map(child => ({observation: child.observation, worldIds: child.worldIds, result: projectPolicy(child.result)})).sort((a, b) => a.observation.localeCompare(b.observation))};
}
