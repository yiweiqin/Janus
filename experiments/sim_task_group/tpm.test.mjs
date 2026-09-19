/**
 * `tpm.mjs` 的本地测试。
 *
 * 跑的是**真 pg-mem 库 + 真迁移**（含 099），不是假 pool：这条链的性质全在库上
 * （授权行只在批了的时候出现、读路径从库里取授权、撤回立刻关上、审计真的写了），
 * 假 pool 只能证明"代码把什么 SQL 发出去了"，而这里要证明的恰恰是"库里最终是什么状态"。
 *
 * 所以这份测试同时是两件事的守门人：
 *   1. 迁移 099 的两张表真的能用（建表、外键、jsonb、ON CONFLICT 都对得上）；
 *   2. 上面那四条性质在真库上成立。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../../cloud/src/db.mjs';
import { inspectElevationItems } from '../../src/shared/contracts/uBuddyTaskPublicMemory.js';
import { buildBriefs } from './lib/protocol.mjs';
import { generate } from './simulate.mjs';
import {
  SIM_REQUESTER_TASK_ID, SIM_REQUESTER_USER_ID, buildTpmMemory, ensureSimUsers, exerciseCase,
  groundedPurpose, pickWindow,
} from './tpm.mjs';
import { createTpmAccessService } from '../../cloud/src/modules/tpm/index.mjs';

const BRIEF = buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 2 })[0];

async function build() {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memoryDb.adapters.createPg();
  const pool = new adapter.Pool();
  await migrate(pool);
  await ensureSimUsers(pool);
  return { pool, service: createTpmAccessService({ pool }) };
}

/** 真 case：走 `generate`，别手搓形状（形状错会让失败看起来像别的问题）。 */
async function sampleCase() {
  const result = await generate({ briefs: [BRIEF], mode: 'offline' });
  assert.ok(result.cases.length > 0, '生成器一条 case 都没出');
  return result.cases[0];
}

test('buildTpmMemory derives three layers from one case, and the request window hits real nodes', async () => {
  const sample = await sampleCase();
  const { memory, inspected } = buildTpmMemory({
    sample, brief: BRIEF, taskId: 'sim_demo', ownerUserId: 'owner_u', participantUserIds: ['owner_u'],
  });
  assert.ok(memory.foundation.plan.nodes.length >= 2, '规划图应该有几个节点');
  assert.ok(memory.foundation.exec.nodes.length >= 2, '执行图应该有几个节点');
  assert.ok(memory.raw.length > 0, 'raw 不该是空的');
  // 每个 raw 都指向一个真实存在的图节点；否则"申请窗口"是空的指向。
  const graphIds = new Set(memory.foundation.plan.nodes.map((node) => node.id));
  for (const item of memory.raw) assert.ok(graphIds.has(item.nodeId), `${item.nodeId} 不在规划图里`);
  // 提升层是省检过的视图，且**不含**容器层那两条。
  assert.ok(memory.elevation.length <= memory.raw.length);
  assert.equal(inspected.rejected, 0, '派生正文不该触发密钥规则（触发了说明派生逻辑变了）');
  for (const item of memory.elevation) {
    // 提升层保留**来源**的 kind（这里 raw 是 context），而它自己的 `summary`
    // 才是省检后的视图正文。
    assert.equal(item.kind, 'context');
    assert.equal(item.sourceRawId.slice(0, 4), 'raw_');
    assert.ok(item.summary.length <= 500);
  }
  const window = pickWindow(memory, 2);
  assert.equal(window.length, 2);
  // purpose 必须落在提升层上 —— 这是 AI 预审那条 `purpose_not_grounded` 的前提。
  const purpose = groundedPurpose({ elevationTitle: memory.elevation[0].title, briefTitle: BRIEF.title });
  assert.ok(purpose.includes(memory.elevation[0].title));
});

test('contract inspection really drops secret-bearing raw items from elevation only', () => {
  const inspected = inspectElevationItems([
    { id: 'raw_ok', title: '取数记录', content: '渠道 A 的线上份额 31.2%' },
    { id: 'raw_leak', title: '取数记录', content: 'api_key: sk-abcdefghijklmnopqrst' },
  ]);
  assert.equal(inspected.accepted.length, 1);
  assert.deepEqual(inspected.rejected.map((item) => item.reason), ['inspect_failed_secret_or_empty']);
  // **摘要被丢了，但 raw 那边的原件还在** —— 这是"提升层=省检视图，原始层=全部"的分界。
  assert.equal(inspected.accepted[0].sourceRawId, 'raw_ok');
});

