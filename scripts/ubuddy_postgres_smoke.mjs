#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { signAccessToken } from '../cloud/src/security.mjs';
import { createPostgresAuthoritativeEvidence } from '../cloud/src/modules/evolution/authoritativeEvidence.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const baseUrl = String(process.env.JANUS_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const databaseUrl = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL || '';
const jwtSecret = process.env.JWT_SECRET || process.env.JANUS_LOCAL_JWT_SECRET || '';
const outputDir = path.resolve(repoRoot, String(process.env.UBUDDY_POSTGRES_SMOKE_RUN_DIR || path.join('experiments', 'runs', `postgres-smoke-${timestamp()}`)));
const capabilityHeader = 'ubuddy-capability-profile-v1,agent-work-detail-projection-v1';

if (!databaseUrl) throw new Error('DATABASE_MIGRATOR_URL or DATABASE_URL is required.');
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET is required and must be at least 32 characters.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const superPassword = process.env.JANUS_LOCAL_POSTGRES_SUPER_PASSWORD || '';
const evidencePool = superPassword
  ? new pg.Pool({ connectionString: `postgres://postgres:${encodeURIComponent(superPassword)}@127.0.0.1:5432/janus` })
  : pool;
const runId = `smoke_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const ids = {
  requester: `${runId}_requester`, recipient: `${runId}_recipient`, outsider: `${runId}_outsider`,
  group: `${runId}_group`, delegation: `${runId}_delegation`, taskRun: `${runId}_task_run`, taskNode: `${runId}_task_node`,
};

try {
  await fs.mkdir(outputDir, { recursive: true });
  await writeJson('config.json', { experiment: 'ubuddy_postgres_smoke_v1', runId, baseUrl, database: 'postgresql',
    scenarios: ['normal_match', 'profile_upgrade_snapshot', 'failure_retry', 'requirement_revision', 'private_filter'], modelCalls: 0, createdAt: new Date().toISOString() });
  await seedBaseData();
  const requesterToken = signAccessToken({ userId: ids.requester, secret: jwtSecret, expiresInSeconds: 3600 });

  const candidateQuery = await api('/api/collaboration/candidates/query', { method: 'POST', token: requesterToken, body: {
    userIds: [ids.recipient, ids.outsider], requirement: { description: '研究并提交带图表的报告', capabilityTags: ['研究', '可视化'], supportedTaskTypes: ['research'], deliverableTypes: ['report'] },
  }});
  await writeJsonl('candidate_queries.jsonl', [{ runId, ...candidateQuery }]);
  const selected = candidateQuery.candidates.find((item) => item.ownerUserId === ids.recipient);
  if (!selected) throw new Error('Recipient was not visible in the candidate query.');

  const selection = await api('/api/collaboration/selections/confirm', { method: 'POST', token: requesterToken, body: {
    recipientUserId: ids.recipient, selection: { queryId: candidateQuery.queryId, profileRevision: selected.profileRevision, contentHash: selected.contentHash,
      requirement: candidateQuery.requirement, consideredCandidateUserIds: [ids.recipient, ids.outsider], selectionReason: '研究、可视化和报告交付能力匹配' },
  }});
  await writeJsonl('selection_snapshots.jsonl', [{ runId, ...selection.snapshot }]);

  await upgradeRecipientProfile();
  await seedCollaborationData(selection.snapshot);
  await writeJsonl('traces.jsonl', await readTraceSeedRows());

  const graph = await api(`/api/collaboration/state-graph?groupId=${encodeURIComponent(ids.group)}`, { token: requesterToken });
  const attribution = await api(`/api/collaboration/attribution?delegationId=${encodeURIComponent(ids.delegation)}`, { token: requesterToken });
  await writeJsonl('state-graphs.jsonl', [{ runId, ...graph }]);
  await writeJsonl('attributions.jsonl', [{ runId, ...attribution }]);
  const requesterRoute = await api(`/api/collaboration/attribution/${encodeURIComponent(ids.delegation)}/evolution-route`, { method: 'POST', token: requesterToken, body: { minConfidence: 0.6 } });
  const recipientRoute = {
    routeVersion: 'ubuddy_attribution_evolution_route_preview_v1', status: 'preview', delegationId: ids.delegation,
    personalCandidates: (attribution.evolutionRouting?.personalCandidates || []).filter((item) => item.userId === ids.recipient),
    personalRuns: [], blockedReasons: attribution.evolutionRouting?.blockedReasons || [],
  };
  const impact = await api(`/api/collaboration/evolution-impact?delegationId=${encodeURIComponent(ids.delegation)}`, { token: requesterToken });
  await writeJsonl('evolution_updates.jsonl', [{ runId, actor: 'requester', ...requesterRoute }, { runId, actor: 'recipient', ...recipientRoute }, { runId, actor: 'requester', kind: 'impact', ...impact }]);

  const metrics = collectMetrics({ candidateQuery, selection, graph, attribution, requesterRoute, recipientRoute, impact });
  await writeJson('metrics.json', metrics); await writeJson('summary.json', { runId, ids, metrics, artifacts: await listArtifacts() });
  await fs.writeFile(path.join(outputDir, 'report.md'), renderReport(metrics), 'utf8');
  console.log(JSON.stringify({ runId, outputDir, ids, metrics }, null, 2));
} finally { await pool.end(); }

async function seedBaseData() {
  await pool.query('BEGIN');
  try {
    for (const [userId, name] of [[ids.requester, 'Smoke Requester'], [ids.recipient, 'Smoke Recipient'], [ids.outsider, 'Smoke Outsider']]) {
      await pool.query(`INSERT INTO users(id,email,display_name,username,email_verified,role,password_hash) VALUES($1,$2,$3,$4,true,'member','smoke-test-password-hash')`, [userId, `${userId}@example.test`, name, userId]);
    }
    const [userA, userB] = [ids.requester, ids.recipient].sort();
    await pool.query(`INSERT INTO friendships(id,user_a_id,user_b_id,status) VALUES($1,$2,$3,'accepted')`, [`${runId}_friendship`, userA, userB]);
    await insertProfile(ids.requester, 'friends', 1, '能组织研究需求并验收报告', ['研究'], ['research'], ['report']);
    await insertProfile(ids.recipient, 'friends', 1, '擅长研究、可视化和报告交付', ['研究', '可视化'], ['research'], ['report']);
    await insertProfile(ids.outsider, 'friends', 1, '仅提供代码开发', ['开发'], ['coding'], ['code']);
    await pool.query('COMMIT');
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
}

async function insertProfile(ownerUserId, visibility, revision, introduction, capabilityTags, supportedTaskTypes, deliverableTypes) {
  const profile = { ownerUserId, uBuddyAgentInstanceId: `${ownerUserId}_agent`, version: 'ubuddy_capability_profile_v1', profileRevision: revision,
    visibility, introduction, capabilityTags, supportedTaskTypes, deliverableTypes, preferredTasks: ['结构化任务'], evidenceSummary: 'smoke-test public profile' };
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
  await pool.query(`INSERT INTO social_ubuddy_capability_profiles(owner_user_id,ubuddy_agent_instance_id,profile_revision,profile_version,visibility,publication_state,source_effective_skill_hash,content_hash,profile_json,state_revision)
    VALUES($1,$2,$3,'ubuddy_capability_profile_v1',$4,'active',$5,$6,$7::jsonb,$3)`, [ownerUserId, `${ownerUserId}_agent`, revision, visibility, `${ownerUserId}_skill_${revision}`, contentHash, JSON.stringify(profile)]);
}

async function upgradeRecipientProfile() {
  await pool.query(`UPDATE social_ubuddy_capability_profiles SET publication_state='archived',archived_at=now(),updated_at=now() WHERE owner_user_id=$1 AND publication_state='active'`, [ids.recipient]);
  await insertProfile(ids.recipient, 'friends', 2, '升级后的研究、可视化和报告交付能力', ['研究', '可视化', '图表'], ['research'], ['report']);
}

async function seedCollaborationData(selectionSnapshot) {
  const now = new Date(); const metadata = { dependencyOf: `${runId}_root`, capabilitySelectionSnapshot: selectionSnapshot, scenario: 'failure_retry_requirement_revision_private_filter' };
  await pool.query('BEGIN');
  try {
    for (const [userId, displayName] of [[ids.recipient, 'Smoke Recipient uBuddy'], [ids.requester, 'Smoke Requester uBuddy']]) {
      await pool.query(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,instance_kind,status,sync_enabled,personal_evolution_consent,display_name) VALUES($1,$2,'secretary_agent','employee','active',true,true,$3)`, [userId, `${userId}_agent`, displayName]);
    }
    await pool.query(`INSERT INTO collaboration_groups(id,owner_user_id,title,status,client_request_id,metadata_json,account_workspace_id) VALUES($1,$2,'PostgreSQL 冒烟任务群','active',$3,$4::jsonb,'workspace_personal')`, [ids.group, ids.requester, `${runId}_request`, JSON.stringify({ runId })]);
    await pool.query(`INSERT INTO collaboration_group_members(group_id,user_id,role,status) VALUES($1,$2,'owner','active'),($1,$3,'member','active')`, [ids.group, ids.requester, ids.recipient]);
    await pool.query(`INSERT INTO collaboration_group_messages(id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,source_event_id) VALUES($1,'workspace_personal',$2,$3,'secretary_agent','agent','Smoke group task published',$4::jsonb,$5)`, [`${runId}_group_message`, ids.group, ids.requester, JSON.stringify({ delegationId: ids.delegation, action: 'publish' }), `${runId}_group_publish`]);
    await pool.query(`INSERT INTO agent_delegations(id,account_workspace_id,requester_user_id,recipient_user_id,title,instruction,status,task_run_id,group_id,metadata_json,client_request_id) VALUES($1,'workspace_personal',$2,$3,'研究报告协作','完成研究并提交图表报告','result_accepted',$4,$5,$6::jsonb,$7)`, [ids.delegation, ids.requester, ids.recipient, ids.taskRun, ids.group, JSON.stringify(metadata), `${runId}_delegation_request`]);
    await pool.query(`INSERT INTO agent_delegation_workspaces(delegation_id,user_id,metadata_json) VALUES($1,$2,'{"privateNote":"requester private note"}'::jsonb),($1,$3,'{"privateNote":"recipient private note"}'::jsonb)`, [ids.delegation, ids.requester, ids.recipient]);
    await pool.query(`INSERT INTO agent_delegation_workspace_messages(id,delegation_id,user_id,role,content,metadata_json) VALUES($1,$2,$3,'user','PRIVATE_LOCAL_PATH_SHOULD_NOT_LEAK','{"localPath":"D:/private/report.md"}'::jsonb),($4,$2,$5,'assistant','PRIVATE_WORKSPACE_BODY_SHOULD_NOT_LEAK','{"source_path":"D:/private/report-v2.md"}'::jsonb)`, [`${runId}_wm_requester`, ids.delegation, ids.requester, `${runId}_wm_recipient`, ids.recipient]);
    await pool.query(`INSERT INTO agent_delegation_revisions(id,delegation_id,author_user_id,revision_no,action,content,metadata_json,created_at) VALUES($1,$2,$3,1,'draft','初始需求','{}'::jsonb,$4),($5,$2,$6,2,'submit','第一次结果','{}'::jsonb,$7),($8,$2,$3,3,'request_revision','请补充图表','{"reason":"missing_chart"}'::jsonb,$9),($10,$2,$6,4,'submit','重试后的最终结果','{}'::jsonb,$11),($12,$2,$3,5,'accept_result','验收通过','{}'::jsonb,$13)`, [`${runId}_rev_1`, ids.delegation, ids.requester, plusSeconds(now, 1), `${runId}_rev_2`, ids.recipient, plusSeconds(now, 2), `${runId}_rev_3`, plusSeconds(now, 3), `${runId}_rev_4`, plusSeconds(now, 4), `${runId}_rev_5`, plusSeconds(now, 5)]);
    // A task performance source must be owned by the same user as the Agent
    // instance executing its node. The requester still owns the collaboration
    // group and delegation, while the recipient owns this delegated task run.
    await pool.query(`INSERT INTO cloud_task_runs(id,owner_user_id,payload_json,account_workspace_id) VALUES($1,$2,$3::jsonb,'workspace_personal')`, [ids.taskRun, ids.recipient, JSON.stringify({ groupId: ids.group, delegationId: ids.delegation, scenario: 'smoke', requesterUserId: ids.requester })]);
    await pool.query(`INSERT INTO cloud_task_nodes(id,task_run_id,user_agent_instance_id,payload_json) VALUES($1,$2,$3,$4::jsonb)`, [ids.taskNode, ids.taskRun, `${ids.recipient}_agent`, JSON.stringify({ dependencyOf: `${runId}_root`, status: 'completed' })]);
    await pool.query(`INSERT INTO cloud_task_events(id,task_run_id,task_node_id,event_type,owner_user_id,user_agent_instance_id,payload_json,created_at) VALUES($1,$2,$3,'execution_failed',$4,$5,'{"reason":"tool_timeout","privatePath":"D:/private/report.md"}'::jsonb,$6),($7,$2,$3,'execution_retried',$4,$5,'{"retry":true}'::jsonb,$8),($9,$2,$3,'result_submitted',$4,$5,'{"version":2}'::jsonb,$10)`, [`${runId}_event_failed`, ids.taskRun, ids.taskNode, ids.recipient, `${ids.recipient}_agent`, plusSeconds(now, 2), `${runId}_event_retry`, plusSeconds(now, 3), `${runId}_event_submit`, plusSeconds(now, 4)]);
    await pool.query(`INSERT INTO task_node_result_versions(id,task_run_id,task_node_id,graph_revision_id,version_no,result_text,result_summary,evidence_json,decision,decision_reason,created_at,decided_at) VALUES($1,$2,$3,'graph_1',1,'旧结果','旧结果摘要','[]'::jsonb,'superseded','需求修订后失效',$4,$4),($5,$2,$3,'graph_2',2,'最终结果','最终结果摘要','[]'::jsonb,'adopted','验收通过',$6,$6)`, [`${runId}_result_1`, ids.taskRun, ids.taskNode, plusSeconds(now, 2), `${runId}_result_2`, plusSeconds(now, 5)]);
    await pool.query('COMMIT');
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
  const client = await evidencePool.connect();
  try {
    await client.query('BEGIN');
    const options = { keyring: evolutionKeyring(), envelopeKeyring: evolutionEnvelopeKeyring(), requireEnvelope: process.env.NODE_ENV === 'production', ownerUserId: ids.recipient, userAgentInstanceId: `${ids.recipient}_agent`, sourceKind: 'delegation_event', sourceId: ids.delegation, sourceVersionId: `${runId}_rev_4`, delegationId: ids.delegation, confidence: 0.9, metadata: { runId, taskRelevance: 1, acceptanceQuality: 1 } };
    await createPostgresAuthoritativeEvidence(client, { ...options, content: 'Smoke test accepted result after retry and requirement revision.' });
    await createPostgresAuthoritativeEvidence(client, { ...options, sourceKind: 'collaboration_message', sourceId: `${runId}_evidence_message`, content: 'Smoke test collaboration message confirms the final report was accepted.', confidence: 0.85 });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); if (evidencePool !== pool) await evidencePool.end(); }
}

