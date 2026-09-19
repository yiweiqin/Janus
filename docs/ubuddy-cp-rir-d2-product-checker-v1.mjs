#!/usr/bin/env node
// Research-only D2 product checker prototype.
// It is intentionally independent from the Janus runtime and does not read any gold corpus.
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-positive-negative-v0.input.example.json', import.meta.url);
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');
const fail = (status, reasonCode, details = {}) => ({ status, reasonCode, ...details });

const ids = (xs) => new Set(xs);
const checkSystem = (system, name) => {
  const states = ids(system.stateIds);
  if (!states.has(system.initialStateId)) return fail('INPUT_INVALID', `${name}_INITIAL_STATE_UNKNOWN`);
  for (const s of [...system.terminalStateIds, ...system.badStateIds]) if (!states.has(s)) return fail('INPUT_INVALID', `${name}_DECLARED_STATE_UNKNOWN`, { state: s });
  for (const e of system.transitions) {
    if (!states.has(e.from) || !states.has(e.to)) return fail('INPUT_INVALID', `${name}_EDGE_STATE_UNKNOWN`, { edge: e });
    if (!system.eventAlphabet.includes(e.event)) return fail('INPUT_INVALID', `${name}_EVENT_OUTSIDE_ALPHABET`, { event: e.event });
  }
  return null;
};

const checkMap = (entries, key, value, label) => {
  const out = new Map();
  for (const m of entries) {
    if (out.has(m[key])) return { error: fail('INPUT_INVALID', `${label}_NOT_FUNCTIONAL`, { from: m[key] }) };
    out.set(m[key], m[value]);
  }
  return { out };
};

