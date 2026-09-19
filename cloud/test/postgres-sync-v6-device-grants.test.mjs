import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createDeviceGrantService, routeWithDeviceGrant, DEFAULT_RDMD_WORKER_USER } from '../src/modules/sync/deviceGrants.mjs';
import { deviceGrantProofMessage, rsaPublicKeyFingerprint } from '../../src/shared/taskMemoryCrypto.js';

test('Sync V6 Device Grants support strict cross-device approval and enforce revocation', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await insertUsers(pool, ['user_a', 'user_b']);

  const service = createDeviceGrantService({ pool, apiError, approvalMode: 'cross_device' });
  const firstKey = deviceIdentity();
  const secondKey = deviceIdentity();
  const first = await service.register({ userId: 'user_a', input: { deviceId: 'device_1', publicKey: firstKey.publicKey } });
  assert.equal(first.status, 'approved');
  assert.match(first.publicKeyFingerprint, /^[a-f0-9]{64}$/);

  const second = await service.register({ userId: 'user_a', input: { deviceId: 'device_2', publicKey: secondKey.publicKey } });
  assert.equal(second.status, 'pending');
  await assert.rejects(service.issueToken({ userId: 'user_a', deviceId: 'device_1', requestedScopes: ['sync:read'],
    proof: signProof(secondKey, 'user_a', 'device_1', ['sync:read']) }), (error) => error.code === 'device_proof_invalid');
  await assert.rejects(
    service.issueToken({ userId: 'user_a', deviceId: 'device_2', requestedScopes: ['sync:read'], proof: signProof(secondKey, 'user_a', 'device_2', ['sync:read']) }),
    (error) => error.code === 'device_not_approved' && error.status === 409,
  );

  const firstGrant = await service.issueToken({
    userId: 'user_a', deviceId: 'device_1', requestedScopes: ['sync:read', 'devices:approve'],
    proof: signProof(firstKey, 'user_a', 'device_1', ['sync:read', 'devices:approve']),
  });
  assert.deepEqual(firstGrant.scopes.sort(), ['devices:approve', 'sync:read']);
  assert.equal((await authorize(pool, firstGrant.token, 'devices:approve')).deviceId, 'device_1');

  const approved = await service.approve({ userId: 'user_a', actorDeviceId: 'device_1', targetDeviceId: 'device_2' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedByDeviceId, 'device_1');
  const secondGrant = await service.issueToken({ userId: 'user_a', deviceId: 'device_2', requestedScopes: ['sync:read'],
    proof: signProof(secondKey, 'user_a', 'device_2', ['sync:read']) });
  assert.equal((await authorize(pool, secondGrant.token, 'sync:read')).userId, 'user_a');

  const otherKey = deviceIdentity();
  const other = await service.register({ userId: 'user_b', input: { deviceId: 'device_1', publicKey: otherKey.publicKey } });
  assert.equal(other.status, 'approved');
  const otherGrant = await service.issueToken({ userId: 'user_b', deviceId: 'device_1', requestedScopes: ['sync:read'],
    proof: signProof(otherKey, 'user_b', 'device_1', ['sync:read']) });
  assert.equal((await authorize(pool, otherGrant.token, 'sync:read')).userId, 'user_b');

  assert.equal((await service.revoke({ userId: 'user_a', actorDeviceId: 'device_1', targetDeviceId: 'device_2' })).status, 'revoked');
  await assert.rejects(authorize(pool, secondGrant.token, 'sync:read'), (error) => error.code === 'device_grant_invalid');
  await assert.rejects(authorize(pool, firstGrant.token, 'sync:write'), (error) => error.code === 'device_grant_scope_denied');
});

