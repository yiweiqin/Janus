#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import {generateRecoveryFsmManifest} from './ubuddy-cp-rir-d2-recovery-fsm-generator-v0.mjs';
import {generateBranchManifest} from './ubuddy-cp-rir-d2-scheduler-fault-branch-generator-v0.mjs';

const base=new URL('.',import.meta.url);
const read=f=>JSON.parse(fs.readFileSync(typeof f==='string'&&/^[A-Za-z]:[\\/]/.test(f)?f:f instanceof URL?f:new URL(f,base),'utf8'));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v,tag)=>crypto.createHash('sha256').update(`${tag}\0${JSON.stringify(canonical(v))}`).digest('hex');
const normalizeStepBinding=z=>({...z,bindings:[...z.bindings].sort((a,b)=>[a.claimId,a.kind,a.effectId,a.sinkId,a.pathId,a.stepIndex,a.transitionId,a.event,a.from,a.to].join('\0').localeCompare([b.claimId,b.kind,b.effectId,b.sinkId,b.pathId,b.stepIndex,b.transitionId,b.event,b.from,b.to].join('\0')))});
const normalizeTranscript=z=>({...z,records:[...z.records].sort((a,b)=>[a.claimId,a.kind,a.effectId,a.sinkId,a.pathId,a.stepIndex,a.transitionId,a.recordId].join('\0').localeCompare([b.claimId,b.kind,b.effectId,b.sinkId,b.pathId,b.stepIndex,b.transitionId,b.recordId].join('\0')))});
const input=read(process.argv[2]??new URL('./ubuddy-cp-rir-d2-recovery-fsm-binding-v0.input.example.json',base));
const schema=read(new URL('./ubuddy-cp-rir-d2-recovery-fsm-binding-v0.schema.json',base));
const validate=new Ajv2020({strict:false}).compile(schema);
const fail=(reasonCode,extra={})=>({schemaVersion:'cp-rir/d2-recovery-fsm-binding-output/v0',implementationStatus:'prototype/unverified',status:'INPUT_INVALID',reasonCode,...extra});
if(!validate(input)){console.log(JSON.stringify(fail('SCHEMA_VALIDATION_FAILED',{errors:validate.errors}),null,2));process.exit(0);}

let canonicalSuite,witness,branchGrammar,branchManifest,recoveryGrammar,recoveryManifest,recoveryEvidence,evidenceStepBinding,runtimeTranscript;
try{
  canonicalSuite=read(input.sources.canonicalSuite);witness=read(input.sources.externalWitness);branchGrammar=read(input.sources.branchGrammar);branchManifest=read(input.sources.branchManifest);recoveryGrammar=read(input.sources.recoveryGrammar);recoveryManifest=read(input.sources.recoveryManifest);recoveryEvidence=read(input.sources.recoveryEvidence);evidenceStepBinding=read(input.sources.evidenceStepBinding);runtimeTranscript=read(input.sources.runtimeTranscript);
}catch(e){console.log(JSON.stringify(fail('SOURCE_READ_FAILED'),null,2));process.exit(0);}
const cc=canonicalSuite.cases.find(c=>c.caseAlias===input.caseAlias),wc=witness.cases.find(c=>c.caseAlias===input.caseAlias);
if(!cc||!wc){console.log(JSON.stringify(fail('CASE_ALIAS_NOT_FOUND'),null,2));process.exit(0);}

const runJson=(script,args)=>{const r=spawnSync(process.execPath,[new URL(script,base).pathname.replace(/^\/(.:)/,'$1'),...args.map(x=>new URL(x,base).pathname.replace(/^\/(.:)/,'$1'))],{encoding:'utf8'});if(r.status!==0||!r.stdout)throw new Error('SEMANTIC_CHECKER_EXECUTION_FAILED');return JSON.parse(r.stdout);};
let canonicalVerdict,branchVerdict,fsmVerdict,evidenceVerdict,stepBindingVerdict,runtimeVerdict;
try{
  canonicalVerdict=runJson('./ubuddy-cp-rir-d2-canonical-reducer-v0.mjs',[input.sources.canonicalSuite]);
  branchVerdict=runJson('./ubuddy-cp-rir-d2-external-branch-closure-v0.mjs',[input.sources.externalWitness,input.sources.canonicalSuite,input.sources.branchManifest,input.sources.branchGrammar]);
  fsmVerdict=runJson('./ubuddy-cp-rir-d2-recovery-fsm-closure-checker-v0.mjs',[input.sources.recoveryGrammar,input.sources.recoveryManifest]);
  evidenceVerdict=runJson('./ubuddy-cp-rir-d2-recovery-evidence-checker-v0.mjs',[input.sources.recoveryEvidence]);
  stepBindingVerdict=runJson('./ubuddy-cp-rir-d2-recovery-evidence-step-binding-checker-v0.mjs',[input.sources.evidenceStepBinding]);
  runtimeVerdict=runJson('./ubuddy-cp-rir-d2-runtime-sink-transcript-checker-v0.mjs',[input.sources.runtimeTranscript]);
}catch(e){console.log(JSON.stringify(fail('SEMANTIC_CHECKER_EXECUTION_FAILED'),null,2));process.exit(0);}

