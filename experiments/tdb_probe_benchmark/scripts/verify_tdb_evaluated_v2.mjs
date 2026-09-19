/** Verify independent evaluator outputs and disclosure solver agreement. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findMinimumDisclosure } from '../../../src/shared/contracts/uBuddyDisclosureFrontier.js';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonl = async file => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const actions = ['noop', 'repair_e0', 'repair_e1', 'repair_both'];
const edges = ['e0', 'e1', 'e2'];
function repair(action) { return new Set(action === 'repair_e0' ? ['e0'] : action === 'repair_e1' ? ['e1'] : action === 'repair_both' ? ['e0', 'e1'] : []); }
function success(world, action) {
  const r = repair(action); const ok = Object.fromEntries(edges.map(edge => [edge, Boolean(world.edgeOk[edge]) || r.has(edge)]));
  if (world.structure === 'and_bottleneck') return ok.e0 && ok.e1;
  if (world.structure === 'or_redundancy') return ok.e0 || ok.e1 || ok.e2;
  if (world.structure === 'cascade') return ok.e0 && ok.e1 && ok.e2;
  if (world.structure === 'shared_resource') return edges.reduce((sum, edge) => sum + (ok[edge] ? Number(world.demand[edge]) : 0), 0) <= Number(world.capacity);
  if (world.structure === 'version_coupling') return ok.e0 && ok.e1 && world.versions.e0 === world.versions.e1;
  if (world.structure === 'double_fault') return ok.e0 && ok.e1 && ok.e2;
  throw new Error(`unknown_structure:${world.structure}`);
}
function checkerInput(row) {
  return row;
}
async function main() {
  const dir = path.resolve(process.argv[2] || '');
  if (!dir) throw new Error('evaluated_dir_required');
  const publicRows = await jsonl(path.join(dir, 'public.jsonl'));
  const goldRows = await jsonl(path.join(dir, 'gold.offline.jsonl'));
  const checkerRows = await jsonl(path.join(dir, 'projection.checker-input.jsonl'));
  const failures = [];
  if (publicRows.length !== goldRows.length || publicRows.length !== checkerRows.length) failures.push(['count_mismatch']);
  const ids = new Set(publicRows.map(row => row.id));
  for (const row of goldRows) {
    if (!ids.has(row.id)) { failures.push([row.id, 'missing_public']); continue; }
    const utils = row.utilityGold;
    const interaction = utils.repair_both - utils.repair_e0 - utils.repair_e1 + utils.noop;
    if (Math.abs(interaction - row.bundleInteraction.interactionValue) > 1e-12) failures.push([row.id, 'interaction_mismatch']);
    const hashes = new Set(actions.map(action => row.arms[action].initialStateHash));
    const versions = new Set(actions.map(action => row.arms[action].evaluation.evaluatorVersion));
    if (hashes.size !== 1) failures.push([row.id, 'paired_snapshot_mismatch']);
    if (versions.size !== 1) failures.push([row.id, 'evaluator_version_mismatch']);
    if (row.projection.status === 'CERTIFIED') {
      const checker = checkerRows.find(item => item.id === row.id);
      const result = findMinimumDisclosure(checkerInput(checker));
      if (result.status !== 'CERTIFIED' || JSON.stringify(result.selectedUnits) !== JSON.stringify(row.projection.selectedUnits)) failures.push([row.id, 'projection_solver_mismatch']);
    }
  }
  const report = {
    scope: 'tdb-independent-evaluator-verification-v2',
    rows: goldRows.length,
    failures,
    allValid: failures.length === 0,
    testWasNotRead: true,
    evidenceLevel: 'SYNTHETIC_FINITE_WORLD_ONLY',
    publicSha256: sha256(await fs.readFile(path.join(dir, 'public.jsonl'))),
    goldSha256: sha256(await fs.readFile(path.join(dir, 'gold.offline.jsonl'))),
  };
  await fs.writeFile(path.join(dir, 'verification.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!report.allValid) process.exitCode = 2;
}
await main();
