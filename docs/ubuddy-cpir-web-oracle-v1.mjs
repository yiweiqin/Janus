/*
 * Candidate-independent finite transition oracle for CPIR-Web.
 *
 * This is a research-prototype/unverified artifact.  It deliberately consumes
 * a frozen manifest instead of a planner callback: every candidate (CPIR,
 * POMDP, MUS, or a mature Web stack) must query the same pure oracle.
 * It is not a browser broker, OAuth verifier, durable store, or runtime safety
 * proof.
 */
import {createHash} from 'node:crypto';
import {verifySignedAuthorityLog} from './ubuddy-cpir-web-authority-signed-log-v1.mjs';

const clone = value => value === undefined ? undefined : structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;

export const digest = (domain, value) => createHash('sha256')
  .update(`${domain}\0${JSON.stringify(canonical(value))}`)
  .digest('hex');

const REQUIRED_HASH_FIELDS = ['contractRegistryHash', 'observationProjectorHash', 'transitionVerifierHash'];
const CANDIDATE_DEPENDENT_KEYS = new Set(['candidate', 'policy', 'baseline', 'safebyworld', 'expectedverdict', 'goldverdict', 'oracleanswer', 'actionresults', 'proberesults']);
const UNKNOWN_FAULTS = new Set(['TIMEOUT', 'BOUND_EXCEEDED', 'INCOMPLETE_EVIDENCE', 'MISSING_AUTHORITY', 'MISSING_RECEIPT']);

function keyIsCandidateDependent(key) {
  return CANDIDATE_DEPENDENT_KEYS.has(String(key).toLowerCase());
}

function scanCandidateDependent(value, path = '$', found = []) {
  if (Array.isArray(value)) value.forEach((item, index) => scanCandidateDependent(item, `${path}[${index}]`, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (keyIsCandidateDependent(key)) found.push(`${path}.${key}`);
      scanCandidateDependent(item, `${path}.${key}`, found);
    }
  }
  return found;
}

function uniqueIds(items, label, errors) {
  if (!Array.isArray(items)) { errors.push(`${label}_MUST_BE_ARRAY`); return; }
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id) errors.push(`${label}_ID_MISSING`);
    else if (seen.has(item.id)) errors.push(`${label}_ID_DUPLICATE:${item.id}`);
    else seen.add(item.id);
  }
}

export function validateOracleManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') errors.push('MANIFEST_NOT_OBJECT');
  if (manifest?.schemaVersion !== 'cpir-web/oracle/v1') errors.push('SCHEMA_VERSION_UNSUPPORTED');
  if (!manifest?.manifestId) errors.push('MANIFEST_ID_MISSING');
  for (const field of REQUIRED_HASH_FIELDS) if (typeof manifest?.[field] !== 'string' || !manifest[field]) errors.push(`HASH_MISSING:${field}`);
  if (!Array.isArray(manifest?.trustRootHashes) || manifest.trustRootHashes.length === 0 || manifest.trustRootHashes.some(item => typeof item !== 'string' || !item)) errors.push('TRUST_ROOT_HASHES_INVALID');
  if (!Array.isArray(manifest?.observationProjector?.fields)) errors.push('OBSERVATION_PROJECTOR_FIELDS_INVALID');
  if (!manifest?.budget || typeof manifest.budget.maxCost !== 'number' || manifest.budget.maxCost < 0) errors.push('BUDGET_INVALID');
  uniqueIds(manifest?.worlds, 'WORLD', errors);
  uniqueIds(manifest?.actions, 'ACTION', errors);
  uniqueIds(manifest?.probes, 'PROBE', errors);
  uniqueIds(manifest?.faultSchedules, 'FAULT_SCHEDULE', errors);
  for (const action of manifest?.actions ?? []) {
    if (!Number.isFinite(action.cost) || action.cost < 0) errors.push(`ACTION_COST_INVALID:${action.id}`);
    if (!action.transition || !Array.isArray(action.transition.guards)) errors.push(`ACTION_TRANSITION_INVALID:${action.id}`);
  }
  for (const probe of manifest?.probes ?? []) {
    if (!Number.isFinite(probe.cost) || probe.cost < 0) errors.push(`PROBE_COST_INVALID:${probe.id}`);
    if (probe.effectClass !== 'READ_ONLY') errors.push(`PROBE_NOT_READ_ONLY:${probe.id}`);
    if (!Array.isArray(probe.projection)) errors.push(`PROBE_PROJECTION_INVALID:${probe.id}`);
  }
  for (const schedule of manifest?.faultSchedules ?? []) {
    if (!Array.isArray(schedule.events)) errors.push(`FAULT_EVENTS_INVALID:${schedule.id}`);
    const eventIds = new Set();
    for (const event of schedule.events ?? []) {
      if (!event || typeof event.id !== 'string' || !event.id) errors.push(`FAULT_EVENT_ID_MISSING:${schedule.id}`);
      else if (eventIds.has(event.id)) errors.push(`FAULT_EVENT_ID_DUPLICATE:${schedule.id}:${event.id}`);
      else eventIds.add(event.id);
    }
  }
  const candidatePaths = scanCandidateDependent(manifest);
  for (const path of candidatePaths) errors.push(`CANDIDATE_DEPENDENT_FIELD:${path}`);
  return {valid: errors.length === 0, errors};
}

