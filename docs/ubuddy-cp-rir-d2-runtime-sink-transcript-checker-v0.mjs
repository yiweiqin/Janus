#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';

const base=new URL('.',import.meta.url);
const read=f=>JSON.parse(fs.readFileSync(typeof f==='string'&&/^[A-Za-z]:[\\/]/.test(f)?f:f instanceof URL?f:new URL(f,base),'utf8'));
const canon=z=>Array.isArray(z)?z.map(canon):z&&typeof z==='object'?Object.fromEntries(Object.keys(z).sort().map(k=>[k,canon(z[k])])):z;
const normalizeEvidence=z=>({...z,claims:[...z.claims].sort((a,b)=>[a.effectId,a.sinkId,a.kind,a.claimId].join('\0').localeCompare([b.effectId,b.sinkId,b.kind,b.claimId].join('\0')))});
const normalizeStep=z=>({...z,bindings:[...z.bindings].sort((a,b)=>[a.claimId,a.kind,a.effectId,a.sinkId,a.pathId,a.stepIndex,a.transitionId,a.event,a.from,a.to].join('\0').localeCompare([b.claimId,b.kind,b.effectId,b.sinkId,b.pathId,b.stepIndex,b.transitionId,b.event,b.from,b.to].join('\0')))});
const normalizeTranscript=z=>({...z,records:[...z.records].sort((a,b)=>[a.claimId,a.kind,a.effectId,a.sinkId,a.pathId,a.stepIndex,a.transitionId,a.recordId].join('\0').localeCompare([b.claimId,b.kind,b.effectId,b.sinkId,b.pathId,b.stepIndex,b.transitionId,b.recordId].join('\0')))});
const digest=(z,t,n=z)=>crypto.createHash('sha256').update(t+'\0'+JSON.stringify(canon(n))).digest('hex');
const fail=(reasonCode,extra={})=>({schemaVersion:'cp-rir/d2-runtime-sink-transcript-output/v0',implementationStatus:'prototype/unverified',channel:'AUDIT_ONLY',status:'INPUT_INVALID',reasonCode,...extra});
const toPath=f=>new URL(f,base).pathname.replace(/^\/(.:)/,'$1');
const runJson=(script,args)=>{const r=spawnSync(process.execPath,[toPath(script),...args.map(toPath)],{encoding:'utf8'});if(r.status!==0||!r.stdout)throw new Error('SEMANTIC_CHECKER_EXECUTION_FAILED');return JSON.parse(r.stdout);};

const input=read(process.argv[2]??'./ubuddy-cp-rir-d2-runtime-sink-transcript-v0.input.example.json');
const schema=read('./ubuddy-cp-rir-d2-runtime-sink-transcript-v0.schema.json');
const validate=new Ajv2020({strict:false}).compile(schema);
if(!validate(input)){console.log(JSON.stringify(fail('SCHEMA_VALIDATION_FAILED',{errors:validate.errors}),null,2));process.exit(0);}
if(input.realizedPathId!==null){console.log(JSON.stringify(fail('REALIZED_PATH_REQUIRES_SIGNED_RUNTIME_PROOF'),null,2));process.exit(0);}

let canonicalSuite,witness,branchManifest,recoveryManifest,evidence,step;
try{canonicalSuite=read(input.sources.canonicalSuite);witness=read(input.sources.externalWitness);branchManifest=read(input.sources.branchManifest);recoveryManifest=read(input.sources.recoveryManifest);evidence=read(input.sources.recoveryEvidence);step=read(input.sources.evidenceStepBinding);}catch(e){console.log(JSON.stringify(fail('SOURCE_READ_FAILED'),null,2));process.exit(0);}
if(evidence.caseAlias!==input.caseAlias||step.caseAlias!==input.caseAlias){console.log(JSON.stringify(fail('CASE_ALIAS_JOIN_MISMATCH'),null,2));process.exit(0);}
const sourceSchemaPairs=[['canonicalSuite','ubuddy-cp-rir-d2-canonical-suite-v0.schema.json'],['externalWitness','ubuddy-cp-rir-d2-external-branch-witness-v0.schema.json'],['branchGrammar','ubuddy-cp-rir-d2-scheduler-fault-grammar-v0.schema.json'],['branchManifest','ubuddy-cp-rir-d2-scheduler-fault-branch-manifest-v0.schema.json'],['recoveryGrammar','ubuddy-cp-rir-d2-recovery-fsm-grammar-v0.schema.json'],['recoveryManifest','ubuddy-cp-rir-d2-recovery-fsm-manifest-v0.schema.json'],['recoveryEvidence','ubuddy-cp-rir-d2-recovery-evidence-v0.schema.json'],['evidenceStepBinding','ubuddy-cp-rir-d2-recovery-evidence-step-binding-v0.schema.json']];
for(const [source,schemaName] of sourceSchemaPairs){try{const sourceValue=read(input.sources[source]);const sourceSchema=read(schemaName);const sourceAjv=new Ajv2020({strict:false,addUsedSchema:false});if(source==='externalWitness'){sourceAjv.addSchema(read('./ubuddy-cp-rir-d2-recovery-branch-closure-v2.schema.json'));}const sourceValidate=sourceAjv.compile(sourceSchema);if(!sourceValidate(sourceValue)){console.log(JSON.stringify(fail('SOURCE_SCHEMA_VALIDATION_FAILED',{source}),null,2));process.exit(0);}}catch(e){console.log(JSON.stringify(fail('SOURCE_SCHEMA_VALIDATION_FAILED',{source}),null,2));process.exit(0);}}
const cc=canonicalSuite.cases.find(c=>c.caseAlias===input.caseAlias),wc=witness.cases.find(c=>c.caseAlias===input.caseAlias);
if(!cc||!wc){console.log(JSON.stringify(fail('CASE_ALIAS_NOT_FOUND'),null,2));process.exit(0);}

