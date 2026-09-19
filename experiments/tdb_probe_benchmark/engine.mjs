import crypto from 'node:crypto';
import { evaluate } from './evaluator.mjs';
import { taskDependencyBundleReplaySnapshot, taskDependencyBundleTraceFromEvents } from '../../src/shared/contracts/uBuddyTaskDependencyBundle.js';

export const VERSION = 'tdb-probe-benchmark-v1';
export const ACTIONS = ['noop', 'replaceAgent', 'restoreHandoff', 'refreshVersion', 'restoreResource', 'refreshAndHandoff'];
export const COST = { noop: 0, replaceAgent: 2, restoreHandoff: 1, refreshVersion: 1, restoreResource: 1, refreshAndHandoff: 2 };
export const CONDITIONS = ['agent', 'handoff', 'version', 'resource', 'joint', 'clean', 'decoy'];
export const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
export const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

export function makeCases({ seed = 20260906, families = 12, repeats = 3 } = {}) {
  if (![seed, families, repeats].every(Number.isSafeInteger) || seed < 0 || seed > 0xffffffff
    || families < 8 || families > 200 || repeats < 1 || repeats > 20) throw new Error('invalid_case_config');
  const random = rng(seed), cases = [];
  const trainEnd = Math.floor(families / 2), calibrationEnd = Math.floor(families * 2 / 3);
  for (let family = 0; family < families; family++) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const rows = Array.from({ length: 3 + family % 5 }, () => ({ quantity: 1 + Math.floor(random() * 4), unitCents: 101 + Math.floor(random() * 999) }));
      const spec = { currentRows: rows, taxPercent: 5 + family % 4 * 5, requiredVersion: 'v2' };
      for (const condition of CONDITIONS) {
        cases.push({ id: hash({ seed, family, repeat, condition }).slice(0, 20), familyId: `family-${family}`,
          split: family < trainEnd ? 'train' : family < calibrationEnd ? 'calibration' : 'test',
          repeat, condition, spec, orderSeed: Math.floor(random() * 0xffffffff) });
      }
    }
  }
  return cases;
}

function startState(item) {
  // Fault injection changes actual execution inputs/implementation, never the evaluator.
  const oldRows = structuredClone(item.spec.currentRows);
  oldRows[0].unitCents += 79;
  return {
    rows: ['version', 'joint'].includes(item.condition) ? oldRows : structuredClone(item.spec.currentRows),
    version: ['version', 'joint'].includes(item.condition) ? 'v1' : 'v2',
    taxPercent: ['handoff', 'joint'].includes(item.condition) ? null : item.spec.taxPercent,
    agentMode: item.condition === 'agent' ? 'currency-unit-bug' : 'exact-cents',
    quota: item.condition === 'resource' ? 1 : item.spec.currentRows.length,
    decoyAlarm: item.condition === 'decoy',
  };
}

function observe(item, state) {
  // Observable contract checks: no cause label, gold result, or effect table.
  return {
    capability: state.agentMode === 'exact-cents' ? 1 : 0, // local unit-contract self-test
    logic: state.taxPercent === null ? 0 : 1,
    freshness: state.version === item.spec.requiredVersion ? 1 : 0,
    resource: state.quota >= state.rows.length ? 1 : 0,
    risk: state.decoyAlarm ? 1 : 0.1, // deliberately misleading alarm
  };
}

