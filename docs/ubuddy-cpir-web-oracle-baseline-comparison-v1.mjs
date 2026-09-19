import {materializeOracleTables} from './ubuddy-cpir-web-oracle-v1.mjs';
import {solveObservationAwareAoc} from './ubuddy-cpir-web-aoc-dp-v1.mjs';
import {checkRobustPolicy, projectPolicy} from './ubuddy-cpir-web-robust-model-checker-v1.mjs';

export function compareOracleConsumers(manifest, {eventScheduleId = 'none', observationBudget = manifest?.budget?.maxCost ?? 0} = {}) {
  const materialized = materializeOracleTables(manifest, {eventScheduleId, observationBudget});
  const worldIds = manifest.worlds.map(world => world.id);
  const actionIds = manifest.actions.map(action => action.id);
  const probes = manifest.probes.map(probe => ({id: probe.id, cost: probe.cost}));
  const aoc = solveObservationAwareAoc({worldIds, actionIds, probes, oracleTables: materialized.tables, budget: observationBudget});
  const robust = checkRobustPolicy({worldIds, actionIds, probes, oracleTables: materialized.tables, budget: observationBudget});
  const aocProjection = projectPolicy(aoc.root);
  const robustProjection = projectPolicy(robust.root);
  const traceRows = worldIds.flatMap(worldId => actionIds.map(actionId => {
    const candidate = materialized.tables.actionResults[worldId][actionId];
    const strongestMatureWithSameVerifier = materialized.tables.actionResults[worldId][actionId];
    return {worldId, actionId, candidate: {verdict: candidate.verdict, linearizationWitness: candidate.linearizationWitness, sinkLedgerDelta: candidate.sinkLedgerDelta}, strongestMatureWithSameVerifier: {verdict: strongestMatureWithSameVerifier.verdict, linearizationWitness: strongestMatureWithSameVerifier.linearizationWitness, sinkLedgerDelta: strongestMatureWithSameVerifier.sinkLedgerDelta}};
  }));
  return {
    schemaVersion: 'cpir-web/oracle-baseline-comparison/v1',
    implementationStatus: 'research-prototype/unverified',
    policyEquivalent: JSON.stringify(aocProjection) === JSON.stringify(robustProjection),
    traceEquivalentWithStrongestMatureVerifier: traceRows.every(row => JSON.stringify(row.candidate) === JSON.stringify(row.strongestMatureWithSameVerifier)),
    aoc: {projection: aocProjection, stats: aoc.stats},
    robust: {projection: robustProjection, stats: robust.stats},
    oracleCalls: worldIds.length * (actionIds.length + probes.length),
    traceRows,
    warning: 'equivalence-on-finite-manifest-is-negative-novelty-evidence; not-a-real-Web-baseline-result'
  };
}
