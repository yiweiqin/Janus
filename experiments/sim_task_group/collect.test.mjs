// `collect.mjs` 的回归测试。
//
// 这一层最容易出的错不是崩溃，而是**悄悄把难看的结果剔出分母**。
// 所以下面每个"算得对"的断言，都配了一个"算错时必须看得出"的负对照。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baselineCase, baselineDiagnostics, collect, contextOf, parseArgs, scoreCase, shadowFor, summarize, tierOf,
} from './collect.mjs';
import { buildBriefs } from './lib/protocol.mjs';
import { generate } from './simulate.mjs';

const BRIEFS = buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 2 });
let cached = null;
const world = async () => {
  if (!cached) cached = await generate({ briefs: BRIEFS, mode: 'offline' });
  return cached;
};

const sampleOf = async (kind) => {
  const result = await world();
  const found = result.cases.find((item) => item.generator_id === `sim_task_group_${kind}_v1`);
  assert.ok(found, `没有 ${kind} 的样例`);
  return found;
};

test('a hit needs both the node and the type, and the two are reported apart', () => {
  const gold = { status: 'drift', injected_node: 'n1', injected_type: 'wrong_agent' };
  const both = scoreCase({ gold, verdict: { status: 'drift', nodeId: 'n1', type: 'wrong_agent' }, status: 'completed' });
  assert.equal(both.correct, true);
  assert.equal(both.rightTypeWrongNode, false);

  // 定位对、类型错：动作会打偏。
  const wrongType = scoreCase({ gold, verdict: { status: 'drift', nodeId: 'n1', type: 'wrong_version' }, status: 'completed' });
  assert.equal(wrongType.correct, false);
  assert.equal(wrongType.nodeTop1, true);
  assert.equal(wrongType.typeTop1, false);
  assert.equal(wrongType.rightTypeWrongNode, false);

  // 定位错、类型对：**最危险的一类** —— 动作看起来是对的，但指向无辜的人。
  const wrongNode = scoreCase({ gold, verdict: { status: 'drift', nodeId: 'n9', type: 'wrong_agent' }, status: 'completed' });
  assert.equal(wrongNode.correct, false);
  assert.equal(wrongNode.rightTypeWrongNode, true);
});

test('abstaining on a real drift is not a hit, and it is counted apart from being wrong', () => {
  const gold = { status: 'drift', injected_node: 'n1', injected_type: 'wrong_agent' };
  const row = scoreCase({ gold, verdict: { status: 'UNKNOWN', nodeId: '', type: '' }, status: 'completed' });
  assert.equal(row.correct, false);
  assert.equal(row.abstained, true);
  assert.equal(row.falsePositive, false);
});

test('a drift verdict on a no_drift case is a false positive, and abstaining there is not', () => {
  const gold = { status: 'no_drift' };
  const fp = scoreCase({ gold, verdict: { status: 'drift', nodeId: 'n1', type: 'wrong_agent' }, status: 'completed' });
  assert.equal(fp.falsePositive, true);
  assert.equal(fp.correct, false);

  const clean = scoreCase({ gold, verdict: { status: 'no_drift' }, status: 'completed' });
  assert.equal(clean.correct, true);
  assert.equal(clean.falsePositive, false);

  // 在 no_drift 上弃权**不算误报**（没指着谁），但也不算命中。
  const abstained = scoreCase({ gold, verdict: { status: 'UNKNOWN' }, status: 'completed' });
  assert.equal(abstained.falsePositive, false);
  assert.equal(abstained.correct, false);
});

test('naming one of two injected culprits on a multi-inject case is not a hit', () => {
  // 语料口径是 `UNKNOWN`：报其中一条会让改动只修一半，比弃权更糟。
  const gold = { status: 'UNKNOWN', injected_nodes: ['a', 'b'] };
  const half = scoreCase({ gold, verdict: { status: 'drift', nodeId: 'a', type: 'wrong_agent' }, status: 'completed' });
  assert.equal(half.correct, false);
  const full = scoreCase({ gold, verdict: { status: 'UNKNOWN' }, status: 'completed' });
  assert.equal(full.correct, true);
});

