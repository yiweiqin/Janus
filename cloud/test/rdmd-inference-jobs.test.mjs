import assert from 'node:assert/strict';
import test from 'node:test';
import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import {
  RDMD_PLAN_EXEC_CONTRACT_VERSION,
  createPostgresRdmdService,
  stableStringify,
} from '../src/modules/rdmd/index.mjs';
import { RDMD_CLOUD_VERDICT_STATUSES, RDMD_DRIFT_TYPES, RDMD_RULE_VERSION } from '../src/modules/rdmd/contract.mjs';
import { auditRdmdCloudPayload } from '../src/modules/rdmd/privacy.mjs';
import { nullBackendVerdict, resolveRdmdBackend } from '../src/modules/rdmd/backend.mjs';

const ADAPTER_SHA = 'a'.repeat(64);

async function fixture({ env = {} } = {}) {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await migrate(pool);
  const service = createPostgresRdmdService({ pool, env: { RDMD_CLOUD_ENABLED: 'true', ...env } });
  return { pool, service };
}

/**
 * 真实 case 的形状：`planExecCase()` 产出的是 `{id, G_star, G_prime}`（见
 * src/shared/contracts/uBuddyPlanExec.js），而 predict.py 只读这三个键。
 *
 * **这个夹具过去是错的**，值得记一笔：它当初照着 privacy.mjs 的白名单写成了扁平的
 * `{nodes, edges}`，于是白名单里漏掉 `G_star`/`G_prime` 这个 bug 被测试完全掩盖 ——
 * 夹具与白名单互相印证，而真实 case 会被裁成空对象。夹具必须长得像**调用方**发的东西，
 * 不是像被测试的实现。
 */
function caseValue(overrides = {}) {
  const graph = (extra = {}) => ({
    nodes: [
      { id: 'n1', kind: 'root', title: '根', agentId: 'general_agent', status: 'completed', summary: '总览' },
      { id: 'n2', kind: 'agent_step', title: '第 1 步', agentId: 'research_agent', status: 'blocked' },
    ],
    edges: [{ id: 'n1->n2', from: 'n1', to: 'n2', kind: 'sequence_of' }],
    ...extra,
  });
  return {
    id: 'group_1',
    G_star: graph(),
    G_prime: graph(),
    // 这些字段**不在**白名单里，用来证明载荷确实只挑白名单。
    prompt: 'PRIVATE prompt /Users/alice/secret',
    rollout: 'raw rollout blob',
    label: { injected_node: 'n2', status: 'drift' },
    ...overrides,
  };
}

/** 在图上塞一个不在白名单里的字段，用来证明图**结构**也被裁剪。 */
function caseWithLeakyGraph(overrides = {}) {
  const value = caseValue();
  return {
    ...value,
    G_star: { ...value.G_star, internalRevisionNote: 'do not ship' },
    G_prime: { ...value.G_prime, internalRevisionNote: 'do not ship' },
    ...overrides,
  };
}

function apiError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * 测试里直读 jsonb 列时要自己解析：真实 Postgres（node-pg）给对象，pg-mem 给字符串。
 * 两个都认，测试才不会因为跑在哪个后端上而结论不同 —— 这类差异正是
 * `publicJob` 里 `jsonObject()` 存在的理由。
 */
function parseJsonb(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value) return JSON.parse(value);
  return value;
}

test('the cloud verdict statuses stay aligned with the drift vocabulary', () => {
  // 云侧只新增了这一个枚举，所以它必须被钉住：漏一个会让合法判定被 400，
  // 多一个会让桌面端收到它不认识的 status。
  assert.deepEqual([...RDMD_CLOUD_VERDICT_STATUSES], ['drift', 'no_drift', 'UNKNOWN']);
  assert.ok(RDMD_DRIFT_TYPES.length >= 5);
  assert.equal(RDMD_RULE_VERSION, 'rdmd_cloud_jobs_v1');
});

test('the null backend is the default, and an unknown value degrades to it instead of throwing', () => {
  assert.equal(resolveRdmdBackend('').name, 'null');
  assert.equal(resolveRdmdBackend(undefined).name, 'null');
  assert.equal(resolveRdmdBackend('gpu_worker').name, 'gpu_worker');
  // 配错不该让云 API 起不来 —— RDMD 是辅助能力，没资格把主服务拖下水。
  const fallback = resolveRdmdBackend('gp-worker-typo');
  assert.equal(fallback.name, 'null');
  assert.equal(fallback.warning, 'unknown_backend:gp-worker-typo');
});

