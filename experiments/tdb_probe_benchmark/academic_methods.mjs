// Academic core: constrained disclosure and conservative intervention ranking.
// These functions are deterministic reference algorithms; a model may propose
// candidates, but certification remains the responsibility of independent checkers.

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(Number(x)) ? Number(x) : lo));

/**
 * Solve min disclosure cost subject to worst-case decision regret and privacy.
 * Each unit contains worlds keyed by world id and an action utility map.
 */
export function solveDisclosureFrontier({ units = [], worlds = [], actions = [], epsilon = 0.05, privacyBudget = 1 } = {}) {
  const feasible = [];
  const n = units.length;
  if (n > 20 || !Array.isArray(worlds) || !Array.isArray(actions) || !actions.length) {
    return { version: 'constrained-disclosure-frontier-v1', epsilon, privacyBudget, frontier: [], optimum: null, status: 'UNKNOWN', reason: 'finite_solver_bounds' };
  }
  for (let mask = 0; mask < (1 << n); mask += 1) {
    const selected = units.filter((_, i) => mask & (1 << i));
    const cost = selected.reduce((s, u) => s + Math.max(0, Number(u.cost || 0)), 0);
    const privacy = selected.reduce((s, u) => s + Math.max(0, Number(u.privacyLoss || 0)), 0);
    if (privacy > privacyBudget) continue;
    let worstRegret = 0;
    for (const world of worlds) {
      const signature = selected.map(u => String(world.observation?.[u.id] ?? '')).join('|');
      const same = worlds.filter(w => selected.map(u => String(w.observation?.[u.id] ?? '')).join('|') === signature);
      const robust = actions.length ? Math.max(...actions.map(a => {
        const safe = same.every(w => w.safe?.[a] !== false);
        return safe ? Math.min(...same.map(w => Number(w.utility?.[a] ?? 0))) : -Infinity;
      })) : 0;
      const oracle = actions.length ? Math.max(...actions.filter(a => world.safe?.[a] !== false).map(a => Number(world.utility?.[a] ?? 0))) : 0;
      worstRegret = Math.max(worstRegret, oracle - robust);
    }
    feasible.push({ selectedUnits: selected.map(u => u.id), disclosureCost: cost, privacyLoss: privacy, worstCaseRegret: worstRegret, sufficient: worstRegret <= epsilon });
  }
  feasible.sort((a, b) => a.disclosureCost - b.disclosureCost || a.worstCaseRegret - b.worstCaseRegret);
  const sufficient = feasible.filter(x => x.sufficient);
  return { version: 'constrained-disclosure-frontier-v1', epsilon, privacyBudget, frontier: feasible, optimum: sufficient[0] || null, status: sufficient.length ? 'SOLVED' : 'UNKNOWN' };
}

/**
 * Conservative causal ranking. Gain is a lower confidence bound on uplift;
 * interaction is inclusion-exclusion residual and is explicitly retained.
 */
export function rankInterventions({ candidates = [], z = 1.96, lambdaCost = 1, lambdaRisk = 1 } = {}) {
  lambdaCost = Number.isFinite(Number(lambdaCost)) ? Number(lambdaCost) : 1;
  lambdaRisk = Number.isFinite(Number(lambdaRisk)) ? Number(lambdaRisk) : 1;
  const rows = candidates.map(c => {
    const mean = Number(c.upliftMean || 0);
    const se = Math.max(0, Number(c.upliftSE || 0));
    const lcb = mean - z * se;
    const interaction = Number(c.jointUplift || 0) - Number(c.aUplift || 0) - Number(c.bUplift || 0);
    const cost = Math.max(Number(c.cost || 0), 1e-9);
    const negativeTransfer = clamp(c.negativeTransferRisk);
    // All terms are expressed in utility units. Cost and expected negative
    // transfer are calibrated before ranking; the ratio is dimensionless.
    const netLCB = lcb - lambdaCost * cost - lambdaRisk * negativeTransfer * Math.abs(mean);
    const score = netLCB / cost;
    return { ...c, lcb, interaction, negativeTransferRisk: negativeTransfer, netLCB, conservativePriority: score, recommendation: netLCB > 0 ? 'INTERVENE' : 'ABSTAIN' };
  }).sort((a, b) => b.conservativePriority - a.conservativePriority);
  return { version: 'conservative-intervention-ranking-v2', z, lambdaCost, lambdaRisk, candidates: rows };
}

