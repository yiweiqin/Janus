import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {normalizeTaskDependencyBundle,taskDependencyBundleTraceFromEvents,taskDependencyBundleReplaySnapshot,taskDependencyBundleHash} from '../../../src/shared/contracts/uBuddyTaskDependencyBundle.js';
const [input,output]=process.argv.slice(2);
if(!input||!output) throw Error('usage: bind_executed_pair_tdb.mjs INPUT OUTPUT');
const rows=(await fs.readFile(input,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const mapping={result_submitted:'task_published',controlled_repair_applied:'version_changed',episode_closed:'completed'};
for(const row of rows){
 const edge=row.gPlan.edges[0];
 row.collectionAudit.originalEventTraceHash=row.traceHash;
 row.tdbPlan=normalizeTaskDependencyBundle({taskId:row.taskInstanceId,edgeId:edge.edgeId,sourceNodeId:edge.from,targetNodeId:edge.to,sourceAgentId:edge.from,targetAgentId:edge.to,relationType:edge.relationType,observedAt:row.eventTrace[0].occurredAt});
 const events=row.eventTrace.map((e,i)=>({id:e.id,created_at:e.occurredAt,event_type:mapping[e.eventKind]||e.eventKind,sequence:i+1,payload_json:e.payload}));
 row.tdbActiveTrace=taskDependencyBundleTraceFromEvents(events,row.tdbPlan);
 row.tdbExec=row.tdbActiveTrace.at(-1)||row.tdbPlan;
 row.replaySnapshot=taskDependencyBundleReplaySnapshot(events,row.tdbPlan);
 assert.equal(taskDependencyBundleHash(row.tdbExec),row.replaySnapshot.finalHash);
 assert.deepEqual(row.replaySnapshot,taskDependencyBundleReplaySnapshot(events,row.tdbPlan));
 row.replayToken=row.replaySnapshot.replayToken;row.traceHash=row.replaySnapshot.traceHash;
 row.collectionAudit.tdbEventMapping=mapping;
 row.collectionAudit.tdbRuntimeEvents=events;
 row.collectionAudit.replayVerified=true;
 row.collectionAudit.tdbNote='Runtime UNKNOWN dimensions are observed-state placeholders, not dependency gold.';
}
await fs.writeFile(output,rows.map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({rows:rows.length,replayVerified:true,sha256:crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex')}));
