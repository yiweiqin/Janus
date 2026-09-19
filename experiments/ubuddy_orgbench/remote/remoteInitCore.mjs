import crypto from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { hashPassword, randomToken, signAccessToken } from '../../../cloud/src/security.mjs';
import { createPgPool } from '../../../cloud/src/db.mjs';
import { createPostgresEmployeeAuthority } from '../../../cloud/src/modules/employees/index.mjs';
import { profileForUser, USERS, AGENT_FAMILIES, ORGBENCH_NAMESPACE, allAgentAliases, deterministicAgentId, deterministicDeviceId, deterministicUBuddyId, passwordForUser } from './roster.mjs';

const API_CAPABILITY = 'ubuddy-capability-profile-v1';
const ACK = 'I_UNDERSTAND_REMOTE_DATABASE_WILL_BE_MODIFIED';

export function assertRemoteExecution({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') throw new Error('remote-orgbench-init refuses to run on Windows. Run it inside the remote Ubuntu Docker environment.');
  if (String(env.UBUDDY_ORGBENCH_REMOTE_INIT_ACK || '') !== ACK) {
    throw new Error(`Set UBUDDY_ORGBENCH_REMOTE_INIT_ACK=${ACK} to acknowledge remote database writes.`);
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for remote initialization.');
  if (!env.JWT_SECRET && !env.JWT_SECRET_FILE && !env.JANUS_JWT_SECRET) throw new Error('JWT_SECRET or JWT_SECRET_FILE is required.');
}

export function resolveSecret(env = process.env, name = 'JWT_SECRET') {
  const direct = String(env[name] || '').trim();
  if (direct) return direct;
  const file = String(env[`${name}_FILE`] || '').trim();
  if (file) return requireFileSecret(file);
  if (name === 'JWT_SECRET') return String(env.JANUS_JWT_SECRET || '').trim();
  return '';
}

function requireFileSecret(file) {
  // Synchronous read keeps startup failure deterministic before any write.
  return readFileSync(file, 'utf8').trim();
}

export async function runRemoteInitialization({ env = process.env, fetchImpl = globalThis.fetch, outputDir = '', logger = console } = {}) {
  assertRemoteExecution({ env });
  const jwtSecret = resolveSecret(env, 'JWT_SECRET');
  const pool = createPgPool(env.DATABASE_URL);
  const apiBaseUrl = String(env.UBUDDY_ORGBENCH_JANUS_BASE_URL || env.JANUS_PUBLIC_BASE_URL || 'http://cloud-api:8787').replace(/\/$/, '');
  const destination = outputDir || env.UBUDDY_ORGBENCH_INIT_OUTPUT_DIR || '/var/lib/janus/orgbench-init';
  const passwordSeed = String(env.UBUDDY_ORGBENCH_PASSWORD_SEED || (env.UBUDDY_ORGBENCH_PASSWORD_SEED_FILE ? readFileSync(env.UBUDDY_ORGBENCH_PASSWORD_SEED_FILE, 'utf8') : '') || randomToken()).trim();
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    await assertDatabase(pool);
    await assertCloudHealth(fetchImpl, apiBaseUrl);
    await upsertCatalog(pool);
    const identities = [];
    const tokens = {};
    const grants = {};
    const agentMap = {};
    for (const user of USERS) {
      const identity = await ensureUser(pool, user, passwordSeed);
      const accessToken = signAccessToken({ userId: user.id, secret: jwtSecret, expiresInSeconds: 30 * 86400 });
      const deviceId = deterministicDeviceId(user.key);
      const grant = await ensureDeviceGrant(pool, user.id, deviceId);
      const ubuddyId = await ensureUBuddyAlias(pool, user.id, deterministicUBuddyId(user.key));
      const authority = createPostgresEmployeeAuthority({ pool, apiError: simpleApiError });
      const bootstrap = await authority.bootstrap({ userId: user.id, deviceId, payload: {
        bootstrapId: `${ORGBENCH_NAMESPACE}:bootstrap`,
        instances: AGENT_FAMILIES.map((family) => ({
          agentFamilyId: family.id,
          proposedInstanceId: deterministicAgentId(user.key, family.familyId),
          displayName: `${user.id} ${family.name}`,
          note: `${ORGBENCH_NAMESPACE} internal execution Agent`,
        })),
      }});
      const skillHash = await currentSkillHash(pool, user.id, ubuddyId);
      const profile = profileForUser(user, ubuddyId, skillHash);
      const published = await publishProfile(fetchImpl, apiBaseUrl, accessToken, profile);
      const agentDetails = await userAgentDetails(pool, user.id);
      identities.push({ ...identity, deviceId, accessToken, evolutionGrant: grant.token, uBuddyAgentInstanceId: ubuddyId, bootstrapStatus: bootstrap.status, agents: agentDetails });
      tokens[user.id] = accessToken;
      grants[user.id] = grant.token;
      for (const family of AGENT_FAMILIES) {
        const alias = `agent_ubuddy_${user.key.toUpperCase()}_${family.familyId.replaceAll('_agent', '')}`;
        agentMap[alias] = deterministicAgentId(user.key, family.familyId);
      }
      logger.info?.(`[orgbench-init] ${user.id}: ${bootstrap.status}; profile ${published?.item?.profileRevision || profile.profileRevision}`);
    }
    await ensureFriendships(pool);
    const verification = await verifyDatabaseState(pool, { agentMap, jwtSecret, requesterId: USERS[0].id, fetchImpl, apiBaseUrl, requesterGrant: grants[USERS[0].id], requesterAccessToken: tokens[USERS[0].id] });
    const envText = renderEnv({ apiBaseUrl, identities, tokens, grants, agentMap });
    await writeSecretFile(path.join(destination, 'remote-orgbench.env'), envText);
    await writeJson(path.join(destination, 'remote-orgbench-identities.json'), identities.map(({ accessToken, evolutionGrant, ...safe }) => safe));
    await writeJson(path.join(destination, 'remote-orgbench-agent-map.json'), agentMap);
    await writeJson(path.join(destination, 'remote-orgbench-verification.json'), verification);
    return { destination, verification, identities: identities.length, agents: Object.keys(agentMap).length };
  } finally {
    await pool.end();
  }
}

async function assertDatabase(pool) {
  await pool.query('SELECT 1');
  const required = ['users', 'cloud_agent_families_v3', 'cloud_agent_versions_v3', 'cloud_user_agent_instances_v3', 'cloud_memory_documents_v3', 'cloud_memory_document_versions_v3', 'cloud_devices_v6', 'cloud_sync_grants', 'social_ubuddy_capability_profiles'];
  const rows = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`, [required]);
  const available = new Set(rows.rows.map((row) => row.table_name));
  const missing = required.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`Cloud database is missing required relations: ${missing.join(', ')}`);
}

async function assertCloudHealth(fetchImpl, baseUrl) {
  const response = await fetchImpl(`${baseUrl}/healthz`);
  if (!response.ok) throw new Error(`Cloud API healthz failed: HTTP ${response.status}`);
}

async function upsertCatalog(pool) {
  for (const family of AGENT_FAMILIES) {
    const payload = { name: family.name, metadata: { summary: `OrgBench ${family.name}`, capabilityTags: family.tags } };
    const versionId = `${family.id}_v1`;
    await pool.query(`INSERT INTO cloud_agent_versions_v3(id,agent_family_id,content_hash,payload_json)
      VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET agent_family_id=excluded.agent_family_id,content_hash=excluded.content_hash,payload_json=excluded.payload_json`,
      [versionId, family.id, sha256(JSON.stringify(payload)), JSON.stringify({ ...payload, baseSkillContent: `# ${family.name} baseline\n\nUse only assigned tools and report structured progress.` })]);
    await pool.query(`INSERT INTO cloud_agent_families_v3(id,department_id,name,role,payload_json,status,routable,current_version_id,instance_kind,recruitable,default_for_new_user,quota_cost,classification_version)
      VALUES($1,'orgbench','${family.name.replaceAll("'", "''")}','agent',$2::jsonb,'active',true,$3,'employee',true,false,1,'orgbench_v2')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,payload_json=excluded.payload_json,status='active',routable=true,current_version_id=excluded.current_version_id,instance_kind='employee',recruitable=true,quota_cost=1,classification_version='orgbench_v2'`,
      [family.id, JSON.stringify(payload), versionId]);
  }
}

