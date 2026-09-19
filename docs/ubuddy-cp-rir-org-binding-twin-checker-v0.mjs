#!/usr/bin/env node
// Structural relational checker only. Signature/MAC and real sink verification are intentionally not implemented.
import fs from 'node:fs';
import crypto from 'node:crypto';

const path = process.argv[2] ?? new URL('./ubuddy-cp-rir-org-binding-twin-v0.input.example.json', import.meta.url);
const input = JSON.parse(fs.readFileSync(path, 'utf8'));
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const [a, b] = input.twins;
const publicEqual = a.publicPrefixDigest === b.publicPrefixDigest && a.publicPrefixDigest === input.sharedPublicPrefix.publicStateDigest;
const decisionsDiffer = a.sinkChallenge.decision !== b.sinkChallenge.decision;
const outcomesDiffer = a.postAttemptOutcome.effectApplied !== b.postAttemptOutcome.effectApplied;
const good = input.twins.find((t) => t.twinId === 'GOOD');
const bad = input.twins.find((t) => t.twinId === 'BAD');
const localConsistency = good?.sinkChallenge.decision === 'REJECT' && good?.postAttemptOutcome.effectApplied === false && good?.postAttemptOutcome.versionBefore === good?.postAttemptOutcome.versionAfter && bad?.sinkChallenge.decision === 'ALLOW' && bad?.postAttemptOutcome.effectApplied === true && bad?.postAttemptOutcome.versionAfter > bad?.postAttemptOutcome.versionBefore && bad?.postAttemptOutcome.receiptId !== null;
console.log(JSON.stringify({
  schemaVersion: 'cp-rir/org-binding-twin-checker-output/v0',
  implementationStatus: 'prototype/unverified',
  inputDigest: digest(input),
  structuralStatus: publicEqual && decisionsDiffer && outcomesDiffer && localConsistency ? 'RELATIONAL_STRUCTURE_PASS' : 'WITNESS_INVALID',
  semanticStatus: 'UNKNOWN_INPUT_NOT_PROVEN',
  reasonCode: 'ATTESTATION_SIGNATURE_AND_REAL_SINK_UNVERIFIED',
  publicPrefixEqual: publicEqual,
  sinkDecisionDiffers: decisionsDiffer,
  postAttemptOutcomeDiffers: outcomesDiffer,
  localConsistency,
  privacyClaim: 'NONE',
  crossOrganizationClaim: 'THREAT_MODEL_ONLY'
}, null, 2));
