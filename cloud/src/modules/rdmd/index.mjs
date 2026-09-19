// RDMD 云侧推理作业：路由 + 判定回传。P4 的核心。
//
// ---------------------------------------------------------------------------
// 拓扑：为什么是"作业队列 + 出站拉取"，而不是"云 API 调 GPU 服务"
// ---------------------------------------------------------------------------
//
// 我们的 GPU 盒是 AutoDL 实例，没有自定义入站端口、也没有隧道（P0 实测：无 docker、
// 无对外服务端口）。反过来，云 API 是长期在线的服务。所以唯一的连通方向是
// **GPU 盒主动出站连云 API**：
//
//     GPU worker --POST /jobs/claim--> 云 API    （领活，租约式）
//     GPU worker --POST /jobs/:id/verdict--> 云 API（回传判定）
//
// 这不是权宜之计，而是与 `cloud_evolution_jobs` 天然同构的形态：抢占 + 租约 + 退避。
// 同一个模式已经在生产里跑着，包括 worker 掉线后租约到期被别人接走。
//
// ---------------------------------------------------------------------------
// 认证：两条通路，用途不同
// ---------------------------------------------------------------------------
//
//   auth（JWT）        —— 桌面端交互式提交 case。用户在场，走现成的会话认证。
//   device grant       —— GPU worker 领活/回传，scope `rdmd:infer`。无人值守，
//                         与 desktop 用同一套 device grant 机制（`routeWithDeviceGrant`），
//                         所以不需要为 worker 发明第二种凭据。
//
// ---------------------------------------------------------------------------
// fail-closed：云侧这一层的失败一律退化成"不产出动作"
// ---------------------------------------------------------------------------
//
// 与桌面端同一条原则（见 planExecDriftService.js 的注释）。这里的每个拒绝路径都要
// 留下**可读的原因**：`verdict.reason` 或作业的 `error_code`。因为 P4 的验收条件之一
// 就是"真实群任务产出的判定 reason 不再是 input_contract_violation"——
// 如果失败原因是空字符串，这句话就没法被验证。
//
// 特别地：**不发判定比发一个假判定好**。worker 回传的判定如果缺出处（adapter sha256 等），
// 整个回传被拒（409），作业留在 claimed 状态等租约到期重来。理由见
// `chk_cloud_rdmd_job_provenance` 的注释：不可审计的判定等于没有判定。

import crypto from 'node:crypto';

import {
  RDMD_CLOUD_VERDICT_STATUSES,
  RDMD_DRIFT_TYPES,
  PLAN_EXEC_CONTRACT_VERSION as RDMD_PLAN_EXEC_CONTRACT_VERSION,
  RDMD_RULE_VERSION,
} from './contract.mjs';
import { backendResolvesImmediately, nullBackendVerdict, resolveRdmdBackend } from './backend.mjs';
import { assertRdmdCloudEligible, buildRdmdCloudPayload } from './privacy.mjs';
import { routeWithDeviceGrant } from '../sync/index.mjs';

const LEASE_MINUTES = 15;
const MAX_VERDICT_BYTES = 64 * 1024;

// 再导出给本模块的使用者（worker / 测试）用，保证它们看到的是同一份定义。
export { RDMD_PLAN_EXEC_CONTRACT_VERSION, RDMD_RULE_VERSION };