const canonicalCaseVerdict=canonicalVerdict.results?.find(x=>x.caseAlias===input.caseAlias),branchCaseVerdict=branchVerdict.results?.find(x=>x.caseAlias===input.caseAlias);
if(!canonicalCaseVerdict||canonicalVerdict.inputStatus!=='VALID'||['INPUT_INVALID','WITNESS_INVALID'].includes(canonicalCaseVerdict.status)||!branchCaseVerdict||branchVerdict.inputStatus!=='VALID'||['INPUT_INVALID','WITNESS_INVALID'].includes(branchCaseVerdict.status)||fsmVerdict.status==='INPUT_INVALID'||stepBindingVerdict.status==='INPUT_INVALID'){console.log(JSON.stringify(fail('SEMANTIC_SUBCHECK_FAILED'),null,2));process.exit(0);}
if(runtimeVerdict.status==='INPUT_INVALID'){console.log(JSON.stringify(fail('RUNTIME_TRANSCRIPT_INPUT_INVALID',{runtimeReasonCode:runtimeVerdict.reasonCode}),null,2));process.exit(0);}
if(evidenceVerdict.status==='INPUT_INVALID'){console.log(JSON.stringify(fail('RECOVERY_EVIDENCE_INPUT_INVALID',{evidenceReasonCode:evidenceVerdict.reasonCode}),null,2));process.exit(0);}
if(recoveryEvidence.caseAlias!==input.caseAlias||evidenceStepBinding.caseAlias!==input.caseAlias){console.log(JSON.stringify(fail('RECOVERY_EVIDENCE_CASE_ALIAS_MISMATCH'),null,2));process.exit(0);}
if(evidenceStepBinding.sources?.recoveryEvidence!==input.sources.recoveryEvidence||evidenceStepBinding.sources?.recoveryGrammar!==input.sources.recoveryGrammar||evidenceStepBinding.sources?.recoveryManifest!==input.sources.recoveryManifest||stepBindingVerdict.evidenceDigest!==evidenceVerdict.evidenceDigest){console.log(JSON.stringify(fail('STEP_BINDING_EVIDENCE_JOIN_MISMATCH'),null,2));process.exit(0);}
if(runtimeTranscript.caseAlias!==input.caseAlias||runtimeTranscript.sources?.canonicalSuite!==input.sources.canonicalSuite||runtimeTranscript.sources?.externalWitness!==input.sources.externalWitness||runtimeTranscript.sources?.branchGrammar!==input.sources.branchGrammar||runtimeTranscript.sources?.branchManifest!==input.sources.branchManifest||runtimeTranscript.sources?.recoveryGrammar!==input.sources.recoveryGrammar||runtimeTranscript.sources?.recoveryManifest!==input.sources.recoveryManifest||runtimeTranscript.sources?.recoveryEvidence!==input.sources.recoveryEvidence||runtimeTranscript.sources?.evidenceStepBinding!==input.sources.evidenceStepBinding){console.log(JSON.stringify(fail('RUNTIME_TRANSCRIPT_SOURCE_JOIN_MISMATCH'),null,2));process.exit(0);}
const stepClaims=evidenceStepBinding.bindings.map(b=>({claimId:b.claimId,kind:b.kind,effectId:b.effectId,sinkId:b.sinkId})).sort((a,b)=>a.claimId.localeCompare(b.claimId));
const ledgerClaims=recoveryEvidence.claims.map(c=>({claimId:c.claimId,kind:c.kind,effectId:c.effectId,sinkId:c.sinkId})).sort((a,b)=>a.claimId.localeCompare(b.claimId));
if(JSON.stringify(stepClaims)!==JSON.stringify(ledgerClaims)){console.log(JSON.stringify(fail('STEP_BINDING_CLAIM_SET_MISMATCH'),null,2));process.exit(0);}