let canonicalVerdict,branchVerdict,fsmVerdict,stepVerdict;
try{
  canonicalVerdict=runJson('./ubuddy-cp-rir-d2-canonical-reducer-v0.mjs',[input.sources.canonicalSuite]);
  branchVerdict=runJson('./ubuddy-cp-rir-d2-external-branch-closure-v0.mjs',[input.sources.externalWitness,input.sources.canonicalSuite,input.sources.branchManifest,input.sources.branchGrammar]);
  fsmVerdict=runJson('./ubuddy-cp-rir-d2-recovery-fsm-closure-checker-v0.mjs',[input.sources.recoveryGrammar,input.sources.recoveryManifest]);
  stepVerdict=runJson('./ubuddy-cp-rir-d2-recovery-evidence-step-binding-checker-v0.mjs',[input.sources.evidenceStepBinding]);
}catch(e){console.log(JSON.stringify(fail('SEMANTIC_CHECKER_EXECUTION_FAILED'),null,2));process.exit(0);}
const canonicalCaseVerdict=canonicalVerdict.results?.find(x=>x.caseAlias===input.caseAlias),branchCaseVerdict=branchVerdict.results?.find(x=>x.caseAlias===input.caseAlias);
if(!canonicalCaseVerdict||canonicalVerdict.inputStatus!=='VALID'||['INPUT_INVALID','WITNESS_INVALID'].includes(canonicalCaseVerdict.status)||!branchCaseVerdict||branchVerdict.inputStatus!=='VALID'||['INPUT_INVALID','WITNESS_INVALID'].includes(branchCaseVerdict.status)||fsmVerdict.status==='INPUT_INVALID'||stepVerdict.status==='INPUT_INVALID'){
  console.log(JSON.stringify(fail('SEMANTIC_SUBCHECK_FAILED'),null,2));process.exit(0);
}

const actualRoots={
  canonicalCaseDigest:digest(cc,'CP-RIR-CANONICAL-CASE-V2'),
  externalWitnessCaseDigest:digest(wc,'CP-RIR-EXTERNAL-CLOSURE-WITNESS-V0'),
  branchGrammarDigest:branchVerdict.grammarDigest,
  branchManifestDigest:digest(branchManifest,'CP-RIR-SCHEDULER-FAULT-BRANCH-MANIFEST-V0'),
  recoveryGrammarDigest:fsmVerdict.grammarDigest,
  recoveryPathSetDigest:fsmVerdict.pathSetDigest,
  evidenceDigest:digest(evidence,'CP-RIR-RECOVERY-EVIDENCE-V0',normalizeEvidence(evidence)),
  evidenceStepBindingDigest:digest(step,'CP-RIR-RECOVERY-EVIDENCE-STEP-BINDING-V0',normalizeStep(step))
};
for(const [k,v] of Object.entries(input.expected))if(actualRoots[k]!==v){console.log(JSON.stringify(fail('TRANSCRIPT_ROOT_MISMATCH',{mismatchField:k}),null,2));process.exit(0);}
if(stepVerdict.evidenceDigest!==actualRoots.evidenceDigest){console.log(JSON.stringify(fail('TRANSCRIPT_STEP_EVIDENCE_JOIN_MISMATCH'),null,2));process.exit(0);}

