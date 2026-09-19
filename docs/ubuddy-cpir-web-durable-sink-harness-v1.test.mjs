#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDurableSinkStore} from './ubuddy-cpir-web-durable-sink-harness-v1.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpir-web-durable-'));
const dbPath = path.join(dir, 'sink.sqlite');
const request = {tokenId: 'token-1', idempotenceKey: 'idem-1', intentId: 'intent-1', effectId: 'effect-1', tenantId: 'tenant-a', contractDigest: 'contract-1'};
const first = openDurableSinkStore(dbPath);
assert.equal(first.reserve({...request, expectedStateRevision: 0}).outcome, 'RESERVED');
const token = first.snapshot().escrow[0];
assert.equal(first.consume({tokenId: token.token_id, tokenHash: token.token_hash, expectedStateRevision: first.snapshot().stateRevision}).outcome, 'COMMITTED');
const receiptId = first.snapshot().sinkLedger[0].receipt_id;
assert.equal(first.audit().disposition, 'SAFE');
assert.equal(first.finalize(receiptId).outcome, 'FINAL_VERIFIED');
assert.equal(first.finalize(receiptId).outcome, 'NO_OP');
first.close();

const restarted = openDurableSinkStore(dbPath);
assert.equal(restarted.snapshot().sinkLedger.length, 1);
assert.equal(restarted.snapshot().sinkLedger[0].state, 'FINAL_VERIFIED');
assert.equal(restarted.consume({tokenId: token.token_id, tokenHash: token.token_hash, expectedStateRevision: token.state_revision}).outcome, 'NO_OP');
assert.equal(restarted.reserve({...request, tokenId: 'token-2', expectedStateRevision: restarted.snapshot().stateRevision}).reasonCode, 'IDEMPOTENCE_KEY_ALREADY_EXISTS');
const stale = restarted.reserve({tokenId: 'token-3', idempotenceKey: 'idem-3', intentId: 'intent-3', effectId: 'effect-3', tenantId: 'tenant-a', contractDigest: 'contract-1', expectedStateRevision: 0});
assert.equal(stale.reasonCode, 'STATE_REVISION_STALE');
restarted.close();

const crashPath = path.join(dir, 'crash.sqlite');
const crashStore = openDurableSinkStore(crashPath);
assert.equal(crashStore.reserve({...request, expectedStateRevision: 0}).outcome, 'RESERVED');
const crashToken = crashStore.snapshot().escrow[0];
assert.throws(() => crashStore.consume({tokenId: crashToken.token_id, tokenHash: crashToken.token_hash, expectedStateRevision: crashStore.snapshot().stateRevision}, {crashAfterCommit: true}), /RESPONSE_LOST/);
crashStore.close();
const afterCrash = openDurableSinkStore(crashPath);
assert.equal(afterCrash.snapshot().sinkLedger.length, 1);
assert.equal(afterCrash.consume({tokenId: crashToken.token_id, tokenHash: crashToken.token_hash, expectedStateRevision: crashToken.state_revision}).outcome, 'NO_OP');
assert.equal(afterCrash.audit().disposition, 'SAFE');
afterCrash.close();

const concurrentPath = path.join(dir, 'concurrent.sqlite');
const left = openDurableSinkStore(concurrentPath);
const right = openDurableSinkStore(concurrentPath);
const leftRevision = left.snapshot().stateRevision;
const rightRevision = right.snapshot().stateRevision;
assert.equal(left.reserve({tokenId: 'left-token', idempotenceKey: 'left-idem', intentId: 'left-intent', effectId: 'left-effect', tenantId: 'tenant-a', contractDigest: 'contract-1', expectedStateRevision: leftRevision}).outcome, 'RESERVED');
assert.equal(right.reserve({tokenId: 'right-token', idempotenceKey: 'right-idem', intentId: 'right-intent', effectId: 'right-effect', tenantId: 'tenant-a', contractDigest: 'contract-1', expectedStateRevision: rightRevision}).reasonCode, 'STATE_REVISION_STALE');
left.close(); right.close();

const crossProcessPath = path.join(dir, 'cross-process.sqlite');
const childPath = fileURLToPath(new URL('./ubuddy-cpir-web-durable-sink-crash-child-v1.mjs', import.meta.url));
const child = spawnSync(process.execPath, [childPath, crossProcessPath], {encoding: 'utf8'});
assert.equal(child.status, 86);
const recovered = openDurableSinkStore(crossProcessPath);
const recoveredSnapshot = recovered.snapshot();
assert.equal(recoveredSnapshot.sinkLedger.length, 1);
assert.equal(recoveredSnapshot.escrow[0].status, 'CONSUMED');
assert.equal(recovered.consume({tokenId: recoveredSnapshot.escrow[0].token_id, tokenHash: recoveredSnapshot.escrow[0].token_hash, expectedStateRevision: 1}).outcome, 'NO_OP');
assert.equal(recovered.snapshot().sinkLedger.length, 1);
assert.equal(recovered.audit().disposition, 'SAFE');
recovered.close();

const rollbackPath = path.join(dir, 'rollback.sqlite');
const rollbackStore = openDurableSinkStore(rollbackPath);
const rollbackReserved = rollbackStore.reserve({tokenId: 'rollback-token', idempotenceKey: 'rollback-idem', intentId: 'rollback-intent', effectId: 'rollback-effect', tenantId: 'tenant-a', contractDigest: 'contract-1', expectedStateRevision: 0});
assert.equal(rollbackReserved.outcome, 'RESERVED');
assert.throws(() => rollbackStore.consume({tokenId: rollbackReserved.token.tokenId, tokenHash: rollbackReserved.token.tokenHash, expectedStateRevision: rollbackReserved.stateRevision}, {failBeforeCommit: true}), /INSIDE_TRANSACTION/);
assert.equal(rollbackStore.snapshot().sinkLedger.length, 0);
assert.equal(rollbackStore.snapshot().escrow[0].status, 'RESERVED');
assert.equal(rollbackStore.audit().disposition, 'SAFE');
assert.equal(rollbackStore.consume({tokenId: rollbackReserved.token.tokenId, tokenHash: rollbackReserved.token.tokenHash, expectedStateRevision: rollbackReserved.stateRevision}).outcome, 'COMMITTED');
rollbackStore.close();
fs.rmSync(dir, {recursive: true, force: true});

console.log(JSON.stringify({schemaVersion: 'cpir-web/durable-sink-harness-test/v1', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 29, result: {walRestartPersistsReceipt: true, finalityMonotone: true, staleRevisionRejected: true, duplicateKeyRejected: true, crashAfterCommitReconciles: true, twoConnectionStaleSnapshotRejected: true, crossProcessCrashRecovery: true, transactionFailureRollsBack: true, auditSafe: true}, warning: 'SQLite local harness only; no external-sink exactly-once or OAuth authenticity claim'}, null, 2));
