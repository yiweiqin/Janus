/**
 * P4 验收 harness：在盒子上对着**真实云 API + 真实 Postgres**跑 RDMD 作业全链路。
 *
 * 为什么需要它：`cloud/test/rdmd-inference-jobs.test.mjs` 已经把 service 层的语义测透了，
 * 但那 23 条全是 **in-process + pg-mem**。下面这些东西在它那里**从未被验证过**：
 *
 *   - HTTP 层：路由、`auth` 中间件、401/409 的真实状态码
 *   - 真实 Postgres：`FOR UPDATE SKIP LOCKED` 的抢占、租约互斥、部分唯一索引的 23505 兜底
 *     （pg-mem 连 `ON CONFLICT ... WHERE` 都解析不了，见 upsertOpenJob 的注释）
 *   - device grant 的真实校验：RSA 公钥指纹、proof 签名、nonce 重放
 *   - 隐私白名单在**真实请求体**上的效果（测试夹具曾经是错的，见 caseValue 的注释）
 *
 * 所以这个脚本刻意**不做任何 mock**：真的连库、真的发 HTTP、真的用 RSA 私钥签 proof。
 * 用 `--stage` 分步，便于和 Python worker 串起来：
 *
 *     node scripts/rdmd_cloud_e2e.mjs --stage submit --backend gpu_worker
 *     /root/autodl-tmp/rdmd-env/bin/python /root/autodl-tmp/Janus/scripts/rdmd_gpu_worker.py --once
 *     node scripts/rdmd_cloud_e2e.mjs --stage verify
 *
 * 状态（userId / jobId / grant / token）落在 --state 指定的 JSON 里，三步之间不用手工传参。
 *
 * 关于夹具的诚实说明：user 行与 access token 是**造出来**的，但用的是**真实签名函数**
 * （`signAccessToken`）与**真实 device grant 服务**（`createDeviceGrantService`），
 * 只绕过了邮箱验证码登录 —— 登录链路与 P4 无关且已有 `cloud:test` 覆盖。
 * 这一点必须写明，否则"全链路"会被误读成"包含注册登录"。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createPgPool } from '../cloud/src/db.mjs';
import { signAccessToken } from '../cloud/src/security.mjs';
import { createDeviceGrantService, DEFAULT_RDMD_WORKER_USER } from '../cloud/src/modules/sync/deviceGrants.mjs';
import { RDMD_RULE_VERSION, RDMD_DRIFT_TYPES } from '../cloud/src/modules/rdmd/contract.mjs';
import { PLAN_EXEC_CONTRACT_VERSION } from '../src/shared/contracts/uBuddyPlanExec.js';
import { deviceGrantProofMessage } from '../src/shared/taskMemoryCrypto.js';

const API = process.env.RDMD_API || 'http://127.0.0.1:8787';

/**
 * 群任务在**桌面端实际发出的** conversationKind。
 *
 * `planExecDriftService.js` 的推导是二值的：
 *     `departmentId === 'private_assistant' ? 'private_assistant' : ''`
 * 也就是说非私有会话一律发**空串**，而不是 `'collaboration'`。
 *
 * 这一点必须照着真实值写，否则测的是一条不存在的链路：云侧对空串是放行的
 * （`if (conversationKind && conversationKind !== 'collaboration')` 这行只在非空时才拦），
 * 而 `'group_task'` 这类自造值会被云侧判成 `conversation_kind_unknown` 直接拒掉。
 * 这个坑当场踩到过：第一版 harness 写 `'group_task'`，如果夹具不照着调用方写，
 * 就会得出"云侧把正常群任务拒了"的错误结论。
 */
const GROUP_TASK_KIND = '';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/**
 * 真实形状的 case：`planExecCase()` 产出 `{id, G_star, G_prime}`。
 *
 * 这里塞进 prompt/rollout/label 三个**不该上云**的字段，是为了让"白名单真的生效"
 * 可被观测：它们在库里必须消失。夹具要长得像**调用方**发的东西，而不是像实现的内部结构
 * —— 这正是 `rdmd-inference-jobs.test.mjs` 里那次白名单 bug 的教训。
 *
 * `drift` 是**漂移形状**，不是布尔值。两种形状的意义完全不同，别混：
 *   'wrong_agent'   单字段变异（只改 n_step 的 agentId）。**无歧义**，模型该答出来。
 *   'removed_step'  删掉 n_step **和**它的 sequence_of 边。这是"结构缺失"，
 *                   在标签体系里同时像 local_replan（增删 step）与 missing_dependency（砍边），
 *                   所以模型答得出节点、答不出 type 是**合理的** —— 真机 E2E 上正是这条
 *                   让云侧 400 了一次。保留它是为了把这个歧义钉在明面上，
 *                   由 `--expect abstain` 断言"它应当弃权且作业仍然终态"，而不是当成失败。
 */
