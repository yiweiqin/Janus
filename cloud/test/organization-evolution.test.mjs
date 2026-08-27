import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

import express from 'express';
import { newDb } from 'pg-mem';

import { registerOrganizationEvolutionRoutes } from '../src/modules/organizationEvolution.mjs';

test('organization evolution trace, policy activation, isolation, health, and disable', async (t) => {
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  t.after(() => pool.end());
  await pool.query(await fs.readFile(new URL('../database/migrations/085_ubuddy_orgbench_evolution.sql', import.meta.url), 'utf8'));
  await pool.query(await fs.readFile(new URL('../database/migrations/086_ubuddy_orgbench_trace_link.sql', import.meta.url), 'utf8'));

  const app = express();
  app.use(express.json());
  const auth = (req, _res, next) => { req.auth = { user: { id: 'user_a' } }; next(); };
  const route = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
  const apiError = (code, message, status = 500) => Object.assign(new Error(message), { code, status });
  registerOrganizationEvolutionRoutes({ app, pool, auth, route, apiError });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code || 'error', message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json' };
  const capability = 'ubuddy-organization-evolution-v1';

  const trace = await fetch(`${base}/api/evolution/organization/traces`, { method: 'POST', headers, body: JSON.stringify({ capability, evolutionNamespace: 'E3-seed-1', traceId: 'trace_1', delegationId: 'delegation_1', eventKind: 'dispatch', idempotencyKey: 'trace_1:dispatch', payload: { publicSummary: 'ok' } }) }).then((response) => response.json());
  assert.equal(trace.insertedCount, 1);

  const playbook = { version: 'UBUDDY_ORG_PLAYBOOK_V1', policyVersionId: 'policy_1', parentPolicyVersionId: 'baseline', stage: 'decomposition', taskScopes: [{ id: 'scope_1', taskTypes: ['appworld'] }], assignmentRules: [], decompositionRules: [{ id: 'review', operator: 'require_synthesis_stage', taskTypes: ['appworld'], role: 'review', minimumConfidence: 0.7, evidenceCount: 1 }], hardConstraints: {}, provenance: { evidenceTraceIds: ['trace_1'], evidenceCount: 1 }, createdAt: new Date().toISOString() };
  const created = await fetch(`${base}/api/evolution/organization/policies`, { method: 'POST', headers, body: JSON.stringify({ capability, evolutionNamespace: 'E3-seed-1', playbook }) }).then((response) => response.json());
  assert.equal(created.status, 'candidate_created');
  const activated = await fetch(`${base}/api/evolution/organization/policies/policy_1/activate`, { method: 'POST', headers, body: JSON.stringify({ capability, evolutionNamespace: 'E3-seed-1' }) }).then((response) => response.json());
  assert.equal(activated.status, 'activated');
  const overview = await fetch(`${base}/api/evolution/organization/overview?capability=${capability}&evolutionNamespace=E3-seed-1`).then((response) => response.json());
  assert.equal(overview.traceCount, 1);
  assert.equal(overview.activePolicy.policyVersionId, 'policy_1');
  const isolated = await fetch(`${base}/api/evolution/organization/overview?capability=${capability}&evolutionNamespace=E0-seed-1`).then((response) => response.json());
  assert.equal(isolated.activePolicy, null);
  const disabled = await fetch(`${base}/api/evolution/organization/disable`, { method: 'POST', headers, body: JSON.stringify({ capability, evolutionNamespace: 'E3-seed-1' }) }).then((response) => response.json());
  assert.equal(disabled.status, 'disabled');
});
