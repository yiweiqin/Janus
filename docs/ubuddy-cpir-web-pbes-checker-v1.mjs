#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const base = new URL('.', import.meta.url);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const input = read(process.argv[2] ? path.resolve(process.argv[2]) : new URL('./ubuddy-cpir-web-pbes-v1.input.example.json', base));
const schema = read(new URL('./ubuddy-cpir-web-pbes-v1.schema.json', base));
const validate = new Ajv2020({strict: false}).compile(schema);
const fail = reasonCode => ({
  schemaVersion: 'cpir-web/pbes-output/v1',
  implementationStatus: 'prototype/unverified',
  status: 'INPUT_INVALID',
  reasonCode
});

if (!validate(input)) {
  console.log(JSON.stringify(fail('SCHEMA_VALIDATION_FAILED'), null, 2));
  process.exit(0);
}

const subset = (required, available) => required.every(x => available.has(x));
const exactKeys = (obj, ids) => {
  const a = Object.keys(obj).sort();
  const b = [...ids].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
};
const better = (a, b) => {
  if (!b) return true;
  if (a.repairedWorlds !== b.repairedWorlds) return a.repairedWorlds > b.repairedWorlds;
  if (a.worstPathRisk !== b.worstPathRisk) return a.worstPathRisk < b.worstPathRisk;
  if (a.worstPathCost !== b.worstPathCost) return a.worstPathCost < b.worstPathCost;
  if (a.maxProbeDepthUsed !== b.maxProbeDepthUsed) return a.maxProbeDepthUsed < b.maxProbeDepthUsed;
  return a.treeNodes < b.treeNodes;
};

