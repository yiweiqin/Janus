#!/usr/bin/env node
// Unified answer-free D2 falsification reducer. Research prototype only.
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-canonical-suite-v0.input.example.json', import.meta.url);
const raw = fs.readFileSync(file, 'utf8');
const input = JSON.parse(raw);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const forbiddenKeys = /^(expected|gold|verdict|answerKey|mutationClass|planningGold|runtimeGold)$/i;

const walkKeys = (v, path = '') => {
  if (Array.isArray(v)) return v.flatMap((x, i) => walkKeys(x, `${path}/${i}`));
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => [forbiddenKeys.test(k) ? `${path}/${k}` : null, ...walkKeys(x, `${path}/${k}`)]).filter(Boolean);
};
const denied = walkKeys(input);
if (denied.length) {
  console.log(JSON.stringify({ schemaVersion:'cp-rir/d2-canonical-suite-output/v0', implementationStatus:'prototype/unverified', inputStatus:'INPUT_INVALID', reasonCode:'ANSWER_ISOLATION_KEY_DENIED', denied }, null, 2));
  process.exit(0);
}

const fail = (status, reasonCode, details = {}) => ({ status, reasonCode, boundedSemanticStatus: null, counterexampleClass: null, ...details });
const set = (xs) => new Set(xs);
const functional = (entries, label) => {
  const m = new Map();
  for (const e of entries) {
    if (m.has(e.from)) return { error: fail('INPUT_INVALID', `${label}_NOT_FUNCTIONAL`, { from: e.from }) };
    m.set(e.from, e.to);
  }
  return { map: m };
};
const sameEffect = (a, b) => ['effectId','sinkId','resourceId','multiplicity','versionDelta'].every((k) => a.effect[k] === b.effect[k]);

