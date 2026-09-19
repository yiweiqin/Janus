#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ? path.resolve(process.argv[2]) : new URL('./ubuddy-cpir-web-simulator-v0.output.json', import.meta.url);
const x = JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = reasonCode => ({schemaVersion:'cpir-web/simulator-check-v0',implementationStatus:'simulator/prototype',status:'INPUT_INVALID',reasonCode});
const expectedPolicies = ['retry','replan','provenanceOnly','gatewayOnly','pbes'];
const expectedScenarioCount = 6;
const expectedSeeds = new Set([11,23,37,53,71]);

if (x.schemaVersion !== 'cpir-web/simulator-output/v0') { console.log(JSON.stringify(fail('SCHEMA_VERSION_INVALID'),null,2)); process.exit(0); }
if (x.implementationStatus !== 'simulator/prototype') { console.log(JSON.stringify(fail('IMPLEMENTATION_STATUS_INVALID'),null,2)); process.exit(0); }
if (x.scenarioCount !== expectedScenarioCount || x.seedCount !== expectedSeeds.size || x.traceCount !== 90) { console.log(JSON.stringify(fail('COVERAGE_SUMMARY_INVALID'),null,2)); process.exit(0); }
if (!Array.isArray(x.traces) || x.traces.length !== x.traceCount) { console.log(JSON.stringify(fail('TRACE_COUNT_INVALID'),null,2)); process.exit(0); }

const groups = new Map();
for (const t of x.traces) {
  if (!t.scenarioId || !t.hiddenWorldId || !expectedSeeds.has(t.seed)) { console.log(JSON.stringify(fail('TRACE_ID_OR_SEED_INVALID'),null,2)); process.exit(0); }
  if (typeof t.publicCut !== 'string' || t.publicCut.includes(t.hiddenWorldId) || t.publicCut.includes(t.hiddenCause)) { console.log(JSON.stringify(fail('PUBLIC_CUT_LEAKS_HIDDEN_STATE'),null,2)); process.exit(0); }
  if (!t.hardContract || typeof t.hardContract.required !== 'string' || !Array.isArray(t.hardContract.forbidden)) { console.log(JSON.stringify(fail('HARD_CONTRACT_MISSING'),null,2)); process.exit(0); }
  const key = `${t.scenarioId}|${t.hiddenWorldId}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(t);
  for (const p of expectedPolicies) {
    const row = t.policies?.[p];
    if (!row || !row.result || !row.goldEffectLedger) { console.log(JSON.stringify(fail('POLICY_OR_LEDGER_MISSING'),null,2)); process.exit(0); }
    const g = row.goldEffectLedger;
    if (!['SATISFIED','VIOLATED','UNKNOWN'].includes(g.contractDisposition)) { console.log(JSON.stringify(fail('LEDGER_DISPOSITION_INVALID'),null,2)); process.exit(0); }
    if (typeof g.actualCardinality !== 'number' || typeof g.intendedCardinality !== 'number' || typeof g.irreversible !== 'boolean') { console.log(JSON.stringify(fail('LEDGER_FIELDS_INVALID'),null,2)); process.exit(0); }
    if (g.contractDisposition === 'VIOLATED' && !g.violationReason) { console.log(JSON.stringify(fail('VIOLATION_REASON_MISSING'),null,2)); process.exit(0); }
    if (g.contractDisposition === 'UNKNOWN' && row.result.action !== 'ABSTAIN') { console.log(JSON.stringify(fail('UNKNOWN_NOT_ABSTAIN'),null,2)); process.exit(0); }
  }
}
if (groups.size !== expectedScenarioCount * 3 || [...groups.values()].some(rows => rows.length !== expectedSeeds.size)) { console.log(JSON.stringify(fail('WORLD_SEED_COVERAGE_INVALID'),null,2)); process.exit(0); }

console.log(JSON.stringify({schemaVersion:'cpir-web/simulator-check-v0',implementationStatus:'simulator/prototype',status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'SIMULATOR_TRACE_LEDGER_CONSISTENCY_VALID_RUNTIME_UNVERIFIED',scenarioCount:x.scenarioCount,traceCount:x.traceCount,worldSeedGroups:groups.size,policiesChecked:expectedPolicies},null,2));
