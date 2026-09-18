import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSample } from './lib/gates.mjs';
import { addDecoyNodes, applyLocalEdit, generateGoldenGraph, inferDownstream, insertedNodesOf, pickInjection, pickForkPair } from './lib/localTeacher.mjs';
import { changedNodeIds, DEFAULT_NODE_STATUS, firstEffectHop, graphHasForbiddenKeys, isDag, maxHopFrom, stripForbiddenKeys, topoIds } from './lib/graph.mjs';
import { detectMinimalDrift } from '../../src/shared/contracts/uBuddyReverseDetective.js';
import { structuralGraph } from './lib/graph.mjs';
import { DRIFT_TYPES, SCHEMA } from './lib/graph.mjs';
import { STEP_TIER_MISSING_FORMS } from './lib/forms.mjs';
import { isMainSupervised, toSftRow } from './lib/sft.mjs';
import { renderedOrderIsTopological } from './lib/obfuscate.mjs';

test('golden graphs are long-range DAGs', () => {
  for (let index = 0; index < 40; index += 1) {
    const graph = generateGoldenGraph(index, 7);
    assert.equal(isDag(graph), true);
    assert.ok(graph.nodes.length >= SCHEMA.nodeCount.starMin && graph.nodes.length <= SCHEMA.nodeCount.starMax);
    assert.ok(maxHopFrom(graph, topoIds(graph)[0]) >= 8);
    // v4：富文本只保证在 agent_step **以上**的层存在。step 层的富文本在真实投影里
    // 恒空（projectAgentPlanSteps 只写 title/status/agentId），所以这一族里不能要求它。
    assert.ok(graph.nodes
      .filter((node) => node.kind !== 'agent_step')
      .every((node) => node.summary && node.output && node.artifact));
  }
});

test('v3 hides the dependency order from the rendered order', () => {
  for (let index = 0; index < 40; index += 1) {
    const graph = generateGoldenGraph(index, 7);
    const order = renderedOrderIsTopological(graph);
    assert.equal(order.byId, false, `index=${index} id order is still topological`);
    assert.equal(order.byArray, false, `index=${index} array order is still topological`);
  }
});

test('same drift type takes a different form on different tasks', () => {
  const research = generateGoldenGraph(0, 11);
  const code = generateGoldenGraph(4, 11);
  const r = applyLocalEdit(research, 'wrong_version', pickInjection(research, 21, 'wrong_version').nodeId, 21);
  const c = applyLocalEdit(code, 'wrong_version', pickInjection(code, 21, 'wrong_version').nodeId, 21);
  const rNode = r.graph.nodes.find((node) => node.id === r.gold.nodeId);
  const cNode = c.graph.nodes.find((node) => node.id === c.gold.nodeId);
  assert.equal(r.gold.type, 'wrong_version');
  assert.equal(c.gold.type, 'wrong_version');
  assert.notEqual(r.gold.formId, c.gold.formId);
  assert.notEqual(rNode.output, cNode.output);
  assert.equal(rNode.output.includes('[stale]'), false);
  assert.equal(cNode.output.includes('[stale]'), false);
});

test('gold is recorded before downstream inference; first effect is delayed', () => {
  const star = generateGoldenGraph(3, 11);
  let applied;
  let decoyed;
  for (let attempt = 0; attempt < 40 && !(decoyed && decoyed.decoys.length); attempt += 1) {
    const picked = pickInjection(star, 404521 + attempt * 7919, 'wrong_agent');
    if (!picked) continue;
    applied = applyLocalEdit(star, picked.type, picked.nodeId, 21);
    if (!applied.gold) continue;
    const prime = inferDownstream(star, applied.graph, applied.gold, { seed: 5, subtle: true });
    decoyed = addDecoyNodes(star, prime, applied.gold.nodeId, { seed: 77 + attempt, count: 1 });
  }
  assert.ok(applied.gold && applied.gold.nodeId, 'gold not recorded');
  assert.ok(decoyed.decoys.length >= 1, 'no decoy attachable');
  const hop = firstEffectHop(star, decoyed.graph, applied.gold.nodeId);
  assert.ok(hop >= SCHEMA.minHopToFirstEffect, `hop=${hop}`);
  const sample = {
    id: 't1', graph_id: 'g1', split: 'train',
    G_star: star, G_prime: decoyed.graph,
    label: {
      status: 'drift',
      injected_node: applied.gold.nodeId,
      injected_type: applied.gold.type,
      injected_edge: '',
      injected_form: applied.gold.formId,
      decoy_nodes: decoyed.decoys,
      inserted_nodes: insertedNodesOf(applied.gold),
    },
  };
  assert.deepEqual(validateSample(sample, { requireSplit: true }), []);
  const blob = JSON.stringify(decoyed.graph);
  assert.equal(blob.includes('wrong_agent'), false);
  assert.equal(blob.includes(applied.gold.nodeId) && /因上游/.test(blob), false);
});

