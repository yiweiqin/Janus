import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './multitask_reference.mjs';

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = process.argv[2];
if (!directory) throw new Error('out_required');
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
const payload = await fs.readFile(path.join(directory, 'multitask.json'), 'utf8');
if (sha(payload) !== manifest.fileHash) throw new Error('artifact_hash_mismatch');
const replay = run(manifest.config);
if (sha(replay.rows) !== manifest.inputHash) throw new Error('input_replay_mismatch');
if (JSON.stringify(replay) !== JSON.stringify(JSON.parse(payload))) throw new Error('result_replay_mismatch');
console.log(JSON.stringify({ verified: true, evidenceLevel: replay.evidenceLevel, counts: replay.counts, metrics: replay.metrics }, null, 2));


