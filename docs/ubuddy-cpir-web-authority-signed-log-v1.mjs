/* Ed25519 signed authority event-log research profile. */
import {createHash, sign, verify} from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const encoded = value => Buffer.from(JSON.stringify(canonical(value)));
export const authorityEventDigest = payload => createHash('sha256').update('cpir-web/authority-event/v1\0').update(encoded(payload)).digest('hex');

export function signAuthorityEvent(privateKey, payload) {
  return {payload: structuredClone(payload), signature: sign(null, encoded(payload), privateKey).toString('base64')};
}

export function verifySignedAuthorityLog({events, keyRegistry, frontierRevision, capabilityId}) {
  if (!Array.isArray(events) || !Number.isInteger(frontierRevision) || !capabilityId || !keyRegistry) return {status: 'UNKNOWN', reasonCode: 'SIGNED_AUTHORITY_INPUT_INCOMPLETE'};
  const visible = events.filter(event => event?.payload?.revision <= frontierRevision).sort((a, b) => a.payload.revision - b.payload.revision || authorityEventDigest(a.payload).localeCompare(authorityEventDigest(b.payload)));
  if (!visible.length) return {status: 'UNKNOWN', reasonCode: 'SIGNED_AUTHORITY_FRONTIER_EMPTY'};
  const revisions = new Map();
  let previousDigest = 'GENESIS';
  let previousRevision = 0;
  for (const event of visible) {
    const payload = event.payload;
    const publicKey = keyRegistry[String(payload.keyRevision)];
    if (!publicKey) return {status: 'UNKNOWN', reasonCode: 'AUTHORITY_KEY_REVISION_UNKNOWN', revision: payload.revision, keyRevision: payload.keyRevision};
    if (!event.signature || !verify(null, encoded(payload), publicKey, Buffer.from(event.signature, 'base64'))) return {status: 'VIOLATED', reasonCode: 'AUTHORITY_EVENT_SIGNATURE_INVALID', revision: payload.revision};
    const eventDigest = authorityEventDigest(payload);
    if (revisions.has(payload.revision) && revisions.get(payload.revision) !== eventDigest) return {status: 'VIOLATED', reasonCode: 'AUTHORITY_EQUIVOCATION_AT_REVISION', revision: payload.revision};
    revisions.set(payload.revision, eventDigest);
    if (payload.revision !== previousRevision + 1) return {status: 'UNKNOWN', reasonCode: 'AUTHORITY_LOG_REVISION_GAP', expected: previousRevision + 1, actual: payload.revision};
    if (payload.prevDigest !== previousDigest) return {status: 'VIOLATED', reasonCode: 'AUTHORITY_HASH_CHAIN_BROKEN', revision: payload.revision};
    previousRevision = payload.revision;
    previousDigest = eventDigest;
  }
  if (previousRevision < frontierRevision) return {status: 'UNKNOWN', reasonCode: 'AUTHORITY_FRONTIER_NOT_FULLY_OBSERVED', observed: previousRevision, frontierRevision};
  const capabilityEvents = visible.filter(event => event.payload.capabilityId === capabilityId);
  if (!capabilityEvents.length) return {status: 'UNKNOWN', reasonCode: 'CAPABILITY_NOT_IN_SIGNED_LOG'};
  const latest = capabilityEvents.at(-1).payload;
  return latest.kind === 'ISSUE'
    ? {status: 'SAFE', reasonCode: 'SIGNED_CAPABILITY_ACTIVE', frontierRevision, latest, chainHead: previousDigest}
    : {status: 'VIOLATED', reasonCode: 'SIGNED_CAPABILITY_REVOKED', frontierRevision, latest, chainHead: previousDigest};
}