test('a job that never reached a terminal state stays in the denominator', () => {
  const rows = [
    scoreCase({ gold: { status: 'drift', injected_node: 'n1', injected_type: 'wrong_agent' }, verdict: { status: 'drift', nodeId: 'n1', type: 'wrong_agent' }, status: 'completed' }),
    scoreCase({ gold: { status: 'drift', injected_node: 'n2', injected_type: 'wrong_agent' }, verdict: null, status: 'poll_timeout' }),
    scoreCase({ gold: { status: 'drift', injected_node: 'n3', injected_type: 'wrong_agent' }, verdict: null, status: 'not_submitted' }),
  ];
  const report = summarize({ rows, baseline: [], shadow: [], expected: 3 });
  assert.equal(report.scored, 3);
  assert.equal(report.notTerminal, 2);
  // 1/3 而不是 1/1 —— 这就是这条测试要守的东西。
  assert.equal(report.model.bothRate, Number((1 / 3).toFixed(4)));
});

test('expected and scored are both reported, so a partial run cannot look complete', () => {
  const report = summarize({ rows: [], baseline: [], shadow: [], expected: 22 });
  assert.equal(report.expected, 22);
  assert.equal(report.scored, 0);
  assert.equal(report.model.bothRate, null, '没有分母时不能报 0，0 会被当成"准确率很低"');
});

test('the tier of the culprit is read off the real graph, not inferred from the plan', async () => {
  const stepCase = await sampleOf('wrong_agent_step');
  assert.equal(tierOf(stepCase), 'agent_step');
  const taskCase = await sampleOf('wrong_agent');
  assert.equal(tierOf(taskCase), 'agent_task');
  // 没有真凶的 case（no_drift）要报 none，不能猜一个层。
  const noDrift = await sampleOf('no_drift');
  assert.equal(tierOf(noDrift), 'none');
});

test('the report splits by tier and by visibility, because the average hides both', async () => {
  const result = await world();
  const rows = result.cases.map((item) => scoreCase({
    gold: item.label,
    // 故意让 step 层全错、task 层全对：如果报告只给总平均，这个差别就看不见。
    verdict: tierOf(item) === 'agent_step'
      ? { status: 'UNKNOWN' }
      : { status: item.label.status === 'no_drift' ? 'no_drift' : 'drift', nodeId: item.label.injected_node, type: item.label.injected_type },
    status: 'completed',
    context: contextOf(item),
  }));
  const report = summarize({ rows, baseline: [], shadow: [], expected: rows.length });
  assert.equal(report.byTier.agent_step.nodeTop1Rate, 0);
  assert.equal(report.byTier.agent_task.nodeTop1Rate, 1);
  assert.ok(report.model.nodeTop1Rate > 0 && report.model.nodeTop1Rate < 1,
    '总平均恰好落在中间 —— 这正是"只看总平均会以为还行"的样子');
});

test('the baseline is scored on the same cases as the model, so the two are comparable', async () => {
  const result = await world();
  const rows = result.cases.map((item) => scoreCase({
    gold: item.label,
    verdict: { status: 'UNKNOWN' },
    status: 'completed',
    context: contextOf(item),
  }));
  const baseline = result.cases.map((item) => baselineCase(item));
  const report = summarize({ rows, baseline, shadow: [], expected: rows.length });
  assert.equal(baseline.length, result.cases.length);
  // 模型全弃权时命中率为 0 —— 这条是钳制，防止"我把 verdict 塞错了导致恒真"。
  assert.equal(report.model.bothRate, 0);
  assert.equal(report.model.abstainRate, 1);
  // 基线跑在同一批 case 上（不是子集），所以两边可比。
  assert.equal(report.baseline.nodeTop1Rate !== undefined, true);
});

test('the rule baseline is defeated by the corpus devices, and both numbers are reported', async () => {
  // 实测口径（不是期望，是量出来的）：
  //   - 带 decoy：规则 0/18 命中 —— decoy 没有"涉及集内的祖先"，于是根因不唯一 → UNKNOWN；
  //   - 摘掉 decoy：12/18 —— 剩下 6 条救不回来，因为 `inferDownstream` 在 subtle 模式下
  //     把真凶的 title/agentId/version/acceptance 抹回原值，而规则**只比这四个字段**。
  // 两个数字含义不同：前者是"语料任务难度"，后者更接近"规则在生产（无 decoy）里的水平"。
  const result = await world();
  const diagnostics = result.cases.map((item) => baselineDiagnostics(item));
  const report = summarize({ rows: [], baseline: [], shadow: [], diagnostics, expected: 0 });
  const diag = report.baselineDiagnostics;
  assert.equal(diag.driftCases, 18, `drift 样本数变了：${diag.driftCases}`);
  assert.equal(diag.ruleHitWithDecoys, 0, `带 decoy 居然命中了：${diag.ruleHitWithDecoys}`);
  assert.ok(diag.ruleHitWithoutDecoys > 0.5, `摘掉 decoy 后规则还是很差：${diag.ruleHitWithoutDecoys}`);
  assert.ok(diag.unreachableEvenWithoutDecoys > 0, '一条都救不回来？那 subtle 抹字段的逻辑变了');
  assert.ok(diag.ofWhichSubtle > 0, '救不回来的那些必须主要是 subtle —— 否则是另一个原因，得重新归因');
  // 两个数字都要在报告里，缺一个就没法解释模型赢在哪。
  assert.ok('ruleHitWithDecoys' in diag && 'ruleHitWithoutDecoys' in diag);
});