async function ensureUser(pool, user, seed) {
  const email = `${user.id}@invalid.local`;
  const displayName = `OrgBench ${user.key.toUpperCase()} (${user.role})`;
  const password = passwordForUser({ userId: user.id, seed });
  const collision = (await pool.query('SELECT id,email,username FROM users WHERE id=$1 OR email=$2 OR username=$3', [user.id, email, user.id])).rows;
  if (collision.some((row) => row.id !== user.id || row.email !== email || row.username !== user.id)) {
    throw new Error(`Virtual identity collision for ${user.id}; refusing to overwrite an unrelated user.`);
  }
  await pool.query(`INSERT INTO users(id,email,display_name,username,avatar_url,email_verified,role,password_hash,created_at,updated_at)
    VALUES($1,$2,$3,$4,'',true,'member',$5,now(),now()) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,email_verified=true,updated_at=now()`,
    [user.id, email, displayName, user.id, hashPassword(password)]);
  await ensurePersonalWorkspace(pool, user.id, displayName);
  return { userId: user.id, email, displayName, role: user.role };
}

async function ensurePersonalWorkspace(pool, userId, displayName) {
  await pool.query(`INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
    VALUES($1,'personal',$2,'',$3,'active',now(),now()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=now()`, [`account_personal_${userId}`, userId, displayName]);
  await pool.query(`INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
    VALUES($1,$2,'owner','active',now(),now()) ON CONFLICT(account_id,user_id) DO UPDATE SET role='owner',status='active',updated_at=now()`, [`account_personal_${userId}`, userId]);
  await pool.query(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,joined_at,updated_at)
    VALUES('workspace_personal',$1,'owner','active',$2,now(),now()) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner',status='active',display_name=excluded.display_name,updated_at=now()`, [userId, displayName]);
  await pool.query(`INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
    VALUES($1,'workspace_personal',$2,'personal',now(),now()) ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='personal',updated_at=now()`, [`account_personal_${userId}`, userId]);
}