/** Check the theorem's sufficient condition for disclosure monotonicity. */
export function disclosureMonotonicityCertificate({ base, extension, privacyBudget = Infinity } = {}) {
  const baseCost = Number(base?.disclosureCost); const extCost = Number(extension?.disclosureCost);
  const basePrivacy = Number(base?.privacyLoss || 0); const extPrivacy = Number(extension?.privacyLoss || 0);
  const condition = Number.isFinite(baseCost) && Number.isFinite(extCost) && extCost >= baseCost
    && extPrivacy <= privacyBudget && basePrivacy <= privacyBudget
    && Number(extension?.worstCaseRegret) <= Number(base?.worstCaseRegret);
  return { version: 'disclosure-monotonicity-certificate-v1', condition, theorem: 'partition_refinement_without_budget_violation', certified: condition };
}

/**
 * Budgeted conservative portfolio selection for minimum evolution steps.
 * gain(S) must be a declared monotone-submodular oracle. The greedy result then
 * has the standard (1-1/e) guarantee for unit costs; for arbitrary costs this
 * function reports a conservative bound only when the caller supplies one.
 */
export function selectInterventionPortfolio({ candidates = [], gain, budget = 0, declaredSubmodular = false, approximationBound = null } = {}) {
  if (!declaredSubmodular || typeof gain !== 'function' || !Number.isFinite(Number(budget)) || budget < 0) {
    return { version: 'submodular-intervention-portfolio-v1', status: 'UNKNOWN', reason: 'submodularity_or_gain_not_declared', selected: [], totalCost: 0, gain: null };
  }
  const pool = candidates.filter(c => Number(c.cost) >= 0 && Number(c.cost) <= budget);
  const selected = []; let totalCost = 0; let currentGain = Number(gain([])) || 0;
  while (true) {
    let best = null;
    for (const c of pool) {
      if (selected.some(x => x.id === c.id) || totalCost + Number(c.cost) > budget) continue;
      const next = [...selected, c];
      const marginal = (Number(gain(next)) || 0) - currentGain;
      const density = Number(c.cost) > 0 ? marginal / Number(c.cost) : (marginal > 0 ? Infinity : -Infinity);
      if (!best || density > best.density || (density === best.density && String(c.id).localeCompare(String(best.c.id)) < 0)) best = { c, density, marginal };
    }
    if (!best || best.marginal <= 0) break;
    selected.push(best.c); totalCost += Number(best.c.cost); currentGain += best.marginal;
  }
  return { version: 'submodular-intervention-portfolio-v1', status: 'PROPOSED', selected: selected.map(c => c.id), totalCost, gain: currentGain, approximationBound: approximationBound ?? (pool.every(c => Number(c.cost) === 1) ? 1 - Math.exp(-1) : null), guaranteeCondition: 'monotone_submodular_gain_and_declared_budget_model' };
}

/** Exhaustive finite-set certificate for monotonicity and submodularity. */
export function certifySubmodularity({ ids = [], gain, tolerance = 1e-9 } = {}) {
  if (!Array.isArray(ids) || ids.length > 16 || typeof gain !== 'function') return { version: 'submodularity-certificate-v1', status: 'UNKNOWN', reason: 'oracle_or_domain_invalid' };
  const value = mask => gain(ids.filter((_, i) => mask & (1 << i)));
  const values = Array.from({ length: 1 << ids.length }, (_, m) => Number(value(m)));
  if (values.some(v => !Number.isFinite(v))) return { version: 'submodularity-certificate-v1', status: 'UNKNOWN', reason: 'nonfinite_gain' };
  const violations = [];
  for (let a = 0; a < values.length; a++) for (let i = 0; i < ids.length; i++) if (!(a & (1 << i))) {
    const b = a | (1 << i);
    if (values[b] + tolerance < values[a]) violations.push({ type: 'monotonicity', a, b });
    for (let c = 0; c < values.length; c++) if ((c & a) === a && !(c & (1 << i))) {
      const d = c | (1 << i);
      if (values[b] - values[a] + tolerance < values[d] - values[c]) violations.push({ type: 'submodularity', a, c, b, d });
    }
  }
  return { version: 'submodularity-certificate-v1', status: violations.length ? 'REJECTED' : 'CERTIFIED', monotone: !violations.some(v => v.type === 'monotonicity'), submodular: !violations.some(v => v.type === 'submodularity'), checkedSubsets: values.length, violations: violations.slice(0, 32) };
}

/**
 * Exact finite-model adaptive disclosure policy.
 * A policy is a decision tree: after observing selected unit values it either
 * stops with a robust action or discloses one more unit. The objective is
 * minimum prior expected cost subject to a worst-case regret bound. This is
 * strictly more expressive than a single static subset.
 */