test('subtle content drift is missed by the structural heuristic', () => {
  const star = generateGoldenGraph(8, 3);
  const picked = pickInjection(star, 4, 'wrong_version');
  const applied = applyLocalEdit(star, 'wrong_version', picked.nodeId, 4);
  const prime = inferDownstream(star, applied.graph, applied.gold, { seed: 9, subtle: true });
  const prediction = detectMinimalDrift(structuralGraph(star), structuralGraph(prime));
  assert.notEqual(prediction.nodeId, applied.gold.nodeId);
});

test('SFT prompt hides gold, and UNKNOWN now trains the abstention branch', () => {
  const star = generateGoldenGraph(3, 11);
  const picked = pickInjection(star, 21, 'wrong_version');
  const applied = applyLocalEdit(star, picked.type, picked.nodeId, 21);
  const prime = inferDownstream(star, applied.graph, applied.gold, { seed: 5, subtle: true });
  const decoyed = addDecoyNodes(star, prime, applied.gold.nodeId, { seed: 31, count: 1 });
  const sample = {
    id: 't-sft', graph_id: 'g-sft', split: 'train',
    G_star: star, G_prime: decoyed.graph,
    label: {
      status: 'drift',
      injected_node: applied.gold.nodeId,
      injected_type: applied.gold.type,
      injected_edge: '',
      injected_form: applied.gold.formId,
      decoy_nodes: decoyed.decoys,
      inserted_nodes: insertedNodesOf(applied.gold),
    },
  };
  const { row, errors } = toSftRow(sample, { supervised: true });
  assert.deepEqual(errors, []);
  assert.equal(row.supervised, true);
  assert.equal(row.prompt.includes('INPUT='), true);
  assert.equal(row.prompt.includes(applied.gold.formId), false);
  assert.equal(row.prompt.slice(row.prompt.indexOf('INPUT=')).includes(applied.gold.type), false);
  const completion = JSON.parse(row.completion);
  assert.equal(completion.status, 'drift');
  assert.equal(completion.nodeId, applied.gold.nodeId);
  assert.equal(completion.type, applied.gold.type);
  assert.equal(isMainSupervised('UNKNOWN'), true);
  assert.equal(isMainSupervised('drift'), true);
  assert.equal(isMainSupervised('no_drift'), true);
});

test('fork pair exists on non-linear graphs', () => {
  const graph = generateGoldenGraph(220, 1);
  const pair = pickForkPair(graph, 99);
  assert.ok(pair && pair.a && pair.b && pair.a !== pair.b);
});

// ---------------------------------------------------------------------------
// 四层群任务族（做法 C 的底料）
// ---------------------------------------------------------------------------

test('群任务族产出四层骨架：容器 + 工作单元 + 真的步骤链', () => {
  const graph = generateGoldenGraph(3, 7);
  const byKind = {};
  for (const node of graph.nodes) byKind[node.kind] = (byKind[node.kind] || 0) + 1;
  assert.equal(byKind.root, 1, '只有一个根');
  assert.ok(byKind.ubuddy >= 2, `协作线数 = ${byKind.ubuddy}`);
  assert.ok(byKind.agent_task >= 4, `工作单元数 = ${byKind.agent_task}`);
  assert.ok(byKind.agent_step >= 10, `子步骤数 = ${byKind.agent_step}`);
  assert.ok(graph.nodes.length >= SCHEMA.nodeCount.starMin && graph.nodes.length <= SCHEMA.nodeCount.starMax);
  assert.equal(isDag(graph), true);
  // 从根起的最长跳数必须过 8：否则"长程"这个前提在群任务族里就不成立了
  assert.ok(maxHopFrom(graph, topoIds(graph)[0]) >= 8);
  // 至少一条 6 步的步骤链 —— 链不够长，step 层就没有可注入的下游余量
  assert.ok(longestStepChain(graph) >= 6, `最长步骤链 = ${longestStepChain(graph)}`);
});

