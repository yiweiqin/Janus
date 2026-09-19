#!/usr/bin/env node
import assert from 'node:assert/strict';
import {runPcLockedPair} from './ubuddy-cpir-web-pc-locked-pair-v0.mjs';

const rows = runPcLockedPair();
assert.equal(rows.length, 2);
assert.deepEqual(rows[0].publicObservation, rows[1].publicObservation);
const positive = rows.find(row => row.worldId === 'PC+');
const negative = rows.find(row => row.worldId === 'PC-');
assert.equal(positive.gold.verdict, 'SAFE');
assert.equal(positive.abca.verdict, 'SAFE');
assert.equal(negative.gold.verdict, 'REJECTED');
assert.equal(negative.localMature.verdict, 'SAFE');
assert.equal(negative.abca.verdict, 'REJECTED');
assert.equal(negative.abca.reasonCode, 'PREDECESSOR_REVOKED_AT_SELECTED_FRONTIER');
assert.deepEqual(rows.map(row => row.abca.verdict), rows.map(row => row.strongestMature.verdict));

console.log(JSON.stringify({schemaVersion: 'cpir-web/pc-locked-pair-test/v0', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 8, result: {commonLocalStackSeparated: false, abcaSeparated: true, strongestMatureEquivalentToAbca: true}, rows}, null, 2));