const canonicalEffects=cc.concrete.transitions.map(t=>t.effect).filter(e=>e&&e.effectId&&e.sinkId),canonicalEffectIds=new Set(canonicalEffects.map(e=>e.effectId)),canonicalPairs=new Set(canonicalEffects.map(e=>`${e.effectId}\0${e.sinkId}`));
if(recoveryEvidence.claims.some(c=>!canonicalEffectIds.has(c.effectId))){console.log(JSON.stringify(fail('RECOVERY_EVIDENCE_EFFECT_JOIN_MISMATCH'),null,2));process.exit(0);}
if(recoveryEvidence.claims.some(c=>!canonicalPairs.has(`${c.effectId}\0${c.sinkId}`))){console.log(JSON.stringify(fail('RECOVERY_EVIDENCE_SINK_JOIN_MISMATCH'),null,2));process.exit(0);}
const requiredClaimKinds=['RECEIPT','NEGATIVE_WITNESS','COMPENSATION'];
if([...canonicalPairs].some(pair=>{const [effectId,sinkId]=pair.split('\0');return requiredClaimKinds.some(kind=>recoveryEvidence.claims.filter(c=>c.effectId===effectId&&c.sinkId===sinkId&&c.kind===kind).length!==1);})){console.log(JSON.stringify(fail('RECOVERY_EVIDENCE_COVERAGE_MISMATCH'),null,2));process.exit(0);}

const generatedBranchManifest=generateBranchManifest(branchGrammar),fsmManifest=generateRecoveryFsmManifest(recoveryGrammar);
if(JSON.stringify(canonical(generatedBranchManifest))!==JSON.stringify(canonical(branchManifest))){console.log(JSON.stringify(fail('BRANCH_MANIFEST_JOIN_MISMATCH'),null,2));process.exit(0);}
const actual={canonicalCaseDigest:digest(cc,'CP-RIR-CANONICAL-CASE-V2'),externalWitnessCaseDigest:digest(wc,'CP-RIR-EXTERNAL-CLOSURE-WITNESS-V0'),branchGrammarDigest:generatedBranchManifest.grammarDigest,branchManifestDigest:digest(branchManifest,'CP-RIR-SCHEDULER-FAULT-BRANCH-MANIFEST-V0'),recoveryGrammarDigest:fsmManifest.grammarDigest,recoveryPathSetDigest:fsmManifest.pathSetDigest,recoveryEvidenceDigest:evidenceVerdict.evidenceDigest,evidenceStepBindingDigest:digest(normalizeStepBinding(evidenceStepBinding),'CP-RIR-RECOVERY-EVIDENCE-STEP-BINDING-V0'),runtimeTranscriptDigest:digest(normalizeTranscript(runtimeTranscript),'CP-RIR-D2-RUNTIME-SINK-TRANSCRIPT-V0')};
for(const [k,v] of Object.entries(input.expected))if(actual[k]!==v){console.log(JSON.stringify(fail('BINDING_INVALID',{mismatchField:k}),null,2));process.exit(0);}
if(wc.canonicalCaseDigest!==actual.canonicalCaseDigest){console.log(JSON.stringify(fail('WITNESS_CANONICAL_JOIN_MISMATCH'),null,2));process.exit(0);}
if(JSON.stringify(canonical(fsmManifest))!==JSON.stringify(canonical(recoveryManifest))){console.log(JSON.stringify(fail('RECOVERY_MANIFEST_JOIN_MISMATCH'),null,2));process.exit(0);}
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-fsm-binding-output/v0',implementationStatus:'prototype/unverified',status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'SEMANTIC_SUBCHECKS_AND_BINDING_VALID_RUNTIME_PATH_CATALOG_UNVERIFIED',scope:input.scope,caseAlias:input.caseAlias,semanticSubchecks:{canonical:canonicalCaseVerdict.status,branch:branchCaseVerdict.status,fsm:fsmVerdict.status,recoveryEvidence:evidenceVerdict.status,evidenceStepBinding:stepBindingVerdict.status,runtimeTranscript:runtimeVerdict.status},bindingDigest:digest(actual,'CP-RIR-FSM-CANONICAL-BRANCH-JOIN-V0'),evidencePolicy:input.evidencePolicy,utilityStatus:'NOT_EVALUATED',causalScope:'NOT_EVALUATED',unknownReasons:['RUNTIME_PATH_CATALOG_REFERENTIAL_ONLY','NO_REALIZED_RUNTIME_PATH','SINK_REPLAY_NOT_IMPLEMENTED','RECEIPT_AND_NEGATIVE_WITNESS_NOT_VERIFIED','COMPENSATION_EVIDENCE_NOT_VERIFIED']},null,2));
