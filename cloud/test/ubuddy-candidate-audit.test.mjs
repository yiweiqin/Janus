import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UBUDDY_CANDIDATE_AUDIT_VERSION,
  normalizeUBuddyCandidateAudit,
  validateUBuddyCandidateAudit,
} from '../../src/shared/contracts/uBuddyCandidateAudit.js';

test('candidate audit normalizes binding-bearing context and preserves privacy-safe fields', () => {
  const audit = normalizeUBuddyCandidateAudit({}, {
    replay: { version: 'tdb-v1', replayToken: 'x', traceHash: 't', finalHash: 'f', initialHash: 'i', secret: 'drop' },
    targetBinding: { status: 'CERTIFIED', targetTaskId: 'task-b', receiverUserId: 'u2', query: 'accept_result', tdbHash: 'h', secret: 'drop' },
    crossTaskApplicability: { status: 'CERTIFIED', applicability: 'APPLICABLE', sourceTaskId: 'task-a', sourceHash: 's' },
  });
  assert.equal(audit.auditVersion, UBUDDY_CANDIDATE_AUDIT_VERSION);
  assert.equal(audit.validation.status, 'VALIDATED');
  assert.equal(audit.targetBinding.targetTaskId, 'task-b');
  assert.equal(audit.crossTaskApplicability.targetTaskId, 'task-b');
  assert.equal('secret' in audit.replay, false);
});

test('legacy supplied audit without version is rejected by validation', () => {
  const result = validateUBuddyCandidateAudit({ replay: null }, { requireVersion: true });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'candidate_audit_version_missing');
});

test('missing audit remains compatible while normalization creates current schema', () => {
  assert.equal(validateUBuddyCandidateAudit(null, { requireVersion: false }).valid, true);
  const audit = normalizeUBuddyCandidateAudit({});
  assert.equal(audit.auditVersion, UBUDDY_CANDIDATE_AUDIT_VERSION);
  assert.equal(audit.validation.status, 'VALIDATED');
});

test('optional evidence audit is privacy-safe and deterministically hashed', () => {
  const audit = normalizeUBuddyCandidateAudit({}, {
    evidenceAudit: {
      status: 'validated',
      evidenceRefs: [{ evidenceId: 'ev-1', sourceVersionId: 'v1', validationStatus: 'validated', secret: 'drop' }],
      secret: 'drop',
    },
  });
  assert.equal(audit.evidenceAudit.version, 'ubuddy_evidence_audit_v1');
  assert.equal(audit.evidenceAudit.status, 'VALIDATED');
  assert.equal(audit.evidenceAudit.hash.length, 64);
  assert.equal(audit.evidenceAudit.refs[0].evidenceId, 'ev-1');
  assert.equal('secret' in audit.evidenceAudit, false);
  assert.equal('secret' in audit.evidenceAudit.refs[0], false);
  assert.equal(audit.evidenceAudit.hash, normalizeUBuddyCandidateAudit({}, { evidenceAudit: { status: 'validated', evidenceRefs: [{ evidenceId: 'ev-1', sourceVersionId: 'v1', validationStatus: 'validated' }] } }).evidenceAudit.hash);
});

test('temporal binding normalizes timestamps and requires correlation id', () => {
  const audit = normalizeUBuddyCandidateAudit({ correlationId: ' corr-1 ', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T01:00:00Z' });
  assert.equal(audit.correlationId, 'corr-1');
  assert.equal(audit.issuedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(audit.expiresAt, '2026-01-01T01:00:00.000Z');
  assert.equal(validateUBuddyCandidateAudit({ auditVersion: UBUDDY_CANDIDATE_AUDIT_VERSION, issuedAt: audit.issuedAt, expiresAt: audit.expiresAt }, { requireTemporalBinding: true, now: '2026-01-01T00:30:00Z' }).reason, 'candidate_audit_correlation_id_missing');
});

test('temporal binding rejects invalid and expired windows', () => {
  const base = { auditVersion: UBUDDY_CANDIDATE_AUDIT_VERSION, correlationId: 'corr-1', issuedAt: '2026-01-01T01:00:00Z', expiresAt: '2026-01-01T00:00:00Z' };
  assert.equal(validateUBuddyCandidateAudit(base, { requireTemporalBinding: true, now: '2026-01-01T00:30:00Z' }).reason, 'candidate_audit_time_window_invalid');
  assert.equal(validateUBuddyCandidateAudit({ ...base, expiresAt: '2026-01-01T02:00:00Z' }, { requireTemporalBinding: true, now: '2026-01-01T03:00:00Z' }).reason, 'candidate_audit_time_window_expired');
});

test('temporal binding accepts bounded clock skew and rejects drift beyond tolerance', () => {
  const base = {
    auditVersion: UBUDDY_CANDIDATE_AUDIT_VERSION,
    correlationId: 'corr-skew',
    issuedAt: '2026-01-01T01:00:00.000Z',
    expiresAt: '2026-01-01T02:00:00.000Z',
  };
  // Verifier is five seconds ahead of the issuer: tolerated.
  assert.equal(validateUBuddyCandidateAudit(base, {
    requireTemporalBinding: true,
    now: '2026-01-01T02:00:00.005Z',
    clockSkewMs: 10_000,
  }).valid, true);
  // Verifier is beyond the configured grace period: indeterminate.
  const exceeded = validateUBuddyCandidateAudit(base, {
    requireTemporalBinding: true,
    now: '2026-01-01T02:00:10.001Z',
    clockSkewMs: 10_000,
  });
  assert.equal(exceeded.valid, false);
  assert.equal(exceeded.reason, 'candidate_audit_clock_skew_exceeded');
  // Invalid configuration is rejected explicitly rather than widening trust.
  assert.equal(validateUBuddyCandidateAudit(base, {
    requireTemporalBinding: true,
    now: '2026-01-01T01:30:00Z',
    clockSkewMs: -1,
  }).reason, 'candidate_audit_clock_skew_invalid');
});

test('zero clock skew preserves strict legacy expiry behavior', () => {
  const base = {
    auditVersion: UBUDDY_CANDIDATE_AUDIT_VERSION,
    correlationId: 'corr-zero',
    issuedAt: '2026-01-01T01:00:00.000Z',
    expiresAt: '2026-01-01T02:00:00.000Z',
  };
  const result = validateUBuddyCandidateAudit(base, {
    requireTemporalBinding: true,
    now: '2026-01-01T02:00:00.001Z',
  });
  assert.equal(result.reason, 'candidate_audit_time_window_expired');
});

