// 回收端：轮询作业终态 → 算指标 → 出动作分布与影子提案。
//
// ---------------------------------------------------------------------------
// 这一层要回答的三个问题，以及它们各自**容易在哪里骗自己**
// ---------------------------------------------------------------------------
//
// 1. **模型找到真凶了吗？**（定位 / 类型）
//    骗自己的方式：只对"成功返回的"算准确率。作业会失败、会超时、会 `UNKNOWN`，
//    把它们踢出分母会让准确率凭空好看。所以这里**分母是全部预期作业**，
//    没到终态的单独列成 `notTerminal`，宁可难看也不要虚高。
//
// 2. **本地规则基线是不是就够了？**（`detectMinimalDrift`）
//    同一批 case 也过一遍纯规则侦探。模型如果赢不过"上下游对比 + 唯一根因"，
//    那这套训练就没证明价值 —— 而 `UNKNOWN` 率差异是最容易看出问题的指标：
//    规则的上限就是"唯一根因"那些 case。
//
// 3. **归因准了，该做的改动是什么？**（`routeEvolution` + 影子提案）
//    `routeEvolution` 把判定翻成动作（record_only / minimal_plan_edit / similar_swap）。
//    影子提案是**本地算、绝不应用**的：`minimalPlanEdits(G_star, G_prime)` 给出
//    "改一处就能让规划靠近现实"的那一处，再用 `reachesProximity` 判它够不够。
//    「改一处即停」是防过拟合的机制（无限靠拢 = 把这一次的现实当普遍规律），
//    所以这里报的是「够不够」，不是「像不像」。
//
// ---------------------------------------------------------------------------
// 一个必须说清楚的口径问题：模拟任务群的 `no_drift` 是**造出来的**
// ---------------------------------------------------------------------------
//
// `G_prime` 是 LLM/本地教师沿着 `G_star` 推演出来的，就算没有注入漂移，也**不会**
// 与 `G_star` 逐字节相等。所以本地规则侦探在同一批 `no_drift` case 上会报出一堆
// drift —— 那不是 bug，是"规则把正常的推演细化当成了漂移"。
// 这个数字本身有诊断价值（它量化了"没有反侦探模型时误报会有多高"），
// 所以这里**照实报**，并在报告里标明它来自模拟数据、不能等同于真实任务上的误报率。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { get } from '../../scripts/rdmd_cloud_e2e.mjs';
import {
  detectMinimalDrift,
  minimalPlanEdits,
  reachesProximity,
  routeEvolution,
} from '../../src/shared/contracts/uBuddyReverseDetective.js';

export const COLLECT_SCHEMA = 'ubuddy_sim_task_group_v1/collect';
export const DEFAULT_CASES = resolve('experiments/sim_task_group/out/generated.jsonl');
export const DEFAULT_JOBS = resolve('experiments/sim_task_group/out/jobs.jsonl');
export const DEFAULT_OUT = resolve('experiments/sim_task_group/out');

const TERMINAL = new Set(['completed', 'unavailable', 'failed_terminal']);

