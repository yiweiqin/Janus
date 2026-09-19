// 只读报告：真实 janus.db 里影子提案的一致性度量 —— 「能不能开真动作」的判据。
//
// 背景（PLAN_EXEC_TRUTH.zh-CN.md §9）：动作侧今天只做影子。关掉的是执行，
// 留下的是证据：`rdmd_plan_exec_drift` 里的 `shadow.proposal`（提了什么），
// 以及 `rdmd_plan_exec_drift_followup` 里的 `outcome`（现实后来走到了哪一步）。
//
// 这个脚本把那两份证据合成**开真动作的前置条件**：每一类 op 各自的一致性。
// 它只读，不写任何东西 —— 一个会说"可以开了"的工具如果自己会改数据，
// 那它就不是证据工具，而是动作本身。
//
// 用法：
//   node scripts/rdmd_shadow_report.mjs <janus.db>            # 人或机器都读得懂的表
//   node scripts/rdmd_shadow_report.mjs <janus.db> --json     # 原始报告
//
// 退出码：0 = 报告产出成功（**不是**"可以开动作"）；2 = 用法错误；3 = 打不开库。
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { summarizeShadowAgreement } from '../src/main/modules/collaboration/application/planExecDriftService.js';

const DRIFT_EVENT = 'rdmd_plan_exec_drift';
const FOLLOWUP_EVENT = 'rdmd_plan_exec_drift_followup';

/**
 * 从任意 SQLite 句柄（真库或测试用的临时库）算出报告。**只读**：只跑 SELECT。
 *
 * 导出它是为了能测：一个只在命令行跑起来、从没被断言过的"判据工具"，
 * 和没有是一样的 —— 它可能一直在把 unobserved 算进分母。
 */
