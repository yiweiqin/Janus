#!/usr/bin/env node
// Research-only all-prefix closure checker for an externally generated FSM
// manifest. It verifies manifest derivation and prefix/terminal closure; it
// does not verify sink reality, receipt cryptography, or crash execution.
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import {generateRecoveryFsmManifest} from './ubuddy-cp-rir-d2-recovery-fsm-generator-v0.mjs';
const read=(f)=>JSON.parse(fs.readFileSync(f,'utf8'));
const grammar=read(process.argv[2]??new URL('./ubuddy-cp-rir-d2-recovery-fsm-grammar-v0.input.example.json',import.meta.url));
const manifest=read(process.argv[3]??new URL('./ubuddy-cp-rir-d2-recovery-fsm-manifest-v0.input.example.json',import.meta.url));
const canonical=(v)=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v,d)=>crypto.createHash('sha256').update(`${d}\0${JSON.stringify(canonical(v))}`).digest('hex');
const ajv=new Ajv2020({strict:false});
const gs=read(new URL('./ubuddy-cp-rir-d2-recovery-fsm-grammar-v0.schema.json',import.meta.url));
const ms=read(new URL('./ubuddy-cp-rir-d2-recovery-fsm-manifest-v0.schema.json',import.meta.url));
const vg=ajv.compile(gs), vm=ajv.compile(ms);
const fail=(reasonCode,extra={})=>({schemaVersion:'cp-rir/d2-recovery-fsm-closure-output/v0',implementationStatus:'prototype/unverified',status:'INPUT_INVALID',reasonCode,...extra});
if(!vg(grammar)||!vm(manifest)){console.log(JSON.stringify(fail('SCHEMA_VALIDATION_FAILED',{grammarErrors:vg.errors??[],manifestErrors:vm.errors??[]}),null,2));process.exit(0);}
let expected; try{expected=generateRecoveryFsmManifest(grammar);}catch(e){console.log(JSON.stringify(fail(e.message),null,2));process.exit(0);}
if(manifest.grammarDigest!==expected.grammarDigest||manifest.grammarId!==expected.grammarId||manifest.horizon!==expected.horizon){console.log(JSON.stringify(fail('MANIFEST_NOT_DERIVED_FROM_GRAMMAR',{expectedGrammarDigest:expected.grammarDigest,actualGrammarDigest:manifest.grammarDigest}),null,2));process.exit(0);}
const paths=manifest.paths; const ids=new Set(paths.map(p=>p.pathId));
if(ids.size!==paths.length){console.log(JSON.stringify(fail('DUPLICATE_PATH_ID'),null,2));process.exit(0);}
const byId=new Map(paths.map(p=>[p.pathId,p]));
for(const p of paths){ if(p.states.length!==p.stepCount+1||p.events.length!==p.stepCount||p.transitionIds.length!==p.stepCount){console.log(JSON.stringify(fail('PATH_LENGTH_MISMATCH',{pathId:p.pathId}),null,2));process.exit(0);} if(p.stepCount>0){const parent=p.transitionIds.slice(0,-1).join('>')||'ROOT'; if(!byId.has(parent)){console.log(JSON.stringify(fail('OMITTED_PREFIX',{pathId:p.pathId,parent}),null,2));process.exit(0);}} }
const expectedIds=new Set(expected.paths.map(p=>p.pathId)); const omitted=[...expectedIds].filter(x=>!ids.has(x)); const extra=[...ids].filter(x=>!expectedIds.has(x));
if(omitted.length){console.log(JSON.stringify(fail('OMITTED_PREFIX',{omitted}),null,2));process.exit(0);} if(extra.length){console.log(JSON.stringify(fail('EXTRA_PATH',{extra}),null,2));process.exit(0);}
if(manifest.pathSetDigest!==expected.pathSetDigest){console.log(JSON.stringify(fail('MANIFEST_NOT_DERIVED_FROM_GRAMMAR',{expectedPathSetDigest:expected.pathSetDigest,actualPathSetDigest:manifest.pathSetDigest}),null,2));process.exit(0);}
const terminalSet=new Set(grammar.terminalStates);
for(const p of paths){const last=p.states[p.states.length-1]; if(p.terminal!==terminalSet.has(last)){console.log(JSON.stringify(fail('TERMINAL_FLAG_MISMATCH',{pathId:p.pathId,lastState:last}),null,2));process.exit(0);} if(!p.terminal && p.stepCount===grammar.horizon){console.log(JSON.stringify(fail('HORIZON_DEAD_END',{pathId:p.pathId}),null,2));process.exit(0);}}
const terminalCount=paths.filter(p=>p.terminal).length;
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-fsm-closure-output/v0',implementationStatus:'prototype/unverified',status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'ALL_PREFIX_CLOSURE_CHECKED_BUT_RUNTIME_EVIDENCE_UNVERIFIED',closure:{mode:'EXTERNAL_FSM_MANIFEST_ALL_PREFIX_CHECK',pathCount:paths.length,terminalCount,checked:true},grammarDigest:manifest.grammarDigest,pathSetDigest:manifest.pathSetDigest,unknownReasons:['NO_SINK_REPLAY','NO_RECEIPT_CRYPTOGRAPHY','NO_REAL_CRASH_RESTART','NO_FAIRNESS_PROOF']},null,2));
