/*
 * Research-only P2 conflict/blockage registry.
 * It consumes per-world action evaluations, never hidden causes or safeByWorld.
 */
import {createHash} from 'node:crypto';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const unique = values => [...new Set(values)];
const subsets = (values, maxWorlds = 20) => {
  if (values.length > maxWorlds) throw new Error(`WORLD_CLASS_BOUND_EXCEEDED:${values.length}>${maxWorlds}`);
  const out = [];
  const limit = 2 ** values.length;
  for (let mask = 1; mask < limit; mask++) out.push(values.filter((_, index) => mask & (2 ** index)));
  return out.sort((a, b) => a.length - b.length || a.join('|').localeCompare(b.join('|')));
};

export const terminalVerdict = evaluation => evaluation?.terminalDisposition === 'SAFE' && evaluation?.disposition === 'SAFE'
  ? 'SAFE_TERMINAL'
  : evaluation?.disposition === 'VIOLATED' ? 'VIOLATED' : 'UNKNOWN';

function intersection(sets) {
  if (!sets.length) return new Set();
  const [first, ...rest] = sets;
  return new Set([...first].filter(value => rest.every(set => set.has(value))));
}

function classify(subset, actionIds, matrix) {
  const rows = subset.map(worldId => matrix[worldId]);
  const safeSets = rows.map(row => new Set(actionIds.filter(actionId => row[actionId]?.verdict === 'SAFE_TERMINAL')));
  const commonSafe = intersection(safeSets);
  if (commonSafe.size) return {kind: 'NONE', commonSafe: [...commonSafe].sort()};

  const hasInfeasibleWorld = rows.some(row => actionIds.every(actionId => row[actionId]?.verdict === 'VIOLATED'));
  const allActionsHaveViolation = actionIds.every(actionId => rows.some(row => row[actionId]?.verdict === 'VIOLATED'));
  const hasUnknownStatus = actionIds.some(actionId => rows.some(row => row[actionId]?.verdict === 'UNKNOWN'));
  if (safeSets.every(set => set.size > 0) && allActionsHaveViolation && !hasUnknownStatus) return {kind: 'HARD_CONFLICT', commonSafe: []};

  const blockageActions = actionIds.filter(actionId => {
    const statuses = rows.map(row => row[actionId]?.verdict);
    return statuses.every(status => status !== 'VIOLATED') && statuses.some(status => status === 'UNKNOWN');
  });
  if (blockageActions.length) return {kind: 'EPISTEMIC_BLOCKAGE', commonSafe: [], blockageActions: blockageActions.sort()};
  if (hasInfeasibleWorld) return {kind: 'INFEASIBLE', commonSafe: []};
  return {kind: 'MIXED_OBSTRUCTION', commonSafe: []};
}

function witnessFor(subset, actionIds, matrix) {
  return Object.fromEntries(actionIds.map(actionId => [actionId, subset.map(worldId => ({
    worldId,
    verdict: matrix[worldId][actionId]?.verdict ?? 'UNKNOWN',
    obligationIds: matrix[worldId][actionId]?.obligationIds ?? [],
    reasonCodes: matrix[worldId][actionId]?.reasonCodes ?? []
  }))]));
}

export function buildConflictRegistry({worlds, actions, evaluate, maxWorldClasses = 20}) {
  const rawWorldIds = worlds.map(world => world.id).sort();
  const actionIds = actions.map(action => action.id).sort();
  const rawMatrix = {};
  for (const world of worlds) {
    rawMatrix[world.id] = {};
    for (const action of actions) {
      const evaluation = evaluate(world, action);
      rawMatrix[world.id][action.id] = {
        verdict: terminalVerdict(evaluation),
        disposition: evaluation?.disposition ?? 'UNKNOWN',
        evidenceMode: evaluation?.evidenceMode ?? 'NONE',
        obligationIds: (evaluation?.obligations ?? []).filter(item => item.verdict !== 'SAFE').map(item => item.obligationId),
        reasonCodes: (evaluation?.obligations ?? []).filter(item => item.verdict !== 'SAFE').map(item => item.code)
      };
    }
  }
  const classesBySignature = new Map();
  for (const worldId of rawWorldIds) {
    const signature = hash(rawMatrix[worldId]);
    if (!classesBySignature.has(signature)) classesBySignature.set(signature, []);
    classesBySignature.get(signature).push(worldId);
  }
  const equivalenceClasses = [...classesBySignature.values()].map(ids => ids.sort()).sort((a, b) => a[0].localeCompare(b[0]));
  const worldIds = equivalenceClasses.map(ids => ids[0]);
  const matrix = Object.fromEntries(worldIds.map(worldId => [worldId, rawMatrix[worldId]]));

  const edges = [];
  const mixedObstructions = [];
  for (const subset of subsets(worldIds, maxWorldClasses)) {
    const classification = classify(subset, actionIds, matrix);
    if (classification.kind === 'MIXED_OBSTRUCTION') {
      mixedObstructions.push({worldSet: subset, witnessesByAction: witnessFor(subset, actionIds, matrix)});
    }
    if (!['HARD_CONFLICT', 'EPISTEMIC_BLOCKAGE', 'MIXED_OBSTRUCTION'].includes(classification.kind)) continue;
    const proper = subsets(subset, maxWorldClasses).filter(candidate => candidate.length < subset.length);
    if (proper.some(candidate => classify(candidate, actionIds, matrix).kind !== 'NONE')) continue;
    const edgeCore = {
      kind: classification.kind,
      minimalWorldSet: subset,
      actionIds,
      blockageActions: classification.blockageActions ?? [],
      witnessesByAction: witnessFor(subset, actionIds, matrix)
    };
    edges.push({edgeId: `edge:${hash(edgeCore)}`, ...edgeCore});
  }

  const infeasibleSingletons = worldIds.filter(worldId => classify([worldId], actionIds, matrix).kind === 'INFEASIBLE');
  return {
    schemaVersion: 'cpir-web/conflict-registry/v0',
    implementationStatus: 'research-prototype/unverified',
    worldIds,
    rawWorldIds,
    equivalenceClasses,
    actionIds,
    matrix,
    edges,
    mixedObstructions,
    infeasibleSingletons,
    publicCutDigest: hash(worldIds),
    registryDigest: hash({worldIds, actionIds, matrix, edges, mixedObstructions, infeasibleSingletons}),
    algorithmLimits: {maxWorldClasses, subsetEnumeration: 'exact-bounded'}
  };
}