async function ensureDeviceGrant(pool, userId, deviceId) {
  const token = `dgr_${crypto.randomBytes(32).toString('base64url')}`;
  const scopes = ['sync:read', 'sync:write', 'sync:files', 'sync:keys', 'evolution:read', 'evolution:write', 'employees:read', 'employees:write'];
  await pool.query(`INSERT INTO cloud_devices_v6(user_id,device_id,display_name,hostname,platform,arch,status,public_key_pem,public_key_fingerprint,approved_by_device_id,approved_at,last_seen_at,metadata_json,created_at,updated_at)
    VALUES($1,$2,$3,'orgbench','linux','x64','approved','','','remote_init',now(),now(),'{}'::jsonb,now(),now())
    ON CONFLICT(user_id,device_id) DO UPDATE SET status='approved',last_seen_at=now(),updated_at=now()`, [userId, deviceId, `${ORGBENCH_NAMESPACE} device`]);
  const expiresAt = new Date(Date.now() + 90 * 86400000);
  await pool.query(`INSERT INTO cloud_sync_grants(id,user_id,device_id,token_hash,scopes_json,status,expires_at,grant_version,issued_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5::jsonb,'active',$6,6,now(),now(),now())
    ON CONFLICT(user_id,device_id) DO UPDATE SET token_hash=excluded.token_hash,scopes_json=excluded.scopes_json,status='active',expires_at=excluded.expires_at,updated_at=now()`,
    [`${ORGBENCH_NAMESPACE}:grant:${userId}`, userId, deviceId, sha256(token), JSON.stringify(scopes), expiresAt]);
  return { token, scopes, expiresAt: expiresAt.toISOString(), deviceId };
}