test('平铺族每个节点都是工作单元层（kind 有缺省，旧族不退化）', () => {
  const graph = generateGoldenGraph(0, 7);
  const byKind = {};
  for (const node of graph.nodes) byKind[node.kind] = (byKind[node.kind] || 0) + 1;
  assert.deepEqual(byKind, { agent_task: graph.nodes.length });
});

test('agent_step 上的漂移用 step 形态；缺依赖砍的是链，不是包含边', () => {
  const graph = generateGoldenGraph(3, 7);
  const steps = graph.nodes.filter((node) => node.kind === 'agent_step');
  const stepIds = new Set(steps.map((node) => node.id));
  const injected = [];
  for (const type of DRIFT_TYPES) {
    for (const node of steps) {
      const applied = applyLocalEdit(graph, type, node.id, 31);
      if (!applied.gold) continue;
      assert.ok(
        applied.gold.formId.includes('.step_'),
        `${type} 在 agent_step 上落回了 domain 形态：${applied.gold.formId}`,
      );
      if (type === 'missing_dependency') {
        // 砍掉的那条边必须来自另一个步骤（链），不能来自所属任务（包含）
        assert.ok(stepIds.has(applied.gold.edgeId.split('->')[0]), `砍到了包含边：${applied.gold.edgeId}`);
      }
      injected.push(type);
      break;
    }
  }
  // v4 的能力削减（**不是**"恰好没测到"）：step 层只承载 4/5 种漂移。
  // `wrong_acceptance` 依赖"验收标准被改松了"，而 plan step 的载荷只有 `{step, status}`
  // ——验收标准在这个层级没有来源，编一段 acceptance 文本就是造假。
  // 显式写死期望集合：将来谁把 wrong_acceptance 加回 STEP_CATALOG，这里会立刻红。
  assert.deepEqual(
    injected.sort(),
    ['local_replan', 'missing_dependency', 'wrong_agent', 'wrong_version'],
    'step 层只承载 4 种漂移，wrong_acceptance 必须缺席',
  );
  assert.deepEqual(Object.keys(STEP_TIER_MISSING_FORMS), ['wrong_acceptance']);
});

test('agent_step 的节点形状与真实投影一致：只有 title/status/agentId 有值', () => {
  const graph = generateGoldenGraph(3, 7);
  const steps = graph.nodes.filter((node) => node.kind === 'agent_step');
  assert.ok(steps.length >= 10);
  for (const step of steps) {
    assert.ok(step.title, '步骤名是 step 层唯一的文本信号');
    assert.equal(step.status, DEFAULT_NODE_STATUS, '两侧基线一致：status 只在漂移处变化');
    assert.ok(step.agentId, 'agentId 从所属任务继承，有值但不是独立信号');
    // 真实投影在 step 层一个字都不写（AGENT_PLAN_OBSERVATION §4.2 的实测表）。
    for (const field of ['role', 'artifact', 'stage', 'inputs', 'output', 'summary']) {
      assert.equal(step[field], '', `step 层的 ${field} 在产品上恒空，语料不许填`);
    }
    // version/acceptance 是归一化补的常量，与产品侧 PLAN_EXEC_CONSTANTS 逐字一致。
    assert.equal(step.version, 'v1');
    assert.equal(step.acceptance, 'standard');
  }
});

/**
 * 一条**端到端**的回归：step 层的四种漂移必须真的能被 gates 收下。
 *
 * 为什么单独要这一条：上面那条用例只验到 `applyLocalEdit` 能产出 `.step_` 形态，
 * 而 P2 的第一次全量生成里 `local_replan` 在 step 层**一条都没进语料**（manifest.stepForms
 * 只有三种），原因是 `insertLocalReplanStep` 插的新节点过不了 gates 的
 * `extra_node_unexplained`（那条判据只看 star 图上的后代，而新节点在 star 图里不存在）。
 * 形态"能生成"与样本"能存活"是两件事，中间隔着一整套门 —— 只测前者就会漏掉这个 bug。
 *
 * 所以这里走完整条链路：注入 → 级联 → 诱饵 → 声明 inserted_nodes → validateSample。
 */
