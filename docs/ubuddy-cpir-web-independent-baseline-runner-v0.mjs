#!/usr/bin/env node
/*
 * Independent research runner: world catalog, policy synthesis, and contract
 * evaluation are separate modules. It intentionally does not import Janus.
 */
import fs from 'node:fs';
import path from 'node:path';
import {scenarios} from './ubuddy-cpir-web-world-catalog-v1.mjs';
import {synthesizePolicies, executeTree} from './ubuddy-cpir-web-policy-synthesizer-v1.mjs';
import {executeRepair} from './ubuddy-cpir-web-contract-evaluator-v1.mjs';

const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const policyNames = ['cpir','safePOMDP','activeDiagnosis','oneStepDiagnosis'];
const rows=[];
for (const [scenarioId, scenario] of Object.entries(scenarios)) {
  const plans=synthesizePolicies(scenario,{budget:0.6,depth:3});
  for (const world of scenario.worlds) {
    for (const policy of policyNames) {
      // Policies receive only probe responses. The hidden world remains inside
      // this evaluator-side closure and is never passed to the policy module.
      const selected=executeTree(scenario,plans[policy].tree,(probe)=>world.scopes.includes(probe.scope)?world.observations[probe.id]:'UNSUPPORTED');
      const repair=scenario.repairs.find(r=>r.id===selected.repairId) ?? scenario.repairs.find(r=>r.id==='ABSTAIN');
      const execution=executeRepair(scenario,world,repair);
      rows.push({scenarioId,worldId:world.id,publicCut:scenario.publicCut,policy,observations:selected.observations,certificate:plans[policy].certificate,effectLedger:execution.goldEffectLedger,evaluation:execution.evaluation});
    }
  }
}
const summary={};
for(const scenarioId of Object.keys(scenarios)){
  summary[scenarioId]={};
  for(const policy of policyNames){
    const rs=rows.filter(r=>r.scenarioId===scenarioId&&r.policy===policy);
    summary[scenarioId][policy]={traces:rs.length,satisfied:rs.filter(r=>r.evaluation.disposition==='SATISFIED').length,violated:rs.filter(r=>r.evaluation.disposition==='VIOLATED').length,unknown:rs.filter(r=>r.evaluation.disposition==='UNKNOWN').length,unresolvedEdges:[...new Set(rs.flatMap(r=>r.certificate?.unresolvedEdges??[]))]};
  }
}
const out={schemaVersion:'cpir-web/independent-runner/v0',implementationStatus:'simulator/prototype',modelScope:'DECLARED_WORLD_CATALOG_PLUS_SEPARATE_POLICY_AND_CONTRACT_MODULES',scenarioCount:Object.keys(scenarios).length,rowCount:rows.length,policyNames,summary,rows,unknownReasons:['NO_REAL_BROWSER_OR_OAUTH_RUNTIME','NO_AUTHENTICATED_SINK_RECEIPTS','DECLARED_WORLD_CATALOG_ONLY','POLICIES_STILL_FINITE_MODEL_BASED']};
const text=JSON.stringify(out,null,2)+'\n';
if(outputPath) fs.writeFileSync(outputPath,text); else process.stdout.write(text);
