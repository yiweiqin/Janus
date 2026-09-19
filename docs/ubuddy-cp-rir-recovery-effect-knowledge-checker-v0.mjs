#!/usr/bin/env node
// Research-only checker for orthogonal recovery/effect-knowledge snapshots.
import fs from 'node:fs';
const file = process.argv[2] ?? new URL('./ubuddy-cp-rir-recovery-effect-knowledge-v0.input.example.json', import.meta.url);
const x = JSON.parse(fs.readFileSync(file, 'utf8'));
const sinkIds = new Set((x.productStateModel?.initial?.sinks ?? []).map((s) => s.sinkId));
const allowed = new Set(x.productStateModel?.allowedActionDomain ?? []);
const out = { schemaVersion:'cp-rir/recovery-effect-knowledge-output/v0', implementationStatus:'prototype/unverified', status:'PROTOTYPE_OUTPUT', checks:[] };
const fail = (code, details={}) => { out.status='INPUT_INVALID'; out.checks.push({status:'FAIL',reasonCode:code,...details}); };
const pass = (code, details={}) => out.checks.push({status:'PASS',reasonCode:code,...(typeof details === 'string' ? {note:details} : details)});
const s = x.productStateModel?.initial;
if (!s || !Array.isArray(s.sinks) || s.sinks.length === 0) fail('PER_SINK_STATE_MISSING');
if (s && (!['SAFE','HARD_VIOLATION','UNKNOWN'].includes(s.globalSafety) || !x.productStateModel.globalSafetyDomain.includes(s.globalSafety))) fail('GLOBAL_SAFETY_OUTSIDE_DOMAIN');
if (s && (!x.productStateModel.recoveryPhaseDomain.includes(s.recoveryPhase) || !x.productStateModel.publicDispositionDomain.includes(s.publicDisposition))) fail('RECOVERY_OR_PUBLIC_STATE_OUTSIDE_DOMAIN');
if (s) {
  for (const a of s.allowedActions) if (!allowed.has(a)) fail('ALLOWED_ACTION_OUTSIDE_DOMAIN',{action:a});
  const seen = new Set();
  for (const sink of s.sinks) {
    if (seen.has(sink.sinkId)) fail('DUPLICATE_SINK_ID',{sinkId:sink.sinkId});
    seen.add(sink.sinkId);
    if (!sinkIds.has(sink.sinkId)) fail('SINK_ID_NOT_REGISTERED',{sinkId:sink.sinkId});
    if (sink.effectKnowledge === 'IN_DOUBT' && s.allowedActions.includes('RETRY_SAME_EFFECT')) fail('IN_DOUBT_RETRY_CONTRADICTION',{sinkId:sink.sinkId});
    if (sink.effectKnowledge === 'IN_DOUBT' && !s.allowedActions.includes('QUERY_RECEIPT') && !s.allowedActions.includes('MANUAL')) fail('IN_DOUBT_NO_RECONCILIATION_ACTION',{sinkId:sink.sinkId});
  }
  const applied = s.sinks.filter((q)=>q.effectReality==='CONFIRMED_APPLIED').length;
  const possible = s.sinks.filter((q)=>q.effectReality==='POSSIBLE_APPLIED').length;
  if (applied > 0 && possible > 0 && s.globalSafety !== 'HARD_VIOLATION') fail('HALF_COMMIT_SAFETY_NOT_RAISED');
  if (s.publicDisposition === 'IN_DOUBT' && !s.allowedActions.includes('QUERY_RECEIPT')) fail('PUBLIC_IN_DOUBT_WITHOUT_QUERY');
  pass('ORTHOGONAL_PRODUCT_STATE_CHECKED',{sinkCount:s.sinks.length,confirmedApplied:applied,possibleApplied:possible});
}
for (const t of x.transitions) {
  if (!x.states.includes(t.from) || !x.states.includes(t.to)) fail('TRANSITION_STATE_UNKNOWN',{transition:t});
  if (t.from==='IN_DOUBT' && t.retryDisposition==='RETRY_ALLOWED') fail('IN_DOUBT_RETRY_FORBIDDEN',{transition:t});
  if (t.event==='CRASH_BEFORE_EFFECT' && t.to==='NO_EFFECT_CONFIRMED') fail('CRASH_WITHOUT_NEGATIVE_WITNESS_NOT_NO_EFFECT',{transition:t});
  if (t.event==='VALID_RECEIPT_FOUND' && t.to==='EFFECT_CONFIRMED') out.checks.push({status:'UNVERIFIED',reasonCode:'RECEIPT_CONFIRMATION_REQUIRES_CRYPTO_ATOMICITY',transition:t});
}
pass('HISTORICAL_VIOLATION_NOT_ERASED','compensation/remediation remains orthogonal to original effect fact');
console.log(JSON.stringify(out,null,2));
