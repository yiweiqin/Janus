#!/usr/bin/env node
// Research-only external-grammar closure checker. The recovery witness is
// separate from the grammar-generated manifest. This checks set equality and
// local semantic labels; it does not prove scheduler reachability or D2 soundness.
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import {generateBranchManifest} from './ubuddy-cp-rir-d2-scheduler-fault-branch-generator-v0.mjs';

const witnessFile = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-external-branch-witness-v0.input.example.json', import.meta.url);
const canonicalFile = process.argv[3] ?? new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.input.example.json', import.meta.url);
const manifestFile = process.argv[4] ?? new URL('./ubuddy-cp-rir-d2-scheduler-fault-branch-manifest-v0.input.example.json', import.meta.url);
const grammarFile = process.argv[5] ?? new URL('./ubuddy-cp-rir-d2-scheduler-fault-grammar-v0.input.example.json', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(f,'utf8'));
const witness = read(witnessFile), canonicalInput = read(canonicalFile), manifest = read(manifestFile), grammar = read(grammarFile);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const digest = (v, domain) => crypto.createHash('sha256').update(`${domain}\0${JSON.stringify(canonical(v))}`).digest('hex');
const fail = (status, reasonCode, extra = {}) => ({status,reasonCode,implementationStatus:'prototype/unverified',...extra});
const ajv = new Ajv2020({strict:false});
const legacyBranchSchema = read(new URL('./ubuddy-cp-rir-d2-recovery-branch-closure-v2.schema.json', import.meta.url));
legacyBranchSchema.$defs.case.properties.branches.minItems = 1;
const witnessSchema = read(new URL('./ubuddy-cp-rir-d2-external-branch-witness-v0.schema.json', import.meta.url));
const canonicalSchema = read(new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.schema.json', import.meta.url));
const manifestSchema = read(new URL('./ubuddy-cp-rir-d2-scheduler-fault-branch-manifest-v0.schema.json', import.meta.url));
const grammarSchema = read(new URL('./ubuddy-cp-rir-d2-scheduler-fault-grammar-v0.schema.json', import.meta.url));
ajv.addSchema(legacyBranchSchema);
const vw = ajv.compile(witnessSchema), vc = ajv.compile(canonicalSchema), vm = ajv.compile(manifestSchema), vg = ajv.compile(grammarSchema);
if (!vw(witness) || !vc(canonicalInput) || !vm(manifest) || !vg(grammar)) {
  console.log(JSON.stringify(fail('INPUT_INVALID','SCHEMA_VALIDATION_FAILED',{witnessErrors:vw.errors??[],canonicalErrors:vc.errors??[],manifestErrors:vm.errors??[],grammarErrors:vg.errors??[]}),null,2)); process.exit(0);
}
let recomputed;
try { recomputed = generateBranchManifest(grammar); }
catch (error) { console.log(JSON.stringify(fail('INPUT_INVALID',error.message),null,2)); process.exit(0); }
if (JSON.stringify(canonical(manifest)) !== JSON.stringify(canonical(recomputed))) {
  console.log(JSON.stringify(fail('INPUT_INVALID','MANIFEST_NOT_DERIVED_FROM_FROZEN_GRAMMAR',{declaredGrammarDigest:manifest.grammarDigest,recomputedGrammarDigest:recomputed.grammarDigest,declaredBranchSetDigest:manifest.branchSetDigest,recomputedBranchSetDigest:recomputed.branchSetDigest}),null,2)); process.exit(0);
}
const key = (b) => `${b.schedulerChoice}|${b.faultEvent}`;
const generated = manifest.branches.map((b) => b.branchKey).sort();
const generatedSet = new Set(generated);
if (generatedSet.size !== generated.length) { console.log(JSON.stringify(fail('INPUT_INVALID','GENERATOR_DUPLICATE_BRANCH',{generated}),null,2)); process.exit(0); }
const canonicalSemantic = new Map([
  ['DELIVER_RECEIPT|NONE','RECEIPT_PRESENT_UNVERIFIED'],
  ['DROP_RECEIPT|RECEIPT_DROP','RECEIPT_LOST_EFFECT_DECLARED_APPLIED'],
  ['CRASH_AFTER_EFFECT|CRASH_RESTART','CRASHED_EFFECT_POSSIBLE']
]);
for (const b of manifest.branches) if (canonicalSemantic.get(b.branchKey) !== b.branchSemantic) {
  console.log(JSON.stringify(fail('INPUT_INVALID','GRAMMAR_RULE_SEMANTIC_MISMATCH',{branchKey:b.branchKey,declared:b.branchSemantic,required:canonicalSemantic.get(b.branchKey)??null}),null,2)); process.exit(0);
}
const coveredSchedulers = new Set(manifest.branches.map((b)=>b.schedulerChoice));
const coveredFaults = new Set(manifest.branches.map((b)=>b.faultEvent));
const missingSchedulerSymbols = grammar.schedulerAlphabet.map((x)=>x.id).filter((x)=>!coveredSchedulers.has(x));
const missingFaultSymbols = grammar.faultAlphabet.map((x)=>x.id).filter((x)=>!coveredFaults.has(x));
if (missingSchedulerSymbols.length || missingFaultSymbols.length) {
  console.log(JSON.stringify(fail('INPUT_INVALID','GRAMMAR_ALPHABET_NOT_COVERED',{missingSchedulerSymbols,missingFaultSymbols}),null,2)); process.exit(0);
}
const canonicalByAlias = new Map(canonicalInput.cases.map((c) => [c.caseAlias,c]));
const results = witness.cases.map((c) => {
  const base = {caseAlias:c.caseAlias, witnessDigest:digest(c,'CP-RIR-EXTERNAL-CLOSURE-WITNESS-V0'), grammarDigest:manifest.grammarDigest, generatedBranchSetDigest:manifest.branchSetDigest};
  const cc = canonicalByAlias.get(c.caseAlias);
  if (!cc) return {...base,...fail('INPUT_INVALID','CANONICAL_CASE_NOT_FOUND')};
  const derivedCanonicalDigest = digest(cc,'CP-RIR-CANONICAL-CASE-V2');
  if (derivedCanonicalDigest !== c.canonicalCaseDigest) return {...base,...fail('INPUT_INVALID','CANONICAL_CASE_DIGEST_MISMATCH',{declared:c.canonicalCaseDigest,derived:derivedCanonicalDigest})};
  const actual = c.branches.map(key).sort();
  if (new Set(c.branches.map((b)=>b.branchId)).size !== c.branches.length) return {...base,...fail('WITNESS_INVALID','DUPLICATE_BRANCH_ID')};
  const counts = new Map(actual.map((x) => [x,(actual.filter((y) => y===x)).length]));
  const duplicates = [...counts.entries()].filter(([,n]) => n>1).map(([x])=>x);
  if (duplicates.length) return {...base,...fail('WITNESS_INVALID','DUPLICATE_BRANCH_KEY',{duplicates})};
  const omitted = [...generatedSet].filter((x) => !actual.includes(x));
  const extra = actual.filter((x) => !generatedSet.has(x));
  if (omitted.length || extra.length) return {...base,...fail('WITNESS_INVALID', omitted.length ? 'OMITTED_BRANCH' : 'EXTRA_BRANCH',{omitted,extra,generated,actual})};
  const semanticByKey = new Map(manifest.branches.map((b) => [b.branchKey,b.branchSemantic]));
  const authorities = new Map(c.authoritativeSinks.map((s)=>[s.sinkId,s]));
  if (authorities.size !== c.authoritativeSinks.length) return {...base,...fail('INPUT_INVALID','DUPLICATE_AUTHORITATIVE_SINK')};
  for (const b of c.branches) {
    if (semanticByKey.get(key(b)) === undefined) return {...base,...fail('WITNESS_INVALID','UNREACHABLE_OR_UNDEFINED_BRANCH',{branchKey:key(b)})};
    const expected = semanticByKey.get(key(b));
    const ok = (expected==='RECEIPT_PRESENT_UNVERIFIED' && b.receiptClaim.state==='PRESENT_UNVERIFIED') || (expected==='RECEIPT_LOST_EFFECT_DECLARED_APPLIED' && b.receiptClaim.state==='LOST') || (expected==='CRASHED_EFFECT_POSSIBLE' && b.receiptClaim.state==='ABSENT');
    if (!ok) return {...base,...fail('WITNESS_INVALID','BRANCH_SEMANTIC_MISMATCH',{branchKey:key(b),expected,actualReceiptState:b.receiptClaim.state})};
    const edge = cc.trace.concreteEvents[b.canonicalFact.canonicalStepIndex];
    if (!edge) return {...base,...fail('WITNESS_INVALID','CANONICAL_STEP_MISSING',{branchId:b.branchId})};
    for (const field of ['event','eventClass']) if (b.canonicalFact[field] !== edge[field]) return {...base,...fail('WITNESS_INVALID','CANONICAL_EVENT_FACT_MISMATCH',{branchId:b.branchId,field})};
    for (const field of ['effectId','sinkId','resourceId','multiplicity','versionDelta']) if (b.canonicalFact[field] !== edge.effect[field]) return {...base,...fail('WITNESS_INVALID','CANONICAL_EFFECT_FACT_MISMATCH',{branchId:b.branchId,field})};
    const authority = authorities.get(b.authorityRef);
    if (!authority || b.authorityRef !== b.canonicalFact.sinkId || b.sinkAfter.sinkId !== b.canonicalFact.sinkId || authority.resourceId !== b.canonicalFact.resourceId) return {...base,...fail('WITNESS_INVALID','AUTHORITATIVE_SINK_BINDING_MISMATCH',{branchId:b.branchId})};
    if (b.sinkAfter.versionAfter-authority.versionBefore !== b.canonicalFact.versionDelta) return {...base,...fail('WITNESS_INVALID','VERSION_DELTA_MISMATCH',{branchId:b.branchId})};
    if (b.runtimeStatus==='IN_DOUBT' && (b.publicDisposition!=='DO_NOT_RETRY' || b.allowedActions.includes('COMPLETE_FORWARD'))) return {...base,...fail('INPUT_INVALID','IN_DOUBT_ACTION_CONTRADICTION',{branchId:b.branchId})};
    if (b.receiptClaim.atomicReplay!=='VERIFIED' && b.sinkAfter.effectKnowledge==='EFFECT_CONFIRMED') return {...base,...fail('UNKNOWN_INPUT_NOT_PROVEN','EFFECT_CONFIRMATION_REQUIRES_ATOMIC_REPLAY',{branchId:b.branchId})};
  }
  return {...base,status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'EXTERNAL_GENERATOR_SET_MATCH_UNVERIFIED_REACHABILITY',closure:{mode:'EXTERNAL_GRAMMAR_MANIFEST_COMPARE_ONLY',generatedCount:generated.length,witnessCount:actual.length,omitted:[],extra:[],checked:true},unknownReasons:['GRAMMAR_REACHABILITY_NOT_MACHINE_CHECKED','ALL_PREFIX_CLOSURE_NOT_IMPLEMENTED','REAL_SCHEDULER_REPLAY_NOT_IMPLEMENTED','SINK_REPLAY_NOT_IMPLEMENTED','RECEIPT_ATOMIC_REPLAY_NOT_IMPLEMENTED']};
});
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-external-branch-closure-output/v0',implementationStatus:'prototype/unverified',inputStatus:'VALID',grammarDigest:manifest.grammarDigest,results},null,2));