test('the null backend verdict keeps the exact shape of a real UNKNOWN', () => {
  const verdict = nullBackendVerdict({ contractVersion: 'ubuddy_plan_exec_v2', ruleVersion: RDMD_RULE_VERSION });
  // 桌面端不该为"没有模型"写特殊分支 —— 那条分支必然会与真实 UNKNOWN 处理逻辑分叉。
  assert.deepEqual(Object.keys(verdict).sort(), ['nodeId', 'provenance', 'reason', 'status', 'type', 'valid', 'warnings']);
  assert.equal(verdict.status, 'UNKNOWN');
  assert.equal(verdict.reason, 'model_not_configured');
  assert.equal(verdict.nodeId, '');
  assert.equal(verdict.type, '');
});

test('submitting a case with the null backend finalizes it immediately and records why', async () => {
  const { pool, service } = await fixture();
  const result = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_1', case: caseValue() } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'model_not_configured');
  assert.equal(result.verdict.status, 'UNKNOWN');

    const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE id=$1', [result.jobId])).rows[0];
  assert.equal(row.status, 'unavailable');
  // 出处为空的**唯一**允许情形是"本来就没有模型"，且必须带上 reason，
  // 否则"为什么没有动作"就查不到了（P4 验收要读的就是这个 reason）。
  assert.equal(row.adapter_sha256, '');
  assert.equal(row.error_code, 'model_not_configured');
  assert.equal(parseJsonb(row.verdict_json).reason, 'model_not_configured');
});

test('the payload sent to the cloud contains only whitelisted fields', async () => {
  const { pool, service } = await fixture();
  const result = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_1', case: caseWithLeakyGraph() } });
  const row = (await pool.query('SELECT case_json FROM cloud_rdmd_inference_jobs WHERE id=$1', [result.jobId])).rows[0];
  const storedCase = parseJsonb(row.case_json);

  // 独立复核：读出真实落库的载荷，枚举每一个键路径，全都要在白名单里。
  assert.deepEqual(auditRdmdCloudPayload(storedCase), []);
  const serialized = JSON.stringify(storedCase);
  // prompt / rollout / label 是本地私有内容，一个字节都不许进云。
  assert.equal(serialized.includes('PRIVATE prompt'), false, 'prompt leaked into the cloud payload');
  assert.equal(serialized.includes('/Users/alice/secret'), false, 'local path leaked');
  assert.equal(serialized.includes('rollout'), false, 'rollout leaked');
  assert.equal(serialized.includes('injected_node'), false, 'label leaked');
  assert.equal(serialized.includes('internalRevisionNote'), false, 'graph-level field leaked past the whitelist');
  // 反过来：**模型要读的信号必须真的在**。少了这一条，一个把载荷裁空的 bug
  // （白名单漏掉 G_star/G_prime）会以"没有多余字段"的形式通过测试。
  // 判据来自 predict.py：它只读 case["G_star"]、case["G_prime"]、case.get("id")。
  assert.equal(storedCase.id, 'group_1');
  for (const key of ['G_star', 'G_prime']) {
    assert.equal(storedCase[key].nodes.length, 2, `${key} 必须完整送到 worker，它是模型的输入`);
    assert.equal(storedCase[key].nodes[1].status, 'blocked');
    assert.equal(storedCase[key].edges[0].kind, 'sequence_of');
  }
});

test('a private_assistant conversation is refused before anything is written', async () => {
  const { pool, service } = await fixture();
  const result = await service.submit({
    userId: 'alice',
    payload: { taskRunId: 'task_private', conversationKind: 'private_assistant', case: caseValue() },
  });
  assert.equal(result.status, 'not_eligible');
  assert.equal(result.reason, 'private_assistant_not_eligible');
  // 关键：不是"过滤掉再发"，而是**根本没发**。所以库里不该有这个 task run 的任何行。
  const rows = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE task_run_id=$1', ['task_private'])).rows;
  assert.deepEqual(rows, []);
});

