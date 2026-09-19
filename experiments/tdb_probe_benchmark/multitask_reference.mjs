import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assessDecisionSufficiency } from '../../src/shared/contracts/uBuddyDecisionSufficiency.js';
import { findMinimumDisclosure } from '../../src/shared/contracts/uBuddyDisclosureFrontier.js';

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const worldsFor = family => {
  const flip = family % 2;
  return [
    { id: 'w-ready', observations: { public_signal: 1 }, state: { freshness: 'fresh', capability: 'matched', risk: 'low' },
      values: { freshness: 1, capability: 1, risk: 0 }, utilities: { proceed: 1, wait: 0 }, safe: { proceed: true, wait: true }, support: true },
    { id: 'w-stale', observations: { public_signal: 1 }, state: { freshness: 'stale', capability: 'matched', risk: 'medium' },
      values: { freshness: 0, capability: 1, risk: .4 }, utilities: { proceed: 0, wait: 1 }, safe: { proceed: true, wait: true }, support: true },
    { id: 'w-capability', observations: { public_signal: flip }, state: { freshness: 'fresh', capability: 'mismatched', risk: 'high' },
      values: { freshness: 1, capability: 0, risk: .9 }, utilities: { proceed: 0, wait: 1 }, safe: { proceed: false, wait: true }, support: true },
  ];
};

// Deliberately separate from findMinimumDisclosure: this is the finite-world
// reference used to score the solver, not a call to the implementation under test.
export function bruteForce(worlds, units, initial, epsilon = 0) {
  const candidates = [];
  for (let mask = 0; mask < (1 << units.length); mask++) {
    const selected = units.filter((_, i) => mask & (1 << i));
    const groups = new Map();
    for (const world of worlds.filter(w => Object.entries(initial).every(([k, v]) => w.observations[k] === v))) {
      const key = JSON.stringify(selected.map(u => world.values[u.id]));
      const group = groups.get(key) || []; group.push(world); groups.set(key, group);
    }
    let sufficient = true;
    for (const group of groups.values()) {
      const feasible = [...new Set(group.flatMap(w => Object.entries(w.safe).filter(([, ok]) => ok).map(([a]) => a)))];
      const common = feasible.filter(action => group.every(w => {
        if (!w.safe[action]) return false;
        const best = Math.max(...Object.entries(w.utilities).filter(([a]) => w.safe[a]).map(([, u]) => u));
        return best - w.utilities[action] <= epsilon;
      }));
      if (!common.length) sufficient = false;
    }
    if (sufficient) candidates.push({ selectedUnits: selected.map(u => u.id).sort(), cost: selected.reduce((n, u) => n + u.cost, 0) });
  }
  return candidates.sort((a, b) => a.cost - b.cost || a.selectedUnits.length - b.selectedUnits.length || a.selectedUnits.join().localeCompare(b.selectedUnits.join()))[0] || null;
}

function publicInput(worlds, family) {
  const current = worlds[family % worlds.length];
  const units = [
    { id: 'freshness', allowed: true, cost: 1 },
    { id: 'capability', allowed: true, cost: 1 },
    { id: 'risk', allowed: true, cost: 2 },
  ];
  const binding = { scope: `task-family-${family}`, version: 'projection-test-v1', query: 'should the downstream agent proceed?' };
  const initial = { public_signal: current.observations.public_signal };
  return { worlds, current, units, binding, initial, epsilon: 0, allowedActions: ['proceed', 'wait'] };
}

function statePrediction(input) {
  // Conservative observable-only predictor: ambiguity is UNKNOWN, not a guessed state.
  const observed = input.initial.public_signal;
  const candidates = input.worlds.filter(w => w.observations.public_signal === observed);
  if (new Set(candidates.map(w => JSON.stringify(w.state))).size !== 1) return { status: 'UNKNOWN', state: null };
  return { status: 'SUPPORTED', state: candidates[0].state };
}

export function run({ families = 24, seed = 20260907 } = {}) {
  const rows = [];
  for (let family = 0; family < families; family++) {
    const worlds = worldsFor(family + seed);
    const input = publicInput(worlds, family);
    const goldProjection = bruteForce(worlds, input.units, input.initial);
    const predictedProjection = findMinimumDisclosure({ ...input, currentWorldId: input.current.id });
    const state = statePrediction(input);
    const visibleCandidates = worlds.filter(w => w.observations.public_signal === input.initial.public_signal);
    const stateIdentifiable = new Set(visibleCandidates.map(w => JSON.stringify(w.state))).size === 1;
    const goldState = input.current.state;
    rows.push({ familyId: `projection-family-${family}`, split: family < families * .5 ? 'train' : family < families * .7 ? 'calibration' : 'test',
      observable: { initial: input.initial }, statePrediction: state, goldState,
      projection: predictedProjection, goldProjection,
      stateKnown: state.status === 'SUPPORTED',
      stateCorrect: stateIdentifiable ? state.status === 'SUPPORTED' && JSON.stringify(state.state) === JSON.stringify(goldState) : state.status === 'UNKNOWN',
      stateIdentifiable,
      projectionCorrect: predictedProjection.status === 'CERTIFIED' && JSON.stringify(predictedProjection.selectedUnits) === JSON.stringify(goldProjection?.selectedUnits),
      projectionPrivacySafe: predictedProjection.status === 'CERTIFIED' && predictedProjection.selectedUnits.every(id => input.units.some(u => u.id === id && u.allowed)),
      projectionCost: predictedProjection.disclosureCost ?? null });
  }
  const test = rows.filter(r => r.split === 'test');
  const mean = key => test.length ? test.reduce((n, r) => n + Number(r[key]), 0) / test.length : null;
  return { version: 'tdb-multitask-reference-v1', evidenceLevel: 'SYNTHETIC_FINITE_WORLD_ONLY', seed, families,
    counts: { total: rows.length, train: rows.filter(r => r.split === 'train').length, calibration: rows.filter(r => r.split === 'calibration').length, test: test.length },
    metrics: { testStateKnownRate: mean('stateKnown'), testStateIdentifiableRate: mean('stateIdentifiable'), testStateDecisionCorrect: mean('stateCorrect'), testProjectionAccuracy: mean('projectionCorrect'), testPrivacySafeRate: mean('projectionPrivacySafe'), testMeanDisclosureCost: mean('projectionCost') },
    limitations: ['worlds and state labels are generated', 'projection reference is finite-world only', 'no real task or human gold'], rows };
}

if (process.argv[1]?.replaceAll('\\','/').endsWith('/multitask_reference.mjs')) {
const out = process.argv[2] || 'experiments/tdb_probe_benchmark/runs/multitask-reference-v1';
const result = run({ families: Number(process.argv[3] || 24), seed: Number(process.argv[4] || 20260907) });
await fs.mkdir(path.resolve(out), { recursive: false });
const payload = JSON.stringify(result, null, 2) + '\n';
await fs.writeFile(path.join(out, 'multitask.json'), payload, { flag: 'wx' });
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ benchmark: result.version, config: { families: result.families, seed: result.seed }, inputHash: sha(result.rows), fileHash: sha(payload), evaluator: 'independent_bruteforce_reference_v1', solver: 'uBuddyDisclosureFrontier', evidenceLevel: result.evidenceLevel }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ out, ...result.metrics, evidenceLevel: result.evidenceLevel }, null, 2));


}
