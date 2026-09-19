#!/usr/bin/env node
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {authorityEventDigest, signAuthorityEvent, verifySignedAuthorityLog} from './ubuddy-cpir-web-authority-signed-log-v1.mjs';
import {digest, evaluate, validateOracleManifest} from './ubuddy-cpir-web-oracle-v1.mjs';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({type: 'spki', format: 'pem'});
const issuePayload = {authorityId: 'oauth-a', revision: 1, keyRevision: 1, prevDigest: 'GENESIS', kind: 'ISSUE', capabilityId: 'grant-1', subject: 'user-1', audience: 'api-a', scope: ['submit']};
const issue = signAuthorityEvent(privateKey, issuePayload);
const revokePayload = {...issuePayload, revision: 2, prevDigest: authorityEventDigest(issuePayload), kind: 'REVOKE'};
const revoke = signAuthorityEvent(privateKey, revokePayload);
const registry = {'1': publicKeyPem};

assert.equal(verifySignedAuthorityLog({events: [issue], keyRegistry: registry, frontierRevision: 1, capabilityId: 'grant-1'}).status, 'SAFE');
assert.equal(verifySignedAuthorityLog({events: [issue, revoke], keyRegistry: registry, frontierRevision: 2, capabilityId: 'grant-1'}).reasonCode, 'SIGNED_CAPABILITY_REVOKED');
const tampered = structuredClone(issue); tampered.payload.subject = 'attacker';
assert.equal(verifySignedAuthorityLog({events: [tampered], keyRegistry: registry, frontierRevision: 1, capabilityId: 'grant-1'}).reasonCode, 'AUTHORITY_EVENT_SIGNATURE_INVALID');
assert.equal(verifySignedAuthorityLog({events: [issue], keyRegistry: {}, frontierRevision: 1, capabilityId: 'grant-1'}).status, 'UNKNOWN');
assert.equal(verifySignedAuthorityLog({events: [issue], keyRegistry: registry, frontierRevision: 2, capabilityId: 'grant-1'}).reasonCode, 'AUTHORITY_FRONTIER_NOT_FULLY_OBSERVED');
const brokenPayload = {...revokePayload, prevDigest: 'forged'};
assert.equal(verifySignedAuthorityLog({events: [issue, signAuthorityEvent(privateKey, brokenPayload)], keyRegistry: registry, frontierRevision: 2, capabilityId: 'grant-1'}).reasonCode, 'AUTHORITY_HASH_CHAIN_BROKEN');
const equivocatedPayload = {...issuePayload, kind: 'REVOKE'};
assert.equal(verifySignedAuthorityLog({events: [issue, signAuthorityEvent(privateKey, equivocatedPayload)], keyRegistry: registry, frontierRevision: 1, capabilityId: 'grant-1'}).reasonCode, 'AUTHORITY_EQUIVOCATION_AT_REVISION');

const manifest = {
  schemaVersion: 'cpir-web/oracle/v1', manifestId: 'signed-authority-oracle-v1', contractRegistryHash: digest('contract/v1', {id: 'c'}), observationProjectorHash: digest('projector/v1', {fields: ['status']}), transitionVerifierHash: digest('verifier/v1', {op: 'SIGNED_CAPABILITY_ACTIVE'}), trustRootHashes: [digest('authority-key/v1', publicKeyPem)], observationProjector: {fields: ['status']}, budget: {maxCost: 2},
  actions: [{id: 'submit', cost: 1, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'signed-predecessor', op: 'SIGNED_CAPABILITY_ACTIVE', eventsPath: 'world.authority.events', keyRegistryPath: 'world.authority.keyRegistry', frontierPath: 'world.authority.frontierRevision', capabilityId: {value: 'grant-1'}, violationReason: 'PREDECESSOR_REVOKED'}]}}], probes: [], faultSchedules: [{id: 'none', events: []}],
  worlds: [{id: 'active', publicObservation: {status: 'valid'}, initialState: {}, authority: {events: [issue], keyRegistry: registry, frontierRevision: 1}}, {id: 'revoked', publicObservation: {status: 'valid'}, initialState: {}, authority: {events: [issue, revoke], keyRegistry: registry, frontierRevision: 2}}]
};
assert.equal(validateOracleManifest(manifest).valid, true);
assert.equal(evaluate(manifest, 'active', 'submit', 'none', 2).verdict, 'SAFE');
assert.equal(evaluate(manifest, 'revoked', 'submit', 'none', 2).verdict, 'VIOLATED');

console.log(JSON.stringify({schemaVersion: 'cpir-web/authority-signed-log-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 12, result: {ed25519Verified: true, revokeDerived: true, tamperDetected: true, missingKeyUnknown: true, frontierGapUnknown: true, hashChainBreakDetected: true, equivocationDetected: true, oracleIntegrated: true}, warning: 'local-signed-authority-log-only; not-real-OAuth-introspection-or-consent-proof'}, null, 2));