const branches=new Map(wc.branches.map(b=>[b.branchId,b])),claims=new Map(evidence.claims.map(c=>[c.claimId,c])),bindings=new Map(step.bindings.map(b=>[b.claimId,b])),paths=new Map(recoveryManifest.paths.map(p=>[p.pathId,p]));
const authorities=new Map(wc.authoritativeSinks.map(a=>[a.sinkId,a]));
if(new Set(input.records.map(r=>r.recordId)).size!==input.records.length){console.log(JSON.stringify(fail('TRANSCRIPT_DUPLICATE_RECORD_ID'),null,2));process.exit(0);}
if(new Set(input.records.map(r=>r.claimId)).size!==input.records.length||input.records.length!==claims.size){console.log(JSON.stringify(fail('TRANSCRIPT_COVERAGE_MISMATCH'),null,2));process.exit(0);}
if(new Set(input.records.map(r=>r.pathId)).size!==input.records.length){console.log(JSON.stringify(fail('TRANSCRIPT_DUPLICATE_PATH_ID'),null,2));process.exit(0);}
for(const r of input.records){
  const c=claims.get(r.claimId),b=bindings.get(r.claimId),br=branches.get(r.branchId),p=paths.get(r.pathId),a=authorities.get(r.authorityRef),canonicalStep=cc.concrete.transitions[r.canonicalStepIndex];
  if(!c||!b||!br||!p||!a||!canonicalStep){console.log(JSON.stringify(fail('TRANSCRIPT_REFERENT_NOT_FOUND'),null,2));process.exit(0);}
  if(r.kind!==c.kind||r.effectId!==c.effectId||r.sinkId!==c.sinkId||r.effectId!==b.effectId||r.sinkId!==b.sinkId||r.pathId!==b.pathId||r.stepIndex!==b.stepIndex||r.transitionId!==b.transitionId||r.declaredEvent!==b.event||r.declaredFrom!==b.from||r.declaredTo!==b.to){console.log(JSON.stringify(fail('TRANSCRIPT_CLAIM_STEP_JOIN_MISMATCH'),null,2));process.exit(0);}
  if(p.transitionIds[r.stepIndex-1]!==r.transitionId||p.events[r.stepIndex-1]!==r.declaredEvent||p.states[r.stepIndex-1]!==r.declaredFrom||p.states[r.stepIndex]!==r.declaredTo){console.log(JSON.stringify(fail('TRANSCRIPT_FSM_PATH_JOIN_MISMATCH'),null,2));process.exit(0);}
  if(r.schedulerChoice!==br.schedulerChoice||r.faultEvent!==br.faultEvent||br.canonicalFact.canonicalStepIndex!==r.canonicalStepIndex||br.canonicalFact.event!==canonicalStep.event||br.canonicalFact.effectId!==r.effectId||br.canonicalFact.sinkId!==r.sinkId||br.canonicalFact.resourceId!==canonicalStep.effect.resourceId||br.canonicalFact.multiplicity!==canonicalStep.effect.multiplicity||br.canonicalFact.versionDelta!==canonicalStep.effect.versionDelta){console.log(JSON.stringify(fail('TRANSCRIPT_CANONICAL_BRANCH_JOIN_MISMATCH'),null,2));process.exit(0);}
  if(br.authorityRef!==r.authorityRef||a.sinkId!==r.sinkId||a.resourceId!==br.canonicalFact.resourceId||r.epoch!==a.epoch||r.generation!==a.generation||r.versionBefore!==a.versionBefore||r.receiptStateAtBranch!==br.receiptClaim.state){console.log(JSON.stringify(fail('TRANSCRIPT_AUTHORITY_JOIN_MISMATCH'),null,2));process.exit(0);}
  if(r.branchVersionAfter!==br.sinkAfter.versionAfter){console.log(JSON.stringify(fail('TRANSCRIPT_BRANCH_VERSION_JOIN_MISMATCH'),null,2));process.exit(0);}
}
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-runtime-sink-transcript-output/v0',implementationStatus:'prototype/unverified',channel:'AUDIT_ONLY',status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'HYPOTHETICAL_PATH_CATALOG_REFERENTIAL_JOIN_VALID_RUNTIME_REPLAY_UNVERIFIED',caseAlias:input.caseAlias,pathSemantics:input.pathSemantics,realizedPathId:null,recordCount:input.records.length,transcriptDigest:digest(normalizeTranscript(input),'CP-RIR-D2-RUNTIME-SINK-TRANSCRIPT-V0'),verifiedEvent:'UNKNOWN_UNVERIFIED',semanticSubchecks:{canonical:canonicalCaseVerdict.status,branch:branchCaseVerdict.status,fsm:fsmVerdict.status,evidenceStepBinding:stepVerdict.status,catalogJoin:'VALID'},utilityStatus:'NOT_EVALUATED',causalScope:'NOT_EVALUATED',unknownReasons:['MUTUALLY_EXCLUSIVE_PATHS_NOT_REALIZED','NO_AUTHORITATIVE_SINK_READ','NO_RUNTIME_REPLAY','NO_RECEIPT_SIGNATURE_VERIFICATION','NO_PRE_POST_LINEARIZATION_PROOF','NO_CRASH_RESTART_EXECUTION']},null,2));