async function readTraceSeedRows() { return (await pool.query(`SELECT event_type AS event_kind,id AS source_id,owner_user_id AS actor_user_id,created_at AS occurred_at FROM cloud_task_events WHERE task_run_id=$1 ORDER BY created_at,id`, [ids.taskRun])).rows.map((row) => ({ runId, ...row, occurred_at: toIso(row.occurred_at) })); }
function collectMetrics({ candidateQuery, selection, graph, attribution, requesterRoute, recipientRoute, impact }) {
  const graphJson = JSON.stringify(graph); const attributionJson = JSON.stringify(attribution); const resultVersions = graph.resultVersions || [];
  const recipientNode = graph.nodes.find((item) => item.userId === ids.recipient);
  const candidateVisibleRecipient = candidateQuery.candidates.some((item) => item.ownerUserId === ids.recipient);
  const outsiderUnavailable = candidateQuery.unavailableUserIds.includes(ids.outsider);
  const selectedProfileRevision = selection.snapshot?.recipientProfile?.profileRevision || 0;
  const currentProfileRevision = recipientNode?.capabilityProfile?.profileRevision || 0;
  const immutableSnapshotPreserved = recipientNode?.selectionSnapshot?.recipientProfile?.profileRevision === 1;
  const supersededResultPresent = resultVersions.some((item) => item.decision === 'superseded');
  const adoptedResultPresent = resultVersions.some((item) => item.decision === 'adopted');
  const privateContentFiltered = !graphJson.includes('PRIVATE_LOCAL_PATH_SHOULD_NOT_LEAK') && !attributionJson.includes('PRIVATE_WORKSPACE_BODY_SHOULD_NOT_LEAK') && !graphJson.includes('D:/private');
  const evidenceRefCount = (attribution.evolutionEvidenceRefs || []).length;
  const requesterOrganizationRoute = requesterRoute.status;
  const recipientPersonalRoute = recipientRoute.status;
  const impactEvidenceCount = (impact.evidence || []).length;
  return { experiment: 'ubuddy_postgres_smoke_v1', databaseBacked: true, apiBackedQueries: true, modelCalls: 0,
    candidateVisibleRecipient, outsiderUnavailable, selectedProfileRevision, currentProfileRevision, immutableSnapshotPreserved,
    graphNodeCount: graph.nodes.length, graphEdgeCount: graph.edges.length, traceEventKinds: [...new Set((attribution.trace || []).map((item) => item.eventKind))],
    organizationSignalKinds: [...new Set((attribution.organizationSignals || []).map((item) => item.kind))], individualSignalKinds: [...new Set((attribution.individualSignals || []).map((item) => item.kind))],
    supersededResultPresent, adoptedResultPresent, privateContentFiltered, evidenceRefCount, requesterOrganizationRoute, recipientPersonalRoute,
    personalRunCount: (recipientRoute.personalRuns || []).length, impactEvidenceCount,
    smokePass: candidateVisibleRecipient && outsiderUnavailable && selectedProfileRevision === 1 && currentProfileRevision === 2 && immutableSnapshotPreserved
      && graph.nodes.length >= 2 && graph.edges.length >= 1 && supersededResultPresent && adoptedResultPresent && privateContentFiltered
      && evidenceRefCount >= 2 && requesterOrganizationRoute === 'routed' && recipientPersonalRoute === 'preview' && impactEvidenceCount > 0,
  };
}

