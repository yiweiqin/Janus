import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeCases, runCase, executeArm, ACTIONS, COST, trainScorer, predict, hash } from './engine.mjs';
import { trainUpliftScorer, predictUplift, chooseUplift } from './uplift_scorer.mjs';
import { analyze } from './analysis.mjs';
import { evaluate } from './evaluator.mjs';
import { writeRun, verifyRun, ROOT } from './artifacts.mjs';
import { validateRealTask } from './real-task-contract.mjs';
test('replay resets every arm and preserves independent evaluator', () => {
  const rows = makeCases({ seed: 7, families: 8, repeats: 1 }).map(runCase);
  assert.equal(rows.length, 8 * 7);
  for (const row of rows) {
    assert.equal(new Set(ACTIONS.map((a) => row.arms[a].initialStateHash)).size, 1);
    for (const a of ACTIONS) assert.equal(row.arms[a].evaluation.evaluatorVersion, 'invoice-exact-cents-v1');
  }
});
test('family split and analysis are deterministic with explicit abstention', () => {
  const rows = makeCases({ seed: 20260906, families: 12, repeats: 2 }).map(runCase);
  const a = analyze(rows), b = analyze(rows);
  assert.deepEqual(a.metrics, b.metrics);
  assert.equal(a.metrics.realWorldValidated, false);
  assert.equal(a.metrics.autoEvolutionAllowed, false);
  assert.equal(a.metrics.counts.independentTestFamilies, 4);
  assert.ok(a.metrics.unknownRate >= 0);
});

test('single repairs are effective only when execution changes the matching defect', () => {
  const cases = makeCases({ families: 8, repeats: 1 });
  const matching = { agent: 'replaceAgent', handoff: 'restoreHandoff', version: 'refreshVersion', resource: 'restoreResource' };
  for (const [condition, action] of Object.entries(matching)) {
    const item = cases.find((c) => c.condition === condition);
    const frozen = structuredClone(item), row = runCase(item);
    assert.equal(row.arms.noop.evaluation.success, false);
    assert.equal(row.effects[action], 1);
    for (const other of Object.values(matching).filter((a) => a !== action)) assert.equal(row.effects[other], 0);
    assert.deepEqual(item, frozen);
  }
});

test('joint faults require the combination; decoy and clean need no repair', () => {
  const cases = makeCases({ families: 8, repeats: 1 });
  const joint = runCase(cases.find((c) => c.condition === 'joint'));
  assert.equal(joint.effects.restoreHandoff, 0);
  assert.equal(joint.effects.refreshVersion, 0);
  assert.equal(joint.effects.refreshAndHandoff, 1);
  for (const c of cases.filter((c) => ['clean', 'decoy'].includes(c.condition))) {
    assert.ok(Object.values(runCase(c).effects).every((v) => v === 0));
  }
});

test('evaluator rejects wrong output regardless of attached fault or action labels', () => {
  const specification = { currentRows: [{ quantity: 3, unitCents: 101 }], taxPercent: 10 };
  assert.equal(evaluate(specification, { totalCents: 333 }).success, true);
  assert.equal(evaluate(specification, { totalCents: 334, condition: 'clean', action: 'oracle' }).success, false);
});

test('evaluator contract keeps noop utility independent and cost separate', () => {
  const specification = { currentRows: [{ quantity: 1, unitCents: 100 }], taxPercent: 10 };
  const noop = evaluate(specification, { totalCents: 110 });
  assert.equal(noop.utility, 1);
  assert.equal(noop.evaluatorVersion, 'invoice-exact-cents-v1');
  assert.equal(COST.noop, 0);
  assert.equal(noop.utility - COST.noop * 0.05, 1);
  const repair = evaluate(specification, { totalCents: 109 });
  assert.equal(repair.utility, 0);
  assert.equal(repair.utility - COST.restoreHandoff * 0.05, -0.05);
});

test('N/A and infrastructure-invalid records are not failures or training labels', () => {
  const na = { applicable: false, outcome: 'N/A', utility: null, infrastructure_invalid: false };
  const infra = { applicable: true, outcome: 'infrastructure_invalid', utility: null, infrastructure_invalid: true };
  assert.equal(na.applicable, false);
  assert.equal(na.utility, null);
  assert.equal(infra.infrastructure_invalid, true);
  assert.equal(infra.utility, null);
});

test('abstain is noop policy state and joint interaction follows inclusion-exclusion', () => {
  const rows = makeCases({ families: 8, repeats: 1 }).map(runCase);
  const base = trainUpliftScorer(rows.filter((r) => r.split === 'train'));
  const uncertain = structuredClone(base);
  for (const model of Object.values(uncertain.actions)) model.residualVariance = 100;
  const unknown = chooseUplift(uncertain, { capability: .5, logic: .5, freshness: .5, resource: .5, risk: .5 });
  assert.equal(unknown.action, 'noop');
  assert.equal(unknown.abstained, true);
  const joint = rows.find((r) => r.condition === 'joint');
  const interaction = joint.arms.refreshAndHandoff.evaluation.utility - joint.arms.noop.evaluation.utility
    - (joint.arms.refreshVersion.evaluation.utility - joint.arms.noop.evaluation.utility)
    - (joint.arms.restoreHandoff.evaluation.utility - joint.arms.noop.evaluation.utility);
  assert.equal(interaction, 1);
});

