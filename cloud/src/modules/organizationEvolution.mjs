import crypto from 'node:crypto';
import { inTransaction } from '../db.mjs';
import {
  UBUDDY_ORG_PLAYBOOK_VERSION,
  uBuddyOrganizationPolicyHash,
  validateUBuddyOrganizationPlaybook,
} from '../../../src/shared/contracts/uBuddyOrganizationEvolution.js';

function capability(req) {
  return String(req.body?.capability || req.query?.capability || req.headers?.['x-janus-social-capability'] || '').split(',').map((x) => x.trim()).includes('ubuddy-organization-evolution-v1');
}
function requireCapability(req, apiError) { if (!capability(req)) throw apiError('ubuddy_organization_evolution_capability_required', '当前客户端未声明组织进化能力。', 426); }
function clean(value, max = 4000) { return String(value || '').trim().slice(0, max); }
function iso(value) { return value ? new Date(value).toISOString() : ''; }
function policyPayload(row) {
  if (!row) return null;
  return { policyVersionId: row.id, parentPolicyVersionId: row.parent_policy_version_id || '', policyHash: row.policy_hash || '', stage: row.stage || '', status: row.status || '', playbook: row.playbook_json || {}, baselineScore: Number(row.baseline_score || 0), namespace: row.evolution_namespace || 'default', createdAt: iso(row.created_at), activatedAt: iso(row.activated_at), disabledAt: iso(row.disabled_at) };
}
function uid(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

export function registerOrganizationEvolutionRoutes({ app, pool, auth, route, apiError }) {
  app.post('/api/evolution/organization/traces', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const userId = req.auth.user.id;
    const body = req.body || {};
    const namespace = clean(body.evolutionNamespace || body.namespace || 'default', 200);
    const rows = Array.isArray(body.events) ? body.events : [body];
    const inserted = [];
    for (const item of rows.slice(0, 256)) {
      const traceId = clean(item.traceId || body.traceId, 200);
      const eventKind = clean(item.eventKind || body.eventKind, 120);
      const idempotencyKey = clean(item.idempotencyKey || `${traceId}:${eventKind}:${item.sourceId || ''}`, 300);
      if (!traceId || !eventKind || !idempotencyKey) continue;
      const result = await pool.query(`INSERT INTO ubuddy_org_trace_events
        (id,owner_user_id,evolution_namespace,trace_id,delegation_id,event_kind,task_type,task_signature,idempotency_key,payload_json,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,COALESCE($11,now()))
        ON CONFLICT(owner_user_id,evolution_namespace,idempotency_key) DO UPDATE SET payload_json=excluded.payload_json
        RETURNING id,trace_id,event_kind`, [uid('orgtrace'), userId, namespace, traceId, clean(item.delegationId || body.delegationId, 200), eventKind, clean(item.taskType || body.taskType, 160), clean(item.taskSignature || body.taskSignature, 200), idempotencyKey, JSON.stringify(item.payload || body.payload || {}), item.occurredAt || body.occurredAt || null]);
      if (result.rows[0]) inserted.push(result.rows[0]);
    }
    res.status(202).json({ authority: 'cloud', status: 'accepted', evolutionNamespace: namespace, insertedCount: inserted.length, items: inserted });
  }));

  app.post('/api/evolution/organization/policies', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const userId = req.auth.user.id;
    const namespace = clean(req.body?.evolutionNamespace || req.body?.namespace || 'default', 200);
    let playbook;
    try { playbook = validateUBuddyOrganizationPlaybook(req.body?.playbook || req.body); } catch (error) { throw apiError('organization_policy_invalid', error.message, 400); }
    const hash = uBuddyOrganizationPolicyHash(playbook);
    const result = await pool.query(`INSERT INTO ubuddy_org_policy_versions
      (id,owner_user_id,evolution_namespace,parent_policy_version_id,policy_hash,stage,playbook_json,baseline_score,status)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'candidate')
      ON CONFLICT(owner_user_id,evolution_namespace,policy_hash) DO UPDATE SET playbook_json=excluded.playbook_json
      RETURNING *`, [playbook.policyVersionId, userId, namespace, playbook.parentPolicyVersionId || '', hash, playbook.stage, JSON.stringify(playbook), Number(req.body?.baselineScore || 0)]);
    res.status(201).json({ authority: 'cloud', status: 'candidate_created', policy: policyPayload(result.rows[0]) });
  }));

  app.get('/api/evolution/organization/overview', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const userId = req.auth.user.id;
    const namespace = clean(req.query?.evolutionNamespace || req.query?.namespace || 'default', 200);
    const [policies, traces, health] = await Promise.all([
      pool.query('SELECT * FROM ubuddy_org_policy_versions WHERE owner_user_id=$1 AND evolution_namespace=$2 ORDER BY created_at DESC', [userId, namespace]),
      pool.query('SELECT count(*)::int AS count FROM ubuddy_org_trace_events WHERE owner_user_id=$1 AND evolution_namespace=$2', [userId, namespace]),
      pool.query('SELECT * FROM ubuddy_org_policy_health_events WHERE owner_user_id=$1 AND evolution_namespace=$2 ORDER BY created_at DESC LIMIT 100', [userId, namespace]),
    ]);
    const active = policies.rows.find((row) => row.status === 'active');
    res.json({ authority: 'cloud', status: 'ok', evolutionNamespace: namespace, traceCount: Number(traces.rows[0]?.count || 0), activePolicy: policyPayload(active), policies: policies.rows.map(policyPayload), healthEvents: health.rows.map((row) => ({ id: row.id, policyVersionId: row.policy_version_id, eventKind: row.event_kind, traceId: row.trace_id, payload: row.payload_json || {}, createdAt: iso(row.created_at) })) });
  }));

  app.get('/api/evolution/organization/active-policy', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const namespace = clean(req.query?.evolutionNamespace || req.query?.namespace || 'default', 200);
    const row = (await pool.query("SELECT * FROM ubuddy_org_policy_versions WHERE owner_user_id=$1 AND evolution_namespace=$2 AND status='active' ORDER BY activated_at DESC LIMIT 1", [req.auth.user.id, namespace])).rows[0];
    res.json({ authority: 'cloud', evolutionNamespace: namespace, activePolicy: policyPayload(row) });
  }));

  app.post('/api/evolution/organization/policies/:policyVersionId/activate', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const userId = req.auth.user.id;
    const namespace = clean(req.body?.evolutionNamespace || req.body?.namespace || 'default', 200);
    const versionId = clean(req.params.policyVersionId, 160);
    const result = await pool.query('SELECT * FROM ubuddy_org_policy_versions WHERE id=$1 AND owner_user_id=$2 AND evolution_namespace=$3', [versionId, userId, namespace]);
    const target = result.rows[0];
    if (!target) throw apiError('organization_policy_not_found', '组织策略候选不存在。', 404);
    const expectedActive = clean(req.body?.expectedActivePolicyVersionId || '', 160);
    await inTransaction(pool, async (client) => {
      const active = (await client.query("SELECT id FROM ubuddy_org_policy_versions WHERE owner_user_id=$1 AND evolution_namespace=$2 AND status='active' ORDER BY activated_at DESC LIMIT 1 FOR UPDATE", [userId, namespace])).rows[0];
      const noActiveBaseline = !active && expectedActive && String(target.parent_policy_version_id || '') === expectedActive;
      if (expectedActive && String(active?.id || '') !== expectedActive && !noActiveBaseline) {
        throw apiError('organization_policy_conflict', '组织策略 active 版本已变化，请基于最新版本重试。', 409);
      }
      if (active && playbookParentMismatch(target, expectedActive)) {
        throw apiError('organization_policy_parent_conflict', '组织策略候选的 parent 版本与当前 active 版本不一致。', 409);
      }
      await client.query("UPDATE ubuddy_org_policy_versions SET status='archived' WHERE owner_user_id=$1 AND evolution_namespace=$2 AND status='active'", [userId, namespace]);
      await client.query("UPDATE ubuddy_org_policy_versions SET status='active',activated_at=now(),disabled_at=NULL WHERE id=$1", [versionId]);
    });
    res.json({ authority: 'cloud', status: 'activated', policy: policyPayload({ ...target, status: 'active', activated_at: new Date() }) });
  }));

  app.post('/api/evolution/organization/disable', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const namespace = clean(req.body?.evolutionNamespace || req.body?.namespace || 'default', 200);
    await pool.query("UPDATE ubuddy_org_policy_versions SET status='disabled',disabled_at=now() WHERE owner_user_id=$1 AND evolution_namespace=$2 AND status='active'", [req.auth.user.id, namespace]);
    res.json({ authority: 'cloud', status: 'disabled', evolutionNamespace: namespace });
  }));

  app.post('/api/evolution/organization/health', auth, route(async (req, res) => {
    requireCapability(req, apiError);
    const body = req.body || {};
    const namespace = clean(body.evolutionNamespace || body.namespace || 'default', 200);
    const eventKind = clean(body.eventKind || 'health', 120);
    const idempotencyKey = clean(body.idempotencyKey || `${body.policyVersionId}:${body.traceId}:${eventKind}`, 300);
    const result = await pool.query(`INSERT INTO ubuddy_org_policy_health_events(id,owner_user_id,evolution_namespace,policy_version_id,trace_id,event_kind,idempotency_key,payload_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(owner_user_id,evolution_namespace,idempotency_key) DO NOTHING RETURNING id`, [uid('orghealth'), req.auth.user.id, namespace, clean(body.policyVersionId, 160), clean(body.traceId, 200), eventKind, idempotencyKey, JSON.stringify(body.payload || {})]);
    res.status(202).json({ authority: 'cloud', status: result.rowCount ? 'recorded' : 'idempotent', id: result.rows[0]?.id || '' });
  }));
}

function playbookParentMismatch(target, expectedActive) {
  return Boolean(expectedActive && String(target.parent_policy_version_id || '') && String(target.parent_policy_version_id) !== expectedActive);
}