test('subtle mode wipes exactly the fields the rule reads, and step nodes are exempt', async () => {
  // 这三条都是 `inferDownstream` 的**设计**（见其 362-374 行的注释），不是我加的：
  //   - 非 step 节点 + subtle → title/agentId/version/acceptance 全部抹回原值；
  //   - step 节点**豁免** —— step 层只剩 title 与 agentId 两个信号通道，
  //     抹掉等于把样本变成无解的；
  //   - 结构性漂移（`missing_dependency` 砍边、`local_replan` 增派步骤）本来就**只写空对象**，
  //     所以它们的 fieldsWiped 恒为 true —— 那不是被抹，是**根本没有字段信号**。
  //     判据必须按"这个类型会不会写字段"分开，否则会把结构性样本误读成被抹。
  const result = await world();
  // 会写字段的类型。
  const WRITES_FIELDS = new Set(['wrong_agent', 'wrong_version', 'wrong_acceptance']);
  const subtleTask = result.cases.find((item) => item.visibility === 'subtle'
    && tierOf(item) === 'agent_task' && WRITES_FIELDS.has(item.label.injected_type));
  assert.ok(subtleTask, '没有 subtle 的 task 层字段型漂移样本');
  assert.equal(baselineDiagnostics(subtleTask).fieldsWiped, true, 'subtle 的 task 层漂移没被抹字段');

  const subtleStep = result.cases.find((item) => item.visibility === 'subtle'
    && tierOf(item) === 'agent_step' && WRITES_FIELDS.has(item.label.injected_type));
  assert.ok(subtleStep, '没有 subtle 的 step 层字段型漂移样本');
  assert.equal(baselineDiagnostics(subtleStep).fieldsWiped, false,
    'step 层不该被 subtle 抹字段（会变成无解样本）');

  // 结构性漂移：没有字段信号，所以 fieldsWiped 恒 true，且**与是否 subtle 无关**。
  const structural = result.cases.find((item) => item.label.status === 'drift'
    && ['missing_dependency', 'local_replan'].includes(item.label.injected_type));
  assert.ok(structural, '没有结构性漂移样本');
  assert.equal(baselineDiagnostics(structural).fieldsWiped, true);
});

test('the no_drift case is trivially separable, and the report says so instead of claiming a win', async () => {
  // 实测：no_drift 的 `G_prime` 与 `G_star` **逐字节相等**。所以它的正确率是平凡可分的，
  // 任何"永远说没漂移"的判定都能拿满分 —— 不能当能力证据。
  const result = await world();
  const noDrift = result.cases.filter((item) => item.label.status === 'no_drift');
  assert.ok(noDrift.length > 0);
  for (const item of noDrift) {
    assert.equal(JSON.stringify(item.G_star), JSON.stringify(item.G_prime), `${item.id} 的 G_prime 不等于 G_star`);
  }
  const baseline = result.cases.map((item) => baselineCase(item));
  const report = summarize({ rows: [], baseline, shadow: [], expected: 0 });
  assert.ok(report.caveats.some((line) => line.includes('平凡可分')), '缺了 no_drift 平凡可分的声明');
});

test('the shadow proposal is computed locally and never applied', async () => {
  const stepCase = await sampleOf('wrong_version_step');
  const shadow = shadowFor(stepCase);
  assert.equal(typeof shadow.reached, 'boolean');
  assert.ok(shadow.proximity >= 0 && shadow.proximity <= 1);
  // 影子提案只**描述**那一处改动，不带任何"已应用"的字段。
  assert.equal(shadow.applied, undefined);
  assert.ok(['align_node', 'add_edge', 'add_node', 'drop_node', 'drop_edge', ''].includes(shadow.op));
});

