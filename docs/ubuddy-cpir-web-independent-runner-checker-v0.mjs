#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const f=process.argv[2]?path.resolve(process.argv[2]):new URL('./ubuddy-cpir-web-independent-runner-v0.output.json',import.meta.url);
const x=JSON.parse(fs.readFileSync(f,'utf8'));
const fail=reasonCode=>({schemaVersion:'cpir-web/independent-runner-check-v0',implementationStatus:'simulator/prototype',status:'INPUT_INVALID',reasonCode});
if(x.schemaVersion!=='cpir-web/independent-runner/v0'){console.log(JSON.stringify(fail('SCHEMA_VERSION_INVALID'),null,2));process.exit(0);}
if(x.implementationStatus!=='simulator/prototype'){console.log(JSON.stringify(fail('IMPLEMENTATION_STATUS_INVALID'),null,2));process.exit(0);}
if(x.scenarioCount!==6||x.rowCount!==72||x.policyNames.length!==4){console.log(JSON.stringify(fail('COVERAGE_SUMMARY_INVALID'),null,2));process.exit(0);}
if(!Array.isArray(x.rows)||x.rows.length!==72){console.log(JSON.stringify(fail('ROW_COUNT_INVALID'),null,2));process.exit(0);}
const keys=new Set();
for(const r of x.rows){
  const k=`${r.scenarioId}|${r.worldId}|${r.policy}`;
  if(keys.has(k)){console.log(JSON.stringify(fail('DUPLICATE_ROW'),null,2));process.exit(0);} keys.add(k);
  if(!r.publicCut||r.publicCut.includes(r.worldId)){console.log(JSON.stringify(fail('PUBLIC_CUT_LEAK'),null,2));process.exit(0);}
  if(!['SATISFIED','VIOLATED','UNKNOWN'].includes(r.evaluation?.disposition)){console.log(JSON.stringify(fail('EVALUATION_INVALID'),null,2));process.exit(0);}
  if(r.evaluation.disposition==='UNKNOWN'&&r.effectLedger.contractDisposition!=='UNKNOWN'){console.log(JSON.stringify(fail('LEDGER_EVALUATION_MISMATCH'),null,2));process.exit(0);}
}
console.log(JSON.stringify({schemaVersion:'cpir-web/independent-runner-check-v0',implementationStatus:'simulator/prototype',status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'SEPARATED_CATALOG_POLICY_EVALUATOR_CONSISTENT_RUNTIME_UNVERIFIED',rowCount:x.rowCount,uniqueRows:keys.size,policies:x.policyNames},null,2));
