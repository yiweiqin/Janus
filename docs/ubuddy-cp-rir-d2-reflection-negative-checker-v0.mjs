#!/usr/bin/env node
// Research-only checker for a single safety-reflection negative witness.
import fs from 'node:fs';
const p = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-reflection-negative-v0.input.example.json', import.meta.url);
const x = JSON.parse(fs.readFileSync(p, 'utf8'));

const emit = (o) => console.log(JSON.stringify({
  schemaVersion: 'cp-rir/d2-reflection-negative-output/v0',
  implementationStatus: 'prototype/unverified',
  ...o,
}, null, 2));
const fail = (status, reasonCode, details = {}) => {
  emit({ status, reasonCode, counterexampleClass: null, safetyReflection: 'NOT_ESTABLISHED', ...details });
  process.exit(0);
};

const uniqueMap = (entries, label) => {
  const out = new Map();
  for (const entry of entries) {
    if (out.has(entry.from)) fail('INPUT_INVALID', `${label}_NOT_FUNCTIONAL`, { duplicateFrom: entry.from });
    out.set(entry.from, entry.to);
  }
  return out;
};

if (!Number.isSafeInteger(x.horizon) || x.horizon < 1) fail('INPUT_INVALID', 'INVALID_HORIZON');
if (x.trace.concreteEvents.length > x.horizon) fail('WITNESS_INVALID', 'TRACE_EXCEEDS_HORIZON');
if (x.trace.concreteEvents.length !== x.trace.abstractEvents.length) fail('WITNESS_INVALID', 'TRACE_LENGTH_MISMATCH');

for (const systemName of ['concrete', 'abstract']) {
  const system = x[systemName];
  const states = new Set(system.stateIds);
  if (!states.has(system.initialStateId)) fail('INPUT_INVALID', `${systemName.toUpperCase()}_INITIAL_STATE_UNKNOWN`);
  for (const state of [...system.terminalStateIds, ...system.badStateIds]) {
    if (!states.has(state)) fail('INPUT_INVALID', `${systemName.toUpperCase()}_DECLARED_STATE_UNKNOWN`, { state });
  }
  for (const edge of system.transitions) {
    if (!states.has(edge.from) || !states.has(edge.to)) fail('INPUT_INVALID', `${systemName.toUpperCase()}_EDGE_STATE_UNKNOWN`, { edge });
  }
}

const sm = uniqueMap(x.mapping.stateMap, 'STATE_MAP');
const em = uniqueMap(x.mapping.eventMap, 'EVENT_MAP');
if (sm.get(x.concrete.initialStateId) !== x.abstract.initialStateId) fail('INPUT_INVALID', 'INITIAL_STATE_MAP_MISMATCH');

let cs = x.concrete.initialStateId; let as = x.abstract.initialStateId;
for (let i = 0; i < x.trace.concreteEvents.length; i += 1) {
  const e = x.trace.concreteEvents[i];
  const suppliedAbstract = x.trace.abstractEvents[i];
  const edge = x.concrete.transitions.find((t) => t.from === cs && t.event === e.event && t.to === e.to && t.eventClass === e.eventClass);
  if (!edge) fail('WITNESS_INVALID', 'CONCRETE_EDGE_NOT_REPLAYABLE', { step: i });
  cs = edge.to;
  const ae = em.get(edge.event);
  if (!ae) fail('INPUT_INVALID', 'EVENT_MAP_NOT_TOTAL_ON_TRACE', { step: i, event: edge.event });
  if (edge.eventClass === 'UNMEDIATED_EFFECT' && (ae === 'STUTTER' || x.mapping.legalStutterEvents.includes(edge.event))) {
    fail('INPUT_INVALID', 'EFFECT_MAPPED_TO_STUTTER', { step: i, event: edge.event });
  }
  const aa = x.abstract.transitions.find((t) => t.from === as && t.event === ae);
  if (!aa) fail('WITNESS_INVALID', 'ABSTRACT_EDGE_NOT_REPLAYABLE', { step: i, mappedEvent: ae });
  if (edge.eventClass.endsWith('EFFECT')) {
    if (!aa.eventClass.endsWith('EFFECT')) fail('INPUT_INVALID', 'EFFECT_CLASS_NOT_PRESERVED', { step: i, concreteClass: edge.eventClass, abstractClass: aa.eventClass });
    for (const field of ['effectId', 'sinkId', 'resourceId', 'multiplicity', 'versionDelta']) {
      if (edge[field] !== aa[field]) fail('INPUT_INVALID', 'EFFECT_IDENTITY_OR_MULTIPLICITY_NOT_PRESERVED', { step: i, field, concrete: edge[field], abstract: aa[field] });
    }
  }
  if (suppliedAbstract.from !== aa.from || suppliedAbstract.event !== aa.event || suppliedAbstract.to !== aa.to || suppliedAbstract.eventClass !== aa.eventClass) {
    fail('WITNESS_INVALID', 'SUPPLIED_ABSTRACT_WITNESS_MISMATCH', { step: i });
  }
  as = aa.to;
  if (!sm.has(cs)) fail('INPUT_INVALID', 'STATE_MAP_NOT_TOTAL_ON_TRACE', { step: i, concreteState: cs });
  if (sm.get(cs) !== as) fail('WITNESS_INVALID', 'STATE_PROJECTION_MISMATCH', { step: i, concreteState: cs, projectedState: sm.get(cs), replayedAbstractState: as });
}
if (!x.concrete.terminalStateIds.includes(cs) || !x.abstract.terminalStateIds.includes(as)) fail('WITNESS_INVALID', 'TERMINAL_CLOSURE_FAILED', { concreteTerminal: cs, abstractTerminal: as });
const badConcrete = x.concrete.badStateIds.includes(cs) || x.trace.concreteEvents.some((e) => e.eventClass === 'UNMEDIATED_EFFECT');
const badAbstract = x.abstract.badStateIds.includes(as);
emit({
  status: badConcrete && !badAbstract ? 'MODEL_COUNTEREXAMPLE' : 'WITNESS_INVALID',
  reasonCode: badConcrete && !badAbstract ? 'BAD_CONCRETE_NOT_REFLECTED' : 'NEGATIVE_CONDITION_NOT_MET',
  counterexampleClass: badConcrete && !badAbstract ? 'REFLECTION_COUNTEREXAMPLE' : null,
  concreteTerminal: cs,
  abstractTerminal: as,
  badConcrete,
  badAbstract,
  safetyReflection: badConcrete && !badAbstract ? 'FAILED' : 'NOT_ESTABLISHED',
  checkedObligations: ['CONCRETE_REPLAY', 'ABSTRACT_WITNESS_REPLAY', 'STATE_PROJECTION', 'EFFECT_NON_STUTTER', 'TERMINAL_CLOSURE'],
  uncheckedObligations: ['CONTRACT_MONITOR_PRODUCT', 'FAULT_AUTOMATON_MEMBERSHIP', 'EFFECT_RECEIPT_REPLAY', 'COMPLETE_MEDIATION', 'CRASH_RECOVERY_PRODUCT'],
});
