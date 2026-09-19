import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createTpmAccessService, statusOf } from '../src/modules/tpm/index.mjs';

/**
 * 这些用例跑的是**真迁移**（`migrate(pool)` 会把 `099_ubuddy_task_public_memory.sql`
 * 一起装上），所以它们同时是「迁移 099 在 pg-mem 里装得上吗」的守门人。
 */

const OWNER = 'user_tpm_owner';
const REQUESTER = 'user_tpm_requester';

/** 一个三层的 TPM：foundation 有图、elevation 有摘要、raw 有原始上下文。 */
function memory({ withSecret = false } = {}) {
  return {
    version: 'ubuddy_task_public_memory_v1',
    taskId: 'task_share_2023_2025',
    ownerUserId: OWNER,
    participantUserIds: ['user_participant_a', 'user_participant_b'],
    foundation: {
      plan: { nodes: [{ id: 'n1', title: '汇总线上份额' }, { id: 'n2', title: '核对口径' }], edges: [{ id: 'e1', from: 'n1', to: 'n2' }] },
      exec: { nodes: [{ id: 'n1', title: '汇总线上份额', status: 'done' }], edges: [] },
    },
    elevation: [
      { id: 'elev_raw_1', sourceRawId: 'raw_1', kind: 'summary', title: '线上份额口径摘要', summary: '线上份额口径按渠道拆分，取数窗口 2023-2025。' },
    ],
    raw: withSecret ? [
      { id: 'raw_1', nodeId: 'n1', title: '取数原始导出', content: 'api_key: sk-abcdefghijklmnopqrst' },
    ] : [
      { id: 'raw_1', nodeId: 'n1', title: '取数原始导出', content: '渠道 A 2023 线上份额 31.2%，渠道 B 19.8%……（很长的原始表格）' },
      { id: 'raw_2', nodeId: 'n2', title: '口径讨论原话', content: '原始讨论：要不要把渠道 C 算进线上？' },
    ],
  };
}

function request(overrides = {}) {
  return {
    requestId: 'tpm_req_test_1',
    sourceTaskId: 'task_other_task',
    targetTaskId: 'task_share_2023_2025',
    requesterUserId: REQUESTER,
    purpose: '线上份额口径要对齐到我们自己的汇报，想看原始取数口径',
    nodeIds: ['n1'],
    excerptOnly: true,
    createdAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

async function build() {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memoryDb.adapters.createPg();
  const pool = new adapter.Pool();
  await migrate(pool);
  // 审计表 requester_user_id 上有 → users(id) 外键，两个身份都得先存在。
  for (const id of [OWNER, REQUESTER, 'user_participant_a']) {
    await pool.query(
      `INSERT INTO users(id,email,display_name,username,password_hash)
       VALUES($1,$2,$3,$1,'test-hash') ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@example.test`, id],
    );
  }
  return { pool, service: createTpmAccessService({ pool }) };
}

test('TPM migration 099 installs and both tables start empty', async (t) => {
  const { pool } = await build();
  t.after(() => pool.end());
  const applied = await pool.query(`SELECT filename FROM schema_migrations WHERE filename LIKE '099%'`);
  assert.equal(applied.rowCount, 1);
  for (const table of ['cloud_tpm_raw_access_requests', 'cloud_tpm_raw_access_grants']) {
    const count = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(count.rows[0].n, 0, `${table} 应该是空的`);
  }
});

test('a clean request is persisted, granted, and audited', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());

  const outcome = await service.requestRawAccess({
    request: request(), memory: memory(), ownerDecision: 'approve', actorUserId: OWNER,
  });

  assert.equal(outcome.ai.decision, 'pass', `AI 预审应该放行，实际 reasons=${outcome.ai.reasons}`);
  assert.equal(outcome.status, 'granted');
  assert.equal(outcome.grant.grantId, 'tpm_grant_tpm_req_test_1');
  assert.equal(outcome.grant.readOnly, true);
  assert.equal(outcome.grant.revocable, true);
  // 申请人自己看到的投影里，三层都在，且 raw 只给了申请窗口内的那一条。
  assert.deepEqual(outcome.projection.layers, ['foundation', 'elevation', 'raw']);
  assert.deepEqual(outcome.projection.raw.map((item) => item.id), ['raw_1']);

  const req = (await pool.query('SELECT * FROM cloud_tpm_raw_access_requests WHERE id=$1', ['tpm_req_test_1'])).rows[0];
  assert.equal(req.status, 'granted');
  assert.equal(req.ai_decision, 'pass');
  assert.equal(req.owner_decision, 'approve');
  assert.equal(req.owner_user_id, OWNER);
  assert.deepEqual(req.node_ids_json, ['n1']);

  const grant = (await pool.query('SELECT * FROM cloud_tpm_raw_access_grants WHERE request_id=$1', ['tpm_req_test_1'])).rows[0];
  assert.equal(grant.grantee_user_id, REQUESTER);
  assert.equal(grant.target_task_id, 'task_share_2023_2025');

  const audit = (await pool.query('SELECT * FROM cloud_work_memory_access_audits')).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].result, 'approved');
  assert.equal(audit[0].result_code, 'granted');
  assert.equal(audit[0].requester_user_id, REQUESTER);
  assert.equal(audit[0].target_user_id, OWNER, '审计里的 target_user 是 raw 的属主，不是审批人');
  assert.equal(audit[0].work_scope_id, 'task_share_2023_2025');
});