function readJsonl(path, label) {
  if (!existsSync(path)) return [];
  const rows = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${label}:${index + 1} 不是合法 JSON（${error.message}）`);
    }
  }
  return rows;
}

const bump = (map, key, by = 1) => { map[key] = (map[key] || 0) + by; };

/** 真凶所在的层。`step` 与 `task` 的可分性差很多，混在一起看会被平均值盖掉。 */
export function tierOf(caseValue) {
  const gold = caseValue?.label || {};
  const nodeId = gold.injected_node || '';
  const node = (caseValue?.G_star?.nodes || []).find((item) => item.id === nodeId);
  if (!node) return 'none';
  return node.kind === 'agent_step' ? 'agent_step' : (node.kind === 'agent_task' ? 'agent_task' : node.kind || 'unknown');
}

/**
 * 把一条「真值 + 模型判定」算成一行可聚合的结果。
 *
 * `nodeTop1` / `typeTop1` 分开算，因为它们的失败含义不同：
 * 定位对了类型错了 = 找到了人但误判了手法（改动会打偏）；
 * 定位错了类型对了 = 手法认对了但指错了人（**更危险**，因为动作看起来是对的）。
 *
 * `tier` / `visibility` / `hop` 三个**难度轴**带在行上，不在这里聚合：
 * 层与层、隐约与明显之间的可分性差很多，混在一起看会被平均值盖掉。
 */
export function scoreCase({ gold = {}, verdict = null, status = '', context = {} } = {}) {
  const injectedNode = gold.injected_node || '';
  const injectedType = gold.injected_type || '';
  const goldStatus = gold.status || '';
  const row = {
    goldStatus,
    goldNode: injectedNode,
    goldType: injectedType,
    jobStatus: status,
    verdictStatus: verdict?.status || '',
    verdictNode: verdict?.nodeId || '',
    verdictType: verdict?.type || '',
    verdictReason: verdict?.reason || '',
    tier: context.tier || 'unknown',
    visibility: context.visibility || 'unknown',
    hop: Number.isFinite(Number(gold.hop_to_first_effect)) ? Number(gold.hop_to_first_effect) : null,
  };
  if (goldStatus === 'no_drift') {
    row.correct = verdict?.status === 'no_drift';
    row.kind = 'no_drift';
    // 误报：真值是"没漂移"而模型报出了漂移。
    row.falsePositive = verdict?.status === 'drift';
    return row;
  }
  if (goldStatus === 'UNKNOWN') {
    // 双注入。语料口径是 `UNKNOWN`，所以"报出一次具体漂移"不是命中 ——
    // 两条都注入了，报其中一条会让改动只修一半，比弃权更糟。
    row.correct = verdict?.status === 'UNKNOWN';
    row.kind = 'multi_inject';
    row.falsePositive = false;
    return row;
  }
  const abstained = verdict?.status === 'UNKNOWN';
  const nodeHit = Boolean(injectedNode) && row.verdictNode === injectedNode;
  const typeHit = Boolean(injectedType) && row.verdictType === injectedType;
  row.abstained = abstained;
  row.nodeTop1 = nodeHit;
  row.typeTop1 = typeHit;
  row.edgeTop1 = gold.injected_edge
    ? verdict?.edgeId === gold.injected_edge
    : null;
  row.correct = nodeHit && typeHit;
  row.kind = 'drift';
  // 误报：这类 case 真的有漂移，所以"报错人/错类型"算**错**，不算误报。
  row.falsePositive = false;
  // 定位错但类型对，单独标记：动作会指向一个无辜的 agent。
  row.rightTypeWrongNode = typeHit && !nodeHit;
  return row;
}

/** 本地规则侦探在同一批 case 上的答案，用来给模型划一条基线。 */
export function baselineCase(caseValue) {
  const gold = caseValue?.label || {};
  const detective = detectMinimalDrift(caseValue?.G_star || {}, caseValue?.G_prime || {});
  return scoreCase({ gold, verdict: detective, status: 'local_baseline', context: contextOf(caseValue) });
}

/** 难度轴：真凶在哪一层、注入是否"隐约"、效果隔了几跳。 */
export function contextOf(caseValue) {
  return {
    tier: tierOf(caseValue),
    visibility: caseValue?.visibility || 'unknown',
    hop: caseValue?.label?.hop_to_first_effect,
  };
}

/**
 * 「影子提案」：本地算出"改一处就够"的那一处，**只算不用**。
 *
 * ---------------------------------------------------------------------------
 * 实测发现（必须原样报出来，别粉饰）：在模拟数据上这条度量是**空的**
 * ---------------------------------------------------------------------------
 *
 * 阈值 0.8（`RDMD_PROXIMITY_DEFAULTS.threshold`），而实测相近度落在 **0.936–1.000**：
 * 一个节点被注入，在 ~32 节点 × 每节点 0.5/32 权重的图上只占约 3–5% 的加权质量，
 * 所以 `G_star` 与 `G_prime` **本来就已经"够近"**，`minimalPlanEdits` 直接返回
 * `alreadySatisfied: true`、`minimal: null`、`edits: []`。
 *
 * 结论：**0.8 这个阈值是为真实 G_plan/G_exec 的漂移量标定的，不是为单点注入标的。**
 * 在单点注入的样本上，"改一处即停"这条机制根本不会被触发，因此
 * 「影子提案」在当前数据上**测不出东西**。报告照实给 `alreadySatisfiedRate`，
 * 不要把它读成"每次都已经完美"。
 */
export function shadowFor(caseValue) {
  const plan = caseValue?.G_star || {};
  const exec = caseValue?.G_prime || {};
  const proposal = minimalPlanEdits(plan, exec, { limit: 24 });
  const proximity = reachesProximity(plan, exec);
  return {
    reached: proposal.reached,
    alreadySatisfied: proposal.alreadySatisfied === true,
    threshold: proposal.threshold,
    proximity: Number(proximity.proximity?.score?.toFixed?.(4) ?? proximity.proximity?.score ?? 0),
    op: proposal.minimal?.edit?.op || '',
    nodeId: proposal.minimal?.edit?.nodeId || '',
    evaluated: proposal.evaluated,
    candidateCount: proposal.edits.length,
  };
}

/**
 * 规则基线的**归因失败分解**。为什么单看一个准确率不够：
 *
 * 实测 18 条 drift 样本上，规则侦探 **0/18** 命中，而把 decoy 摘掉后是 **12/18**。
 * 两种失败机制混在同一个数字里，含义完全不同：
 *
 * - **decoy 抬出多余根因**：`contrastDriftGraphs` 把新节点算作"涉及"，而 decoy 没有
 *   涉及集内的祖先 → 根因不唯一 → `UNKNOWN`。这是**语料装置**造成的，真实投影图里
 *   没有 decoy，所以生产环境不会遇到。
 * - **`subtle` 抹掉字段**：`inferDownstream` 在 subtle 模式下把真凶的
 *   `title/agentId/version/acceptance` 抹回原值（step 层除外，见其注释），而
 *   `contrastDriftGraphs` **只比这四个字段**、不读富文本 → 真凶在规则眼里与
 *   无辜节点无法区分。
 *
 * 拆开报的理由：前者**不该**算进"规则基线有多差"（生产里没有 decoy），后者**才是**
 * 模型的用武之地。把两者混成一个 0/18，会既高估模型的必要性又低估规则的真实水平。
 */
export function baselineDiagnostics(caseValue) {
  const gold = caseValue?.label?.injected_node || '';
  const base = { tier: tierOf(caseValue), visibility: caseValue?.visibility || 'unknown' };
  if (!gold) return { ...base, kind: caseValue?.label?.status || '', ruleHit: null, noDecoyHit: null, fieldsWiped: null };
  const fields = ['title', 'agentId', 'version', 'acceptance'];
  const starNode = (caseValue?.G_star?.nodes || []).find((node) => node.id === gold);
  const primeNode = (caseValue?.G_prime?.nodes || []).find((node) => node.id === gold);
  const fieldsWiped = Boolean(starNode && primeNode)
    && fields.every((field) => String(starNode[field] ?? '') === String(primeNode[field] ?? ''));
  const decoys = new Set(caseValue?.label?.decoy_nodes || []);
  const stripped = {
    nodes: (caseValue?.G_prime?.nodes || []).filter((node) => !decoys.has(node.id)),
    edges: (caseValue?.G_prime?.edges || []).filter((edge) => !decoys.has(edge.from) && !decoys.has(edge.to)),
  };
  return {
    ...base,
    kind: caseValue?.label?.status || '',
    goldType: caseValue?.label?.injected_type || '',
    ruleHit: detectMinimalDrift(caseValue?.G_star || {}, caseValue?.G_prime || {}).nodeId === gold,
    noDecoyHit: detectMinimalDrift(caseValue?.G_star || {}, stripped).nodeId === gold,
    fieldsWiped,
  };
}

/**
 * 把逐条结果聚合成报告。
 *
 * **分母口径写死在输出里**：`expected` 是全部预期作业，`scored` 是拿到终态的，
 * 两者不等时报告里会有 `notTerminal`，不允许把没回来的悄悄丢掉。
 */
export function summarize({ rows = [], baseline = [], shadow = [], diagnostics = [], expected = 0 } = {}) {
  const drift = rows.filter((row) => row.kind === 'drift');
  const noDrift = rows.filter((row) => row.kind === 'no_drift');
  const multi = rows.filter((row) => row.kind === 'multi_inject');
  const notTerminal = rows.filter((row) => !TERMINAL.has(row.jobStatus)).length;
  // 采集端自己掉线（token 过期/被拒）单独计数并在报告里现形：它会让**整批**都变成
  // 非终态，是最像"模型不行"的一种管线故障。放在顶层，谁读报告都不会漏掉。
  const authRejected = rows.filter((row) => row.jobStatus === 'auth_rejected').length;

  const rate = (numerator, denominator) => (denominator ? Number((numerator / denominator).toFixed(4)) : null);
  const countBy = (list, fn) => list.filter(fn).length;

  const diagDrift = diagnostics.filter((row) => row.kind === 'drift');
  const subtleDrift = diagDrift.filter((row) => row.visibility === 'subtle');

  const byGroup = (list, keyFn) => {
    const groups = {};
    for (const row of list) {
      const key = keyFn(row) || 'unknown';
      groups[key] = groups[key] || { n: 0, correct: 0, nodeTop1: 0, typeTop1: 0, abstained: 0 };
      const bucket = groups[key];
      bucket.n += 1;
      if (row.correct) bucket.correct += 1;
      if (row.nodeTop1) bucket.nodeTop1 += 1;
      if (row.typeTop1) bucket.typeTop1 += 1;
      if (row.abstained) bucket.abstained += 1;
    }
    for (const bucket of Object.values(groups)) {
      bucket.correctRate = rate(bucket.correct, bucket.n);
      bucket.nodeTop1Rate = rate(bucket.nodeTop1, bucket.n);
      bucket.typeTop1Rate = rate(bucket.typeTop1, bucket.n);
      bucket.abstainRate = rate(bucket.abstained, bucket.n);
    }
    return groups;
  };

  const actionOf = (list) => {
    const actions = {};
    const reasons = {};
    for (const row of list) {
      const route = routeEvolution(
        { status: row.verdictStatus, type: row.verdictType },
        { decision: 'pending' },
      );
      bump(actions, route.action);
      bump(reasons, route.reason);
    }
    return { actions, reasons };
  };

  return {
    schema: `${COLLECT_SCHEMA}/report`,
    expected,
    scored: rows.length,
    // 分母不相等**必须留在报告里**：不能让"没回来的作业"看起来像"对了的作业"。
    notTerminal,
    // 非零就说明这一轮的"未终态"是采集端掉线造成的，不是作业或模型的问题。
    authRejected,
    driftCases: drift.length,
    noDriftCases: noDrift.length,
    multiInjectCases: multi.length,
    model: {
      nodeTop1Rate: rate(countBy(drift, (row) => row.nodeTop1), drift.length),
      typeTop1Rate: rate(countBy(drift, (row) => row.typeTop1), drift.length),
      bothRate: rate(countBy(drift, (row) => row.correct), drift.length),
      edgeTop1Rate: rate(countBy(drift, (row) => row.edgeTop1 === true),
        drift.filter((row) => row.edgeTop1 !== null).length),
      abstainRate: rate(countBy(drift, (row) => row.abstained), drift.length),
      // 最危险的一类错误：动作看起来对（类型对）但指向无辜的人。
      rightTypeWrongNodeRate: rate(countBy(drift, (row) => row.rightTypeWrongNode), drift.length),
      noDriftAccuracy: rate(countBy(noDrift, (row) => row.correct), noDrift.length),
      noDriftFalsePositiveRate: rate(countBy(noDrift, (row) => row.falsePositive), noDrift.length),
      multiInjectAbstainRate: rate(countBy(multi, (row) => row.correct), multi.length),
    },
    baseline: {
      nodeTop1Rate: rate(countBy(baseline.filter((row) => row.kind === 'drift'), (row) => row.nodeTop1),
        baseline.filter((row) => row.kind === 'drift').length),
      typeTop1Rate: rate(countBy(baseline.filter((row) => row.kind === 'drift'), (row) => row.typeTop1),
        baseline.filter((row) => row.kind === 'drift').length),
      abstainRate: rate(
        countBy(baseline.filter((row) => row.kind === 'drift'), (row) => row.abstained),
        baseline.filter((row) => row.kind === 'drift').length,
      ),
      noDriftFalsePositiveRate: rate(
        countBy(baseline.filter((row) => row.kind === 'no_drift'), (row) => row.falsePositive),
        baseline.filter((row) => row.kind === 'no_drift').length,
      ),
      multiInjectAbstainRate: rate(
        countBy(baseline.filter((row) => row.kind === 'multi_inject'), (row) => row.correct),
        baseline.filter((row) => row.kind === 'multi_inject').length,
      ),
      note: '规则侦探（detectMinimalDrift）在同一批 case 上。它的上限就是"唯一根因"那些 case，'
        + '所以在 step 层与 subtle 层会明显掉 —— 那正是模型该赢的地方。',
    },
    byGoldType: byGroup(drift, (row) => row.goldType),
    // 难度轴分组。**层与层之间的差距是最该看的数**：`agent_step` 的真凶只在链上、
    // 可分的证据比 `agent_task` 少得多，混在一起看会被 task 层的高分盖掉。
    byTier: byGroup(drift, (row) => row.tier),
    byVisibility: byGroup(drift, (row) => row.visibility),
    byHop: byGroup(drift, (row) => (row.hop === null ? 'n/a' : String(row.hop))),
    baselineByTier: byGroup(baseline.filter((row) => row.kind === 'drift'), (row) => row.tier),
    baselineByVisibility: byGroup(baseline.filter((row) => row.kind === 'drift'), (row) => row.visibility),
    byJobStatus: (() => {
      const groups = {};
      for (const row of rows) bump(groups, row.jobStatus || 'none');
      return groups;
    })(),
    actions: {
      model: actionOf(rows),
      baseline: actionOf(baseline),
    },
    shadow: {
      cases: shadow.length,
      reachedRate: rate(countBy(shadow, (row) => row.reached), shadow.length),
      alreadySatisfied: countBy(shadow, (row) => row.alreadySatisfied),
      alreadySatisfiedRate: rate(countBy(shadow, (row) => row.alreadySatisfied), shadow.length),
      opDistribution: shadow.reduce((acc, row) => {
        bump(acc, row.op || 'none');
        return acc;
      }, {}),
      note: '影子提案是本地算的、**绝不应用**。「改一处即停」是防过拟合：'
        + '无限向执行图靠拢等于把这一次的现实当成普遍规律。',
    },
    baselineDiagnostics: {
      driftCases: diagDrift.length,
      // 两个数字必须并列：一个是"语料难度"，一个是"生产里规则的真实水平"。
      ruleHitWithDecoys: rate(countBy(diagDrift, (row) => row.ruleHit), diagDrift.length),
      ruleHitWithoutDecoys: rate(countBy(diagDrift, (row) => row.noDecoyHit), diagDrift.length),
      // 摘掉 decoy 也救不回来的那部分：`subtle` 抹掉了规则唯一会读的四个字段。
      unreachableEvenWithoutDecoys: countBy(diagDrift, (row) => !row.noDecoyHit),
      ofWhichSubtle: countBy(diagDrift.filter((row) => !row.noDecoyHit), (row) => row.visibility === 'subtle'),
      subtleDriftCases: subtleDrift.length,
      subtleFieldsWipedRate: rate(countBy(subtleDrift, (row) => row.fieldsWiped), subtleDrift.length),
      note: '`ruleHitWithDecoys` 衡量的是**语料任务难度**（decoy 是训练装置，真实投影图里没有）；'
        + '`ruleHitWithoutDecoys` 更接近规则在生产里的水平。两个数一起看才知道模型的提升'
        + '有多少来自"抗 decoy"、多少来自"读富文本"。',
    },
    caveats: [
      // 这一条是被数据推翻后重写的。原来的说法（"no_drift 也会被推演改动，所以规则会误报"）
      // 是我想当然：实测 `G_prime` 在 no_drift 上与 `G_star` **逐字节相等**，
      // 所以 no_drift 是**平凡可分**的。
      '`no_drift` 样本的 `G_prime` 与 `G_star` 逐字节相等（实测），因此它的正确率是'
        + '**平凡可分**的：任何"永远说没漂移"的判定都能拿满分。这个数字**不能**当作'
        + '模型能力的证据，只能当作"链路没坏"的烟雾测试。',
      '相近度阈值 0.8 是为真实漂移量标定的；单点注入只占约 3–5% 加权质量，'
        + '所以 `minimalPlanEdits` 恒报 `alreadySatisfied`，「影子提案」在当前数据上测不出东西。',
      '模拟任务群出的判定不是真实用户任务，只证明链路成立与量级可比。',
    ],
  };
}

/** 轮询一条作业到终态。超时不抛错，把状态照原样带回去（分母里要看得见）。 */
export async function pollJob(jobId, { token, grant, timeoutMs = 10 * 60 * 1000, intervalMs = 2000 } = {}) {
  const startedAt = Date.now();
  let last = { status: 0, body: null };
  while (Date.now() - startedAt < timeoutMs) {
    last = await get(`/api/rdmd/jobs/${jobId}`, { token, grant });
    if (last.status === 401 || last.status === 403) {
      // **单独一类，不并进 `http_error`。** 401/403 与"这条作业有问题"是两件事：
      // 它是**我们的 token 过期了**，而这会一次性命中后面每一条，直到有人重签。
      // 混进通用 http_error 的后果是报告里一大堆 notTerminal，看起来像"模型/作业不行"，
      // 而真相是采集端自己掉线了。整批采集的时长由队列长度决定（实测 1300 条约 4 小时），
      // 而 run_remote.sh 里的 token TTL 是分钟级的 —— 这个不匹配就是本条存在的理由。
      return { status: 'auth_rejected', httpStatus: last.status, verdict: null, errorCode: 'access_token_rejected' };
    }
    if (last.status !== 200) {
      return { status: 'http_error', httpStatus: last.status, verdict: null, errorCode: last.body?.error || '' };
    }
    if (TERMINAL.has(last.body?.status)) {
      return {
        status: last.body.status,
        httpStatus: 200,
        verdict: last.body.verdict || null,
        errorCode: last.body.errorCode || '',
      };
    }
    await new Promise((wake) => setTimeout(wake, intervalMs));
  }
  return { status: 'poll_timeout', httpStatus: last.status, verdict: last.body?.verdict || null, errorCode: '' };
}

export async function collect({
  casesPath = DEFAULT_CASES, jobsPath = DEFAULT_JOBS, outDir = DEFAULT_OUT,
  token = '', grant = '', timeoutMs = 10 * 60 * 1000, intervalMs = 2000,
} = {}) {
  const cases = readJsonl(casesPath, 'cases');
  const jobs = readJsonl(jobsPath, 'jobs');
  const caseById = new Map(cases.map((item) => [item.id, item]));

  // `jobs.jsonl` 是提交端的账。对不上就是不完整，必须报，不能补。
  const missingJobs = jobs.filter((job) => !caseById.has(job.caseId));
  const jobsByCase = new Map(jobs.map((job) => [job.caseId, job]));

  const rows = [];
  const baseline = [];
  const shadow = [];
  const diagnostics = [];
  const results = [];
  for (const caseValue of cases) {
    const context = contextOf(caseValue);
    baseline.push(baselineCase(caseValue));
    shadow.push({ caseId: caseValue.id, ...shadowFor(caseValue) });
    diagnostics.push({ caseId: caseValue.id, ...baselineDiagnostics(caseValue) });
    const job = jobsByCase.get(caseValue.id);
    if (!job) {
      // **不跳过**：没提交的 case 是"没量到"，用 `not_submitted` 进分母。
      rows.push(scoreCase({ gold: caseValue.label, verdict: null, status: 'not_submitted', context }));
      results.push({ caseId: caseValue.id, jobId: '', status: 'not_submitted', errorCode: '' });
      continue;
    }
    const polled = await pollJob(job.jobId, { token, grant, timeoutMs, intervalMs });
    rows.push(scoreCase({ gold: caseValue.label, verdict: polled.verdict, status: polled.status, context }));
    results.push({
      caseId: caseValue.id, jobId: job.jobId, status: polled.status,
      errorCode: polled.errorCode, verdict: polled.verdict,
    });
  }

  const report = {
    ...summarize({ rows, baseline, shadow, diagnostics, expected: cases.length }),
    // 提交端有、生成端没有的记录 = 账对不上，必须报出来。
    orphanJobs: missingJobs.length,
  };
  return { report, rows, baseline, shadow, diagnostics, results, cases, jobs };
}

export function writeReport(outDir, { report, rows, results }) {
  mkdirSync(outDir, { recursive: true });
  const files = {
    report: resolve(outDir, 'collect_report.json'),
    verdicts: resolve(outDir, 'verdicts.jsonl'),
    rows: resolve(outDir, 'collect_rows.jsonl'),
  };
  writeFileSync(files.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(files.verdicts, `${results.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  writeFileSync(files.rows, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return files;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { json: false, cases: DEFAULT_CASES, jobs: DEFAULT_JOBS, out: DEFAULT_OUT, token: '', grant: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') args.json = true;
    else if (flag === '--cases') args.cases = resolve(argv[++index]);
    else if (flag === '--jobs') args.jobs = resolve(argv[++index]);
    else if (flag === '--out') args.out = resolve(argv[++index]);
    else if (flag === '--token') args.token = argv[++index];
    else if (flag === '--grant') args.grant = argv[++index];
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs();
  collect(args).then(({ report, rows, results }) => {
    // 落盘（`out/collect_report.json` 等）—— 盒子上的 runner 靠这些文件回收，
    // 所以这一步必须在 CLI 里，不能只让调用方自己写。
    const files = writeReport(args.out, { report, rows, results });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    process.stdout.write(`[collect] 报告 -> ${files.report}\n`);
    process.stdout.write(`[collect] 预期 ${report.expected} / 计分 ${report.scored}（未终态 ${report.notTerminal}）\n`);
    process.stdout.write(`[collect] 定位 ${report.model.nodeTop1Rate} 类型 ${report.model.typeTop1Rate} `
      + `弃权 ${report.model.abstainRate} 误报 ${report.model.noDriftFalsePositiveRate}\n`);
  }).catch((error) => {
    process.stderr.write(`[collect] ${error.message}\n`);
    process.exitCode = 1;
  });
}