function projectObservation(raw, projector) {
  const fields = [...new Set(projector?.fields ?? [])].sort();
  return Object.fromEntries(fields.map(field => [field, raw && Object.hasOwn(raw, field) ? clone(raw[field]) : 'UNKNOWN']));
}

function applyPatch(state, patch) {
  if (!patch || typeof patch !== 'object') return state;
  return {...state, ...clone(patch)};
}

function getPath(root, path) {
  if (typeof path !== 'string' || !path) return undefined;
  return path.split('.').reduce((value, key) => value === undefined || value === null ? undefined : value[key], root);
}

function setPath(root, path, value) {
  const keys = path.split('.');
  let cursor = root;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = clone(value);
}

const resolveOperand = (operand, context) => operand && Object.hasOwn(operand, 'value') ? clone(operand.value) : getPath(context, operand?.path);

function evaluateGuard(guard, context) {
  const left = resolveOperand(guard.left, context);
  const right = resolveOperand(guard.right, context);
  if (guard.op === 'EQ' || guard.op === 'NEQ' || guard.op === 'DIGEST_EQ') {
    if (left === undefined || right === undefined) return {status: 'UNKNOWN', reasonCode: guard.unknownReason ?? 'GUARD_OPERAND_MISSING', guardId: guard.id};
    const equal = guard.op === 'DIGEST_EQ' ? digest('cpir-web/oracle/guard-digest/v1', left) === digest('cpir-web/oracle/guard-digest/v1', right) : JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const passed = guard.op === 'NEQ' ? !equal : equal;
    return {status: passed ? 'SAFE' : 'VIOLATED', reasonCode: passed ? 'GUARD_SATISFIED' : (guard.violationReason ?? 'GUARD_VIOLATED'), guardId: guard.id, left, right};
  }
  if (guard.op === 'TRUE') {
    if (left === undefined) return {status: 'UNKNOWN', reasonCode: guard.unknownReason ?? 'GUARD_OPERAND_MISSING', guardId: guard.id};
    return {status: left === true ? 'SAFE' : 'VIOLATED', reasonCode: left === true ? 'GUARD_SATISFIED' : (guard.violationReason ?? 'GUARD_VIOLATED'), guardId: guard.id, left};
  }
  if (guard.op === 'LTE_AFTER_DELTA') {
    const delta = resolveOperand(guard.delta, context);
    const max = resolveOperand(guard.max, context);
    if (![left, delta, max].every(Number.isFinite)) return {status: 'UNKNOWN', reasonCode: guard.unknownReason ?? 'CARDINALITY_EVIDENCE_INCOMPLETE', guardId: guard.id};
    return {status: left + delta <= max ? 'SAFE' : 'VIOLATED', reasonCode: left + delta <= max ? 'GUARD_SATISFIED' : (guard.violationReason ?? 'EFFECT_CARDINALITY_EXCEEDED'), guardId: guard.id, left, delta, max};
  }
  if (guard.op === 'CAPABILITY_ACTIVE') {
    const events = getPath(context, guard.eventsPath);
    const frontier = getPath(context, guard.frontierPath);
    const capabilityId = resolveOperand(guard.capabilityId, context);
    if (!Array.isArray(events) || !Number.isFinite(frontier) || capabilityId === undefined) return {status: 'UNKNOWN', reasonCode: guard.unknownReason ?? 'AUTHORITY_FRONTIER_INCOMPLETE', guardId: guard.id};
    const visible = events.filter(event => event.capabilityId === capabilityId && Number.isFinite(event.revision) && event.revision <= frontier).sort((a, b) => a.revision - b.revision);
    if (!visible.length) return {status: 'UNKNOWN', reasonCode: guard.unknownReason ?? 'CAPABILITY_STATUS_UNKNOWN', guardId: guard.id};
    const active = visible.at(-1).kind === 'ISSUE';
    return {status: active ? 'SAFE' : 'VIOLATED', reasonCode: active ? 'GUARD_SATISFIED' : (guard.violationReason ?? 'CAPABILITY_REVOKED'), guardId: guard.id, frontier, latestEvent: visible.at(-1)};
  }
  if (guard.op === 'SIGNED_CAPABILITY_ACTIVE') {
    const checked = verifySignedAuthorityLog({events: getPath(context, guard.eventsPath), keyRegistry: getPath(context, guard.keyRegistryPath), frontierRevision: getPath(context, guard.frontierPath), capabilityId: resolveOperand(guard.capabilityId, context)});
    return {status: checked.status, reasonCode: checked.status === 'SAFE' ? 'GUARD_SATISFIED' : (checked.status === 'VIOLATED' ? (guard.violationReason ?? checked.reasonCode) : checked.reasonCode), guardId: guard.id, signedAuthorityWitness: checked};
  }
  return {status: 'UNKNOWN', reasonCode: 'GUARD_OPERATOR_UNDECLARED', guardId: guard.id, op: guard.op};
}

