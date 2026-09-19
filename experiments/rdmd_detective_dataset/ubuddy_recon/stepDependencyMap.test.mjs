/**
 * 「顺序链 → 依赖 DAG」映射契约的纪律测试。
 *
 * 这份契约的全部价值在于**不让顺序冒充因果**，所以测试也围绕这一件事：
 *
 *   1. 纯顺序链上，`causalAttributionReadiness` 必须**说不**（不是「差不多」）；
 *   2. 证据边必须能和顺序边**分开取**，且同一对端点上只能有一条边
 *      （两条同 id 的边会被 `drop_edge` 一次删两条、被度量重复计数）；
 *   3. 指向未来 / 自环 / 端点在外的证据必须被**丢弃并报警**，不许静默采信；
 *   4. 三档必要性必须互相分得开，尤其是 `unverifiable ≠ 不需要`；
 *   5. 空分母不许印 0；`assertNotForTraining` 必须真的会抛。
 *
 * 运行：node --test experiments/rdmd_detective_dataset/ubuddy_recon/stepDependencyMap.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STEP_DEPENDENCY_EDGE_KINDS,
  STEP_DEPENDENCY_MAP_PURPOSES,
  STEP_DEPENDENCY_MAP_TRAINING_ALLOWED,
  STEP_DEPENDENCY_MAP_VERSION,
  STEP_DEPENDENCY_MAP_WARNING_CODES,
  STEP_NECESSITY,
  assertNotForTraining,
  causalAttributionReadiness,
  causalOnlyGraph,
  stepDependencyMap,
  stepNecessity,
} from './stepDependencyMapLib.mjs';

/** 一条 5 步的顺序链，形状与真实 rollout 投影（`buildAgentGraph`）一致。 */
function chain(length = 5) {
  const nodes = [];
  const edges = [];
  for (let index = 0; index < length; index += 1) {
    nodes.push({
      id: `s1#${index}`,
      title: index % 2 ? 'reasoning' : `function_call:shell_command`,
      role: index % 2 ? 'reasoning' : 'function_call',
      status: 'executed',
    });
    if (index > 0) edges.push({ id: `s1#${index - 1}->s1#${index}`, from: `s1#${index - 1}`, to: `s1#${index}` });
  }
  return { nodes, edges };
}

const warningCodes = (mapped) => mapped.warnings.map((warning) => warning.code);

test('纯顺序链：每条边都是假设，门必须说不', () => {
  const mapped = stepDependencyMap(chain(5));

  assert.equal(mapped.version, STEP_DEPENDENCY_MAP_VERSION);
  assert.equal(mapped.stats.edgeCount, 4);
  assert.equal(mapped.stats.orderEdgeCount, 4);
  assert.equal(mapped.stats.evidenceEdgeCount, 0);
  assert.deepEqual(warningCodes(mapped), []);

  // 每一条边都必须被标成非因果，而且带得走 `evidence: 'order_only'`。
  for (const edge of mapped.edges) {
    assert.equal(edge.kind, STEP_DEPENDENCY_EDGE_KINDS.SEQUENCE);
    assert.equal(edge.causal, false);
    assert.equal(edge.evidence, 'order_only');
  }

  assert.equal(mapped.stats.orderOnlyShare, 1);
  // 没有证据边时「高估多少倍」没有上限可言 —— 给 null，不给 1（1 读起来像「不膨胀」）。
  assert.equal(mapped.stats.cascadeInflation, null);

  const readiness = causalAttributionReadiness(mapped);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.reasons, ['no_evidence_edges', 'order_only_edges_present']);
});