test('authenticated device registration automatically authorizes new, replacement, and previously revoked devices', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await insertUsers(pool, ['user_login']);

  const service = createDeviceGrantService({ pool, apiError });
  const firstKey = deviceIdentity();
  const replacementKey = deviceIdentity();
  assert.equal((await service.register({ userId: 'user_login', input: { deviceId: 'device_first', publicKey: firstKey.publicKey } })).status, 'approved');
  const replacement = await service.register({ userId: 'user_login', input: { deviceId: 'device_reinstalled', publicKey: replacementKey.publicKey } });
  assert.equal(replacement.status, 'approved');
  assert.equal(replacement.approvedByDeviceId, 'authenticated_registration');
  const grant = await service.issueToken({
    userId: 'user_login', deviceId: 'device_reinstalled', requestedScopes: ['sync:read'],
    proof: signProof(replacementKey, 'user_login', 'device_reinstalled', ['sync:read']),
  });
  assert.equal(grant.status, 'approved');
  assert.equal((await service.revoke({ userId: 'user_login', actorDeviceId: 'device_first', targetDeviceId: 'device_reinstalled' })).status, 'revoked');
  const reauthorized = await service.register({
    userId: 'user_login', input: { deviceId: 'device_reinstalled', publicKey: replacementKey.publicKey },
  });
  assert.equal(reauthorized.status, 'approved');
  assert.equal(reauthorized.revokedAt, null);
  assert.equal((await service.issueToken({
    userId: 'user_login', deviceId: 'device_reinstalled', requestedScopes: ['sync:read'],
    proof: signProof(replacementKey, 'user_login', 'device_reinstalled', ['sync:read']),
  })).status, 'approved');
});

test('the cross-user rdmd:infer scope is issued only to a configured service identity', async (t) => {
  // `rdmd:infer` 与其余 scope 的本质区别：它是**跨用户**的。一个 worker 池替所有用户领活、
  // 回传判定，所以拿到它等于拿到"给任意一条推理作业写判定"的权力。而通用签发端点只要求
  // 登录态、scope 直接来自请求体 —— 没有这道闸，任何登录用户都能给自己的设备签出它。
  //
  // 这条测试盯住的是**签发**，不是消费：消费侧（claim/verdict）本来就该跨用户，
  // 所以唯一能收口的地方就是这里。
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await insertUsers(pool, ['user_plain', DEFAULT_RDMD_WORKER_USER]);

  const service = createDeviceGrantService({ pool, apiError });

  // ---- 普通用户自取 rdmd:infer：必须被拒 ----
  const plainKey = deviceIdentity();
  assert.equal((await service.register({ userId: 'user_plain', input: { deviceId: 'device_plain', publicKey: plainKey.publicKey } })).status, 'approved');
  await assert.rejects(
    service.issueToken({ userId: 'user_plain', deviceId: 'device_plain', requestedScopes: ['rdmd:infer'],
      proof: signProof(plainKey, 'user_plain', 'device_plain', ['rdmd:infer']) }),
    (error) => error.code === 'device_grant_scope_reserved' && error.status === 403,
  );
  // 被拒之后不该留下任何凭据。
  assert.equal((await pool.query('SELECT * FROM cloud_sync_grants WHERE user_id=$1', ['user_plain'])).rows.length, 0);

  // 混在普通 scope 里也不行 —— 否则"顺手带一个"就能绕过。
  await assert.rejects(
    service.issueToken({ userId: 'user_plain', deviceId: 'device_plain', requestedScopes: ['sync:read', 'rdmd:infer'],
      proof: signProof(plainKey, 'user_plain', 'device_plain', ['sync:read', 'rdmd:infer']) }),
    (error) => error.code === 'device_grant_scope_reserved',
  );

  // ---- 收口之前签出去的残留也要兜住 ----
  // 判据取的是**合并后**的 scope 集合：只看本次请求的话，一个已经把这行写成 rdmd:infer 的
  // 身份，之后每次续签都会被原样合并回来，闸门等于没关。
  await service.issueToken({ userId: 'user_plain', deviceId: 'device_plain', requestedScopes: ['sync:read'],
    proof: signProof(plainKey, 'user_plain', 'device_plain', ['sync:read']) });
  await pool.query('UPDATE cloud_sync_grants SET scopes_json=$1::jsonb WHERE user_id=$2 AND device_id=$3',
    [JSON.stringify(['sync:read', 'rdmd:infer']), 'user_plain', 'device_plain']);
  await assert.rejects(
    service.issueToken({ userId: 'user_plain', deviceId: 'device_plain', requestedScopes: ['sync:read'],
      proof: signProof(plainKey, 'user_plain', 'device_plain', ['sync:read']) }),
    (error) => error.code === 'device_grant_scope_reserved',
  );

  // ---- 服务身份：正常签发，且签出来的 grant 真的能过消费侧那道 scope 检查 ----
  const workerKey = deviceIdentity();
  await service.register({ userId: DEFAULT_RDMD_WORKER_USER, input: { deviceId: 'device_gpu', publicKey: workerKey.publicKey } });
  const workerGrant = await service.issueToken({
    userId: DEFAULT_RDMD_WORKER_USER, deviceId: 'device_gpu', requestedScopes: ['rdmd:infer'],
    proof: signProof(workerKey, DEFAULT_RDMD_WORKER_USER, 'device_gpu', ['rdmd:infer']),
  });
  assert.deepEqual(workerGrant.scopes, ['rdmd:infer']);
  assert.equal((await authorize(pool, workerGrant.token, 'rdmd:infer')).userId, DEFAULT_RDMD_WORKER_USER);
});

