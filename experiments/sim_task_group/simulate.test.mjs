/**
 * 模拟任务群生成器的回归测试。
 *
 * ## 这些断言为什么值得写
 *
 * 这一轮实现里踩到的每一个坑都有同一个形状：**不报错，只是样本变简单或变少**。
 * 所以每条断言都配一个"如果退回去会怎样"的说明，并且尽量用负对照
 * （故意造一个坏输入，断言它**必须**被拦下）而不是只断言好路径。
 *
 * 被钉住的具体退化：
 *   - 骨架步数不够 → step 层一条 case 都注入不进去，症状只是"这几条没生成"；
 *   - step 层写了 acceptance → 模型学到生产上不存在的字段；
 *   - `pickForTier` 放宽到"非 step 即可" → 真凶落到 root 上 → decoy 池为空 → 判死；
 *   - `inferDownstream` 的 repair 分支 → 闸门不接受，症状只是"这批 case 没过"；
 *   - subtle 档位绑在 case 下标上 → 每个类型只有一档，占比却看着正常；
 *   - 忘了 `obfuscateGraph` → 数组序就是拓扑序，位置捷径复活而指标变好。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBriefs, planCases } from './lib/protocol.mjs';
import {
  STAR_NODE_MAX, assembleCase, buildSkeleton, pickForTier, repairNodeIds,
  skeletonBudget, stepTierViolations, subtleFor, validateSample, withoutRepair,
} from './lib/scenario.mjs';
import { generate, readBriefs, seedOf, validateLlmScript, writeArtifacts } from './simulate.mjs';
import { descendantsOf, hopDistance, normalizeRichGraph } from '../rdmd_detective_dataset/lib/graph.mjs';
import { renderedOrderIsTopological } from '../rdmd_detective_dataset/lib/obfuscate.mjs';

const BRIEFS = buildBriefs({ orgIds: ['org_01_consumer', 'org_04_education'], personLimitPerOrg: 2 });
const SMALL = buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 1 });
const BRIEF = SMALL[0];

function caseOf(brief, kind) {
  const plan = planCases(brief).find((item) => item.kind === kind);
  assert.ok(plan, `planCases 里没有 ${kind}`);
  return plan;
}

async function assemble(brief, kind, extra = {}) {
  const plan = caseOf(brief, kind);
  return assembleCase({ brief, plan, seed: seedOf(plan.caseId), propagate: 'local', ...extra });
}

// ---------------------------------------------------------------------------
// 骨架预算
// ---------------------------------------------------------------------------

test('the skeleton never exceeds the corpus node budget, and the budget is derived not guessed', () => {
  // 这条上界来自 schema.json 的 nodeCount.starMax，超了闸门的 star_node_count 会判死。
  for (let count = 2; count <= 8; count += 1) {
    const budget = skeletonBudget(count);
    assert.ok(budget.starNodes <= STAR_NODE_MAX, `P=${count} 时骨架 ${budget.starNodes} 个节点，超上界`);
    assert.ok(budget.stepsPerTask >= 5, `P=${count} 时每任务只有 ${budget.stepsPerTask} 步`);
    assert.equal(budget.starNodes, 2 + budget.participants * (1 + budget.stepsPerTask));
  }
  // 上限是**算出来的**：P*(1+S) ≤ 30 且 S ≥ 5 ⇒ P ≤ 5。6 个参与者无解。
  assert.equal(skeletonBudget(6).maxParticipants, 5);
  assert.equal(skeletonBudget(6).droppedParticipants, 1);
  assert.equal(skeletonBudget(5).droppedParticipants, 0);
});

test('a brief with more participants than the budget loses them loudly, not silently', () => {
  const fat = { ...BRIEF, participants: [...BRIEF.participants, ...BRIEF.participants, ...BRIEF.participants] };
  const budget = skeletonBudget(fat.participants.length);
  assert.ok(budget.droppedParticipants > 0);
  const base = buildSkeleton(fat, {});
  assert.equal(base.ordered.length, budget.maxParticipants);
  assert.ok(normalizeRichGraph(base.graph).nodes.length <= STAR_NODE_MAX);
});

// ---------------------------------------------------------------------------
// 骨架形状
// ---------------------------------------------------------------------------

test('every task chain is long enough that a step-tier culprit can exist at all', () => {
  // step 层真凶要同时满足「有前驱步骤」和「≥3 跳后代」。5 步链上只有 s1 满足 —— 所以
  // 4 步链（曾经的最小值）会让 step 层**一条 case 都注入不进去**。
  const base = buildSkeleton(BRIEF, {});
  const graph = base.graph;
  const steps = graph.nodes.filter((node) => node.kind === 'agent_step');
  const withPredecessor = steps.filter((step) => graph.edges.some((edge) => edge.to === step.id
    && graph.nodes.find((node) => node.id === edge.from)?.kind === 'agent_step'));
  const injectable = withPredecessor.filter((step) => descendantsOf(graph, step.id)
    .some((id) => hopDistance(graph, step.id, id) >= 3));
  assert.ok(injectable.length > 0, '没有任何 step 能当注入点');
  assert.ok(base.ordered.length >= 2, '至少要两个参与者才有协作链');
});

test('step nodes carry only the fields the real projection writes', () => {
  // 注意 `normalizeRichGraph` 会给缺失字段填默认值，所以归一化之后的图上
  // "没写"和"写了默认值"是**分不开**的 —— 这正是 `stepTierViolations` 只拦非默认值的原因。
  // 这里能断言的就是：它们全都停在默认值上。
  const base = buildSkeleton(BRIEF, {});
  for (const node of base.graph.nodes.filter((item) => item.kind === 'agent_step')) {
    assert.equal(node.version, 'v1', `${node.id} 的 version 不是默认值`);
    assert.equal(node.acceptance, 'standard', `${node.id} 的 acceptance 不是默认值`);
    for (const field of ['artifact', 'output', 'summary', 'inputs', 'stage']) {
      assert.equal(node[field], '', `${node.id} 写了 ${field}`);
    }
    assert.ok(node.agentId, `${node.id} 没有 agentId`);
  }
});

test('the step-tier guard actually fires when a step node is given a forbidden field', () => {
  // 负对照：不造坏输入的话，"这条判据存在"与"这条判据有效"是两回事。
  const base = buildSkeleton(BRIEF, {});
  const step = base.graph.nodes.find((node) => node.kind === 'agent_step');
  const poisoned = {
    G_star: { ...base.graph, nodes: base.graph.nodes.map((node) => (node.id === step.id ? { ...node, acceptance: 'relaxed' } : node)) },
    G_prime: base.graph,
  };
  const errors = stepTierViolations(poisoned);
  assert.ok(errors.some((error) => error.startsWith('step_acceptance:')), `没拦住：${JSON.stringify(errors)}`);
});

// ---------------------------------------------------------------------------
// 注入点
// ---------------------------------------------------------------------------

test('the culprit is never root or ubuddy', async () => {
  // 放宽成"非 step 即可"时 root 会进候选，而 root 的后代是全图 →
  // decoy 池为空 → drift_without_decoy。这条断言把那个放宽挡在门外。
  for (const brief of BRIEFS) {
    for (const kind of ['wrong_agent', 'wrong_version', 'wrong_acceptance', 'missing_dependency', 'twin_swap']) {
      const assembled = await assemble(brief, kind);
      assert.equal(assembled.errors.length, 0, `${brief.id}/${kind}: ${JSON.stringify(assembled.errors)}`);
      const goldId = assembled.sample.label.injected_node;
      const gold = normalizeRichGraph(assembled.sample.G_star).nodes.find((node) => node.id === goldId);
      assert.equal(gold.kind, 'agent_task', `${brief.id}/${kind} 的真凶是 ${gold.kind}`);
    }
  }
});

test('step-tier cases land on a step node, and the dependency cut is a step-to-step edge', async () => {
  for (const kind of ['local_replan_step', 'wrong_agent_step', 'wrong_version_step']) {
    const assembled = await assemble(BRIEF, kind);
    assert.equal(assembled.errors.length, 0, `${kind}: ${JSON.stringify(assembled.errors)}`);
    const star = normalizeRichGraph(assembled.sample.G_star);
    const gold = star.nodes.find((node) => node.id === assembled.sample.label.injected_node);
    assert.equal(gold.kind, 'agent_step', `${kind} 的真凶不是 step`);
  }

  // `missing_dependency` 是唯一一条**必须**有前驱步骤的 step 层类型：它砍的是
  // "上一步 → 这一步"的链边。砍包含边（任务 → 步骤）会把这一步变成孤立源点，
  // 那不是漂移是数据坏了。所以这一条要单独查、且要查两边。
  const cut = await assemble(BRIEF, 'missing_dependency_step');
  assert.equal(cut.errors.length, 0, JSON.stringify(cut.errors));
  const star = normalizeRichGraph(cut.sample.G_star);
  const prime = normalizeRichGraph(cut.sample.G_prime);
  const goldId = cut.sample.label.injected_node;
  assert.equal(star.nodes.find((node) => node.id === goldId).kind, 'agent_step');
  assert.ok(star.edges.some((edge) => edge.to === goldId
    && star.nodes.find((node) => node.id === edge.from)?.kind === 'agent_step'),
  '真凶没有前驱步骤');
  const cutEdgeId = cut.sample.label.injected_edge;
  assert.ok(cutEdgeId, 'missing_dependency 没有记录被砍的边');
  const [from, to] = cutEdgeId.split('->');
  assert.equal(to, goldId, `被砍的边不是指向真凶的：${cutEdgeId}`);
  assert.equal(star.nodes.find((node) => node.id === from).kind, 'agent_step',
    `被砍的是包含边而不是链边：${cutEdgeId}`);
  // 两侧对比：这一步在 G_exec 里确实失去了它的上游。
  assert.ok(prime.edges.some((edge) => edge.id === cutEdgeId || (`${edge.from}->${edge.to}` === cutEdgeId)) === false,
    'G_prime 里那条边还在');
});

test('asking for a tier the corpus cannot serve is reported, not silently downgraded', () => {
  // step 层没有 wrong_acceptance 形态（STEP_TIER_MISSING_FORMS）。这时必须**报错**，
  // 不能回落到 agent_task —— 回落会造出 step 层带 acceptance 的形状。
  const base = buildSkeleton(BRIEF, {});
  const picked = pickForTier(base.graph, { type: 'wrong_acceptance', tier: 'agent_step', seed: 7 });
  assert.equal(picked.ok, false, 'step 层居然给了 wrong_acceptance 的注入点');
  assert.match(picked.reason, /no_agent_step_injection_point|no_injection_point/);
});

// ---------------------------------------------------------------------------
// 闸门与分布
// ---------------------------------------------------------------------------

test('every generated case passes the corpus gate, across many briefs and all ten kinds', async () => {
  const result = await generate({ briefs: BRIEFS, mode: 'offline' });
  assert.equal(result.report.dropped, 0, `被丢掉：${JSON.stringify(result.report.dropReasons)} ${JSON.stringify(result.report.gateErrors)}`);
  assert.equal(result.report.cases, BRIEFS.length * 11);
  assert.deepEqual(
    Object.keys(result.report.byKind).sort(),
    ['local_replan_step', 'missing_dependency', 'missing_dependency_step', 'multi_inject', 'no_drift',
      'twin_swap', 'wrong_acceptance', 'wrong_agent', 'wrong_agent_step', 'wrong_version',
      'wrong_version_step'].sort(),
  );
  for (const sample of result.cases) {
    assert.equal(validateSample(sample, { requireSplit: true }).length, 0, `${sample.id} 没过闸门`);
    assert.equal(stepTierViolations(sample).length, 0);
    assert.equal(repairNodeIds(sample).length, 0);
  }
});

test('the positional shortcut stays dead: array order is not a topological order', async () => {
  // 忘了 obfuscateGraph 时，节点数组就是拓扑序，"取数组第一个"能直接得满分。
  const result = await generate({ briefs: SMALL, mode: 'offline' });
  for (const sample of result.cases) {
    for (const graph of [sample.G_star, sample.G_prime]) {
      const order = renderedOrderIsTopological(graph);
      assert.equal(order.byArray, false, `${sample.id} 的数组序是拓扑序`);
    }
  }
});

test('every drift case carries the decoy that kills the "whoever changed it" shortcut', async () => {
  const result = await generate({ briefs: BRIEFS, mode: 'offline' });
  for (const sample of result.cases) {
    if (sample.label.status !== 'drift') continue;
    assert.ok((sample.label.decoy_nodes || []).length > 0, `${sample.id} 没有 decoy`);
  }
});

test('both the subtle and the visible tier occur for every drift type', async () => {
  // 档位曾经绑在 case 下标上，于是 wrong_agent 永远 visible、wrong_version 永远 subtle ——
  // 占比正常、覆盖是空的。
  const result = await generate({ briefs: readBriefs(undefined, { personLimitPerOrg: 2 }), mode: 'offline' });
  const byKind = {};
  for (const sample of result.cases) {
    if (sample.label.status !== 'drift') continue;
    byKind[sample.plan.kind] = byKind[sample.plan.kind] || { subtle: 0, visible: 0, type: sample.label.injected_type };
    byKind[sample.plan.kind][sample.visibility] += 1;
  }
  for (const [kind, counts] of Object.entries(byKind)) {
    // 排除的是**类型**而不是某个 kind 名：`missing_dependency` 靠"少一条边"表达，
    // 没有可被 subtle 还原的字段。它现在有两层（agent_task / agent_step）共两条 case。
    if (counts.type === 'missing_dependency') {
      assert.equal(counts.subtle, 0, `${kind} 不该有 subtle`);
      continue;
    }
    assert.ok(counts.subtle > 0, `${kind} 一条 subtle 都没有`);
    assert.ok(counts.visible > 0, `${kind} 一条 visible 都没有`);
  }
});

test('the cascade is a sampled subset, not every far descendant', async () => {
  // 这是"我早先那版传播器"的直接探测器：它把 hop≥3 的后代**全部**写上，
  // 于是 960/960 条都恰好 hop=3，零方差。语料的 `inferDownstream` 是
  // `pickCount = ceil(far.length * rng.range(0.35, 0.75))` 的**子集抽样**。
  //
  // 只断言 hop 的分布会漏掉这个 bug 的其它后果（比如级联长度），所以这里直接查
  // "存在没被改到的 far 后代" —— 子集抽样必然产生这种节点，"全写"必然不产生。
  const result = await generate({ briefs: readBriefs(undefined, { personLimitPerOrg: 2 }), mode: 'offline' });
  const drift = result.cases.filter((sample) => sample.label.status === 'drift');
  const withUntouchedFar = drift.filter((sample) => {
    const star = normalizeRichGraph(sample.G_star);
    const changed = new Set(sample.changed_node_ids);
    return descendantsOf(star, sample.label.injected_node).some((id) => {
      const hop = hopDistance(star, sample.label.injected_node, id);
      return hop >= 3 && !changed.has(id) && !(sample.label.inserted_nodes || []).includes(id);
    });
  });
  assert.ok(
    withUntouchedFar.length >= drift.length * 0.5,
    `${withUntouchedFar.length}/${drift.length} 条留了没改到的远后代 —— 疑似把 far 全写了`,
  );

  // hop 的分布本身也查一遍（task 层）。这条是**经验性**的：语料抽样下 120 条里
  // 约 15 条落在 hop=4，所以"≥2 个取值"是稳的，但别把它当成不变量。
  const taskHops = new Set(Object.keys(result.report.hopByTier.agent_task || {}));
  assert.ok(taskHops.size >= 2, `agent_task 层的 hop 没有分布：${[...taskHops]}`);
  // 真正的**不变量**：任何一条的 hop 都不许低于语料门槛。
  for (const sample of drift) {
    assert.ok(sample.label.hop_to_first_effect >= 3,
      `${sample.id} 的 hop=${sample.label.hop_to_first_effect} < 3`);
  }
});

test('subtleFor excludes missing_dependency and is seed-driven, not index-driven', () => {
  assert.equal(subtleFor(2, 'missing_dependency'), false);
  assert.equal(subtleFor(1, 'missing_dependency'), false);
  // 同一个类型在同一个下标上必须两档都取得到 —— 这正是"绑下标"那版做不到的事。
  assert.equal(subtleFor(2, 'wrong_agent'), true);
  assert.equal(subtleFor(3, 'wrong_agent'), false);
});

// ---------------------------------------------------------------------------
// repair 分支
// ---------------------------------------------------------------------------

test('the corpus repair branch is switched off, and its re-appearance is caught', () => {
  // 闸门不接受 repair_* 节点（gates.mjs 明写那是另一个独立的行为变更），
  // 而 shipped 语料里 repair_ 出现 0 次。所以我们显式摘掉形态上的 repair。
  const form = { id: 'x', gold: () => ({}), far: () => ({}), repair: () => ({ title: 't' }) };
  const gold = { nodeId: 'n1', type: 'wrong_agent', form };
  assert.equal(withoutRepair(gold).form.repair, undefined);
  assert.equal(gold.form.repair, form.repair, 'withoutRepair 改动了原对象');
  // 形态没有 repair 时原样返回，不白造对象。
  const plain = { nodeId: 'n1', type: 'wrong_agent', form: { id: 'x' } };
  assert.equal(withoutRepair(plain), plain);

  const base = buildSkeleton(BRIEF, {});
  const withRepair = {
    G_prime: { ...base.graph, nodes: [...base.graph.nodes, { id: 'repair_n1_a', kind: 'agent_task', title: 'x' }] },
  };
  assert.deepEqual(repairNodeIds(withRepair), ['repair_n1_a']);
});

// ---------------------------------------------------------------------------
// LLM 契约
// ---------------------------------------------------------------------------

test('the LLM script contract rejects the two failures that would silently shrink the sample', () => {
  const budget = skeletonBudget(BRIEF.participants.length);
  const goodSteps = Array.from({ length: budget.stepsPerTask }, (_, index) => `步骤${index}`);
  const good = {
    tasks: Object.fromEntries(BRIEF.participants.slice(0, budget.participants)
      .map((participant) => [participant.agentId, { title: 't', steps: goodSteps }])),
  };
  assert.equal(validateLlmScript(good, BRIEF).ok, true);

  // 步数不够：装配器会造出短链，step 层一条 case 都注入不进去。
  const shortSteps = JSON.parse(JSON.stringify(good));
  shortSteps.tasks[Object.keys(shortSteps.tasks)[0]].steps = ['只有一步'];
  const shortCheck = validateLlmScript(shortSteps, BRIEF);
  assert.equal(shortCheck.ok, false);
  assert.ok(shortCheck.errors.some((error) => error.startsWith('steps_too_few:')));

  // 编造 agentId：骨架里会长出一个不存在的参与者。
  const invented = JSON.parse(JSON.stringify(good));
  invented.tasks.ag_does_not_exist = { title: 't', steps: goodSteps };
  const inventedCheck = validateLlmScript(invented, BRIEF);
  assert.equal(inventedCheck.ok, false);
  assert.ok(inventedCheck.errors.some((error) => error.startsWith('unknown_agent_id:')));
});

test('llm mode refuses to run without credentials instead of writing an empty file', async () => {
  const saved = { base: process.env.OPENAI_BASE_URL, key: process.env.CRS_OAI_KEY, alt: process.env.OPENAI_API_KEY };
  delete process.env.OPENAI_BASE_URL;
  delete process.env.CRS_OAI_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'sim-nokey-'));
    await assert.rejects(
      () => generate({ briefs: SMALL, mode: 'llm' }),
      /model_endpoint_not_configured/,
    );
    rmSync(dir, { recursive: true, force: true });
  } finally {
    if (saved.base) process.env.OPENAI_BASE_URL = saved.base;
    if (saved.key) process.env.CRS_OAI_KEY = saved.key;
    if (saved.alt) process.env.OPENAI_API_KEY = saved.alt;
  }
});

// ---------------------------------------------------------------------------
// 产物
// ---------------------------------------------------------------------------

test('the artifacts are byte-identical across runs, so two reports are comparable', async () => {
  const first = mkdtempSync(join(tmpdir(), 'sim-a-'));
  const second = mkdtempSync(join(tmpdir(), 'sim-b-'));
  try {
    const a = await generate({ briefs: SMALL, mode: 'offline' });
    const b = await generate({ briefs: SMALL, mode: 'offline' });
    writeArtifacts(first, a);
    writeArtifacts(second, b);
    assert.equal(
      readFileSync(join(first, 'generated.jsonl'), 'utf8'),
      readFileSync(join(second, 'generated.jsonl'), 'utf8'),
    );
    // 报告里会带 model/cache 之类的运行时字段，但主体统计必须一致。
    const ra = JSON.parse(readFileSync(join(first, 'report.json'), 'utf8'));
    const rb = JSON.parse(readFileSync(join(second, 'report.json'), 'utf8'));
    assert.deepEqual(ra.byKind, rb.byKind);
    assert.deepEqual(ra.hopHistogram, rb.hopHistogram);
    assert.deepEqual(ra.byVisibility, rb.byVisibility);
    assert.deepEqual(ra.dropReasons, rb.dropReasons);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('a leaked model key stops the write instead of landing in the artifact', () => {
  const key = 'sk-sim-test-key-must-not-be-written';
  const saved = { key: process.env.CRS_OAI_KEY, base: process.env.OPENAI_BASE_URL };
  process.env.CRS_OAI_KEY = key;
  process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
  const dir = mkdtempSync(join(tmpdir(), 'sim-leak-'));
  try {
    // 正对照：正常产物里不会有密钥，所以能写出去。
    writeArtifacts(dir, { cases: [{ id: 'ok' }], report: { ok: true } });
    assert.ok(readFileSync(join(dir, 'generated.jsonl'), 'utf8').includes('ok'));
    // 负对照：把密钥混进产物必须**抛**，而不是安静写出。
    assert.throws(
      () => writeArtifacts(dir, { cases: [{ id: 'ok', note: `token=${key}` }], report: { ok: true } }),
      /sim_key_leaked_into_generated\.jsonl/,
    );
  } finally {
    if (saved.key === undefined) delete process.env.CRS_OAI_KEY;
    else process.env.CRS_OAI_KEY = saved.key;
    if (saved.base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved.base;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the briefs actually used are written next to the cases, so a report can be replayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-briefs-'));
  try {
    const result = await generate({ briefs: SMALL, mode: 'offline' });
    writeArtifacts(dir, { ...result, briefs: SMALL });
    const rows = readFileSync(join(dir, 'briefs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, SMALL.length);
    assert.equal(rows[0].id, SMALL[0].id);
    // 每个 case 都指向一个真的写下来的 brief。
    const ids = new Set(rows.map((row) => row.id));
    for (const sample of result.cases) assert.ok(ids.has(sample.brief_id), `${sample.id} 指向了没写下来的 brief`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
