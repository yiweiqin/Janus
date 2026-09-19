/* Research-only replayable obstruction certificate wrapper. */
import {buildConflictRegistry} from './ubuddy-cpir-web-conflict-registry-v0.mjs';

export function buildAocCertificate({worlds, actions, evaluate, maxWorldClasses = 20}) {
  const evaluations = {};
  const wrapped = (world, action) => {
    const result = evaluate(world, action);
    evaluations[world.id] ??= {};
    evaluations[world.id][action.id] = result;
    return result;
  };
  const registry = buildConflictRegistry({worlds, actions, evaluate: wrapped, maxWorldClasses});
  return {
    schemaVersion: 'cpir-web/aoc/v0',
    implementationStatus: 'research-prototype/unverified',
    registryDigest: registry.registryDigest,
    worldIds: registry.worldIds,
    actionIds: registry.actionIds,
    edges: registry.edges.map(edge => ({
      ...edge,
      replayWitnessesByAction: Object.fromEntries(edge.actionIds.map(actionId => [actionId, edge.minimalWorldSet.map(worldId => ({worldId, evaluation: evaluations[worldId][actionId]}))]))
    })),
    mixedObstructions: registry.mixedObstructions,
    infeasibleSingletons: registry.infeasibleSingletons,
    algorithmLimits: registry.algorithmLimits,
    certificateKind: 'bounded-transition-replay-wrapper'
  };
}