const replay = (c, supplied) => {
  const concrete = c.concreteSystem;
  const abstract = c.abstractSystem;
  const monitor = c.monitor;
  const fault = c.faultAutomaton;
  const stateMapResult = checkMap(c.abstraction.stateMap, 'concrete', 'abstract', 'STATE_MAP');
  const eventMapResult = checkMap(c.abstraction.eventMap, 'concrete', 'abstract', 'EVENT_MAP');
  if (stateMapResult.error) return stateMapResult.error;
  if (eventMapResult.error) return eventMapResult.error;
  const stateMap = stateMapResult.out;
  const eventMap = eventMapResult.out;
  let cs = concrete.initialStateId;
  let as = abstract.initialStateId;
  let ms = monitor.initialStateId;
  let fs = fault.initialStateId;
  const faultRun = [];
  const projected = [];
  const monitorRun = [ms];
  const productPrefixes = [];
  const witnesses = supplied.effectWitnesses ?? [];
  const witnessByEvent = new Map(witnesses.map((w) => [w.event, w]));

  if (stateMap.get(cs) !== as) return fail('INPUT_INVALID', 'INITIAL_STATE_MAP_MISMATCH');
  if (supplied.concreteEvents.length > input.horizon) return fail('WITNESS_INVALID', 'TRACE_EXCEEDS_HORIZON');
  if (supplied.concreteEvents.length !== supplied.abstractEvents.length) return fail('WITNESS_INVALID', 'TRACE_LENGTH_MISMATCH');

  for (let i = 0; i < supplied.concreteEvents.length; i += 1) {
    const e = supplied.concreteEvents[i];
    const aeSupplied = supplied.abstractEvents[i];
    const edge = concrete.transitions.find((x) => x.from === cs && x.event === e.event && x.to === e.to && x.eventClass === e.eventClass);
    if (!edge) return fail('WITNESS_INVALID', 'CONCRETE_EDGE_NOT_REPLAYABLE', { step: i, event: e.event });
    cs = edge.to;
    const mappedEvent = eventMap.get(edge.event);
    if (!mappedEvent) return fail('INPUT_INVALID', 'EVENT_MAP_NOT_TOTAL_ON_TRACE', { step: i, event: edge.event });
    if (edge.eventClass === 'UNMEDIATED_EFFECT' && (mappedEvent === 'STUTTER' || c.abstraction.legalStutterEvents.includes(edge.event))) {
      return fail('INPUT_INVALID', 'EFFECT_MAPPED_TO_STUTTER', { step: i, event: edge.event });
    }
    const abstractEdge = abstract.transitions.find((x) => x.from === as && x.event === mappedEvent);
    if (!abstractEdge) return fail('WITNESS_INVALID', 'ABSTRACT_EDGE_NOT_REPLAYABLE', { step: i, mappedEvent });
    if (aeSupplied.from !== abstractEdge.from || aeSupplied.event !== abstractEdge.event || aeSupplied.to !== abstractEdge.to || aeSupplied.eventClass !== abstractEdge.eventClass) {
      return fail('WITNESS_INVALID', 'SUPPLIED_ABSTRACT_WITNESS_MISMATCH', { step: i });
    }
    as = abstractEdge.to;
    if (stateMap.get(cs) !== as) return fail('WITNESS_INVALID', 'STATE_PROJECTION_MISMATCH', { step: i, concreteState: cs, projectedState: stateMap.get(cs), abstractState: as });
    projected.push(mappedEvent);

    const rule = monitor.rules.find((x) => x.from === ms && x.event === mappedEvent);
    if (!rule) return fail('WITNESS_INVALID', 'MONITOR_RULE_NOT_REPLAYABLE', { step: i, monitorState: ms, event: mappedEvent });
    ms = rule.to;
    monitorRun.push(ms);
    if (!ids(monitor.stateIds).has(ms)) return fail('INPUT_INVALID', 'MONITOR_TARGET_UNKNOWN', { step: i, state: ms });

    if (fault.faultEventIds.includes(edge.event)) {
      const fr = fault.transitions.find((x) => x.from === fs && x.event === edge.event);
      if (!fr) return fail('WITNESS_INVALID', 'FAULT_TRANSITION_NOT_REPLAYABLE', { step: i, faultState: fs, event: edge.event });
      fs = fr.to;
    } else if (fault.normalEventPolicy !== 'SELF_LOOP') {
      return fail('INPUT_INVALID', 'UNSUPPORTED_NORMAL_FAULT_POLICY', { policy: fault.normalEventPolicy });
    }
    if (!ids(fault.stateIds).has(fs)) return fail('INPUT_INVALID', 'FAULT_TARGET_UNKNOWN', { step: i, state: fs });
    faultRun.push(fs);

    if (edge.eventClass === 'MEDIATED_EFFECT') {
      const w = witnessByEvent.get(edge.event);
      if (!w) return fail('WITNESS_INVALID', 'MEDIATED_EFFECT_WITNESS_MISSING', { step: i, event: edge.event });
      for (const k of ['sinkId', 'resourceId', 'ownerId', 'writerId', 'versionBefore', 'versionAfter']) {
        if (w[k] !== edge[k]) return fail('WITNESS_INVALID', 'EFFECT_WITNESS_MISMATCH', { step: i, field: k, event: edge.event });
      }
      if (!Number.isInteger(w.linearizationIndex) || w.linearizationIndex < 0) return fail('WITNESS_INVALID', 'LINEARIZATION_INDEX_INVALID', { step: i });
    }
    productPrefixes.push({ step: i + 1, concreteState: cs, abstractState: as, monitorState: ms, faultState: fs, badConcretePrefix: concrete.badStateIds.includes(cs) || edge.eventClass === 'UNMEDIATED_EFFECT', badAbstractPrefix: abstract.badStateIds.includes(as) || monitor.violationStateIds.includes(ms) });
  }

  if (JSON.stringify(faultRun) !== JSON.stringify(supplied.faultRun)) return fail('WITNESS_INVALID', 'FAULT_RUN_MISMATCH', { derived: faultRun, supplied: supplied.faultRun });
  const concreteTerminal = concrete.terminalStateIds.includes(cs);
  const abstractTerminal = abstract.terminalStateIds.includes(as);
  const monitorTerminal = monitor.terminalClosureStateIds.includes(ms);
  const badConcrete = productPrefixes.some((p) => p.badConcretePrefix);
  const badAbstract = productPrefixes.some((p) => p.badAbstractPrefix);
  if (!concreteTerminal || !abstractTerminal || (!badAbstract && !monitorTerminal)) return fail('WITNESS_INVALID', 'TERMINAL_CLOSURE_FAILED', { concreteState: cs, abstractState: as, monitorState: ms });
  return { concreteState: cs, abstractState: as, monitorState: ms, faultState: fs, projected, faultRun, monitorRun, productPrefixes, concreteTerminal, abstractTerminal, monitorTerminal, badConcrete, badAbstract };
};