test('证据边升级顺序边：同一对端点只留一条，且能被单独取出来', () => {
  const { nodes, edges } = chain(5);
  const mapped = stepDependencyMap({
    nodes,
    edges,
    consumes: [{ from: 's1#0', to: 's1#1', symbol: 'path:notes.md' }],
  });

  // 4 条边不是 5 条：`s1#0->s1#1` 被升级，而不是两条并存。
  assert.equal(mapped.stats.edgeCount, 4);
  assert.equal(mapped.stats.evidenceEdgeCount, 1);
  assert.equal(mapped.stats.orderEdgeCount, 3);
  assert.equal(mapped.stats.upgradedFromSequence, 1);
  assert.equal(mapped.stats.orderOnlyShare, 0.75);
  assert.equal(mapped.stats.cascadeInflation, 4);

  // 边 id 唯一：`edgeKey` 是 `${from}->${to}`，重复 id 会被 `drop_edge` 一次删两条。
  const ids = mapped.edges.map((edge) => edge.id);
  assert.equal(new Set(ids).size, ids.length);

  const upgraded = mapped.evidenceEdges.find((edge) => edge.id === 's1#0->s1#1');
  assert.equal(upgraded.kind, STEP_DEPENDENCY_EDGE_KINDS.CONSUMES);
  assert.equal(upgraded.causal, true);
  assert.equal(upgraded.evidence, 'path:notes.md');
  assert.deepEqual(mapped.orderEdges.map((edge) => edge.id), ['s1#1->s1#2', 's1#2->s1#3', 's1#3->s1#4']);

  // 还有顺序边 → 仍然不可以做因果归因，但理由只剩下一条。
  assert.deepEqual(causalAttributionReadiness(mapped).reasons, ['order_only_edges_present']);
});

test('整条链都有证据时，门才第一次打开', () => {
  const { nodes, edges } = chain(4);
  const mapped = stepDependencyMap({
    nodes,
    edges,
    consumes: [0, 1, 2].map((index) => ({ from: `s1#${index}`, to: `s1#${index + 1}`, symbol: `path:p${index}` })),
  });

  assert.equal(mapped.stats.orderEdgeCount, 0);
  assert.equal(mapped.stats.evidenceEdgeCount, 3);
  assert.equal(mapped.stats.orderOnlyShare, 0);
  assert.equal(mapped.stats.cascadeInflation, 1);
  const readiness = causalAttributionReadiness(mapped);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.reasons, []);
  assert.deepEqual(causalOnlyGraph(mapped).isolatedNodeIds, []);
});

test('坏证据（自环 / 端点在外 / 指向未来）必须丢弃并报警，不许静默采信', () => {
  const { nodes, edges } = chain(4);
  const mapped = stepDependencyMap({
    nodes,
    edges,
    consumes: [
      { from: 's1#1', to: 's1#1' },
      { from: 's1#0', to: 'ghost' },
      { from: 's1#2', to: 's1#1', symbol: 'path:from_the_future' },
    ],
  });

  assert.equal(mapped.stats.evidenceEdgeCount, 0);
  assert.equal(mapped.stats.edgeCount, 3, '坏证据不能改变顺序骨架');
  assert.deepEqual([...warningCodes(mapped)].sort(), [
    STEP_DEPENDENCY_MAP_WARNING_CODES.CONSUMES_AGAINST_ORDER,
    STEP_DEPENDENCY_MAP_WARNING_CODES.CONSUMES_SELF_LOOP,
    STEP_DEPENDENCY_MAP_WARNING_CODES.CONSUMES_UNKNOWN_ENDPOINT,
  ].sort());
  // 「消费了未来才产出的东西」在时间上不可能，提示语必须说清是顺序问题。
  const againstOrder = mapped.warnings.find((warning) => warning.code === STEP_DEPENDENCY_MAP_WARNING_CODES.CONSUMES_AGAINST_ORDER);
  assert.match(againstOrder.detail, /指向未来/);
});

