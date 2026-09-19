import fs from 'node:fs/promises';
const p = JSON.parse(await fs.readFile(process.argv[2] || 'experiments/tdb_probe_benchmark/tdb_multitask_label_contract_v2.json', 'utf8'));
const errors=[]; const need=(x,c)=>{if(!x)errors.push(c)};
need(p.version==='tdb-multitask-label-contract-v2','version');
for(const h of ['state_posterior','counterfactual_uplift','decision_sufficient_projection','attribution']) need(p.heads?.[h],'head:'+h);
need(p.heads.counterfactual_uplift.formula==='utility(candidate_action)-utility(noop)','uplift_formula');
for(const x of ['condition/fault_type/ground_truth/oracle_action never enter inputs','test outcomes are read-only after freeze','hard constraints and privacy checks are non-differentiable gates']) need(p.global_rules.includes(x),'rule:'+x);
const result={valid:errors.length===0,errors,heads:Object.keys(p.heads||{})}; console.log(JSON.stringify(result,null,2)); if(errors.length)process.exitCode=1;