async function ensureUBuddyAlias(pool, userId, preferredId) {
  const family = await pool.query("SELECT id,current_version_id FROM cloud_agent_families_v3 WHERE id='secretary_agent'");
  if (!family.rows[0]) throw new Error('secretary_agent catalog entry is missing.');
  const existing = await pool.query("SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND agent_family_id='secretary_agent' ORDER BY created_at,id LIMIT 1", [userId]);
  const ubuddyId = existing.rows[0]?.id || preferredId;
  if (!existing.rowCount) await pool.query(`INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,source_device_id,payload_json,instance_kind,employment_state,quota_exempt,recruitment_source,policy_version,family_instance_seq,display_name,note,created_at,updated_at)
      VALUES($1,$2,'secretary_agent',$3,'active',true,true,false,false,'orgbench_init',$4::jsonb,'system','active',true,'orgbench_init','employee_cloud_authority_v1',0,$5,'OrgBench secretary',now(),now())`,
    [userId, ubuddyId, family.rows[0].current_version_id || '', JSON.stringify({ orgbench: true, role: 'uBuddy' }), `OrgBench uBuddy ${userId}`]);
  await ensureMemory(pool, userId, ubuddyId, family.rows[0].current_version_id || '');
  return ubuddyId;
}

async function ensureMemory(pool, userId, instanceId, familyVersionId) {
  const documentId = `orgbench_memory_${userId}_${instanceId}`;
  const versionId = `${documentId}_v1`;
  const content = '# memory0.md\n\n## OrgBench baseline\n\nPrivate baseline memory.\n';
  const contentHash = sha256(content);
  await pool.query(`INSERT INTO cloud_memory_documents_v3(user_id,id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,visibility,current_version_id,lifecycle_state,sync_enabled,allow_personal_evolution,allow_cluster_evolution,payload_json,created_at,updated_at)
    VALUES($1,$2,$3,'secretary_agent',$4,'general',0,'memory0.md','agent_private',$5,'active',true,true,false,$6::jsonb,now(),now()) ON CONFLICT(user_id,id) DO NOTHING`,
    [userId, documentId, instanceId, documentId, versionId, JSON.stringify({ content, contentHash })]);
  await pool.query(`INSERT INTO cloud_memory_document_versions_v3(user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at,base_version_id,parent_version_id,branch_id,conflict_state)
    VALUES($1,$2,$3,1,$4,$5::jsonb,now(),'','','main','none') ON CONFLICT(user_id,id) DO NOTHING`,
    [userId, versionId, documentId, contentHash, JSON.stringify({ content, contentHash, privacyLevel: 'private' })]);
}

