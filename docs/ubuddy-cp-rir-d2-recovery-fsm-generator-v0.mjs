#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
const canonical=(v)=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v,d)=>crypto.createHash('sha256').update(`${d}\0${JSON.stringify(canonical(v))}`).digest('hex');
export function generateRecoveryFsmManifest(grammar){
  const states=new Set(grammar.states), terminals=new Set(grammar.terminalStates);
  if(!states.has(grammar.initialState)) throw new Error('INITIAL_STATE_NOT_DECLARED');
  for(const s of terminals) if(!states.has(s)) throw new Error('TERMINAL_STATE_NOT_DECLARED');
  const transitionIds=new Set(), deterministic=new Set();
  for(const t of grammar.transitions){if(!states.has(t.from)||!states.has(t.to)) throw new Error('TRANSITION_STATE_NOT_DECLARED');}
  for(const t of grammar.transitions){if(transitionIds.has(t.transitionId)) throw new Error('DUPLICATE_TRANSITION_ID'); transitionIds.add(t.transitionId); const k=`${t.from}|${t.event}`; if(deterministic.has(k)) throw new Error('NONDETERMINISTIC_TRANSITION_UNDECLARED'); deterministic.add(k);}
  const byFrom=new Map(); for(const t of grammar.transitions){const a=byFrom.get(t.from)||[]; a.push(t); byFrom.set(t.from,a);}
  const reachable=new Set([grammar.initialState]); const queue=[grammar.initialState];
  while(queue.length){const s=queue.shift(); for(const t of (byFrom.get(s)||[])) if(!reachable.has(t.to)){reachable.add(t.to);queue.push(t.to);}}
  const unreachableStates=grammar.states.filter(s=>!reachable.has(s));
  const unreachableTransitions=grammar.transitions.filter(t=>!reachable.has(t.from)).map(t=>t.transitionId);
  if(unreachableStates.length||unreachableTransitions.length) throw new Error(`UNREACHABLE_STATE_OR_TRANSITION:${JSON.stringify({unreachableStates,unreachableTransitions})}`);
  const paths=[]; const visit=(state,steps)=>{
    const pathId=steps.length?steps.map(s=>s.transitionId).join('>'):'ROOT';
    paths.push({pathId,stepCount:steps.length,states:[grammar.initialState,...steps.map(s=>s.to)],events:steps.map(s=>s.event),transitionIds:steps.map(s=>s.transitionId),terminal:terminals.has(state)});
    if(steps.length>=grammar.horizon||terminals.has(state)) return;
    for(const t of (byFrom.get(state)||[])) visit(t.to,[...steps,t]);
  };
  visit(grammar.initialState,[]);
  const seen=new Set(); for(const p of paths){if(seen.has(p.pathId)) throw new Error('DUPLICATE_PATH_ID'); seen.add(p.pathId);}
  return {$schema:'ubuddy-cp-rir-d2-recovery-fsm-manifest-v0.schema.json',schemaVersion:'cp-rir/d2-recovery-fsm-manifest/v0',implementationStatus:'prototype/unverified',generatorVersion:'cp-rir/d2-recovery-fsm-generator/v0',grammarId:grammar.grammarId,grammarDigest:digest(grammar,'CP-RIR-RECOVERY-FSM-GRAMMAR-V0'),horizon:grammar.horizon,generationMode:'EXPLICIT_PREFIX_ENUMERATION',paths,pathSetDigest:digest(paths,'CP-RIR-RECOVERY-FSM-PATH-SET-V0'),limitations:['NO_SINK_REPLAY','NO_RECEIPT_CRYPTOGRAPHY','NO_REAL_CRASH_RESTART','NO_FAIRNESS_PROOF']};
}
if(process.argv[1]&&import.meta.url===new URL(`file:///${process.argv[1].replace(/\\/g,'/')}`).href){
  const file=process.argv[2]??new URL('./ubuddy-cp-rir-d2-recovery-fsm-grammar-v0.input.example.json',import.meta.url); const g=JSON.parse(fs.readFileSync(file,'utf8')); const s=JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-recovery-fsm-grammar-v0.schema.json',import.meta.url),'utf8')); const v=new Ajv2020({strict:false}).compile(s);
  if(!v(g)) console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-fsm-manifest/v0',implementationStatus:'prototype/unverified',inputStatus:'INPUT_INVALID',reasonCode:'GRAMMAR_SCHEMA_VALIDATION_FAILED',errors:v.errors??[]},null,2)); else try{console.log(JSON.stringify(generateRecoveryFsmManifest(g),null,2));}catch(e){console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-fsm-manifest/v0',implementationStatus:'prototype/unverified',inputStatus:'INPUT_INVALID',reasonCode:e.message},null,2));}
}