const enumerate = (c) => {
  const terminal = ids(c.concreteSystem.terminalStateIds);
  const frontier = [];
  const terminals = [];
  const dfs = (state, trace) => {
    if (terminal.has(state)) { terminals.push(trace); return; }
    if (trace.length === input.horizon) { frontier.push(trace); return; }
    const out = c.concreteSystem.transitions.filter((e) => e.from === state);
    if (!out.length) { frontier.push(trace); return; }
    for (const e of out) dfs(e.to, [...trace, e]);
  };
  dfs(c.concreteSystem.initialStateId, []);
  return { terminals, frontier };
};

const analyze = (c) => {
  for (const [name, system] of [['CONCRETE', c.concreteSystem], ['ABSTRACT', c.abstractSystem]]) { const e = checkSystem(system, name); if (e) return { caseId: c.caseId, ...e }; }
  const enumeration = enumerate(c);
  const suppliedKeys = c.reachableTraces.map((t) => t.concreteEvents.map((e) => e.event).join(',')).sort();
  const enumeratedKeys = enumeration.terminals.map((t) => t.map((e) => e.event).join(',')).sort();
  if (c.coverageMode === 'EXHAUSTIVE_UP_TO_H' && JSON.stringify(suppliedKeys) !== JSON.stringify(enumeratedKeys)) return { caseId: c.caseId, ...fail('WITNESS_INVALID', 'EXHAUSTIVE_TERMINAL_PATH_SET_MISMATCH', { suppliedKeys, enumeratedKeys }) };
  const traces = [];
  for (const t of c.reachableTraces) {
    const r = replay(c, t);
    if (r.status) return { caseId: c.caseId, ...r };
    traces.push({ concreteEvents: t.concreteEvents.map((e) => e.event), projectedAbstractTrace: r.projected, concreteTerminal: r.concreteState, abstractTerminal: r.abstractState, monitorTerminal: r.monitorState, faultTerminal: r.faultState, badConcrete: r.badConcrete, badAbstract: r.badAbstract, productPrefixes: r.productPrefixes });
  }
  if (enumeration.frontier.length) return { caseId: c.caseId, ...fail('MODEL_COUNTEREXAMPLE', 'HORIZON_FRONTIER_UNCLOSED', { boundedSemanticStatus: 'FRONTIER_UNCLOSED', frontierCount: enumeration.frontier.length, traces }) };
  const bad = traces.filter((t) => t.badConcrete || t.badAbstract);
  const reflectionFailure = traces.find((t) => t.badConcrete && !t.badAbstract);
  const evidence = c.mediationEvidence;
  const structurePresent = evidence.writerUniverse.closed && evidence.sinkEnforcement.length >= 2 && evidence.credentialAttestations.length >= 2;
  return {
    caseId: c.caseId,
    status: bad.length ? 'MODEL_COUNTEREXAMPLE' : 'UNKNOWN_INPUT_NOT_PROVEN',
    reasonCode: reflectionFailure ? 'BAD_CONCRETE_NOT_REFLECTED' : bad.length ? 'REACHABLE_BAD_PRODUCT_STATE' : 'ATTESTATION_SIGNATURE_UNVERIFIED',
    boundedSemanticStatus: bad.length ? 'UNSAFE' : 'BOUNDED_PRODUCT_PASS',
    counterexampleClass: reflectionFailure ? 'REFLECTION_COUNTEREXAMPLE' : bad.length ? 'ABSTRACT_UNSAFE' : null,
    reachableStateCoverage: { mode: c.coverageMode, suppliedTraceCount: c.reachableTraces.length, enumeratedTerminalPathCount: enumeration.terminals.length, hFrontierCount: enumeration.frontier.length },
    product: { dimensions: ['concreteState', 'abstractState', 'monitorState', 'faultState'], monitorInputLayer: c.monitor.inputLayer, checkedMonitorRules: true, checkedFaultTransitions: true, checkedBadPrefixes: true, checkedHFrontier: true },
    completeMediationCheck: { claim: evidence.completeMediationClaim, writerUniverseClosed: evidence.writerUniverse.closed, materializedStructurePresent: structurePresent, cryptographicVerification: 'NOT_IMPLEMENTED' },
    traces,
  };
};

const results = input.cases.map(analyze);
console.log(JSON.stringify({ schemaVersion: 'cp-rir/d2-product-checker-output/v1', implementationStatus: 'prototype/unverified', inputDigest: digest(input), results }, null, 2));
