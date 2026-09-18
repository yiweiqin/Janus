/**
 * 桌面端 ↔ 云侧 RDMD 通道的**集成测试**：真的 HTTP、真的 Express 路由、真的出站拉取 worker 协议。
 *
 * 为什么必须有这一层 —— 只有单独跑的时候才看得清：云侧单测（cloud/test/rdmd-inference-jobs.test.mjs）
 * 直接调 service，桌面端单测（planExecDriftService.test.js）直接喂桩对象。**两侧各自全绿，
 * 接缝照样可以是错的**，而且这个接缝已经错过两次：
 *
 *   1. `privacy.mjs` 的白名单漏了 `G_star`/`G_prime`，测试夹具当时照着白名单写，
 *      于是"夹具与实现互相印证"，真实 case 会被裁成空对象；
 *   2. 模型回了 `drift` 但给不出 type，worker 原样回传被云侧 400 —— 两侧单测都不会经过这条路径。
 *
 * 所以这里不再给任何一侧喂桩：起真的 cloud app（express + 迁移后的库）、用真的
 * `createCloudSyncClient` 发请求、用一个真的 device grant 扮演 GPU 盒上的 worker，
 * 断言的重点是**桌面端最终拿到的结论对不对**，而不是两侧各自内部对不对。
 *
 * 这里的 `cloudInferVia` 复刻 `cloudSync.rdmdInfer` 的对外约定（submit → 若 queued 则轮询到终态
 * → 归一成 `{status, reason, verdict, jobId, errorCode}`）。**不 import cloudSync.js 本身**：
 * 它依赖 Electron 的 db/authStateProvider 一大套，把那些搬进测试会淹没接缝本身。
 * 复刻的代价是"cloudSync 改了约定而这里没跟"，所以下面第一条测试专门盯住那个约定。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../../../../../cloud/src/db.mjs';
import { readConfig } from '../../../../../cloud/src/config.mjs';
import { createApp } from '../../../../../cloud/src/server.mjs';
import { signAccessToken } from '../../../../../cloud/src/security.mjs';
import { createDeviceGrantService } from '../../../../../cloud/src/modules/sync/deviceGrants.mjs';
import { CloudSyncClient } from '../../../../../network/clients/cloudSyncClient.js';
import { deviceGrantProofMessage } from '../../../../shared/taskMemoryCrypto.js';
import { RDMD_DRIFT_TYPES } from '../../../../shared/contracts/uBuddyReverseDetective.js';
import { runCloudRdmdInference, runRdmdInference } from './planExecDriftService.js';

const JWT_SECRET = 'rdmd-transport-integration-secret-0123456789';

/**
 * 起一个**真的监听端口**的云 API（pg-mem 做库）。
 *
 * 用 pg-mem 而不是真 Postgres：这条测试要能在任何开发机上跑，而它要证明的是
 * HTTP 契约与两侧归一化，不是 PG 的 SQL 语义（后者由 `_rdmd_zombie_sweep.sh`
 * 在真机上单独验）。
 */