const checkCase = (c) => {
  for (const [label, system] of [['CONCRETE', c.concrete], ['ABSTRACT', c.abstract]]) {
    const states = set(system.stateIds);
    if (!states.has(system.initialStateId)) return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID', `${label}_INITIAL_UNKNOWN`) };
    for (const s of [...system.terminalStateIds, ...system.badStateIds]) if (!states.has(s)) return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID', `${label}_DECLARED_STATE_UNKNOWN`, { state:s }) };
    for (const e of system.transitions) if (!states.has(e.from) || !states.has(e.to)) return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID', `${label}_EDGE_STATE_UNKNOWN`, { edge:e }) };
  }
  const sm = functional(c.mapping.stateMap, 'STATE_MAP');
  const em = functional(c.mapping.eventMap, 'EVENT_MAP');
  if (sm.error) return { caseAlias:c.caseAlias, ...sm.error };
  if (em.error) return { caseAlias:c.caseAlias, ...em.error };
  let cs = c.concrete.initialStateId, as = c.abstract.initialStateId, ms = c.monitor.initialStateId, fs = c.fault.initialStateId;
  if (sm.map.get(cs) !== as) return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID','INITIAL_STATE_MAP_MISMATCH') };
  if (c.trace.concreteEvents.length > c.horizon) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','TRACE_EXCEEDS_HORIZON') };
  if (c.trace.concreteEvents.length !== c.trace.abstractEvents.length) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','TRACE_LENGTH_MISMATCH') };
  const prefixes = [];
  for (let i=0;i<c.trace.concreteEvents.length;i+=1) {
    const supplied = c.trace.concreteEvents[i];
    const edge = c.concrete.transitions.find((e) => e.from===cs && e.event===supplied.event && e.to===supplied.to && e.eventClass===supplied.eventClass && sameEffect(e,supplied));
    if (!edge) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','CONCRETE_EDGE_NOT_REPLAYABLE',{step:i}) };
    cs=edge.to;
    const mapped=em.map.get(edge.event);
    if (!mapped) return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID','EVENT_MAP_NOT_TOTAL',{step:i}) };
    const ae=c.abstract.transitions.find((e) => e.from===as && e.event===mapped);
    if (!ae) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','ABSTRACT_EDGE_NOT_REPLAYABLE',{step:i}) };
    if (edge.eventClass.endsWith('EFFECT') && ae.eventClass==='STUTTER') return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID','EFFECT_MAPPED_TO_STUTTER',{step:i}) };
    if (edge.eventClass.endsWith('EFFECT') && !ae.eventClass.endsWith('EFFECT')) return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID','EFFECT_CLASS_NOT_PRESERVED',{step:i}) };
    if (edge.eventClass.endsWith('EFFECT') && !sameEffect(edge,ae)) return { caseAlias:c.caseAlias, ...fail('INPUT_INVALID','EFFECT_IDENTITY_OR_MULTIPLICITY_NOT_PRESERVED',{step:i}) };
    const suppliedA=c.trace.abstractEvents[i];
    if (suppliedA.from!==ae.from || suppliedA.event!==ae.event || suppliedA.to!==ae.to || suppliedA.eventClass!==ae.eventClass || !sameEffect(suppliedA,ae)) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','SUPPLIED_ABSTRACT_WITNESS_MISMATCH',{step:i}) };
    as=ae.to;
    if (sm.map.get(cs)!==as) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','STATE_PROJECTION_MISMATCH',{step:i}) };
    const mr=c.monitor.rules.find((r) => r.from===ms && r.event===mapped);
    if (!mr) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','MONITOR_RULE_NOT_REPLAYABLE',{step:i}) };
    ms=mr.to;
    if (c.fault.faultEventIds.includes(edge.event)) {
      const fr=c.fault.transitions.find((r) => r.from===fs && r.event===edge.event);
      if (!fr) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','FAULT_RULE_NOT_REPLAYABLE',{step:i}) };
      fs=fr.to;
    }
    prefixes.push({step:i+1,concreteState:cs,abstractState:as,monitorState:ms,faultState:fs,badConcrete:c.concrete.badStateIds.includes(cs),badAbstract:c.abstract.badStateIds.includes(as)||c.monitor.violationStateIds.includes(ms)});
  }
  if (!c.concrete.terminalStateIds.includes(cs) || !c.abstract.terminalStateIds.includes(as)) return { caseAlias:c.caseAlias, ...fail('WITNESS_INVALID','TERMINAL_CLOSURE_FAILED') };
  const badConcrete=prefixes.some((p)=>p.badConcrete);
  const badAbstract=prefixes.some((p)=>p.badAbstract);
  if (badConcrete && !badAbstract) return {caseAlias:c.caseAlias,status:'MODEL_COUNTEREXAMPLE',reasonCode:'BAD_CONCRETE_NOT_REFLECTED',boundedSemanticStatus:'UNSAFE',counterexampleClass:'REFLECTION_COUNTEREXAMPLE',prefixes};
  if (badConcrete || badAbstract) return {caseAlias:c.caseAlias,status:'MODEL_COUNTEREXAMPLE',reasonCode:'REACHABLE_BAD_PRODUCT_STATE',boundedSemanticStatus:'UNSAFE',counterexampleClass:'ABSTRACT_UNSAFE',prefixes};
  return {caseAlias:c.caseAlias,status:'UNKNOWN_INPUT_NOT_PROVEN',reasonCode:'ATTESTATION_RECEIPT_RECOVERY_UNVERIFIED',boundedSemanticStatus:'BOUNDED_WITNESS_PASS',counterexampleClass:null,prefixes,uncheckedObligations:['EXHAUSTIVE_ALL_PATHS','ATTESTATION_SIGNATURE','RECEIPT_CRYPTOGRAPHY','RECOVERY_PRODUCT','REAL_SINK_ENFORCEMENT']};
};

const aliases=input.cases.map((c)=>c.caseAlias);
if (new Set(aliases).size!==aliases.length) {
  console.log(JSON.stringify({schemaVersion:'cp-rir/d2-canonical-suite-output/v0',implementationStatus:'prototype/unverified',inputStatus:'INPUT_INVALID',reasonCode:'DUPLICATE_CASE_ALIAS'},null,2));
  process.exit(0);
}
const results=input.cases.map(checkCase);
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-canonical-suite-output/v0',implementationStatus:'prototype/unverified',inputStatus:'VALID',inputDigest:digest(input),answerIsolation:{keyDenylist:'PASS',processNamespaceIsolation:'NOT_IMPLEMENTED'},results},null,2));
