#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

const base = new URL('.', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(typeof f === 'string' && /^[A-Za-z]:[\\/]/.test(f) ? f : f instanceof URL ? f : new URL(f, base), 'utf8'));
const input = read(process.argv[2] ?? './ubuddy-cp-rir-effect-complete-transfer-v0.input.example.json');
const cert = read(process.argv[3] ?? './ubuddy-cp-rir-effect-complete-transfer-certificate-v0.input.example.json');
const schema = read('./ubuddy-cp-rir-effect-complete-transfer-certificate-v0.schema.json');
const validate = new Ajv2020({ strict: false }).compile(schema);
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');
const key = (t) => `${t.concrete}|${t.abstract}|${t.monitor}`;
const emit = (status, reasonCode, extra = {}) => { console.log(JSON.stringify({ schemaVersion: 'cp-rir/effect-complete-transfer-certificate-output/v0', implementationStatus: 'prototype/unverified', status, reasonCode, ...extra }, null, 2)); process.exit(0); };

if (!validate(cert)) emit('INPUT_INVALID', 'CERTIFICATE_SCHEMA_INVALID');
const actual = digest(input);
if (cert.inputDigest !== actual) emit('PLAN_REJECT', 'INPUT_DIGEST_MISMATCH', { actual });
const byId = new Map(input.cases.map((c) => [c.caseId, c]));
for (const cc of cert.cases) {
  const c = byId.get(cc.caseId);
  if (!c) emit('PLAN_REJECT', 'UNKNOWN_CASE_ID', { caseId: cc.caseId });
  const sm = new Map(c.stateMap.map((x) => [x.concrete, x.abstract]));
  const em = new Map(c.eventMap.map((x) => [x.concrete, x.abstract]));
  const rules = new Map(c.monitor.rules.map((x) => [`${x.from}|${x.event}`, x.to]));
  const seen = new Set();
  const adjacency = new Map();
  for (const e of cc.productEdges) {
    const fromKey = key(e.from);
    const edgeKey = `${fromKey}|${e.event}|${e.depth}`;
    if (seen.has(edgeKey)) emit('PLAN_REJECT', 'DUPLICATE_CERTIFICATE_EDGE', { caseId: cc.caseId, edge: edgeKey });
    seen.add(edgeKey);
    if (sm.get(e.from.concrete) !== e.from.abstract || sm.get(e.to.concrete) !== e.to.abstract) emit('PLAN_REJECT', 'STATE_MAP_CERTIFICATE_MISMATCH', { caseId: cc.caseId, event: e.event });
    if (em.get(e.event) !== e.mappedEvent) emit('PLAN_REJECT', 'EVENT_MAP_CERTIFICATE_MISMATCH', { caseId: cc.caseId, event: e.event });
    const tr = c.concreteSystem.transitions.find((x) => x.from === e.from.concrete && x.event === e.event && x.to === e.to.concrete);
    if (!tr) emit('PLAN_REJECT', 'CONCRETE_EDGE_CERTIFICATE_NOT_FOUND', { caseId: cc.caseId, event: e.event });
    const ar = c.abstractSystem.transitions.find((x) => x.from === e.from.abstract && x.event === e.mappedEvent && x.to === e.to.abstract);
    if (!ar) emit('PLAN_REJECT', 'ABSTRACT_EDGE_CERTIFICATE_NOT_FOUND', { caseId: cc.caseId, event: e.event });
    if (rules.get(`${e.from.monitor}|${e.mappedEvent}`) !== e.to.monitor) emit('PLAN_REJECT', 'MONITOR_EDGE_CERTIFICATE_NOT_FOUND', { caseId: cc.caseId, event: e.event });
    if (JSON.stringify([...tr.effectFootprint].sort()) !== JSON.stringify([...e.concreteEffectFootprint].sort()) || JSON.stringify([...ar.effectFootprint].sort()) !== JSON.stringify([...e.abstractEffectFootprint].sort())) emit('PLAN_REJECT', 'EFFECT_FOOTPRINT_CERTIFICATE_MISMATCH', { caseId: cc.caseId, event: e.event });
    if (JSON.stringify([...tr.effectFootprint].sort()) !== JSON.stringify([...ar.effectFootprint].sort())) emit('PLAN_REJECT', 'EFFECT_FOOTPRINT_NOT_PRESERVED', { caseId: cc.caseId, event: e.event });
    if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
    adjacency.get(fromKey).push(e.to);
  }
  const start = key({ concrete: c.concreteSystem.initialStateId, abstract: c.abstractSystem.initialStateId, monitor: c.monitor.initialStateId });
  const reachable = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const u = queue.shift();
    for (const t of adjacency.get(u) ?? []) {
      const v = key(t);
      if (!reachable.has(v)) { reachable.add(v); queue.push(v); }
    }
  }
  for (const t of cc.terminalTuples) {
    if (!c.concreteSystem.terminalStateIds.includes(t.concrete) || !c.abstractSystem.terminalStateIds.includes(t.abstract) || !c.monitor.terminalStateIds.includes(t.monitor)) emit('PLAN_REJECT', 'TERMINAL_TUPLE_NOT_CLOSED', { caseId: cc.caseId, tuple: t });
    if (!reachable.has(key(t))) emit('PLAN_REJECT', 'TERMINAL_TUPLE_NOT_REACHABLE', { caseId: cc.caseId, tuple: t });
  }
}
console.log(JSON.stringify({ schemaVersion: 'cp-rir/effect-complete-transfer-certificate-output/v0', implementationStatus: 'prototype/unverified', status: 'UNKNOWN_INPUT_NOT_PROVEN', reasonCode: 'CERTIFICATE_REPLAY_FINITE_ONLY', inputDigest: actual, casesChecked: cert.cases.map((c) => ({ caseId: c.caseId, edgeCount: c.productEdges.length, terminalCount: c.terminalTuples.length })), proofBoundary: ['NO_SIGNATURE_VERIFICATION', 'NO_RUNTIME_MEDIATION', 'NO_GENERAL_THEOREM'] }, null, 2));
