/**
 * TPM 原始层的那个**消费者**：模拟任务群把申请→预审→终审→读 这条链在真库上跑一遍。
 *
 * ## 为什么这件事必须走一遍真库，而不是只跑纯函数
 *
 * `src/shared/contracts/uBuddyTaskPublicMemory.js` 的状态机早就有测试了，而且是纯的。
 * 但"纯函数算得对"与"这套机制真的在库里成立"是两件事，中间隔着的正是这一层：
 *
 *   - 申请落库了没有？授权行是不是**只在** owner 批了的时候才出现？
 *   - 读路径拿的授权是**从库里取的**，还是调用方在内存里递进来的？
 *     （如果是后者，删掉库里那行照样能读 —— 那"留痕"就只是日记。）
 *   - 审计有没有真的写进 `cloud_work_memory_access_audits`？
 *   - 撤回之后，读路径是不是**立刻**关上了？
 *
 * 这四条都是库层面的性质，纯函数测试永远问不出来。所以这一步的产出不是"跑通了"，
 * 而是一份**可核对的观测**：每一步的 layers、每一张表的行数、每条申请的状态。
 * 任何一条不变式不成立就抛错（`sim_tpm_invariant_failed`），让整条 run_remote 失败 ——
 * 一个静默变绿的 TPM 验证比没有验证更糟。
 *
 * ## 边界：这里**不**持久化 memory 本体
 *
 * 落库的是**访问状态**（申请/授权/审计）。memory 的三层内容仍然由调用方装配：
 * foundation 取自本 case 的 `G_star`/`G_prime`（就是 `store.mjs` 刚写进
 * `collaboration_graph_*` 的那两张图 —— 所以这里有一道交叉校验：申请窗口里的每个
 * nodeId 都必须能在图里查到），elevation 走合约自带的 `inspectElevationItems` 省检，
 * raw 由 case 的节点字段派生。
 *
 * 这条边界是**刻意**的：把 memory 本体也塞进 TPM 表，等于在库里再养一份协作图的副本，
 * 而"哪一份是真的"这种问题会在第一次对不上时爆出来。合约文档给的装配方式是
 * **复用**既有载体（协作图 / 工作 memory 摘要 / 私有会话），不是新建一套。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgPool } from '../../cloud/src/db.mjs';
import { createTpmAccessService } from '../../cloud/src/modules/tpm/index.mjs';
import { inspectElevationItems } from '../../src/shared/contracts/uBuddyTaskPublicMemory.js';
import { normalizeRichGraph } from '../rdmd_detective_dataset/lib/graph.mjs';
import { graphRows, writeGraph } from './store.mjs';
import { SIM_OWNER_USER_ID, readJsonl } from './submit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CASES = resolve(HERE, 'out/generated.jsonl');
export const DEFAULT_BRIEFS = resolve(HERE, 'out/briefs.jsonl');
export const DEFAULT_OUT = resolve(HERE, 'out/tpm_report.json');

/**
 * 申请人。**刻意与 `user_sim_task_group` 分开**：跨人申请是这套机制唯一有意思的形态，
 * 而"自己申请看自己的原始层"根本不该走到申请这一步（属主本来就有权）。
 * 用两个身份，这条链上每次授权都真的是跨人授权。
 */
export const SIM_REQUESTER_USER_ID = 'user_sim_tpm_requester';
/** 申请人自己的任务（与目标任务不同 —— 这正是跨任务）。 */
export const SIM_REQUESTER_TASK_ID = 'task_sim_tpm_requester_home';

/** 容器层不是"原始上下文"的产出者，所以不进 raw。 */
const CONTAINER_KINDS = new Set(['root', 'ubuddy']);

/** 申请窗口最多取几个节点。窗口越窄，越能看出"授权 ≠ 全文"。 */
const DEFAULT_WINDOW = 2;

