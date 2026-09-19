#!/usr/bin/env node
// Research-only integration checker. It joins the canonical D2 reducer with
// a recovery product, but does not claim runtime conformance or soundness.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const productFile = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-canonical-recovery-product-v1.input.example.json', import.meta.url);
const canonicalFile = process.argv[3] ?? new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.input.example.json', import.meta.url);
const product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
const canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');
const fail = (status, reasonCode, extra = {}) => ({ status, reasonCode, ...extra });
const forbidden = /^(expected|gold|verdict|answerKey|mutationClass|planningGold|runtimeGold)$/i;
const walk = (v, p = '') => Array.isArray(v) ? v.flatMap((x, i) => walk(x, `${p}/${i}`)) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [forbidden.test(k) ? `${p}/${k}` : null, ...walk(x, `${p}/${k}`)]).filter(Boolean) : [];
const ajv = new Ajv2020({ strict:false });
const productSchema = JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-canonical-recovery-product-v1.schema.json', import.meta.url), 'utf8'));
const canonicalSchema = JSON.parse(fs.readFileSync(new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.schema.json', import.meta.url), 'utf8'));
const validateProduct = ajv.compile(productSchema);
const validateCanonical = ajv.compile(canonicalSchema);
if (!validateProduct(product) || !validateCanonical(canonical)) {
  console.log(JSON.stringify({ schemaVersion:'cp-rir/d2-canonical-recovery-product-output/v1', implementationStatus:'prototype/unverified', inputStatus:'INPUT_INVALID', reasonCode:'SCHEMA_VALIDATION_FAILED', productErrors:validateProduct.errors ?? [], canonicalErrors:validateCanonical.errors ?? [] }, null, 2));
  process.exit(0);
}

const actionSet = new Set(['QUERY_RECEIPT','RESUME_IDEMPOTENT_TX','RETRY_SAME_EFFECT','COMPLETE_FORWARD','COMPENSATE','MANUAL']);
const stateNames = new Set(['PRE_EFFECT','EFFECT_POSSIBLE','EFFECT_CONFIRMED','NO_EFFECT_CONFIRMED','IN_DOUBT','REMEDIATED','HARD_VIOLATION','MANUAL_INTERVENTION']);
const transitionRules = new Map([
  ['MEDIATED_EFFECT_OBSERVED', new Map([['PRE_EFFECT',new Set(['EFFECT_POSSIBLE'])]])],
  ['UNMEDIATED_EFFECT_OBSERVED', new Map([['PRE_EFFECT',new Set(['HARD_VIOLATION'])],['EFFECT_POSSIBLE',new Set(['HARD_VIOLATION'])],['IN_DOUBT',new Set(['HARD_VIOLATION'])]])],
  ['RECEIPT_QUERY_UNAVAILABLE', new Map([['PRE_EFFECT',new Set(['IN_DOUBT'])],['EFFECT_POSSIBLE',new Set(['IN_DOUBT'])],['IN_DOUBT',new Set(['IN_DOUBT'])]])],
  ['VALID_RECEIPT_FOUND', new Map([['IN_DOUBT',new Set(['EFFECT_CONFIRMED'])],['EFFECT_POSSIBLE',new Set(['EFFECT_CONFIRMED'])]])],
  ['COMPENSATION_SUCCESS', new Map([['EFFECT_CONFIRMED',new Set(['REMEDIATED'])],['HARD_VIOLATION',new Set(['REMEDIATED'])]])],
  ['COMPENSATION_FAILURE', new Map([['EFFECT_CONFIRMED',new Set(['MANUAL_INTERVENTION'])],['HARD_VIOLATION',new Set(['MANUAL_INTERVENTION'])]])]
]);

const snapshotErrors = (s) => {
  const e = [];
  if (!stateNames.has(s.stateName)) e.push('STATE_NAME_UNKNOWN');
  const ids = s.sinks.map((x) => x.sinkId);
  if (new Set(ids).size !== ids.length) e.push('DUPLICATE_SINK_ID');
  for (const x of s.sinks) {
    if (x.effectReality === 'NOT_APPLIED' && ['EFFECT_CONFIRMED','EFFECT_POSSIBLE','IN_DOUBT'].includes(x.effectKnowledge)) e.push('NO_EFFECT_WITH_APPLIED_KNOWLEDGE');
    if (x.effectKnowledge === 'NO_EFFECT_CONFIRMED' && x.effectReality !== 'NOT_APPLIED') e.push('NO_EFFECT_KNOWLEDGE_WITH_APPLIED_REALITY');
    if (x.receiptState === 'DUPLICATE' && x.dedupState !== 'DUPLICATE') e.push('DUPLICATE_RECEIPT_DEDUP_MISMATCH');
    if (x.dedupState === 'DUPLICATE' && x.receiptState !== 'DUPLICATE') e.push('DUPLICATE_DEDUP_WITHOUT_DUPLICATE_RECEIPT');
  }
  if (s.stateName === 'IN_DOUBT' && s.allowedActions.includes('RETRY_SAME_EFFECT')) e.push('IN_DOUBT_RETRY_FORBIDDEN');
  if (['PRE_EFFECT','EFFECT_POSSIBLE'].includes(s.stateName) && s.allowedActions.includes('RETRY_SAME_EFFECT')) e.push('UNCONFIRMED_EFFECT_RETRY_FORBIDDEN');
  if (s.globalSafety === 'HARD_VIOLATION' && !s.historicalViolation) e.push('HARD_VIOLATION_HISTORY_MISSING');
  if (s.historicalViolation && s.stateName === 'NO_EFFECT_CONFIRMED') e.push('HISTORY_ERASED_AS_NO_EFFECT');
  for (const a of s.allowedActions) if (!actionSet.has(a)) e.push('ACTION_OUTSIDE_DOMAIN');
  return [...new Set(e)];
};

const asPath = (v) => v instanceof URL ? fileURLToPath(v) : v;
const canonicalRun = spawnSync(process.execPath, [fileURLToPath(new URL('./ubuddy-cp-rir-d2-canonical-reducer-v0.mjs', import.meta.url)), asPath(canonicalFile)], { encoding: 'utf8' });
let canonicalOutput;
try { canonicalOutput = JSON.parse(canonicalRun.stdout); } catch { canonicalOutput = { inputStatus:'UNKNOWN', reasonCode:'CANONICAL_REDUCER_OUTPUT_UNPARSEABLE' }; }
if (canonicalRun.status !== 0 || canonicalOutput.inputStatus !== 'VALID') {
  console.log(JSON.stringify({ schemaVersion:'cp-rir/d2-canonical-recovery-product-output/v1', implementationStatus:'prototype/unverified', inputStatus:'INPUT_INVALID', reasonCode:'CANONICAL_REDUCER_FAILED', reducerExitCode:canonicalRun.status, canonicalInputStatus:canonicalOutput.inputStatus, canonicalReasonCode:canonicalOutput.reasonCode }, null, 2));
  process.exit(0);
}
const canonicalByAlias = new Map((canonicalOutput.results ?? []).map((r) => [r.caseAlias, r]));
const canonicalInputByAlias = new Map((canonical.cases ?? []).map((c) => [c.caseAlias, c]));

if (walk(product).length) {
  console.log(JSON.stringify({ schemaVersion:'cp-rir/d2-canonical-recovery-product-output/v1', implementationStatus:'prototype/unverified', inputStatus:'INPUT_INVALID', reasonCode:'ANSWER_ISOLATION_KEY_DENIED', paths:walk(product) }, null, 2));
  process.exit(0);
}
const aliases = product.cases.map((c) => c.caseAlias);
if (new Set(aliases).size !== aliases.length) {
  console.log(JSON.stringify({ schemaVersion:'cp-rir/d2-canonical-recovery-product-output/v1', implementationStatus:'prototype/unverified', inputStatus:'INPUT_INVALID', reasonCode:'DUPLICATE_CASE_ALIAS' }, null, 2));
  process.exit(0);
}

const results = product.cases.map((c) => {
  const base = { caseAlias:c.caseAlias, productDigest:digest(c), sharedBindingDigest:digest(product.sharedBinding) };
  const cc = canonicalInputByAlias.get(c.caseAlias);
  if (!cc) return { ...base, ...fail('INPUT_INVALID','CANONICAL_CASE_NOT_FOUND') };
  if (digest(cc) !== c.canonicalCaseDigest) return { ...base, ...fail('INPUT_INVALID','CANONICAL_CASE_DIGEST_MISMATCH',{derivedCanonicalCaseDigest:digest(cc)}) };
  const allSnapshots = [c.initial, ...c.steps.map((x) => x.post), c.final];
  for (const s of allSnapshots) { const e = snapshotErrors(s); if (e.length) return { ...base, ...fail('INPUT_INVALID','RECOVERY_SNAPSHOT_INCONSISTENT',{errors:e}) }; }
  let current = c.initial.stateName;
  let lastCanonicalStepIndex = -1;
  for (let i = 0; i < c.steps.length; i += 1) {
    const st = c.steps[i];
    if (st.fromState !== current) return { ...base, ...fail('WITNESS_INVALID','RECOVERY_FROM_STATE_MISMATCH',{step:i,expected:current,provided:st.fromState}) };
    const canonicalEvents = cc.trace?.concreteEvents ?? [];
    if (!Number.isInteger(st.canonicalStepIndex) || st.canonicalStepIndex >= canonicalEvents.length || canonicalEvents[st.canonicalStepIndex].event !== st.canonicalEvent) return { ...base, ...fail('WITNESS_INVALID','CANONICAL_EVENT_BINDING_MISMATCH',{step:i,canonicalStepIndex:st.canonicalStepIndex,canonicalEvent:st.canonicalEvent}) };
    if (st.canonicalStepIndex <= lastCanonicalStepIndex) return { ...base, ...fail('WITNESS_INVALID','CANONICAL_STEP_ORDER_OR_REUSE_INVALID',{step:i,canonicalStepIndex:st.canonicalStepIndex,lastCanonicalStepIndex}) };
    lastCanonicalStepIndex = st.canonicalStepIndex;
    const canonicalEdge = canonicalEvents[st.canonicalStepIndex];
    if (st.event === 'MEDIATED_EFFECT_OBSERVED' && canonicalEdge.eventClass !== 'MEDIATED_EFFECT') return { ...base, ...fail('WITNESS_INVALID','RECOVERY_EVENT_CLASS_MISMATCH',{step:i}) };
    if (st.event === 'UNMEDIATED_EFFECT_OBSERVED' && canonicalEdge.eventClass !== 'UNMEDIATED_EFFECT') return { ...base, ...fail('WITNESS_INVALID','RECOVERY_EVENT_CLASS_MISMATCH',{step:i}) };
    const allowedFrom = transitionRules.get(st.event);
    if (!allowedFrom || !allowedFrom.has(st.fromState) || !allowedFrom.get(st.fromState).has(st.toState)) return { ...base, ...fail('WITNESS_INVALID','RECOVERY_EVENT_NOT_REPLAYABLE',{step:i,event:st.event,fromState:st.fromState,toState:st.toState}) };
    if (st.toState !== st.post.stateName) return { ...base, ...fail('WITNESS_INVALID','RECOVERY_TO_STATE_MISMATCH',{step:i}) };
    const before = i === 0 ? c.initial : c.steps[i - 1].post;
    const beforeBySink = new Map(before.sinks.map((x) => [x.sinkId, x]));
    const afterIds = new Set(st.post.sinks.map((x) => x.sinkId));
    if (afterIds.size !== beforeBySink.size || [...beforeBySink.keys()].some((id) => !afterIds.has(id))) return { ...base, ...fail('WITNESS_INVALID','RECOVERY_SINK_UNIVERSE_CHANGED',{step:i}) };
    if (canonicalEdge.effect?.sinkId && !afterIds.has(canonicalEdge.effect.sinkId)) return { ...base, ...fail('WITNESS_INVALID','CANONICAL_EFFECT_SINK_NOT_IN_RECOVERY_UNIVERSE',{step:i,sinkId:canonicalEdge.effect.sinkId}) };
    for (const sink of st.post.sinks) {
      const prev = beforeBySink.get(sink.sinkId);
      if (!prev) return { ...base, ...fail('WITNESS_INVALID','RECOVERY_SINK_UNIVERSE_CHANGED',{step:i,sinkId:sink.sinkId}) };
      if (sink.version < prev.version) return { ...base, ...fail('WITNESS_INVALID','VERSION_REGRESSION',{step:i,sinkId:sink.sinkId}) };
      const realityRank = { NOT_APPLIED:0, POSSIBLE_APPLIED:1, CONFIRMED_APPLIED:2 };
      if (realityRank[sink.effectReality] < realityRank[prev.effectReality]) return { ...base, ...fail('WITNESS_INVALID','EFFECT_REALITY_REGRESSION',{step:i,sinkId:sink.sinkId}) };
      if (prev.dedupState === 'UNIQUE' && sink.dedupState !== 'UNIQUE') return { ...base, ...fail('WITNESS_INVALID','DEDUP_STATE_REGRESSION',{step:i,sinkId:sink.sinkId}) };
      if (prev.receiptState === 'PRESENT_VERIFIED' && sink.receiptState !== 'PRESENT_VERIFIED') return { ...base, ...fail('WITNESS_INVALID','RECEIPT_STATE_REGRESSION',{step:i,sinkId:sink.sinkId}) };
    }
    if (st.toState === 'EFFECT_CONFIRMED' && (c.evidence.receiptReplay !== 'VERIFIED' || c.evidence.sinkEnforcement !== 'VERIFIED')) return { ...base, ...fail('UNKNOWN_INPUT_NOT_PROVEN','EFFECT_CONFIRMATION_REQUIRES_INDEPENDENT_REPLAY',{step:i}) };
    if (st.post.stateName === 'IN_DOUBT' && st.retryDisposition !== 'DO_NOT_RETRY') return { ...base, ...fail('INPUT_INVALID','IN_DOUBT_RETRY_DISPOSITION_CONTRADICTION',{step:i}) };
    current = st.toState;
  }
  if (c.final.stateName !== current) return { ...base, ...fail('WITNESS_INVALID','RECOVERY_FINAL_STATE_MISMATCH') };
  if (JSON.stringify(canon(c.final)) !== JSON.stringify(canon(c.steps.at(-1).post))) return { ...base, ...fail('WITNESS_INVALID','RECOVERY_FINAL_SNAPSHOT_MISMATCH') };
  const cr = canonicalByAlias.get(c.caseAlias);
  if (!cr) return { ...base, ...fail('UNKNOWN_INPUT_NOT_PROVEN','CANONICAL_RESULT_MISSING') };
  const unknownReasons = [...new Set(['RECEIPT_REPLAY_NOT_IMPLEMENTED','NEGATIVE_WITNESS_REPLAY_NOT_IMPLEMENTED','SINK_ENFORCEMENT_NOT_IMPLEMENTED','ESCROW_REACHABILITY_NOT_IMPLEMENTED'])];
  const modelTransferStatus = cr.status;
  const runtimeStatus = c.final.globalSafety === 'HARD_VIOLATION' ? 'HARD_VIOLATION' : c.final.stateName === 'IN_DOUBT' ? 'IN_DOUBT' : 'UNKNOWN';
  return { ...base, status:'COMPOSITE_STATUS_NOT_COLLAPSED', modelTransferStatus, runtimeStatus, reasonCode:'RECOVERY_AND_MEDIATION_EVIDENCE_UNVERIFIED', canonicalReasonCode:cr.reasonCode, boundedSemanticStatus:cr.boundedSemanticStatus, currentSafety:c.final.globalSafety, effectKnowledge:[...new Set(c.final.sinks.map((x)=>x.effectKnowledge))], perSinkRuntime:c.final.sinks, recovery:{stateName:c.final.stateName,recoveryPhase:c.final.recoveryPhase,publicDisposition:c.final.publicDisposition,allowedActions:c.final.allowedActions}, planningSafety:'NOT_EVALUATED', unknownReasons, planningBinding:{candidateDigest:product.sharedBinding.candidateDigest,worldDigest:product.sharedBinding.worldDigest,contractDigest:product.sharedBinding.contractDigest,faultDigest:product.sharedBinding.faultDigest,recoveryDigest:product.sharedBinding.recoveryDigest} };
});
console.log(JSON.stringify({ schemaVersion:'cp-rir/d2-canonical-recovery-product-output/v1', implementationStatus:'prototype/unverified', inputStatus:'VALID', observer:{solverVisible:['caseAlias','coarsePublicDisposition','productDigest'],processNamespaceIsolation:'NOT_IMPLEMENTED'}, results }, null, 2));