function runActionTransition(action, state, world) {
  const context = {state, world, action};
  const guardWitnesses = action.transition.guards.map(guard => evaluateGuard(guard, context));
  const unknown = guardWitnesses.find(item => item.status === 'UNKNOWN');
  if (unknown) return {verdict: 'UNKNOWN', reasonCode: unknown.reasonCode, state, witness: {guardWitnesses}};
  const violated = guardWitnesses.find(item => item.status === 'VIOLATED');
  if (violated) return {verdict: 'VIOLATED', reasonCode: violated.reasonCode, state, witness: {guardWitnesses}};
  const next = clone(state);
  for (const update of action.transition.set ?? []) {
    const value = resolveOperand(update.value, {state: next, world, action});
    if (value === undefined) return {verdict: 'UNKNOWN', reasonCode: 'TRANSITION_SET_VALUE_MISSING', state, witness: {update, guardWitnesses}};
    setPath(next, update.path, value);
  }
  for (const increment of action.transition.increments ?? []) {
    const current = getPath(next, increment.path);
    const by = resolveOperand(increment.by, {state: next, world, action});
    if (!Number.isFinite(current) || !Number.isFinite(by)) return {verdict: 'UNKNOWN', reasonCode: 'TRANSITION_INCREMENT_VALUE_MISSING', state, witness: {increment, guardWitnesses}};
    setPath(next, increment.path, current + by);
  }
  return {verdict: 'SAFE', reasonCode: action.transition.successReason ?? 'TRANSITION_GUARDS_SATISFIED', state: next, witness: {guardWitnesses}};
}

function runProbe(probe, state, world) {
  const guards = (probe.guards ?? []).map(guard => evaluateGuard(guard, {state, world, probe}));
  const blocked = guards.find(item => item.status !== 'SAFE');
  if (blocked) return {verdict: blocked.status, reasonCode: blocked.reasonCode, state, observation: {}, witness: {guardWitnesses: guards}};
  const observation = {};
  for (const item of probe.projection) {
    const value = getPath({state, world, probe}, item.path);
    if (value === undefined) return {verdict: 'UNKNOWN', reasonCode: 'PROBE_EVIDENCE_INCOMPLETE', state, observation, witness: {field: item.field, path: item.path}};
    observation[item.field] = clone(value);
  }
  return {verdict: 'SAFE', reasonCode: 'READ_ONLY_PROBE_OBSERVED', state, observation, witness: {projection: probe.projection}};
}

