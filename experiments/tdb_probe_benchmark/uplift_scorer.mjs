// Causal/uplift-style dependency-repair scorer.
//
// The target is not "which action sounds plausible".  For every action a, we
// learn the conditional incremental utility relative to the same-case noop:
//   tau_a(x) = E[U(a) - U(noop) | X=x]
// using only training families.  A small ridge model is deliberately used so
// the scorer is auditable, deterministic, and cannot inspect calibration/test
// outcomes.  The prediction also carries uncertainty and support so policy
// selection can abstain when extrapolating.

import { ACTIONS, COST } from './engine.mjs';

export const FEATURES = ['capability', 'logic', 'freshness', 'resource', 'risk'];

function vector(features) { return [1, ...FEATURES.map((name) => Number(features?.[name] ?? 0))]; }
function dot(a, b) { return a.reduce((sum, value, i) => sum + value * b[i], 0); }
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    if (Math.abs(M[pivot][col]) < 1e-10) continue;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const scale = M[col][col]; for (let j = col; j <= n; j++) M[col][j] /= scale;
    for (let row = 0; row < n; row++) { if (row === col) continue; const f = M[row][col]; for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j]; }
  }
  return M.map((row, i) => Math.abs(row[i]) < 1e-8 ? 0 : row[n]);
}

function fit(rows, action, ridge = 0.25) {
  const p = FEATURES.length + 1, A = Array.from({ length: p }, () => Array(p).fill(0)), b = Array(p).fill(0);
  for (const row of rows) {
    const x = vector(row.features), y = Number(row.arms[action].evaluation.utility) - Number(row.arms.noop.evaluation.utility);
    for (let i = 0; i < p; i++) { b[i] += x[i] * y; for (let j = 0; j < p; j++) A[i][j] += x[i] * x[j]; }
  }
  for (let i = 1; i < p; i++) A[i][i] += ridge; // do not penalize intercept
  const beta = solve(A, b), residuals = rows.map((row) => {
    const y = Number(row.arms[action].evaluation.utility) - Number(row.arms.noop.evaluation.utility);
    return y - dot(vector(row.features), beta);
  });
  const variance = residuals.length > 1 ? residuals.reduce((s, r) => s + r * r, 0) / (residuals.length - 1) : 1;
  return { beta, residualVariance: variance, n: rows.length };
}

export function trainUpliftScorer(rows, { ridge = 0.25 } = {}) {
  if (!Array.isArray(rows) || !rows.length || rows.some((r) => r.split !== 'train')) throw new Error('uplift_training_split_violation');
  return { version: 'causal-uplift-ridge-v1', features: FEATURES, ridge, actions: Object.fromEntries(ACTIONS.filter((a) => a !== 'noop').map((a) => [a, fit(rows, a, ridge)])), trainingFamilies: [...new Set(rows.map((r) => r.familyId))] };
}

export function predictUplift(scorer, features) {
  const x = vector(features), actions = { noop: { effect: 0, lower: 0, uncertainty: 0 } };
  for (const [action, model] of Object.entries(scorer.actions || {})) {
    const uncertainty = Math.sqrt(Math.max(0, model.residualVariance) / Math.max(1, model.n));
    const effect = dot(x, model.beta);
    actions[action] = { effect, lower: effect - 1.96 * uncertainty, uncertainty };
  }
  return actions;
}

export function chooseUplift(scorer, features, { costPenalty = 0.05, z = 1.96 } = {}) {
  const predictions = predictUplift(scorer, features);
  const candidates = Object.entries(predictions).map(([action, p]) => ({ action, score: p.effect - costPenalty * COST[action], conservative: p.effect - z * p.uncertainty - costPenalty * COST[action] }));
  // Conservative lower confidence bound: abstain unless repair is expected to
  // beat noop after cost. This is a policy decision, not a root-cause claim.
  candidates.sort((a, b) => b.conservative - a.conservative || COST[a.action] - COST[b.action]);
  const best = candidates[0];
  return { action: best && best.conservative > 0 ? best.action : 'noop', predictions, candidates, abstained: !best || best.conservative <= 0 };
}