export function registerRdmdRoutes({ app, pool, auth, route, apiError, deviceGrants, env = process.env }) {
  const service = createPostgresRdmdService({ pool, apiError, env });
  // worker 的两个端点走 device grant + `rdmd:infer`（无人值守，没有用户会话）。
  // 桌面端的两个端点是交互式的（用户在场），走 JWT。
  // 这两条通路的分工见 `deviceGrants.mjs#VALID_SCOPES` 附近的注释。
  const requireInferGrant = (handler) => routeWithDeviceGrant(pool, apiError, 'rdmd:infer', handler, { property: 'rdmdGrant' });

  // 提交：桌面端在任务终态上发起。同步返回判定（空后端）或一个待领的作业 id。
  //
  // 状态码按**结果**给，不是一律 201：`not_eligible` 表示"这一轮按设计不上云"，
  // 此时数据库里**没有任何东西被创建** —— 给 201（Created）会让任何一个按 HTTP 状态
  // 判断"云端是否接下了这条 case"的调用方得到相反结论。作业真的建了才给 201。
  app.post('/api/rdmd/jobs', auth, route(async (req, res) => {
    const result = await service.submit({ userId: req.auth.user.id, payload: req.body || {} });
    res.status(result.status === 'not_eligible' ? 200 : 201).json(result);
  }));

  // 领活：GPU worker 出站来领。租约式，掉线后自动被别人接走。
  app.post('/api/rdmd/jobs/claim', requireInferGrant(async (req, res) => {
    res.json(await service.claim({ workerId: req.body?.workerId, payload: req.body || {} }));
  }));

  // 回传判定。**必须**带全出处，否则拒收；且**必须是当前持有租约的那个 worker** 回传。
  app.post('/api/rdmd/jobs/:id/verdict', requireInferGrant(async (req, res) => {
    res.json(await service.recordVerdict({
      jobId: req.params.id,
      payload: req.body || {},
      workerId: req.body?.workerId,
    }));
  }));

  // 桌面端轮询取判定（gpu_worker 后端下提交时还没有判定）。
  app.get('/api/rdmd/jobs/:id', auth, route(async (req, res) => {
    res.json(await service.read({ userId: req.auth.user.id, jobId: req.params.id }));
  }));

  return service;
}