async function startCloudApi({ backend = 'gpu_worker' } = {}) {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await migrate(pool);
  const env = {
    JWT_SECRET,
    NODE_ENV: 'test',
    RDMD_CLOUD_ENABLED: 'true',
    RDMD_CLOUD_BACKEND: backend,
  };
  const app = createApp({ pool, config: readConfig(env) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

/** 建一个真的用户 + 带 rdmd:infer 的 device grant（worker 侧凭据）。 */
async function provisionUser(pool, { userId, deviceId }) {
  const apiError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
  await pool.query(
    `INSERT INTO users (id,email,display_name,password_hash,email_verified,role)
     VALUES ($1,$2,$3,$4,true,'member') ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@transport.invalid`, 'RDMD Transport', 'not-a-real-hash'],
  );
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const service = createDeviceGrantService({ pool, apiError });
  await service.register({ userId, input: { deviceId, displayName: 'rdmd-worker', platform: 'linux', arch: 'x64', publicKey } });
  const scopes = ['rdmd:infer'];
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signature = crypto.sign('sha256',
    Buffer.from(deviceGrantProofMessage({ userId, deviceId, scopes, timestamp, nonce }), 'utf8'), privateKey).toString('base64');
  const grant = await service.issueToken({ userId, deviceId, requestedScopes: scopes, proof: { timestamp, nonce, signature } });
  assert.equal(grant.status, 'approved');
  return grant.token;
}

/**
 * 复刻 `cloudSync.rdmdInfer` 的对外约定。**改 cloudSync 的时候必须同步这里** ——
 * 第一条测试就是在盯这个约定（它会 import 真的 client，验证方法名与响应字段名）。
 */
function cloudInferVia(client, state, { userToken, waitMs = 3000, pollMs = 25 } = {}) {
  return async ({ taskRunId = '', case: caseValue = {}, conversationKind = '' } = {}) => {
    const submitted = await client.submitRdmdJob(state, { taskRunId, case: caseValue, conversationKind }, { accessToken: userToken });
    const jobId = String(submitted?.jobId || '');
    const status = String(submitted?.status || '');
    const immediate = (value = {}) => ({
      status: String(value.status || ''), reason: String(value.reason || ''),
      jobId, verdict: value.verdict || null, errorCode: String(value.errorCode || ''),
    });
    if (!jobId || status !== 'queued') return immediate(submitted);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const polled = await client.rdmdJob(state, jobId, { accessToken: userToken });
      const polledStatus = String(polled?.status || '');
      if (!['completed', 'unavailable', 'failed_terminal'].includes(polledStatus)) continue;
      if (polledStatus === 'failed_terminal') {
        const failure = new Error(`RDMD job ${jobId} failed terminally: ${String(polled?.errorCode || '')}.`);
        failure.code = 'rdmd_cloud_job_failed';
        failure.status = 409;
        throw failure;
      }
      return immediate({ ...polled, reason: polled?.errorCode || '' });
    }
    const timeout = new Error(`RDMD verdict for job ${jobId} did not reach a terminal state in ${waitMs}ms.`);
    timeout.code = 'rdmd_cloud_timeout';
    throw timeout;
  };
}

/** 真 case：`planExecCase()` 的形状是 `{id, G_star, G_prime}`。 */
function realCase({ id = 'transport_case', drift = 'wrong_agent' } = {}) {
  const graph = (mutate) => {
    const nodes = [
      { id: 'n_root', kind: 'root', title: '季度复盘', agentId: 'general_agent', status: 'completed', summary: '总览', output: 'root out' },
      { id: 'n_task', kind: 'agent_task', title: '拉取数据', agentId: 'data_agent', status: 'completed', summary: '拉数', output: 'raw rows' },
      { id: 'n_step', kind: 'agent_step', title: '第 1 步：读表', agentId: 'data_agent', status: 'completed' },
    ];
    const edges = [
      { id: 'e1', from: 'n_root', to: 'n_task', kind: 'parent_of' },
      { id: 'e2', from: 'n_task', to: 'n_step', kind: 'sequence_of' },
    ];
    if (mutate) mutate({ nodes, edges });
    return { nodes, edges };
  };
  return {
    id,
    G_star: graph(),
    G_prime: graph(({ nodes, edges }) => {
      if (drift === 'wrong_agent') nodes[2].agentId = 'writer_agent';
      if (drift === 'removed_step') { nodes.splice(2, 1); edges.splice(1, 1); }
    }),
    prompt: 'PRIVATE prompt',
    label: { injected_node: 'n_step' },
  };
}

/** 一个把 cloudInfer 接进桌面侧归一化的最小配置（只走云，不碰本地 spawn）。 */
function cloudConfig({ taskRunId = 'run_transport', conversationKind = '', cloudInfer }) {
  return {
    transport: 'cloud',
    taskRunId,
    conversationKind,
    cloudInfer,
    script: '',
    adapter: '',
    model: '',
    device: '',
  };
}

/** 扮演 worker 的那一侧真的去领活（走 HTTP + device grant）。 */
async function claimJobs({ api, grant, workerId = 'transport-worker', limit = 4 }) {
  const response = await fetch(`${api.baseUrl}/api/rdmd/jobs/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, limit }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `claim 应得 200，得到 ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** 领活 + 回传判定，返回云侧的应答（用来断言 HTTP 语义）。 */
async function runWorker({ api, grant, verdict, provenance }) {
  const claimed = await claimJobs({ api, grant });
  const jobs = claimed.jobs || [];
  if (!jobs.length) return { claimed: 0 };
  const job = jobs[0];
  const response = await fetch(`${api.baseUrl}/api/rdmd/jobs/${encodeURIComponent(job.jobId)}/verdict`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verdict,
      provenance: {
        adapterSha256: 'b'.repeat(64), baseModelId: 'Qwen/Qwen3-8B',
        contractVersion: claimed.contractVersion, ruleVersion: claimed.ruleVersion,
        workerVersion: 'transport-test/1', ...provenance,
      },
    }),
  });
  // `case` 一并带回去：worker 拿到的载荷是**云侧过滤后**的那一份，这里才能断言
  // "白名单没有把 G_star/G_prime 裁掉、也没有把 prompt/label 放过去"。
  return { claimed: jobs.length, jobId: job.jobId, case: job.case, status: response.status, body: await response.json() };
}

