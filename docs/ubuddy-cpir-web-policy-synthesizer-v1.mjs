import {conflictEdges, universallySafeRepairs, evaluateRepair} from './ubuddy-cpir-web-contract-evaluator-v1.mjs';

const obsFor = (world, probe) => world.scopes.includes(probe.scope) ? world.observations[probe.id] : 'UNSUPPORTED';
const partition = (belief, probe) => {
  const cells=new Map();
  for (const w of belief) { const o=obsFor(w,probe); if(!cells.has(o))cells.set(o,[]); cells.get(o).push(w); }
  return cells;
};
const countNodes = tree => tree.decision==='PROBE' ? 1+Object.values(tree.branches).reduce((n,x)=>n+countNodes(x),0) : 1;
const beliefWorlds = (scenario, ids) => scenario.worlds.filter(w => ids.includes(w.id));
const unresolved = (scenario, tree) => {
  if(tree.decision==='REPAIR') return [];
  if(tree.decision==='ABSTAIN') return conflictEdges(scenario,beliefWorlds(scenario,tree.belief)).map(e=>e.worldIds.join('|'));
  return [...new Set(Object.values(tree.branches).flatMap(x=>unresolved(scenario,x)))];
};

function solveConflict(scenario, belief, probes, budget, depth) {
  const direct=universallySafeRepairs(scenario,belief);
  if(direct.length) return {decision:'REPAIR',repairId:direct[0].repair.id,belief:belief.map(x=>x.id)};
  let best={decision:'ABSTAIN',belief:belief.map(x=>x.id)};
  if(depth<=0) return best;
  let bestScore=[unresolved(scenario,best).length,Infinity,Infinity];
  for(const p of probes) {
    if(p.risk>budget) continue;
    const cells=partition(belief,p);
    if(cells.size===1) continue;
    const remaining=probes.filter(x=>x.id!==p.id);
    const branches={};
    for(const [o,cell] of cells) branches[o]=solveConflict(scenario,cell,remaining,budget-p.risk,depth-1);
    const tree={decision:'PROBE',probeId:p.id,belief:belief.map(x=>x.id),branches};
    const score=[unresolved(scenario,tree).length,p.risk,countNodes(tree)];
    if(score[0]<bestScore[0] || score[0]===bestScore[0]&&score[1]<bestScore[1] || score[0]===bestScore[0]&&score[1]===bestScore[1]&&score[2]<bestScore[2]) {best=tree;bestScore=score;}
  }
  return best;
}

function solveInformationGain(scenario, belief, probes, depth) {
  if(depth<=0 || probes.length===0) {
    const scored=scenario.repairs.filter(r=>r.id!=='ABSTAIN').map(r=>({r,ok:belief.filter(w=>evaluateRepair(scenario,w,r).disposition==='SATISFIED').length})).sort((a,b)=>b.ok-a.ok||a.r.cost-b.r.cost);
    return scored[0]?.ok ? {decision:'REPAIR',repairId:scored[0].r.id,belief:belief.map(x=>x.id)} : {decision:'ABSTAIN',belief:belief.map(x=>x.id)};
  }
  const ranked=probes.map(p=>({p,cells:partition(belief,p)})).sort((a,b)=>b.cells.size-a.cells.size||a.p.risk-b.p.risk);
  const {p,cells}=ranked[0];
  if(cells.size===1) return solveInformationGain(scenario,belief,probes.filter(x=>x.id!==p.id),depth-1);
  const branches={}; for(const [o,cell] of cells) branches[o]=solveInformationGain(scenario,cell,probes.filter(x=>x.id!==p.id),depth-1);
  return {decision:'PROBE',probeId:p.id,belief:belief.map(x=>x.id),branches};
}

function solveSafePOMDP(scenario, belief, probes, budget, depth) {
  // Independent implementation of a finite constrained-POMDP policy search.
  // It deliberately has no access to CPIR certificates or conflict-edge scores.
  const universallySafe = (cell) => scenario.repairs
    .filter(r => r.id !== 'ABSTAIN')
    .filter(r => cell.every(w => evaluateRepair(scenario,w,r).disposition === 'SATISFIED'))
    .sort((a,b) => a.cost-b.cost || a.id.localeCompare(b.id))[0];
  const recurse = (cell, ps, remBudget, remDepth) => {
    const safe = universallySafe(cell);
    if (safe) return {decision:'REPAIR',repairId:safe.id,belief:cell.map(w=>w.id)};
    if (remDepth<=0) return {decision:'ABSTAIN',belief:cell.map(w=>w.id)};
    let best={decision:'ABSTAIN',belief:cell.map(w=>w.id)};
    let bestUnresolved=Infinity;
    for (const p of ps) {
      if (p.risk>remBudget) continue;
      const cells=partition(cell,p); if(cells.size===1) continue;
      const branches={}; let unresolvedCount=0;
      for (const [obs,sub] of cells) {
        branches[obs]=recurse(sub,ps.filter(q=>q.id!==p.id),remBudget-p.risk,remDepth-1);
        if(branches[obs].decision==='ABSTAIN') unresolvedCount += sub.length;
      }
      if(unresolvedCount<bestUnresolved){bestUnresolved=unresolvedCount;best={decision:'PROBE',probeId:p.id,belief:cell.map(w=>w.id),branches};}
    }
    return best;
  };
  return recurse(belief,probes,budget,depth);
}

export function synthesizePolicies(scenario, {budget=0.6,depth=3}={}) {
  const belief=scenario.worlds;
  const conflictTree=solveConflict(scenario,belief,scenario.probes,budget,depth);
  const initialEdges=conflictEdges(scenario,belief);
  const probeClosure=scenario.probes.map(p=>({probeId:p.id,scope:p.scope,risk:p.risk,observationAlphabet:[...new Set(belief.map(w=>obsFor(w,p)))].sort(),worldCoverage:belief.map(w=>w.id).sort()}));
  return {
    cpir:{tree:conflictTree,certificate:{initialConflictEdges:initialEdges,probeClosure,unresolvedEdges:unresolved(scenario,conflictTree),certificateStatus:unresolved(scenario,conflictTree).length?'PARTIAL_OR_ABSTAIN':'COVERED_UNDER_DECLARED_CATALOG'}},
    safePOMDP:{tree:solveSafePOMDP(scenario,belief,scenario.probes,budget,depth),certificate:null},
    activeDiagnosis:{tree:solveInformationGain(scenario,belief,scenario.probes,depth),certificate:null},
    oneStepDiagnosis:{tree:solveInformationGain(scenario,belief,scenario.probes,1),certificate:null}
  };
}

export function executeTree(scenario, tree, probeResponse) {
  const observations=[];
  let node=tree;
  while(node.decision==='PROBE') {
    const probe=scenario.probes.find(p=>p.id===node.probeId);
    const observation=probeResponse(probe); observations.push({probeId:probe.id,observation});
    node=node.branches[observation];
    if(!node) return {repairId:'ABSTAIN',observations,reason:'UNDECLARED_OBSERVATION'};
  }
  return {repairId:node.decision==='REPAIR'?node.repairId:'ABSTAIN',observations,reason:node.decision};
}