export function createPostgresRdmdService({ pool, apiError = defaultApiError, env = process.env } = {}) {
  if (!pool) throw new Error('PostgreSQL RDMD service requires a pool.');
  const backend = resolveRdmdBackend(env.RDMD_CLOUD_BACKEND);
  const cloudEnabled = String(env.RDMD_CLOUD_ENABLED || '').trim().toLowerCase() === 'true';

  return {
    backend,

    /**
     * 入队一条 case。
     *
     * 三道闸全在这里，且**顺序是刻意的**：能力位 → 隐私 → 载荷。
     * 能力位最先，因为"这个部署根本不想把数据发出去"时，连白名单裁剪都不该发生
     * （裁剪也要把内容读进内存）。
     */
    async submit({ userId = '', payload = {} } = {}) {
      if (!userId) throw apiError('unauthorized', 'Authentication is required.', 401);
      const taskRunId = text(payload.taskRunId || payload.task_run_id, 200);
      const caseValue = payload.case || {};
      const privacy = {
        conversationKind: payload.conversationKind || payload.conversation_kind || '',
      };
      const eligibility = assertRdmdCloudEligible({ privacy, capabilityEnabled: cloudEnabled });
      if (!eligibility.eligible) {
        // 不eligible **不是**错误码，是一个正常结论：这一轮不上云，桌面端据此走 record_only。
        // 用 200 而不是 4xx，是因为"私有会话不该上云"是设计，不是调用方用错了。
        return {
          status: 'not_eligible',
          reason: eligibility.reason,
          jobId: '',
          verdict: null,
        };
      }

      const casePayload = buildRdmdCloudPayload({ case: caseValue });
      const caseHash = sha256(stableStringify(casePayload));
      const jobId = `rdmdjob_${crypto.randomUUID()}`;
      const job = await upsertOpenJob(pool, { jobId, userId, taskRunId, caseHash, casePayload });
      if (backend.warning) {
        await pool.query('UPDATE cloud_rdmd_inference_jobs SET error_code=$1,updated_at=now() WHERE id=$2', [backend.warning, job.id]);
      }

      // 空后端：立刻把这个作业收成 unavailable + UNKNOWN(model_not_configured)。
      // 走的是与真实判定**完全相同**的落库路径，所以"没有 GPU"这件事在数据上也长得像
      // 一条正常判定，而不是一个洞。
      if (backendResolvesImmediately(backend.name)) {
        const verdict = nullBackendVerdict({
          contractVersion: RDMD_PLAN_EXEC_CONTRACT_VERSION,
          ruleVersion: RDMD_RULE_VERSION,
        });
        const finalized = await finalizeJob(pool, { jobId: job.id, status: 'unavailable', verdict, errorCode: verdict.reason });
        return { status: 'unavailable', reason: verdict.reason, jobId: finalized.id, verdict: publicVerdict(finalized) };
      }

      return { status: 'queued', reason: '', jobId: job.id, verdict: null };
    },

    /**
     * 领活。`FOR UPDATE SKIP LOCKED` + 租约，与 `claimJob`（evolution/worker.mjs）同构。
     *
     * `available_at` 参与抢占条件，所以退避只需要在失败时把 `available_at` 往后推，
     * 不需要另写一套调度器。
     */
    async claim({ workerId = '', payload = {} } = {}) {
      const id = text(workerId, 200) || `rdmd-worker-${crypto.randomUUID()}`;
      const limit = Math.max(1, Math.min(4, Number(payload.limit) || 1));
      const claimed = [];
      for (let index = 0; index < limit; index += 1) {
        const row = await claimOne(pool, id);
        if (!row) break;
        claimed.push(publicJob(row));
      }
      return {
        workerId: id, jobs: claimed, leaseSeconds: LEASE_MINUTES * 60,
        // 云侧把**它认可的**契约版本与规则版本随领活一起发下去，worker 要原样回传。
        // 为什么不干脆让 worker 自己声明：出处只有"双方一致"才可信。worker 声明版本、
        // 云侧照单全收，等于出处由被审计方自己填写 —— 那正是"不可审计的判定等于没有判定"
        // 要防的事。worker 侧拿着自己那份契约版本与这里比对，不一致就**不产出判定**。
        contractVersion: RDMD_PLAN_EXEC_CONTRACT_VERSION,
        ruleVersion: RDMD_RULE_VERSION,
      };
    },

    /**
     * 回传判定。出处不全一律拒收。
     */
    /**
     * 回传判定。
     *
     * **为什么必须校验 `workerId`：** 在这之前，只要手里有一个 `rdmd:infer` 的 grant，
     * 就能凭 job id 终结**队列里任何一条在飞作业** —— 包括别的用户的。`owner_user_id` 挡不住
     * 这一侧（worker 是跨用户的服务身份，见 097 迁移的注释），所以唯一有意义的绑定是
     * **租约**：领活时 `claimed_by` 记下了是谁拿的，回传时就该是同一个 worker。
     *
     * 这不是密码学意义上的证明（`workerId` 是 worker 自述的），但它把越权面从
     * 「任何一个 grant 能终结任何一条作业」收窄到「必须知道并冒用持租约者的 id」——
     * 而后者在租约到期后就会失效（见下面的过期检查）。
     *
     * 校验顺序是刻意的：形状/出处的校验在前，所以既有的错误码语义不变；
     * 租约校验在**落库之前**，所以被拒的回传不消耗作业、也不覆盖已完成的判定。
     */
    async recordVerdict({ jobId = '', payload = {}, workerId = '' } = {}) {
      const verdict = normalizeVerdict(payload.verdict || {}, apiError);
      const provenance = normalizeProvenance(payload.provenance || payload.verdict?.provenance || {}, apiError);
      const job = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE id=$1', [jobId])).rows[0];
      if (!job) throw apiError('rdmd_job_not_found', 'RDMD inference job was not found.', 404);
      if (job.status === 'completed') {
        // 重放：同一作业的第二次回传按"已完成"返回，不覆盖。worker 重试是常态
        // （租约到期后别人接走），这里必须是幂等的。
        //
        // 重放**也要**校验租约归属：否则"已经终结的作业"就成了另一个可以随便写的口子。
        // 但已完成的行租约已释放（`lease_expires_at=NULL`），所以这里只比 `claimed_by`。
        assertVerdictLease({ job, workerId, apiError, allowReleasedLease: true });
        return { status: 'completed', jobId: job.id, verdict: publicVerdict(job), replay: true };
      }
      if (!['claimed', 'running'].includes(job.status)) {
        throw apiError('rdmd_job_not_claimed', `RDMD job is ${job.status}; claim it before returning a verdict.`, 409);
      }
      assertVerdictLease({ job, workerId, apiError, allowReleasedLease: false });
      const updated = await finalizeJob(pool, { jobId: job.id, status: 'completed', verdict, provenance });
      return { status: 'completed', jobId: updated.id, verdict: publicVerdict(updated), replay: false };
    },

    /** 桌面端轮询。只允许读自己的作业。 */
    async read({ userId = '', jobId = '' } = {}) {
      const job = (await pool.query('SELECT * FROM cloud_rdmd_inference_jobs WHERE id=$1 AND owner_user_id=$2', [jobId, userId])).rows[0];
      if (!job) throw apiError('rdmd_job_not_found', 'RDMD inference job was not found.', 404);
      return { status: job.status, jobId: job.id, verdict: publicVerdict(job), errorCode: job.error_code || '' };
    },
  };
}

