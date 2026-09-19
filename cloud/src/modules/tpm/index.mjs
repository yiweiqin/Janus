/**
 * TPM 原始层申请/授权的落库。
 *
 * 状态机**不在这里**：它在 `src/shared/contracts/uBuddyTaskPublicMemory.js`，
 * 是纯函数、已有自己的测试。这里只做三件事：
 *
 *   1. 把纯函数的结论**落库**（申请一张行、授权一张行）；
 *   2. 把**读路径**记进已有的 `cloud_work_memory_access_audits`（合约文档指定的复用点）；
 *   3. 读的时候**从库里取授权**再投影 —— 而不是把 grant 当参数传进来。
 *
 * 第 3 条是这份接线的重点。如果投影用的 grant 是调用方在内存里递过来的，那么
 * "落库"这件事就只是个日记：把库里那张授权行删掉，读路径照样能拿到 raw。
 * 而"谁能看原始层"这件事，唯一说了算的应该是库里那一行。
 *
 * 于是 `readRaw` 的形状里**没有 grant 参数** —— 授权只能从表里来。
 */
import { randomUUID } from 'node:crypto';

import {
  TPM_OWNER_REVIEW_DECISIONS,
  applyRawAccessPipeline, createRawAccessRequest, normalizeTaskPublicMemory,
  projectTaskPublicMemory,
} from '../../../../src/shared/contracts/uBuddyTaskPublicMemory.js';

export const TPM_REQUEST_TABLE = 'cloud_tpm_raw_access_requests';
export const TPM_GRANT_TABLE = 'cloud_tpm_raw_access_grants';
export const TPM_AUDIT_TABLE = 'cloud_work_memory_access_audits';

/** `isParticipant` 的兜底：一个不可能等于任何 taskId 的值。见 `readRaw` 的注释。 */
const EXTERNAL_VIEWER_TASK = '__external__';

/**
 * 派生状态。**唯一**的派生点 —— 调用方不许自己算这个字符串，
 * 否则"库里 status 是 granted 却没有授权行"这类不一致迟早会出现。
 */
export function statusOf(ai = {}, owner = null) {
  if (ai.decision === 'reject') return 'rejected_by_ai';
  if (owner && owner.decision === 'approve') return 'granted';
  return 'denied_by_owner';
}

/**
 * 审计行的 `result` 用**粗粒度**的 outcome，`result_code` 用细粒度的 status。
 * 两个都要：粗的用于"通过率"这类统计（`denied_by_owner` 与 `rejected_by_ai`
 * 在这个问题上都是"没通过"），细的用于追具体原因。
 */
function auditOutcome(status) {
  return status === 'granted' ? 'approved' : 'denied';
}

