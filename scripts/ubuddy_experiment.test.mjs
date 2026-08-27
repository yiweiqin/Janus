import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const runner = path.join(repoRoot, 'scripts', 'ubuddy_experiment.mjs');

test('offline pilot writes the planned balanced artifacts', async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ubuddy-experiment-'));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(process.execPath, [runner, 'pilot', '--run-dir', runDir], { cwd: repoRoot });
  const payload = JSON.parse(stdout);
  assert.equal(payload.summary.episodeCounts.A, 30);
  assert.equal(payload.summary.episodeCounts.B, 144);
  assert.equal(payload.summary.episodeCounts.C, 256);
  assert.equal(payload.summary.episodeCounts.D, 144);
  assert.equal(payload.summary.episodeCounts.DFirstRound, 24);
  assert.equal(payload.summary.episodeCounts.DSecondRound, 120);
  assert.equal(payload.summary.metrics.A.passRate, 1);
  assert.equal(payload.summary.metrics.A.privateLeakCount, 0);
  assert.equal(payload.summary.evidenceLevel.fullTaskImprovementProven, false);

  const expectedFiles = [
    'config.json', 'source-manifest.json', 'prototype-regression.json', 'prototype-regression.log',
    'A-architecture.jsonl', 'B-state-decision.jsonl', 'C-attribution.jsonl',
    'D-first-round.jsonl', 'D-joint-evolution.jsonl', 'tasks.jsonl', 'candidate_queries.jsonl',
    'selection_snapshots.jsonl', 'traces.jsonl', 'attributions.jsonl', 'evolution_updates.jsonl',
    'metrics.json', 'errors.jsonl', 'model-calibration-summary.json', 'summary.json', 'report.md', 'change-manifest.md',
  ];
  for (const filename of expectedFiles) await fs.access(path.join(runDir, filename));
});

test('analyze recomputes metrics without rerunning episodes', async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ubuddy-analyze-'));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [runner, 'pilot', '--run-dir', runDir], { cwd: repoRoot });
  const { stdout } = await execFileAsync(process.execPath, [runner, 'analyze', '--run-dir', runDir], { cwd: repoRoot });
  const payload = JSON.parse(stdout);
  assert.equal(payload.metrics.B.B3_ours.n, 36);
  assert.equal(payload.metrics.C.C3_dual_layer.n, 64);
  assert.equal(payload.metrics.D.D3_joint_gated.n, 24);
  await fs.access(path.join(runDir, 'metrics.json'));
});

test('paper command refuses to claim readiness without persistence prerequisites', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [runner, 'paper'], { cwd: repoRoot, env: { ...process.env, DATABASE_URL: '', EVOLUTION_WORKER_DATABASE_URL: '' } }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.paperScaleGate, false);
      assert.equal(payload.checks.srcShared, true);
      return true;
    },
  );
});

test('live model calibration is blocked before API calls when pricing is unknown', async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ubuddy-cost-gate-'));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [runner, 'pilot', '--run-dir', runDir, '--live-model'], { cwd: repoRoot, env: { ...process.env, UBUDDY_INPUT_CNY_PER_MTOK: '', UBUDDY_OUTPUT_CNY_PER_MTOK: '' } });
  const summary = JSON.parse(await fs.readFile(path.join(runDir, 'model-calibration-summary.json'), 'utf8'));
  assert.equal(summary.completed, 0);
  assert.match(summary.blockedReason, /pricing_not_configured/);
});

test('live model calibration can explicitly skip cost estimation while remaining bounded', async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ubuddy-ignore-cost-'));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [runner, 'pilot', '--run-dir', runDir, '--live-model', '--ignore-cost'], { cwd: repoRoot, env: { ...process.env, OPENAI_BASE_URL: '', CRS_OAI_KEY: '', OPENAI_API_KEY: '', UBUDDY_INPUT_CNY_PER_MTOK: '', UBUDDY_OUTPUT_CNY_PER_MTOK: '' } });
  const summary = JSON.parse(await fs.readFile(path.join(runDir, 'model-calibration-summary.json'), 'utf8'));
  assert.equal(summary.attempted, 0);
  assert.equal(summary.blockedReason, 'model_credentials_missing');
});