async function api(endpoint, { method = 'GET', token, body } = {}) { const response = await fetch(`${baseUrl}${endpoint}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-janus-social-capability': capabilityHeader }, body: body === undefined ? undefined : JSON.stringify(body) }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`API ${method} ${endpoint} failed (${response.status}): ${JSON.stringify(payload)}`); return payload; }
function evolutionKeyring() { return { activeKeyId: process.env.JANUS_EVOLUTION_ACTIVE_KEY_ID || '', keys: JSON.parse(process.env.JANUS_EVOLUTION_KEYS_JSON || '{}') }; }
function evolutionEnvelopeKeyring() { return { activeKeyId: process.env.JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID || '', keys: JSON.parse(process.env.JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON || '{}') }; }
async function writeJson(name, value) { await fs.writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function writeJsonl(name, rows) { await fs.writeFile(path.join(outputDir, name), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8'); }
async function listArtifacts() { return (await fs.readdir(outputDir)).sort(); }
function plusSeconds(date, seconds) { return new Date(date.getTime() + seconds * 1000); }
function toIso(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function renderReport(metrics) { return `# uBuddy PostgreSQL 真实链路冒烟实验\n\n- 数据库后端：PostgreSQL 17\n- API 查询：Cloud API\n- 模型调用：0 次\n- 冒烟结论：${metrics.smokePass ? '通过' : '失败'}\n\n- 候选画像可见且外部候选被过滤：${metrics.candidateVisibleRecipient && metrics.outsiderUnavailable}\n- 选择时画像版本：${metrics.selectedProfileRevision}；当前画像版本：${metrics.currentProfileRevision}\n- 不可变选择快照保持：${metrics.immutableSnapshotPreserved}\n- 旧结果 superseded：${metrics.supersededResultPresent}\n- 最终结果 adopted：${metrics.adoptedResultPresent}\n- 私有内容过滤：${metrics.privateContentFiltered}\n- 进化证据数：${metrics.evidenceRefCount}\n- 请求者组织路由：${metrics.requesterOrganizationRoute}\n- 接收者个体路由：${metrics.recipientPersonalRoute}\n\n该实验验证真实 PostgreSQL 与 Cloud API 数据链路，不等同于论文级成功率提升结论。\n`; }
