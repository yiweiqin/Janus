#!/usr/bin/env node
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const base = new URL('.', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(typeof f === 'string' && /^[A-Za-z]:[\\/]/.test(f) ? f : f instanceof URL ? f : new URL(f, base), 'utf8'));
const input = read(process.argv[2] ?? './ubuddy-cp-rir-effect-complete-inductive-transfer-v0.input.example.json');
const schema = read('./ubuddy-cp-rir-effect-complete-inductive-transfer-v0.schema.json');
const validate = new Ajv2020({ strict: false }).compile(schema);
const key = (t) => JSON.stringify([t.concrete, t.abstract, t.monitor]);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const emit = (status, reasonCode, extra = {}) => { console.log(JSON.stringify({ schemaVersion: 'cp-rir/effect-complete-inductive-transfer-output/v1', implementationStatus: 'prototype/unverified', status, reasonCode, ...extra }, null, 2)); process.exit(0); };
const duplicate = (xs, f) => { const seen = new Set(); for (const x of xs) { const k = f(x); if (seen.has(k)) return k; seen.add(k); } return null; };
const requireSystem = (s, label, caseId) => {
  const states = new Set(s.stateIds);
  if (!states.has(s.initialStateId)) emit('PLAN_REJECT', `${label}_INITIAL_STATE_UNKNOWN`, { caseId, state: s.initialStateId });
  for (const q of s.terminalStateIds) if (!states.has(q)) emit('PLAN_REJECT', `${label}_TERMINAL_STATE_UNKNOWN`, { caseId, state: q });
  for (const q of s.badStateIds) if (!states.has(q)) emit('PLAN_REJECT', `${label}_BAD_STATE_UNKNOWN`, { caseId, state: q });
  for (const e of s.transitions) if (!states.has(e.from) || !states.has(e.to)) emit('PLAN_REJECT', `${label}_TRANSITION_STATE_UNKNOWN`, { caseId, event: e.event });
  for (const q of s.terminalStateIds) if (s.transitions.some((e) => e.from === q)) emit('PLAN_REJECT', `${label}_TERMINAL_OUTGOING_UNCHECKED`, { caseId, state: q });
};

