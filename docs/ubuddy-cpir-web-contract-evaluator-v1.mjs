// Transition/contract evaluator separated from world generation and policy synthesis.
export function evaluateRepair(scenario, world, repair) {
  if (repair.id === 'ABSTAIN') return {disposition:'UNKNOWN',reasons:['ABSTAIN'],finalCardinality:world.initialCardinality};
  const reasons = [];
  const hasScopes = repair.requiredScopes.every(s => world.scopes.includes(s));
  if (!hasScopes) reasons.push('REQUIRED_SCOPE_MISSING');
  if (world.initialCardinality === null) reasons.push('INITIAL_EFFECT_CARDINALITY_UNKNOWN');

  if (repair.claimSuccess) {
    if (world.initialCardinality !== 1) reasons.push('SUCCESS_WITHOUT_PROVEN_EFFECT');
  } else if (repair.effectDelta > 0) {
    if (world.binding === 'WRONG' && !repair.rebindIdentity && repair.targetBinding !== 'BOUND') reasons.push('WRONG_TARGET_BINDING');
    if (world.binding === 'WRONG' && repair.targetBinding === 'CURRENT') reasons.push('WRONG_TARGET_BINDING');
    if (world.auth === 'EXPIRED' && !repair.refreshAuth) reasons.push('AUTH_EXPIRED');
    if (world.version === 'STALE' && !repair.refreshVersion) reasons.push('VERSION_STALE');
    if (world.version === 'CHANGED') reasons.push('INTERVENING_VERSION_REQUIRES_CONFIRMATION');
    if (world.reference === 'INVALID' && !repair.fixReference) reasons.push('REFERENCE_INVALID');
  }

  const finalCardinality = world.initialCardinality === null ? null : world.initialCardinality + (hasScopes ? repair.effectDelta : 0);
  if (finalCardinality !== null && finalCardinality > scenario.contract.maxCardinality) reasons.push('EFFECT_CARDINALITY_EXCEEDED');
  if (finalCardinality !== null && finalCardinality < scenario.contract.requiredCardinality) reasons.push('REQUIRED_EFFECT_MISSING');
  if (finalCardinality === null) return {disposition:'UNKNOWN',reasons:[...new Set(reasons)],finalCardinality};
  return {disposition:reasons.length ? 'VIOLATED' : 'SATISFIED',reasons:[...new Set(reasons)],finalCardinality};
}

export function universallySafeRepairs(scenario, belief) {
  return scenario.repairs
    .filter(r => r.id !== 'ABSTAIN')
    .map(repair => ({repair,evaluations:belief.map(world => ({worldId:world.id,...evaluateRepair(scenario,world,repair)}))}))
    .filter(x => x.evaluations.every(e => e.disposition === 'SATISFIED'))
    .sort((a,b) => a.repair.cost-b.repair.cost || a.repair.id.localeCompare(b.repair.id));
}

export function conflictEdges(scenario, belief) {
  const edges = [];
  for (let i=0;i<belief.length;i++) for (let j=i+1;j<belief.length;j++) {
    const a=belief[i], b=belief[j];
    const witness=[];
    const commonSafe=[];
    for (const r of scenario.repairs.filter(x=>x.id!=='ABSTAIN')) {
      const ea=evaluateRepair(scenario,a,r).disposition;
      const eb=evaluateRepair(scenario,b,r).disposition;
      if (ea==='SATISFIED' && eb==='SATISFIED') commonSafe.push(r.id);
      else witness.push({repairId:r.id,worldA:ea,worldB:eb});
    }
    // A pair is a conflict edge only when no candidate-independent repair
    // is universally safe for both worlds. Mere safety asymmetry is not enough.
    if (!commonSafe.length) edges.push({worldIds:[a.id,b.id],witnessRepairs:witness,obligationLevel:'DECLARED_CONTRACT_CONFLICT'});
  }
  return edges;
}

export function executeRepair(scenario, world, repair) {
  const evaluation=evaluateRepair(scenario,world,repair);
  return {
    action:repair.id,
    evaluation,
    goldEffectLedger:{
      effectClass:scenario.contract.effectClass,
      intendedCardinality:scenario.contract.requiredCardinality,
      actualCardinality:evaluation.finalCardinality,
      irreversible:repair.effectDelta>0,
      contractDisposition:evaluation.disposition,
      violationReasons:evaluation.reasons
    }
  };
}