const results = [];
for (const c of input.cases) {
  const worlds = new Map(c.worlds.map(w => [w.worldId, w]));
  const probes = new Map(c.probes.map(p => [p.probeId, p]));
  const repairs = new Map(c.repairs.map(r => [r.repairId, r]));
  const scopes = new Set(c.availableScopes);
  const worldIds = [...worlds.keys()];

  if (worlds.size !== c.worlds.length || probes.size !== c.probes.length || repairs.size !== c.repairs.length) {
    console.log(JSON.stringify(fail('DUPLICATE_ID'), null, 2));
    process.exit(0);
  }
  if (new Set(c.worlds.map(w => w.publicObservation)).size !== 1) {
    console.log(JSON.stringify(fail('PAIRED_WORLD_PUBLIC_OBSERVATION_MISMATCH'), null, 2));
    process.exit(0);
  }
  for (const p of c.probes) {
    if (!exactKeys(p.observationByWorld, worldIds)) {
      console.log(JSON.stringify(fail('PROBE_WORLD_COVERAGE_NOT_EXACT'), null, 2));
      process.exit(0);
    }
  }
  for (const r of c.repairs) {
    if (!exactKeys(r.safeByWorld, worldIds) || !exactKeys(r.utilityByWorld, worldIds)) {
      console.log(JSON.stringify(fail('REPAIR_WORLD_COVERAGE_NOT_EXACT'), null, 2));
      process.exit(0);
    }
  }

  const memo = new Map();
  let memoHits = 0;
  const solve = (belief, remainingRisk, remainingDepth, usedProbeIds, observations) => {
    const beliefIds = belief.map(w => w.worldId).sort();
    const used = new Set(usedProbeIds);
    const obs = new Set(observations);
    const key = JSON.stringify([beliefIds, remainingRisk.toFixed(9), remainingDepth, [...used].sort(), [...obs].sort()]);
    if (memo.has(key)) {
      memoHits += 1;
      return memo.get(key);
    }

    let best = {
      decision: 'ABSTAIN', worldIds: beliefIds, repairedWorlds: 0,
      worstPathRisk: 0, worstPathCost: 0, maxProbeDepthUsed: 0, treeNodes: 1
    };

    const directRepairs = c.repairs
      .filter(r => subset(r.requiredScopes, scopes) && subset(r.requiredObservations, obs))
      .filter(r => belief.every(w => r.safeByWorld[w.worldId] && r.utilityByWorld[w.worldId] >= c.utilityLowerBound))
      .sort((a, b) => a.actionCost - b.actionCost || a.repairId.localeCompare(b.repairId));
    if (directRepairs.length) {
      const r = directRepairs[0];
      best = {
        decision: 'REPAIR', repairId: r.repairId, effectClass: r.effectClass,
        worldIds: beliefIds, repairedWorlds: belief.length,
        worstPathRisk: 0, worstPathCost: r.actionCost, maxProbeDepthUsed: 0, treeNodes: 1,
        declaredModelSafetyWitness: beliefIds.map(worldId => ({worldId, safe: r.safeByWorld[worldId], utility: r.utilityByWorld[worldId]}))
      };
    }

    if (remainingDepth > 0) {
      for (const p of c.probes) {
        if (used.has(p.probeId) || p.riskCost > remainingRisk + 1e-12) continue;
        if (!subset(p.requiredScopes, scopes) || !subset(p.requiredObservations, obs)) continue;
        const cells = new Map();
        for (const w of belief) {
          const o = p.observationByWorld[w.worldId];
          if (!cells.has(o)) cells.set(o, []);
          cells.get(o).push(w);
        }
        const branches = [];
        let repairedWorlds = 0;
        let worstChildRisk = 0;
        let worstChildCost = 0;
        let maxChildDepth = 0;
        let treeNodes = 1;
        for (const [observation, cell] of [...cells.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const child = solve(
            cell,
            remainingRisk - p.riskCost,
            remainingDepth - 1,
            [...used, p.probeId],
            [...obs, observation]
          );
          repairedWorlds += child.repairedWorlds;
          worstChildRisk = Math.max(worstChildRisk, child.worstPathRisk);
          worstChildCost = Math.max(worstChildCost, child.worstPathCost);
          maxChildDepth = Math.max(maxChildDepth, child.maxProbeDepthUsed);
          treeNodes += child.treeNodes;
          branches.push({observation, worldIds: cell.map(w => w.worldId).sort(), next: child});
        }
        const candidate = {
          decision: 'PROBE', probeId: p.probeId, worldIds: beliefIds, branches,
          repairedWorlds,
          worstPathRisk: Number((p.riskCost + worstChildRisk).toFixed(9)),
          worstPathCost: Number((p.actionCost + worstChildCost).toFixed(9)),
          maxProbeDepthUsed: 1 + maxChildDepth,
          treeNodes
        };
        if (better(candidate, best)) best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  };

  const plan = solve(c.worlds, c.riskBudget, c.maxProbeDepth, [], []);
  const disposition = plan.decision === 'REPAIR'
    ? 'DIRECT_REPAIR'
    : plan.repairedWorlds === c.worlds.length
      ? (plan.maxProbeDepthUsed > 1 ? 'MULTI_STEP_CONTINGENT_PLAN' : 'ONE_STEP_CONTINGENT_PLAN')
      : plan.repairedWorlds > 0
        ? 'PARTIAL_REPAIR_WITH_ABSTENTION'
        : 'ABSTAIN_NECESSARY_UNDER_DECLARED_MODEL';
  results.push({
    caseId: c.caseId,
    disposition,
    repairedWorlds: plan.repairedWorlds,
    totalWorlds: c.worlds.length,
    riskBudget: c.riskBudget,
    worstPathRisk: plan.worstPathRisk,
    maxProbeDepthUsed: plan.maxProbeDepthUsed,
    memoizedStates: memo.size,
    beliefStateMergeHits: memoHits,
    plan
  });
}

console.log(JSON.stringify({
  schemaVersion: 'cpir-web/pbes-output/v1',
  implementationStatus: 'prototype/unverified',
  status: 'UNKNOWN_INPUT_NOT_PROVEN',
  reasonCode: 'FINITE_MULTISTEP_PBES_DECLARED_MODEL_VALID_RUNTIME_UNVERIFIED',
  results,
  modelScope: 'LOCKED_FINITE_TYPED_WEB_WORLDS',
  optimizationOrder: ['PROTOTYPE_HEURISTIC_MAX_REPAIRED_WORLD_COUNT', 'MIN_WORST_PATH_RISK', 'MIN_WORST_PATH_COST', 'MIN_PROBE_DEPTH', 'MIN_TREE_NODES'],
  unknownReasons: [
    'NO_BROWSER_RUNTIME_REPLAY',
    'NO_OAUTH_OR_OWNER_CERTIFICATE_VERIFICATION',
    'NO_AUTHORITATIVE_SINK_RECEIPT',
    'NO_CURRENT_INSTANCE_ROOT_CAUSE_PROOF',
    'NO_WORLD_MEASURE_OR_REPRESENTATION_INVARIANT_PARTIAL_COVERAGE_OBJECTIVE',
    'NO_EXTERNAL_WORLD_COVERAGE'
  ]
}, null, 2));
