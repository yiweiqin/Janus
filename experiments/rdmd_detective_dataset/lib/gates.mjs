import {
  ancestorsOf,
  changedNodeIds,
  descendantsOf,
  firstEffectHop,
  graphHasForbiddenKeys,
  hopDistance,
  isDag,
  maxHopFrom,
  normalizeRichGraph,
} from './graph.mjs';
import { renderedOrderIsTopological } from './obfuscate.mjs';
import { DRIFT_TYPES, SCHEMA } from './graph.mjs';

export function validateSample(sample = {}, { requireSplit = false } = {}) {
  const errors = [];
  if (!sample || typeof sample !== 'object') return ['sample_not_object'];
  const star = normalizeRichGraph(sample.G_star);
  const prime = normalizeRichGraph(sample.G_prime);
  const label = sample.label && typeof sample.label === 'object' ? sample.label : {};
  if (!sample.id) errors.push('id_missing');
  if (!sample.graph_id) errors.push('graph_id_missing');
  if (requireSplit && !['train', 'development', 'test'].includes(sample.split)) errors.push('split_invalid');
  if (!isDag(star)) errors.push('star_not_dag');
  if (!isDag(prime)) errors.push('prime_not_dag');
  const starMin = SCHEMA.nodeCount?.starMin || 16;
  const starMax = SCHEMA.nodeCount?.starMax || 32;
  const primeMax = SCHEMA.nodeCount?.primeMax || 40;
  if (star.nodes.length < starMin || star.nodes.length > starMax) errors.push('star_node_count');
  if (prime.nodes.length < starMin || prime.nodes.length > primeMax) errors.push('prime_node_count');
  errors.push(...graphHasForbiddenKeys(star).map((path) => `star_forbidden:${path}`));
  errors.push(...graphHasForbiddenKeys(prime).map((path) => `prime_forbidden:${path}`));
  errors.push(...textLeaks(star, 'star'));
  errors.push(...textLeaks(prime, 'prime'));
  if (!SCHEMA.status.includes(label.status)) errors.push('status_invalid');

  if (label.status === 'no_drift') {
    if (JSON.stringify(nodesAndEdges(star)) !== JSON.stringify(nodesAndEdges(prime))) errors.push('no_drift_graphs_differ');
    if (label.injected_node) errors.push('no_drift_has_injected_node');
    return unique(errors);
  }

  const goldNodes = label.status === 'UNKNOWN'
    ? array(label.injected_nodes).length ? array(label.injected_nodes) : [label.injected_node, label.injected_node_b]
    : [label.injected_node];
  const cleanGold = goldNodes.filter(Boolean);
  if (!cleanGold.length) errors.push('gold_node_missing');
  for (const nodeId of cleanGold) {
    if (!star.nodes.some((node) => node.id === nodeId)) errors.push(`gold_absent_in_star:${nodeId}`);
    if (!prime.nodes.some((node) => node.id === nodeId) && label.status !== 'UNKNOWN') {
      errors.push(`gold_absent_in_prime:${nodeId}`);
    }
    if (label.status === 'drift' && !DRIFT_TYPES.includes(label.injected_type)) errors.push('type_invalid');
  }

  const changed = changedNodeIds(star, prime);
  if (!changed.length) errors.push('no_visible_difference');
  sample.changed_node_ids = changed;

  const decoys = array(label.decoy_nodes).filter(Boolean);
  for (const decoy of decoys) {
    if (!prime.nodes.some((node) => node.id === decoy)) errors.push(`decoy_absent_in_prime:${decoy}`);
    if (star.nodes.some((node) => node.id === decoy)) errors.push(`decoy_present_in_star:${decoy}`);
    if (cleanGold.includes(decoy)) errors.push(`decoy_is_gold:${decoy}`);
    if (descendantsOf(star, decoy).some((id) => changed.includes(id))) errors.push(`decoy_has_cascade:${decoy}`);
    for (const gold of cleanGold) {
      if (descendantsOf(star, gold).includes(decoy) || ancestorsOf(star, gold).includes(decoy)) {
        errors.push(`decoy_inside_gold_branch:${decoy}`);
      }
    }
  }

  // 新节点的第二种合法来源：**注入本身**（`local_replan` 在 step 链上插一环）。
  // 它既不是真凶也不是诱饵，所以必须显式声明；但光声明不算数，还要过结构判据 ——
  // 否则这张"通行证"可以顺手塞进任何东西。
  const inserted = array(label.inserted_nodes).filter(Boolean);
  for (const id of inserted) {
    if (!prime.nodes.some((node) => node.id === id)) errors.push(`inserted_absent_in_prime:${id}`);
    if (star.nodes.some((node) => node.id === id)) errors.push(`inserted_present_in_star:${id}`);
    if (cleanGold.includes(id)) errors.push(`inserted_is_gold:${id}`);
    if (decoys.includes(id)) errors.push(`inserted_is_decoy:${id}`);
    // 结构判据：真的挂在某个真凶的**下游**（prime 图）才叫"这一步被插进了链里"。
    // 挂在别处或挂成孤立点，就是无来由地长节点，照样拦。
    const hangsOffGold = cleanGold.some((gold) => descendantsOf(prime, gold).includes(id));
    if (!hangsOffGold) errors.push(`inserted_not_downstream_of_gold:${id}`);
  }

  for (const id of changed) {
    const isExtra = !star.nodes.some((node) => node.id === id);
    if (isExtra) {
      // v3: brand new nodes must be either downstream consequences of the gold node,
      // declared innocent decoys, or **the injection's own insertion** (local_replan 插一环)。
      //
      // 第三条是 v4 补的。原判据只认"gold 在 **star 图** 上的后代"，而插入的节点在 star 图里
      // 根本不存在 —— 于是**所有**结构性 local_replan 样本都被判死（实测 step 层 223/223 全灭），
      // 只剩"标题里写一句『并入下一环』"这种可背诵的形态。那正是本文件别处最反对的事：
      // 把结构信号换成一句可背的话。
      //
      // 注意这里**仍然只查 star 图**（不是 prime）。改成 prime 会把 addRepair 的修补节点
      // 也一并放行 —— 那是另一个独立的行为变更，不该夹在 P2 里悄悄发生。
      // 插入节点走的是显式声明 + 结构判据那条路（见上面 inserted 那一节）。
      const explained = cleanGold.some((gold) => descendantsOf(star, gold).includes(id))
        || decoys.includes(id)
        || inserted.includes(id);
      if (!explained) errors.push(`extra_node_unexplained:${id}`);
      continue;
    }
    const ok = cleanGold.some((gold) => id === gold || descendantsOf(star, gold).includes(id));
    if (!ok) errors.push(`changed_outside_descendants:${id}`);
  }

  for (const [name, graph] of [['star', star], ['prime', prime]]) {
    const order = renderedOrderIsTopological(graph);
    if (order.byId) errors.push(`${name}_id_order_topological`);
    if (order.byArray) errors.push(`${name}_array_order_topological`);
  }

  if (label.status === 'drift' && !decoys.length) errors.push('drift_without_decoy');

  for (const gold of cleanGold) {
    for (const ancestor of ancestorsOf(star, gold)) {
      const left = star.nodes.find((node) => node.id === ancestor);
      const right = prime.nodes.find((node) => node.id === ancestor);
      if (right && JSON.stringify(left) !== JSON.stringify(right) && !cleanGold.includes(ancestor)) {
        errors.push(`ancestor_mutated:${ancestor}`);
      }
    }
  }

  if (label.status === 'drift') {
    if (changed.includes(label.injected_node) === false) {
      const descChanged = descendantsOf(star, label.injected_node).some((id) => changed.includes(id));
      if (!descChanged) errors.push('gold_has_no_effect');
    }
    const hop = firstEffectHop(star, prime, label.injected_node);
    sample.label.hop_to_first_effect = hop;
    if (maxHopFrom(star, label.injected_node) < SCHEMA.minHopToFirstEffect) errors.push('inject_path_too_short');
    if (hop < SCHEMA.minHopToFirstEffect) errors.push(`first_effect_too_near:${hop}`);
    if (quietHopsMutated(star, prime, label.injected_node, hop)) errors.push('mid_hops_mutated');
  }
  return unique(errors);
}

function quietHopsMutated(star, prime, goldId, firstHop) {
  if (firstHop < 2) return false;
  const changed = new Set(changedNodeIds(star, prime));
  return descendantsOf(star, goldId).some((id) => {
    const hop = hopDistance(star, goldId, id);
    return hop > 0 && hop < firstHop && changed.has(id);
  });
}

function textLeaks(graph, prefix) {
  const blob = JSON.stringify(nodesAndEdges(graph));
  return (SCHEMA.forbiddenText || [])
    .filter((token) => token && blob.includes(token))
    .map((token) => `${prefix}_text_leak:${token}`);
}

function nodesAndEdges(graph) {
  return { nodes: graph.nodes, edges: graph.edges };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values)];
}