test('the service identity allowlist is configurable, and is the only thing that grants the reserved scope', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  await insertUsers(pool, ['user_custom_worker', DEFAULT_RDMD_WORKER_USER]);

  // 换一份 env：名单里是 user_custom_worker，于是**默认**那个服务身份反而拿不到了。
  // 这条同时钉住两件事：名单确实生效，且它不是"写死的白名单"。
  const service = createDeviceGrantService({ pool, apiError, env: { RDMD_WORKER_USER: 'user_custom_worker' } });
  const customKey = deviceIdentity();
  await service.register({ userId: 'user_custom_worker', input: { deviceId: 'device_custom', publicKey: customKey.publicKey } });
  const grant = await service.issueToken({ userId: 'user_custom_worker', deviceId: 'device_custom', requestedScopes: ['rdmd:infer'],
    proof: signProof(customKey, 'user_custom_worker', 'device_custom', ['rdmd:infer']) });
  assert.deepEqual(grant.scopes, ['rdmd:infer']);

  const defaultKey = deviceIdentity();
  await service.register({ userId: DEFAULT_RDMD_WORKER_USER, input: { deviceId: 'device_default', publicKey: defaultKey.publicKey } });
  await assert.rejects(
    service.issueToken({ userId: DEFAULT_RDMD_WORKER_USER, deviceId: 'device_default', requestedScopes: ['rdmd:infer'],
      proof: signProof(defaultKey, DEFAULT_RDMD_WORKER_USER, 'device_default', ['rdmd:infer']) }),
    (error) => error.code === 'device_grant_scope_reserved',
  );
});

function apiError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function deviceIdentity() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  return { publicKey, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyFingerprint: rsaPublicKeyFingerprint(publicKey) };
}

function signProof(identity, userId, deviceId, scopes) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const message = deviceGrantProofMessage({ userId, deviceId, scopes, timestamp, nonce });
  return { timestamp, nonce, publicKeyFingerprint: identity.publicKeyFingerprint,
    signature: crypto.sign('sha256', Buffer.from(message), identity.privateKey).toString('base64') };
}

function authorize(pool, token, scope) {
  return new Promise((resolve, reject) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const middleware = routeWithDeviceGrant(pool, apiError, scope, async (authorizedRequest) => resolve(authorizedRequest.deviceGrant));
    middleware(req, {}, reject);
  });
}

async function insertUsers(pool, ids) {
  for (const id of ids) await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash)
    VALUES($1,$2,$3,$1,'test-hash')`, [id, `${id}@example.test`, id]);
}
