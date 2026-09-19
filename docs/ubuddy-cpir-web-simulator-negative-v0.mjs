#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(fs.readFileSync(path.join(here,'ubuddy-cpir-web-simulator-v0.output.json'),'utf8'));
const checker = path.join(here,'ubuddy-cpir-web-simulator-checker-v0.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'cpir-web-sim-neg-'));
const clone = x => JSON.parse(JSON.stringify(x));
const cases = [];
const run = (name, x, expected) => {
  const f = path.join(tmp, `${name}.json`); fs.writeFileSync(f, JSON.stringify(x));
  const r = JSON.parse(spawnSync(process.execPath,[checker,f],{encoding:'utf8'}).stdout);
  cases.push({name,expectedReasonCode:expected,actualReasonCode:r.reasonCode,passed:r.reasonCode===expected});
};
try {
  let x=clone(base); x.traceCount=89; run('summary-count',x,'COVERAGE_SUMMARY_INVALID');
  x=clone(base); delete x.traces[0].policies.pbes.goldEffectLedger; run('ledger-missing',x,'POLICY_OR_LEDGER_MISSING');
  x=clone(base); x.traces[0].publicCut += '|'+x.traces[0].hiddenCause; run('public-leak',x,'PUBLIC_CUT_LEAKS_HIDDEN_STATE');
  x=clone(base); x.traces[0].policies.pbes.goldEffectLedger.contractDisposition='UNKNOWN'; x.traces[0].policies.pbes.result.action='REPAIR'; run('unknown-not-abstain',x,'UNKNOWN_NOT_ABSTAIN');
  x=clone(base); x.traces[0].policies.retry.goldEffectLedger.contractDisposition='VIOLATED'; delete x.traces[0].policies.retry.goldEffectLedger.violationReason; run('violation-without-reason',x,'VIOLATION_REASON_MISSING');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
console.log(JSON.stringify({schemaVersion:'cpir-web/simulator-negative/v0',implementationStatus:'simulator/prototype',allPassed:cases.every(x=>x.passed),results:cases},null,2));
