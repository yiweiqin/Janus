#!/usr/bin/env node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const base=JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-runtime-sink-transcript-v0.input.example.json',import.meta.url),'utf8')),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cp-rir-transcript-neg-')),checker=fileURLToPath(new URL('./ubuddy-cp-rir-d2-runtime-sink-transcript-checker-v0.mjs',import.meta.url)),out=[];
const clone=v=>JSON.parse(JSON.stringify(v));
const run=(name,x,reason)=>{const f=path.join(tmp,name+'.json');fs.writeFileSync(f,JSON.stringify(x));const r=spawnSync(process.execPath,[checker,f],{encoding:'utf8'});const p=JSON.parse(r.stdout);out.push({name,expectedReasonCode:reason,actualReasonCode:p.reasonCode,passed:p.reasonCode===reason});};
try{
  const claim=clone(base);claim.records[0].claimId='negative-e1';run('claim-swap',claim,'TRANSCRIPT_COVERAGE_MISMATCH');
  const pathSwap=clone(base);pathSwap.records[0].pathId=pathSwap.records[1].pathId;run('path-swap',pathSwap,'TRANSCRIPT_DUPLICATE_PATH_ID');
  const branchSwap=clone(base);branchSwap.records[0].branchId='B-DROP';run('branch-swap',branchSwap,'TRANSCRIPT_CANONICAL_BRANCH_JOIN_MISMATCH');
  const sinkSwap=clone(base);sinkSwap.records[0].sinkId='s999';run('sink-swap',sinkSwap,'TRANSCRIPT_CLAIM_STEP_JOIN_MISMATCH');
  const rootTamper=clone(base);rootTamper.expected.evidenceDigest='0'.repeat(64);run('root-tamper',rootTamper,'TRANSCRIPT_ROOT_MISMATCH');
  const omit=clone(base);omit.records.pop();run('omitted-record',omit,'TRANSCRIPT_COVERAGE_MISMATCH');
  const indexSwap=clone(base);indexSwap.records[0].canonicalStepIndex=1;run('canonical-index-swap',indexSwap,'TRANSCRIPT_REFERENT_NOT_FOUND');
  const authorityTamper=clone(base);authorityTamper.records[0].epoch=99;run('authority-epoch-tamper',authorityTamper,'TRANSCRIPT_AUTHORITY_JOIN_MISMATCH');
  const branchVersionTamper=clone(base);branchVersionTamper.records[1].branchVersionAfter=0;run('branch-version-tamper',branchVersionTamper,'TRANSCRIPT_BRANCH_VERSION_JOIN_MISMATCH');
  const duplicateRecordId=clone(base);duplicateRecordId.records[1].recordId=duplicateRecordId.records[0].recordId;run('duplicate-record-id',duplicateRecordId,'TRANSCRIPT_DUPLICATE_RECORD_ID');
  const duplicatePathId=clone(base);duplicatePathId.records[1].pathId=duplicatePathId.records[0].pathId;run('duplicate-path-id',duplicatePathId,'TRANSCRIPT_DUPLICATE_PATH_ID');
  const realized=clone(base);realized.realizedPathId=realized.records[0].pathId;run('realized-without-signed-proof',realized,'REALIZED_PATH_REQUIRES_SIGNED_RUNTIME_PROOF');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-runtime-sink-transcript-negative/v0',implementationStatus:'prototype/unverified',allPassed:out.every(x=>x.passed),results:out},null,2));