function baseResult({verdict, reasonCode, worldId, selectedId, kind, publicObservation, trace, preState, postState, cost, witness, world}) {
  return {
    schemaVersion: 'cpir-web/oracle/v1',
    implementationStatus: 'research-prototype/unverified',
    verdict, reasonCode, worldId,
    selectedActionOrProbeId: selectedId,
    selectedKind: kind,
    canonicalObservation: publicObservation,
    transitionTrace: trace,
    preStateHash: digest('cpir-web/oracle/state/v1', preState),
    postStateHash: digest('cpir-web/oracle/state/v1', postState),
    linearizationWitness: clone(world?.linearizationWitness ?? null),
    activationVector: clone(postState?.activationVector ?? world?.activationVector ?? null),
    authorityAtoms: clone(postState?.authorityAtoms ?? world?.authorityAtoms ?? []),
    authorityFrontiers: clone(postState?.authorityFrontiers ?? world?.authorityFrontiers ?? {}),
    escrowBinding: clone(postState?.escrowBinding ?? world?.escrowBinding ?? null),
    sinkLedgerDelta: clone(world?.sinkLedgerDelta ?? null),
    witness: clone(witness ?? world?.witness ?? null),
    cost
  };
}

function unknownResult(args) { return baseResult({...args, verdict: 'UNKNOWN'}); }

export function evaluate(manifest, worldId, actionIdOrProbeId, eventScheduleId = 'none', observationBudget = manifest?.budget?.maxCost ?? 0) {
  try {
    const checked = validateOracleManifest(manifest);
    if (!checked.valid) return unknownResult({reasonCode: 'MANIFEST_INVALID', worldId, selectedId: actionIdOrProbeId, kind: 'UNKNOWN', publicObservation: {}, trace: [], preState: {}, postState: {}, cost: 0, witness: {errors: checked.errors}, world: null});
    if (!Number.isFinite(observationBudget) || observationBudget < 0) return unknownResult({reasonCode: 'OBSERVATION_BUDGET_INVALID', worldId, selectedId: actionIdOrProbeId, kind: 'UNKNOWN', publicObservation: {}, trace: [], preState: {}, postState: {}, cost: 0, witness: {}, world: null});
    const world = manifest.worlds.find(item => item.id === worldId);
    if (!world) return unknownResult({reasonCode: 'WORLD_NOT_DECLARED', worldId, selectedId: actionIdOrProbeId, kind: 'UNKNOWN', publicObservation: {}, trace: [], preState: {}, postState: {}, cost: 0, witness: {worldId}, world: null});
    const action = manifest.actions.find(item => item.id === actionIdOrProbeId);
    const probe = manifest.probes.find(item => item.id === actionIdOrProbeId);
    if (!action && !probe) return unknownResult({reasonCode: 'ACTION_OR_PROBE_NOT_DECLARED', worldId, selectedId: actionIdOrProbeId, kind: 'UNKNOWN', publicObservation: projectObservation(world.publicObservation, manifest.observationProjector), trace: [], preState: world.initialState ?? {}, postState: world.initialState ?? {}, cost: 0, witness: {}, world});
    if (action && probe) return unknownResult({reasonCode: 'ACTION_PROBE_ID_COLLISION', worldId, selectedId: actionIdOrProbeId, kind: 'UNKNOWN', publicObservation: {}, trace: [], preState: world.initialState ?? {}, postState: world.initialState ?? {}, cost: 0, witness: {}, world});
    const kind = action ? 'ACTION' : 'PROBE';
    const selected = action ?? probe;
    if (kind === 'PROBE' && probe.effectClass !== 'READ_ONLY') return unknownResult({reasonCode: 'PROBE_NOT_READ_ONLY', worldId, selectedId: actionIdOrProbeId, kind, publicObservation: {}, trace: [], preState: world.initialState ?? {}, postState: world.initialState ?? {}, cost: 0, witness: {}, world});
    const schedule = eventScheduleId === 'none' ? {id: 'none', events: []} : manifest.faultSchedules.find(item => item.id === eventScheduleId);
    if (!schedule) return unknownResult({reasonCode: 'FAULT_SCHEDULE_NOT_DECLARED', worldId, selectedId: actionIdOrProbeId, kind, publicObservation: {}, trace: [], preState: world.initialState ?? {}, postState: world.initialState ?? {}, cost: 0, witness: {eventScheduleId}, world});
    let state = clone(world.initialState ?? {});
    const trace = [];
    let cost = 0;
    for (const event of schedule.events) {
      cost += Number(event.cost ?? 0);
      const before = digest('cpir-web/oracle/state/v1', state);
      state = applyPatch(state, event.statePatch);
      const after = digest('cpir-web/oracle/state/v1', state);
      trace.push({type: 'FAULT_EVENT', eventId: event.id, fault: event.fault ?? null, preStateHash: before, postStateHash: after});
      if (UNKNOWN_FAULTS.has(event.fault)) {
        return unknownResult({reasonCode: `FAULT_${event.fault}`, worldId, selectedId: actionIdOrProbeId, kind, publicObservation: projectObservation(world.publicObservation, manifest.observationProjector), trace, preState: world.initialState ?? {}, postState: state, cost, witness: {eventId: event.id, fault: event.fault}, world});
      }
    }
    cost += Number(selected.cost ?? 0);
    const preState = clone(state);
    if (cost > observationBudget || cost > manifest.budget.maxCost) return unknownResult({reasonCode: 'OBSERVATION_BUDGET_EXCEEDED', worldId, selectedId: actionIdOrProbeId, kind, publicObservation: projectObservation(world.publicObservation, manifest.observationProjector), trace, preState, postState: state, cost, witness: {cost, observationBudget, manifestBudget: manifest.budget.maxCost}, world});
    const transitionResult = kind === 'ACTION' ? runActionTransition(action, state, world) : runProbe(probe, state, world);
    state = transitionResult.state;
    trace.push({type: kind, id: actionIdOrProbeId, preStateHash: digest('cpir-web/oracle/state/v1', preState), postStateHash: digest('cpir-web/oracle/state/v1', state), verdict: transitionResult.verdict});
    const rawObservation = kind === 'PROBE' ? transitionResult.observation : world.publicObservation;
    const result = baseResult({verdict: transitionResult.verdict, reasonCode: transitionResult.reasonCode, worldId, selectedId: actionIdOrProbeId, kind, publicObservation: projectObservation(rawObservation, manifest.observationProjector), trace, preState, postState: state, cost, witness: transitionResult.witness, world});
    if (kind === 'ACTION' && transitionResult.verdict === 'SAFE' && digest('cpir-web/oracle/state/v1', preState) !== digest('cpir-web/oracle/state/v1', state)) {
      result.linearizationWitness = {actionId: action.id, preStateHash: trace.at(-1).preStateHash, postStateHash: trace.at(-1).postStateHash};
      result.sinkLedgerDelta = {before: clone(preState.effectCount ?? null), after: clone(state.effectCount ?? null)};
    }
    return result;
  } catch (error) {
    return unknownResult({reasonCode: 'ORACLE_EXCEPTION', worldId, selectedId: actionIdOrProbeId, kind: 'UNKNOWN', publicObservation: {}, trace: [], preState: {}, postState: {}, cost: 0, witness: {error: String(error?.message ?? error)}, world: null});
  }
}

