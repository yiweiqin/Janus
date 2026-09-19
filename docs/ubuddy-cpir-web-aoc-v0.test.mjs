#!/usr/bin/env node
import assert from 'node:assert/strict';
import {buildAocCertificate} from './ubuddy-cpir-web-aoc-v0.mjs';
import {verifyAocCertificate} from './ubuddy-cpir-web-aoc-verifier-v0.mjs';

const worlds = [{id: 'w1'}, {id: 'w2'}];
const actions = [{id: 'a'}, {id: 'b'}];
const evaluate = (world, action) => {
  const safe = world.id === 'w1' ? action.id === 'a' : action.id === 'b';
  return {disposition: safe ? 'SAFE' : 'VIOLATED', terminalDisposition: safe ? 'SAFE' : 'VIOLATED', trace: [{eventType: 'COMMIT', outcome: safe ? 'FINAL_VERIFIED' : 'REJECTED', reasonCode: safe ? 'FINALITY_OK' : `FAIL_${action.id}`}], witnessObligations: safe ? [] : [`FAIL_${action.id}`]};
};
const certificate = buildAocCertificate({worlds, actions, evaluate});
assert.equal(certificate.edges.length, 1);
assert.equal(certificate.edges[0].kind, 'HARD_CONFLICT');
assert.equal(certificate.edges[0].replayWitnessesByAction.a[1].evaluation.trace[0].outcome, 'REJECTED');
assert.equal(certificate.certificateKind, 'bounded-transition-replay-wrapper');
assert.equal(verifyAocCertificate({certificate, worlds, actions, evaluate}).valid, true);
const omitted = structuredClone(certificate); omitted.edges[0].replayWitnessesByAction.a.pop();
assert.equal(verifyAocCertificate({certificate: omitted, worlds, actions, evaluate}).valid, false);
const forged = structuredClone(certificate); forged.edges[0].minimalWorldSet = ['w1'];
assert.equal(verifyAocCertificate({certificate: forged, worlds, actions, evaluate}).valid, false);

console.log(JSON.stringify({schemaVersion: 'cpir-web/aoc-test/v0', implementationStatus: 'research-prototype/unverified', allPassed: true, caseCount: 6, replayWitnesses: 4, warning: 'wrapper-not-new-algorithm'}, null, 2));
