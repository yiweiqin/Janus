#!/usr/bin/env node
// Research-only, read-only prototype. It does not read expected/planning/runtime gold.
import fs from 'node:fs';
import crypto from 'node:crypto';

const inputPath = process.argv[2] ?? new URL('./ubuddy-cp-rir-g05-baseline-dominance-v0.input.example.json', import.meta.url);
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const forbidden = new Set(['expected', 'worldValues', 'robustDelta', 'deltaWitness', 'verdict', 'dominanceWitness', 'baseInputHash', 'variantInputHash', 'selectedCandidateId', 'negativeWitnessSet']);

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};
const bytes = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash('sha256').update(bytes(value), 'utf8').digest('hex');
const rat = (x) => {
  if (!x || !Number.isInteger(x.num) || !Number.isInteger(x.den) || !Number.isSafeInteger(x.num) || !Number.isSafeInteger(x.den) || x.den <= 0) throw new Error('INVALID_OR_UNSAFE_RATIONAL');
  return { n: BigInt(x.num), d: BigInt(x.den) };
};
const add = (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a, b) => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const cmp = (a, b) => { const z = a.n * b.d - b.n * a.d; return z < 0n ? -1 : z > 0n ? 1 : 0; };
const minRat = (xs) => xs.reduce((a, b) => (cmp(a, b) <= 0 ? a : b));
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const outRat = (x) => { const g = gcd(x.n, x.d); const sign = x.d < 0n ? -1n : 1n; return { num: Number((x.n / g) * sign), den: Number((x.d / g) * sign) }; };
const equalRat = (a, b) => cmp(a, b) === 0;
const fail = (status, reason, extra = {}) => {
  console.log(JSON.stringify({ artifactStatus: status, inputStatus: status, reasonCode: reason, ...extra }, null, 2));
  process.exit(0);
};