function realCase({ id = 'group_e2e', drift = 'none' } = {}) {
  const shape = drift === true ? 'removed_step' : drift;
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
      if (shape === 'removed_step') {
        nodes.splice(2, 1);
        edges.splice(1, 1);
      } else if (shape === 'wrong_agent') {
        // 只动这一个字段：结构、标题、status 全不变。
        nodes[2].agentId = 'writer_agent';
      }
    }),
    // 白名单之外，必须被裁掉：
    prompt: 'PRIVATE prompt that must never leave the device',
    rollout: 'raw rollout blob',
    label: { injected_node: 'n_step', status: 'drift' },
  };
}

/** 注入的漂移形状 → 期望模型指认的节点与类型（用于把"答对了没有"说清楚）。 */
const DRIFT_GOLD = {
  wrong_agent: { nodeId: 'n_step', type: 'wrong_agent' },
  removed_step: { nodeId: 'n_step', type: '' }, // type 不可判定，见 realCase 的注释
};

export async function call(method, pathname, { body = null, token = '', grant = '' } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (grant) headers.Authorization = `Bearer ${grant}`;
  else if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

export const post = (pathname, body, options) => call('POST', pathname, { ...options, body });
export const get = (pathname, options) => call('GET', pathname, options);

const readState = (statePath) => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {});
const writeState = (statePath, state) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

/**
 * 夹具：user 行 + 已批准设备 + 带 `rdmd:infer` 的 device grant。
 *
 * 用**真 RSA 密钥 + 真签名 proof**，而不是 `allowLegacyNoKey` 抄近路：
 * 后者会让 `verifyDeviceProof` 的指纹比对、时间窗、nonce 入表三条分支全都不执行，
 * device grant 这层安全就等于没测。
 *
 * ## 为什么这个函数是 `export` 的
 *
 * 模拟任务群（`experiments/sim_task_group/submit.mjs`）要发**同样形状**的请求，
 * 它需要的就是这一份凭据。计划里写的是"直接抄 provision()"，但抄一份意味着两条
 * 凭据策略会各自演化 —— 而这里面藏着 RSA 指纹、proof 时间窗、nonce、服务身份
 * （`rdmd:infer` 只签给在册服务身份）四件容易抄漏的事。少抄一件，模拟那一侧
 * 会在 403 上花掉一下午，而错的结果看起来像"云侧不认我们的 worker"。
 * 所以这里导出，让它只有一份。
 */
