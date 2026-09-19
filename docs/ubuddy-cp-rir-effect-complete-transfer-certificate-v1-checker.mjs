#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

const base = new URL('.', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(typeof f === 'string' && /^[A-Za-z]:[\\/]/.test(f) ? f : f instanceof URL ? f : new URL(f, base), 'utf8'));
const input = read(process.argv[2] ?? './ubuddy-cp-rir-effect-complete-transfer-v0.input.example.json');
const cert = read(process.argv[3] ?? './ubuddy-cp-rir-effect-complete-transfer-certificate-v1.input.example.json');
const schema = read('./ubuddy-cp-rir-effect-complete-transfer-certificate-v1.schema.json');
const validate = new Ajv2020({ strict: false }).compile(schema);
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');
const key = (t) => `${t.concrete}|${t.abstract}|${t.monitor}`;
const emit = (status, reasonCode, extra = {}) => { console.log(JSON.stringify({ schemaVersion: 'cp-rir/effect-complete-transfer-certificate-output/v1', implementationStatus: 'prototype/unverified', status, reasonCode, ...extra }, null, 2)); process.exit(0); };
const dup = (xs, f) => { const seen = new Set(); for (const x of xs) { const k = f(x); if (seen.has(k)) return k; seen.add(k); } return null; };

if (!validate(cert)) emit('INPUT_INVALID', 'CERTIFICATE_SCHEMA_INVALID');
const actual = digest(input);
if (cert.inputDigest !== actual) emit('PLAN_REJECT', 'INPUT_DIGEST_MISMATCH', { actual });
if (cert.coverageMode !== 'EXHAUSTIVE_PRODUCT_UP_TO_H') emit('PLAN_REJECT', 'COVERAGE_MODE_UNSUPPORTED');
const inputIds = input.cases.map((c) => c.caseId);
const certIds = cert.cases.map((c) => c.caseId);
if (dup(input.cases, (c) => c.caseId) || dup(cert.cases, (c) => c.caseId) || inputIds.length !== certIds.length || inputIds.some((id) => !certIds.includes(id))) emit('PLAN_REJECT', 'CASE_SET_MISMATCH', { inputIds, certIds });

