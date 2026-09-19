/* AL/PC/ER/AN locked pairs compiled into the shared oracle-v1 DSL. */
import {digest} from './ubuddy-cpir-web-oracle-v1.mjs';

const activationA = {activationRoot: 'root-1', tabEpoch: 1, pageEpoch: 1, swEpoch: 1, partitionEpoch: 1, activationNonce: 'nonce-1', partitionKeyHash: 'partition-a'};
const activationB = {...activationA, pageEpoch: 2, activationNonce: 'nonce-2'};
const publicObservation = {status: 'AMBIGUOUS_WEB_EFFECT', signal: 'HIDDEN'};
const cardinalityGuard = {id: 'effect-cardinality', op: 'LTE_AFTER_DELTA', left: {path: 'state.effectCount'}, delta: {value: 1}, max: {path: 'world.contract.maxCardinality'}, violationReason: 'EFFECT_CARDINALITY_EXCEEDED'};
const commit = {increments: [{path: 'effectCount', by: {value: 1}}]};

export const lockedPairOracleManifest = {
  schemaVersion: 'cpir-web/oracle/v1',
  manifestId: 'al-pc-er-an-locked-pairs-v1',
  contractRegistryHash: digest('cpir-web/locked-pair-contracts/v1', {maxCardinality: 1}),
  observationProjectorHash: digest('cpir-web/locked-pair-projector/v1', {fields: ['signal', 'status']}),
  transitionVerifierHash: digest('cpir-web/locked-pair-transition-dsl/v1', {ops: ['EQ', 'DIGEST_EQ', 'TRUE', 'LTE_AFTER_DELTA', 'CAPABILITY_ACTIVE']}),
  trustRootHashes: [digest('cpir-web/locked-pair-trust-root/v1', {id: 'browser'}), digest('cpir-web/locked-pair-trust-root/v1', {id: 'oauth'}), digest('cpir-web/locked-pair-trust-root/v1', {id: 'sink'})],
  observationProjector: {fields: ['status', 'signal']},
  budget: {maxCost: 4},
  actions: [
    {id: 'activation-bound-submit', cost: 2, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'activation-lineage', op: 'DIGEST_EQ', left: {path: 'state.activationVector'}, right: {path: 'world.reservedActivation'}, violationReason: 'STALE_ACTIVATION_LINEAGE'}, cardinalityGuard], ...commit, successReason: 'ACTIVATION_BOUND_COMMIT'}},
    {id: 'predecessor-bound-submit', cost: 2, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'oauth-predecessor', op: 'CAPABILITY_ACTIVE', eventsPath: 'world.authority.events', frontierPath: 'world.authority.frontierRevision', capabilityId: {value: 'grant-1'}, violationReason: 'PREDECESSOR_REVOKED'}, cardinalityGuard], ...commit, successReason: 'PREDECESSOR_CLOSURE_COMMIT'}},
    {id: 'consume-evidence-escrow', cost: 1, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'signature', op: 'TRUE', left: {path: 'state.signatureVerified'}, violationReason: 'SIGNATURE_UNVERIFIED'}, {id: 'single-use', op: 'TRUE', left: {path: 'state.escrowUnused'}, violationReason: 'ESCROW_ALREADY_CONSUMED'}, {id: 'reconstructible-cut', op: 'DIGEST_EQ', left: {path: 'state.aggregateCut'}, right: {path: 'state.reconstructedCut'}, violationReason: 'CUT_NOT_RECONSTRUCTIBLE'}], set: [{path: 'escrowUnused', value: {value: false}}], successReason: 'ESCROW_RECONSTRUCTED_AND_CONSUMED'}},
    {id: 'retry-original-key', cost: 2, effectClass: 'IRREVERSIBLE', transition: {guards: [{id: 'authoritative-no-commit', op: 'EQ', left: {path: 'world.commitState'}, right: {value: 'NO_COMMIT'}, violationReason: 'COMMIT_AMBIGUITY_FORBIDS_RETRY'}, cardinalityGuard], ...commit, successReason: 'NO_COMMIT_CONFIRMED_RETRY'}}
  ],
  probes: [
    {id: 'activation-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.activationStatus'}]},
    {id: 'authority-frontier-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.authorityStatus'}]},
    {id: 'escrow-reconstruction-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.escrowStatus'}]},
    {id: 'receipt-finality-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.commitState'}]}
  ],
  faultSchedules: [
    {id: 'none', events: []},
    {id: 'response-timeout', events: [{id: 'timeout-1', fault: 'TIMEOUT'}]},
    {id: 'incomplete-authority', events: [{id: 'authority-gap-1', fault: 'MISSING_AUTHORITY'}]}
  ],
  worlds: [
    {id: 'AL+', pair: 'AL', publicObservation, activationStatus: 'CURRENT', reservedActivation: activationA, contract: {maxCardinality: 1}, initialState: {activationVector: activationA, effectCount: 0}},
    {id: 'AL-', pair: 'AL', publicObservation, activationStatus: 'STALE_BFCACHE_RESTORE', reservedActivation: activationA, contract: {maxCardinality: 1}, initialState: {activationVector: activationB, effectCount: 0}},
    {id: 'PC+', pair: 'PC', publicObservation, authorityStatus: 'ACTIVE', contract: {maxCardinality: 1}, authority: {frontierRevision: 1, events: [{revision: 1, kind: 'ISSUE', capabilityId: 'grant-1'}]}, initialState: {effectCount: 0}},
    {id: 'PC-', pair: 'PC', publicObservation, authorityStatus: 'REVOKED', contract: {maxCardinality: 1}, authority: {frontierRevision: 2, events: [{revision: 1, kind: 'ISSUE', capabilityId: 'grant-1'}, {revision: 2, kind: 'REVOKE', capabilityId: 'grant-1'}]}, initialState: {effectCount: 0}},
    {id: 'ER+', pair: 'ER', publicObservation, escrowStatus: 'COHERENT_UNUSED', initialState: {signatureVerified: true, escrowUnused: true, aggregateCut: {atoms: ['a', 'b'], tenant: 'tenant-a'}, reconstructedCut: {tenant: 'tenant-a', atoms: ['a', 'b']}}},
    {id: 'ER-FORGED', pair: 'ER', publicObservation, escrowStatus: 'FORGED_AGGREGATE', initialState: {signatureVerified: true, escrowUnused: true, aggregateCut: {atoms: ['a', 'b'], tenant: 'tenant-evil'}, reconstructedCut: {tenant: 'tenant-a', atoms: ['a', 'b']}}},
    {id: 'ER-REPLAY', pair: 'ER', publicObservation, escrowStatus: 'ALREADY_CONSUMED', initialState: {signatureVerified: true, escrowUnused: false, aggregateCut: {atoms: ['a', 'b'], tenant: 'tenant-a'}, reconstructedCut: {tenant: 'tenant-a', atoms: ['a', 'b']}}},
    {id: 'AN-NO-COMMIT', pair: 'AN', publicObservation, commitState: 'NO_COMMIT', contract: {maxCardinality: 1}, initialState: {effectCount: 0}},
    {id: 'AN-COMMITTED-LOST', pair: 'AN', publicObservation, commitState: 'COMMITTED_RECEIPT_LOST', contract: {maxCardinality: 1}, initialState: {effectCount: 1}}
  ]
};
