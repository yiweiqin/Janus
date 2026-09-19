#!/usr/bin/env node
import {openDurableSinkStore} from './ubuddy-cpir-web-durable-sink-harness-v1.mjs';

const dbPath = process.argv[2];
const store = openDurableSinkStore(dbPath);
const request = {tokenId: 'cross-token', idempotenceKey: 'cross-idem', intentId: 'cross-intent', effectId: 'cross-effect', tenantId: 'tenant-a', contractDigest: 'contract-1'};
const reserved = store.reserve({...request, expectedStateRevision: 0});
if (reserved.outcome !== 'RESERVED') process.exit(70);
const committed = store.consume({tokenId: reserved.token.tokenId, tokenHash: reserved.token.tokenHash, expectedStateRevision: reserved.stateRevision});
if (committed.outcome !== 'COMMITTED') process.exit(71);
// Simulates process loss after durable commit but before a receipt can be
// delivered to the caller. Deliberately skip store.close().
process.exit(86);
