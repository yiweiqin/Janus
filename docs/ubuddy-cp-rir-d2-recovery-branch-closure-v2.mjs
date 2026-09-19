#!/usr/bin/env node
// Research-only bounded recovery branch-closure checker.
// It validates supplied branch closure for one frozen canonical witness; it
// does not explore a real scheduler or claim D2 soundness.
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

const inputFile = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-recovery-branch-closure-v2.input.example.json', import.meta.url);
const canonicalFile = process.argv[3] ?? new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.input.example.json', import.meta.url);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const canonicalInput = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const digest = (v, domain = 'CP-RIR-V2') => crypto.createHash('sha256').update(`${domain}\0${JSON.stringify(canonical(v))}`).digest('hex');
const fail = (status, reasonCode, extra = {}) => ({ status, reasonCode, ...extra });
const ajv = new Ajv2020({ strict:false });
const schema = JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-recovery-branch-closure-v2.schema.json', import.meta.url), 'utf8'));
const canonicalSchema = JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.schema.json', import.meta.url), 'utf8'));
const validateInput = ajv.compile(schema);
const validateCanonical = ajv.compile(canonicalSchema);
if (!validateInput(input) || !validateCanonical(canonicalInput)) {
  console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-branch-closure-output/v2',implementationStatus:'prototype/unverified',inputStatus:'INPUT_INVALID',reasonCode:'SCHEMA_VALIDATION_FAILED',inputErrors:validateInput.errors??[],canonicalErrors:validateCanonical.errors??[]},null,2));
  process.exit(0);
}

