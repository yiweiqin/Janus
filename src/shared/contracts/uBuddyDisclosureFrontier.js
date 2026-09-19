/** Exact nonadaptive disclosure over a declared finite, rectangular model. */
export function findMinimumDisclosure(input = {}) {
  const diagnostics = { visitedSubsets: 0, evaluatedPartitions: 0, pruned: 0, dominatedUnits: 0 };
  const done = result => ({ ...result, diagnostics });
  const fail = reason => done({ status: 'UNKNOWN', reason, selectedUnits: [], disclosureCost: null, frontier: 'finite_catalog_optimum' });
  const catalog = Array.isArray(input.worlds) ? input.worlds : [];
  const units = Array.isArray(input.units) ? input.units : [];
  const epsilon = input.epsilon;
  const hasRiskBudget = input.riskBudget !== undefined && input.riskBudget !== null;
  if (typeof epsilon !== 'number' || !Number.isFinite(epsilon) || epsilon < 0) return fail('epsilon_invalid');
  if (hasRiskBudget && (typeof input.riskBudget !== 'number' || !Number.isFinite(input.riskBudget) || input.riskBudget < 0)) return fail('risk_budget_invalid');
  if (!input.binding || typeof input.binding !== 'object') return fail('binding_missing');
  const binding = publicBinding(input.binding);
  if (!binding.scope || !binding.version || !binding.query) return fail('binding_incomplete');
  if (!catalog.length || catalog.length > 128) return fail('world_catalog_out_of_bounds');
  if (units.length > 16) return fail('unit_catalog_out_of_bounds');
  if (!catalog.every(w => w && typeof w.id === 'string' && w.id.trim()) || new Set(catalog.map(w => w.id)).size !== catalog.length) return fail('world_catalog_invalid');
  if (!catalog.some(w => w.id === input.currentWorldId)) return fail('current_world_unknown');
  if (!units.every(u => u && u.allowed === true && typeof u.id === 'string' && u.id.trim() && typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0)
    || new Set(units.map(u => u.id.trim())).size !== units.length) return fail('unit_catalog_invalid');
  const initial = input.initial ?? {};
  if (typeof initial !== 'object' || Array.isArray(initial) || Object.values(initial).some(v => !primitiveFinite(v))) return fail('initial_observable_invalid');
  const worlds = catalog.filter(w => Object.entries(initial).every(([key, value]) => {
    const observations = w.observations || w.values || {};
    return Object.hasOwn(observations, key) && JSON.stringify(observations[key]) === JSON.stringify(value);
  }));
  if (!worlds.length) return fail('initial_observation_inconsistent');
  // Validate the private current-world identifier without revealing it to the
  // receiver or collapsing the receiver's uncertainty to that single world.
  if (!worlds.some(w => w.id === input.currentWorldId)) return fail('current_world_initial_inconsistent');
  const actions = input.allowedActions === undefined
    ? [...new Set(catalog.flatMap(w => [...Object.keys(w.utilities || {}), ...Object.keys(w.utilityInterval || {}), ...Object.keys(w.safe || {})]))].sort()
    : input.allowedActions;
  if (!Array.isArray(actions) || !actions.length || actions.length > 32) return fail('action_catalog_out_of_bounds');
  if (actions.some(a => typeof a !== 'string' || !a.trim()) || new Set(actions).size !== actions.length) return fail('action_catalog_invalid');
  const orderedInput = units.map(u => ({ ...u, id: u.id.trim() })).sort((a, b) => a.cost - b.cost || lexical(a.id, b.id));
  if (worlds.some(w => orderedInput.some(u => !Object.hasOwn(w.values || {}, u.id) || !primitiveFinite(w.values[u.id])))) return fail('observable_value_invalid');

  // Compile admissible action sets once. Top two safe upper endpoints exclude
  // the candidate's own upper endpoint in O(1), including tied maxima.
  const admissible = new Map();
  const intervalMode = worlds.some(w => w.utilityInterval !== undefined || Object.values(w.utilities || {}).some(v => v && typeof v === 'object'));
  for (const w of worlds) {
    if (w.support !== true) return fail('support_incomplete');
    if (w.evidenceConflict === true) return fail('declared_evidence_conflict');
    if (actions.some(a => typeof w.safe?.[a] !== 'boolean')) return fail('contract_incomplete');
    const bounds = actions.map(a => utilityBounds(w.utilityInterval?.[a] ?? w.utilities?.[a]));
    if (bounds.some(v => !v)) return fail(intervalMode ? 'utility_interval_invalid' : 'utility_incomplete');
    if (hasRiskBudget && actions.some(a => w.safe[a] && (typeof w.risk?.[a] !== 'number' || !Number.isFinite(w.risk[a]) || w.risk[a] < 0))) return fail('risk_incomplete');
    let first = -Infinity, second = -Infinity, firstIndex = -1;
    for (let i = 0; i < actions.length; i++) if (w.safe[actions[i]]) {
      const upper = bounds[i][1];
      if (upper > first) { second = first; first = upper; firstIndex = i; }
      else if (upper > second) second = upper;
    }
    let mask = 0;
    for (let i = 0; i < actions.length; i++) if (w.safe[actions[i]]) {
      const regret = Math.max(0, (i === firstIndex ? second : first) - bounds[i][0]);
      if (regret <= epsilon && (!hasRiskBudget || w.risk[actions[i]] <= input.riskBudget)) mask |= 1 << i;
    }
    admissible.set(w, mask);
  }
  const signature = unit => JSON.stringify(worlds.map(w => w.values[unit.id]));
  const representatives = new Map();
  for (const unit of orderedInput) if (!representatives.has(signature(unit))) representatives.set(signature(unit), unit);
  const ordered = orderedInput.filter(unit => representatives.get(signature(unit)) === unit);
  diagnostics.dominatedUnits = orderedInput.length - ordered.length;
  const n = ordered.length;
  let best = null;
  const costOf = mask => ordered.reduce((sum, unit, i) => sum + ((mask & (1 << i)) ? unit.cost : 0), 0);
  function assess(mask) {
    diagnostics.evaluatedPartitions++;
    const blocks = new Map();
    for (const w of worlds) {
      const values = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) values.push(w.values[ordered[i].id]);
      const key = JSON.stringify(values);
      if (!blocks.has(key)) blocks.set(key, { worlds: [], common: -1 });
      const block = blocks.get(key);
      block.worlds.push(w); block.common &= admissible.get(w);
    }
    for (const block of blocks.values()) if (block.common === 0) return block.worlds;
    return null;
  }
  function dfs(selected, undecided) {
    diagnostics.visitedSubsets++;
    const cost = costOf(selected);
    if (best && cost > best.cost) { diagnostics.pruned++; return; }
    const conflict = assess(selected);
    if (!conflict) {
      const ids = ordered.filter((_, i) => selected & (1 << i)).map(u => u.id).sort();
      if (!best || cost < best.cost || (cost === best.cost && (ids.length < best.units.length
        || (ids.length === best.units.length && compareIds(ids, best.units) < 0)))) best = { units: ids, cost };
      return;
    }
    let pick = -1, groups = 1, minimumSplitterCost = Infinity;
    for (let i = 0; i < n; i++) if (undecided & (1 << i)) {
      const count = new Set(conflict.map(w => JSON.stringify(w.values[ordered[i].id]))).size;
      if (count > 1) {
        minimumSplitterCost = Math.min(minimumSplitterCost, ordered[i].cost);
        if (count > groups || (count === groups && (pick < 0 || lexical(ordered[i].id, ordered[pick].id) < 0))) { pick = i; groups = count; }
      }
    }
    // Every feasible extension must split this conflicting block at least once.
    // The cheapest remaining splitter is therefore an admissible cost bound.
    if (pick < 0 || (best && cost + minimumSplitterCost > best.cost)) { diagnostics.pruned++; return; }
    const bit = 1 << pick;
    dfs(selected | bit, undecided ^ bit);
    dfs(selected, undecided ^ bit);
  }
  dfs(0, (1 << n) - 1);
  return best ? done({ status: 'CERTIFIED', binding, selectedUnits: best.units, disclosureCost: best.cost, epsilon,
    ...(hasRiskBudget ? { riskBudget: input.riskBudget } : {}), frontier: 'finite_catalog_optimum' }) : fail('no_common_safe_epsilon_optimal_action');
}

function utilityBounds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? [value, value] : null;
  if (!value || typeof value !== 'object') return null;
  // Preserve the disclosure API's historical two-number array shorthand.
  if (Array.isArray(value) && value.length !== 2) return null;
  const lower = Array.isArray(value) ? value[0] : value.lower ?? value.min;
  const upper = Array.isArray(value) ? value[1] : value.upper ?? value.max;
  return typeof lower === 'number' && Number.isFinite(lower) && typeof upper === 'number' && Number.isFinite(upper) && lower <= upper ? [lower, upper] : null;
}
function primitiveFinite(value) { return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value); }
function lexical(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function compareIds(a, b) { for (let i = 0; i < a.length; i++) { const difference = lexical(a[i], b[i]); if (difference) return difference; } return 0; }
function publicBinding(value) { return { scope: clean(value.scope || value.taskId || value.task_id), version: clean(value.version), query: clean(value.query || value.queryId || value.query_id) }; }
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200); }