test('an unknown conversation kind is refused rather than silently allowed', async () => {
  const { pool, service } = await fixture();
  const result = await service.submit({
    userId: 'alice',
    payload: { taskRunId: 'task_unknown_kind', conversationKind: 'some_future_mode', case: caseValue() },
  });
  // 以后新增会话类型时默认落在"不外发"这一侧，而不是被悄悄放行。
  assert.equal(result.status, 'not_eligible');
  assert.equal(result.reason, 'conversation_kind_unknown:some_future_mode');
  assert.deepEqual((await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows, []);
});

test('the capability flag gates the whole path, and is off by default', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_ENABLED: 'false' } });
  const result = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_off', case: caseValue() } });
  assert.equal(result.status, 'not_eligible');
  assert.equal(result.reason, 'capability_disabled');
  assert.deepEqual((await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows, []);
});

test('the gpu_worker backend queues the job instead of answering', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const result = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_gpu', case: caseValue() } });
  assert.equal(result.status, 'queued');
  assert.equal(result.verdict, null, '排队时不许给判定');
  const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE id=$1', [result.jobId])).rows[0];
  assert.equal(row.status, 'queued');
  assert.equal(row.verdict_json, null);
});

test('claim hands out one job with a lease, and a second claim gets nothing', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  await service.submit({ userId: 'bob', payload: { taskRunId: 'task_a', case: caseValue() } });

  const first = await service.claim({ workerId: 'worker-1' });
  assert.equal(first.jobs.length, 1);
  assert.equal(first.jobs[0].case.G_star.nodes.length, 2, 'worker 必须拿到 case，否则无法推理');
  assert.equal(first.leaseSeconds, 900);
  // 云侧随领活下发它认可的契约/规则版本，worker 原样回传。出处不能由被审计方自己声明。
  assert.equal(first.contractVersion, RDMD_PLAN_EXEC_CONTRACT_VERSION);
  assert.equal(first.ruleVersion, RDMD_RULE_VERSION);

  // 租约生效：同一次租期内别人领不到同一条。
  const second = await service.claim({ workerId: 'worker-2' });
  assert.deepEqual(second.jobs, []);

  const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows[0];
  assert.equal(row.status, 'claimed');
  assert.equal(row.claimed_by, 'worker-1');
  assert.equal(Number(row.attempt_count), 1);
});

test('an expired lease is handed to another worker', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  await service.submit({ userId: 'bob', payload: { taskRunId: 'task_expired', case: caseValue() } });
  await service.claim({ workerId: 'worker-dead' });
  // worker 掉线：租约到期。
  await pool.query("UPDATE cloud_rdmd_inference_jobs SET lease_expires_at = now() - interval '1 second'");

  const rescued = await service.claim({ workerId: 'worker-alive' });
  assert.equal(rescued.jobs.length, 1, '掉线 worker 的作业必须能被接走');
  const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows[0];
  assert.equal(row.claimed_by, 'worker-alive');
  assert.equal(Number(row.attempt_count), 2);
});

test('a job is not handed out more times than max_attempts', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  await service.submit({ userId: 'bob', payload: { taskRunId: 'task_max', case: caseValue() } });
  await pool.query('UPDATE cloud_rdmd_inference_jobs SET attempt_count = max_attempts');
  const result = await service.claim({ workerId: 'worker-x' });
  assert.deepEqual(result.jobs, [], '超出重试上限的作业不许再被领走（否则会无限重试）');
});

test('a job that exhausted its attempts reaches a terminal state instead of becoming a zombie', async () => {
  // 这是真机上暴露的洞：选行条件含 `attempt_count < max_attempts`，所以用尽了次数的作业
  // 永远不会再被选中 —— 若没有收尾，它就永远停在 claimed（租约过期、无人认领、也不是终态），
  // 既占着去重用的部分唯一索引，又让任何"作业都结束了吗"的判断永远为假。
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  await service.submit({ userId: 'bob', payload: { taskRunId: 'task_zombie', case: caseValue() } });
  await service.claim({ workerId: 'worker-dying' });
  // worker 领了活但没回传判定就死了（模型反复答不出、或进程被杀），租约自然过期。
  await pool.query("UPDATE cloud_rdmd_inference_jobs SET attempt_count = max_attempts, lease_expires_at = now() - interval '1 second'");

  const result = await service.claim({ workerId: 'worker-next' });
  assert.deepEqual(result.jobs, []);

  const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows[0];
  assert.equal(row.status, 'failed_terminal', '次数用尽 + 租约过期 = 终态，不能再是不生不死的 claimed');
  assert.equal(row.error_code, 'rdmd_attempts_exhausted');
  assert.equal(row.lease_expires_at, null);
  assert.ok(row.completed_at, '终态必须有完成时间，否则"这一批处理完了吗"没法查');
  assert.equal(row.verdict_json, null, '没有判定就是没有判定，不许给它塞一个空 verdict（约束也不允许）');
});