/**
 * 装配 TPM 本体。**纯函数** —— 于是"装配对不对"可以在没有库的地方穷举。
 *
 * raw 的正文由节点字段派生（标题/角色/执行者/语义摘要），**刻意不取**
 * `inputs`/`output`：那是节点内部的自由文本，语料里可能带绝对路径或
 * `token:` 这类东西，而 `inspectElevationItems` 的密钥规则会把整条 raw 丢掉 ——
 * 于是"省检丢了几条"这个数就再也不是我们能解释的一个数。派生是可控的，
 * 也让报告里的 `elevationDropped` 保持可解释。
 */
export function buildTpmMemory({ sample, brief, taskId, ownerUserId, participantUserIds = [] }) {
  const plan = normalizeRichGraph(sample.G_star);
  const exec = normalizeRichGraph(sample.G_prime);
  const briefTitle = String(brief?.title || brief?.topic || taskId);
  const raw = plan.nodes
    .filter((node) => !CONTAINER_KINDS.has(node.kind))
    .slice(0, 24)
    .map((node) => ({
      id: `raw_${node.id}`,
      nodeId: node.id,
      kind: 'context',
      title: node.title || node.id,
      resultVersion: node.version,
      content: `[${briefTitle}] ${node.title}（${node.role || node.kind}）由 ${node.agentId} 执行；`
        + `原始上下文：${node.summary || '该步骤没有留下语义摘要'}`,
    }));
  // 省检：合约自带的那一道。被丢掉的（密钥/空）不提升为摘要 —— 但**留在 raw 里**，
  // 这正是"提升层是省检过的视图、原始层才是全部"的分界。
  const inspected = inspectElevationItems(raw);
  return {
    memory: {
      version: 'ubuddy_task_public_memory_v1',
      taskId,
      ownerUserId,
      participantUserIds,
      foundation: {
        plan: { nodes: plan.nodes, edges: plan.edges },
        exec: { nodes: exec.nodes, edges: exec.edges },
      },
      elevation: inspected.accepted,
      raw,
    },
    inspected: { accepted: inspected.accepted.length, rejected: inspected.rejected.length },
  };
}

/** 申请窗口：挑最前面的几个**工作单元**。 */
export function pickWindow(memory, size = DEFAULT_WINDOW) {
  return memory.raw
    .filter((item) => item.nodeId)
    .slice(0, size)
    .map((item) => item.nodeId);
}

/**
 * purpose 必须**落在已公开的那两层上** —— AI 预审的 `purpose_not_grounded` 检查
 * 就是这个意思：申请人应当先看过摘要，再基于摘要提出申请。
 * 这里用 elevation 的标题当锚点，于是"接地"这件事是构造上成立的，而不是碰运气。
 */
export function groundedPurpose({ elevationTitle, briefTitle }) {
  return `核对「${elevationTitle}」这一步的原始取数记录（来源任务：${briefTitle}）`;
}

/**
 * 两个 sim 身份的 users 行。`cloud_work_memory_access_audits.requester_user_id` 上有
 * → `users(id)` 的外键，所以**审计行插得进去的前提**是申请人真的在册。
 * 幂等：重跑不该因为身份已存在而失败。
 */
export async function ensureSimUsers(pool, ids = [SIM_OWNER_USER_ID, SIM_REQUESTER_USER_ID]) {
  for (const id of ids) {
    await pool.query(
      `INSERT INTO users (id,email,display_name,username,password_hash,email_verified,role)
       VALUES ($1,$2,$3,$1,'not-a-real-hash',true,'member')
       ON CONFLICT (id) DO UPDATE SET display_name=excluded.display_name`,
      [id, `${id}@sim.invalid`, id],
    );
  }
}

/**
 * 一条 case 上跑完整条链，返回可直接核对的观测。
 *
 * 请求的三个方向各自防一种失败：
 *   1. 正当申请 → pass + approve → 拿到（切片、截断的）raw；
 *   2. 没有 purpose → AI 直接拒，**不产生授权行**（哪怕 owner 想批也轮不到）；
 *   3. purpose 与已公开层无关 → need_human（不是拒，是交给人），owner 拒掉。
 */