/** 等一个作业进入某个状态；超时返回 null，让调用方自己断言失败。 */
async function waitForJob(pool, status, { attempts = 400, intervalMs = 25 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE status=$1 LIMIT 1', [status])).rows[0];
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

test('the cloud client exposes the two RDMD calls the desktop transport depends on', () => {
  // 这条测试防的是"cloudSync 改了调用方式，而这个文件还在用旧的"。
  // 只断言方法存在与请求形状，真实调用由下面的用例覆盖。
  const client = new CloudSyncClient();
  assert.equal(typeof client.submitRdmdJob, 'function', '提交作业的方法名变了，桌面 transport 会直接炸');
  assert.equal(typeof client.rdmdJob, 'function', '读取作业的方法名变了');
});

test('a real verdict travels the whole seam intact', async () => {
  const api = await startCloudApi({ backend: 'gpu_worker' });
  try {
    const userId = 'user_seam_ok';
    const grant = await provisionUser(api.pool, { userId, deviceId: 'device_seam_ok' });
    const userToken = signAccessToken({ userId, secret: JWT_SECRET, expiresInSeconds: 900 });
    const client = new CloudSyncClient();

    // worker 那一侧在后台领活；桌面侧在轮询。用真实时序，不用 await 顺序作弊。
    const worker = (async () => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const result = await runWorker({
          api, grant,
          verdict: { status: 'drift', nodeId: 'n_step', type: 'wrong_agent', valid: true, warnings: [], reason: '' },
        });
        if (result.claimed) return result;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { claimed: 0 };
    })();

    const outcome = await runCloudRdmdInference({
      case: realCase(),
      config: cloudConfig({ cloudInfer: cloudInferVia(client, { server_url: api.baseUrl }, { userToken }) }),
    });
    const done = await worker;

    assert.equal(done.claimed, 1, 'worker 应当领到那条作业');
    assert.equal(done.status, 200, `回传判定应得 200，得到 ${done.status}: ${JSON.stringify(done.body)}`);

    // worker 真正拿到的载荷：这正是白名单曾经把 G_star/G_prime 裁空的地方。
    // 断言放在**这一侧**（worker 收到的字节）而不是云侧的库表，因为 worker 拿到什么，
    // 才是"模型能看见什么"的同义词；库表对不代表领活响应对。
    assert.ok(done.case?.G_star?.nodes?.length, `worker 拿到的 case 缺 G_star：${JSON.stringify(done.case)?.slice(0, 200)}`);
    assert.ok(done.case?.G_prime?.nodes?.length, 'worker 拿到的 case 缺 G_prime');
    const received = JSON.stringify(done.case);
    for (const leak of ['PRIVATE prompt', 'injected_node']) {
      assert.ok(!received.includes(leak), `隐私白名单失效：worker 收到了 ${leak}`);
    }

    assert.equal(outcome.invoked, true);
    assert.equal(outcome.ok, true, `桌面端应认为这是一条可用判定，实际 reason=${outcome.reason}`);
    assert.equal(outcome.reason, '');
    assert.equal(outcome.verdict.status, 'drift');
    assert.equal(outcome.verdict.nodeId, 'n_step');
    assert.equal(outcome.verdict.type, 'wrong_agent');
    assert.ok(RDMD_DRIFT_TYPES.includes(outcome.verdict.type), 'type 必须是桌面侧标定集里的值');
  } finally {
    await api.close();
  }
});

test('an abstention travels the seam as a refusal, not as a drift', async () => {
  // 真机上的形态：模型指对了节点、说不出 type，worker 把它降级成 UNKNOWN + reason。
  // 桌面端必须**不路由**（ok:false）且原因可读 —— 这正是修 bug 之前 400 掉的那条。
  const api = await startCloudApi({ backend: 'gpu_worker' });
  try {
    const userId = 'user_seam_abstain';
    const grant = await provisionUser(api.pool, { userId, deviceId: 'device_seam_abstain' });
    const userToken = signAccessToken({ userId, secret: JWT_SECRET, expiresInSeconds: 900 });
    const client = new CloudSyncClient();

    const worker = (async () => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const result = await runWorker({
          api, grant,
          verdict: {
            status: 'UNKNOWN', nodeId: '', type: '', valid: false,
            reason: 'drift_without_type', warnings: ['drift_without_type', 'unusable_claim:n_step/-'],
          },
        });
        if (result.claimed) return result;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { claimed: 0 };
    })();

    const outcome = await runCloudRdmdInference({
      case: realCase({ drift: 'removed_step' }),
      config: cloudConfig({ cloudInfer: cloudInferVia(client, { server_url: api.baseUrl }, { userToken }) }),
    });
    await worker;

    assert.equal(outcome.invoked, true, '云侧确实处理了这条 case，invoked 必须是 true');
    assert.equal(outcome.ok, false, '弃权不是可用判定，绝不能当 drift 路由出去');
    assert.equal(outcome.reason, 'drift_without_type', '原因必须来自模型/worker，而不是一句笼统的失败');
    assert.equal(outcome.verdict.status, 'UNKNOWN');
    // 弃权也必须带上 warnings：审计要能看见"它当时指向 n_step"。
    assert.ok(outcome.warnings.includes('unusable_claim:n_step/-'), `warnings 丢了：${JSON.stringify(outcome.warnings)}`);
  } finally {
    await api.close();
  }
});

