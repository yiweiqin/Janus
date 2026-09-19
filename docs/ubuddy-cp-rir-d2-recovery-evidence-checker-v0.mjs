#!/usr/bin/env node
import fs from 'node:fs';import crypto from 'node:crypto';import Ajv2020 from 'ajv/dist/2020.js';
const f=process.argv[2]??new URL('./ubuddy-cp-rir-d2-recovery-evidence-v0.input.example.json',import.meta.url);
const x=JSON.parse(fs.readFileSync(f,'utf8'));
const s=JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-recovery-evidence-v0.schema.json',import.meta.url),'utf8'));
const v=new Ajv2020({strict:false}).compile(s);
const canon=z=>Array.isArray(z)?z.map(canon):z&&typeof z==='object'?Object.fromEntries(Object.keys(z).sort().map(k=>[k,canon(z[k])])):z;
const normalizedEvidence=z=>({...z,claims:[...z.claims].sort((a,b)=>[a.effectId,a.sinkId,a.kind,a.claimId].join('\0').localeCompare([b.effectId,b.sinkId,b.kind,b.claimId].join('\0')))});
const d=z=>crypto.createHash('sha256').update('CP-RIR-RECOVERY-EVIDENCE-V0\0'+JSON.stringify(canon(normalizedEvidence(z)))).digest('hex');
const fail=(reasonCode,extra={})=>({schemaVersion:'cp-rir/d2-recovery-evidence-output/v0',implementationStatus:'prototype/unverified',status:'INPUT_INVALID',reasonCode,...extra});
if(!v(x)){console.log(JSON.stringify(fail('SCHEMA_VALIDATION_FAILED',{errors:v.errors??[]}),null,2));process.exit(0);}
const claimIds=x.claims.map(c=>c.claimId);
if(new Set(claimIds).size!==claimIds.length){console.log(JSON.stringify(fail('DUPLICATE_CLAIM_ID'),null,2));process.exit(0);}
if(x.claims.some(c=>Object.values(c.checks).includes('PASS'))){console.log(JSON.stringify(fail('INPUT_PASS_FORBIDDEN_WITHOUT_INDEPENDENT_VERIFIER'),null,2));process.exit(0);}
const requiredKinds=['RECEIPT','NEGATIVE_WITNESS','COMPENSATION'];
const claimIdentities=x.claims.map(c=>`${c.effectId}\0${c.sinkId}\0${c.kind}`);
if(requiredKinds.some(kind=>!x.claims.some(c=>c.kind===kind))||new Set(claimIdentities).size!==claimIdentities.length){console.log(JSON.stringify(fail('CLAIM_KIND_COVERAGE_INVALID'),null,2));process.exit(0);}
const results=x.claims.map(c=>c.verificationStatus==='VERIFIED'
  ?{claimId:c.claimId,status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'VERIFIED_CLAIM_REQUIRES_ALL_REPLAY_CHECKS'}
  :{claimId:c.claimId,status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'REPLAY_NOT_IMPLEMENTED'});
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-evidence-output/v0',implementationStatus:'prototype/unverified',status:'UNKNOWN_INPUT_NOT_PROVEN',evidenceDigest:d(x),results,unknownReasons:results.map(r=>`${r.claimId}:${r.reasonCode}`)},null,2));
