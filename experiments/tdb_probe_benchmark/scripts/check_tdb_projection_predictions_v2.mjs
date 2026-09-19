/** Directly validate predicted disclosure sets against offline finite worlds. */
import fs from 'node:fs/promises';
import path from 'node:path';

const readJsonl = async file => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);

function assessPrediction(prediction, input) {
  const isCandidate = prediction.status === 'PROPOSED' || prediction.status === 'CERTIFIED';
  if (!isCandidate) return {
    certified: false, abstained: true, privacySafe: true, sufficient: false,
    decisionAgreement: false, disclosureCost: 0, reason: prediction.status,
  };
  const unitMap = new Map(input.units.map(unit => [unit.id, unit]));
  const selected = Array.isArray(prediction.selectedUnits) ? [...new Set(prediction.selectedUnits)].sort() : [];
  const privacySafe = selected.every(id => unitMap.get(id)?.allowed === true);
  if (!privacySafe) return { certified: true, abstained: false, privacySafe: false, sufficient: false, decisionAgreement: false, disclosureCost: null, reason: 'unit_not_allowed' };
  const blocks = new Map();
  for (const world of input.worlds) {
    const signature = JSON.stringify(selected.map(id => world.values[id]));
    if (!blocks.has(signature)) blocks.set(signature, []);
    blocks.get(signature).push(world);
  }
  let sufficient = true;
  for (const block of blocks.values()) {
    const common = input.allowedActions.filter(action => block.every(world => {
      if (!world.safe[action]) return false;
      const best = Math.max(...input.allowedActions.filter(candidate => world.safe[candidate]).map(candidate => world.utilities[candidate]));
      return best - world.utilities[action] <= input.epsilon;
    }));
    if (!common.length) { sufficient = false; break; }
  }
  const current = input.worlds.find(world => world.id === input.currentWorldId);
  const currentSignature = JSON.stringify(selected.map(id => current.values[id]));
  const currentBlock = input.worlds.filter(world => JSON.stringify(selected.map(id => world.values[id])) === currentSignature);
  const commonCurrent = input.allowedActions.filter(action => currentBlock.every(world => {
    if (!world.safe[action]) return false;
    const best = Math.max(...input.allowedActions.filter(candidate => world.safe[candidate]).map(candidate => world.utilities[candidate]));
    return best - world.utilities[action] <= input.epsilon;
  }));
  return {
    certified: true, abstained: false, privacySafe, sufficient,
    decisionAgreement: commonCurrent.includes(prediction.decision),
    disclosureCost: selected.reduce((sum, id) => sum + unitMap.get(id).cost, 0),
    reason: sufficient ? 'checked' : 'insufficient_partition',
  };
}

const evaluatedDir = path.resolve(process.argv[2] || '');
const predictionsFile = path.resolve(process.argv[3] || '');
const outputFile = path.resolve(process.argv[4] || '');
if (!evaluatedDir || !predictionsFile || !outputFile) throw new Error('usage: check_tdb_projection_predictions_v2.mjs EVALUATED_DIR PREDICTIONS OUTPUT');
const predictions = await readJsonl(predictionsFile);
const checker = new Map((await readJsonl(path.join(evaluatedDir, 'projection.checker-input.jsonl'))).map(row => [row.id, row]));
const gold = new Map((await readJsonl(path.join(evaluatedDir, 'gold.offline.jsonl'))).map(row => [row.id, row.projection]));
const rows = predictions.map(prediction => {
  if (!checker.has(prediction.id) || !gold.has(prediction.id)) throw new Error(`prediction_id_unknown:${prediction.id}`);
  const assessed = assessPrediction(prediction, checker.get(prediction.id));
  const reference = gold.get(prediction.id);
  return { id: prediction.id, prediction, assessed, gold: reference,
    disclosureExcess: assessed.disclosureCost === null || reference.disclosureCost === null ? null : assessed.disclosureCost - reference.disclosureCost };
});
const mean = values => values.length ? values.reduce((a, b) => a + Number(b), 0) / values.length : null;
const certified = rows.filter(row => row.assessed.certified);
const validExcess = certified.map(row => row.disclosureExcess).filter(Number.isFinite);
const report = {
  scope: 'development_projection_prediction_independent_check_v2',
  rows: rows.length,
  certifiedRate: mean(rows.map(row => row.assessed.certified)),
  safeAbstainRate: mean(rows.map(row => row.assessed.abstained)),
  privacySafeRate: mean(rows.map(row => row.assessed.privacySafe)),
  sufficiencyRateOverall: mean(rows.map(row => row.assessed.sufficient)),
  sufficiencyRateConditionalCertified: mean(certified.map(row => row.assessed.sufficient)),
  decisionAgreementOverall: mean(rows.map(row => row.assessed.decisionAgreement)),
  decisionAgreementConditionalCertified: mean(certified.map(row => row.assessed.decisionAgreement)),
  meanDisclosureExcessConditionalCertified: mean(validExcess),
  hardViolationCount: rows.filter(row => !row.assessed.privacySafe).length,
  legacyModelCertificationClaimCount: rows.filter(row => row.prediction.status === 'CERTIFIED').length,
  testRead: false,
  evidenceLevel: 'SYNTHETIC_FINITE_WORLD_ONLY',
  failures: rows.filter(row => row.assessed.certified && (!row.assessed.sufficient || !row.assessed.decisionAgreement || !row.assessed.privacySafe)).map(row => ({ id: row.id, reason: row.assessed.reason })),
};
await fs.writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