test('AI rejects a purpose-less request before any human sees it, and nothing is granted', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());

  const outcome = await service.requestRawAccess({
    request: request({ requestId: 'tpm_req_nopurpose', purpose: '' }),
    memory: memory(), ownerDecision: 'approve', actorUserId: OWNER,
  });

  assert.equal(outcome.ai.decision, 'reject');
  assert.ok(outcome.ai.reasons.includes('missing_purpose'));
  assert.equal(outcome.status, 'rejected_by_ai');
  assert.equal(outcome.grant, null);
  // 关键：**即使 owner 批了**，AI 先拒就不该出现授权行。
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cloud_tpm_raw_access_grants')).rows[0].n, 0);
  const audit = (await pool.query('SELECT * FROM cloud_work_memory_access_audits')).rows[0];
  assert.equal(audit.result, 'denied');
  assert.equal(audit.result_code, 'rejected_by_ai');
});

test('the owner can deny what the AI passed, and that is recorded as denied_by_owner', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  const outcome = await service.requestRawAccess({
    request: request(), memory: memory(), ownerDecision: 'deny', actorUserId: OWNER,
  });
  assert.equal(outcome.ai.decision, 'pass');
  assert.equal(outcome.status, 'denied_by_owner');
  assert.equal(outcome.grant, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cloud_tpm_raw_access_grants')).rows[0].n, 0);
  const req = (await pool.query('SELECT * FROM cloud_tpm_raw_access_requests WHERE id=$1', ['tpm_req_test_1'])).rows[0];
  // AI 的那一列必须留着 —— 「AI 放行、人拦下」这个数才是这套机制值得看的地方。
  assert.equal(req.ai_decision, 'pass');
  assert.equal(req.owner_decision, 'deny');
});

test('a non-participant sees nothing without a grant, and all three layers with one', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());

  // 这是合约里**明文断言过**的行为（`uBuddyTaskPublicMemory.test.js` 的
  // 「other-task viewers see nothing without a grant」）：非参与者连 foundation
  // 都看不到。注意它与「原始层要申请」不是一回事 —— 参与者才是"前两层默认可见"
  // 的那个群体。这条用例把这个区别钉在这里。
  const locked = await service.readRaw({
    memory: memory(), requesterUserId: REQUESTER, sourceTaskId: 'task_other_task',
  });
  assert.equal(locked.unlocked, false);
  assert.deepEqual(locked.projection.layers, []);
  assert.ok(locked.projection.denied.includes('not_participant_and_no_grant'));
  assert.equal(locked.projection.foundation, null);
  assert.equal(locked.projection.raw.length, 0);

  await service.requestRawAccess({ request: request(), memory: memory(), ownerDecision: 'approve', actorUserId: OWNER });

  const unlocked = await service.readRaw({
    memory: memory(), requesterUserId: REQUESTER, sourceTaskId: 'task_other_task',
  });
  assert.equal(unlocked.unlocked, true);
  assert.deepEqual(unlocked.projection.layers, ['foundation', 'elevation', 'raw']);
  assert.deepEqual(unlocked.projection.raw.map((item) => item.id), ['raw_1']);
  // excerptOnly=true ⇒ 正文被截断到 280 字符。这是"授权 ≠ 全文"的那一层保护。
  assert.ok(unlocked.projection.raw[0].content.length <= 280);
  assert.equal(unlocked.grant.excerptOnly, true);

  // 参与者走的是另一条路：前两层直接可见，raw 依然要申请。
  const participant = await service.readRaw({
    memory: memory(), requesterUserId: 'user_participant_a', sourceTaskId: 'task_share_2023_2025',
  });
  assert.equal(participant.unlocked, false, '参与者也只有前两层 —— 原始层的闸门是申请，不是身份');
  assert.deepEqual(participant.projection.layers, ['foundation', 'elevation']);
  assert.ok(participant.projection.denied.includes('raw_requires_grant'));
});