export async function exerciseCase({ pool, service, sample, brief, graphPresent = false, windowSize = DEFAULT_WINDOW }) {
  // 缺失的身份会让审计插入撞外键，报出来的却是"users 表上的外键约束"——看不出
  // 真正缺的是谁。所以在开跑前先问一句，把话说清楚。
  const missing = [];
  for (const id of [SIM_OWNER_USER_ID, SIM_REQUESTER_USER_ID]) {
    // 逐个查而不是 `= ANY($1)`：数组参数在 pg-mem 夹具里不可靠，
    // 而这道守门逻辑**必须**在两个环境里给出同一个结论。
    const row = await pool.query('SELECT 1 AS x FROM users WHERE id=$1', [id]);
    if (!row.rowCount) missing.push(id);
  }
  if (missing.length) throw new Error(`sim_tpm_identity_missing:${missing.join(',')}（先调 ensureSimUsers）`);

  const taskId = `sim_${sample.graph_id}`.slice(0, 160);

  // **重跑要先清掉上一次的状态**（申请/授权），否则第二条不变式「撤回之后读不到」
  // 会让重跑直接失败：上一轮已经把 `tpm_grant_…_ok` 撤回了，这一轮再撤回就是 404，
  // 而不撤回又拿不到能读的授权 —— 两种都错，因为**已撤回的授权不该复活**。
  //
  // 边界说清楚：清的是**状态**（`cloud_tpm_*`，当前真相），不动**审计**
  // （`cloud_work_memory_access_audits`，追加式流水）。所以重跑之后
  // "申请行数不变、审计行数变多"是预期，而不是泄漏 —— 见 `tpm.test.mjs` 的幂等用例。
  const stale = (await pool.query(
    'SELECT count(*)::int AS n FROM cloud_tpm_raw_access_grants WHERE target_task_id=$1 AND revoked_at IS NOT NULL',
    [taskId],
  )).rows[0].n;
  let stateReset = 'none';
  if (stale) {
    await pool.query('DELETE FROM cloud_tpm_raw_access_grants WHERE target_task_id=$1', [taskId]);
    await pool.query('DELETE FROM cloud_tpm_raw_access_requests WHERE target_task_id=$1', [taskId]);
    stateReset = `cleared_previous_run:${stale}`;
  }
  const { memory, inspected } = buildTpmMemory({
    sample, brief, taskId, ownerUserId: SIM_OWNER_USER_ID,
    participantUserIds: [SIM_OWNER_USER_ID],
  });
  const window = pickWindow(memory, windowSize);
  if (!window.length) throw new Error(`sim_tpm_no_window:${sample.id}`);
  const anchor = memory.elevation[0];

  const steps = [];
  const viewer = { requesterUserId: SIM_REQUESTER_USER_ID, sourceTaskId: SIM_REQUESTER_TASK_ID };

  // ① 授权之前：读不到 raw。这一条是整套机制的地基。
  const locked = await service.readRaw({ memory, targetTaskId: taskId, ...viewer });
  steps.push({
    step: 'locked_before_request',
    layers: locked.projection.layers,
    denied: locked.projection.denied,
    rawItems: locked.projection.raw.length,
  });

  // ② 正当申请：purpose 落在 elevation 上、窗口很窄、只要摘录。
  const granted = await service.requestRawAccess({
    request: {
      requestId: `tpm_req_${taskId}_ok`, sourceTaskId: SIM_REQUESTER_TASK_ID, targetTaskId: taskId,
      requesterUserId: SIM_REQUESTER_USER_ID, nodeIds: window,
      purpose: groundedPurpose({ elevationTitle: anchor?.title || window[0], briefTitle: brief?.title || taskId }),
      excerptOnly: true,
    },
    memory, ownerDecision: 'approve', actorUserId: SIM_OWNER_USER_ID,
  });
  steps.push({
    step: 'request_granted', ai: granted.ai.decision, aiReasons: granted.ai.reasons, status: granted.status,
    grantId: granted.grant?.grantId || '', readOnly: granted.grant?.readOnly, revocable: granted.grant?.revocable,
  });

  // ③ 拿到之后：raw 只给**申请窗口内**的那几条，且正文被截断到 280 字符。
  const unlocked = await service.readRaw({ memory, targetTaskId: taskId, ...viewer });
  steps.push({
    step: 'unlocked_after_grant',
    layers: unlocked.projection.layers,
    rawNodeIds: unlocked.projection.raw.map((item) => item.nodeId),
    rawItems: unlocked.projection.raw.length,
    maxContentLength: Math.max(0, ...unlocked.projection.raw.map((item) => item.content.length)),
  });

  // ④ 负对照一：没有 purpose。AI 预审就拒，授权表必须一条都不多。
  const noPurpose = await service.requestRawAccess({
    request: {
      requestId: `tpm_req_${taskId}_nopurpose`, sourceTaskId: SIM_REQUESTER_TASK_ID, targetTaskId: taskId,
      requesterUserId: SIM_REQUESTER_USER_ID, nodeIds: window, purpose: '', excerptOnly: true,
    },
    memory, ownerDecision: 'approve', actorUserId: SIM_OWNER_USER_ID,
  });
  const grantsAfterReject = (await service.listGrants({ targetTaskId: taskId, includeRevoked: true })).length;
  steps.push({
    step: 'ai_rejected_no_purpose', ai: noPurpose.ai.decision, aiReasons: noPurpose.ai.reasons,
    status: noPurpose.status, grantsInDb: grantsAfterReject,
  });

  // ⑤ 负对照二：purpose 与已公开的两层毫无关系 → need_human（交给人，而不是自动放行）。
  //    只有 elevation 非空时这条才有意义（空的话合约会跳过接地检查）。
  let ungrounded = null;
  if (memory.elevation.length) {
    ungrounded = await service.requestRawAccess({
      request: {
        requestId: `tpm_req_${taskId}_ungrounded`, sourceTaskId: SIM_REQUESTER_TASK_ID, targetTaskId: taskId,
        requesterUserId: SIM_REQUESTER_USER_ID, nodeIds: window, purpose: 'zzz qqq wwww', excerptOnly: true,
      },
      memory, ownerDecision: 'deny', actorUserId: SIM_OWNER_USER_ID,
    });
    steps.push({
      step: 'ungrounded_needs_human_then_denied', ai: ungrounded.ai.decision,
      aiReasons: ungrounded.ai.reasons, status: ungrounded.status,
    });
  } else {
    steps.push({ step: 'ungrounded_needs_human_then_denied', skipped: 'elevation_empty' });
  }

  // ⑥ 撤回：授权行留着（历史），但读路径立刻关上。
  await service.revokeGrant({ grantId: granted.grant.grantId, actorUserId: SIM_OWNER_USER_ID });
  const afterRevoke = await service.readRaw({ memory, targetTaskId: taskId, ...viewer });
  const grantsIncludingRevoked = await service.listGrants({ targetTaskId: taskId, includeRevoked: true });
  steps.push({
    step: 'revoked_relocks',
    layers: afterRevoke.projection.layers,
    grantRows: grantsIncludingRevoked.length,
    liveGrants: (await service.listGrants({ targetTaskId: taskId })).length,
  });

  const requests = await service.listRequests({ targetTaskId: taskId });
  const audits = (await pool.query(
    `SELECT result_code, count(*)::int AS n FROM cloud_work_memory_access_audits
      WHERE work_scope_id=$1 GROUP BY result_code ORDER BY result_code`, [taskId],
  )).rows;

  // 交叉校验：申请窗口里的每个节点，必须真的是图上的节点。少了这条，
  // 一份"申请了一个不存在的节点"的 TPM 报告看起来也是全绿的。
  let graphCrossLink = 'graph_absent';
  if (graphPresent) {
    const ids = memory.raw.map((item) => item.nodeId).filter(Boolean);
    const found = (await pool.query(
      `SELECT node_id FROM collaboration_graph_nodes WHERE graph_id=$1 AND node_id = ANY($2::text[])`,
      [taskId, ids],
    )).rows.map((row) => row.node_id);
    const missing = ids.filter((id) => !found.includes(id));
    graphCrossLink = missing.length ? `missing:${missing.slice(0, 3).join(',')}` : `ok:${found.length}/${ids.length}`;
  }

  const observations = {
    taskId, briefId: sample.brief_id || '', window, stateReset,
    memory: {
      planNodes: memory.foundation.plan.nodes.length,
      execNodes: memory.foundation.exec.nodes.length,
      elevationAccepted: inspected.accepted, elevationRejected: inspected.rejected,
      rawItems: memory.raw.length,
    },
    steps, graphCrossLink,
    db: {
      requests: requests.length,
      requestStatuses: Object.fromEntries(requests.map((row) => [row.id, row.status])),
      grantsIncludingRevoked: grantsIncludingRevoked.length,
      auditRowsByResultCode: Object.fromEntries(audits.map((row) => [row.result_code, row.n])),
    },
  };

  // 不变式。任何一条不成立就抛 —— 报一个"绿的"TPM 验证比不验证更糟。
  const rawLayers = steps.find((step) => step.step === 'locked_before_request').layers;
  const unlockedIds = [...steps.find((step) => step.step === 'unlocked_after_grant').rawNodeIds].sort();
  const afterRevokeLayers = steps.find((step) => step.step === 'revoked_relocks').layers;
  const failures = [];
  if (rawLayers.includes('raw')) failures.push('raw_visible_before_grant');
  if (granted.status !== 'granted' || granted.ai.decision !== 'pass') failures.push(`clean_request_not_granted:${granted.ai.decision}/${granted.status}`);
  if (!unlocked.projection.layers.includes('raw')) failures.push('raw_locked_after_grant');
  if (JSON.stringify(unlockedIds) !== JSON.stringify([...window].sort())) failures.push(`window_mismatch:${unlockedIds.join(',')}/${[...window].sort().join(',')}`);
  if (steps.find((step) => step.step === 'unlocked_after_grant').maxContentLength > 280) failures.push('excerpt_not_truncated');
  if (noPurpose.status !== 'rejected_by_ai') failures.push(`no_purpose_not_rejected:${noPurpose.status}`);
  if (grantsAfterReject !== 1) failures.push(`rejected_request_created_grant:${grantsAfterReject}`);
  if (ungrounded && ungrounded.ai.decision !== 'need_human') failures.push(`ungrounded_not_need_human:${ungrounded.ai.decision}`);
  if (ungrounded && ungrounded.status !== 'denied_by_owner') failures.push(`ungrounded_not_denied:${ungrounded.status}`);
  if (afterRevoke.projection.layers.includes('raw')) failures.push('revoke_did_not_relock');
  if (grantsIncludingRevoked.length !== 1) failures.push(`revoked_grant_row_lost:${grantsIncludingRevoked.length}`);
  if (!audits.length) failures.push('no_audit_rows');
  if (graphPresent && !String(graphCrossLink).startsWith('ok:')) failures.push(`graph_cross_link:${graphCrossLink}`);
  if (failures.length) throw new Error(`sim_tpm_invariant_failed:${sample.id}:${JSON.stringify(failures)}`);

  return observations;
}

