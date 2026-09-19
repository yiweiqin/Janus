#!/usr/bin/env node
import assert from 'node:assert/strict';
import {runAbstentionPair, runActivationPair, runEscrowPair} from './ubuddy-cpir-web-locked-pairs-v0.mjs';

const activation = runActivationPair();
assert.deepEqual(activation.map(row => row.abca), ['SAFE', 'STALE_ACTIVATION']);
assert.deepEqual(activation.map(row => row.baseline), ['SAFE', 'SAFE']);

const escrow = runEscrowPair();
assert.equal(escrow.positive.verdict, 'SAFE');
assert.equal(escrow.forged.verdict, 'REJECTED');
assert.equal(escrow.replay.first, 'SAFE');
assert.equal(escrow.replay.second, 'REJECTED');

const abstention = runAbstentionPair();
assert.deepEqual(abstention.worlds.map(world => world.publicObservation), [{status: 'timeout'}, {status: 'timeout'}]);
assert.deepEqual(abstention.commonSafe, []);
assert.equal(abstention.requiredDecision, 'ABSTAIN_OR_PROBE');

console.log(JSON.stringify({schemaVersion: 'cpir-web/locked-pairs-test/v0', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 10, pairs: {AL: 'separated', ER: 'single-use-and-refinement', AN: 'no-common-effect-action'}}, null, 2));