export function buildShadowReport(db, { dbPath = '', now = () => new Date().toISOString() } = {}) {
  const q = (sql, params = []) => {
    try {
      return db.prepare(sql).all(...params);
    } catch {
      return [];
    }
  };
  const parsePayload = (value) => {
    try {
      const parsed = JSON.parse(value || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  // 提案：能力位开着时写下的记录才有 `shadow.proposal`；没有它的行不是影子数据。
  const proposals = [];
  const opByProposal = new Map();
  for (const row of q(
    `SELECT id, task_run_id, payload_json FROM task_events WHERE event_type = ? ORDER BY created_at ASC`,
    [DRIFT_EVENT],
  )) {
    const payload = parsePayload(row.payload_json);
    const proposal = payload?.shadow?.proposal;
    if (!proposal || !proposal.op) continue;
    // 事件主键：库里是 `id` 列，投影成 eventId 后就是后续事件里 `proposalRef.eventId` 的值。
    const sourceEventId = String(row.id || '');
    const record = {
      sourceEventId,
      taskRunId: String(row.task_run_id || ''),
      graphRevision: Number(payload?.graphRevision || 0),
      op: String(proposal.op || ''),
      nodeId: String(proposal.nodeId || proposal.edgeId || ''),
      fields: Array.isArray(proposal.fields) ? proposal.fields : [],
      target: proposal.target && typeof proposal.target === 'object' ? proposal.target : {},
      score: proposal.score ?? null,
      // 任务族随提案一起读出来（P3）。老记录可能只有顶层 `taskFamily`，再没有就是 null
      // —— null **不计入** `families`，但提案本身照常进分母口径：
      // `observed` 是图的属性，不是族的属性，两件事不能互相顶替。
      taskFamily: proposal.taskFamily || payload?.taskFamily || null,
    };
    proposals.push(record);
    if (record.op) opByProposal.set(sourceEventId, record.op);
  }

  const followUps = [];
  for (const row of q(
    `SELECT task_run_id, payload_json FROM task_events WHERE event_type = ? ORDER BY created_at ASC`,
    [FOLLOWUP_EVENT],
  )) {
    const payload = parsePayload(row.payload_json);
    const proposalEventId = String(payload?.proposalRef?.eventId || '');
    // op 优先取后续自带的（它是提案当时的快照），退化时才去查本次读到的提案表。
    const op = String(payload?.proposalRef?.op || '') || opByProposal.get(proposalEventId) || '';
    followUps.push({ ...payload, op });
  }

  const ops = [...new Set(proposals.map((item) => item.op).filter(Boolean))].sort();
  const ofOp = (list, op) => list.filter((item) => item.op === op);
  const summarize = (list, followUpsOfOp) => summarizeShadowAgreement({
    proposals: list.map((item) => ({ eventId: item.sourceEventId, taskFamily: item.taskFamily })),
    followUps: followUpsOfOp,
  });

  const overall = summarize(proposals, followUps);
  const byOp = Object.fromEntries(ops.map((op) => [op, summarize(ofOp(proposals, op), ofOp(followUps, op))]));

  return {
    db: dbPath,
    generatedAt: now(),
    shadowProposals: proposals.length,
    shadowFollowUps: followUps.length,
    // 影子阶段有没有真的在跑：一条提案都没有，说明能力位还关着（或还没有真实群任务）。
    capabilityObserved: proposals.length > 0,
    overall,
    byOp,
    // 还差多少条观察才有结论。**按 op 给**：总数够了不等于每一类都够。
    remaining: Object.fromEntries(ops.map((op) => [
      op, Math.max(0, Number(overall.minObservations || 0) - Number(byOp[op].observed || 0)),
    ])),
    // 任务族分区（P3）：先建起来，等"跨图节点身份"解决后就能按族汇总而不必回填历史。
    // `degenerateFamilyProposals` 是 anchor 落到单条 run 上的提案数 —— 它们**结构上**
    // 不可能收敛，报告必须把它们单独说出来，否则"提案数在涨"会被读成"样本在积累"。
    families: overall.families,
    familyIds: overall.familyIds,
    degenerateFamilyProposals: overall.degenerateFamilyProposals,
    // 分母口径随报告一起给出，让读的人（和测试）不必去猜它用的是哪个数。
    denominator: overall.denominator,
    denominatorNote: overall.denominatorNote,
  };
}

const pct = (value) => (value === null || value === undefined ? '  n/a' : `${(Number(value) * 100).toFixed(1)}%`);
const line = (op, s) => `${op.padEnd(20)} ${String(s.proposals).padStart(4)} ${String(s.observed).padStart(4)} `
  + `${String(s.unobserved).padStart(4)} ${String(s.carriedOut).padStart(4)} ${pct(s.agreementRate).padStart(7)} `
  + `${s.sampleSufficient ? ' 是' : ' 否'}`;

export function renderShadowReport(report) {
  const ops = Object.keys(report.byOp);
  const lines = [
    `影子一致性报告（只读） ${report.db}`,
    `生成时间 ${report.generatedAt}`,
    '',
    `影子提案 ${report.shadowProposals} 条，后续观察 ${report.shadowFollowUps} 条。`,
    // 分母说在表格**之前**：读错分母是这类度量最贵的错，而"12 条提案、1 条命中"配上
    // 一个没写清的分母，可以读成 8% 也可以读成 100%。
    `一致率的分母是**已观察**（observed=${report.overall.observed}），不是提案数：`,
    '  未观察到后续（图不再变，产品里是常态）既不算同意也不算反对。',
  ];
  if (!report.capabilityObserved) {
    lines.push('', '没有任何影子提案 —— 能力位 `ubuddy_plan_exec_drift_apply` 还没开过，',
      '或者还没有真实群任务跑完。这时候"开真动作"无从谈起。');
  }
  lines.push('', 'op                  提案  已观察  未观察  命中   一致率  样本够', line('(全部)', report.overall));
  for (const op of ops) lines.push(line(op, report.byOp[op]));
  // 族分区：`families` 是族数，`degenerate` 是"anchor 落到单条 run"的提案数。
  lines.push('', `任务族：${report.families} 个族；其中**结构上无法收敛**的提案（anchor 只有单条 run）`
    + ` ${report.degenerateFamilyProposals} 条。`);
  lines.push('  说明：今天的后续观察只能在**同一张协作图**里做 —— `nodeId` 是图内标识，',
    '  跨图比较节点 id 没有意义。所以"下一个**同类任务**是否采纳"这件事，',
    '  在拿到跨图节点身份之前无法被诚实度量；族先记下来是为了那时不必回填历史。');
  lines.push('', `开真动作的判据（**两道门**，缺一不可）：能力位开着，且 \`shadowApplyGate\` 通过 ——`,
    `每一类 op 已观察 ≥ ${report.overall.minObservations} 条，且一致率 ≥ 阈值。`);
  const pending = Object.entries(report.remaining).filter(([, need]) => need > 0);
  if (pending.length) {
    lines.push('还差：');
    for (const [op, need] of pending) lines.push(`  ${op}：还差 ${need} 条已观察`);
  } else if (!report.capabilityObserved) {
    lines.push('还没开始累积 —— 先开能力位、跑真实群任务。');
  } else if (ops.length) {
    lines.push('各类 op 的样本量都够了 —— 现在可以**开始看**一致率，注意这仍然不是自动开动作。');
  }
  lines.push('', '注意：本脚本只读；它不会、也不该打开真动作。升到 apply 由 `resolveDriftPhase`',
    '在**能力位 + 度量门**同时满足时决定（见 RDMD_ACTION_PHASES），这是一次显式的代码改动',
    '加一次显式的复审，不是这里的一个开关。');
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const dbPath = argv.find((arg) => !arg.startsWith('--'));
  if (!dbPath) {
    console.error('usage: node scripts/rdmd_shadow_report.mjs <janus.db> [--json]');
    process.exit(2);
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    console.error(`打不开数据库（只读）：${dbPath}\n${error?.message || error}`);
    process.exit(3);
  }
  try {
    const report = buildShadowReport(db, { dbPath });
    console.log(jsonMode ? JSON.stringify(report, null, 2) : renderShadowReport(report));
  } finally {
    db.close();
  }
}

// 只在作为 CLI 直接运行时才执行；被 import 时（测试）什么都不做。
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
