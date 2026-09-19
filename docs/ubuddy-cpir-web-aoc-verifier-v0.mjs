/* Independent replay/minimality verifier for the bounded AOC certificate. */
import {buildConflictRegistry} from './ubuddy-cpir-web-conflict-registry-v0.mjs';

const key = (kind, ids) => `${kind}:${ids.slice().sort().join('|')}`;

export function verifyAocCertificate({certificate, worlds, actions, evaluate, maxWorldClasses = 20}) {
  const registry = buildConflictRegistry({worlds, actions, evaluate, maxWorldClasses});
  const errors = [];
  if (certificate.registryDigest !== registry.registryDigest) errors.push({code: 'REGISTRY_DIGEST_MISMATCH'});
  const expectedEdges = new Map(registry.edges.map(edge => [key(edge.kind, edge.minimalWorldSet), edge]));
  const providedEdges = new Set();
  for (const edge of certificate.edges ?? []) {
    const edgeKey = key(edge.kind, edge.minimalWorldSet);
    if (providedEdges.has(edgeKey)) errors.push({code: 'DUPLICATE_EDGE', edgeKey});
    providedEdges.add(edgeKey);
    const expected = expectedEdges.get(edgeKey);
    if (!expected) {
      errors.push({code: 'UNEXPECTED_EDGE', edgeKey});
      continue;
    }
    for (const actionId of actions.map(action => action.id)) {
      for (const worldId of edge.minimalWorldSet) {
        const supplied = edge.replayWitnessesByAction?.[actionId]?.find(item => item.worldId === worldId)?.evaluation;
        if (!supplied) errors.push({code: 'MISSING_REPLAY_WITNESS', edgeKey, actionId, worldId});
        else {
          const actual = evaluate(worlds.find(world => world.id === worldId), actions.find(action => action.id === actionId));
          if (JSON.stringify(supplied) !== JSON.stringify(actual)) errors.push({code: 'REPLAY_WITNESS_MISMATCH', edgeKey, actionId, worldId});
        }
      }
    }
  }
  for (const edgeKey of expectedEdges.keys()) if (!providedEdges.has(edgeKey)) errors.push({code: 'MISSING_EDGE', edgeKey});
  return {valid: errors.length === 0, errors, registryDigest: registry.registryDigest, edgeCount: registry.edges.length};
}

