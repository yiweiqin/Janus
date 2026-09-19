import fs from 'node:fs/promises';
import path from 'node:path';

const required = {
  realIndependentEvaluator: 'A real task evaluator independent of the scorer and generator',
  realHeldoutFamilies: 'Held-out real task families, not only one synthetic generator',
  stateGold: 'Independent state posterior gold with label provenance',
  projectionGold: 'Independent decision-sufficiency/projection reference and privacy checker',
  baselines: 'Pre-registered baseline and ablation matrix',
  calibration: 'Calibration/OOD/risk-coverage artifact',
  costAccounting: 'Comparable latency/token/Probe/repair cost accounting',
  humanAgreement: 'Dual annotation agreement and adjudication for human labels',
  transfer: 'Agent-pair, relation-type, temporal and adapt-1/3/5 transfer',
};

function check(value, reason) { return { pass: Boolean(value), reason: value ? null : reason }; }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

export async function audit(runDirectory) {
  const root = path.resolve(runDirectory);
  const result = { version: 'tdb-paper-readiness-v1', runDirectory: root, evidenceLevel: null, checks: {}, blockers: [], warnings: [] };
  const files = new Set(await fs.readdir(root));
  const manifest = files.has('manifest.json') ? await readJson(path.join(root, 'manifest.json')) : null;
  const metrics = files.has('metrics.json') ? await readJson(path.join(root, 'metrics.json')) : null;
  result.evidenceLevel = manifest?.evidenceLevel || metrics?.evidenceLevel || 'unknown';
  result.checks.artifactManifest = check(Boolean(manifest), 'manifest.json is missing');
  result.checks.replay = check(Boolean(manifest?.files && manifest?.code && manifest?.synthetic === true), 'replay/hash manifest is missing');
  result.checks.realIndependentEvaluator = check(manifest?.realIndependentEvaluator === true, required.realIndependentEvaluator);
  result.checks.realHeldoutFamilies = check(manifest?.realHeldoutFamilies >= 20, required.realHeldoutFamilies);
  result.checks.stateGold = check(manifest?.stateGold === true, required.stateGold);
  result.checks.projectionGold = check(manifest?.projectionGold === true, required.projectionGold);
  result.checks.baselines = check(manifest?.baselineMatrixComplete === true, required.baselines);
  result.checks.calibration = check(manifest?.calibrationArtifact === true, required.calibration);
  result.checks.costAccounting = check(manifest?.costAccounting === true, required.costAccounting);
  result.checks.humanAgreement = check(manifest?.humanAgreement === true, required.humanAgreement);
  result.checks.transfer = check(manifest?.transferMatrixComplete === true, required.transfer);
  result.checks.syntheticOnlyDisclosure = check(result.evidenceLevel !== 'REAL_HELDOUT', 'run is synthetic/pilot and cannot support real generalization claims');
  for (const [name, item] of Object.entries(result.checks)) if (!item.pass && name !== 'syntheticOnlyDisclosure') result.blockers.push({ check: name, reason: item.reason });
  if (result.evidenceLevel !== 'REAL_HELDOUT') result.warnings.push('Only protocol/synthetic evidence is present; paper claims must be scoped accordingly.');
  result.readyForRealGeneralizationClaim = result.blockers.length === 0 && result.evidenceLevel === 'REAL_HELDOUT';
  result.readyForSyntheticMethodSection = result.checks.artifactManifest.pass && result.checks.replay.pass;
  return result;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/paper_readiness_gate.mjs')) {
  const directory = process.argv[2]; if (!directory) throw new Error('run_directory_required');
  const result = await audit(directory); console.log(JSON.stringify(result, null, 2));
  if (!result.readyForRealGeneralizationClaim) process.exitCode = 2;
}
