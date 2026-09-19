/*
 * Research-only PC locked pair: a downstream capability may remain locally
 * fresh after an upstream authority frontier revoked its predecessor grant.
 * This compares a local-check mature stack, ABCA predecessor closure, and a
 * strongest mature stack augmented with the same causal frontier verifier.
 */
const clone = value => structuredClone(value);

function capabilityStatus(events, capabilityId, frontierRevision) {
  const visible = events.filter(event => event.capabilityId === capabilityId && event.revision <= frontierRevision).sort((a, b) => a.revision - b.revision);
  if (!visible.length) return 'UNKNOWN';
  return visible.at(-1).kind === 'REVOKE' ? 'REVOKED' : 'ACTIVE';
}

export function goldFromAuthorityLogs(world) {
  for (const atom of world.atoms) {
    for (const dependency of atom.predecessorRefs ?? []) {
      const authority = world.authorities[dependency.sourceId];
      if (!authority) return {verdict: 'UNKNOWN', reasonCode: 'GOLD_AUTHORITY_LOG_MISSING', dependency};
      const status = capabilityStatus(authority.events, dependency.capabilityId, authority.frontierRevision);
      if (status === 'REVOKED') return {verdict: 'REJECTED', reasonCode: 'GOLD_PREDECESSOR_REVOKED', dependency, frontierRevision: authority.frontierRevision};
      if (status !== 'ACTIVE') return {verdict: 'UNKNOWN', reasonCode: 'GOLD_PREDECESSOR_STATUS_UNKNOWN', dependency};
    }
  }
  return {verdict: 'SAFE', reasonCode: 'GOLD_PREDECESSORS_ACTIVE'};
}

export function evaluateLocalMatureStack(world) {
  const failed = world.atoms.find(atom => atom.signatureVerified !== true || atom.localFresh !== true || atom.localAuthorized !== true);
  return failed ? {verdict: 'REJECTED', reasonCode: 'LOCAL_AUTH_OR_FRESHNESS_FAILED', atomId: failed.atomId}
    : {verdict: 'SAFE', reasonCode: 'ALL_LOCAL_CHECKS_PASSED'};
}

export function evaluatePredecessorClosure(world) {
  for (const atom of world.atoms) {
    for (const dependency of atom.predecessorRefs ?? []) {
      const authority = world.authorities[dependency.sourceId];
      if (!authority) return {verdict: 'UNKNOWN', reasonCode: 'PREDECESSOR_AUTHORITY_UNAVAILABLE', atomId: atom.atomId, dependency};
      if (authority.frontierRevision < dependency.minFrontierRevision) return {verdict: 'UNKNOWN', reasonCode: 'PREDECESSOR_FRONTIER_TOO_OLD', atomId: atom.atomId, dependency, frontierRevision: authority.frontierRevision};
      const status = capabilityStatus(authority.events, dependency.capabilityId, authority.frontierRevision);
      if (status === 'REVOKED') return {verdict: 'REJECTED', reasonCode: 'PREDECESSOR_REVOKED_AT_SELECTED_FRONTIER', atomId: atom.atomId, dependency, frontierRevision: authority.frontierRevision};
      if (status !== 'ACTIVE') return {verdict: 'UNKNOWN', reasonCode: 'PREDECESSOR_STATUS_UNKNOWN', atomId: atom.atomId, dependency};
    }
  }
  return {verdict: 'SAFE', reasonCode: 'PREDECESSOR_CLOSURE_ACTIVE'};
}

export const evaluateStrongMatureStack = world => evaluatePredecessorClosure(world);

export function makePcWorld({id, revoked}) {
  const predecessorRefs = [{sourceId: 'oauth', capabilityId: 'grant-1', minFrontierRevision: 1}];
  return {
    id,
    publicObservation: {oauth: 'valid', tenant: 'tenant-a', apiEtag: 'etag-1', sinkKey: 'available'},
    authorities: {
      oauth: {frontierRevision: revoked ? 2 : 1, events: [
        {revision: 1, kind: 'ISSUE', capabilityId: 'grant-1'},
        ...(revoked ? [{revision: 2, kind: 'REVOKE', capabilityId: 'grant-1'}] : [])
      ]}
    },
    atoms: ['tenant', 'api', 'sink'].map(sourceId => ({atomId: `${id}-${sourceId}`, sourceId, signatureVerified: true, localFresh: true, localAuthorized: true, predecessorRefs: clone(predecessorRefs)}))
  };
}

export function runPcLockedPair() {
  const worlds = [makePcWorld({id: 'PC+', revoked: false}), makePcWorld({id: 'PC-', revoked: true})];
  return worlds.map(world => ({worldId: world.id, publicObservation: world.publicObservation, gold: goldFromAuthorityLogs(world), localMature: evaluateLocalMatureStack(world), abca: evaluatePredecessorClosure(world), strongestMature: evaluateStrongMatureStack(world)}));
}

