import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const runner = path.join(repoRoot, 'scripts', 'ubuddy_www_experiment.mjs');

test('WWW canary writes a protocol-complete artifact set in mock mode', async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ubuddy-www-canary-'));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [runner, 'canary', '--run-dir', runDir, '--allow-mock'], { cwd: repoRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.episodes, 4);
  const metrics = JSON.parse(await fs.readFile(path.join(runDir, 'metrics.json'), 'utf8'));
  assert.equal(metrics.episodeCount, 4);
  assert.equal(metrics.byMethod.M3_ours.n, 1);
  assert.equal(metrics.byMethod.M3_ours.protocolPassRate, 1);
  const verification = JSON.parse(await fs.readFile(path.join(runDir, 'verification.json'), 'utf8'));
  assert.equal(verification.protocolOnly, true);
  assert.equal(verification.allChecksPassed, true);
  for (const file of ['episodes.jsonl', 'events.jsonl', 'official_evaluations.jsonl', 'attributions.jsonl', 'evolution_updates.jsonl']) await fs.access(path.join(runDir, file));
});

test('WWW main refuses protocol-only mode unless mock mode is explicit', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [runner, 'main'], { cwd: repoRoot, env: { ...process.env, UBUDDY_WWW_BRIDGE_MODE: 'mock' } }),
    (error) => /requires UBUDDY_WWW_BRIDGE_MODE=real/.test(String(error.stderr || error.stdout || error.message)),
  );
});

test('WWW schema prevents private metadata from entering public checkpoints', async () => {
  const { redactPrivateMetadata } = await import('../experiments/ubuddy_www/schema.mjs');
  const result = redactPrivateMetadata({ summary: 'done', privateBody: 'secret', localPath: 'C:/secret', resultRef: 'r1' });
  assert.deepEqual(result, { summary: 'done', resultRef: 'r1' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