test('a job whose final attempt is still being worked on is not declared dead early', async () => {
  // 收尾必须等租约过期：最后一次尝试可能正被某个 worker 拿在手上跑，
  // 提前判死会让那次**真实判定**撞上"作业已不是 claimed"而被丢掉。
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const submitted = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_inflight', case: caseValue() } });
  await service.claim({ workerId: 'worker-slow' });
  // 最后一次尝试正在进行中：attempt 已用尽，但租约还活着。
  await pool.query('UPDATE cloud_rdmd_inference_jobs SET attempt_count = max_attempts');
  await service.claim({ workerId: 'worker-next' });

  const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows[0];
  assert.equal(row.status, 'claimed', '租约还活着就不许判死');
  assert.equal(row.claimed_by, 'worker-slow');

  // 它仍然来得及把判定交回来 —— 这正是我们不肯提前收尾的原因。
  const provenance = { adapterSha256: 'a'.repeat(64), baseModelId: 'Qwen/Qwen3-8B', contractVersion: RDMD_PLAN_EXEC_CONTRACT_VERSION };
  await service.recordVerdict({ jobId: submitted.jobId, payload: { verdict: { status: 'no_drift', valid: true }, provenance } });
  const done = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows[0];
  assert.equal(done.status, 'completed');
});

test('terminalizing an exhausted job frees its task run for a fresh submission', async () => {
  // 收尾不只是好看：去重用的部分唯一索引只覆盖未结束的作业，所以僵尸行会把同一个
  // task run 的新提交一直撞在 ON CONFLICT 上（或复用一个永远不会完成的旧作业）。
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  await service.submit({ userId: 'bob', payload: { taskRunId: 'task_freed', case: caseValue() } });
  await service.claim({ workerId: 'worker-a' });
  await pool.query("UPDATE cloud_rdmd_inference_jobs SET attempt_count = max_attempts, lease_expires_at = now() - interval '1 second'");
  await service.claim({ workerId: 'worker-b' });

  const resubmitted = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_freed', case: caseValue() } });
  const rows = (await pool.query("SELECT status FROM cloud_rdmd_inference_jobs WHERE task_run_id = 'task_freed' ORDER BY created_at")).rows;
  assert.equal(rows.length, 2, '旧的僵尸行要留痕，新的提交要能进去');
  assert.equal(rows[0].status, 'failed_terminal');
  assert.equal(resubmitted.status, 'queued');
});

test('a verdict without provenance is rejected, and the job stays claimable', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const submitted = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_prov', case: caseValue() } });
  await service.claim({ workerId: 'worker-1' });

  const verdict = { status: 'drift', nodeId: 'n2', type: 'wrong_agent', valid: true };
  // 缺 adapter sha256：不可审计的判定等于没有判定。
  await assert.rejects(
    () => service.recordVerdict({ jobId: submitted.jobId, payload: { verdict } }),
    (error) => error.code === 'rdmd_provenance_missing_adapter',
  );
  // 占位符不算出处。
  await assert.rejects(
    () => service.recordVerdict({ jobId: submitted.jobId, payload: { verdict, provenance: { adapterSha256: 'unknown', baseModelId: 'Qwen/Qwen3-8B' } } }),
    (error) => error.code === 'rdmd_provenance_invalid_adapter',
  );
  // 截断的哈希也不算。
  await assert.rejects(
    () => service.recordVerdict({ jobId: submitted.jobId, payload: { verdict, provenance: { adapterSha256: ADAPTER_SHA.slice(0, 16), baseModelId: 'Qwen/Qwen3-8B' } } }),
    (error) => error.code === 'rdmd_provenance_invalid_adapter',
  );
  // 缺契约版本同样拒收。
  await assert.rejects(
    () => service.recordVerdict({ jobId: submitted.jobId, payload: { verdict, provenance: { adapterSha256: ADAPTER_SHA, baseModelId: 'Qwen/Qwen3-8B' } } }),
    (error) => error.code === 'rdmd_provenance_missing_contract',
  );

  const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE id=$1', [submitted.jobId])).rows[0];
  assert.equal(row.status, 'claimed', '被拒的回传不许改变作业状态');
  assert.equal(row.verdict_json, null);
});