async function currentSkillHash(pool, userId, instanceId) {
  const row = (await pool.query('SELECT active_personal_skill_version_id,base_agent_version_id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [userId, instanceId])).rows[0];
  return sha256(`${row?.base_agent_version_id || 'secretary_agent_v1'}:${row?.active_personal_skill_version_id || 'baseline'}`);
}

async function userAgentDetails(pool, userId) {
  const { rows } = await pool.query(`SELECT i.id,i.agent_family_id,i.base_agent_version_id,i.active_personal_skill_version_id,
      d.id AS memory_document_id,d.current_version_id AS memory_version
    FROM cloud_user_agent_instances_v3 i
    LEFT JOIN cloud_memory_documents_v3 d ON d.user_id=i.user_id AND d.user_agent_instance_id=i.id
      AND d.scope='general' AND d.slot_no=0 AND d.lifecycle_state='active'
    WHERE i.user_id=$1 ORDER BY i.agent_family_id,i.id`, [userId]);
  return rows.map((row) => ({
    agentInstanceId: row.id,
    ownerUserId: userId,
    agentFamilyId: row.agent_family_id,
    baseSkillVersion: row.base_agent_version_id || '',
    activeSkillVersion: row.active_personal_skill_version_id || row.base_agent_version_id || '',
    personalSkillOverlayVersion: row.active_personal_skill_version_id || '',
    memoryDocumentId: row.memory_document_id || '',
    memoryVersion: row.memory_version || '',
    personalEvolutionConsent: true,
  }));
}

async function publishProfile(fetchImpl, baseUrl, accessToken, profile) {
  const response = await fetchImpl(`${baseUrl}/api/social/ubuddy-profile`, { method: 'PUT', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'x-janus-social-capability': API_CAPABILITY }, body: JSON.stringify({ commandId: `${ORGBENCH_NAMESPACE}:profile:${profile.ownerUserId}`, socialCapability: API_CAPABILITY, profile }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Profile publish failed for ${profile.ownerUserId}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function ensureFriendships(pool) {
  for (let i = 0; i < USERS.length; i += 1) for (let j = i + 1; j < USERS.length; j += 1) {
    const [left, right] = [USERS[i].id, USERS[j].id].sort();
    await pool.query(`INSERT INTO friendships(id,user_a_id,user_b_id,status,created_at,updated_at)
      VALUES($1,$2,$3,'accepted',now(),now()) ON CONFLICT DO NOTHING`, [`${ORGBENCH_NAMESPACE}:friend:${left}:${right}`, left, right]);
  }
}

async function verifyDatabaseState(pool, { agentMap, jwtSecret, requesterId, fetchImpl, apiBaseUrl, requesterGrant, requesterAccessToken }) {
  const users = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE id = ANY($1::text[])`, [USERS.map((u) => u.id)])).rows[0]?.count || 0);
  const instances = (await pool.query(`SELECT user_id,id,agent_family_id,base_agent_version_id,active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE user_id = ANY($1::text[])`, [USERS.map((u) => u.id)])).rows;
  const internal = instances.filter((row) => row.agent_family_id.startsWith('orgbench_')).length;
  const ubuddies = instances.filter((row) => row.id.startsWith('orgbench_ubuddy_')).length;
  const memories = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM cloud_memory_documents_v3 WHERE user_id = ANY($1::text[]) AND lifecycle_state='active'`, [USERS.map((u) => u.id)])).rows[0]?.count || 0);
  const profiles = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM social_ubuddy_capability_profiles WHERE owner_user_id = ANY($1::text[]) AND publication_state='active'`, [USERS.map((u) => u.id)])).rows[0]?.count || 0);
  const grants = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM cloud_sync_grants WHERE user_id = ANY($1::text[]) AND status='active'`, [USERS.map((u) => u.id)])).rows[0]?.count || 0);
  const workspaces = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM account_workspace_memberships WHERE workspace_id='workspace_personal' AND user_id = ANY($1::text[]) AND status='active'`, [USERS.map((u) => u.id)])).rows[0]?.count || 0);
  const privateMemoryRows = (await pool.query(`SELECT user_id,visibility FROM cloud_memory_documents_v3 WHERE user_id = ANY($1::text[])`, [USERS.filter((u) => u.role === 'recipient').map((u) => u.id)])).rows;
  const uniqueOwners = new Set(instances.map((row) => row.user_id)).size;
  const mapComplete = Object.keys(agentMap).length === allAgentAliases().length;
  const recipientAgentId = Object.values(agentMap).find((id) => id.startsWith('orgbench_uagent_b_'));
  const forbiddenSkillActivation = await checkForeignSkillActivationDenied(fetchImpl, apiBaseUrl, requesterGrant, recipientAgentId);
  const visibleProfiles = await checkProfilesVisible(fetchImpl, apiBaseUrl, requesterAccessToken);
  const checks = { users, internalAgents: internal, ubuddies, memories, profiles, visibleRecipientProfiles: visibleProfiles, evolutionGrants: grants, personalWorkspaces: workspaces, uniqueAgentOwners: uniqueOwners, agentMapEntries: Object.keys(agentMap).length, agentMapComplete: mapComplete, requesterAccessTokenSigned: Boolean(signAccessToken({ userId: requesterId, secret: jwtSecret })), requesterCannotReadRecipientPrivateMemory: privateMemoryRows.length > 0 && privateMemoryRows.every((row) => row.visibility === 'agent_private'), requesterCannotActivateRecipientSkill: forbiddenSkillActivation };
  return { version: 'remote_orgbench_verification_v2', passed: users === 6 && internal === 36 && ubuddies === 6 && memories >= 42 && profiles === 6 && visibleProfiles === 5 && grants === 6 && workspaces === 6 && uniqueOwners === 6 && mapComplete && checks.requesterCannotReadRecipientPrivateMemory && forbiddenSkillActivation, checks, generatedAt: new Date().toISOString() };
}

async function checkForeignSkillActivationDenied(fetchImpl, apiBaseUrl, requesterGrant, recipientAgentId) {
  if (!requesterGrant || !recipientAgentId) return false;
  const response = await fetchImpl(`${apiBaseUrl}/v1/evolution/personal/versions/orgbench_forbidden_probe/activate`, { method: 'POST', headers: { authorization: `Bearer ${requesterGrant}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentInstanceId: recipientAgentId, commandId: `${ORGBENCH_NAMESPACE}:forbidden-skill-probe`, expectedActiveVersionId: '' }) });
  return response.status === 403 || response.status === 404;
}