export async function provision(pool, { userId, deviceId }) {
  const apiError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

  // worker 凭据属于**服务身份**，不属于 `userId`（任务的属主）。这是生产里的真实形态：
  // 一个 worker 池替所有用户领活与回传判定，所以 `rdmd:infer` 只签给配置在册的服务身份
  // （`deviceGrants.mjs#SERVICE_ONLY_SCOPES`，默认与 `_rdmd_worker_provision.mjs` 同源）。
  // 早先这里图省事把 grant 签给 `userId` —— 那既不是生产形态，收口之后也会被云侧 403 拒掉。
  const workerUserId = DEFAULT_RDMD_WORKER_USER;
  for (const [id, label] of [[userId, 'RDMD E2E'], [workerUserId, 'RDMD Inference Worker']]) {
    await pool.query(
      `INSERT INTO users (id,email,display_name,password_hash,email_verified,role)
       VALUES ($1,$2,$3,$4,true,'member')
       ON CONFLICT (id) DO UPDATE SET email=excluded.email, updated_at=now()`,
      [id, `${id}@e2e.invalid`, label, 'not-a-real-hash'],
    );
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const service = createDeviceGrantService({ pool, apiError });
  await service.register({
    userId: workerUserId,
    input: { deviceId, displayName: 'rdmd-gpu-worker', platform: 'linux', arch: 'x64', publicKey },
  });

  const scopes = ['rdmd:infer'];
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signature = crypto.sign(
    'sha256',
    Buffer.from(deviceGrantProofMessage({ userId: workerUserId, deviceId, scopes, timestamp, nonce }), 'utf8'),
    privateKey,
  ).toString('base64');

  const grant = await service.issueToken({
    userId: workerUserId, deviceId, requestedScopes: scopes, proof: { timestamp, nonce, signature },
  });
  assert.equal(grant.status, 'approved', 'device 未被批准');
  assert.ok(grant.token.startsWith('dgr_'), 'device grant token 形状不对');
  assert.ok(grant.scopes.includes('rdmd:infer'), 'scope 没拿到 rdmd:infer');
  return grant.token;
}

async function stageSubmit(pool, { userId, deviceId, taskRunId, statePath, evidence }) {
  assert.equal((await get('/healthz')).status, 200, '云 API 没起来');
  const grant = await provision(pool, { userId, deviceId });
  const token = signAccessToken({ userId, secret: process.env.JWT_SECRET, expiresInSeconds: 900 });

  // ---- 闸门 1：私有会话必须被拒。能力位已开，所以拒的理由只能是隐私，不能是"没开" ----
  const privateSubmit = await post('/api/rdmd/jobs', {
    taskRunId, case: realCase(), conversationKind: 'private_assistant',
  }, { token });
  assert.equal(privateSubmit.status, 200, `私有会话应得 200（是正常结论不是错误），得到 ${privateSubmit.status}`);
  assert.equal(privateSubmit.body.status, 'not_eligible', `私有会话必须 not_eligible，得到 ${privateSubmit.body.status}`);
  assert.match(String(privateSubmit.body.reason), /private/i, `拒绝理由应指向隐私，得到 ${privateSubmit.body.reason}`);
  evidence.privateAssistant = { status: privateSubmit.body.status, reason: privateSubmit.body.reason };
  console.log(`[ok] private_assistant -> ${privateSubmit.body.status} (${privateSubmit.body.reason})`);

  // ---- 闸门 2：不认识的会话类型也必须**默认不外发**（不是默认放行）----
  const unknownKind = await post('/api/rdmd/jobs', {
    taskRunId: `${taskRunId}_unknown`, case: realCase(), conversationKind: 'group_task',
  }, { token });
  assert.equal(unknownKind.body.status, 'not_eligible', '未知会话类型必须默认不外发');
  assert.match(String(unknownKind.body.reason), /unknown/, `未知类型的理由应能指认，得到 ${unknownKind.body.reason}`);
  evidence.unknownKind = { status: unknownKind.body.status, reason: unknownKind.body.reason };
  console.log(`[ok] 未知会话类型 -> ${unknownKind.body.status} (${unknownKind.body.reason})`);

  // ---- 正常提交 ----
  // 漂移形状由 `--case` 决定（默认单字段变异：它无歧义，是"链路通不通"的干净试金石）。
  const caseShape = arg('case', 'wrong_agent');
  assert.ok(DRIFT_GOLD[caseShape], `--case 必须是 ${Object.keys(DRIFT_GOLD).join(' / ')} 之一，得到 ${caseShape}`);
  const submitted = await post('/api/rdmd/jobs', {
    taskRunId, case: realCase({ id: `group_e2e_${caseShape}`, drift: caseShape }), conversationKind: GROUP_TASK_KIND,
  }, { token });
  assert.equal(submitted.status, 201, `提交应得 201，得到 ${submitted.status}: ${JSON.stringify(submitted.body)}`);
  evidence.submit = { status: submitted.body.status, reason: submitted.body.reason, jobId: submitted.body.jobId, caseShape, gold: DRIFT_GOLD[caseShape] };
  console.log(`[ok] submit -> ${submitted.body.status} jobId=${submitted.body.jobId} case=${caseShape} gold=${JSON.stringify(DRIFT_GOLD[caseShape])}`);

  // ---- 白名单：库里必须找不到 prompt/rollout/label ----
  const row = (await pool.query(
    'SELECT case_json FROM cloud_rdmd_inference_jobs WHERE id=$1', [submitted.body.jobId],
  )).rows[0];
  const persisted = typeof row.case_json === 'string' ? JSON.parse(row.case_json) : row.case_json;
  const serialized = JSON.stringify(persisted);
  for (const leak of ['PRIVATE prompt', 'raw rollout blob', 'injected_node']) {
    assert.ok(!serialized.includes(leak), `隐私白名单失效：落库载荷里出现了 ${leak}`);
  }
  assert.ok(persisted.G_star && persisted.G_prime, '落库载荷缺 G_star/G_prime（白名单裁过头了）');
  evidence.persistedCaseKeys = Object.keys(persisted).sort();
  console.log(`[ok] 白名单：落库字段 ${JSON.stringify(Object.keys(persisted).sort())}`);

  writeState(statePath, { userId, deviceId, jobId: submitted.body.jobId, grant, token, taskRunId, caseShape });
  console.log(`[state] 写入 ${statePath}`);
}

async function stageClaim(statePath, { evidence }) {
  const { grant, token } = readState(statePath);
  assert.ok(grant, '缺 device grant：先跑 --stage submit');

  // 领两轮（每轮最多 4 条），断言**同一个作业不会出现在两轮里**。
  //
  // 这里刻意不去断言"第一轮领到的就是我刚提交的那个"：云侧的 claimOne 是
  // `ORDER BY available_at, created_at LIMIT 1`，也就是**永远先领最老的**。
  // 队列里有别的作业时，领到别人的作业是正确行为，不是 bug —— 第一版断言就是这么
  // 误报的。真正要守的不变式是"一个作业不会被两个 worker 同时拿走"，
  // 也就是两轮 id 集合不相交。
  const roundA = await post('/api/rdmd/jobs/claim', { workerId: 'e2e-worker-A', limit: 4 }, { grant });
  assert.equal(roundA.status, 200, `claim 应得 200，得到 ${roundA.status}: ${JSON.stringify(roundA.body)}`);
  assert.equal(roundA.body.contractVersion, PLAN_EXEC_CONTRACT_VERSION, '云侧下发的契约版本不对');
  assert.equal(roundA.body.ruleVersion, RDMD_RULE_VERSION, '云侧下发的规则版本不对');
  const idsA = (roundA.body.jobs || []).map((job) => job.jobId);
  const roundB = await post('/api/rdmd/jobs/claim', { workerId: 'e2e-worker-B', limit: 4 }, { grant });
  const idsB = (roundB.body.jobs || []).map((job) => job.jobId);
  const overlap = idsA.filter((id) => idsB.includes(id));
  assert.deepEqual(overlap, [], `租约互斥失效：作业同时被两个 worker 领走 ${JSON.stringify(overlap)}`);
  evidence.claim = {
    workerId: roundA.body.workerId, roundA: idsA.length, roundB: idsB.length, overlap,
    contractVersion: roundA.body.contractVersion, ruleVersion: roundA.body.ruleVersion,
  };
  console.log(`[ok] claim 两轮 A=${idsA.length} B=${idsB.length} 交集=0 → 租约互斥有效 (contract=${roundA.body.contractVersion}, rule=${roundA.body.ruleVersion})`);

  if (!idsA.length) {
    console.log('[skip] 队列里没有可领的作业，跳过出处校验相关断言');
    evidence.claimProbeSkipped = 'queue_empty';
    return;
  }

  // 接下来的两条用**第一轮真领到并持有租约的那个作业**，不是 state 里的 jobId ——
  // 因为租约在我们手上，只有我们能回传判定，这才测得到"拒绝"这一侧。
  const heldJobId = idsA[0];

  // ---- 出处不全的判定必须被拒（"不可审计的判定等于没有判定"）----
  const bad = await post(`/api/rdmd/jobs/${heldJobId}/verdict`, {
    workerId: 'e2e-worker-A',
    verdict: { status: 'drift', nodeId: 'n_step', type: 'missing_dependency', valid: true, warnings: [], reason: '' },
  }, { grant });
  assert.equal(bad.status, 409, `缺出处的判定应被拒 409，得到 ${bad.status}: ${JSON.stringify(bad.body)}`);
  evidence.provenanceRejected = { status: bad.status, code: bad.body?.error || bad.body?.code || '' };
  console.log(`[ok] 缺出处的判定被拒 -> ${bad.status}`);

  // ---- 形状非法的 status 必须被拒 400（不能把未知状态当合法判定收下）----
  const bogus = await post(`/api/rdmd/jobs/${heldJobId}/verdict`, {
    workerId: 'e2e-worker-A',
    verdict: { status: 'definitely_not_a_status', nodeId: 'n_step', type: '', valid: true },
    provenance: { adapterSha256: 'a'.repeat(64), baseModelId: 'x', contractVersion: PLAN_EXEC_CONTRACT_VERSION, ruleVersion: RDMD_RULE_VERSION },
  }, { grant });
  assert.equal(bogus.status, 400, `非法 status 应得 400，得到 ${bogus.status}`);
  console.log('[ok] 非法 verdict.status -> 400');

  // ---- 判定只能由**持租约的那个 worker** 回传 ----
  //
  // 这一条是新加的，因为它补的是个真实的口子：在这之前，任何一个持 `rdmd:infer` 的 grant
  // 都能凭 job id 终结队列里**任何一条在飞作业**（包括别的用户的）—— 而 `owner_user_id`
  // 挡不住这一侧（worker 是跨用户的服务身份，见 097 迁移注释）。
  // `e2e-worker-B` 是一个真实存在的、持有合法 grant 的 worker，只是它没领这条活。
  const stolen = await post(`/api/rdmd/jobs/${heldJobId}/verdict`, {
    workerId: 'e2e-worker-B',
    verdict: { status: 'no_drift', valid: true, warnings: [], reason: '' },
    provenance: { adapterSha256: 'a'.repeat(64), baseModelId: 'x', contractVersion: PLAN_EXEC_CONTRACT_VERSION, ruleVersion: RDMD_RULE_VERSION },
  }, { grant });
  assert.equal(stolen.status, 409, `非持租约者的判定应被拒 409，得到 ${stolen.status}: ${JSON.stringify(stolen.body)}`);
  assert.equal(stolen.body?.error, 'rdmd_job_claimed_by_other_worker', `错误码应指出"租约不属于你"，得到 ${stolen.body?.error}`);
  evidence.leaseBoundVerdict = { workerId: 'e2e-worker-B', status: stolen.status, code: stolen.body?.error || '' };
  console.log(`[ok] 非持租约者的判定被拒 -> ${stolen.status} ${stolen.body?.error}`);

  // 上面三次拒绝都不该消耗作业：它必须仍被我们租着，所以第三轮 claim 拿不到它。
  //
  // 这里不能用「读自己的作业」来验证：worker 的 claim 是**跨用户**的（一个 worker 池服务
  // 所有用户），所以 idsA[0] 未必属于 state 里那个用户，用 owner 作用域的 read 会 404。
  // 换成对 worker 自己的 API 提问："这个作业现在还能被领走吗？"——不能，就是我们要的答案。
  const roundC = await post('/api/rdmd/jobs/claim', { workerId: 'e2e-worker-C', limit: 4 }, { grant });
  const idsC = (roundC.body.jobs || []).map((job) => job.jobId);
  assert.ok(!idsC.includes(heldJobId),
    `被拒的回传消耗了租约：作业 ${heldJobId} 在第三轮里又被领走了`);
  evidence.stillLeasedAfterRejections = { heldJobId, reClaimed: false };
  console.log('[ok] 三次被拒后该作业仍被租用（拒绝不消耗作业）');
}

async function stageVerify(pool, { backend, statePath, evidence }) {
  const state = readState(statePath);
  const { jobId, token } = state;
  assert.ok(jobId, '缺 jobId：先跑 --stage submit');
  const deadline = Date.now() + Number(arg('wait-ms', '600000'));
  let snapshot = null;
  while (Date.now() < deadline) {
    const read = await get(`/api/rdmd/jobs/${jobId}`, { token });
    assert.equal(read.status, 200, `read 应得 200，得到 ${read.status}`);
    snapshot = read.body;
    if (['completed', 'unavailable', 'failed_terminal'].includes(snapshot.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const provenance = (await pool.query(
    `SELECT status, adapter_sha256, base_model_id, contract_version, rule_version, worker_version, error_code
     FROM cloud_rdmd_inference_jobs WHERE id=$1`, [jobId],
  )).rows[0];
  evidence.job = snapshot;
  evidence.provenance = provenance;
  console.log(`[job] ${JSON.stringify(snapshot)}`);
  console.log(`[provenance] ${JSON.stringify(provenance)}`);
  // 出处先单独播报一次：这条断言失败时，人第一眼要看到的就是"实际跑了哪份权重"。
  console.log(`[provenance] adapter_sha256=${String(provenance.adapter_sha256).slice(0, 16)}… `
    + `base=${provenance.base_model_id || '(空)'}`);

  if (backend === 'null') {
    // P4 验收之一：空后端下链路照常跑通，恒定 record_only，且不伪造出处。
    assert.equal(snapshot.status, 'unavailable', `空后端期望 unavailable，得到 ${snapshot.status}`);
    assert.equal(snapshot.verdict?.reason, 'model_not_configured', `空后端 reason 应为 model_not_configured，得到 ${snapshot.verdict?.reason}`);
    assert.equal(provenance.adapter_sha256, '', '空后端不该有 adapter 出处（与迁移的 provenance 约束同义）');
    assert.equal(provenance.base_model_id, '', '空后端不该有 base model 出处');
    console.log('[ok] 空后端 -> unavailable / model_not_configured，且无 adapter 出处');
  } else {
    assert.equal(snapshot.status, 'completed', `期望 completed，得到 ${snapshot.status}（errorCode=${snapshot.errorCode}）`);
    assert.match(String(provenance.adapter_sha256), /^[0-9a-f]{64}$/, 'adapter_sha256 不是 64 位 hex');
    assert.ok(provenance.base_model_id, 'completed 却缺 base_model_id');
    assert.equal(provenance.contract_version, PLAN_EXEC_CONTRACT_VERSION);
    assert.equal(provenance.rule_version, RDMD_RULE_VERSION);
    assert.ok(provenance.worker_version, '缺 worker_version');

    // 「判的是哪份权重」必须能被机器核对，而不是靠人去日志里认 sha。
    // 这条断言存在的理由：常驻 worker 曾经钉在 qlora-v3 上，而那时没人看得出来 ——
    // 判定照样 completed、出处照样齐全、形状照样合法，**只有 sha 不一样**。
    const expectAdapter = arg('expect-adapter', '');
    if (expectAdapter) {
      assert.equal(provenance.adapter_sha256, expectAdapter,
        `判定的 adapter 不是期望的那份：期望 ${expectAdapter.slice(0, 16)}…，`
        + `实际 ${String(provenance.adapter_sha256).slice(0, 16)}…（跑错权重了，这不等于验收通过）`);
      console.log(`[ok] adapter 出处核对：${String(provenance.adapter_sha256).slice(0, 16)}… 与期望一致`);
    }
    const reason = String(snapshot.verdict?.reason || '');
    // P4 验收之二：真实 case 的判定 reason 不再是 input_contract_violation。
    assert.notEqual(reason, 'input_contract_violation',
      'P4 验收未达成：判定 reason 仍是 input_contract_violation（契约仍然对不上）');

    // 判定的形状不变量。`verdict.status` 是模型的**主张**，标定过的只有三种；
    // drift 必须同时给出 nodeId 与 type —— 云侧 normalizeVerdict 只认这一种 drift，
    // 少了任何一个都是 400（真机上撞到过：模型指对了节点却说不出 type）。
    const verdict = snapshot.verdict || {};
    const expect = arg('expect', 'drift');
    const gold = DRIFT_GOLD[state.caseShape] || {};
    assert.ok(['drift', 'no_drift', 'UNKNOWN'].includes(verdict.status),
      `verdict.status 不在标定集内：${verdict.status}（模型不该发明状态）`);
    if (verdict.status === 'drift') {
      assert.match(String(verdict.nodeId || ''), /\S/, 'drift 必须给出 nodeId');
      assert.match(String(verdict.type || ''), /\S/, 'drift 必须给出 type');
      assert.ok(RDMD_DRIFT_TYPES.includes(verdict.type), `drift.type 不在标定集内：${verdict.type}`);
    }

    if (expect === 'drift') {
      // 单字段变异的情形：答案是无歧义的，所以这里可以做"答对没有"的硬断言。
      assert.equal(verdict.status, 'drift',
        `case=${state.caseShape} 注入的漂移无歧义，期望 drift，得到 ${verdict.status}（reason=${reason}）`);
      assert.equal(verdict.nodeId, gold.nodeId,
        `指认节点应是变异点 ${gold.nodeId}，得到 ${verdict.nodeId || '(空)'}`);
      if (gold.type) {
        assert.equal(verdict.type, gold.type,
          `注入的是 ${gold.type}，模型答 ${verdict.type} —— 单字段变异下这个归类不该出错`);
      }
      console.log(`[ok] 真实判定：drift node=${verdict.nodeId} type=${verdict.type}（gold 全中，出处齐全）`);
    } else {
      // 弃权路径：模型答不出**也必须**以 completed 收尾，而不是 400 重试到僵尸。
      // 这正是真机上那条 `drift_without_type` 暴露的洞：worker 若原样回传，
      // 云侧 400 → 作业退回 claimed → 重试跑同一份权重必然再失败 → 用尽次数后无人再领。
      assert.equal(verdict.status, 'UNKNOWN', `--expect abstain 时期望 UNKNOWN，得到 ${verdict.status}`);
      assert.match(reason, /\S/, '弃权必须有 reason，否则线上分不清"它说不清"和"它没答"');
      assert.ok((verdict.warnings || []).some((item) => String(item).startsWith('unusable_claim:')),
        `弃权时应留下模型原本的指认：${JSON.stringify(verdict.warnings)}`);
      console.log(`[ok] 弃权也是终态：UNKNOWN reason=${reason} warnings=${JSON.stringify(verdict.warnings)}`);
    }
    assert.equal(provenance.error_code, '', `completed 却带 error_code=${provenance.error_code}`);
    console.log(`[ok] verdict=${verdict.status} reason=${reason || '(空)'} ← 不再是 input_contract_violation`);
  }

  // 越权与无效凭据必须被挡在 401，不是 200。
  assert.equal((await get(`/api/rdmd/jobs/${jobId}`, { token: 'not-a-real-token' })).status, 401, '无效 token 应得 401');
  assert.equal((await post(`/api/rdmd/jobs/${jobId}/verdict`, { verdict: { status: 'no_drift' } }, { grant: 'dgr_not_a_real_grant' })).status, 401,
    '无效 grant 应得 401');
  console.log('[ok] 无效 token / 无效 grant -> 401');
}

async function main() {
  const stage = arg('stage', 'all');
  const backend = arg('backend', process.env.RDMD_CLOUD_BACKEND || 'null');
  const statePath = arg('state', '/root/autodl-tmp/rdmd_runs/rdmd_e2e_state.json');
  const taskRunId = arg('task-run', `e2e_${Date.now()}`);
  const state = readState(statePath);
  const userId = state.userId || `user_e2e_${crypto.randomUUID().slice(0, 8)}`;
  const deviceId = state.deviceId || `device_e2e_${crypto.randomUUID().slice(0, 8)}`;

  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL 未设置：脚本必须在 remote.env 生效的环境里跑');
  assert.ok(process.env.JWT_SECRET, 'JWT_SECRET 未设置');

  const evidence = { stage, backend, api: API, taskRunId, userId };
  const pool = createPgPool(process.env.DATABASE_URL);
  try {
    if (stage === 'reset') {
      // 只清本 harness 自己的作业（task_run_id 前缀），绝不碰真实任务的作业。
      // 有存在的必要：claim 是**跨用户**的、且永远先领最老的，所以队列里只要还躺着一个
      // 上一轮的作业，"这一轮 worker 会处理我提交的那条"就不成立 —— 第一版 E2E 正是
      // 因此领到了别的作业。先清干净，才能把"提交 → 领活 → 判定"讲成一条确定的链。
      const { rowCount } = await pool.query("DELETE FROM cloud_rdmd_inference_jobs WHERE task_run_id LIKE 'e2e\\_%'");
      console.log(`[reset] 清掉 ${rowCount} 条历史 e2e 作业（task_run_id LIKE 'e2e_%'）`);
      const left = (await pool.query('SELECT count(*)::int AS n FROM cloud_rdmd_inference_jobs')).rows[0].n;
      console.log(`[reset] 队列剩余 ${left} 条`);
      evidence.cleared = rowCount;
    }
    if (stage === 'submit' || stage === 'all') {
      await stageSubmit(pool, { userId, deviceId, taskRunId, statePath, evidence });
    }
    if (stage === 'claim' || stage === 'all') {
      await stageClaim(statePath, { evidence });
    }
    if (stage === 'verify') {
      await stageVerify(pool, { backend, statePath, evidence });
    }
    console.log(`\nEVIDENCE ${JSON.stringify(evidence, null, 2)}`);
    console.log('E2E_OK');
  } finally {
    await pool.end();
  }
}

// 只有在**直接跑这个文件**时才进 main。
// 早先这里是裸的 `main().catch(...)`，于是任何 `import` 都会连带跑一遍全链路 E2E
// （会去连库、发 HTTP）。`experiments/sim_task_group/submit.mjs` 现在要 import `provision`，
// 所以这条守卫是必需的，不是整洁问题。
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`E2E_FAILED ${error?.stack || error}`);
    process.exit(1);
  });
}
