#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { aggregateMetrics, evaluateEpisode } from './metrics.mjs';

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readRows(dir) {
  const jsonl = path.join(dir, 'episodes.jsonl');
  const json = path.join(dir, 'episodes.json');
  const file = await exists(jsonl) ? jsonl : json;
  const raw = await fs.readFile(file, 'utf8');
  return file.endsWith('.jsonl') ? raw.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : JSON.parse(raw);
}

export async function independentlyVerify(runDir) {
  const rows = await readRows(runDir);
  const recomputedRows = rows.map((row) => {
    const graph = { nodes: new Map((row.graph?.nodes || []).map((node) => [node.id, node])), edges: row.graph?.edges || [] };
    const scenario = row.scenario || { requirements: [], internalPools: {} };
    return evaluateEpisode({ scenario, method: row.method, graph, events: row.events || [], officialEvaluation: row.officialEvaluation || null });
  });
  const privateLeak = rows.some((row) => /privateMemory|private-memory-|cookie|hiddenTruth/.test(JSON.stringify(row)));
  const missingOfficial = rows.filter((row) => row.protocolOnly === false && !row.officialEvaluation).map((row) => row.episodeId);
  const malformed = rows.filter((row) => !row.episodeId || !row.method || !Array.isArray(row.events) || !Array.isArray(row.graph?.nodes)).map((row) => row.episodeId || 'unknown');
  const valid = rows.length > 0 && !privateLeak && !missingOfficial.length && !malformed.length;
  return { verifier: 'independent_raw_artifact_recompute_v2', valid, episodeCount: rows.length, privateLeak, missingOfficial, malformed, recomputedMetrics: aggregateMetrics(recomputedRows) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const runDir = path.resolve(process.argv[2] || '');
  if (!process.argv[2]) throw new Error('usage: node independentVerifier.mjs <run-dir>');
  const result = await independentlyVerify(runDir);
  await fs.writeFile(path.join(runDir, 'verification.independent.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}
