#!/usr/bin/env node
// Research-only branch generator driven by an external, versioned grammar.
// Rule enumeration is independent from recovery witnesses, but it is not a
// machine-checked scheduler reachability or all-prefix closure procedure.
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

export const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
export const digest = (v, domain) => crypto.createHash('sha256').update(`${domain}\0${JSON.stringify(canonical(v))}`).digest('hex');

export function generateBranchManifest(grammar) {
  const schedulerIds = new Set(grammar.schedulerAlphabet.map((x) => x.id));
  const faultIds = new Set(grammar.faultAlphabet.map((x) => x.id));
  if (schedulerIds.size !== grammar.schedulerAlphabet.length) throw new Error('DUPLICATE_SCHEDULER_SYMBOL');
  if (faultIds.size !== grammar.faultAlphabet.length) throw new Error('DUPLICATE_FAULT_SYMBOL');
  const ruleIds = new Set();
  const branches = [];
  for (const rule of grammar.generationRules) {
    if (ruleIds.has(rule.ruleId)) throw new Error('DUPLICATE_GENERATION_RULE_ID');
    ruleIds.add(rule.ruleId);
    if (!schedulerIds.has(rule.schedulerChoice)) throw new Error('UNKNOWN_SCHEDULER_SYMBOL');
    for (const faultEvent of rule.faultEvents) {
      if (!faultIds.has(faultEvent)) throw new Error('UNKNOWN_FAULT_SYMBOL');
      branches.push({branchKey:`${rule.schedulerChoice}|${faultEvent}`,ruleId:rule.ruleId,schedulerChoice:rule.schedulerChoice,faultEvent,branchSemantic:rule.branchSemantic});
    }
  }
  branches.sort((a,b) => a.branchKey.localeCompare(b.branchKey));
  if (new Set(branches.map((x) => x.branchKey)).size !== branches.length) throw new Error('DUPLICATE_GENERATED_BRANCH_KEY');
  const grammarDigest = digest(grammar,'CP-RIR-SCHEDULER-FAULT-GRAMMAR-V0');
  return {$schema:'ubuddy-cp-rir-d2-scheduler-fault-branch-manifest-v0.schema.json',schemaVersion:'cp-rir/d2-scheduler-fault-branch-manifest/v0',implementationStatus:'prototype/unverified',generatorVersion:'cp-rir/d2-rule-enumerator/v0',grammarId:grammar.grammarId,grammarDigest,horizon:grammar.horizon,generationMode:'EXTERNAL_RULE_ENUMERATION_ONLY',branches,branchSetDigest:digest(branches,'CP-RIR-SCHEDULER-FAULT-BRANCH-SET-V0'),limitations:['NO_MACHINE_CHECKED_REACHABILITY','NO_ALL_PREFIX_CLOSURE','NO_REAL_SCHEDULER_REPLAY']};
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g,'/')}`).href) {
  const grammarFile = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-scheduler-fault-grammar-v0.input.example.json', import.meta.url);
  const grammar = JSON.parse(fs.readFileSync(grammarFile,'utf8'));
  const schema = JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-scheduler-fault-grammar-v0.schema.json',import.meta.url),'utf8'));
  const validate = new Ajv2020({strict:false}).compile(schema);
  if (!validate(grammar)) {
    console.log(JSON.stringify({schemaVersion:'cp-rir/d2-scheduler-fault-branch-manifest/v0',implementationStatus:'prototype/unverified',inputStatus:'INPUT_INVALID',reasonCode:'GRAMMAR_SCHEMA_VALIDATION_FAILED',errors:validate.errors??[]},null,2));
  } else {
    try { console.log(JSON.stringify(generateBranchManifest(grammar),null,2)); }
    catch (error) { console.log(JSON.stringify({schemaVersion:'cp-rir/d2-scheduler-fault-branch-manifest/v0',implementationStatus:'prototype/unverified',inputStatus:'INPUT_INVALID',reasonCode:error.message},null,2)); }
  }
}
