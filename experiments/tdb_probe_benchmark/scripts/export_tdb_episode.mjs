#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { buildTdbTrainingEpisode } from '../../../cloud/src/modules/collaboration/stateGraph.mjs';

const [delegationId, outputFile] = process.argv.slice(2);
if (!delegationId || !outputFile) throw new Error('usage: export_tdb_episode.mjs DELEGATION_ID OUTPUT_JSONL');
const databaseUrl = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL || '';
const viewerUserId = process.env.TDB_VIEWER_USER_ID || '';
if (!databaseUrl || !viewerUserId) throw new Error('DATABASE_URL and TDB_VIEWER_USER_ID are required');
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const episode = await buildTdbTrainingEpisode(pool, {
    viewerUserId, delegationId,
    taskFamilyId: process.env.TDB_TASK_FAMILY_ID || '',
    taskInstanceId: process.env.TDB_TASK_INSTANCE_ID || '',
    decisionQuery: process.env.TDB_DECISION_QUERY || 'accept_result',
  });
  await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await fs.writeFile(path.resolve(outputFile), JSON.stringify(episode) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: true, output: path.resolve(outputFile), episodeId: episode.episodeId, conversation: episode.conversation.length, events: episode.eventTrace.length, replayToken: episode.replayToken, traceHash: episode.traceHash }, null, 2));
} finally { await pool.end(); }