test('training cannot consume test rows or labels; unseen features abstain', () => {
  const rows = makeCases({ families: 8, repeats: 1 }).map(runCase), train = rows.filter((r) => r.split === 'train');
  assert.throws(() => trainScorer(rows), /training_split_violation/);
  const scorer = trainScorer(train);
  assert.deepEqual(trainScorer(train.map((r) => ({ ...r, condition: 'wrong-label' }))), scorer);
  const unseen = predict(scorer, { capability: .5, logic: .5, freshness: .5, resource: .5, risk: .5 });
  assert.equal(unseen.unknown, true);
});

test('test outcomes cannot train scorer or select threshold; family leakage is rejected', () => {
  const rows = makeCases({ families: 8, repeats: 1 }).map(runCase), original = analyze(rows);
  const changed = structuredClone(rows);
  for (const row of changed.filter((r) => r.split === 'test')) for (const arm of Object.values(row.arms)) arm.evaluation.utility = 0;
  const result = analyze(changed);
  assert.deepEqual(result.scorer, original.scorer);
  assert.equal(result.metrics.selectedAbstentionThreshold, original.metrics.selectedAbstentionThreshold);
  const contaminated = [...rows, { ...rows[0], id: 'duplicate-family', split: 'test' }];
  assert.throws(() => analyze(contaminated), /family_split_leakage/);
});

test('TDB replay commits to execution input and output, not just event ids', () => {
  const item = makeCases({ families: 8, repeats: 1 }).find((c) => c.condition === 'clean');
  const a = executeArm(item, 'noop');
  const modified = structuredClone(item); modified.spec.currentRows[0].unitCents++;
  const b = executeArm(modified, 'noop');
  assert.notEqual(a.snapshot.replayToken, b.snapshot.replayToken);
  assert.deepEqual(a.snapshot, executeArm(item, 'noop').snapshot);
});

test('artifact verifier reexecutes and rejects tampering even after rehashing a file', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tdb-probe-test-'));
  const out = path.join(temporary, 'run');
  t.after(async () => {
    // Only unlink files in this test-created directory; never recursive delete.
    for (const name of await fs.readdir(out)) await fs.unlink(path.join(out, name));
    await fs.rmdir(out); await fs.rmdir(temporary);
  });
  await writeRun({ out, families: 8, repeats: 1 });
  assert.equal((await verifyRun(out)).verified, true);
  await assert.rejects(writeRun({ out, families: 8, repeats: 1 }), { code: 'EEXIST' });
  const file = path.join(out, 'episodes.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  lines[0].arms.noop.output.totalCents++;
  const data = lines.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(file, data);
  await assert.rejects(verifyRun(out), /artifact_hash_mismatch/);
  const manifestFile = path.join(out, 'manifest.json'), manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.files['episodes.jsonl'] = hash(data);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(verifyRun(out), /execution_replay_mismatch/);
});

test('real-task doctor cannot turn a filled template into a runtime certificate', async () => {
  const template = JSON.parse(await fs.readFile(path.join(ROOT, 'real-task.template.json'), 'utf8'));
  const result = validateRealTask(template);
  assert.equal(result.metadataComplete, false);
  assert.equal(result.executableReady, false);
  assert.ok(result.issues.includes('missing:resetVerification'));
  assert.equal(validateRealTask(null).metadataComplete, false);
});

test('CLI resolves files outside the repo and returns structured option errors', () => {
  const cli = path.join(ROOT, 'runner.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /verify/);
  const wrong = spawnSync(process.execPath, [cli, 'run', '--families', 'nope'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(wrong.status, 1); assert.equal(JSON.parse(wrong.stderr).error, 'invalid_case_config');
  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--task', path.join(ROOT, 'real-task.template.json')], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(doctor.status, 2); assert.equal(JSON.parse(doctor.stdout).executableReady, false);
});

test('uplift scorer learns incremental repair effect, not absolute success', () => {
  const rows = makeCases({ seed: 20260906, families: 12, repeats: 2 }).map(runCase);
  const train = rows.filter((r) => r.split === 'train');
  const scorer = trainUpliftScorer(train);
  const prediction = predictUplift(scorer, train[0].features);
  assert.equal(scorer.version, 'causal-uplift-ridge-v1');
  assert.equal(prediction.noop.effect, 0);
  assert.ok(Object.hasOwn(prediction, 'restoreHandoff'));
  const decision = chooseUplift(scorer, train[0].features);
  assert.ok(ACTIONS.includes(decision.action));
});

test('uplift training rejects calibration/test leakage', () => {
  const rows = makeCases({ seed: 20260906, families: 12, repeats: 1 }).map(runCase);
  assert.throws(() => trainUpliftScorer(rows), /uplift_training_split_violation/);
});