test('三档必要性分得开，且 unverifiable 不等于「不需要」', () => {
  const { nodes, edges } = chain(5);
  const mapped = stepDependencyMap({
    nodes,
    edges,
    consumes: [{ from: 's1#0', to: 's1#1' }, { from: 's1#1', to: 's1#2' }],
  });

  const middle = stepNecessity(mapped, 's1#1');
  assert.equal(middle.verdict, STEP_NECESSITY.ON_EVIDENCE_PATH);
  assert.equal(middle.evidenceIn, 1);
  assert.equal(middle.evidenceOut, 1);

  assert.equal(stepNecessity(mapped, 's1#0').verdict, STEP_NECESSITY.ENDPOINT);
  assert.equal(stepNecessity(mapped, 's1#0').reason, 'only_produces_evidence');
  assert.equal(stepNecessity(mapped, 's1#2').verdict, STEP_NECESSITY.ENDPOINT);
  assert.equal(stepNecessity(mapped, 's1#2').reason, 'only_consumes_evidence');

  // 链上有邻居、却没有证据：必须是 unverifiable + 能看出「它在链上」。
  const unproven = stepNecessity(mapped, 's1#3');
  assert.equal(unproven.verdict, STEP_NECESSITY.UNVERIFIABLE);
  assert.equal(unproven.reason, 'on_the_chain_but_no_evidence_attaches');
  assert.equal(unproven.orderOnlyIn, 1);
  assert.equal(unproven.orderOnlyOut, 1);

  // 单节点链：两种视图里都孤立。
  const lonely = stepDependencyMap({ nodes: [{ id: 'only' }], edges: [] });
  const isolated = stepNecessity(lonely, 'only');
  assert.equal(isolated.verdict, STEP_NECESSITY.UNVERIFIABLE);
  assert.equal(isolated.reason, 'isolated_in_both_views');

  // 节点名打错不能当成「查不到」悄悄过去。
  assert.throws(() => stepNecessity(mapped, 's1#99'), /不在映射结果里/);
});

test('缺边时按顺序推导，但必须留下「边不是数据里的」这条痕迹', () => {
  const { nodes } = chain(3);
  const mapped = stepDependencyMap({ nodes });

  assert.equal(mapped.stats.orderEdgeCount, 2);
  assert.deepEqual(warningCodes(mapped), [STEP_DEPENDENCY_MAP_WARNING_CODES.EDGES_DERIVED_FROM_ORDER]);
  assert.match(mapped.warnings[0].detail, /推导了 2 条顺序边/);
});

test('逆序边与重复节点：丢边报警，但绝不偷偷改掉观察到的顺序', () => {
  const { nodes } = chain(3);
  const mapped = stepDependencyMap({
    nodes: [...nodes, { id: 's1#0', title: '重复' }],
    edges: [{ from: 's1#2', to: 's1#0' }, { from: 's1#0', to: 's1#1' }],
  });

  assert.equal(mapped.stats.nodeCount, 3, '重复 id 只留第一次');
  assert.deepEqual([...warningCodes(mapped)].sort(), [
    STEP_DEPENDENCY_MAP_WARNING_CODES.DUPLICATE_NODE_ID,
    STEP_DEPENDENCY_MAP_WARNING_CODES.EDGE_AGAINST_ORDER,
  ].sort());
  // 顺序仍是最初观察到的 s1#0 -> s1#1 -> s1#2。
  assert.deepEqual(mapped.nodes.map((node) => node.id), ['s1#0', 's1#1', 's1#2']);
  assert.deepEqual(mapped.edges.map((edge) => edge.id), ['s1#0->s1#1']);
});

test('空图：全零，比率一律 null（空分母不许印 0）', () => {
  const mapped = stepDependencyMap({});

  assert.equal(mapped.stats.nodeCount, 0);
  assert.equal(mapped.stats.edgeCount, 0);
  assert.equal(mapped.stats.orderOnlyShare, null);
  assert.equal(mapped.stats.cascadeInflation, null);
  assert.deepEqual(warningCodes(mapped), [STEP_DEPENDENCY_MAP_WARNING_CODES.NODES_MISSING]);
  assert.deepEqual(causalAttributionReadiness(mapped).reasons, ['no_edges']);
  assert.deepEqual(causalOnlyGraph(mapped), {
    version: STEP_DEPENDENCY_MAP_VERSION, nodes: [], edges: [], isolatedNodeIds: [],
  });
});

test('「不得用于训练」必须是可执行的，不是一句注释', () => {
  assert.equal(STEP_DEPENDENCY_MAP_TRAINING_ALLOWED, false);
  assert.deepEqual([...STEP_DEPENDENCY_MAP_PURPOSES], ['diagnosis']);
  assert.equal(assertNotForTraining('diagnosis'), true);
  for (const purpose of ['train', 'eval', 'evaluation', 'sft', '']) {
    assert.throws(() => assertNotForTraining(purpose), /不得用于训练或评测/,
      `用途「${purpose}」必须被拒`);
  }
});