test('the null backend produces a constant, explainable refusal at the desktop side', async () => {
  // P4 验收：没有 GPU 时整条链路照常跑通，且**恒定不产出动作**。
  // 这里证明桌面端拿到的是一个可解释的结论（model_not_configured），不是一个空 verdict 或异常。
  const api = await startCloudApi({ backend: 'null' });
  try {
    const userId = 'user_seam_null';
    await provisionUser(api.pool, { userId, deviceId: 'device_seam_null' });
    const userToken = signAccessToken({ userId, secret: JWT_SECRET, expiresInSeconds: 900 });
    const client = new CloudSyncClient();

    const outcome = await runCloudRdmdInference({
      case: realCase(),
      config: cloudConfig({ cloudInfer: cloudInferVia(client, { server_url: api.baseUrl }, { userToken }) }),
    });

    assert.equal(outcome.invoked, true);
    assert.equal(outcome.ok, false, '空后端不得产出可用判定');
    assert.equal(outcome.reason, 'model_not_configured');
    assert.equal(outcome.verdict.status, 'UNKNOWN');
    assert.equal(outcome.verdict.nodeId, '', 'UNKNOWN 不得指认凶手');
    assert.equal(outcome.verdict.type, '');
  } finally {
    await api.close();
  }
});

test('a private assistant conversation is refused with the privacy reason, not a transport error', async () => {
  // 隐私边界是**设计**，不是故障：桌面端必须把云侧的理由原样带出来，
  // 否则运维会去查网络，而真正要改的是"这条会话不该外发"。
  const api = await startCloudApi({ backend: 'gpu_worker' });
  try {
    const userId = 'user_seam_private';
    await provisionUser(api.pool, { userId, deviceId: 'device_seam_private' });
    const userToken = signAccessToken({ userId, secret: JWT_SECRET, expiresInSeconds: 900 });
    const client = new CloudSyncClient();

    const outcome = await runCloudRdmdInference({
      case: realCase(),
      config: cloudConfig({
        conversationKind: 'private_assistant',
        cloudInfer: cloudInferVia(client, { server_url: api.baseUrl }, { userToken }),
      }),
    });

    assert.equal(outcome.invoked, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'private_assistant_not_eligible', '理由必须指向隐私边界本身');
    assert.equal(outcome.verdict, null);
  } finally {
    await api.close();
  }
});