for (const cc of cert.cases) {
  const c = input.cases.find((x) => x.caseId === cc.caseId);
  if (cc.maxDepth !== input.horizon) emit('PLAN_REJECT', 'HORIZON_BINDING_MISMATCH', { caseId: cc.caseId, inputHorizon: input.horizon, maxDepth: cc.maxDepth });
  const stateDup = dup(c.stateMap, (x) => x.concrete); const eventDup = dup(c.eventMap, (x) => x.concrete); const monitorDup = dup(c.monitor.rules, (x) => `${x.from}|${x.event}`); const abstractDup = dup(c.abstractSystem.transitions, (x) => `${x.from}|${x.event}`);
  if (stateDup) emit('PLAN_REJECT', 'STATE_MAP_NOT_FUNCTIONAL', { caseId: cc.caseId, key: stateDup });
  if (eventDup) emit('PLAN_REJECT', 'EVENT_MAP_NOT_FUNCTIONAL', { caseId: cc.caseId, key: eventDup });
  if (monitorDup) emit('PLAN_REJECT', 'MONITOR_RULE_NOT_FUNCTIONAL', { caseId: cc.caseId, key: monitorDup });
  if (abstractDup) emit('PLAN_REJECT', 'ABSTRACT_TRANSITION_NOT_DETERMINISTIC', { caseId: cc.caseId, key: abstractDup });
  const sm = new Map(c.stateMap.map((x) => [x.concrete, x.abstract])); const em = new Map(c.eventMap.map((x) => [x.concrete, x.abstract])); const rules = new Map(c.monitor.rules.map((x) => [`${x.from}|${x.event}`, x.to]));
  if (sm.get(c.concreteSystem.initialStateId) !== c.abstractSystem.initialStateId) emit('PLAN_REJECT', 'INITIAL_STATE_RELATION_MISMATCH', { caseId: cc.caseId });
  if (c.concreteSystem.badStateIds.includes(c.concreteSystem.initialStateId) || c.monitor.violationStateIds.includes(c.monitor.initialStateId) || c.abstractSystem.badStateIds.includes(c.abstractSystem.initialStateId)) emit('PLAN_REJECT', 'INITIAL_BAD_PREFIX', { caseId: cc.caseId });
  for (const s of c.concreteSystem.terminalStateIds) if (c.concreteSystem.transitions.some((e) => e.from === s)) emit('PLAN_REJECT', 'TERMINAL_OUTGOING_UNCHECKED', { caseId: cc.caseId, state: s });
  for (const s of c.concreteSystem.stateIds) if (!sm.has(s)) emit('PLAN_REJECT', 'STATE_MAP_NOT_TOTAL', { caseId: cc.caseId, state: s });
  for (const e of c.concreteSystem.transitions) if (!em.has(e.event)) emit('PLAN_REJECT', 'EVENT_MAP_NOT_TOTAL', { caseId: cc.caseId, event: e.event });

  if (cc.caseStatus === 'COUNTEREXAMPLE') {
    if (!cc.counterexample || cc.productEdges.length || cc.terminalTuples.length || cc.reachableTupleCount !== 0) emit('PLAN_REJECT', 'COUNTEREXAMPLE_CASE_SHAPE_INVALID', { caseId: cc.caseId });
    let cs = c.concreteSystem.initialStateId, as = c.abstractSystem.initialStateId, ms = c.monitor.initialStateId, witnessed = null;
    for (const event of cc.counterexample) {
      const candidates = c.concreteSystem.transitions.filter((e) => e.from === cs && e.event === event); if (candidates.length !== 1) emit('PLAN_REJECT', 'COUNTEREXAMPLE_CONCRETE_STEP_INVALID', { caseId: cc.caseId, event });
      const tr = candidates[0], mapped = em.get(event), nextAbstract = sm.get(tr.to);
      if (mapped === 'STUTTER' && (tr.eventClass === 'MEDIATED_EFFECT' || tr.eventClass === 'UNMEDIATED_EFFECT' || tr.effectFootprint.length)) { witnessed = 'EFFECT_MAPPED_TO_STUTTER'; break; }
      if (mapped === 'STUTTER') { cs = tr.to; continue; }
      const at = c.abstractSystem.transitions.find((a) => a.from === as && a.event === mapped && a.to === nextAbstract); if (!at) { witnessed = 'ABSTRACT_STEP_MISSING'; break; }
      const monitorTo = rules.get(`${ms}|${mapped}`); if (monitorTo === undefined) { witnessed = 'MONITOR_STEP_MISSING'; break; }
      if (JSON.stringify([...tr.effectFootprint].sort()) !== JSON.stringify([...at.effectFootprint].sort())) { witnessed = 'EFFECT_FOOTPRINT_NOT_PRESERVED'; break; }
      const badC = c.concreteSystem.badStateIds.includes(tr.to) || tr.eventClass === 'UNMEDIATED_EFFECT', badA = c.abstractSystem.badStateIds.includes(at.to) || c.monitor.violationStateIds.includes(monitorTo); if (badC && !badA) { witnessed = 'BAD_CONCRETE_NOT_REFLECTED'; break; }
      cs = tr.to; as = at.to; ms = monitorTo;
    }
    if (!witnessed) emit('PLAN_REJECT', 'COUNTEREXAMPLE_NOT_REPLAYABLE', { caseId: cc.caseId });
    continue;
  }
  if (cc.counterexample) emit('PLAN_REJECT', 'PASS_CASE_HAS_COUNTEREXAMPLE', { caseId: cc.caseId });

  const supplied = new Map();
  for (const e of cc.productEdges) { const k = `${e.depth}|${key(e.from)}|${e.event}|${key(e.to)}`; if (supplied.has(k)) emit('PLAN_REJECT', 'DUPLICATE_CERTIFICATE_EDGE', { caseId: cc.caseId, edge: k }); supplied.set(k, e); }
  const start = { concrete: c.concreteSystem.initialStateId, abstract: c.abstractSystem.initialStateId, monitor: c.monitor.initialStateId };
  const queue = [{ tuple: start, depth: 0 }]; const visited = new Set([`0|${key(start)}`]); const expected = new Map(); const expectedTerminals = new Map();
  while (queue.length) {
    const { tuple, depth } = queue.shift();
    if (c.concreteSystem.badStateIds.includes(tuple.concrete) || c.abstractSystem.badStateIds.includes(tuple.abstract) || c.monitor.violationStateIds.includes(tuple.monitor)) emit('PLAN_REJECT', 'BAD_PREFIX_REACHABLE', { caseId: cc.caseId, tuple, depth });
    if (c.concreteSystem.terminalStateIds.includes(tuple.concrete)) {
      if (!c.abstractSystem.terminalStateIds.includes(tuple.abstract) || !c.monitor.terminalStateIds.includes(tuple.monitor)) emit('PLAN_REJECT', 'TERMINAL_CLOSURE_FAILED', { caseId: cc.caseId, tuple });
      expectedTerminals.set(`${depth}|${key(tuple)}`, { depth, ...tuple }); continue;
    }
    if (depth >= cc.maxDepth) emit('PLAN_REJECT', 'CERTIFICATE_HORIZON_UNCLOSED', { caseId: cc.caseId, tuple, depth });
    for (const tr of c.concreteSystem.transitions.filter((e) => e.from === tuple.concrete)) {
      const mapped = em.get(tr.event); const nextAbstract = sm.get(tr.to);
      if (mapped === 'STUTTER') {
        if (!c.legalStutterEvents.includes(tr.event) || tr.eventClass !== 'INTERNAL' || tr.effectFootprint.length || nextAbstract !== tuple.abstract) emit('PLAN_REJECT', 'EFFECTIVE_STUTTER_INVALID', { caseId: cc.caseId, event: tr.event });
        const nt = { concrete: tr.to, abstract: tuple.abstract, monitor: tuple.monitor }; expected.set(`${depth}|${key(tuple)}|${tr.event}|${key(nt)}`, { depth, from: tuple, event: tr.event, mappedEvent: mapped, to: nt, concreteEffectFootprint: tr.effectFootprint, abstractEffectFootprint: [] }); if (!visited.has(`${depth + 1}|${key(nt)}`)) { visited.add(`${depth + 1}|${key(nt)}`); queue.push({ tuple: nt, depth: depth + 1 }); } continue;
      }
      const at = c.abstractSystem.transitions.find((a) => a.from === tuple.abstract && a.event === mapped && a.to === nextAbstract); if (!at) emit('PLAN_REJECT', 'ABSTRACT_STEP_MISSING', { caseId: cc.caseId, event: tr.event });
      const monitorTo = rules.get(`${tuple.monitor}|${mapped}`); if (monitorTo === undefined) emit('PLAN_REJECT', 'MONITOR_STEP_MISSING', { caseId: cc.caseId, event: tr.event });
      const nt = { concrete: tr.to, abstract: at.to, monitor: monitorTo }; if (JSON.stringify([...tr.effectFootprint].sort()) !== JSON.stringify([...at.effectFootprint].sort())) emit('PLAN_REJECT', 'EFFECT_FOOTPRINT_NOT_PRESERVED', { caseId: cc.caseId, event: tr.event });
      const badC = c.concreteSystem.badStateIds.includes(tr.to) || tr.eventClass === 'UNMEDIATED_EFFECT'; const badA = c.abstractSystem.badStateIds.includes(at.to) || c.monitor.violationStateIds.includes(monitorTo); if (badC && !badA) emit('PLAN_REJECT', 'BAD_CONCRETE_NOT_REFLECTED', { caseId: cc.caseId, event: tr.event });
      expected.set(`${depth}|${key(tuple)}|${tr.event}|${key(nt)}`, { depth, from: tuple, event: tr.event, mappedEvent: mapped, to: nt, concreteEffectFootprint: tr.effectFootprint, abstractEffectFootprint: at.effectFootprint }); if (!visited.has(`${depth + 1}|${key(nt)}`)) { visited.add(`${depth + 1}|${key(nt)}`); queue.push({ tuple: nt, depth: depth + 1 }); }
    }
  }
  for (const [k, e] of expected) { const s = supplied.get(k); if (!s) emit('PLAN_REJECT', 'CERTIFICATE_EDGE_MISSING', { caseId: cc.caseId, edge: k }); if (JSON.stringify(canon(s)) !== JSON.stringify(canon(e))) emit('PLAN_REJECT', 'CERTIFICATE_EDGE_CONTENT_MISMATCH', { caseId: cc.caseId, edge: k }); }
  for (const k of supplied.keys()) if (!expected.has(k)) emit('PLAN_REJECT', 'CERTIFICATE_EDGE_SPURIOUS', { caseId: cc.caseId, edge: k });
  for (const t of cc.terminalTuples) { if (!expectedTerminals.has(`${t.depth}|${key(t)}`)) emit('PLAN_REJECT', 'TERMINAL_TUPLE_NOT_REACHABLE', { caseId: cc.caseId, tuple: t }); }
  for (const [k, t] of expectedTerminals) if (!cc.terminalTuples.some((x) => `${x.depth}|${key(x)}` === k)) emit('PLAN_REJECT', 'TERMINAL_TUPLE_MISSING', { caseId: cc.caseId, tuple: t });
  if (cc.reachableTupleCount !== visited.size) emit('PLAN_REJECT', 'REACHABLE_TUPLE_COUNT_MISMATCH', { caseId: cc.caseId, expected: visited.size, actual: cc.reachableTupleCount });
}
console.log(JSON.stringify({ schemaVersion: 'cp-rir/effect-complete-transfer-certificate-output/v1', implementationStatus: 'prototype/unverified', status: 'UNKNOWN_INPUT_NOT_PROVEN', reasonCode: 'EXHAUSTIVE_CERTIFICATE_REPLAY_FINITE_ONLY', inputDigest: actual, casesChecked: cert.cases.map((c) => ({ caseId: c.caseId, caseStatus: c.caseStatus, maxDepth: c.maxDepth, reachableTupleCount: c.reachableTupleCount, edgeCount: c.productEdges.length, terminalCount: c.terminalTuples.length })), proofBoundary: ['NO_SIGNATURE_VERIFICATION', 'NO_RUNTIME_MEDIATION', 'NO_GENERAL_THEOREM'] }, null, 2));