test('a valid verdict is stored with full provenance, and a replay is idempotent', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const submitted = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_ok', case: caseValue() } });
  await service.claim({ workerId: 'worker-1' });

  const payload = {
    verdict: { status: 'drift', nodeId: 'n2', type: 'wrong_agent', valid: true, warnings: [] },
    provenance: {
      adapterSha256: ADAPTER_SHA, baseModelId: 'Qwen/Qwen3-8B',
      contractVersion: 'ubuddy_plan_exec_v2', ruleVersion: RDMD_RULE_VERSION, workerVersion: 'rdmd-gpu-worker/1',
    },
  };
  const first = await service.recordVerdict({ jobId: submitted.jobId, payload });
  assert.equal(first.status, 'completed');
  assert.equal(first.replay, false);
  assert.equal(first.verdict.provenance.adapterSha256, ADAPTER_SHA);

  const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE id=$1', [submitted.jobId])).rows[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.adapter_sha256, ADAPTER_SHA);
  assert.equal(row.base_model_id, 'Qwen/Qwen3-8B');
  assert.equal(row.contract_version, 'ubuddy_plan_exec_v2');
  assert.equal(row.rule_version, RDMD_RULE_VERSION);
  assert.ok(row.completed_at);
  assert.equal(row.lease_expires_at, null, '终态必须释放租约');

  // worker 重试是常态（租约到期后别人接走），回传必须幂等而不是覆盖。
  const replay = await service.recordVerdict({ jobId: submitted.jobId, payload: {
    verdict: { status: 'no_drift', valid: true }, provenance: payload.provenance,
  } });
  assert.equal(replay.replay, true);
  const after = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE id=$1', [submitted.jobId])).rows[0];
  assert.equal(after.verdict_json.status, 'drift', '重放不许覆盖已完成的判定');
});

