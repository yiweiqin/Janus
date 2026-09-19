import fs from 'node:fs/promises';
import path from 'node:path';
const file = process.argv[2]; if (!file) throw new Error('usage: validate_tdb_episode.mjs JSONL');
const forbidden = ['hidden_state','fault_type','ground_truth','oracle_action','post_action_utility','test_outcome','private_prompt','private_memory','password','access_token','refresh_token','api_token','secret'];
const rows = (await fs.readFile(path.resolve(file), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const errors = [];
function walk(v, p='') { if (!v || typeof v !== 'object') return; for (const [k,x] of Object.entries(v)) { if (forbidden.includes(k)) errors.push(`${p}.${k}`); walk(x, `${p}.${k}`); } }
for (const [i,row] of rows.entries()) { walk(row, `row[${i}]`); for (const k of ['taskFamilyId','taskInstanceId','episodeId','conversation','toolTrace','eventTrace','gPlan','gExec','tdbPlan','tdbActiveTrace','tdbExec','receiverScope','decisionQuery','privacyPolicy','hardContract','labelMask']) if (!(k in row)) errors.push(`row[${i}].missing:${k}`); }
console.log(JSON.stringify({ version:'tdb-episode-contract-v1', rows: rows.length, valid: errors.length === 0, errors }, null, 2));
if (errors.length) process.exitCode = 1;