async function checkProfilesVisible(fetchImpl, apiBaseUrl, accessToken) {
  if (!accessToken) return 0;
  const response = await fetchImpl(`${apiBaseUrl}/api/social/ubuddy-profiles/query`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'x-janus-social-capability': API_CAPABILITY }, body: JSON.stringify({ socialCapability: API_CAPABILITY, userIds: USERS.filter((u) => u.role === 'recipient').map((u) => u.id) }) });
  if (!response.ok) return 0;
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body.profiles) ? body.profiles.length : 0;
}

function renderEnv({ apiBaseUrl, identities, tokens, grants, agentMap }) {
  const requester = identities.find((item) => item.role === 'requester');
  return [
    '# Generated by remote-orgbench-init. chmod 600; do not commit.',
    'UBUDDY_ORGBENCH_JANUS_SYNC=1',
    `UBUDDY_ORGBENCH_JANUS_BASE_URL=${apiBaseUrl}`,
    `UBUDDY_ORGBENCH_JANUS_ACCESS_TOKEN=${requester.accessToken}`,
    `UBUDDY_ORGBENCH_EVOLUTION_GRANT=${requester.evolutionGrant}`,
    `UBUDDY_ORGBENCH_CLOUD_AGENT_MAP=${shellQuote(JSON.stringify(agentMap))}`,
    `UBUDDY_ORGBENCH_EVOLUTION_OWNER_TOKENS=${shellQuote(JSON.stringify(grants))}`,
    `UBUDDY_ORGBENCH_JANUS_CANDIDATE_USER_IDS=${shellQuote(USERS.filter((u) => u.role === 'recipient').map((u) => u.id).join(','))}`,
    `UBUDDY_ORGBENCH_UBUDDY_USER_MAP=${shellQuote(JSON.stringify(Object.fromEntries(USERS.map((u) => [`ubuddy_${u.key.toUpperCase()}`, u.id]))))}`,
    `UBUDDY_ORGBENCH_REQUESTER_USER_ID=${requester.userId}`,
    `UBUDDY_ORGBENCH_EVOLUTION_NAMESPACE_PREFIX=${ORGBENCH_NAMESPACE}`,
    `UBUDDY_ORGBENCH_RECIPIENT_USER_IDS=${shellQuote(USERS.filter((u) => u.role === 'recipient').map((u) => u.id).join(','))}`,
    `UBUDDY_ORGBENCH_ACCESS_TOKENS=${shellQuote(JSON.stringify(tokens))}`,
    '',
  ].join('\n');
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
async function writeSecretFile(file, content) { await fs.promises.writeFile(file, content, { mode: 0o600 }); await fs.promises.chmod(file, 0o600); }
async function writeJson(file, value) { await fs.promises.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await fs.promises.chmod(file, 0o600); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function simpleApiError(code, message, status = 400) { const error = new Error(message); error.code = code; error.status = status; return error; }

export { ACK };