test('step 层四种漂移都能活着过 gates（含插一环的 local_replan）', () => {
  const types = ['missing_dependency', 'wrong_agent', 'wrong_version', 'local_replan'];
  const survived = new Set();
  for (let index = 0; index < 12 && survived.size < types.length; index += 1) {
    const star = generateGoldenGraph(index, 7);
    for (const target of types) {
      if (survived.has(target)) continue;
      const steps = star.nodes.filter((node) => node.kind === 'agent_step');
      for (const step of steps) {
        const applied = applyLocalEdit(star, target, step.id, 41);
        if (!applied.gold?.formId?.includes('.step_')) continue;
        const prime = inferDownstream(star, applied.graph, applied.gold, { seed: 41 });
        const decoyed = addDecoyNodes(star, prime, applied.gold.nodeId, { seed: 43 });
        const sample = {
          id: `probe-${target}`, graph_id: star.graph_id, split: 'train',
          G_star: star, G_prime: decoyed.graph,
          label: {
            status: 'drift',
            injected_node: applied.gold.nodeId,
            injected_type: applied.gold.type,
            injected_edge: applied.gold.edgeId || '',
            injected_form: applied.gold.formId,
            decoy_nodes: decoyed.decoys,
            inserted_nodes: insertedNodesOf(applied.gold),
          },
        };
        if (validateSample(sample).length) continue;
        survived.add(target);
        break;
      }
    }
  }
  assert.deepEqual([...survived].sort(), [...types].sort(),
    'step 层的四种漂移都必须有能过 gates 的样本，否则缩窄后的 step 层等于白训');
});

test('插进链里的新节点必须显式声明，且必须真的挂在真凶下游', () => {
  const star = generateGoldenGraph(3, 7);
  const step = star.nodes.find((node) => node.kind === 'agent_step' && maxHopFrom(star, node.id) >= 3);
  const applied = applyLocalEdit(star, 'local_replan', step.id, 41);
  assert.ok(applied.gold.insertedNodeId, 'local_replan 在 step 层应该是结构性插入');
  const prime = inferDownstream(star, applied.graph, applied.gold, { seed: 41 });
  const decoyed = addDecoyNodes(star, prime, applied.gold.nodeId, { seed: 43 });
  const base = {
    id: 't-inserted', graph_id: star.graph_id, split: 'train',
    G_star: star, G_prime: decoyed.graph,
    label: {
      status: 'drift',
      injected_node: applied.gold.nodeId,
      injected_type: applied.gold.type,
      injected_edge: applied.gold.edgeId || '',
      injected_form: applied.gold.formId,
      decoy_nodes: decoyed.decoys,
    },
  };

  // 不声明 → 新节点是"无来由地长出来的"，必须被拦。这条正是 P2 全量生成踩到的坑。
  const undeclared = validateSample({ ...base, label: { ...base.label } });
  assert.ok(undeclared.some((problem) => problem.startsWith('extra_node_unexplained')),
    `不声明 inserted_nodes 时必须报 extra_node_unexplained，实际：${undeclared.join(',')}`);

  // 声明了就放行。
  assert.deepEqual(validateSample({ ...base, label: { ...base.label, inserted_nodes: [applied.gold.insertedNodeId] } }), []);

  // 但声明不是免检通行证：把插入节点说成不是它自己的东西，结构判据照样拦。
  const swapped = validateSample({
    ...base,
    label: { ...base.label, inserted_nodes: [applied.gold.insertedNodeId], injected_node: star.nodes[0].id },
  });
  assert.ok(swapped.length, '插入节点必须挂在真凶下游；不属于任何真凶时不许放行');
});

test('step 层的漂移沿链往下传，而不是直接跳到交付物', () => {  const graph = generateGoldenGraph(3, 7);
  const kinds = Object.fromEntries(graph.nodes.map((node) => [node.id, node.kind]));
  for (const node of graph.nodes.filter((item) => item.kind === 'agent_step')) {
    if (maxHopFrom(graph, node.id) < SCHEMA.minHopToFirstEffect) continue;
    const applied = applyLocalEdit(graph, 'wrong_version', node.id, 5);
    if (!applied.gold) continue;
    const prime = inferDownstream(graph, applied.graph, applied.gold, { seed: 5 });
    const changed = changedNodeIds(graph, prime).filter((id) => id !== node.id);
    assert.ok(changed.length, '注入必须留下可见后果');
    assert.ok(changed.some((id) => kinds[id] === 'agent_step'), '级联要先落在同一条链上');
    return;
  }
  assert.fail('没有任何 step 拿到足够的注入余量');
});

