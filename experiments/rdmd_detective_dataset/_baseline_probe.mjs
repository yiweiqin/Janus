// Ad-hoc evidence: why does the legacy structural heuristic score exactly 0 on v3?
//
// `detectMinimalDrift` compares only {title, agentId, version, acceptance} and answers with the
// unique involved root. Two v3 mechanisms interact here:
//   1. a decoy is an *extra* node, and `contrastDriftGraphs` marks both endpoints of an ADDED edge
//      as involved -- so the decoy's innocent parent becomes involved too;
//   2. the decoy ends up with an involved ancestor, so the *parent* is the root, not the decoy.
// When the gold node is visible only in derived fields (`artifact` / `summary` / `output`), the
// decoy's parent is the single root, so the heuristic confidently names an innocent bystander.
// That is why `baseline.topologicalHit` is 0.000: not a metric bug, and not random guessing.
import { readFileSync } from 'node:fs';
import { detectMinimalDrift } from '../../src/shared/contracts/uBuddyReverseDetective.js';
import { changedNodeIds, structuralGraph } from './lib/graph.mjs';

const rows = readFileSync('experiments/rdmd_detective_dataset/data/test.jsonl', 'utf8')
  .split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
const drift = rows.filter((row) => row.label.status === 'drift');

const parentsOfDecoy = (graph, decoys) => {
  const set = new Set(decoys);
  return graph.edges.filter((edge) => set.has(edge.to)).map((edge) => edge.from);
};

const tally = { drift: 0, UNKNOWN: 0, no_drift: 0 };
let hitGold = 0;
let blamedDecoy = 0;
let blamedDecoyParent = 0;
let blamedOther = 0;
for (const row of drift) {
  const prediction = detectMinimalDrift(structuralGraph(row.G_star), structuralGraph(row.G_prime));
  tally[prediction.status] = (tally[prediction.status] || 0) + 1;
  if (prediction.status !== 'drift') continue;
  const decoys = row.label.decoy_nodes || [];
  if (prediction.nodeId === row.label.injected_node) hitGold += 1;
  else if (decoys.includes(prediction.nodeId)) blamedDecoy += 1;
  else if (parentsOfDecoy(row.G_prime, decoys).includes(prediction.nodeId)) blamedDecoyParent += 1;
  else blamedOther += 1;
}
const n = drift.length || 1;
console.log(JSON.stringify({
  n,
  statusTally: tally,
  nodeTop1: hitGold / n,
  blamesDecoyParent: blamedDecoyParent / n,
  blamesDecoyItself: blamedDecoy / n,
  blamesSomethingElse: blamedOther / n,
  abstainRate: tally.UNKNOWN / n,
}, null, 2));
