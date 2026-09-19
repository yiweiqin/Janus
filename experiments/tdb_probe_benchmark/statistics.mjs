import fs from 'node:fs/promises';
import path from 'node:path';

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; }; }

// Collapse repeated conditions within a family before inference. Episodes and
// arms are never treated as independent observations.
export function familyValues(predictions, policy, metric = 'netGain') {
  const byFamily = new Map();
  for (const row of predictions) {
    const value = Number(row.outcomes?.[policy]?.[metric]);
    if (!Number.isFinite(value)) throw new Error(`missing_metric:${policy}:${metric}`);
    const list = byFamily.get(row.familyId) || [];
    list.push(value); byFamily.set(row.familyId, list);
  }
  return [...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([familyId, values]) => ({ familyId, value: mean(values) }));
}

export function pairedEffect(predictions, treatment, control, metric = 'netGain') {
  const a = new Map(familyValues(predictions, treatment, metric).map(x => [x.familyId, x.value]));
  const b = new Map(familyValues(predictions, control, metric).map(x => [x.familyId, x.value]));
  const families = [...a.keys()].filter(id => b.has(id));
  if (!families.length) throw new Error('no_paired_families');
  return families.map(familyId => ({ familyId, difference: a.get(familyId) - b.get(familyId) }));
}

export function bootstrapCI(values, seed = 17, samples = 10000) {
  if (values.length < 2) return { lower: null, upper: null, clusters: values.length, method: 'family_paired_percentile_bootstrap' };
  const random = rng(seed), draws = [];
  for (let i = 0; i < samples; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) total += values[Math.floor(random() * values.length)];
    draws.push(total / values.length);
  }
  draws.sort((a, b) => a - b);
  return { lower: draws[Math.floor(samples * .025)], upper: draws[Math.floor(samples * .975)], clusters: values.length, method: 'family_paired_percentile_bootstrap' };
}

export function signPermutationP(values, seed = 19, samples = 10000) {
  if (!values.length) return null;
  const observed = Math.abs(mean(values));
  const random = rng(seed); let extreme = 0;
  for (let i = 0; i < samples; i++) {
    let total = 0;
    for (const value of values) total += (random() < .5 ? -1 : 1) * value;
    if (Math.abs(total / values.length) >= observed) extreme++;
  }
  return (extreme + 1) / (samples + 1);
}

export function benjaminiHochberg(entries) {
  const ranked = entries.map((entry, index) => ({ ...entry, index })).sort((a, b) => a.pValue - b.pValue);
  let running = 1;
  for (let i = ranked.length - 1; i >= 0; i--) {
    running = Math.min(running, ranked[i].pValue * ranked.length / (i + 1));
    ranked[i].qValue = running;
  }
  return ranked.sort((a, b) => a.index - b.index).map(({ index, ...entry }) => entry);
}

export function comparePolicies(predictions, comparisons = [['learned', 'heuristic'], ['learned', 'noop'], ['learned', 'oracle']]) {
  const raw = comparisons.map(([treatment, control], index) => {
    const paired = pairedEffect(predictions, treatment, control);
    const values = paired.map(x => x.difference);
    return { treatment, control, metric: 'netGain', clusters: values.length, meanDifference: mean(values),
      effectSize: (() => { const m = mean(values); const variance = values.length > 1 ? values.reduce((n, v) => n + (v - m) ** 2, 0) / (values.length - 1) : 0; return variance > 1e-12 ? m / Math.sqrt(variance) : null; })(),
      ci95: bootstrapCI(values, 101 + index), pValue: signPermutationP(values, 701 + index) };
  });
  return benjaminiHochberg(raw);
}

export async function aggregateDirectory(directory) {
  const predictions = JSON.parse(await fs.readFile(path.join(directory, 'predictions.json'), 'utf8'));
  const comparisons = comparePolicies(predictions);
  return { version: 'tdb-statistics-v1', evidenceLevel: 'SYNTHETIC_DESCRIPTIVE_UNTIL_REAL_EVALUATOR',
    predictionRows: predictions.length, familyCount: new Set(predictions.map(x => x.familyId)).size, comparisons,
    primaryEndpoint: 'family_mean_netGain', bootstrapUnit: 'familyId', permutation: 'paired_sign_randomization', multipleComparison: 'Benjamini-Hochberg FDR' };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/statistics.mjs')) {
  const directory = process.argv[2]; if (!directory) throw new Error('out_required');
  console.log(JSON.stringify(await aggregateDirectory(directory), null, 2));
}