try {
  const walk = (v, path = []) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...path, i]));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (path[0] !== 'answerIsolation' && forbidden.has(k)) throw new Error(`ANSWER_KEY:${[...path, k].join('/')}`);
      walk(x, [...path, k]);
    }
  };
  walk(input);
  const fixed = {
    fixedBindings: input.fixedBindings,
    kernel: input.kernel,
    candidatePolicy: input.candidatePolicy,
    thresholds: input.thresholds
  };
  const fixedBindingDigest = digest(fixed);
  const candidate = input.candidatePolicy;
  const base = input.baseBaselinePolicy;
  const variant = input.variantBaselinePolicy;
  if (candidate.role !== 'candidate' || base.role !== 'baseline' || variant.role !== 'baseline') fail('PAIR_BINDING_UNKNOWN', 'BASELINE_ROLE_MISMATCH');
  for (const policy of [candidate, base, variant]) if (crypto.createHash('sha256').update(policy.canonicalAst, 'utf8').digest('hex') !== policy.canonicalPolicyHash) fail('PAIR_BINDING_UNKNOWN', 'POLICY_HASH_MISMATCH');
  if (new Set([candidate.canonicalPolicyHash, base.canonicalPolicyHash, variant.canonicalPolicyHash]).size !== 3) fail('PAIR_BINDING_UNKNOWN', 'POLICY_ID_NOT_STRICT');
  if (candidate.canonicalAst === variant.canonicalAst) fail('PAIR_BINDING_UNKNOWN', 'CANDIDATE_VARIANT_AST_EQUAL');
  if (input.kernel.actions.length !== 3 || !input.kernel.actions.includes(candidate.proposal) || !input.kernel.actions.includes(base.proposal) || !input.kernel.actions.includes(variant.proposal)) fail('PAIR_BINDING_UNKNOWN', 'ACTION_NOT_REGISTERED');

  const arm = (armId, baseline) => ({ armId, fixed, baselinePolicy: baseline });
  const baseArm = arm('base', base);
  const variantArm = arm('variant', variant);
  const baseInputHash = digest(baseArm);
  const variantInputHash = digest(variantArm);
  const supportChecks = [];
  const worldArithmetic = [];
  const utility = { success: rat(input.kernel.terminalUtility.success), failure: rat(input.kernel.terminalUtility.failure) };
  const valueFor = (world, proposal) => {
    const auth = world.authorization?.[proposal];
    const exec = world.executability?.[proposal];
    if (auth !== 'ALLOW' || exec !== true) throw new Error(`BASELINE_SUPPORT_MISSING:${world.worldId}/${proposal}`);
    const rows = world.transitionRows?.[proposal];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`BASELINE_SUPPORT_MISSING:${world.worldId}/${proposal}/rows`);
    let mass = { n: 0n, d: 1n };
    let value = { n: 0n, d: 1n };
    for (const row of rows) {
      if (row.from !== input.kernel.initialState || !Object.hasOwn(utility, row.to)) throw new Error(`BASELINE_SUPPORT_MISSING:${world.worldId}/${proposal}/endpoint`);
      const p = rat(row.prob); if (p.n < 0n) throw new Error(`BASELINE_SUPPORT_MISSING:${world.worldId}/${proposal}/negative`);
      mass = add(mass, p); value = add(value, { n: p.n * utility[row.to].n, d: p.d * utility[row.to].d });
    }
    if (!equalRat(mass, { n: 1n, d: 1n })) throw new Error(`BASELINE_SUPPORT_MISSING:${world.worldId}/${proposal}/mass`);
    return value;
  };
  for (const world of input.kernel.worlds) {
    const vc = valueFor(world, candidate.proposal);
    const vb = valueFor(world, base.proposal);
    const vv = valueFor(world, variant.proposal);
    const db = sub(vc, vb); const dv = sub(vc, vv); const dom = sub(vv, vb);
    supportChecks.push({ worldId: world.worldId, actions: input.kernel.actions, status: 'SUPPORTED' });
    worldArithmetic.push({ worldId: world.worldId, candidateValue: outRat(vc), baseBaselineValue: outRat(vb), variantBaselineValue: outRat(vv), baseDelta: outRat(db), variantDelta: outRat(dv), dominanceGap: outRat(dom) });
  }
  const baseD = minRat(worldArithmetic.map((x) => rat(x.baseDelta)));
  const variantD = minRat(worldArithmetic.map((x) => rat(x.variantDelta)));
  const dominance = worldArithmetic.map((x) => ({ worldId: x.worldId, strict: cmp(rat(x.variantBaselineValue), rat(x.baseBaselineValue)) > 0 }));
  const weakEveryWorld = worldArithmetic.every((x) => cmp(rat(x.variantBaselineValue), rat(x.baseBaselineValue)) >= 0);
  if (!weakEveryWorld || !dominance.some((x) => x.strict)) fail('DOMINANCE_CHECK', 'BASELINE_NOT_WEAKLY_DOMINANT_WITH_STRICT_WITNESS', { baseInputHash, variantInputHash, fixedBindingDigest, worldArithmetic, dominance });
  const eta = rat(input.thresholds.eta), kappa = rat(input.thresholds.kappa), cost = rat(candidate.cost);
  const candidateValue = minRat(input.kernel.worlds.map((w) => valueFor(w, candidate.proposal)));
  const baseAccept = cmp(candidateValue, eta) >= 0 && cmp(baseD, kappa) >= 0 && cmp(cost, rat(input.thresholds.costBudget)) <= 0;
  const variantAccept = cmp(candidateValue, eta) >= 0 && cmp(variantD, kappa) >= 0 && cmp(cost, rat(input.thresholds.costBudget)) <= 0;
  console.log(JSON.stringify({
    artifactStatus: 'PROTOTYPE_OUTPUT', inputStatus: 'VALID', reasonCode: null,
    baseInputHash, variantInputHash, fixedBindingDigest,
    changedPointers: ['/variantBaselinePolicy'],
    pairBinding: 'DERIVED_FROM_SHARED_ENVELOPE; independent dual-file diff still unverified',
    candidateHash: candidate.canonicalPolicyHash, baseBaselineHash: base.canonicalPolicyHash, variantBaselineHash: variant.canonicalPolicyHash,
    supportChecks, worldArithmetic,
    aggregateArithmetic: { aggregation: 'min_world_difference', robustDeltaBase: outRat(baseD), robustDeltaPrime: outRat(variantD), strictDecrease: cmp(variantD, baseD) < 0 },
    dominance: { everyWorldWeak: weakEveryWorld, strictAtLeastOne: dominance.some((x) => x.strict) },
    baseArm: { softPlanningStatus: baseAccept ? 'SOFT_ACCEPT' : 'SOFT_PLAN_REJECT', reasonCode: baseAccept ? null : 'DELTA' },
    variantArm: { softPlanningStatus: variantAccept ? 'SOFT_ACCEPT' : 'SOFT_PLAN_REJECT', reasonCode: variantAccept ? null : 'DELTA' },
    planningSafety: { status: 'NOT_EVALUATED', reasonCode: null, witnessRef: null },
    causalScope: 'fixed finite model policy-regime contrast only; not current-instance root cause, population efficacy or general monotonicity theorem'
  }, null, 2));
} catch (e) {
  const msg = String(e.message ?? e);
  const reason = msg.startsWith('BASELINE_SUPPORT_MISSING') ? 'BASELINE_SUPPORT_MISSING' : msg.startsWith('ANSWER_KEY') ? 'ANSWER_KEY_PRESENT' : 'INPUT_INVALID';
  fail('UNKNOWN', reason);
}
