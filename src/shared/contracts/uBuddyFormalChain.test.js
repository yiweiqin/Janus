import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUBuddy, createAuditableCertificate, createEvolutionProposal, invariantDiagnostics, validateFormalEnvelope } from './uBuddyFormalChain.js';

test('formal envelope, authorization and certificate invariants are deterministic', () => {
  const envelope = validateFormalEnvelope({ taskRunId: 'task-1', idempotencyKey: 'req-1', objective: 'x' }, 'requirement');
  assert.equal(envelope.valid, true);
  const denied = authorizeUBuddy({ subject: { userId: 'u1', capabilities: ['read'] }, capability: 'read:L3', scope: { id: 'edge-1' }, resource: { scopeId: 'edge-1', ownerUserId: 'u1' }, disclosurePolicy: { maxLevel: 1 } });
  assert.equal(denied.allowed, false);
  const allowed = authorizeUBuddy({ subject: { userId: 'u1', capabilities: ['read:L2'] }, capability: 'read:L2', scope: { id: 'edge-1' }, resource: { scopeId: 'edge-1', ownerUserId: 'u1' } });
  assert.equal(allowed.allowed, true);
  const certificate = createAuditableCertificate({ taskRunId: 'task-1', scope: 'edge-1', version: 'v1', inputStateHash: 'hash', claims: ['ok'], evidenceRefs: ['ev-1'], confidence: .9, status: 'CERTIFIED' });
  assert.ok(certificate.certificateId);
  assert.equal(invariantDiagnostics({ certificate, currentEvidenceRefs: ['ev-1'], evidenceRefs: ['ev-1'] }).valid, true);
  const proposal = createEvolutionProposal({ taskRunId: 'task-1', baseStateHash: 'hash', scope: 'edge-1', interventionKind: 'changeEdge', targetId: 'e1', preservedInvariants: ['privacy', 'authorization'] });
  assert.ok(proposal.proposalId);
});