export function solveAdaptiveDisclosure({ units = [], worlds = [], actions = [], epsilon = 0.05, privacyBudget = 1, prior = null, priors = null } = {}) {
  if (!Array.isArray(units) || units.length > 12 || !Array.isArray(worlds) || !worlds.length || !Array.isArray(actions) || !actions.length) return { version: 'adaptive-disclosure-policy-v1', status: 'UNKNOWN', reason: 'finite_policy_bounds' };
  if (!Number.isFinite(Number(epsilon)) || Number(epsilon) < 0 || !Number.isFinite(Number(privacyBudget)) || Number(privacyBudget) < 0 || worlds.some(w => !w || typeof w.id !== 'string' || !w.id) || new Set(worlds.map(w => w.id)).size !== worlds.length || new Set(actions).size !== actions.length) return { version: 'adaptive-disclosure-policy-v1', status: 'UNKNOWN', reason: 'model_contract_invalid' };
  const allowed = units.filter(u => u && u.allowed !== false && Number.isFinite(Number(u.cost)) && Number(u.cost) >= 0 && Number(u.privacyLoss || 0) >= 0);
  if (allowed.length !== units.length) return { version: 'adaptive-disclosure-policy-v1', status: 'UNKNOWN', reason: 'unit_contract_invalid' };
  if (new Set(allowed.map(u => u.id)).size !== allowed.length || worlds.some(w => actions.some(a => typeof w.safe?.[a] !== 'boolean' || !boundsForAdaptive(w.utilityInterval?.[a] ?? w.utility?.[a])))) return { version: 'adaptive-disclosure-policy-v1', status: 'UNKNOWN', reason: 'world_contract_invalid' };
  const priorList = Array.isArray(priors) && priors.length ? priors : [prior || Object.fromEntries(worlds.map(w => [w.id, 1 / worlds.length]))];
  const normalizedPriors = priorList.map(p => {
    const total = worlds.reduce((s, w) => s + Math.max(0, Number(p?.[w.id] ?? 0)), 0) || 1;
    return Object.fromEntries(worlds.map(w => [w.id, Math.max(0, Number(p?.[w.id] ?? 0)) / total]));
  });
  const bounds = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return [value, value];
    if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return [value[0], value[1]];
    if (value && typeof value === 'object' && Number.isFinite(Number(value.lower ?? value.min)) && Number.isFinite(Number(value.upper ?? value.max))) return [Number(value.lower ?? value.min), Number(value.upper ?? value.max)];
    return null;
  };
  const robustAction = group => {
    let best = null;
    for (const action of actions) {
      if (!group.every(w => w.safe?.[action] !== false)) continue;
      const regret = Math.max(...group.map(w => {
        const utility = w.utilityInterval || w.utility || {};
        const ub = Math.max(...actions.filter(a => w.safe?.[a] !== false).map(a => (bounds(utility[a]) || [-Infinity, -Infinity])[1]));
        const candidate = (bounds(utility[action]) || [Infinity, Infinity])[0];
        return ub - candidate;
      }));
      if (regret <= epsilon && (!best || regret < best.regret || (regret === best.regret && String(action).localeCompare(String(best.action)) < 0))) best = { action, regret };
    }
    return best;
  };
  const memo = new Map(); const frontierCap = 4096;
  const prune = candidates => {
    const worldIds = worlds.map(w => w.id).sort();
    const unique = new Map();
    for (const c of candidates) { const key = worldIds.map(id => Number(c.costs[id] ?? Infinity).toPrecision(15)).join(','); if (!unique.has(key)) unique.set(key, c); }
    const rows = [...unique.values()];
    return rows.filter((a, i) => !rows.some((b, j) => i !== j && worldIds.every(id => Number(b.costs[id] ?? Infinity) <= Number(a.costs[id] ?? Infinity) + 1e-12) && worldIds.some(id => Number(b.costs[id] ?? Infinity) < Number(a.costs[id] ?? Infinity) - 1e-12)));
  };
  const solve = (group, remaining, privacy) => {
    const key = `${group.map(w => w.id).sort().join(',')}|${remaining.join(',')}|${privacy.toFixed(12)}`;
    if (memo.has(key)) return memo.get(key);
    const stop = robustAction(group); let frontier = stop ? [{ costs: Object.fromEntries(group.map(w => [w.id, 0])), tree: { type: 'stop', action: stop.action, regret: stop.regret } }] : [];
    for (const id of remaining) {
      const unit = allowed.find(u => u.id === id); if (!unit || privacy + Number(unit.privacyLoss || 0) > privacyBudget) continue;
      const partitions = new Map(); for (const w of group) { const value = JSON.stringify(w.observation?.[id]); if (!partitions.has(value)) partitions.set(value, []); partitions.get(value).push(w); }
      if (partitions.size < 2) continue;
      const childFrontiers = [...partitions.values()].map(child => solve(child, remaining.filter(x => x !== id), privacy + Number(unit.privacyLoss || 0)));
      if (childFrontiers.some(c => !c.length)) continue;
      let combinations = [{ costs: {}, children: [] }];
      for (const [index, childFrontier] of childFrontiers.entries()) {
        const next = []; const branchWorlds = partitions.get([...partitions.keys()][index]);
        for (const prefix of combinations) for (const child of childFrontier) {
          const costs = { ...prefix.costs }; for (const w of branchWorlds) costs[w.id] = child.costs[w.id] + Number(unit.cost);
          next.push({ costs, children: [...prefix.children, child] });
        }
        combinations = next.length > frontierCap * 2 ? prune(next).slice(0, frontierCap) : next;
      }
      frontier.push(...combinations.map(c => ({ costs: c.costs, tree: { type: 'reveal', unit: id, children: Object.fromEntries([...partitions.keys()].map((k, i) => [k, c.children[i].tree])) } })));
      frontier = prune(frontier); if (frontier.length > frontierCap) return [];
    }
    memo.set(key, frontier); return frontier;
  };
  const frontier = solve(worlds, allowed.map(u => u.id), 0);
  if (!frontier.length) return { version: 'adaptive-disclosure-policy-v2', status: 'UNKNOWN', reason: 'no_regret_feasible_policy', diagnostics: { states: memo.size, priorCount: normalizedPriors.length } };
  const score = c => normalizedPriors.map(p => worlds.reduce((s, w) => s + p[w.id] * c.costs[w.id], 0));
  const result = frontier.map(c => ({ ...c, expectedCostByPrior: score(c) })).sort((a, b) => Math.max(...a.expectedCostByPrior) - Math.max(...b.expectedCostByPrior) || Math.max(...Object.values(a.costs)) - Math.max(...Object.values(b.costs)))[0];
  return { version: 'adaptive-disclosure-policy-v2', status: 'SOLVED', epsilon, privacyBudget, expectedDisclosureCost: Math.max(...result.expectedCostByPrior), expectedDisclosureCostByPrior: result.expectedCostByPrior, worstDisclosureCost: Math.max(...Object.values(result.costs)), policy: result.tree, theoremCondition: normalizedPriors.length > 1 ? 'finite_worlds_and_declared_prior_set' : 'finite_worlds_and_declared_prior', diagnostics: { states: memo.size, priorCount: normalizedPriors.length, frontierSize: frontier.length } };
}

