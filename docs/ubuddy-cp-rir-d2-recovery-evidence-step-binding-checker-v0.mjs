#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {generateRecoveryFsmManifest} from './ubuddy-cp-rir-d2-recovery-fsm-generator-v0.mjs';

const base=new URL('.',import.meta.url);
const read=f=>JSON.parse(fs.readFileSync(typeof f==='string'&&/^[A-Za-z]:[\\/]/.test(f)?f:new URL(f,base),'utf8'));
const input=read(process.argv[2]??'./ubuddy-cp-rir-d2-recovery-evidence-step-binding-v0.input.example.json');
const schema=read('./ubuddy-cp-rir-d2-recovery-evidence-step-binding-v0.schema.json');
const validate=new Ajv2020({strict:false}).compile(schema);
const canon=z=>Array.isArray(z)?z.map(canon):z&&typeof z==='object'?Object.fromEntries(Object.keys(z).sort().map(k=>[k,canon(z[k])])):z;
const normalizeEvidence=z=>({...z,claims:[...z.claims].sort((a,b)=>[a.effectId,a.sinkId,a.kind,a.claimId].join('\0').localeCompare([b.effectId,b.sinkId,b.kind,b.claimId].join('\0')))});
const evidenceDigest=z=>crypto.createHash('sha256').update('CP-RIR-RECOVERY-EVIDENCE-V0\0'+JSON.stringify(canon(normalizeEvidence(z)))).digest('hex');
const fail=(reasonCode,extra={})=>({schemaVersion:'cp-rir/d2-recovery-evidence-step-binding-output/v0',implementationStatus:'prototype/unverified',status:'INPUT_INVALID',reasonCode,...extra});
if(!validate(input)){console.log(JSON.stringify(fail('SCHEMA_VALIDATION_FAILED',{errors:validate.errors??[]}),null,2));process.exit(0);}

let evidence,grammar,manifest,evidenceVerdict;
try{
  evidence=read(input.sources.recoveryEvidence);
  grammar=read(input.sources.recoveryGrammar);
  manifest=read(input.sources.recoveryManifest);
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./ubuddy-cp-rir-d2-recovery-evidence-checker-v0.mjs',base)),fileURLToPath(new URL(input.sources.recoveryEvidence,base))],{encoding:'utf8'});
  evidenceVerdict=JSON.parse(r.stdout);
}catch(e){console.log(JSON.stringify(fail('SOURCE_OR_SUBCHECK_FAILED'),null,2));process.exit(0);}
if(evidenceVerdict.status==='INPUT_INVALID'){console.log(JSON.stringify(fail('RECOVERY_EVIDENCE_INPUT_INVALID'),null,2));process.exit(0);}
let generated;
try{generated=generateRecoveryFsmManifest(grammar);}catch(e){console.log(JSON.stringify(fail('RECOVERY_GRAMMAR_INVALID'),null,2));process.exit(0);}
if(JSON.stringify(canon(generated))!==JSON.stringify(canon(manifest))){console.log(JSON.stringify(fail('RECOVERY_MANIFEST_NOT_DERIVED_FROM_GRAMMAR'),null,2));process.exit(0);}
if(evidence.caseAlias!==input.caseAlias){console.log(JSON.stringify(fail('EVIDENCE_CASE_ALIAS_MISMATCH'),null,2));process.exit(0);}
if(evidenceDigest(evidence)!==input.expected.evidenceDigest||generated.grammarDigest!==input.expected.grammarDigest||generated.pathSetDigest!==input.expected.pathSetDigest){console.log(JSON.stringify(fail('STEP_BINDING_ROOT_MISMATCH'),null,2));process.exit(0);}

const transitionById=new Map(grammar.transitions.map(t=>[t.transitionId,t]));
const claimById=new Map(evidence.claims.map(c=>[c.claimId,c]));
const expectedEvent={RECEIPT:'VERIFIED_RECEIPT',NEGATIVE_WITNESS:'VERIFIED_NEGATIVE_WITNESS',COMPENSATION:'COMPENSATION_VERIFIED'};
if(new Set(input.bindings.map(b=>b.claimId)).size!==input.bindings.length||input.bindings.length!==evidence.claims.length){console.log(JSON.stringify(fail('CLAIM_BINDING_COVERAGE_MISMATCH'),null,2));process.exit(0);}
for(const b of input.bindings){
  const c=claimById.get(b.claimId),path=manifest.paths.find(p=>p.pathId===b.pathId),t=transitionById.get(b.transitionId);
  if(!c||c.kind!==b.kind||c.effectId!==b.effectId||c.sinkId!==b.sinkId){console.log(JSON.stringify(fail('CLAIM_BINDING_CLAIM_MISMATCH'),null,2));process.exit(0);}
  if(!path||b.stepIndex>path.stepCount||path.transitionIds[b.stepIndex-1]!==b.transitionId||path.events[b.stepIndex-1]!==b.event||path.states[b.stepIndex-1]!==b.from||path.states[b.stepIndex]!==b.to){console.log(JSON.stringify(fail('FSM_STEP_BINDING_MISMATCH'),null,2));process.exit(0);}
  if(!t||t.event!==b.event||t.from!==b.from||t.to!==b.to||expectedEvent[b.kind]!==b.event){console.log(JSON.stringify(fail('FSM_TRANSITION_SEMANTIC_MISMATCH'),null,2));process.exit(0);}
}
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-evidence-step-binding-output/v0',implementationStatus:'prototype/unverified',status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'STEP_BINDING_VALID_RUNTIME_TRANSCRIPT_UNVERIFIED',caseAlias:input.caseAlias,bindingCount:input.bindings.length,evidenceDigest:evidenceDigest(evidence),claimIdentities:evidence.claims.map(c=>({claimId:c.claimId,kind:c.kind,effectId:c.effectId,sinkId:c.sinkId})),sourceRefs:input.sources,semanticSubcheck:'FSM_PATH_TRANSITION_REFERENTIAL_INTEGRITY',unknownReasons:['NO_RUNTIME_SINK_TRANSCRIPT','NO_INDEPENDENT_RECEIPT_REPLAY','NO_CRASH_RESTART_EXECUTION','NO_CAUSAL_OR_UTILITY_IDENTIFICATION']},null,2));
