/**
 * Independent finite-world evaluator for the TDB world catalog.
 *
 * This file intentionally does not import the generator or model code. It
 * derives utility, interaction, state labels and disclosure reference from a
 * raw world catalog. It is synthetic protocol evidence, not real-task truth.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIONS = ['noop', 'repair_e0', 'repair_e1', 'repair_both'];
const EDGES = ['e0', 'e1', 'e2'];

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJsonl = async file => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const writeJsonl = async (file, rows) => fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');

function repairedEdges(action) {
  if (action === 'repair_e0') return new Set(['e0']);
  if (action === 'repair_e1') return new Set(['e1']);
  if (action === 'repair_both') return new Set(['e0', 'e1']);
  return new Set();
}

function effectiveState(world, action) {
  const repaired = repairedEdges(action);
  return Object.fromEntries(EDGES.map(edge => [edge, Boolean(world.edgeOk[edge]) || repaired.has(edge)]));
}

function successFor(world, action) {
  const ok = effectiveState(world, action);
  switch (world.structure) {
    case 'and_bottleneck': return ok.e0 && ok.e1;
    case 'or_redundancy': return ok.e0 || ok.e1 || ok.e2;
    case 'cascade': return ok.e0 && ok.e1 && ok.e2;
    case 'shared_resource': {
      const demand = EDGES.reduce((n, edge) => n + (ok[edge] ? Number(world.demand[edge]) : 0), 0);
      return demand <= Number(world.capacity);
    }
    case 'version_coupling': return ok.e0 && ok.e1 && world.versions.e0 === world.versions.e1;
    case 'double_fault': return ok.e0 && ok.e1 && ok.e2;
    default: throw new Error(`unknown_structure:${world.structure}`);
  }
}

function utility(world, action) { return Number(successFor(world, action)); }

function stateLabel(worlds, current, edge, observation) {
  const item = observation.evidence[edge];
  const base = { evidenceRefs: item.evidenceRefs, sourceVersion: item.sourceVersion, latentTarget: Number(current.edgeOk[edge]), label_mask: true };
  if (item.missing) return { ...base, status: 'UNKNOWN', posteriorMean: null, interval: null, uncertainty: 1 };
  if (item.conflict) return { ...base, status: 'CONFLICT', posteriorMean: null, interval: null, uncertainty: 1 };
  if (item.ageBucket >= 3) return { ...base, status: 'STALE', posteriorMean: null, interval: [0, 1], uncertainty: 0.75 };
  const reliability = Number(observation.sourceReliability);
  let positive = 0; let total = 0;
  for (const world of worlds) {
    const truth = Number(world.edgeOk[edge]);
    const likelihood = truth === Number(item.primary) ? reliability : 1 - reliability;
    positive += likelihood * truth; total += likelihood;
  }
  const posteriorMean = total > 0 ? positive / total : 0.5;
  const status = posteriorMean >= 0.8 ? 'SUPPORTED' : posteriorMean <= 0.2 ? 'FAILED' : 'UNKNOWN';
  const radius = Math.max(0.12, 1 - reliability);
  return { ...base, status, posteriorMean, interval: [Math.max(0, posteriorMean - radius), Math.min(1, posteriorMean + radius)], uncertainty: 1 - Math.abs(2 * posteriorMean - 1) };
}

function worldProjection(worlds, currentWorldId, observation, units, actionCosts) {
  // Evidence is explicitly noisy, so a disagreeing signal has non-zero
  // likelihood and cannot remove the true world from the support catalog.
  // State estimation may use reliability; the hard decision checker receives
  // the complete declared support set and fails closed on ambiguity.
  const candidates = worlds;
  const actions = ACTIONS;
  const safeByWorld = world => Object.fromEntries(actions.map(action => [action, true]));
  const catalog = candidates.map(world => ({
    id: world.id,
    observations: Object.fromEntries(EDGES.map(edge => [edge, Number(world.edgeOk[edge])])),
    values: Object.fromEntries(units.map(unit => [unit.id, Number(world.edgeOk[unit.edgeId])])),
    utilities: Object.fromEntries(actions.map(action => [action, utility(world, action) - Number(actionCosts[action])])),
    safe: safeByWorld(world),
    support: true,
  }));
  const current = catalog.find(world => world.id === currentWorldId);
  const orderedUnits = [...units].sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  let best = null;
  for (let mask = 0; mask < (1 << orderedUnits.length); mask++) {
    const selected = orderedUnits.filter((_, index) => mask & (1 << index));
    const blocks = new Map();
    for (const world of catalog) {
      const signature = JSON.stringify(selected.map(unit => world.values[unit.id]));
      if (!blocks.has(signature)) blocks.set(signature, []);
      blocks.get(signature).push(world);
    }
    let sufficient = true;
    for (const block of blocks.values()) {
      const common = ACTIONS.filter(action => block.every(world => {
        if (!world.safe[action]) return false;
        const bestUtility = Math.max(...ACTIONS.filter(candidate => world.safe[candidate]).map(candidate => world.utilities[candidate]));
        return bestUtility - world.utilities[action] <= 0;
      }));
      if (!common.length) { sufficient = false; break; }
    }
    if (!sufficient) continue;
    const cost = selected.reduce((sum, unit) => sum + unit.cost, 0);
    const ids = selected.map(unit => unit.id).sort();
    if (!best || cost < best.cost || (cost === best.cost && (ids.length < best.ids.length
      || (ids.length === best.ids.length && ids.join('\0') < best.ids.join('\0'))))) best = { ids, cost };
  }
  if (!best) return {
    status: 'UNKNOWN', selectedUnits: [], decision: 'PROBE', privacySafe: true, disclosureCost: null,
    coverageRef: `world-catalog:${sha256(JSON.stringify(catalog))}`,
    checkerInput: { binding: { scope: 'task-public', version: 'tdb-independent-reference-v2', query: 'select a safe task action with minimum regret' }, worlds: catalog, units, currentWorldId, initial: {}, allowedActions: ACTIONS, epsilon: 0 },
  };
  const currentSignature = JSON.stringify(best.ids.map(id => current.values[id]));
  const currentBlock = catalog.filter(world => JSON.stringify(best.ids.map(id => world.values[id])) === currentSignature);
  const common = ACTIONS.filter(action => currentBlock.every(world => {
    const bestUtility = Math.max(...ACTIONS.map(candidate => world.utilities[candidate]));
    return bestUtility - world.utilities[action] <= 0;
  })).sort();
  return {
    status: 'CERTIFIED',
    selectedUnits: best.ids,
    decision: common[0],
    privacySafe: true,
    disclosureCost: best.cost,
    coverageRef: `world-catalog:${sha256(JSON.stringify(catalog))}`,
    checkerInput: { binding: { scope: 'task-public', version: 'tdb-independent-reference-v2', query: 'select a safe task action with minimum regret' }, worlds: catalog, units, currentWorldId, initial: {}, allowedActions: ACTIONS, epsilon: 0 },
  };
}

function evaluateRow(row) {
  const current = row.worldCatalog.find(world => world.id === row.currentWorldId);
  if (!current) throw new Error(`current_world_missing:${row.id}`);
  const utilities = Object.fromEntries(ACTIONS.map(action => [action, utility(current, action)]));
  const costs = row.actionCosts;
  const arms = Object.fromEntries(ACTIONS.map(action => [action, {
    action,
    initialStateHash: sha256(JSON.stringify({ row: row.id, world: current })),
    applicable: true,
    evaluation: { utility: utilities[action], evaluatorVersion: 'tdb-independent-reference-v2', outcome: 'completed' },
    cost: costs[action],
  }]));
  const stateGold = Object.fromEntries(EDGES.map(edge => [edge, stateLabel(row.worldCatalog, current, edge, row.publicObservation)]));
  const interaction = utilities.repair_both - utilities.repair_e0 - utilities.repair_e1 + utilities.noop;
  const projection = worldProjection(row.worldCatalog, row.currentWorldId, row.publicObservation, row.unitCatalog, costs);
  return {
    id: row.id,
    familyId: row.taskFamilyId,
    split: row.split,
    publicInput: {
      id: row.id,
      taskFamilyId: row.taskFamilyId,
      split: row.split,
      observable: row.publicObservation,
      structure: row.structure,
      unitCatalog: row.unitCatalog,
      actionCatalog: ACTIONS.map(action => ({ action, applicable: true, cost: costs[action] })),
    },
    gold: {
      id: row.id,
      familyId: row.taskFamilyId,
      split: row.split,
      statePosterior: stateGold,
      bundleInteraction: {
        structure: row.structure.kind,
        edgeIds: EDGES,
        interaction: { repair_e0: true, repair_e1: true, repair_both: true },
        interactionValue: interaction,
        label_mask: true,
        source: 'independent_finite_world_evaluator',
      },
      utilityGold: utilities,
      costGold: costs,
      arms,
      projection: {
        status: projection.status,
        selectedUnits: projection.selectedUnits,
        decision: projection.decision,
        privacySafe: projection.privacySafe,
        disclosureCost: projection.disclosureCost,
        coverageRef: projection.coverageRef,
        decisionScoreSemantics: 'task_utility_minus_incremental_action_cost',
        label_mask: true,
      },
      evaluatorVersion: 'tdb-independent-reference-v2',
      evaluatorInputHash: sha256(JSON.stringify({ worlds: row.worldCatalog, currentWorldId: row.currentWorldId })),
    },
    offlineCheckerInput: projection.checkerInput,
  };
}

const inputDir = path.resolve(process.argv[2] || '');
const outputDir = path.resolve(process.argv[3] || '');
if (!inputDir || !outputDir) throw new Error('usage: evaluate_tdb_world_catalog_v2.mjs INPUT_DIR OUTPUT_DIR');
await fs.mkdir(outputDir, { recursive: false });
const files = ['train.jsonl', 'development.jsonl', 'calibration.jsonl'];
const all = [];
for (const file of files) all.push(...(await readJsonl(path.join(inputDir, file))).map(evaluateRow));
await writeJsonl(path.join(outputDir, 'public.jsonl'), all.map(row => row.publicInput));
await writeJsonl(path.join(outputDir, 'gold.offline.jsonl'), all.map(row => row.gold));
await writeJsonl(path.join(outputDir, 'projection.checker-input.jsonl'), all.map(row => ({ id: row.id, ...row.offlineCheckerInput })));
const manifest = {
  schemaVersion: 'tdb-evaluated-dataset-manifest-v2',
  evidenceLevel: 'SYNTHETIC_FINITE_WORLD_ONLY',
  sourceManifest: JSON.parse(await fs.readFile(path.join(inputDir, 'manifest.json'), 'utf8')),
  evaluatedSplits: files.map(file => file.replace('.jsonl', '')),
  testNotRead: true,
  testFile: 'test.frozen.jsonl',
  evaluator: 'tdb-independent-reference-v2',
  evaluatorSha256: sha256(await fs.readFile(new URL(import.meta.url))),
  files: {},
};
for (const file of ['public.jsonl', 'gold.offline.jsonl', 'projection.checker-input.jsonl']) {
  const bytes = await fs.readFile(path.join(outputDir, file));
  manifest.files[file] = { sha256: sha256(bytes), bytes: bytes.length };
}
await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ outputDir, rows: all.length, evaluatedSplits: manifest.evaluatedSplits, testNotRead: true, evidenceLevel: manifest.evidenceLevel }, null, 2));