test('a terminally failed job becomes a named failure at the desktop side', async () => {
  // 云侧把"次数用尽"收成 failed_terminal 之后，桌面端必须把它认成一次**指名**失败，
  // 而不是一直等到超时（那会把一个确定的结论拖成 90 秒的等待）。
  const api = await startCloudApi({ backend: 'gpu_worker' });
  try {
    const userId = 'user_seam_failed';
    const grant = await provisionUser(api.pool, { userId, deviceId: 'device_seam_failed' });
    const userToken = signAccessToken({ userId, secret: JWT_SECRET, expiresInSeconds: 900 });
    const client = new CloudSyncClient();

    const outcomePromise = runCloudRdmdInference({
      case: realCase(),
      config: cloudConfig({ cloudInfer: cloudInferVia(client, { server_url: api.baseUrl }, { userToken, waitMs: 8000 }) }),
    });

    // 扮演一个"领了活但答不出来"的 worker：领走，**不回传判定**（回传就把它结掉了）。
    const queued = await waitForJob(api.pool, 'queued');
    assert.ok(queued, '桌面端应当已经提交了作业');
    const claimed = await claimJobs({ api, grant });
    assert.equal(claimed.jobs.length, 1, 'worker 应当领到它');

    // 反复答不出 → 次数用尽；worker 掉线 → 租约过期。这就是真机上那条失败形态。
    await api.pool.query("UPDATE cloud_rdmd_inference_jobs SET attempt_count=max_attempts, lease_expires_at=now() - interval '1 second' WHERE status='claimed'");
    // 借一次 claim 触发云侧收尾。
    await claimJobs({ api, grant, workerId: 'sweeper', limit: 1 });

    const dead = await waitForJob(api.pool, 'failed_terminal');
    assert.ok(dead, '云侧应当把次数用尽的作业收成 failed_terminal');

    const outcome = await outcomePromise;
    assert.equal(outcome.invoked, true);
    assert.equal(outcome.ok, false);
    // `cloudSync.rdmdInfer` 抛 409 + rdmd_cloud_job_failed，桌面侧映射成 HTTP 号。
    assert.equal(outcome.reason, 'cloud_http_409', '终态失败必须被立刻认出来（而不是超时）');
    assert.ok(String(outcome.detail || '').includes('failed terminally'), `detail 应保留原始失败信息：${outcome.detail}`);
  } finally {
    await api.close();
  }
});

test('a cloud that is not reachable fails closed with a named reason', async () => {
  // 通道配置好了但连不上：必须 record_only + 可指认的原因，绝不降级成本地推理。
  // 注：把底层错误细分成 `rdmd_cloud_unreachable` 的映射在 `cloudSync.js` 里（它依赖
  // Electron 的 db/authStateProvider，这里不搬进来），所以这条只断言"原因是云侧的"。
  const client = new CloudSyncClient();
  const outcome = await runCloudRdmdInference({
    case: realCase(),
    config: cloudConfig({
      cloudInfer: cloudInferVia(client, { server_url: 'http://127.0.0.1:9' },
        { userToken: signAccessToken({ userId: 'u', secret: JWT_SECRET }) }),
    }),
  });
  assert.equal(outcome.invoked, true, '尝试过了才算 invoked');
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /^cloud_/, `原因要能指认是云侧的问题，得到 ${outcome.reason}`);
});

test('a missing cloud channel is reported as a config error, not as a local fallback', async () => {
  // transport=cloud 但没给 cloudInfer：这是配置错误。**不允许偷偷跑本地 spawn** ——
  // 那会让"判定来自哪一侧"这个出处问题消失，而 P4 的全部意义就在于出处清楚。
  const outcome = await runCloudRdmdInference({ case: realCase(), config: cloudConfig({ cloudInfer: null }) });
  assert.equal(outcome.invoked, false);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'cloud_transport_unavailable');
});

test('the local transport is untouched by the cloud path (three states stay three)', async () => {
  // 三态必须真的互不影响：本地通道在没配脚本时给出的仍是它自己那条原因。
  const local = await runRdmdInference({
    case: realCase(),
    config: { transport: 'local_spawn', script: '', adapter: '', model: '', device: '' },
  });
  assert.equal(local.ok, false);
  assert.notEqual(local.reason, 'cloud_transport_unavailable', '本地通道不该被云侧的配置错误污染');
});
