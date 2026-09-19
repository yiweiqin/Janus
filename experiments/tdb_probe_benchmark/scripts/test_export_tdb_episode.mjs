import assert from 'node:assert/strict';
import { buildTdbTrainingEpisode } from '../../../cloud/src/modules/collaboration/stateGraph.mjs';
const queries=[];
const pool={query:async(sql,params)=>{queries.push(sql); if(sql.includes('agent_delegations')) return {rows:[{id:'d1',requester_user_id:'u1',recipient_user_id:'u2',task_run_id:null,metadata_json:{}}]}; return {rows:[]};}};
const result=await buildTdbTrainingEpisode(pool,{viewerUserId:'u1',delegationId:'d1'});
assert.equal(result.schemaVersion,'tdb-episode-contract-v1'); assert.deepEqual(result.agentPair,['u1','u2']); assert.ok(Array.isArray(result.conversation)); console.log('episode export contract ok');
