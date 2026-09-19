/* Double-fault obstruction worlds for shared-oracle falsification. */
import {digest} from './ubuddy-cpir-web-oracle-v1.mjs';

const activationA = {activationRoot: 'root-1', tabEpoch: 1, pageEpoch: 1, swEpoch: 1, partitionEpoch: 1, activationNonce: 'nonce-1', partitionKeyHash: 'partition-a'};
const activationB = {...activationA, pageEpoch: 2, activationNonce: 'nonce-2'};
const issue = [{revision: 1, kind: 'ISSUE', capabilityId: 'grant-1'}];
const revoked = [...issue, {revision: 2, kind: 'REVOKE', capabilityId: 'grant-1'}];
const coherent = {atoms: ['browser', 'oauth', 'sink'], tenant: 'tenant-a'};
const forged = {atoms: ['browser', 'oauth', 'sink'], tenant: 'tenant-evil'};
const publicObservation = {status: 'AMBIGUOUS_DOUBLE_FAULT', signal: 'HIDDEN'};

const baseState = () => ({activationVector: structuredClone(activationA), effectCount: 0, signatureVerified: true, escrowUnused: true, aggregateCut: structuredClone(coherent), reconstructedCut: structuredClone(coherent)});
const baseWorld = () => ({publicObservation, reservedActivation: structuredClone(activationA), authority: {frontierRevision: 1, events: structuredClone(issue)}, commitState: 'NO_COMMIT', contract: {maxCardinality: 1}, initialState: baseState()});

export const doubleFaultOracleManifest = {
  schemaVersion: 'cpir-web/oracle/v1', manifestId: 'cpir-web-double-faults-v1',
  contractRegistryHash: digest('double-fault-contract/v1', {maxCardinality: 1}),
  observationProjectorHash: digest('double-fault-projector/v1', {fields: ['signal', 'status']}),
  transitionVerifierHash: digest('double-fault-verifier/v1', {guards: 7}),
  trustRootHashes: ['browser-root', 'oauth-root', 'sink-root'], observationProjector: {fields: ['status', 'signal']}, budget: {maxCost: 4},
  actions: [{
    id: 'combined-evidence-submit', cost: 2, effectClass: 'IRREVERSIBLE',
    transition: {
      guards: [
        {id: 'activation', op: 'DIGEST_EQ', left: {path: 'state.activationVector'}, right: {path: 'world.reservedActivation'}, violationReason: 'STALE_ACTIVATION_LINEAGE'},
        {id: 'predecessor', op: 'CAPABILITY_ACTIVE', eventsPath: 'world.authority.events', frontierPath: 'world.authority.frontierRevision', capabilityId: {value: 'grant-1'}, violationReason: 'PREDECESSOR_REVOKED'},
        {id: 'signature', op: 'TRUE', left: {path: 'state.signatureVerified'}, violationReason: 'SIGNATURE_UNVERIFIED'},
        {id: 'escrow-single-use', op: 'TRUE', left: {path: 'state.escrowUnused'}, violationReason: 'ESCROW_ALREADY_CONSUMED'},
        {id: 'escrow-refinement', op: 'DIGEST_EQ', left: {path: 'state.aggregateCut'}, right: {path: 'state.reconstructedCut'}, violationReason: 'CUT_NOT_RECONSTRUCTIBLE'},
        {id: 'no-commit', op: 'EQ', left: {path: 'world.commitState'}, right: {value: 'NO_COMMIT'}, violationReason: 'COMMIT_AMBIGUITY_FORBIDS_RETRY'},
        {id: 'cardinality', op: 'LTE_AFTER_DELTA', left: {path: 'state.effectCount'}, delta: {value: 1}, max: {path: 'world.contract.maxCardinality'}, violationReason: 'EFFECT_CARDINALITY_EXCEEDED'}
      ],
      increments: [{path: 'effectCount', by: {value: 1}}], successReason: 'ALL_WEB_EFFECT_GUARDS_SATISFIED'
    }
  }],
  probes: [
    {id: 'activation-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.activationSignal'}]},
    {id: 'authority-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.authoritySignal'}]},
    {id: 'escrow-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.escrowSignal'}]},
    {id: 'receipt-probe', cost: 1, effectClass: 'READ_ONLY', projection: [{field: 'signal', path: 'world.commitState'}]}
  ],
  faultSchedules: [{id: 'none', events: []}, {id: 'timeout', events: [{id: 'timeout-1', fault: 'TIMEOUT'}]}],
  worlds: [
    {...baseWorld(), id: 'DF-CLEAN', activationSignal: 'CURRENT', authoritySignal: 'ACTIVE', escrowSignal: 'COHERENT_UNUSED'},
    {...baseWorld(), id: 'DF-AL-PC', activationSignal: 'STALE', authoritySignal: 'REVOKED', escrowSignal: 'COHERENT_UNUSED', authority: {frontierRevision: 2, events: revoked}, initialState: {...baseState(), activationVector: activationB}},
    {...baseWorld(), id: 'DF-AL-AN', activationSignal: 'STALE', authoritySignal: 'ACTIVE', escrowSignal: 'COHERENT_UNUSED', commitState: 'COMMITTED_RECEIPT_LOST', initialState: {...baseState(), activationVector: activationB, effectCount: 1}},
    {...baseWorld(), id: 'DF-PC-ER', activationSignal: 'CURRENT', authoritySignal: 'REVOKED', escrowSignal: 'FORGED', authority: {frontierRevision: 2, events: revoked}, initialState: {...baseState(), aggregateCut: forged}},
    {...baseWorld(), id: 'DF-ER-AN', activationSignal: 'CURRENT', authoritySignal: 'ACTIVE', escrowSignal: 'ALREADY_CONSUMED', commitState: 'COMMITTED_RECEIPT_LOST', initialState: {...baseState(), escrowUnused: false, effectCount: 1}}
  ]
};