test('图顶层不得出现 status，节点上的 status 必须放行', () => {
  // v4 的关键一处收窄：status 从"任意位置禁止"改成"只在图顶层禁止"。
  //
  // 为什么不能继续按 token 拦：status 现在是 agent_step 层**唯一**有来源的漂移信号，
  // 按 token 拦会把每一个节点都判成泄漏（lib/sft.mjs 的 LEAK_KEYS 里那条注释记了这件事）。
  // 为什么又不能干脆不禁：`label.status`（drift / no_drift / UNKNOWN）就是答案本身，
  // 整块 label 并进图时必须仍然被拦。深度就是这两者之间的分界线。
  const withNodeStatus = {
    domain: 'research', title: 't',
    nodes: [{ id: 'n1', title: 'x', status: 'blocked' }],
    edges: [],
  };
  assert.deepEqual(graphHasForbiddenKeys(withNodeStatus), [], '节点上的 status 是合法字段');
  assert.deepEqual(stripForbiddenKeys(withNodeStatus), withNodeStatus, '节点上的 status 不许被剥掉');

  // 整块 label 并进图：status 落在顶层，必须被拦 + 被剥掉。
  const smuggled = { ...withNodeStatus, status: 'drift', injected_node: 'n1' };
  const hits = graphHasForbiddenKeys(smuggled);
  assert.ok(hits.includes('$.status'), `顶层 status 必须被拦，实际：${hits.join(',')}`);
  assert.ok(hits.includes('$.injected_node'), 'label 侧的其它键同样要拦');
  assert.equal(Object.hasOwn(stripForbiddenKeys(smuggled), 'status'), false);
  assert.equal(Object.hasOwn(stripForbiddenKeys(smuggled), 'injected_node'), false);

  // 真实语料两件事都要成立：节点的 status 在、顶层的 status 不在。
  const graph = generateGoldenGraph(3, 7);
  assert.deepEqual(graphHasForbiddenKeys(graph), []);
  assert.equal(Object.hasOwn(graph, 'status'), false);
  assert.ok(graph.nodes.every((node) => node.status === DEFAULT_NODE_STATUS));
});

test('层名 kind 不进 prompt，status 进：群任务族的 prompt 与平铺族同构', () => {
  const layered = generateGoldenGraph(3, 7);
  const flat = generateGoldenGraph(0, 7);
  // 群任务族确实带 kind（否则测试没意义）
  assert.ok(layered.nodes.some((node) => node.kind === 'agent_step'));
  const layeredRow = toSftRow({ ...minimalSample(layered) });
  assert.deepEqual(layeredRow.errors, []);
  const flatRow = toSftRow({ ...minimalSample(flat) });
  assert.deepEqual(flatRow.errors, []);
  // 两族的 prompt 字段集合必须一致 —— kind 不得混进来
  const fieldsOf = (prompt) => {
    const input = prompt.slice(prompt.indexOf('\nINPUT=') + 7);
    return [...new Set([...input.matchAll(/"(\w+)":/g)].map((match) => match[1]))].sort();
  };
  assert.deepEqual(fieldsOf(layeredRow.row.prompt), fieldsOf(flatRow.row.prompt));
  assert.equal(fieldsOf(layeredRow.row.prompt).includes('kind'), false);
  // v4：status 是**唯一**新增的可见字段，两族都要带。这条断言防的是"只给群任务族加 status"——
  // 那会让平铺族的 prompt 少一个字段，而模型是在同一个 prompt 模板上训的。
  assert.equal(fieldsOf(layeredRow.row.prompt).includes('status'), true);
  assert.equal(fieldsOf(flatRow.row.prompt).includes('status'), true);
});

/** 只为了拿到 prompt：造一条最小的漂移样本，其余字段照抄生成器的形状。 */
function minimalSample(graph) {
  const injection = pickInjection(graph, 21, 'wrong_version');
  const applied = applyLocalEdit(graph, 'wrong_version', injection.nodeId, 21);
  return {
    id: 'sample',
    graph_id: 'graph',
    split: 'train',
    G_star: graph,
    G_prime: applied.graph,
    label: { status: 'drift', injected_node: applied.gold.nodeId, injected_type: 'wrong_version' },
  };
}

function longestStepChain(graph) {  const steps = new Set(graph.nodes.filter((node) => node.kind === 'agent_step').map((node) => node.id));
  const next = new Map();
  for (const edge of graph.edges) {
    if (steps.has(edge.from) && steps.has(edge.to)) next.set(edge.from, edge.to);
  }
  let best = 0;
  for (const id of steps) {
    let cursor = id;
    let length = 1;
    const seen = new Set([id]);
    while (next.has(cursor)) {
      cursor = next.get(cursor);
      if (seen.has(cursor)) break;
      seen.add(cursor);
      length += 1;
    }
    best = Math.max(best, length);
  }
  return best;
}
