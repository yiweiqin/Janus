#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(ROOT, 'experiments', 'ubuddy_www', 'webarena_verified_tasks.manifest.json');
const datasetPath = process.env.WEBARENA_VERIFIED_DATASET || 'D:/Cli-anything/benchmarks/webarena-verified/assets/dataset/webarena-verified.json';
const urls = {
  shopping_admin: process.env.WEBARENA_SHOPPING_ADMIN_URL || 'http://127.0.0.1:7780/admin',
  reddit: process.env.WEBARENA_REDDIT_URL || 'http://127.0.0.1:9999',
  gitlab: process.env.WEBARENA_GITLAB_URL || 'http://127.0.0.1:8023',
};

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function reachable(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(2500) }); return { ok: response.status < 500, status: response.status }; } catch (error) { return { ok: false, error: String(error.message || error) }; } }

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
const datasetIds = new Set(dataset.map((task) => Number(task.task_id)));
const checks = [
  { name: 'manifest_exists', ok: await exists(manifestPath) },
  { name: 'dataset_812_tasks', ok: dataset.length === 812, detail: dataset.length },
  { name: 'manifest_12_tasks', ok: manifest.tasks?.length === 12, detail: manifest.tasks?.length },
  { name: 'manifest_ids_exist', ok: manifest.tasks.every((task) => datasetIds.has(Number(task.taskId))) },
  { name: 'official_evaluator_required', ok: manifest.officialEvaluatorRequired === true },
];
for (const [site, url] of Object.entries(urls)) checks.push({ name: `site_${site}`, url, ...(await reachable(url)) });
const result = { benchmark: 'WebArena-Verified', approvalRequired: false, checks, readyForRealEpisodes: checks.every((check) => check.ok), next: 'npm run experiment:ubuddy:www:main -- --real' };
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.readyForRealEpisodes ? 0 : 1;
