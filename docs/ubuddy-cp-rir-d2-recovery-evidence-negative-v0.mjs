#!/usr/bin/env node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const x=JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-recovery-evidence-v0.input.example.json',import.meta.url),'utf8'));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cp-rir-evidence-neg-'));const checker=fileURLToPath(new URL('./ubuddy-cp-rir-d2-recovery-evidence-checker-v0.mjs',import.meta.url));const out=[];
const clone=v=>JSON.parse(JSON.stringify(v));
const run=(name,input,expectedReasonCode,selector=p=>p.reasonCode)=>{const f=path.join(dir,`${name}.json`);fs.writeFileSync(f,JSON.stringify(input));const r=spawnSync(process.execPath,[checker,f],{encoding:'utf8'});const p=JSON.parse(r.stdout);const actualReasonCode=selector(p);out.push({name,expectedReasonCode,actualReasonCode,passed:actualReasonCode===expectedReasonCode});};
try{
  for(const claim of x.claims){const y=clone(x);y.claims.find(c=>c.claimId===claim.claimId).verificationStatus='VERIFIED';run(`false-verified-${claim.claimId}`,y,'VERIFIED_CLAIM_REQUIRES_ALL_REPLAY_CHECKS',p=>p.results?.find(r=>r.claimId===claim.claimId)?.reasonCode);}
  const passBypass=clone(x);for(const claim of passBypass.claims)for(const key of Object.keys(claim.checks))claim.checks[key]='PASS';run('input-pass-bypass',passBypass,'INPUT_PASS_FORBIDDEN_WITHOUT_INDEPENDENT_VERIFIER');
  const duplicate=clone(x);duplicate.claims.push(clone(duplicate.claims[0]));run('duplicate-claim-id',duplicate,'DUPLICATE_CLAIM_ID');
  const missingKind=clone(x);missingKind.claims=missingKind.claims.filter(c=>c.kind!=='COMPENSATION');run('missing-claim-kind',missingKind,'CLAIM_KIND_COVERAGE_INVALID');
  const duplicateKind=clone(x);duplicateKind.claims.find(c=>c.kind==='COMPENSATION').kind='RECEIPT';run('duplicate-claim-kind',duplicateKind,'CLAIM_KIND_COVERAGE_INVALID');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-evidence-negative/v0',implementationStatus:'prototype/unverified',allPassed:out.every(x=>x.passed),results:out},null,2));
