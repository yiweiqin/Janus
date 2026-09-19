import { ACTIONS, COST, rng, trainScorer, predict, choose, heuristic } from './engine.mjs';
export const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Resample task families, not repeated executions or arms as independent samples.
export function clusterInterval(records, seed = 31, samples = 1000) {
  const groups = Object.groupBy(records, (r) => r.familyId);
  const values = Object.values(groups).map((g) => mean(g.map((r) => r.value)));
  if (values.length < 2) return { lower: null, upper: null, clusters: values.length, status: 'insufficient_clusters' };
  const random = rng(seed), draws = [];
  for (let b = 0; b < samples; b++) draws.push(mean(values.map(() => values[Math.floor(random() * values.length)])));
  draws.sort((a, b) => a - b);
  return { lower: draws[Math.floor(.025 * samples)], upper: draws[Math.floor(.975 * samples)], clusters: values.length,
    method: 'family-cluster-percentile-bootstrap', status: 'descriptive_synthetic_only',
    warning: values.every((v) => v === values[0]) ? 'Zero-width interval reflects identical synthetic responses, not certainty on real tasks.' : 'Few synthetic families; no real-world coverage guarantee.' };
}

export function analyze(rows) {
  const train = rows.filter((r) => r.split === 'train'), calibration = rows.filter((r) => r.split === 'calibration'), test = rows.filter((r) => r.split === 'test');
  if (![train, calibration, test].every((s) => s.length)) throw new Error('missing_split');
  const familySplits = new Map();
  for (const r of rows) {
    if (familySplits.has(r.familyId) && familySplits.get(r.familyId) !== r.split) throw new Error('family_split_leakage');
    familySplits.set(r.familyId, r.split);
  }
  const scorer = trainScorer(train);
  // Abstention threshold selected only on calibration families; test never updates scorer.
  const thresholds = [0, .1, .2, .3];
  const netGain = (row, action) => row.effects[action] - .05 * COST[action];
  const select = (row, threshold) => {
    const p = predict(scorer, row.features), a = choose(p.probabilities);
    return !p.unknown && p.probabilities[a] - p.probabilities.noop - .05 * COST[a] > threshold ? a : 'noop';
  };
  const threshold = [...thresholds].sort((a, b) => mean(calibration.map((r) => netGain(r, select(r, b)))) - mean(calibration.map((r) => netGain(r, select(r, a)))) || b - a)[0];
  const policyRows = test.map((row) => {
    const p = predict(scorer, row.features);
    const empiricalAction = select(row, threshold);
    const oracleValues = Object.fromEntries(ACTIONS.map((a) => [a, row.arms[a].evaluation.utility]));
    const policies = { noop: 'noop', heuristic: heuristic(row.features), learned: empiricalAction,
      probeSearch: choose(oracleValues), oracle: choose(oracleValues) };
    const outcomes = Object.fromEntries(Object.entries(policies).map(([name, action]) => [name, {
      action, success: row.arms[action].evaluation.utility, gain: row.effects[action], cost: COST[action],
      netGain: netGain(row, action),
      // Exhaustive probing costs six local executions before deploying the selected action.
      diagnosticExecutions: name === 'probeSearch' ? ACTIONS.length : 0,
    }]));
    return { id: row.id, familyId: row.familyId, condition: row.condition, unknown: p.unknown, probabilities: p.probabilities,
      brier: mean(ACTIONS.map((a) => (p.probabilities[a] - row.arms[a].evaluation.utility) ** 2)), outcomes };
  });
  const byPolicy = Object.fromEntries(['noop', 'heuristic', 'learned', 'probeSearch', 'oracle'].map((name) => [name, {
    successRate: mean(policyRows.map((r) => r.outcomes[name].success)),
    meanGain: mean(policyRows.map((r) => r.outcomes[name].gain)),
    meanRepairCost: mean(policyRows.map((r) => r.outcomes[name].cost)),
    meanDiagnosticExecutions: mean(policyRows.map((r) => r.outcomes[name].diagnosticExecutions)),
    gainInterval: clusterInterval(policyRows.map((r) => ({ familyId: r.familyId, value: r.outcomes[name].gain }))),
  }]));
  const byCondition = Object.fromEntries([...new Set(test.map((r) => r.condition))].map((condition) => [condition,
    Object.fromEntries(['noop', 'heuristic', 'learned', 'probeSearch'].map((name) => [name, mean(policyRows.filter((r) => r.condition === condition).map((r) => r.outcomes[name].success))]))]));
  const effectTable = Object.fromEntries([...new Set(test.map((r) => r.condition))].map((condition) => [condition,
    Object.fromEntries(ACTIONS.map((a) => [a, mean(test.filter((r) => r.condition === condition).map((r) => r.effects[a]))]))]));
  const joint = test.filter((r) => r.condition === 'joint');
  const interaction = mean(joint.map((r) => r.arms.refreshAndHandoff.evaluation.utility - r.arms.refreshVersion.evaluation.utility - r.arms.restoreHandoff.evaluation.utility + r.arms.noop.evaluation.utility));
  return { scorer, policyRows, metrics: {
    evidenceLevel: 'SYNTHETIC_EXECUTION_ONLY', realWorldValidated: false, autoEvolutionAllowed: false,
    counts: { train: train.length, calibration: calibration.length, test: test.length, totalExecutions: rows.length * ACTIONS.length,
      independentTestFamilies: new Set(test.map((r) => r.familyId)).size },
    selectedAbstentionThreshold: threshold, byPolicy, byCondition, effectTable, interaction,
    actionSuccessBrier: mean(policyRows.map((r) => r.brier)), unknownRate: mean(policyRows.map((r) => Number(r.unknown))),
    rootCauseAccuracy: null, rootCauseAccuracyReason: 'Repair effects do not identify unique root causes.',
    externalValidity: 'All splits use one hand-built task generator. Held-out families are not unseen real task domains.',
    probeBudgetCaveat: 'probeSearch and oracle share outcomes; the former pays six diagnostic executions. No equal-budget superiority claim.',
  } };
}