test('a verdict with an unknown drift type is rejected instead of being silently routed', async () => {
  const { service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const submitted = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_type', case: caseValue() } });
  await service.claim({ workerId: 'worker-1' });
  // `routeEvolution` 对未知 type 是兜底成 minimal_plan_edit，所以这里必须拦 ——
  // 放宽会让一个概念外的类型变成一次改图动作（与桌面端第 5 条防线同源）。
  await assert.rejects(
    () => service.recordVerdict({ jobId: submitted.jobId, payload: {
      verdict: { status: 'drift', nodeId: 'n2', type: 'conceptual_drift', valid: true },
      provenance: { adapterSha256: ADAPTER_SHA, baseModelId: 'Qwen/Qwen3-8B', contractVersion: 'v2' },
    } }),
    (error) => error.code === 'rdmd_verdict_type_invalid',
  );
});

test('a drift verdict must name both a node and a type', async () => {
  const { service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const submitted = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_incomplete', case: caseValue() } });
  await service.claim({ workerId: 'worker-1' });
  await assert.rejects(
    () => service.recordVerdict({ jobId: submitted.jobId, payload: {
      verdict: { status: 'drift', nodeId: 'n2', valid: true },
      provenance: { adapterSha256: ADAPTER_SHA, baseModelId: 'Qwen/Qwen3-8B', contractVersion: 'v2' },
    } }),
    (error) => error.code === 'rdmd_verdict_incomplete',
  );
});

test('an abstention carries no type even if the worker sends one', async () => {
  const { service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const submitted = await service.submit({ userId: 'bob', payload: { taskRunId: 'task_abstain', case: caseValue() } });
  await service.claim({ workerId: 'worker-1' });
  const result = await service.recordVerdict({ jobId: submitted.jobId, payload: {
    verdict: { status: 'UNKNOWN', nodeId: '', type: 'wrong_agent', valid: true },
    provenance: { adapterSha256: ADAPTER_SHA, baseModelId: 'Qwen/Qwen3-8B', contractVersion: 'v2' },
  } });
  assert.equal(result.verdict.type, '', '弃权不该带 type：带了就等于给了一个未经确认的归因');
});

test('resubmitting the same task run reuses the open job instead of stacking rows', async () => {
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const first = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_dup', case: caseValue() } });
  const second = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_dup', case: caseValue() } });
  // 终态上的 notifyTaskUpdated 会被调用多次，所以重放必须命中同一行。
  assert.equal(second.jobId, first.jobId);
  assert.equal((await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows.length, 1);
});

test('a new task run gets its own job, and a finished one is not reused', async () => {
  // 去重只针对**未结束**的作业。判完的作业必须留着（它是审计记录），
  // 而同一个 task run 之后再来一次（比如用户重跑）应该是新作业。
  const { pool, service } = await fixture({ env: { RDMD_CLOUD_BACKEND: 'gpu_worker' } });
  const first = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_seq', case: caseValue() } });
  await service.claim({ workerId: 'worker-1' });
  await service.recordVerdict({ jobId: first.jobId, payload: {
    verdict: { status: 'no_drift', valid: true },
    provenance: { adapterSha256: 'b'.repeat(64), baseModelId: 'Qwen/Qwen3-8B', contractVersion: 'v2' },
  } });

  const second = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_seq', case: caseValue() } });
  assert.notEqual(second.jobId, first.jobId, '已判完的作业不该被复用（否则历史判定会被覆盖）');
  assert.equal((await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows.length, 2);

  const other = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_other', case: caseValue() } });
  assert.notEqual(other.jobId, second.jobId, '不同 task run 必须是不同作业');
  assert.equal((await pool.query('SELECT * FROM cloud_rdmd_inference_jobs')).rows.length, 3);
});

test('reads are scoped to the owner', async () => {
  const { service } = await fixture();
  const submitted = await service.submit({ userId: 'alice', payload: { taskRunId: 'task_owner', case: caseValue() } });
  assert.equal((await service.read({ userId: 'alice', jobId: submitted.jobId })).jobId, submitted.jobId);
  await assert.rejects(
    () => service.read({ userId: 'mallory', jobId: submitted.jobId }),
    (error) => error.code === 'rdmd_job_not_found',
  );
});

test('the case hash is stable across key orderings', () => {
  // 哈希是去重与"这份载荷有没有变过"的判据，键序不同不该算成不同的 case。
  const left = { a: 1, b: [2, 3], c: { d: 4, e: 5 } };
  const right = { c: { e: 5, d: 4 }, b: [2, 3], a: 1 };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.notEqual(stableStringify(left), stableStringify({ ...left, a: 2 }));
});

test('the migration constraint refuses a half-written verdict', async () => {
  const { pool } = await fixture();
  // 数据库这一层的 CHECK 是"出处与判定同生共死"的最后一道闸：
  // 应用层已经拦了，但这是数据库能自己保证的事，所以它必须真的生效。
  await assert.rejects(() => pool.query(`INSERT INTO cloud_rdmd_inference_jobs
    (id,owner_user_id,status,case_json,verdict_json,adapter_sha256) VALUES ($1,$2,'completed',$3::jsonb,$4::jsonb,'')`,
  ['job_bad', 'alice', '{}', '{"status":"drift"}']));
  // 反过来：status 不是 completed 时不许有 verdict。
  await assert.rejects(() => pool.query(`INSERT INTO cloud_rdmd_inference_jobs
    (id,owner_user_id,status,case_json,verdict_json) VALUES ($1,$2,'queued',$3::jsonb,$4::jsonb)`,
  ['job_bad2', 'alice', '{}', '{"status":"drift"}']));
});

test('an unexpected status is refused by the database state machine', async () => {
  const { pool } = await fixture();
  await assert.rejects(() => pool.query(`INSERT INTO cloud_rdmd_inference_jobs
    (id,owner_user_id,status,case_json) VALUES ($1,$2,'half_done',$3::jsonb)`, ['job_bad3', 'alice', '{}']));
});