test('the whole apply→review→read→revoke chain holds on a real migrated database', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  const sample = await sampleCase();

  // 走 `exerciseCase` 本体（它自己会断言不变式），再看它落下的观测。
  const observed = await exerciseCase({ pool, service, sample, brief: BRIEF, graphPresent: false });

  assert.deepEqual(observed.steps.find((step) => step.step === 'locked_before_request').layers, []);
  assert.ok(observed.steps.find((step) => step.step === 'locked_before_request')
    .denied.includes('not_participant_and_no_grant'));
  const granted = observed.steps.find((step) => step.step === 'request_granted');
  assert.equal(granted.ai, 'pass');
  assert.equal(granted.status, 'granted');
  assert.equal(granted.readOnly, true);
  assert.equal(granted.revocable, true);
  const unlocked = observed.steps.find((step) => step.step === 'unlocked_after_grant');
  assert.deepEqual(unlocked.layers, ['foundation', 'elevation', 'raw']);
  assert.deepEqual([...unlocked.rawNodeIds].sort(), [...observed.window].sort(), 'raw 只给申请窗口内那几条');
  assert.ok(unlocked.maxContentLength <= 280, `摘录该被截断，实际 ${unlocked.maxContentLength}`);
  assert.equal(observed.steps.find((step) => step.step === 'ai_rejected_no_purpose').status, 'rejected_by_ai');
  assert.equal(observed.steps.find((step) => step.step === 'revoked_relocks').layers.includes('raw'), false);
  assert.equal(observed.steps.find((step) => step.step === 'revoked_relocks').liveGrants, 0);
  assert.equal(observed.steps.find((step) => step.step === 'revoked_relocks').grantRows, 1, '撤回只写时间戳，行要留着');
  // 审计：一次 granted 的申请 + 一次 revoked 的读 + 被拒的那条。
  assert.ok(observed.db.auditRowsByResultCode.granted >= 1);
  assert.ok(observed.db.auditRowsByResultCode.rejected_by_ai >= 1);
  assert.ok(observed.db.auditRowsByResultCode.revoked >= 1);
  assert.equal(observed.db.requests, 3, '三次申请各一行');
});

test('the whole flow is idempotent: rerunning clears state, keeps the audit log growing', async (t) => {
  const { pool } = await build();
  t.after(() => pool.end());
  const sample = await sampleCase();
  const service = createTpmAccessService({ pool });
  const first = await exerciseCase({ pool, service, sample, brief: BRIEF, graphPresent: false });
  assert.equal(first.stateReset, 'none', '第一次跑没有可清的状态');
  const before = await pool.query('SELECT count(*)::int AS n FROM cloud_tpm_raw_access_requests');
  const auditsBefore = await pool.query('SELECT count(*)::int AS n FROM cloud_work_memory_access_audits');
  const second = await exerciseCase({ pool, service, sample, brief: BRIEF, graphPresent: false });
  // 上一轮留下的那条授权是**已撤回**的，重跑时清掉 —— 已撤回的授权绝不复活。
  assert.match(second.stateReset, /^cleared_previous_run:1$/);
  const after = await pool.query('SELECT count(*)::int AS n FROM cloud_tpm_raw_access_requests');
  assert.equal(after.rows[0].n, before.rows[0].n, '同一份申请重跑不该多出行');
  // 审计是追加式流水：重跑就是又发生了一次，理应多行。两件事不矛盾 ——
  // 一个是"当前真相"，一个是"发生过什么"。
  const auditsAfter = await pool.query('SELECT count(*)::int AS n FROM cloud_work_memory_access_audits');
  assert.ok(auditsAfter.rows[0].n > auditsBefore.rows[0].n, '审计该增长');
});

test('a leaked request cannot get a grant merely because the requester asks again', async (t) => {
  const { pool, service } = await build();
  t.after(() => pool.end());
  const sample = await sampleCase();
  const taskId = `sim_${sample.graph_id}`.slice(0, 160);
  const { memory } = buildTpmMemory({ sample, brief: BRIEF, taskId, ownerUserId: 'owner_u' });

  // 没有 purpose：AI 拒。**owner 明确批了**也不该出现授权行 ——
  // 这套流程的"闸门"是两级串联，任何一级关着就不通。
  const rejected = await service.requestRawAccess({
    request: {
      requestId: `tpm_req_${taskId}_nopurpose`, sourceTaskId: SIM_REQUESTER_TASK_ID, targetTaskId: taskId,
      requesterUserId: SIM_REQUESTER_USER_ID, nodeIds: pickWindow(memory, 2), purpose: '', excerptOnly: true,
    },
    memory, ownerDecision: 'approve', actorUserId: 'owner_u',
  });
  assert.equal(rejected.status, 'rejected_by_ai');
  assert.equal(rejected.grant, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cloud_tpm_raw_access_grants')).rows[0].n, 0);
  // 读路径也依然是锁着的。
  const read = await service.readRaw({ memory, requesterUserId: SIM_REQUESTER_USER_ID, sourceTaskId: SIM_REQUESTER_TASK_ID });
  assert.equal(read.unlocked, false);
});

test('a missing sim identity fails with an actionable error, not an FK error from the audit table', async (t) => {
  // 这是上面那条守门逻辑自己的负对照：不做这道检查的话，症状是一句
  // `violates foreign key constraint on table "cloud_work_memory_access_audits_requester_user_id_fkey"`，
  // 而它出现在一条 INSERT INTO users 的语境里 —— 第一眼只会以为 users 表坏了。
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memoryDb.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await migrate(pool);
  const sample = await sampleCase();
  await assert.rejects(
    exerciseCase({ pool, service: createTpmAccessService({ pool }), sample, brief: BRIEF }),
    (error) => /sim_tpm_identity_missing/.test(error.message) && /user_sim_tpm_requester/.test(error.message),
  );
});
