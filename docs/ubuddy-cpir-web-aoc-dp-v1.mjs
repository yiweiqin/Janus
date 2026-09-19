/*
 * Observation-aware bounded obstruction DP.
 * This is a research candidate, not a claim of planner novelty: its purpose
 * is to make belief-cell semantics explicit and produce fail-closed losing
 * children rather than treating arbitrary world subsets as conflicts.
 */

const terminalSafe = evaluation => evaluation?.verdict === 'SAFE';

export function solveObservationAwareAoc({worldIds, actionIds, probes, oracleTables, budget = 0}) {
  if (!oracleTables?.actionResults || !oracleTables?.probeResults) throw new TypeError('ORACLE_TABLES_REQUIRED');
  if (arguments[0]?.evaluate || arguments[0]?.observe || arguments[0]?.worlds || arguments[0]?.actions) throw new TypeError('ARBITRARY_CALLBACKS_AND_HIDDEN_WORLD_OBJECTS_FORBIDDEN');
  worldIds = [...worldIds].sort();
  actionIds = [...actionIds].sort();
  const memo = new Map();
  const evalCache = new Map();
  const evaluation = (worldId, actionId) => {
    const cacheKey = `${worldId}|${actionId}`;
    if (!evalCache.has(cacheKey)) evalCache.set(cacheKey, oracleTables.actionResults?.[worldId]?.[actionId] ?? {verdict: 'UNKNOWN', reasonCode: 'ORACLE_CELL_MISSING'});
    return evalCache.get(cacheKey);
  };
  const partition = (cell, probe) => {
    const groups = new Map();
    for (const worldId of cell) {
      const oracleCell = oracleTables.probeResults?.[worldId]?.[probe.id];
      const observation = JSON.stringify(oracleCell?.verdict === 'SAFE' ? oracleCell.canonicalObservation : {status: 'UNKNOWN', reasonCode: oracleCell?.reasonCode ?? 'ORACLE_CELL_MISSING'});
      if (!groups.has(observation)) groups.set(observation, []);
      groups.get(observation).push(worldId);
    }
    return [...groups.entries()].map(([observation, child]) => ({observation, worldIds: child.sort()}));
  };
  const solve = (cell, remainingBudget) => {
    const key = JSON.stringify([cell, remainingBudget]);
    if (memo.has(key)) return memo.get(key);
    const safeActions = actionIds.filter(actionId => cell.every(worldId => terminalSafe(evaluation(worldId, actionId))));
    if (safeActions.length) {
      const result = {status: 'WIN', worldIds: cell, remainingBudget, safeActions};
      memo.set(key, result);
      return result;
    }
    const losingProbeWitnesses = [];
    for (const probe of probes) {
      if (probe.cost > remainingBudget) continue;
      const children = partition(cell, probe);
      if (children.length <= 1) continue;
      const childResults = children.map(child => ({...child, result: solve(child.worldIds, remainingBudget - probe.cost)}));
      if (childResults.every(child => child.result.status === 'WIN')) {
        const result = {status: 'WIN', worldIds: cell, remainingBudget, probeId: probe.id, cost: probe.cost, children: childResults};
        memo.set(key, result);
        return result;
      }
      const losingChildren = childResults.filter(child => child.result.status !== 'WIN').map(child => ({observation: child.observation, worldIds: child.worldIds, obstruction: child.result}));
      if (losingChildren.length) losingProbeWitnesses.push({probeId: probe.id, losingChildren});
    }
    const result = {status: 'LOSE', worldIds: cell, remainingBudget, reasonCode: 'NO_UNIVERSALLY_SAFE_ACTION_OR_SEPARATING_PROBE', losingProbeWitnesses};
    memo.set(key, result);
    return result;
  };
  const root = solve(worldIds, budget);
  return {schemaVersion: 'cpir-web/aoc-dp/v1', implementationStatus: 'research-prototype/unverified', status: root.status, root, stats: {memoStates: memo.size, evaluatedPairs: evalCache.size, worldCount: worldIds.length, actionCount: actionIds.length, probeCount: probes.length, budget}};
}