export function executeArm(item, action) {
  if (!ACTIONS.includes(action)) throw new Error('unknown_intervention');
  const state = startState(item), before = observe(item, state);
  const initialStateHash = hash(state);
  if (action === 'replaceAgent') state.agentMode = 'exact-cents';
  if (['restoreHandoff', 'refreshAndHandoff'].includes(action)) state.taxPercent = item.spec.taxPercent;
  if (['refreshVersion', 'refreshAndHandoff'].includes(action)) {
    state.rows = structuredClone(item.spec.currentRows); state.version = 'v2';
  }
  if (action === 'restoreResource') state.quota = state.rows.length;
  const after = observe(item, state);
  const inputs = state.rows.slice(0, state.quota);
  let subtotal = 0;
  for (const row of inputs) subtotal += row.quantity * row.unitCents;
  const tax = Math.round(subtotal * (state.taxPercent ?? 0) / 100);
  // A concrete agent implementation bug: treats cents as whole currency units.
  const totalCents = (subtotal + tax) * (state.agentMode === 'currency-unit-bug' ? 100 : 1);
  const output = { totalCents };
  const evaluation = evaluate(item.spec, output);
  const dimensions = (values) => Object.fromEntries(Object.entries(values).map(([key, score]) => [key, { score, confidence: 1, explanation: 'synthetic observable contract check; not learned confidence' }]));
  const events = [
    { id: `${item.id}:${action}:0`, eventType: 'task_created', sequence: 1, createdAt: '2026-09-06T00:00:00.000Z', payload: { dimensions: dimensions(before), initialStateHash } },
    { id: `${item.id}:${action}:1`, eventType: 'handoff', sequence: 2, createdAt: '2026-09-06T00:00:01.000Z', payload: { action, dimensions: dimensions(after), inputHash: hash(inputs) } },
    { id: `${item.id}:${action}:2`, eventType: evaluation.success ? 'completed' : 'failed', sequence: 3, createdAt: '2026-09-06T00:00:02.000Z', payload: { outputHash: hash(output), utility: evaluation.utility } },
  ];
  const tdbSeed = { taskId: item.id, edgeId: `${item.id}:invoice-edge`, sourceNodeId: 'producer', targetNodeId: 'calculator', sourceAgentId: 'producer-v1', targetAgentId: 'calculator-v1', relationType: 'consumes', observedAt: '2026-09-06T00:00:00.000Z' };
  return { action, initialStateHash, output, evaluation, events, tdbSeed,
    snapshot: taskDependencyBundleReplaySnapshot(events, tdbSeed),
    trace: taskDependencyBundleTraceFromEvents(events, tdbSeed) };
}

export function runCase(item) {
  const order = [...ACTIONS], random = rng(item.orderSeed);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const arms = Object.fromEntries(order.map((a) => [a, executeArm(item, a)]));
  if (new Set(Object.values(arms).map((a) => a.initialStateHash)).size !== 1) throw new Error('reset_mismatch');
  return { id: item.id, familyId: item.familyId, split: item.split, condition: item.condition,
    features: observe(item, startState(item)), executionOrder: order, arms,
    effects: Object.fromEntries(ACTIONS.map((a) => [a, arms[a].evaluation.utility - arms.noop.evaluation.utility])) };
}

export const featureKey = (features) => ['capability', 'logic', 'freshness', 'resource', 'risk'].map((k) => features[k]).join('|');

export function trainScorer(rows) {
  if (!rows.length || rows.some((r) => r.split !== 'train')) throw new Error('training_split_violation');
  const table = {};
  for (const row of rows) {
    const key = featureKey(row.features);
    const cell = table[key] ||= { n: 0, successes: Object.fromEntries(ACTIONS.map((a) => [a, 0])) };
    cell.n++;
    for (const a of ACTIONS) cell.successes[a] += row.arms[a].evaluation.utility;
  }
  return { version: 'empirical-action-success-v1', table };
}

export function predict(scorer, features) {
  const cell = scorer.table[featureKey(features)];
  return { unknown: !cell, probabilities: Object.fromEntries(ACTIONS.map((a) => [a, cell ? (cell.successes[a] + 1) / (cell.n + 2) : 0.5])) };
}

export function choose(probabilities, penalty = 0.05) {
  return [...ACTIONS].sort((a, b) => (probabilities[b] - penalty * COST[b]) - (probabilities[a] - penalty * COST[a]) || COST[a] - COST[b])[0];
}

export function heuristic(features) {
  if (features.risk > .9) return 'replaceAgent';
  if (!features.capability) return 'replaceAgent';
  if (!features.logic) return 'restoreHandoff';
  if (!features.freshness) return 'refreshVersion';
  if (!features.resource) return 'restoreResource';
  return 'noop';
}