/**
 * 入队时的去重：同一 task run 只保留一个**未结束**的作业。
 *
 * 为什么不用 `ON CONFLICT ... WHERE`（部分唯一索引推断）：功能上等价，但那句语法把
 * "哪个索引能接住这次冲突"交给规划器推断，读代码的人得回头查索引定义才知道行为。
 * 这里写成显式的「先更新未结束的，否则插入」，行为在调用处即可读。
 *
 * 并发提交仍可能撞车（两个请求同时没看到未结束的作业），所以插入失败要认 23505 并
 * 回头取那一行 —— 部分唯一索引在迁移里，是这里的兜底而不是唯一的正确性来源。
 */
async function upsertOpenJob(pool, { jobId = '', userId = '', taskRunId = '', caseHash = '', casePayload = {} } = {}) {
  const updated = await pool.query(`UPDATE cloud_rdmd_inference_jobs
    SET case_hash=$1, case_json=$2::jsonb, updated_at=now()
    WHERE owner_user_id=$3 AND task_run_id=$4 AND status IN ('queued','claimed','running')
    RETURNING *`, [caseHash, JSON.stringify(casePayload), userId, taskRunId]);
  if (updated.rows[0]) return updated.rows[0];
  try {
    const inserted = await pool.query(`INSERT INTO cloud_rdmd_inference_jobs (
      id,owner_user_id,task_run_id,case_hash,case_json,status,available_at,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,'queued',now(),now(),now()) RETURNING *`,
    [jobId, userId, taskRunId, caseHash, JSON.stringify(casePayload)]);
    return inserted.rows[0];
  } catch (error) {
    if (error?.code !== '23505') throw error;
    const raced = (await pool.query(`SELECT * FROM cloud_rdmd_inference_jobs
      WHERE owner_user_id=$1 AND task_run_id=$2 AND status IN ('queued','claimed','running')
      ORDER BY created_at DESC LIMIT 1`, [userId, taskRunId])).rows[0];
    if (!raced) throw error;
    return raced;
  }
}

/**
 * 回传判定的租约归属校验。见 `recordVerdict` 的注释。
 *
 * 两种拒绝要分得清，因为排查方向完全不同：
 *   - `rdmd_worker_id_required` —— 回传者根本没说自己是谁（客户端没升级 / 忘了带）；
 *   - `rdmd_job_claimed_by_other_worker` —— 说了，但不是持租约的那个（发错了 worker，或有人在越权）；
 *   - `rdmd_job_lease_expired` —— 是持租约者，但租约已经过期（很可能是这条作业已经被别人接走重跑）。
 *
 * `allowReleasedLease`：已完成的作业租约已经被释放（`lease_expires_at=NULL`），
 * 幂等重放时不能因此被拒，所以那种情况下只比 `claimed_by`。
 */
function assertVerdictLease({ job = {}, workerId = '', apiError, allowReleasedLease = false } = {}) {
  const claimant = String(job.claimed_by || '');
  const claimedBy = String(workerId || '').trim().slice(0, 200);
  if (!claimedBy) {
    throw apiError('rdmd_worker_id_required',
      'A verdict must carry the workerId that claimed the job: without it any rdmd:infer grant could finalize any in-flight job.', 400);
  }
  if (!claimant || claimant !== claimedBy) {
    throw apiError('rdmd_job_claimed_by_other_worker',
      `RDMD job ${job.id} is leased to a different worker; a verdict may only be returned by the worker that claimed it.`, 409);
  }
  if (allowReleasedLease) return;
  const expiresAt = job.lease_expires_at ? new Date(job.lease_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    throw apiError('rdmd_job_lease_expired',
      `RDMD job ${job.id} is no longer leased; the case has been (or will be) handed to another worker.`, 409);
  }
}

