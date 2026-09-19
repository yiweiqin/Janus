#!/usr/bin/env node
// Research-only bounded checker prototype. No runtime integration or cryptographic trust anchor.
import fs from 'node:fs';
import crypto from 'node:crypto';

const path = process.argv[2] ?? new URL('./ubuddy-cp-rir-d2-positive-negative-v0.input.example.json', import.meta.url);
const input = JSON.parse(fs.readFileSync(path, 'utf8'));
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

const analyze = (c) => {
  const edges = c.concreteSystem.transitions;
  const abstractEdges = c.abstractSystem.transitions;
  const terminal = new Set(c.concreteSystem.terminalStateIds);
  const stateMap = new Map(c.abstraction.stateMap.map((x) => [x.concrete, x.abstract]));
  const eventMap = new Map(c.abstraction.eventMap.map((x) => [x.concrete, x.abstract]));
  const paths = [];
  const dfs = (state, trace = []) => {
    if (trace.length > input.horizon) return;
    if (terminal.has(state)) { paths.push(trace); return; }
    const outgoing = edges.filter((e) => e.from === state);
    if (outgoing.length === 0) throw new Error(`TERMINAL_CLOSURE:${c.caseId}/${state}`);
    for (const edge of outgoing) dfs(edge.to, [...trace, edge]);
  };
  dfs(c.concreteSystem.initialStateId);
  if (c.coverageMode === 'EXHAUSTIVE_UP_TO_H') {
    const derived = paths.map((p) => p.map((e) => e.event).join(',')).sort();
    const supplied = c.reachableTraces.map((p) => p.concreteEvents.map((e) => e.event).join(',')).sort();
    if (JSON.stringify(derived) !== JSON.stringify(supplied)) throw new Error(`WITNESS_INVALID:${c.caseId}/coverage`);
  }
  const analyzed = [];
  for (const trace of c.reachableTraces) {
    let concreteState = c.concreteSystem.initialStateId;
    let abstractState = c.abstractSystem.initialStateId;
    let faultState = c.faultAutomaton.initialStateId;
    const faultStates = [];
    const projected = [];
    for (const supplied of trace.concreteEvents) {
      const edge = edges.find((e) => e.from === concreteState && e.event === supplied.event && e.to === supplied.to);
      if (!edge) throw new Error(`WITNESS_INVALID:${c.caseId}/${supplied.event}`);
      concreteState = edge.to;
      const abstractEvent = eventMap.get(edge.event);
      if (!abstractEvent) throw new Error(`INPUT_INVALID:${c.caseId}/eventMap/${edge.event}`);
      if (edge.eventClass.includes('EFFECT') && c.abstraction.legalStutterEvents.includes(edge.event)) throw new Error(`INPUT_INVALID:${c.caseId}/effect-stutter`);
      const abstractEdge = abstractEdges.find((e) => e.from === abstractState && e.event === abstractEvent);
      if (!abstractEdge) throw new Error(`WITNESS_INVALID:${c.caseId}/abstract/${abstractEvent}`);
      abstractState = abstractEdge.to;
      projected.push(abstractEvent);
      if (c.faultAutomaton.faultEventIds.includes(edge.event)) {
        const ft = c.faultAutomaton.transitions.find((x) => x.from === faultState && x.event === edge.event);
        if (!ft) throw new Error(`WITNESS_INVALID:${c.caseId}/fault/${edge.event}`);
        faultState = ft.to;
      }
      faultStates.push(faultState);
    }
    if (JSON.stringify(faultStates) !== JSON.stringify(trace.faultRun)) throw new Error(`WITNESS_INVALID:${c.caseId}/faultRun`);
    if (stateMap.get(concreteState) !== abstractState) throw new Error(`WITNESS_INVALID:${c.caseId}/stateProjection`);
    analyzed.push({ concreteEvents: trace.concreteEvents.map((e) => e.event), projectedAbstractTrace: projected, concreteTerminal: concreteState, abstractTerminal: abstractState, badConcrete: trace.concreteEvents.some((e) => e.eventClass === 'UNMEDIATED_EFFECT'), badAbstract: c.abstractSystem.badStateIds.includes(abstractState) });
  }
  const bad = analyzed.filter((t) => t.badConcrete || t.badAbstract);
  const evidence = c.mediationEvidence;
  const materializedMediation = evidence.writerUniverse.closed && evidence.sinkEnforcement.length >= 2 && evidence.credentialAttestations.length >= 2;
  return {
    caseId: c.caseId,
    status: bad.length ? 'MODEL_COUNTEREXAMPLE' : materializedMediation ? 'UNKNOWN_INPUT_NOT_PROVEN' : 'UNKNOWN_INPUT_NOT_PROVEN',
    reasonCode: bad.length ? 'REACHABLE_BAD_STATE' : 'ATTESTATION_SIGNATURE_UNVERIFIED',
    boundedSemanticStatus: bad.length ? 'UNSAFE' : 'BOUNDED_FIXTURE_PASS',
    counterexampleClass: bad.length ? (bad.some((t) => t.badConcrete && !t.badAbstract) ? 'REFLECTION_COUNTEREXAMPLE' : 'ABSTRACT_UNSAFE') : null,
    inputDigest: digest(c),
    reachableStateCoverage: { mode: c.coverageMode, suppliedTraceCount: c.reachableTraces.length, enumeratedTerminalPathCount: paths.length },
    completeMediationCheck: { claim: evidence.completeMediationClaim, writerUniverseClosed: evidence.writerUniverse.closed, materializedStructurePresent: materializedMediation, cryptographicVerification: 'NOT_IMPLEMENTED' },
    badPredicateCoverage: { predicate: c.abstraction.badConcretePredicate, badTraceCount: bad.length },
    counterexampleKind: bad.length ? (bad.some((t) => t.badConcrete && !t.badAbstract) ? 'REFLECTION_COUNTEREXAMPLE' : 'ABSTRACT_UNSAFE') : null,
    shortestConcreteCounterexample: bad.length ? bad.sort((a, b) => a.concreteEvents.length - b.concreteEvents.length)[0].concreteEvents : null,
    traces: analyzed
  };
};

try {
  const results = input.cases.map(analyze);
  console.log(JSON.stringify({ schemaVersion: 'cp-rir/d2-pair-checker-output/v0', implementationStatus: 'prototype/unverified', inputDigest: digest(input), results }, null, 2));
} catch (e) {
  const message = String(e.message ?? e);
  const status = message.startsWith('INPUT_INVALID') ? 'INPUT_INVALID' : message.startsWith('WITNESS_INVALID') || message.startsWith('TERMINAL_CLOSURE') ? 'WITNESS_INVALID' : 'UNKNOWN_INPUT_NOT_PROVEN';
  console.log(JSON.stringify({ schemaVersion: 'cp-rir/d2-pair-checker-output/v0', implementationStatus: 'prototype/unverified', status, reasonCode: message }, null, 2));
}