function boundsForAdaptive(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return [value, value];
  if (Array.isArray(value) && value.length === 2 && value.every(v => Number.isFinite(Number(v))) && Number(value[0]) <= Number(value[1])) return [Number(value[0]), Number(value[1])];
  if (value && typeof value === 'object' && Number.isFinite(Number(value.lower ?? value.min)) && Number.isFinite(Number(value.upper ?? value.max)) && Number(value.lower ?? value.min) <= Number(value.upper ?? value.max)) return [Number(value.lower ?? value.min), Number(value.upper ?? value.max)];
  return null;
}

/** Independent certificate checker for an adaptive policy tree. */
export function certifyAdaptiveDisclosurePolicy({ policy, units = [], worlds = [], actions = [], epsilon = 0.05, privacyBudget = 1 } = {}) {
  if (!policy || !Array.isArray(units) || !Array.isArray(worlds) || !Array.isArray(actions)) return { version: 'adaptive-disclosure-certificate-v1', status: 'UNKNOWN', reason: 'certificate_input_invalid' };
  const unitMap = new Map(units.map(u => [u.id, u])); const seen = new Set();
  const walk = (node, group, privacy, path) => {
    if (!node || typeof node !== 'object') return { ok: false, reason: 'node_invalid' };
    if (node.type === 'stop') {
      if (!actions.includes(node.action) || !group.every(w => w.safe?.[node.action] === true)) return { ok: false, reason: 'unsafe_or_unknown_action', path };
      let regret = 0;
      for (const w of group) {
        const utility = w.utilityInterval || w.utility || {};
        const candidate = boundsForAdaptive(utility[node.action]);
        const oracle = Math.max(...actions.filter(a => w.safe?.[a] === true).map(a => boundsForAdaptive(utility[a])[1]));
        regret = Math.max(regret, oracle - candidate[0]);
      }
      if (regret > epsilon + 1e-12) return { ok: false, reason: 'regret_bound_violation', path, regret };
      group.forEach(w => seen.add(w.id)); return { ok: true };
    }
    if (node.type !== 'reveal' || !unitMap.has(node.unit) || seen.size === worlds.length && group.length) return { ok: false, reason: 'reveal_node_invalid', path };
    const unit = unitMap.get(node.unit); const nextPrivacy = privacy + Number(unit.privacyLoss || 0);
    if (nextPrivacy > privacyBudget + 1e-12 || path.includes(node.unit)) return { ok: false, reason: 'privacy_or_repeated_unit_violation', path };
    if (!node.children || typeof node.children !== 'object') return { ok: false, reason: 'children_missing', path };
    const groups = new Map(); for (const w of group) { const key = JSON.stringify(w.observation?.[node.unit]); if (!Object.hasOwn(node.children, key)) return { ok: false, reason: 'branch_missing', path: [...path, node.unit] }; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(w); }
    for (const [key, branchWorlds] of groups) { const result = walk(node.children[key], branchWorlds, nextPrivacy, [...path, node.unit]); if (!result.ok) return result; }
    return { ok: true };
  };
  const result = walk(policy, worlds, 0, []);
  return result.ok && seen.size === worlds.length ? { version: 'adaptive-disclosure-certificate-v1', status: 'CERTIFIED', worldCount: worlds.length } : { version: 'adaptive-disclosure-certificate-v1', status: 'REJECTED', reason: result.reason || 'world_not_covered', path: result.path || [] };
}