const key = (x) => `${x.schedulerChoice}|${x.faultEvent}`;
const expectedBranchKeys = input.kernel.allowedBranches.map(key).sort();
if (new Set(expectedBranchKeys).size !== expectedBranchKeys.length) {
  console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-branch-closure-output/v2',implementationStatus:'prototype/unverified',inputStatus:'INPUT_INVALID',reasonCode:'KERNEL_BRANCH_DUPLICATE'},null,2));
  process.exit(0);
}
const canonicalByAlias = new Map(canonicalInput.cases.map((c) => [c.caseAlias, c]));
const results = input.cases.map((c) => {
  const base = {caseAlias:c.caseAlias,caseProductDigest:digest(c,'CP-RIR-RECOVERY-BRANCH-CASE-V2'),sharedBindingDigest:digest(input.sharedBinding,'CP-RIR-SHARED-BINDING-V2')};
  const cc = canonicalByAlias.get(c.caseAlias);
  if (!cc) return {...base,...fail('INPUT_INVALID','CANONICAL_CASE_NOT_FOUND')};
  if (digest(cc,'CP-RIR-CANONICAL-CASE-V2') !== c.canonicalCaseDigest) return {...base,...fail('INPUT_INVALID','CANONICAL_CASE_DIGEST_MISMATCH',{derived:digest(cc,'CP-RIR-CANONICAL-CASE-V2')})};
  const actualBranchKeys = c.branches.map(key).sort();
  if (new Set(c.branches.map((b) => b.branchId)).size !== c.branches.length) return {...base,...fail('INPUT_INVALID','DUPLICATE_BRANCH_ID')};
  if (JSON.stringify(expectedBranchKeys) !== JSON.stringify(actualBranchKeys)) return {...base,...fail('WITNESS_INVALID','BOUNDED_BRANCH_CLOSURE_MISMATCH',{expectedBranchKeys,actualBranchKeys})};
  const authorities = new Map(c.authoritativeSinks.map((s) => [s.sinkId, s]));
  if (authorities.size !== c.authoritativeSinks.length) return {...base,...fail('INPUT_INVALID','DUPLICATE_AUTHORITATIVE_SINK')};
  const branches = [];
  for (const b of c.branches) {
    const edge = cc.trace.concreteEvents[b.canonicalFact.canonicalStepIndex];
    if (!edge) return {...base,...fail('WITNESS_INVALID','CANONICAL_STEP_MISSING',{branchId:b.branchId})};
    for (const field of ['event','eventClass']) if (b.canonicalFact[field] !== edge[field]) return {...base,...fail('WITNESS_INVALID','CANONICAL_EVENT_FACT_MISMATCH',{branchId:b.branchId,field})};
    for (const field of ['effectId','sinkId','resourceId','multiplicity','versionDelta']) if (b.canonicalFact[field] !== edge.effect[field]) return {...base,...fail('WITNESS_INVALID','CANONICAL_EFFECT_FACT_MISMATCH',{branchId:b.branchId,field})};
    if (b.authorityRef !== b.canonicalFact.sinkId || b.sinkAfter.sinkId !== b.canonicalFact.sinkId) return {...base,...fail('WITNESS_INVALID','SINK_BINDING_MISMATCH',{branchId:b.branchId})};
    const authority = authorities.get(b.authorityRef);
    if (!authority || authority.resourceId !== b.canonicalFact.resourceId) return {...base,...fail('WITNESS_INVALID','AUTHORITATIVE_SINK_BINDING_MISMATCH',{branchId:b.branchId})};
    if (b.sinkAfter.versionAfter - authority.versionBefore !== b.canonicalFact.versionDelta) return {...base,...fail('WITNESS_INVALID','VERSION_DELTA_MISMATCH',{branchId:b.branchId})};
    if (b.schedulerChoice === 'DELIVER_RECEIPT' && (b.faultEvent !== 'NONE' || b.receiptClaim.state !== 'PRESENT_UNVERIFIED')) return {...base,...fail('WITNESS_INVALID','DELIVER_BRANCH_SEMANTICS_MISMATCH',{branchId:b.branchId})};
    if (b.schedulerChoice === 'DROP_RECEIPT' && (b.faultEvent !== 'RECEIPT_DROP' || b.receiptClaim.state !== 'LOST')) return {...base,...fail('WITNESS_INVALID','DROP_BRANCH_SEMANTICS_MISMATCH',{branchId:b.branchId})};
    if (b.schedulerChoice === 'CRASH_AFTER_EFFECT' && (b.faultEvent !== 'CRASH_RESTART' || b.receiptClaim.state !== 'ABSENT')) return {...base,...fail('WITNESS_INVALID','CRASH_BRANCH_SEMANTICS_MISMATCH',{branchId:b.branchId})};
    if (b.runtimeStatus === 'IN_DOUBT' && (b.publicDisposition !== 'DO_NOT_RETRY' || b.allowedActions.includes('COMPLETE_FORWARD'))) return {...base,...fail('INPUT_INVALID','IN_DOUBT_ACTION_CONTRADICTION',{branchId:b.branchId})};
    if (b.receiptClaim.atomicReplay !== 'VERIFIED' && b.sinkAfter.effectKnowledge === 'EFFECT_CONFIRMED') return {...base,...fail('UNKNOWN_INPUT_NOT_PROVEN','EFFECT_CONFIRMATION_REQUIRES_ATOMIC_REPLAY',{branchId:b.branchId})};
    branches.push({branchId:b.branchId,schedulerChoice:b.schedulerChoice,faultEvent:b.faultEvent,runtimeStatus:b.runtimeStatus,publicDisposition:b.publicDisposition,sinkId:b.sinkAfter.sinkId,declaredEffectReality:b.sinkAfter.declaredEffectReality,verifiedEffectReality:b.sinkAfter.verifiedEffectReality,effectKnowledge:b.sinkAfter.effectKnowledge,versionAfter:b.sinkAfter.versionAfter,utilityStatus:b.utilityStatus,causalScope:b.causalScope});
  }
  return {...base,status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'SUPPLIED_BRANCH_SET_CHECK_ONLY_EXTERNAL_EVIDENCE_UNVERIFIED',branchClosure:{mode:'SUPPLIED_BRANCH_SET_CHECK_ONLY',expectedCount:expectedBranchKeys.length,actualCount:branches.length,checked:true},productDimensions:['canonicalState','schedulerChoice','faultEvent','sinkRuntime','effectKnowledge','publicDisposition'],authorityBinding:c.authoritativeSinks.map((s)=>({sinkId:s.sinkId,resourceId:s.resourceId,ownerId:s.ownerId,writerId:s.writerId,epoch:s.epoch,generation:s.generation})),branches,unknownReasons:['REAL_SCHEDULER_EXPLORATION_NOT_IMPLEMENTED','SINK_REPLAY_NOT_IMPLEMENTED','RECEIPT_ATOMIC_REPLAY_NOT_IMPLEMENTED','ESCROW_REPLAY_NOT_IMPLEMENTED']};
});
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-recovery-branch-closure-output/v2',implementationStatus:'prototype/unverified',inputStatus:'VALID',inputDigest:digest(input,'CP-RIR-RECOVERY-BRANCH-INPUT-V2'),results},null,2));