export function createOracle(manifest) {
  const frozenManifest = clone(manifest);
  const validation = validateOracleManifest(frozenManifest);
  return Object.freeze({
    validation,
    evaluate: (worldId, actionIdOrProbeId, eventScheduleId = 'none', observationBudget = frozenManifest?.budget?.maxCost ?? 0) => evaluate(frozenManifest, worldId, actionIdOrProbeId, eventScheduleId, observationBudget)
  });
}

export function materializeOracleTables(manifest, {eventScheduleId = 'none', observationBudget = manifest?.budget?.maxCost ?? 0} = {}) {
  const oracle = createOracle(manifest);
  const actionResults = {};
  const probeResults = {};
  for (const world of manifest.worlds ?? []) {
    actionResults[world.id] = Object.fromEntries((manifest.actions ?? []).map(action => [action.id, oracle.evaluate(world.id, action.id, eventScheduleId, observationBudget)]));
    probeResults[world.id] = Object.fromEntries((manifest.probes ?? []).map(probe => [probe.id, oracle.evaluate(world.id, probe.id, eventScheduleId, observationBudget)]));
  }
  return {schemaVersion: 'cpir-web/oracle-tables/v1', implementationStatus: 'research-prototype/unverified', eventScheduleId, observationBudget, tables: {actionResults, probeResults}};
}
