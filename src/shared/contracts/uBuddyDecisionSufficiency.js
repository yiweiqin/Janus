/** Internal finite-model checker; its guarantee is conditional on an explicit model. */
export function assessDecisionSufficiency({ worlds = [], allowedActions = [], utility, hardContract, support, risk, riskBudget, epsilon = 0, coverage, query = '', initial = null } = {}) {
  const base = { query, action: null, guarantee: 'conditional_on_declared_finite_model', regretBound: null, worldCount: Array.isArray(worlds) ? worlds.length : 0 };
  const unknown = (reason, extra = {}) => ({ status: 'UNKNOWN', ...base, reason, ...extra });
  if (!Array.isArray(worlds) || !worlds.length || worlds.length > 128 || !Array.isArray(allowedActions) || !allowedActions.length || allowedActions.length > 32) return unknown('model_size_invalid');
  if (typeof query !== 'string' || !query.trim() || typeof epsilon !== 'number' || !Number.isFinite(epsilon) || epsilon < 0) return unknown('query_or_epsilon_invalid');
  const hasRiskBudget = riskBudget !== undefined && riskBudget !== null;
  if (hasRiskBudget && (typeof riskBudget !== 'number' || !Number.isFinite(riskBudget) || riskBudget < 0)) return unknown('risk_budget_invalid');
  if (allowedActions.some(a => typeof a !== 'string' || !a.trim()) || new Set(allowedActions).size !== allowedActions.length) return unknown('action_catalog_invalid');
  if (worlds.some(w => !w || typeof w.id !== 'string' || !w.id.trim()) || new Set(worlds.map(w => w.id)).size !== worlds.length) return unknown('world_catalog_invalid');
  if (coverage?.complete !== true || typeof coverage?.basisRef !== 'string' || !coverage.basisRef.trim()) return unknown('coverage_unknown');
  if (initial !== null && (typeof initial !== 'object' || Array.isArray(initial) || Object.values(initial).some(v => !(v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v))))) return unknown('initial_observable_invalid');
  const conditionedWorlds = initial && typeof initial === 'object' && !Array.isArray(initial)
    ? worlds.filter((w) => Object.entries(initial).every(([key, value]) => Object.prototype.hasOwnProperty.call(w.observations || w.values || {}, key)
      && JSON.stringify((w.observations || w.values)[key]) === JSON.stringify(value)))
    : worlds;
  if (!conditionedWorlds.length) return unknown('initial_observation_inconsistent');
  if (conditionedWorlds.some(w => w.evidenceConflict === true)) return { status: 'CONFLICT', ...base, reason: 'declared_evidence_conflict' };
  const actions = [...allowedActions].sort(); const rows = [];
  // An interval model is enabled by an interval declaration anywhere in the catalog.
  // Point values are lifted to degenerate intervals, so mixed catalogs remain comparable.
  const intervalDeclared = conditionedWorlds.some(w => w && w.utilityInterval !== undefined)
    || conditionedWorlds.some(w => w && w.utility && Object.values(w.utility).some(v => v && typeof v === 'object' && !Array.isArray(v) && (Object.prototype.hasOwnProperty.call(v, 'lower') || Object.prototype.hasOwnProperty.call(v, 'upper') || Object.prototype.hasOwnProperty.call(v, 'min') || Object.prototype.hasOwnProperty.call(v, 'max'))));
  const readUtility = (w, a) => typeof utility === 'function' ? utility(w, a) : (w.utilityInterval?.[a] ?? w.utility?.[a]);
  const bounds = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? [v, v] : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const lower = v.lower ?? v.min; const upper = v.upper ?? v.max;
    return typeof lower === 'number' && Number.isFinite(lower) && typeof upper === 'number' && Number.isFinite(upper) && lower <= upper ? [lower, upper] : null;
  };
  try {
    for (const w of conditionedWorlds) {
      if ((typeof support === 'function' ? support(w) : w.support) !== true) return unknown('support_incomplete');
      const utilityBounds = actions.map(a => bounds(readUtility(w, a)));
      if (intervalDeclared && utilityBounds.some(v => !v)) return unknown('utility_interval_incomplete', { ...(intervalDeclared ? { utilityMode: 'interval' } : {}) });
      if (!intervalDeclared && utilityBounds.some(v => !v || v[0] !== v[1])) return unknown('utility_incomplete');
      const safe = actions.map(a => typeof hardContract === 'function' ? hardContract(w, a) : w.safe ? w.safe[a] : w.hardContract);
      if (safe.some(s => typeof s !== 'boolean')) return unknown('contract_incomplete');
      const feasible = utilityBounds.filter((_, i) => safe[i]); if (!feasible.length) return unknown('no_safe_action');
      const risks = actions.map(a => {
        if (!hasRiskBudget) return 0;
        const value = typeof risk === 'function' ? risk(w, a) : w.risk?.[a];
        return value;
      });
      if (hasRiskBudget && risks.some((v, i) => safe[i] && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))) return unknown('risk_incomplete');
      let first = -Infinity, second = -Infinity, firstIndex = -1;
      for (let i = 0; i < actions.length; i++) if (safe[i]) {
        const upper = utilityBounds[i][1];
        if (upper > first) { second = first; first = upper; firstIndex = i; }
        else if (upper > second) second = upper;
      }
      rows.push({ bounds: utilityBounds, safe, risks, first, second, firstIndex });
    }
  } catch { return unknown('model_provider_failed'); }
  const regretCandidates = actions.map((action, i) => ({
    action,
    // Rectangular interval regret compares the candidate against a *different*
    // safe action. Including the candidate's own upper endpoint would create a
    // spurious self-regret whenever its interval is wide.
    worst: Math.max(...rows.map(row => {
      if (!row.safe[i]) return Infinity;
      const bestCompetitor = i === row.firstIndex ? row.second : row.first;
      return Math.max(0, bestCompetitor - row.bounds[i][0]);
    })),
    worstRisk: Math.max(...rows.map(row => row.safe[i] ? row.risks[i] : Infinity)),
  }))
    .filter(row => Number.isFinite(row.worst) && row.worst <= epsilon);
  if (hasRiskBudget && regretCandidates.length && !regretCandidates.some(row => row.worstRisk <= riskBudget)) return unknown('risk_budget_infeasible', intervalDeclared ? { utilityMode: 'interval' } : {});
  const candidates = regretCandidates
    .filter(row => !hasRiskBudget || row.worstRisk <= riskBudget)
    .sort((a,b) => a.worst - b.worst || a.worstRisk - b.worstRisk || a.action.localeCompare(b.action));
  if (!candidates.length) return unknown('action_ambiguity', intervalDeclared ? { utilityMode: 'interval' } : {});
  return { status: 'CERTIFIED', ...base, worldCount: conditionedWorlds.length, action: candidates[0].action, epsilon, regretBound: candidates[0].worst,
    ...(intervalDeclared ? { utilityMode: 'interval', regretSemantics: 'upper_best_minus_lower_candidate' } : {}),
    ...(hasRiskBudget ? { riskBudget, riskBound: candidates[0].worstRisk } : {}), reason: hasRiskBudget ? 'safe_epsilon_optimal_under_risk_budget' : 'safe_epsilon_optimal_in_declared_worlds' };
}
