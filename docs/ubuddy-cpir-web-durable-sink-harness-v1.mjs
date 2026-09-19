/*
 * SQLite/WAL durable escrow + sink research harness.
 * research-prototype/unverified: this is not a production transaction layer or
 * proof of exactly-once across arbitrary external Web services.
 */
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {digest} from './ubuddy-cpir-web-oracle-v1.mjs';

const clone = value => value === undefined ? undefined : structuredClone(value);

function init(db) {
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS escrow (
      token_id TEXT PRIMARY KEY,
      idempotence_key TEXT NOT NULL UNIQUE,
      intent_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      contract_digest TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('RESERVED','CONSUMED')),
      state_revision INTEGER NOT NULL,
      receipt_id TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sink_ledger (
      receipt_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL UNIQUE,
      idempotence_key TEXT NOT NULL UNIQUE,
      intent_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      commit_index INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('COMMITTED_UNFINALIZED','FINAL_VERIFIED')),
      payload_json TEXT NOT NULL
    );`);
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('state_revision');
  if (!row) db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('state_revision', '0');
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

export function openDurableSinkStore(filePath) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), {recursive: true});
  const db = new DatabaseSync(resolved);
  init(db);
  const stateRevision = () => Number(db.prepare('SELECT value FROM metadata WHERE key = ?').get('state_revision').value);
  const bumpRevision = () => { const next = stateRevision() + 1; db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(String(next), 'state_revision'); return next; };
  const snapshot = () => ({stateRevision: stateRevision(), escrow: db.prepare('SELECT * FROM escrow ORDER BY token_id').all(), sinkLedger: db.prepare('SELECT * FROM sink_ledger ORDER BY commit_index').all()});
  return {
    filePath: resolved,
    snapshot,
    close: () => db.close(),
    reserve(request) {
      return tx(db, () => {
        const actual = stateRevision();
        if (request.expectedStateRevision !== actual) return {outcome: 'REJECTED', reasonCode: 'STATE_REVISION_STALE', actual, expected: request.expectedStateRevision};
        if (db.prepare('SELECT token_id FROM escrow WHERE idempotence_key = ?').get(request.idempotenceKey)) return {outcome: 'REJECTED', reasonCode: 'IDEMPOTENCE_KEY_ALREADY_EXISTS'};
        const tokenHash = digest('cpir-web/durable-token/v1', {...request, stateRevision: actual});
        const nextRevision = bumpRevision();
        db.prepare('INSERT INTO escrow(token_id,idempotence_key,intent_id,effect_id,tenant_id,contract_digest,token_hash,status,state_revision,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(request.tokenId, request.idempotenceKey, request.intentId, request.effectId, request.tenantId, request.contractDigest, tokenHash, 'RESERVED', nextRevision, JSON.stringify({...request, tokenHash, stateRevision: nextRevision}));
        return {outcome: 'RESERVED', reasonCode: 'DURABLE_RESERVATION_COMMITTED', token: {...request, tokenHash, stateRevision: nextRevision}, stateRevision: nextRevision};
      });
    },
    consume(request, {crashAfterCommit = false, failBeforeCommit = false} = {}) {
      const result = tx(db, () => {
        const row = db.prepare('SELECT * FROM escrow WHERE token_id = ?').get(request.tokenId);
        if (!row) return {outcome: 'REJECTED', reasonCode: 'TOKEN_NOT_RESERVED'};
        if (row.token_hash !== request.tokenHash) return {outcome: 'REJECTED', reasonCode: 'TOKEN_HASH_MISMATCH'};
        if (row.status === 'CONSUMED') return {outcome: 'NO_OP', reasonCode: 'TOKEN_ALREADY_CONSUMED', receiptId: row.receipt_id};
        const actual = stateRevision();
        if (request.expectedStateRevision !== actual) return {outcome: 'REJECTED', reasonCode: 'STATE_REVISION_STALE', actual, expected: request.expectedStateRevision};
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM sink_ledger WHERE effect_id = ?').get(row.effect_id).count);
        if (count >= 1) return {outcome: 'REJECTED', reasonCode: 'EFFECT_CARDINALITY_EXCEEDED'};
        const nextRevision = bumpRevision();
        const commitIndex = Number(db.prepare('SELECT COALESCE(MAX(commit_index),0)+1 AS next FROM sink_ledger').get().next);
        const receiptId = `receipt:${commitIndex}`;
        const payload = {tokenId: row.token_id, intentId: row.intent_id, effectId: row.effect_id, tenantId: row.tenant_id, idempotenceKey: row.idempotence_key, commitIndex, stateRevision: nextRevision};
        db.prepare('INSERT INTO sink_ledger(receipt_id,token_id,idempotence_key,intent_id,effect_id,tenant_id,commit_index,state,payload_json) VALUES(?,?,?,?,?,?,?,?,?)').run(receiptId, row.token_id, row.idempotence_key, row.intent_id, row.effect_id, row.tenant_id, commitIndex, 'COMMITTED_UNFINALIZED', JSON.stringify(payload));
        if (failBeforeCommit) throw new Error('SIMULATED_FAILURE_INSIDE_TRANSACTION');
        db.prepare('UPDATE escrow SET status = ?, receipt_id = ?, state_revision = ?, payload_json = ? WHERE token_id = ?').run('CONSUMED', receiptId, nextRevision, JSON.stringify({...JSON.parse(row.payload_json), consumedAt: Date.now(), receiptId}), row.token_id);
        return {outcome: 'COMMITTED', reasonCode: 'DURABLE_SINK_COMMIT', receiptId, commitIndex, stateRevision: nextRevision};
      });
      if (crashAfterCommit && result.outcome === 'COMMITTED') throw new Error('SIMULATED_RESPONSE_LOST_AFTER_DURABLE_COMMIT');
      return result;
    },
    finalize(receiptId) {
      return tx(db, () => {
        const row = db.prepare('SELECT * FROM sink_ledger WHERE receipt_id = ?').get(receiptId);
        if (!row) return {outcome: 'UNKNOWN', reasonCode: 'RECEIPT_NOT_FOUND'};
        if (row.state === 'FINAL_VERIFIED') return {outcome: 'NO_OP', reasonCode: 'RECEIPT_ALREADY_FINAL'};
        db.prepare('UPDATE sink_ledger SET state = ? WHERE receipt_id = ?').run('FINAL_VERIFIED', receiptId);
        bumpRevision();
        return {outcome: 'FINAL_VERIFIED', reasonCode: 'DURABLE_FINALITY_COMMITTED', receiptId};
      });
    },
    audit() {
      const state = snapshot();
      const violations = [];
      for (const receipt of state.sinkLedger) {
        const token = state.escrow.find(item => item.token_id === receipt.token_id);
        if (!token || token.status !== 'CONSUMED' || token.receipt_id !== receipt.receipt_id) violations.push({code: 'RECEIPT_TOKEN_BINDING_MISMATCH', receiptId: receipt.receipt_id});
      }
      return {disposition: violations.length ? 'VIOLATED' : 'SAFE', stateRevision: state.stateRevision, violations};
    }
  };
}