/**
 * Decision value of revealing one unit. It is defined by robust-regret
 * reduction, normalized by communication cost and privacy loss. This is an
 * interpretable marginal quantity, not a learned attention score.
 */
export function disclosureValueOfInformation({ beforeRegret, afterRegret, cost = 0, privacyLoss = 0, lambdaPrivacy = 1 } = {}) {
  const before = Number(beforeRegret); const after = Number(afterRegret);
  const denominator = Math.max(Number(cost) + Number(lambdaPrivacy) * Number(privacyLoss), 1e-12);
  if (![before, after, denominator].every(Number.isFinite) || before < 0 || after < 0 || after > before) return { version: 'disclosure-voi-v1', status: 'UNKNOWN', reason: 'regret_or_cost_invalid' };
  return { version: 'disclosure-voi-v1', status: 'DEFINED', regretReduction: before - after, denominator, value: (before - after) / denominator, monotone: after <= before };
}

/**
 * Partial-identification of causal explanations. Each cause has a predicted
 * response signature over interventions/observables. We return the complete
 * equivalence class of minimal subsets whose additive signature matches the
 * observed response within tolerance; no scalar dependency score is produced.
 */
export function identifyCauseEquivalenceClass({ causes = [], observed = [], tolerance = 0 } = {}) {
  if (!Array.isArray(causes) || causes.length > 20 || !Array.isArray(observed) || observed.length === 0 || causes.some(c => !c || typeof c.id !== 'string' || !Array.isArray(c.signature) || c.signature.length !== observed.length)) return { version: 'causal-equivalence-class-v1', status: 'UNKNOWN', reason: 'cause_design_invalid' };
  const y = observed.map(Number); const tau = Math.max(0, Number(tolerance));
  if (!y.every(Number.isFinite) || !Number.isFinite(tau)) return { version: 'causal-equivalence-class-v1', status: 'UNKNOWN', reason: 'response_invalid' };
  const matches = [];
  for (let mask = 0; mask < (1 << causes.length); mask += 1) {
    const prediction = observed.map((_, j) => causes.reduce((s, c, i) => s + ((mask & (1 << i)) ? Number(c.signature[j]) : 0), 0));
    if (prediction.every((v, j) => Number.isFinite(v) && Math.abs(v - y[j]) <= tau)) matches.push({ ids: causes.filter((_, i) => mask & (1 << i)).map(c => c.id), prediction, cardinality: popcount(mask) });
  }
  const minCardinality = matches.length ? Math.min(...matches.map(m => m.cardinality)) : null;
  const minimal = matches.filter(m => m.cardinality === minCardinality);
  return { version: 'causal-equivalence-class-v1', status: minimal.length ? (minimal.length === 1 ? 'IDENTIFIED' : 'PARTIALLY_IDENTIFIED') : 'UNIDENTIFIED', observed: y, tolerance: tau, minimalCauseSets: minimal, equivalenceClassSize: minimal.length, theoremCondition: 'additive_signature_model_with_bounded_observation_error' };
}

function popcount(value) { let n = value; let count = 0; while (n) { n &= n - 1; count += 1; } return count; }