function text(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function apiError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function createTpmAccessService({ pool, now = () => Date.now() } = {}) {
  if (!pool) throw new Error('tpm_pool_required');

  async function writeAudit({ requestId, requesterUserId, targetTaskId, reason, result, resultCode, ownerUserId = '' }) {
    // requester_user_id 上有 → users(id) 的外键：调用方必须保证这个人存在。
    // 这里不替他建用户 —— 建用户是身份的活，不是访问审计的活。
    await pool.query(
      `INSERT INTO ${TPM_AUDIT_TABLE}
         (id,requester_user_id,requester_agent_instance_id,target_user_id,target_agent_instance_id,
          work_scope_id,memory_document_version_id,requested_reason,requester_role_snapshot,
          leadership_assignment_snapshot_json,result,result_code)
       VALUES ($1,$2,$3,$4,'',$5,'',$6,'','{}'::jsonb,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [
        `tpm_audit_${requestId}`, requesterUserId, `${requesterUserId}__tpm`,
        text(ownerUserId, 160), text(targetTaskId, 160), text(reason, 500), result, resultCode,
      ],
    );
  }

  async function persistRequest({ request, ai, owner, actorUserId, status }) {
    await pool.query(
      `INSERT INTO ${TPM_REQUEST_TABLE}
         (id,source_task_id,target_task_id,requester_user_id,purpose,node_ids_json,excerpt_only,
          ai_decision,ai_reasons_json,owner_decision,owner_user_id,status,created_at,decided_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
       -- 同一份申请重跑要幂等：submit 与模拟任务群都会重跑，而"重跑一次多一条申请"
       -- 会让审计里同一个 requestId 出现好几次，看起来像被申请了三遍。
       ON CONFLICT (id) DO UPDATE SET
         ai_decision=excluded.ai_decision, ai_reasons_json=excluded.ai_reasons_json,
         owner_decision=excluded.owner_decision, owner_user_id=excluded.owner_user_id,
         status=excluded.status, decided_at=excluded.decided_at`,
      [
        request.requestId, request.sourceTaskId, request.targetTaskId, request.requesterUserId,
        request.purpose, JSON.stringify(request.nodeIds), request.excerptOnly,
        ai.decision, JSON.stringify(ai.reasons),
        // `owner_user_id` 记的是**做决定的那个人**（actorUserId），不是 raw 的属主。
        // 属主另有其位（审计行的 target_user_id）—— 这两个在跨人申请里通常不是一个人。
        owner ? owner.decision : '', text(actorUserId, 160),
        status, request.createdAt, owner ? new Date(now()).toISOString() : null,
      ],
    );
  }

  async function persistGrant(grant) {
    if (!grant) return;
    await pool.query(
      `INSERT INTO ${TPM_GRANT_TABLE}
         (id,request_id,target_task_id,grantee_user_id,node_ids_json,excerpt_only,
          read_only,revocable,expires_at,approved_by,created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        grant.grantId, grant.requestId, grant.targetTaskId, grant.granteeUserId,
        JSON.stringify(grant.nodeIds || []), grant.excerptOnly !== false,
        grant.readOnly !== false, grant.revocable !== false, grant.expiresAt,
        text(grant.approvedBy, 160), new Date(now()).toISOString(),
      ],
    );
  }

  return {
    /**
     * 走完整条流水线并落库。`memory` 是 TPM 本体（三层），由调用方从既有底座装配 ——
     * foundation 来自协作图投影、elevation 来自省检摘要、raw 来自原始上下文。
     * 这里不负责装配，只负责"申请 → 预审 → 终审 → 授权"这条链的落库。
     */
    async requestRawAccess({ request = {}, memory = {}, ownerDecision = 'deny', actorUserId = '' } = {}) {
      // 纯函数对非法 ownerDecision 是**静默降级成 deny** 的（合约里 `TPM_OWNER_REVIEW_DECISIONS.includes`
      // 那一段）。在落库这个边界上不该静默：一个 `'approve '`（尾随空格）会被存成一条
      // "被拒"的申请，而调用方以为批了。所以这里响亮地拒绝。
      if (!TPM_OWNER_REVIEW_DECISIONS.includes(ownerDecision)) {
        throw apiError('tpm_owner_decision_invalid',
          `ownerDecision 必须是 ${TPM_OWNER_REVIEW_DECISIONS.join('|')}，收到 ${JSON.stringify(ownerDecision)}`);
      }
      const normalizedMemory = normalizeTaskPublicMemory(memory);
      const pipeline = applyRawAccessPipeline(request, normalizedMemory, { ownerDecision, actorUserId });
      const normalizedRequest = pipeline.ai.request || createRawAccessRequest(request);
      const status = statusOf(pipeline.ai, pipeline.owner);
      // 授权行只在 owner 真的批了的时候才写。"granted" ⟺ "有授权行"。
      if (status === 'granted' && !pipeline.owner?.grant) {
        throw apiError('tpm_grant_missing', 'owner 判了 approve 却没给出 grant', 500);
      }
      if (status !== 'granted' && pipeline.owner?.grant) {
        throw apiError('tpm_grant_unexpected', `status=${status} 却带了 grant`, 500);
      }

      await persistRequest({ request: normalizedRequest, ai: pipeline.ai, owner: pipeline.owner, actorUserId, status });
      await persistGrant(pipeline.owner?.grant || null);
      await writeAudit({
        requestId: normalizedRequest.requestId, requesterUserId: normalizedRequest.requesterUserId,
        targetTaskId: normalizedRequest.targetTaskId, reason: normalizedRequest.purpose,
        ownerUserId: normalizedMemory.ownerUserId, result: auditOutcome(status), resultCode: status,
      });

      return {
        status,
        request: normalizedRequest,
        ai: pipeline.ai,
        owner: pipeline.owner,
        grant: pipeline.owner?.grant || null,
        // 申请人自己看到的投影：批了就能看到 raw（按 nodeIds 切片 / excerptOnly 截断）。
        projection: pipeline.projection,
      };
    },

    /**
     * 读路径。**不接受 grant 参数** —— 授权只能从库里取（理由见文件头）。
     * 取不到 / 过期 / 被撤回 → 投影里 raw 依然是关的，`denied` 会写明 `raw_requires_grant`。
     *
     * `sourceTaskId` 是**申请人自己的任务**，会作为 `viewer.taskId` 传下去。
     * 为什么不能省：`isParticipant` 在 `viewer.taskId` 为空时只比对 userId ——
     * 于是"属主来申请看自己任务的 raw"会**绕过 grant**直接解锁。传申请人的任务，
     * 参与者判定就落回它本来的语义（跨任务 ≠ 参与者），解锁与否只由授权行决定。
     * 没传时用 `__external__` 兜底：宁可判成"外部人"，也不能默认成"参与者"。
     */
    async readRaw({ memory = {}, requesterUserId = '', sourceTaskId = '', targetTaskId = '', grantId = '' } = {}) {
      const normalizedMemory = normalizeTaskPublicMemory(memory);
      const taskId = text(targetTaskId, 160) || normalizedMemory.taskId;
      const params = [text(requesterUserId, 160), taskId];
      const filter = grantId ? 'AND id=$3' : '';
      if (grantId) params.push(text(grantId, 160));
      const rows = (await pool.query(
        `SELECT * FROM ${TPM_GRANT_TABLE}
          WHERE grantee_user_id=$1 AND target_task_id=$2
            AND revoked_at IS NULL AND expires_at > now() ${filter}
          ORDER BY expires_at DESC`,
        params,
      )).rows;
      const row = rows[0] || null;
      const grant = row ? {
        grantId: row.id,
        requestId: row.request_id,
        targetTaskId: row.target_task_id,
        granteeUserId: row.grantee_user_id,
        nodeIds: row.node_ids_json || [],
        excerptOnly: row.excerpt_only,
        readOnly: row.read_only,
        revocable: row.revocable,
        expiresAt: new Date(row.expires_at).toISOString(),
        approvedBy: row.approved_by,
      } : null;

      const projection = projectTaskPublicMemory(normalizedMemory, {
        userId: text(requesterUserId, 160),
        taskId: text(sourceTaskId, 160) || EXTERNAL_VIEWER_TASK,
        grant,
      });
      await writeAudit({
        // 读是**流水**：重跑一次就是又读了一次，理应多一行。所以这里刻意不用
        // `grantId` 当 id（那会让"同一个授权被读了两次"在审计里只剩一行）。
        requestId: `read_${randomUUID()}`,
        requesterUserId: text(requesterUserId, 160), targetTaskId: taskId,
        reason: 'tpm_raw_read', ownerUserId: normalizedMemory.ownerUserId,
        result: projection.layers.includes('raw') ? 'approved' : 'denied',
        resultCode: projection.layers.includes('raw') ? 'granted' : 'raw_requires_grant',
      });
      return {
        grant,
        // 有授权行却没解锁 raw 的唯一可能是授权与 memory 对不上（属主/任务），照实带出去。
        unlocked: projection.layers.includes('raw'),
        projection,
      };
    },

    async listRequests({ targetTaskId = '', limit = 100 } = {}) {
      return (await pool.query(
        `SELECT * FROM ${TPM_REQUEST_TABLE} WHERE target_task_id=$1 ORDER BY created_at DESC LIMIT $2`,
        [text(targetTaskId, 160), Number(limit) || 100],
      )).rows;
    },

    async listGrants({ targetTaskId = '', includeRevoked = false, limit = 100 } = {}) {
      return (await pool.query(
        `SELECT * FROM ${TPM_GRANT_TABLE}
          WHERE target_task_id=$1 ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
          ORDER BY created_at DESC LIMIT $2`,
        [text(targetTaskId, 160), Number(limit) || 100],
      )).rows;
    },

    /**
     * 撤回。写 `revoked_at` 而不是删行（删了就无法回答"它曾经被授权过"）。
     * 撤回后 `readRaw` 立刻读不到 —— 那是这条链接线的意义所在。
     */
    async revokeGrant({ grantId = '', actorUserId = '' } = {}) {
      if (!grantId) throw apiError('tpm_grant_id_required', '缺少 grantId');
      const row = (await pool.query(
        `UPDATE ${TPM_GRANT_TABLE} SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING *`,
        [text(grantId, 160)],
      )).rows[0];
      if (!row) throw apiError('tpm_grant_not_found', `授权不存在或已撤回：${grantId}`, 404);
      await writeAudit({
        requestId: `revoke_${row.id}`, requesterUserId: text(actorUserId, 160) || row.approved_by,
        targetTaskId: row.target_task_id, reason: 'tpm_grant_revoked',
        result: 'denied', resultCode: 'revoked',
      });
      return row;
    },
  };
}