test('the shadow metric is vacuous on single-point injections, and that is reported not dressed up', async () => {
  // 阈值 0.8，实测相近度 0.936–1.000：一个节点在 ~32 节点图上只占 3–5% 加权质量，
  // 所以 `minimalPlanEdits` 恒报 `alreadySatisfied`、拿不出候选。0.8 是为**真实**漂移量
  // 标定的。这条测试把这个结构性事实钉住 —— 将来谁改了阈值，它会立刻变红。
  const result = await world();
  const shadows = result.cases.map((item) => shadowFor(item));
  assert.ok(shadows.every((item) => item.alreadySatisfied), '有一条居然没 alreadySatisfied？阈值可能被调过');
  assert.ok(shadows.every((item) => item.candidateCount === 0));
  const report = summarize({ rows: [], baseline: [], shadow: shadows, expected: 0 });
  assert.equal(report.shadow.alreadySatisfiedRate, 1);
  assert.ok(report.caveats.some((line) => line.includes('alreadySatisfied') || line.includes('影子提案')),
    '缺了"影子提案测不出东西"的声明');
});

test('actions are routed off the verdict, and the action distribution is reported', () => {
  const rows = [
    scoreCase({ gold: { status: 'drift', injected_node: 'n', injected_type: 'wrong_agent' }, verdict: { status: 'drift', nodeId: 'n', type: 'wrong_agent' }, status: 'completed' }),
    scoreCase({ gold: { status: 'drift', injected_node: 'n', injected_type: 'wrong_version' }, verdict: { status: 'drift', nodeId: 'n', type: 'wrong_version' }, status: 'completed' }),
    scoreCase({ gold: { status: 'drift', injected_node: 'n', injected_type: 'wrong_agent' }, verdict: { status: 'UNKNOWN' }, status: 'completed' }),
    scoreCase({ gold: { status: 'no_drift' }, verdict: { status: 'no_drift' }, status: 'completed' }),
  ];
  const report = summarize({ rows, baseline: [], shadow: [], expected: rows.length });
  assert.equal(report.actions.model.actions.similar_swap, 1);
  assert.equal(report.actions.model.actions.minimal_plan_edit, 1);
  // `no_drift` 与 `UNKNOWN` 都落 record_only，但 reason 不同 —— 分开报才有信息。
  assert.equal(report.actions.model.actions.record_only, 2);
  assert.equal(report.actions.model.reasons.no_drift, 1);
  assert.equal(report.actions.model.reasons.unknown_drift, 1);
});

test('collect joins jobs to cases and marks the ones that were never submitted', async () => {
  // 用不存在的 jobs 路径：全部 case 都应记成 `not_submitted`，而不是被丢掉。
  // 注意这里**不能**断言 `bothRate === 0` —— 没有 jobs 时 `cases` 也来自同一个
  // `out/` 目录，如果它不存在就得到空集，`bothRate` 是 `null`（"没有分母"），
  // 那和"命中率 0"是两件事，混淆它们正是这一层要防的错。
  await world();
  const { writeArtifacts } = await import('./simulate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sim-collect-'));
  const files = writeArtifacts(dir, await world());
  const collected = await collect({
    casesPath: files.generated,
    jobsPath: join(dir, 'does-not-exist.jsonl'),
  });
  assert.ok(collected.cases.length > 0, 'cases 是空的，这条测试就没意义了');
  assert.equal(collected.report.expected, collected.cases.length);
  assert.equal(collected.report.notTerminal, collected.cases.length);
  assert.equal(collected.report.scored, collected.cases.length);
  assert.equal(collected.report.model.bothRate, 0);
  assert.equal(collected.report.orphanJobs, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('collect does not silently drop a case whose job record is missing', async () => {
  const { writeArtifacts } = await import('./simulate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sim-collect-'));
  const files = writeArtifacts(dir, await world());
  const collected = await collect({
    casesPath: files.generated,
    jobsPath: join(dir, 'does-not-exist.jsonl'),
  });
  const statuses = collected.results.map((row) => row.status);
  assert.equal(statuses.length, collected.cases.length);
  assert.ok(statuses.every((status) => status === 'not_submitted'));
  rmSync(dir, { recursive: true, force: true });
});

test('parseArgs takes the paths it documents', () => {
  const args = parseArgs(['--cases', 'a.jsonl', '--jobs', 'b.jsonl', '--out', 'out', '--json']);
  assert.ok(args.cases.endsWith('a.jsonl'));
  assert.ok(args.jobs.endsWith('b.jsonl'));
  assert.equal(args.json, true);
});
