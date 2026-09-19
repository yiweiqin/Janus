#!/usr/bin/env node
// Research-only recovery mutation checker. It does not claim runtime conformance.
import fs from 'node:fs';
const file=process.argv[2]??new URL('./ubuddy-cp-rir-d2-recovery-mutation-v0.input.example.json',import.meta.url);
const x=JSON.parse(fs.readFileSync(file,'utf8'));
const out={schemaVersion:'cp-rir/d2-recovery-mutation-output/v0',implementationStatus:'prototype/unverified',inputStatus:'VALID',results:[]};
const result=(c,status,reasonCode,extra={})=>({caseAlias:c.caseAlias,mutation:c.mutation,status,reasonCode,...extra});
const requiredEvents={
  PRE_EFFECT_CRASH:['PREPARE','CRASH_BEFORE_LINEARIZATION'],
  POST_EFFECT_RECEIPT_LOSS:['COMMIT_LINEARIZED','RECEIPT_LOST'],
  LATE_VALID_RECEIPT:['RECEIPT_QUERY','VALID_RECEIPT_FOUND'],
  HALF_COMMIT:['SINK_R_COMMIT','RECOVER'],
  DUPLICATE_RECEIPT:['RECEIPT_RECEIVED','RECEIPT_DUPLICATE'],
  COMPENSATION_FAILURE:['COMPENSATION_ATTEMPT','COMPENSATION_FAILED']
};
const invalid=(c,reasonCode,extra={})=>out.results.push(result(c,'INPUT_INVALID',reasonCode,extra));
const semanticErrors=(c)=>{
  const errors=[];
  const ids=c.sinks.map(s=>s.sinkId);
  if(new Set(ids).size!==ids.length) errors.push('DUPLICATE_SINK_ID');
  for(const s of c.sinks){
    if(s.effectReality==='NOT_APPLIED' && s.effectKnowledge==='EFFECT_CONFIRMED') errors.push('NO_EFFECT_WITH_CONFIRMED_KNOWLEDGE');
    if(s.effectKnowledge==='NO_EFFECT_CONFIRMED' && s.effectReality!=='NOT_APPLIED') errors.push('NO_EFFECT_KNOWLEDGE_WITH_APPLIED_REALITY');
    // A per-sink receipt may be locally marked present/verified while the
    // aggregate cryptographic/atomicity evidence remains unverified. That
    // is intentionally handled as UNKNOWN in the mutation branch below;
    // do not turn a legitimate half-commit snapshot into malformed input.
    if(s.receiptState==='DUPLICATE' && s.dedupState!=='DUPLICATE') errors.push('DUPLICATE_RECEIPT_DEDUP_MISMATCH');
    if(s.dedupState==='DUPLICATE' && s.receiptState!=='DUPLICATE') errors.push('DUPLICATE_DEDUP_WITHOUT_DUPLICATE_RECEIPT');
  }
  for(const event of (requiredEvents[c.mutation]??[])) if(!c.events.includes(event)) errors.push(`MISSING_EVENT:${event}`);
  return [...new Set(errors)];
};
for(const c of x.cases){
  const errors=semanticErrors(c);
  if(errors.length){ invalid(c,'RECOVERY_SNAPSHOT_INCONSISTENT',{errors}); continue; }
  const sinks=c.sinks;
  if(c.mutation==='PRE_EFFECT_CRASH'){
    if(c.evidence.negativeWitness!=='PRESENT'||sinks.some(s=>s.effectReality!=='NOT_APPLIED')) out.results.push(result(c,'IN_DOUBT','NO_EFFECT_NEGATIVE_WITNESS_INSUFFICIENT',{allowedActions:['QUERY_RECEIPT','MANUAL']}));
    else out.results.push(result(c,'UNKNOWN_INPUT_NOT_PROVEN','NEGATIVE_WITNESS_NOT_INDEPENDENTLY_VERIFIED',{boundedKnowledge:'DECLARED_NO_EFFECT',allowedActions:['QUERY_RECEIPT','MANUAL'],retryDisposition:'DO_NOT_RETRY'}));
    continue;
  }
  if(c.mutation==='POST_EFFECT_RECEIPT_LOSS'){
    out.results.push(result(c,'IN_DOUBT','RECEIPT_LOST_EFFECT_POSSIBLE',{allowedActions:['QUERY_RECEIPT','COMPLETE_FORWARD','COMPENSATE','MANUAL'],retryDisposition:'DO_NOT_RETRY',effectKnowledge:'IN_DOUBT'}));
    continue;
  }
  if(c.mutation==='LATE_VALID_RECEIPT'){
    if(c.evidence.receiptCrypto==='VERIFIED'&&c.evidence.sinkAtomicity==='VERIFIED'&&sinks.every(s=>s.effectKnowledge==='EFFECT_CONFIRMED')) out.results.push(result(c,'UNKNOWN_INPUT_NOT_PROVEN','RECEIPT_CRYPTO_ATOMICITY_NOT_INDEPENDENTLY_REPLAYED',{boundedKnowledge:'DECLARED_EFFECT_CONFIRMED',allowedActions:['QUERY_RECEIPT','MANUAL'],retryDisposition:'DO_NOT_RETRY'}));
    else out.results.push(result(c,'IN_DOUBT','RECEIPT_ATOMICITY_UNVERIFIED',{allowedActions:['QUERY_RECEIPT','MANUAL'],retryDisposition:'DO_NOT_RETRY'}));
    continue;
  }
  if(c.mutation==='HALF_COMMIT'){
    out.results.push(result(c,'HARD_VIOLATION','CROSS_SINK_HALF_COMMIT',{globalSafety:'HARD_VIOLATION',recoveryPhase:'RECONCILING',publicDisposition:'IN_DOUBT',allowedActions:['QUERY_RECEIPT','COMPLETE_FORWARD','COMPENSATE','MANUAL'],perSinkKnowledge:sinks.map(s=>({sinkId:s.sinkId,effectReality:s.effectReality,effectKnowledge:s.effectKnowledge})),retryDisposition:'DO_NOT_RETRY'}));
    continue;
  }
  if(c.mutation==='DUPLICATE_RECEIPT'){
    out.results.push(result(c,'IN_DOUBT','DUPLICATE_RECEIPT_DOES_NOT_RAISE_KNOWLEDGE',{allowedActions:['QUERY_RECEIPT','MANUAL'],retryDisposition:'DO_NOT_RETRY',effectKnowledge:'EFFECT_POSSIBLE'}));
    continue;
  }
  if(c.mutation==='COMPENSATION_FAILURE'){
    out.results.push(result(c,'MANUAL_INTERVENTION','COMPENSATION_FAILED_HISTORY_RETAINED',{historicalSafety:'VIOLATED',currentInvariant:'UNKNOWN',allowedActions:['MANUAL'],retryDisposition:'DO_NOT_RETRY'}));
    continue;
  }
  out.results.push(result(c,'UNKNOWN_INPUT_NOT_PROVEN','UNRECOGNIZED_MUTATION',{allowedActions:['MANUAL']}));
}
console.log(JSON.stringify(out,null,2));