if (!validate(input)) emit('INPUT_INVALID', 'SCHEMA_VALIDATION_FAILED');
if (duplicate(input.cases, (c) => c.caseId)) emit('INPUT_INVALID', 'DUPLICATE_CASE_ID');
const results = [];
for (const c of input.cases) {
  requireSystem(c.concreteSystem, 'CONCRETE', c.caseId);
  requireSystem(c.abstractSystem, 'ABSTRACT', c.caseId);
  const monitorStates = new Set(c.monitor.stateIds);
  if (!monitorStates.has(c.monitor.initialStateId)) emit('PLAN_REJECT', 'MONITOR_INITIAL_STATE_UNKNOWN', { caseId: c.caseId });
  for (const q of [...c.monitor.terminalStateIds, ...c.monitor.violationStateIds]) if (!monitorStates.has(q)) emit('PLAN_REJECT', 'MONITOR_DECLARED_STATE_UNKNOWN', { caseId: c.caseId, state: q });
  for (const r of c.monitor.rules) if (!monitorStates.has(r.from) || !monitorStates.has(r.to)) emit('PLAN_REJECT', 'MONITOR_RULE_STATE_UNKNOWN', { caseId: c.caseId, event: r.event });
  if (duplicate(c.stateMap, (x) => x.concrete)) emit('PLAN_REJECT', 'STATE_MAP_NOT_FUNCTIONAL', { caseId: c.caseId });
  if (duplicate(c.eventMap, (x) => x.concrete)) emit('PLAN_REJECT', 'EVENT_MAP_NOT_FUNCTIONAL', { caseId: c.caseId });
  if (duplicate(c.monitor.rules, (x) => `${JSON.stringify(x.from)}:${JSON.stringify(x.event)}`)) emit('PLAN_REJECT', 'MONITOR_RULE_NOT_FUNCTIONAL', { caseId: c.caseId });
  if (duplicate(c.abstractSystem.transitions, (x) => `${JSON.stringify(x.from)}:${JSON.stringify(x.event)}`)) emit('PLAN_REJECT', 'ABSTRACT_TRANSITION_NOT_DETERMINISTIC', { caseId: c.caseId });
  const concreteStates = new Set(c.concreteSystem.stateIds), abstractStates = new Set(c.abstractSystem.stateIds);
  const sm = new Map(c.stateMap.map((x) => [x.concrete, x.abstract])); const em = new Map(c.eventMap.map((x) => [x.concrete, x.abstract])); const rules = new Map(c.monitor.rules.map((x) => [`${JSON.stringify(x.from)}:${JSON.stringify(x.event)}`, x.to]));
  for (const x of c.stateMap) if (!concreteStates.has(x.concrete) || !abstractStates.has(x.abstract)) emit('PLAN_REJECT', 'STATE_MAP_REFERENCE_UNKNOWN', { caseId: c.caseId, mapping: x });
  for (const q of c.concreteSystem.stateIds) if (!sm.has(q)) emit('PLAN_REJECT', 'STATE_MAP_NOT_TOTAL', { caseId: c.caseId, state: q });
  const concreteEvents = new Set(c.concreteSystem.transitions.map((e) => e.event)), abstractEvents = new Set(c.abstractSystem.transitions.map((e) => e.event));
  for (const x of c.eventMap) if (!concreteEvents.has(x.concrete) || (x.abstract !== 'STUTTER' && !abstractEvents.has(x.abstract))) emit('PLAN_REJECT', 'EVENT_MAP_REFERENCE_UNKNOWN', { caseId: c.caseId, mapping: x });
  for (const e of concreteEvents) if (!em.has(e)) emit('PLAN_REJECT', 'EVENT_MAP_NOT_TOTAL', { caseId: c.caseId, event: e });
  if (sm.get(c.concreteSystem.initialStateId) !== c.abstractSystem.initialStateId) emit('PLAN_REJECT', 'INITIAL_STATE_RELATION_MISMATCH', { caseId: c.caseId });

  const replayStep = (tuple, event) => {
    const xs = c.concreteSystem.transitions.filter((e) => e.from === tuple.concrete && e.event === event);
    if (xs.length !== 1) return { failure: 'COUNTEREXAMPLE_CONCRETE_STEP_INVALID' };
    const tr = xs[0], mapped = em.get(event), nextAbstract = sm.get(tr.to);
    if (mapped === 'STUTTER') {
      if (tr.eventClass === 'MEDIATED_EFFECT' || tr.eventClass === 'UNMEDIATED_EFFECT' || tr.effectFootprint.length) return { failure: 'EFFECT_MAPPED_TO_STUTTER' };
      if (!c.legalStutterEvents.includes(event) || nextAbstract !== tuple.abstract) return { failure: 'EFFECTIVE_STUTTER_INVALID' };
      return { next: { concrete: tr.to, abstract: tuple.abstract, monitor: tuple.monitor } };
    }
    const at = c.abstractSystem.transitions.find((a) => a.from === tuple.abstract && a.event === mapped && a.to === nextAbstract);
    if (!at) return { failure: 'ABSTRACT_STEP_MISSING' };
    const monitorTo = rules.get(`${JSON.stringify(tuple.monitor)}:${JSON.stringify(mapped)}`);
    if (monitorTo === undefined) return { failure: 'MONITOR_STEP_MISSING' };
    if (!same(tr.effectFootprint, at.effectFootprint)) return { failure: 'EFFECT_FOOTPRINT_NOT_PRESERVED' };
    const badC = c.concreteSystem.badStateIds.includes(tr.to) || tr.eventClass === 'UNMEDIATED_EFFECT'; const badA = c.abstractSystem.badStateIds.includes(at.to) || c.monitor.violationStateIds.includes(monitorTo);
    if (badC && !badA) return { failure: 'BAD_CONCRETE_NOT_REFLECTED' };
    return { next: { concrete: tr.to, abstract: at.to, monitor: monitorTo } };
  };

  if (c.claimStatus === 'COUNTEREXAMPLE') {
    if (!c.counterexample || c.relation.length) emit('PLAN_REJECT', 'COUNTEREXAMPLE_CASE_SHAPE_INVALID', { caseId: c.caseId });
    let tuple = { concrete: c.concreteSystem.initialStateId, abstract: c.abstractSystem.initialStateId, monitor: c.monitor.initialStateId }, witnessed = null;
    for (const event of c.counterexample) { const r = replayStep(tuple, event); if (r.failure) { witnessed = r.failure; break; } tuple = r.next; }
    if (!witnessed) emit('PLAN_REJECT', 'COUNTEREXAMPLE_NOT_REPLAYABLE', { caseId: c.caseId });
    results.push({ caseId: c.caseId, claimStatus: 'COUNTEREXAMPLE', counterexampleClass: witnessed }); continue;
  }

  if (c.counterexample) emit('PLAN_REJECT', 'PASS_CASE_HAS_COUNTEREXAMPLE', { caseId: c.caseId });
  if (duplicate(c.relation, key)) emit('PLAN_REJECT', 'RELATION_NOT_SET', { caseId: c.caseId });
  for (const t of c.relation) if (!concreteStates.has(t.concrete) || !abstractStates.has(t.abstract) || !monitorStates.has(t.monitor)) emit('PLAN_REJECT', 'RELATION_TUPLE_STATE_UNKNOWN', { caseId: c.caseId, tuple: t });
  const relation = new Set(c.relation.map(key)); const initial = { concrete: c.concreteSystem.initialStateId, abstract: c.abstractSystem.initialStateId, monitor: c.monitor.initialStateId };
  if (!relation.has(key(initial))) emit('PLAN_REJECT', 'INITIAL_RELATION_MISSING', { caseId: c.caseId });
  const reachable = new Set([key(initial)]), queue = [initial];
  while (queue.length) {
    const t = queue.shift();
    if (sm.get(t.concrete) !== t.abstract) emit('PLAN_REJECT', 'RELATION_STATE_MAP_MISMATCH', { caseId: c.caseId, tuple: t });
    if (c.concreteSystem.badStateIds.includes(t.concrete) || c.abstractSystem.badStateIds.includes(t.abstract) || c.monitor.violationStateIds.includes(t.monitor)) emit('PLAN_REJECT', 'RELATION_CONTAINS_BAD_TUPLE', { caseId: c.caseId, tuple: t });
    if (c.concreteSystem.terminalStateIds.includes(t.concrete)) { if (!c.abstractSystem.terminalStateIds.includes(t.abstract) || !c.monitor.terminalStateIds.includes(t.monitor)) emit('PLAN_REJECT', 'TERMINAL_CLOSURE_FAILED', { caseId: c.caseId, tuple: t }); continue; }
    const outgoing = c.concreteSystem.transitions.filter((e) => e.from === t.concrete); if (!outgoing.length) emit('PLAN_REJECT', 'CONCRETE_DEADLOCK_NOT_TERMINAL', { caseId: c.caseId, tuple: t });
    for (const tr of outgoing) { const r = replayStep(t, tr.event); if (r.failure) emit('PLAN_REJECT', r.failure, { caseId: c.caseId, event: tr.event }); const k = key(r.next); if (!relation.has(k)) emit('PLAN_REJECT', 'RELATION_SUCCESSOR_NOT_CLOSED', { caseId: c.caseId, event: tr.event, successor: r.next }); if (!reachable.has(k)) { reachable.add(k); queue.push(r.next); } }
  }
  for (const t of c.relation) if (!reachable.has(key(t))) emit('PLAN_REJECT', 'RELATION_TUPLE_UNREACHABLE', { caseId: c.caseId, tuple: t });
  results.push({ caseId: c.caseId, claimStatus: 'PASS', relationSize: c.relation.length, reachableRelationSize: reachable.size, checkedObligations: ['STRUCTURAL_REFERENTIAL_INTEGRITY', 'INITIAL_IN_RELATION', 'EXACT_REACHABLE_RELATION', 'SUCCESSOR_CLOSURE', 'EFFECT_COMPLETENESS', 'BAD_PREFIX_REFLECTION', 'TERMINAL_CLOSURE'] });
}
console.log(JSON.stringify({ schemaVersion: 'cp-rir/effect-complete-inductive-transfer-output/v1', implementationStatus: 'prototype/unverified', status: 'UNKNOWN_INPUT_NOT_PROVEN', reasonCode: 'FINITE_EXACT_INDUCTIVE_RELATION_CHECKED_RUNTIME_UNVERIFIED', results, proofBoundary: ['FINITE_SUPPLIED_LTS_ONLY', 'NO_RUNTIME_MEDIATION_EVIDENCE', 'NO_PROOF_ASSISTANT_KERNEL', 'NO_LIVENESS_CLAIM'] }, null, 2));
