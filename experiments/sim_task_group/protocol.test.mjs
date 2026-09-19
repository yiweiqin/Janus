/**
 * 协议的自检：把「照抄」这件事变成断言，而不是注释里的一句话。
 *
 * 这个文件要回答的核心问题是：**模拟任务群跑出来的东西，和模型训练/上线那条链是同一套语义吗？**
 *
 * 如果协议自己发明一套漂移词表，那么"模拟群任务判定全对"这件事什么也不说明 —— 它证明的
 * 是一个不存在的系统能跑。所以每一处"我们复用了 X"都必须在 X 真的变了的时候**红**。
 *
 * 因此这里的每条断言都指向一个**外来**的真相源：
 *   - `experiments/rdmd_detective_dataset/schema.json`（语料的机器可读契约）
 *   - `experiments/rdmd_detective_dataset/lib/forms.mjs`（形态与 step 层的真实能力）
 *   - `experiments/rdmd_detective_dataset/generate.mjs`（gold 的实际写法）
 *   - `experiments/cpdb_org_world/data/full/*.jsonl`（角色库）
 *   - `experiments/cpdb_org_world/lib/catalog.mjs`（职能与 split 规则）
 *
 * 不是"断言我们的常量等于我们自己的常量"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FAMILIES } from '../cpdb_org_world/lib/catalog.mjs';
import {
  BRIEFS_PATH, CASE_PLAN, CPDB_DATA_DIR, DRIFT_SPEC, DRIFT_TYPES, GOLD_FIELDS,
  MIN_HOP_TO_FIRST_EFFECT, NODE_FIELDS, NODE_KINDS, NODE_STATUSES, PROPAGATION,
  RDMD_DATASET_DIR, SIM_SCHEMA, STATUSES, STEP_TIER_MISSING_FORMS, briefsJsonl, buildBriefs,
  familyDependencyEdges, familyDependencyOrder, goldOf, orderParticipants, planCases,
  rdmdSchema, stepFormAvailable,
} from './lib/protocol.mjs';

function readJsonl(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

test('the drift vocabulary is the corpus vocabulary, not ours', () => {
  // 双向相等，不是"包含"。协议里多出一种语料没有的类型 = 模型没训过；
  // 少一种 = 有一类漂移永远不被模拟，而报告里看不出来。
  assert.deepEqual([...DRIFT_TYPES], [...rdmdSchema().driftTypes]);
  assert.deepEqual([...STATUSES], [...rdmdSchema().status]);
  assert.deepEqual([...NODE_FIELDS], [...rdmdSchema().nodeFields]);
  assert.deepEqual([...NODE_KINDS], [...rdmdSchema().nodeKinds]);
  assert.deepEqual([...NODE_STATUSES], [...rdmdSchema().nodeStatuses]);
  assert.equal(MIN_HOP_TO_FIRST_EFFECT, rdmdSchema().minHopToFirstEffect);
});

test('every drift type carries a spec, and every spec is a real drift type', () => {
  assert.deepEqual(Object.keys(DRIFT_SPEC).sort(), [...DRIFT_TYPES].sort());
  for (const type of DRIFT_TYPES) {
    const spec = DRIFT_SPEC[type];
    assert.ok(spec.zh, `${type} 缺中文名，报告里会显示成裸 id`);
    assert.ok(spec.signal, `${type} 缺信号说明`);
    assert.ok(spec.tiers.length, `${type} 没有可注入的层级`);
    for (const tier of spec.tiers) {
      assert.ok(NODE_KINDS.includes(tier), `${type} 的层级 ${tier} 不是合法节点 kind`);
      // root / ubuddy 是容器层，永远不是真凶：它们不是"某个 agent 干的活"。
      assert.notEqual(tier, 'root');
      assert.notEqual(tier, 'ubuddy');
    }
    // structural 的类型必须"真凶一个字段都不改"，否则它就不是结构信号。
    if (spec.structural) assert.deepEqual([...spec.goldTouchesFields], []);
    else assert.ok(spec.goldTouchesFields.length, `${type} 不是结构性的，就必须说清动哪个字段`);
  }
});

test('the step tier really does lack wrong_acceptance, and the spec agrees', async () => {
  // 这条不是断言我们的常量：它去读**语料自己**那套 step 目录，确认
  // forms.mjs 确实没有给 wrong_acceptance 任何 step 形态。
  const forms = await import('../rdmd_detective_dataset/lib/forms.mjs');
  for (const type of DRIFT_TYPES) {
    const available = forms.stepFormAvailable(type);
    if (type in STEP_TIER_MISSING_FORMS) {
      assert.equal(available, false, `语料里 ${type} 其实有 step 形态，协议却把它当成缺失`);
      assert.ok(STEP_TIER_MISSING_FORMS[type], '缺失必须带理由，否则下一个人会以为是漏写');
    } else {
      assert.equal(available, true, `语料里 ${type} 没有 step 形态，协议却在 step 层用它`);
    }
    assert.equal(stepFormAvailable(type), available, '协议与语料对 step 能力的分歧');
  }
  // step 层的能力削减必须真的咬到协议：DRIFT_SPEC 的层级要与 forms 一致。
  assert.deepEqual([...DRIFT_SPEC.wrong_acceptance.tiers], ['agent_task']);
});

test('the family dependency graph is real, and the cycle is reported not swallowed', () => {
  const edges = familyDependencyEdges();
  // 依赖边必须来自 catalog 的 produces / consumes，不能是手写的。
  assert.ok(edges.length >= 8, `依赖边只有 ${edges.length} 条，太少`);
  for (const edge of edges) {
    const from = FAMILIES[edge.from];
    const to = FAMILIES[edge.to];
    assert.ok(from && to, `依赖边指向了不存在的职能：${edge.from}->${edge.to}`);
    for (const token of edge.tokens) {
      assert.ok(from.produces.includes(token), `${edge.from} 并不产出 ${token}`);
      assert.ok(to.consumes.includes(token), `${edge.to} 并不消费 ${token}`);
    }
  }
  const { order, brokenEdges } = familyDependencyOrder();
  assert.deepEqual([...order].sort(), Object.keys(FAMILIES).sort(), '排序必须覆盖全部职能且不重复');
  // 环是真的存在（writing→review→writing，经由 report 与 verdict）。
  // 如果哪天有人"顺手修好了"，这里会红 —— 那时该更新的是对环的解释，不是这条断言。
  assert.ok(brokenEdges.length > 0, '依赖图里那个环不见了？先确认是不是有人改了 produces/consumes');
  for (const edge of brokenEdges) assert.equal(edge.reason, 'cycle');
  // 断边必须只断环：任何一条被断的边，其 from 在 order 里都排在 to 之后。
  for (const edge of brokenEdges) {
    assert.ok(order.indexOf(edge.from) > order.indexOf(edge.to),
      `断边 ${edge.from}->${edge.to} 其实不是回边，断错了`);
  }
});

test('a brief is built out of the real CPDB roster, field for field', () => {
  const briefs = buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 3 });
  assert.equal(briefs.length, 3);
  const agents = readJsonl(join(CPDB_DATA_DIR, 'agents.jsonl'));
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const brief of briefs) {
    assert.ok(brief.participants.length >= 5, '参与者太少，图会撑不到 16 个节点');
    for (const participant of brief.participants) {
      const source = byId.get(participant.agentId);
      // 逐字段核对：brief 里的参与者必须能在 agents.jsonl 里原样找到，
      // 而不是我们按 familyId 编出来的名字。
      assert.ok(source, `${participant.agentId} 不在 agents.jsonl 里`);
      assert.equal(participant.familyId, source.familyId);
      assert.equal(participant.facetId, source.facetId);
      assert.equal(participant.twin, Boolean(source.twin));
      assert.deepEqual(participant.consumes, source.consumes);
      assert.deepEqual(participant.produces, source.produces);
      assert.deepEqual(participant.detailCapabilities, source.detailCapabilities);
      assert.equal(participant.ownerUserId, brief.lead.ownerUserId, '一个群任务只在一个人的团队里');
    }
    // 近邻对是 CPDB 相似度的落点：同职能、只差一项细节能力。
    assert.ok(brief.twinPairs.length >= 1, '没有近邻对就没有"最小能力改动"的实验台');
    for (const pair of brief.twinPairs) {
      const main = byId.get(pair.mainAgentId);
      const twin = byId.get(pair.twinAgentId);
      assert.equal(main.familyId, twin.familyId, '近邻必须同职能');
      assert.equal(twin.twin, true);
      assert.notEqual(main.facetId, twin.facetId, '近邻的细节能力必须不同，否则不构成"最小改动"');
    }
  }
});

test('the split is per-org, so an org never straddles train and test', () => {
  const briefs = buildBriefs({});
  const byOrg = new Map();
  for (const brief of briefs) {
    const seen = byOrg.get(brief.orgId);
    if (seen) assert.equal(seen, brief.split, `${brief.orgId} 跨了 split —— 测试集泄漏训练集`);
    byOrg.set(brief.orgId, brief.split);
    // `rng.splitForOrg` 是哈希切分，会把同 org 的人劈到不同 split。协议不能用它。
    assert.ok(['train', 'development', 'test'].includes(brief.split));
  }
  assert.equal(briefs.filter((brief) => brief.split === 'test').length > 0, true, 'test split 是空的，评测无从谈起');
  assert.equal(briefs.filter((brief) => brief.split === 'development').length > 0, true, 'development split 是空的');
});

test('the case plan covers all five drift types and the two non-drift cases', () => {
  const covered = new Set(CASE_PLAN.filter((entry) => entry.status === 'drift').map((entry) => entry.type));
  assert.deepEqual([...covered].sort(), [...DRIFT_TYPES].sort(), '有一类漂移永远不会被注入');
  assert.equal(CASE_PLAN.filter((entry) => entry.status === 'no_drift').length, 1);
  assert.equal(CASE_PLAN.filter((entry) => entry.status === 'UNKNOWN').length, 1, '没有双注入就测不出弃权');
  // 每条 drift case 的层级必须在 DRIFT_SPEC 允许的层级里 —— 这是 step 层能力削减真正咬合的地方。
  for (const entry of CASE_PLAN) {
    if (entry.status !== 'drift') continue;
    assert.ok(DRIFT_SPEC[entry.type].tiers.includes(entry.tier),
      `${entry.id} 把 ${entry.type} 放在了 ${entry.tier}，而协议说它只能在 ${DRIFT_SPEC[entry.type].tiers.join('/')}`);
  }
  // 至少有一条落在 step 层：否则四层图里最值钱的那层从来没被评过。
  assert.ok(CASE_PLAN.some((entry) => entry.tier === 'agent_step'), 'step 层一条 case 都没有');
  // 近邻替换必须挂在 CPDB 相似度上，而不是随手指一个 agent。
  assert.equal(CASE_PLAN.find((entry) => entry.id === 'twin_swap').viaCpdbSimilarity, true);
});

test('planned cases name real agents, and the drift case names a substitute', () => {
  const briefs = buildBriefs({ orgIds: ['org_01_consumer', 'org_02_platform'], personLimitPerOrg: 2 });
  const agents = new Set(readJsonl(join(CPDB_DATA_DIR, 'agents.jsonl')).map((agent) => agent.id));
  for (const brief of briefs) {
    const cases = planCases(brief);
    assert.equal(cases.length, CASE_PLAN.length);
    for (const item of cases) {
      assert.ok(agents.has(item.targetTaskAgentId), `${item.caseId} 的真凶不是真实 agent`);
      assert.ok(agents.has(item.upstreamAgentId), `${item.caseId} 的上游不是真实 agent`);
      // 真凶必须有上游，否则 missing_dependency 根本没有入边可删。
      assert.notEqual(item.upstreamAgentId, item.targetTaskAgentId,
        `${item.caseId} 的真凶同时是它自己的上游，删不掉入边`);
      if (item.type === 'wrong_agent') {
        assert.ok(agents.has(item.substituteAgentId), `${item.caseId} 没有替换者`);
        assert.notEqual(item.substituteAgentId, item.targetTaskAgentId);
      }
      // 期望跳数就是协议的硬规则 1；no_drift 没有后果所以是 0。
      assert.equal(item.expected.minHopToFirstEffect, item.status === 'drift' ? MIN_HOP_TO_FIRST_EFFECT : 0);
    }
    // twin_swap 的替换者必须是该主职能位的近邻，不是随便一个同职能 agent。
    const swap = cases.find((item) => item.kind === 'twin_swap');
    const pair = brief.similarSwapCandidates.find((candidate) => candidate.familyId ===
      brief.participants.find((p) => p.agentId === swap.targetTaskAgentId)?.familyId);
    assert.ok(pair, 'twin_swap 的真凶职能没有近邻对照');
    assert.equal(swap.substituteAgentId, pair.to, 'twin_swap 换错了人 —— 相似度实验就失去意义');
  }
});

test('gold uses exactly the corpus gold fields, and never leaks the answer', () => {
  const single = goldOf({ status: 'drift', nodeId: 'n7', type: 'wrong_agent', edgeId: 'n3->n7', formId: 'research.wrong_agent.x', hopToFirstEffect: 3, decoyNodes: ['n9'] });
  for (const key of Object.keys(single)) {
    const allowed = [...GOLD_FIELDS, 'inserted_nodes'];
    assert.ok(allowed.includes(key), `gold 里出现了语料没有的键：${key}（不会报错，只会让指标静默算错）`);
  }
  assert.deepEqual(Object.keys(single).sort(), [...GOLD_FIELDS].sort(), '单注入 gold 的键必须与语料一一对应');
  assert.equal(single.hop_to_first_effect, 3);

  const none = goldOf({ status: 'no_drift' });
  assert.equal(none.injected_node, '');
  assert.equal(none.injected_type, '');
  assert.equal(none.hop_to_first_effect, 0);

  // 双注入走复数键（照 `generate.mjs#makeUnknown`），单数留空。
  const multi = goldOf({ status: 'UNKNOWN', multiNodes: ['n4', 'n11'], multiTypes: ['wrong_version', 'local_replan'], multiForms: ['a', 'b'] });
  assert.deepEqual(multi.injected_nodes, ['n4', 'n11']);
  assert.equal(multi.injected_node, '', 'UNKNOWN 的单数键必须是空的，否则定位指标会把它当成单点答案');

  // 注入副作用节点要显式声明，否则 extra_node_unexplained 会判死。
  const inserted = goldOf({ status: 'drift', nodeId: 'n5', type: 'local_replan', insertedNodes: ['n5b'] });
  assert.deepEqual(inserted.inserted_nodes, ['n5b']);

  assert.throws(() => goldOf({ status: 'maybe' }), /sim_protocol_bad_status/);
  assert.throws(() => goldOf({ status: 'drift', nodeId: 'n1', type: 'wrong_typo' }), /sim_protocol_bad_type/);
});

test('the propagation contract is the one the corpus actually gates on', () => {
  // 照 `generate.mjs#makePrime` 的指令与 `lib/graph.mjs#firstEffectHop` 的取法：
  // hop 1–2 的后代不许改，后果从第 3 跳起。不一致的话 firstEffectHop 会静默变 1。
  assert.deepEqual([...PROPAGATION.untouchedDescendantHops], [1, 2]);
  assert.equal(PROPAGATION.effectStartsAtHop, MIN_HOP_TO_FIRST_EFFECT);
  assert.equal(PROPAGATION.effectStartsAtHop, 3);
  assert.match(PROPAGATION.shared, /1–2 跳/);
  assert.match(PROPAGATION.scope, /descendants\(gold\)/);
  // 两个口径（subtle / visible）都要在，采样时二选一 —— 只有一种的话
  // "改动很微小"和"改动明显"就分不出来，而难度分层正是评测要看的一维。
  assert.ok(PROPAGATION.subtle && PROPAGATION.visible);
});

test('orderParticipants is deterministic and dependency-ordered', () => {
  const briefs = buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 1 });
  const participants = briefs[0].participants;
  const once = orderParticipants(participants);
  const twice = orderParticipants([...participants].reverse());
  // 输入顺序不同，输出必须相同：否则 gold 会随重跑漂移。
  assert.deepEqual(once.map((item) => item.agentId), twice.map((item) => item.agentId));
  // 产出上游的职能要排在消费它的职能前面。
  const rank = new Map(familyDependencyOrder().order.map((id, index) => [id, index]));
  for (const edge of familyDependencyEdges()) {
    if (familyDependencyOrder().brokenEdges.some((item) => item.from === edge.from && item.to === edge.to)) continue;
    const from = once.findIndex((item) => item.familyId === edge.from);
    const to = once.findIndex((item) => item.familyId === edge.to);
    if (from < 0 || to < 0) continue;
    assert.ok(from < to || rank.get(edge.from) < rank.get(edge.to),
      `${edge.from} 该在 ${edge.to} 前面（产出 ${edge.tokens.join(',')}）`);
  }
});

test('the protocol does not depend on the corpus dataset being present at import time', async () => {
  // `protocol.mjs` 在模块加载时就读 schema.json。这条断言是为了让"读不到文件"这件事
  // 以**清晰**的方式失败，而不是让所有人看到一句 ERR_MODULE_NOT_FOUND 猜是哪个文件。
  assert.ok(RDMD_DATASET_DIR.includes('rdmd_detective_dataset'));
  assert.ok(CPDB_DATA_DIR.includes('cpdb_org_world'));
  const reread = rdmdSchema();
  assert.ok(Array.isArray(reread.driftTypes));
  assert.equal(DRIFT_TYPES.length, reread.driftTypes.length);
});

test('briefs.jsonl on disk is exactly what the roster derives, so it cannot go stale', () => {
  // 这个文件完全可以从 `cpdb_org_world/data/full` 推导出来。落盘是为了让"这一轮到底用了
  // 哪些 agent"能被人复查（否则一次 `--limit 3` 的跑与一次全量跑在报告上长得一样），
  // 但落盘就会过期 —— 所以这里断言磁盘内容 === 函数推导内容。
  //
  // 红了怎么办：`node experiments/sim_task_group/lib/protocol.mjs --write`
  assert.ok(existsSync(BRIEFS_PATH), `briefs.jsonl 不在 ${BRIEFS_PATH}，用 --write 生成`);
  const onDisk = readFileSync(BRIEFS_PATH, 'utf8').replace(/^\uFEFF/, '');
  const derived = briefsJsonl(buildBriefs({}));
  if (onDisk !== derived) {
    const diskLines = onDisk.trim().split('\n');
    const derivedLines = derived.trim().split('\n');
    assert.equal(diskLines.length, derivedLines.length,
      'briefs.jsonl 的行数不对 —— 角色库或 split 规则变了，请重新 --write');
    const firstDiff = diskLines.findIndex((line, index) => line !== derivedLines[index]);
    assert.fail(`briefs.jsonl 第 ${firstDiff + 1} 行与推导结果不一致（角色库变了？）请重新 --write`);
  }
  assert.equal(JSON.parse(derived.split('\n')[0]).schema, SIM_SCHEMA);
});
