/*
 * Oracle-only adapter for the observation-aware DP.
 * The DP receives materialized, candidate-independent oracle cells.  It never
 * receives a hidden world object or an arbitrary candidate-supplied evaluator.
 */
import {materializeOracleTables} from './ubuddy-cpir-web-oracle-v1.mjs';
import {solveObservationAwareAoc} from './ubuddy-cpir-web-aoc-dp-v1.mjs';

export function solveObservationAwareAocFromOracle(manifest, {eventScheduleId = 'none', observationBudget = manifest?.budget?.maxCost ?? 0} = {}) {
  const worldIds = (manifest.worlds ?? []).map(world => world.id);
  const actionIds = (manifest.actions ?? []).map(action => action.id);
  const probes = (manifest.probes ?? []).map(probe => ({id: probe.id, cost: probe.cost}));
  const materialized = materializeOracleTables(manifest, {eventScheduleId, observationBudget});
  const result = solveObservationAwareAoc({
    worldIds, actionIds, probes, oracleTables: materialized.tables,
    budget: observationBudget
  });
  return {
    ...result,
    schemaVersion: 'cpir-web/aoc-dp-oracle/v1',
    implementationStatus: 'research-prototype/unverified',
    oracleManifestId: manifest?.manifestId,
    oracleHashes: {contractRegistryHash: manifest?.contractRegistryHash, observationProjectorHash: manifest?.observationProjectorHash, transitionVerifierHash: manifest?.transitionVerifierHash},
    oracleOnly: true,
    oracleCallCount: worldIds.length * (actionIds.length + probes.length)
  };
}
