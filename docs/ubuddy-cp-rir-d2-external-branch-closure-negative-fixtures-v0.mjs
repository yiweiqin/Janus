#!/usr/bin/env node
// Negative corpus for the external branch closure checker. It exercises
// omitted, extra, duplicate and semantic-mismatch witness branches without
// changing the source fixture on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const witness = JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-external-branch-witness-v0.input.example.json',import.meta.url),'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-scheduler-fault-branch-manifest-v0.input.example.json',import.meta.url),'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = clone(witness.cases[0]);
const cases = {
  omitted: (() => { const c=clone(base); c.branches=c.branches.slice(1); return c; })(),
  extra: (() => { const c=clone(base); c.branches.push({...clone(c.branches[0]),branchId:'B-EXTRA',schedulerChoice:'DELIVER_RECEIPT',faultEvent:'RECEIPT_DROP'}); return c; })(),
  duplicate: (() => { const c=clone(base); c.branches.push(clone(c.branches[0])); return c; })(),
  semanticMismatch: (() => { const c=clone(base); c.branches[0].receiptClaim.state='LOST'; return c; })()
};
const expected = {omitted:'OMITTED_BRANCH',extra:'EXTRA_BRANCH',duplicate:'DUPLICATE_BRANCH_ID',semanticMismatch:'BRANCH_SEMANTIC_MISMATCH'};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'cp-rir-negative-'));
const checker = new URL('./ubuddy-cp-rir-d2-external-branch-closure-v0.mjs',import.meta.url);
const canonicalFile = new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.input.example.json',import.meta.url);
const manifestFile = new URL('./ubuddy-cp-rir-d2-scheduler-fault-branch-manifest-v0.input.example.json',import.meta.url);
const grammarFile = new URL('./ubuddy-cp-rir-d2-scheduler-fault-grammar-v0.input.example.json',import.meta.url);
const results = [];
try {
  for (const [name,c] of Object.entries(cases)) {
    const mutated = clone(witness); mutated.cases=[c];
    const file = path.join(tmp,`${name}.json`); fs.writeFileSync(file,JSON.stringify(mutated));
    const run = spawnSync(process.execPath,[checker.pathname.replace(/^\/(.:)/,'$1'),file,canonicalFile.pathname.replace(/^\/(.:)/,'$1'),manifestFile.pathname.replace(/^\/(.:)/,'$1'),grammarFile.pathname.replace(/^\/(.:)/,'$1')],{encoding:'utf8'});
    const output = JSON.parse(run.stdout); const reasonCode = output.results?.[0]?.reasonCode ?? output.reasonCode;
    results.push({fixture:name,expectedReasonCode:expected[name],actualReasonCode:reasonCode,passed:reasonCode===expected[name]});
  }
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-external-branch-negative-fixtures/v0',implementationStatus:'prototype/unverified',grammarBranchKeys:manifest.branches.map((b)=>b.branchKey).sort(),allPassed:results.every((x)=>x.passed),results},null,2));