export async function runTpmFlow({
  casesPath = DEFAULT_CASES, briefsPath = DEFAULT_BRIEFS, outPath = DEFAULT_OUT,
  limit = 3, windowSize = DEFAULT_WINDOW, pool: injectedPool = null, quiet = false,
} = {}) {
  if (!existsSync(casesPath)) throw new Error(`sim_tpm_cases_missing:${casesPath}`);
  const cases = readJsonl(casesPath, 'cases');
  const briefs = existsSync(briefsPath) ? readJsonl(briefsPath, 'briefs') : [];
  const byBrief = Object.fromEntries(briefs.map((brief) => [brief.id, brief]));
  const selected = (limit > 0 ? cases.slice(0, limit) : cases);
  if (!selected.length) throw new Error('sim_tpm_no_cases');

  if (!injectedPool && !process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置：TPM 链路要在 remote.env 生效的环境里跑');
  const pool = injectedPool || createPgPool(process.env.DATABASE_URL);
  const service = createTpmAccessService({ pool });
  const observations = [];
  const written = [];
  try {
    await ensureSimUsers(pool);
    for (const sample of selected) {
      const brief = byBrief[sample.brief_id];
      if (!brief) throw new Error(`sim_tpm_brief_not_found:${sample.brief_id}`);
      const taskId = `sim_${sample.graph_id}`.slice(0, 160);
      // 图在就复用。图不在（单独跑 tpm.mjs）就自己写一张 —— 否则交叉校验无从谈起，
      // 而"申请了一个不存在的节点"这种错会静默通过。写图是幂等的（见 store.mjs）。
      const existing = (await pool.query('SELECT 1 AS x FROM collaboration_graphs WHERE id=$1', [taskId])).rowCount > 0;
      let graphSource = 'existing';
      if (!existing) {
        await writeGraph(pool, graphRows({ graph: sample.G_star, graphId: taskId, ownerUserId: SIM_OWNER_USER_ID, taskRunId: taskId }));
        graphSource = 'written_by_tpm';
        written.push(taskId);
      }
      const observed = await exerciseCase({ pool, service, sample, brief, graphPresent: true, windowSize });
      observations.push({ ...observed, graphSource });
      if (!quiet) {
        const granted = observed.steps.find((step) => step.step === 'request_granted');
        const unlocked = observed.steps.find((step) => step.step === 'unlocked_after_grant');
        console.log(`[sim-tpm] ${taskId} 申请=${granted.status} 解锁层=${unlocked.layers.join('+')} `
          + `raw=${unlocked.rawItems}/${observed.memory.rawItems} 审计=${JSON.stringify(observed.db.auditRowsByResultCode)}`);
      }
    }
    const report = {
      schema: 'ubuddy_sim_task_group_v1/tpm',
      requesterUserId: SIM_REQUESTER_USER_ID,
      ownerUserId: SIM_OWNER_USER_ID,
      cases: observations.length,
      // 报告里明确写清楚**什么没做**：memory 本体没有落库，这里落的是访问状态。
      persisted: {
        tables: ['cloud_tpm_raw_access_requests', 'cloud_tpm_raw_access_grants', 'cloud_work_memory_access_audits'],
        memoryBody: 'not_persisted_by_design',
      },
      graphsWrittenByTpm: written,
      observations,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!quiet) console.log(`[sim-tpm] ${report.cases} 个任务的申请链全部成立 -> ${outPath}`);
    return report;
  } finally {
    if (!injectedPool) await pool.end();
  }
}

function parseArgs(argv) {
  const args = { casesPath: DEFAULT_CASES, briefsPath: DEFAULT_BRIEFS, outPath: DEFAULT_OUT, limit: 3, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--cases') args.casesPath = resolve(argv[++i]);
    else if (token === '--briefs') args.briefsPath = resolve(argv[++i]);
    else if (token === '--out') args.outPath = resolve(argv[++i]);
    else if (token === '--limit') args.limit = Number(argv[++i]) || 0;
    else if (token === '--window') args.windowSize = Number(argv[++i]) || DEFAULT_WINDOW;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node experiments/sim_task_group/tpm.mjs [选项]
  --cases <path>   generated.jsonl，缺省 experiments/sim_task_group/out/generated.jsonl
  --briefs <path>  briefs.jsonl
  --out <path>     报告输出，缺省 out/tpm_report.json
  --limit <n>      只跑前 n 条 case（缺省 3）
  --window <n>     每条申请的节点窗口大小（缺省 2）
  --json           报告打到 stdout`);
    process.exit(0);
  }
  runTpmFlow(args)
    .then((report) => {
      if (args.json) console.log(JSON.stringify(report, null, 2));
      console.log('SIM_TPM_OK');
    })
    .catch((error) => {
      console.error(`SIM_TPM_FAILED ${error?.stack || error}`);
      process.exit(1);
    });
}