async function claimOne(pool, workerId) {  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 先把"次数用尽但还没终态"的作业收掉。
    //
    // 为什么必须在 claim 里做：选行条件含 `attempt_count < max_attempts`，所以一个用尽了
    // 次数的作业**永远不会再被选中**，也就永远不会离开 claimed —— 它以"过期租约"的样子
    // 永远留在表里，谁都不再处理它。这不是"少见情况"：worker 领到一条它反复答不出的 case
    // 时必然走到这里（每次重试都是同一份权重、同一条 case，结果一样）。
    // cloud_evolution_jobs 的 worker 明确有这一步（attemptsExhausted → failed_terminal），
    // 这里照做，用的是同一套语义。
    //
    // 只收租约已过期的行：最后一次尝试可能**正被某个 worker 拿在手上跑**，今天就把它判死
    // 会让那次真实回传撞上"作业已不是 claimed"而丢掉一个判定（判定是稀缺物，不该丢）。
    // 等租约自然过期，说明确实没人还在管它，再收。代价是僵尸多活一个租约周期，值得。
    await client.query(`UPDATE cloud_rdmd_inference_jobs SET status='failed_terminal',
      error_code='rdmd_attempts_exhausted',
      error_text='The job exhausted max_attempts without an accepted verdict; no worker will claim it again.',
      lease_expires_at=NULL, completed_at=now(), updated_at=now()
      WHERE attempt_count >= max_attempts
        AND status IN ('queued','claimed','running','failed_retryable')
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())`);
    const { rows } = await client.query(`SELECT * FROM cloud_rdmd_inference_jobs WHERE
      ((status IN ('queued','failed_retryable') AND available_at <= now())
       OR (status IN ('claimed','running') AND lease_expires_at <= now()))
      AND attempt_count < max_attempts
      ORDER BY available_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const result = await client.query(`UPDATE cloud_rdmd_inference_jobs SET status='claimed', claimed_by=$1,
      claimed_at=now(), lease_expires_at=now() + interval '${LEASE_MINUTES} minutes',
      attempt_count=attempt_count+1, updated_at=now() WHERE id=$2 RETURNING *`, [workerId, rows[0].id]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeJob(pool, { jobId = '', status = '', verdict = null, provenance = {}, errorCode = '' } = {}) {
  const result = await pool.query(`UPDATE cloud_rdmd_inference_jobs SET status=$1, verdict_json=$2::jsonb,
    adapter_sha256=$3, base_model_id=$4, contract_version=$5, rule_version=$6, worker_version=$7,
    error_code=$8, completed_at=now(), updated_at=now(), lease_expires_at=NULL
    WHERE id=$9 RETURNING *`, [
    status, verdict ? JSON.stringify(verdict) : null,
    provenance.adapterSha256 || verdict?.provenance?.adapterSha256 || '',
    provenance.baseModelId || verdict?.provenance?.baseModelId || '',
    provenance.contractVersion || verdict?.provenance?.contractVersion || RDMD_PLAN_EXEC_CONTRACT_VERSION,
    provenance.ruleVersion || verdict?.provenance?.ruleVersion || RDMD_RULE_VERSION,
    provenance.workerVersion || verdict?.provenance?.workerVersion || '',
    errorCode, jobId,
  ]);
  return result.rows[0];
}

/**
 * 把 worker 回传的 status 归一成契约里的规范写法。
 *
 * 为什么需要归一而不是原样比：判定的 status 取值域是 `drift` / `no_drift` / `UNKNOWN`
 * —— **大小写不统一是刻意的**，它直接来自语料的 `label.status` 与 `predict.py` 的输出。
 * worker 侧（Python 3 + json）与 JS 侧对大小写的处理不同，中间还隔着 HTTP，
 * 所以这里按"不区分大小写地认，但落库/回传一律用规范写法"来做 ——
 * 否则一个 `DRIFT` 会变成"未知状态"被 400 掉，而它明明是合法判定。
 */
const VERDICT_STATUS_CANONICAL = new Map(RDMD_CLOUD_VERDICT_STATUSES.map((status) => [status.toLowerCase(), status]));

function canonicalVerdictStatus(value) {
  return VERDICT_STATUS_CANONICAL.get(String(value == null ? '' : value).trim().toLowerCase()) || '';
}

/**
 * 判定形状校验。**这里只校验形状与出处，不校验内容对不对** ——
 * "这个 nodeId 在不在图里"是 worker 侧（predict.py）的职责，云侧没有图可比。
 */
function normalizeVerdict(value, apiError) {
  const raw = value && typeof value === 'object' ? value : {};
  const status = canonicalVerdictStatus(raw.status);
  if (!status) {
    throw apiError('rdmd_verdict_status_invalid', `RDMD verdict status must be one of ${RDMD_CLOUD_VERDICT_STATUSES.join(', ')}.`, 400);
  }
  const type = text(raw.type, 60);
  // 未知 type 必须拦在这里。`routeEvolution` 对未知 type 是**兜底成** minimal_plan_edit，
  // 所以放宽这一条会让一个概念外的类型变成一次改图动作（与桌面端第 5 条防线同源）。
  if (type && !RDMD_DRIFT_TYPES.includes(type)) {
    throw apiError('rdmd_verdict_type_invalid', `RDMD verdict type ${type} is not a known drift type.`, 400);
  }
  const verdict = {
    status,
    nodeId: text(raw.nodeId, 200),
    type: status === 'drift' ? type : '',
    reason: text(raw.reason, 200),
    valid: raw.valid !== false,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map((item) => text(item, 200)).slice(0, 20) : [],
  };
  if (status === 'drift' && (!verdict.nodeId || !verdict.type)) {
    throw apiError('rdmd_verdict_incomplete', 'A drift verdict requires nodeId and type.', 400);
  }
  if (JSON.stringify(verdict).length > MAX_VERDICT_BYTES) {
    throw apiError('rdmd_verdict_too_large', 'RDMD verdict exceeds the size limit.', 413);
  }
  return verdict;
}

/**
 * 出处校验。**这是"不可审计的判定等于没有判定"的执行点。**
 *
 * adapterSha256 必须是 64 位十六进制 —— 不是的话，要么是占位符（'unknown'/'none'），
 * 要么是截断过的哈希。两种都无法回答"这条判定出自哪一个 adapter"，
 * 而那正是 P4 要求出处的原因。
 */
function normalizeProvenance(value, apiError) {
  const raw = value && typeof value === 'object' ? value : {};
  const adapterSha256 = text(raw.adapterSha256 || raw.adapter_sha256, 64).toLowerCase();
  const baseModelId = text(raw.baseModelId || raw.base_model_id, 200);
  if (!adapterSha256) throw apiError('rdmd_provenance_missing_adapter', 'A verdict must carry the adapter sha256 it came from.', 409);
  if (!/^[0-9a-f]{64}$/.test(adapterSha256)) {
    throw apiError('rdmd_provenance_invalid_adapter', 'adapterSha256 must be a full 64-character hex digest.', 409);
  }
  if (!baseModelId) throw apiError('rdmd_provenance_missing_model', 'A verdict must carry the base model id it came from.', 409);
  const contractVersion = text(raw.contractVersion || raw.contract_version, 60);
  if (!contractVersion) throw apiError('rdmd_provenance_missing_contract', 'A verdict must carry the contract version it was judged against.', 409);
  return {
    adapterSha256,
    baseModelId,
    contractVersion,
    ruleVersion: text(raw.ruleVersion || raw.rule_version, 60) || RDMD_RULE_VERSION,
    workerVersion: text(raw.workerVersion || raw.worker_version, 120),
  };
}

function publicJob(row) {
  return {
    jobId: row.id,
    taskRunId: row.task_run_id,
    caseHash: row.case_hash,
    // jsonb 在真实 Postgres（node-pg）里是对象，在 pg-mem 里是字符串。
    // 不解析的话，worker 会收到一个字符串形式的 case 而去解析失败 —— 或者更糟，
    // 拿到一个"看起来像对象"的东西，字段全 undefined。
    case: jsonObject(row.case_json),
    attemptCount: Number(row.attempt_count || 0),
    leaseExpiresAt: toIso(row.lease_expires_at),
  };
}

function publicVerdict(row) {
  if (!row) return null;
  const verdict = jsonObject(row.verdict_json);
  if (!row.verdict_json) return null;
  return { ...verdict, provenance: provenanceOf(row) };
}

/** jsonb 兼容解析：对象原样返回，字符串解析，其余给空对象。 */
function jsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function provenanceOf(row) {
  return {
    adapterSha256: row.adapter_sha256 || '',
    baseModelId: row.base_model_id || '',
    contractVersion: row.contract_version || '',
    ruleVersion: row.rule_version || '',
    workerVersion: row.worker_version || '',
  };
}

export function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function text(value, limit = 0) {
  const result = value == null ? '' : String(value).trim();
  return limit > 0 ? result.slice(0, limit) : result;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value || '');
}

function defaultApiError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
