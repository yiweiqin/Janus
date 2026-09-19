/*
 * Generic deletion-MUS style baseline. It finds one subset-minimal
 * obstruction from a sealed world/action matrix. This is intentionally a
 * mature generic baseline, not an AOC novelty claim.
 */
import {terminalVerdict} from './ubuddy-cpir-web-conflict-registry-v0.mjs';

function intersection(sets) {
  if (!sets.length) return new Set();
  return new Set([...sets[0]].filter(value => sets.slice(1).every(set => set.has(value))));
}

function classify(worldIds, actionIds, matrix) {
  const rows = worldIds.map(worldId => matrix[worldId]);
  const safeSets = rows.map(row => new Set(actionIds.filter(actionId => row[actionId] === 'SAFE_TERMINAL')));
  if (intersection(safeSets).size) return 'NONE';
  const anyUnknown = actionIds.some(actionId => rows.some(row => row[actionId] === 'UNKNOWN'));
  const allActionsViolated = actionIds.every(actionId => rows.some(row => row[actionId] === 'VIOLATED'));
  if (safeSets.every(set => set.size > 0) && allActionsViolated && !anyUnknown) return 'HARD_CONFLICT';
  const blockage = actionIds.some(actionId => rows.every(row => row[actionId] !== 'VIOLATED') && rows.some(row => row[actionId] === 'UNKNOWN'));
  if (blockage) return 'EPISTEMIC_BLOCKAGE';
  if (rows.some(row => actionIds.every(actionId => row[actionId] === 'VIOLATED'))) return 'INFEASIBLE';
  return 'MIXED_OBSTRUCTION';
}

export function findOneMinimalObstruction({worlds, actions, evaluate, targetKind}) {
  const worldIds = worlds.map(world => world.id).sort();
  const actionIds = actions.map(action => action.id).sort();
  if (new Set(worldIds).size !== worldIds.length) return {status: 'INPUT_INVALID', reasonCode: 'DUPLICATE_WORLD_ID'};
  if (new Set(actionIds).size !== actionIds.length) return {status: 'INPUT_INVALID', reasonCode: 'DUPLICATE_ACTION_ID'};
  let oracleCalls = 0;
  const matrix = Object.fromEntries(worlds.map(world => [world.id, Object.fromEntries(actions.map(action => {
    oracleCalls += 1;
    return [action.id, terminalVerdict(evaluate(world, action))];
  }))]));
  const initialKind = classify(worldIds, actionIds, matrix);
  const desiredKind = targetKind ?? initialKind;
  if (initialKind === 'NONE' || (targetKind && initialKind !== targetKind)) return {status: 'NONE', kind: initialKind, oracleCalls, matrix};
  let core = [...worldIds];
  for (const worldId of worldIds) {
    if (!core.includes(worldId) || core.length === 1) continue;
    const candidate = core.filter(id => id !== worldId);
    if (classify(candidate, actionIds, matrix) === desiredKind) core = candidate;
  }
  return {status: 'FOUND', kind: desiredKind, minimalWorldSet: core, oracleCalls, matrix, minimalityScope: 'ONE_CORE_DELETION_MINIMAL', completenessScope: 'NOT_ALL_CORES'};
}