test('readRaw has no grant parameter: deleting the grant row re-locks raw', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  await service.requestRawAccess({ request: request(), memory: memory(), ownerDecision: 'approve', actorUserId: OWNER });
  assert.equal((await service.readRaw({ memory: memory(), requesterUserId: REQUESTER, sourceTaskId: 'task_other_task' })).unlocked, true);

  // 这条断言就是「授权从库里来」的负对照：把行删掉，读路径必须立刻变回锁着的。
  // 如果哪天有人把 grant 改成参数传进来，这条会红。
  await pool.query('DELETE FROM cloud_tpm_raw_access_grants');
  const after = await service.readRaw({ memory: memory(), requesterUserId: REQUESTER, sourceTaskId: 'task_other_task' });
  assert.equal(after.unlocked, false);
  assert.equal(after.grant, null);
});

test('revoking keeps the row (history survives) but closes the read path', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  const granted = await service.requestRawAccess({ request: request(), memory: memory(), ownerDecision: 'approve', actorUserId: OWNER });

  const revoked = await service.revokeGrant({ grantId: granted.grant.grantId, actorUserId: OWNER });
  assert.ok(revoked.revoked_at, '撤回只写时间戳');

  assert.equal((await service.readRaw({ memory: memory(), requesterUserId: REQUESTER, sourceTaskId: 'task_other_task' })).unlocked, false);
  assert.equal((await service.listGrants({ targetTaskId: 'task_share_2023_2025' })).length, 0, '默认不含已撤回');
  assert.equal((await service.listGrants({ targetTaskId: 'task_share_2023_2025', includeRevoked: true })).length, 1, '带 includeRevoked 时还在');
  await assert.rejects(service.revokeGrant({ grantId: granted.grant.grantId }), (error) => error.code === 'tpm_grant_not_found');
});

test('rerunning the same request is idempotent, and a bad ownerDecision is refused loudly', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  for (let i = 0; i < 3; i += 1) {
    await service.requestRawAccess({ request: request(), memory: memory(), ownerDecision: 'approve', actorUserId: OWNER });
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cloud_tpm_raw_access_requests')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cloud_work_memory_access_audits')).rows[0].n, 1);

  // 纯函数对 `'approve '` 会静默降级成 deny；落库边界上必须响亮地拒绝，
  // 否则一条"被拒"的申请会被调用方当成批过了。
  await assert.rejects(
    service.requestRawAccess({ request: request({ requestId: 'tpm_req_2' }), memory: memory(), ownerDecision: 'approve ' }),
    (error) => error.code === 'tpm_owner_decision_invalid',
  );
});

test('a request that wants full text over a too-wide window is rejected, and secrets block full text', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  const wide = await service.requestRawAccess({
    request: request({ requestId: 'tpm_req_wide', nodeIds: Array.from({ length: 9 }, (_, i) => `n${i}`), excerptOnly: false }),
    memory: memory(), ownerDecision: 'approve', actorUserId: OWNER,
  });
  assert.ok(wide.ai.reasons.includes('scope_too_wide'));
  assert.equal(wide.status, 'rejected_by_ai');

  const secret = await service.requestRawAccess({
    request: request({ requestId: 'tpm_req_secret', nodeIds: ['raw_1'], excerptOnly: false }),
    memory: memory({ withSecret: true }), ownerDecision: 'approve', actorUserId: OWNER,
  });
  assert.ok(secret.ai.reasons.includes('raw_contains_secrets'));
  assert.equal(secret.status, 'rejected_by_ai');

  // 同样的窗口只要摘录，就不触发 secret 规则：摘录路径本身就是缓解手段。
  const excerpt = await service.requestRawAccess({
    request: request({ requestId: 'tpm_req_excerpt', nodeIds: ['raw_1'], excerptOnly: true }),
    memory: memory({ withSecret: true }), ownerDecision: 'approve', actorUserId: OWNER,
  });
  assert.equal(excerpt.status, 'granted');
});

test('a purpose that is not grounded in the elevation raises need_human instead of pass', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  const outcome = await service.requestRawAccess({
    request: request({ requestId: 'tpm_req_ungrounded', purpose: 'zzz qqq wwww' }),
    memory: memory(), ownerDecision: 'approve', actorUserId: OWNER,
  });
  assert.equal(outcome.ai.decision, 'need_human');
  assert.ok(outcome.ai.reasons.includes('purpose_not_grounded'));
  // need_human 不等于拒：人批了照样成立，状态是 granted。
  assert.equal(outcome.status, 'granted');
});

test('statusOf is the single derivation point and never says granted without an approve', () => {
  assert.equal(statusOf({ decision: 'reject' }, null), 'rejected_by_ai');
  assert.equal(statusOf({ decision: 'pass' }, { decision: 'deny' }), 'denied_by_owner');
  assert.equal(statusOf({ decision: 'need_human' }, { decision: 'approve' }), 'granted');
  // 没有 owner 阶段（AI 就拒了）时不许出现 granted。
  assert.equal(statusOf({ decision: 'need_human' }, null), 'denied_by_owner');
});
