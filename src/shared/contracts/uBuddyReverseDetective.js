export const UBUDDY_RDMD_VERSION = 'ubuddy_reverse_detective_v1';
export const RDMD_DRIFT_TYPES = Object.freeze([
  'missing_dependency',
  'wrong_agent',
  'wrong_version',
  'wrong_acceptance',
  'local_replan',
]);

// 图分层。`kind` 是协作图节点的原生类型（uBuddyCollaborationGraph.js 的
// COLLABORATION_GRAPH_NODE_KINDS），透传到漂移图上供「相近度」按层加权。
// 空串 = 未知层，按中性权重 1 处理（保持旧数据不降级）。
export const RDMD_GRAPH_LAYERS = Object.freeze(['root', 'ubuddy', 'agent_task', 'agent_step']);

// 分层权重：容器层（root/ubuddy）比工作单元层（agent_task/agent_step）轻。
// 理由：级联真正发生在工作单元之间，容器变化本身不携带归因信息。
export const RDMD_LAYER_WEIGHTS = Object.freeze({
  root: 1,
  ubuddy: 2,
  agent_task: 4,
  agent_step: 4,
});

// 「相近效果」的默认口径。threshold 是「改一处即停」的停止阈值，
// 不是 1 —— 要求完全对齐执行图就等于过拟合，见 PLAN_EXEC_TRUTH.zh-CN.md。
export const RDMD_PROXIMITY_DEFAULTS = Object.freeze({
  nodeWeight: 0.5,
  edgeWeight: 0.5,
  threshold: 0.8,
});

export function normalizeDriftGraph(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map((node) => ({
    id: str(node.id || node.nodeId),
    title: str(node.title, 240),
    agentId: str(node.agentId, 160),
    version: str(node.version, 80) || 'v1',
    acceptance: str(node.acceptance, 80) || 'standard',
    role: str(node.role, 80),
    kind: str(node.kind, 40),
  })).filter((node) => node.id);
  const edges = (Array.isArray(source.edges) ? source.edges : []).map((edge) => ({
    id: str(edge.id) || `${str(edge.from)}->${str(edge.to)}`,
    from: str(edge.from),
    to: str(edge.to),
  })).filter((edge) => edge.from && edge.to);
  return { nodes, edges };
}

export function cloneDriftGraph(value = {}) {
  const graph = normalizeDriftGraph(value);
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

export function contrastDriftGraphs(plan = {}, exec = {}) {
  const left = normalizeDriftGraph(plan);
  const right = normalizeDriftGraph(exec);
  const leftNodes = Object.fromEntries(left.nodes.map((node) => [node.id, node]));
  const rightNodes = Object.fromEntries(right.nodes.map((node) => [node.id, node]));
  const leftEdges = new Set(left.edges.map(edgeKey));
  const rightEdges = new Set(right.edges.map(edgeKey));
  const involved = new Set();
  const extraNodes = [];
  const missingNodes = [];
  for (const id of new Set([...Object.keys(leftNodes), ...Object.keys(rightNodes)])) {
    const a = leftNodes[id];
    const b = rightNodes[id];
    if (!a) {
      extraNodes.push(id);
      involved.add(id);
      continue;
    }
    if (!b) {
      missingNodes.push(id);
      involved.add(id);
      continue;
    }
    if (a.agentId !== b.agentId || a.version !== b.version || a.acceptance !== b.acceptance || a.title !== b.title) {
      involved.add(id);
    }
  }
  for (const key of new Set([...leftEdges, ...rightEdges])) {
    if (leftEdges.has(key) === rightEdges.has(key)) continue;
    const [from, to] = key.split('->');
    if (!rightEdges.has(key)) involved.add(to);
    else {
      involved.add(from);
      involved.add(to);
    }
  }
  return {
    involvedNodeIds: [...involved],
    extraNodeIds: extraNodes,
    missingNodeIds: missingNodes,
    missingEdgeKeys: [...leftEdges].filter((key) => !rightEdges.has(key)),
    extraEdgeKeys: [...rightEdges].filter((key) => !leftEdges.has(key)),
    nodeCountDiff: right.nodes.length - left.nodes.length,
    edgeCountDiff: right.edges.length - left.edges.length,
  };
}

export function detectMinimalDrift(plan = {}, exec = {}) {
  const left = normalizeDriftGraph(plan);
  const right = normalizeDriftGraph(exec);
  const contrast = contrastDriftGraphs(left, right);
  if (!contrast.involvedNodeIds.length) {
    return { status: 'no_drift', nodeId: '', edgeId: '', type: '', evidenceNodeIds: [], contrast };
  }
  const parents = incomingIndex((right.edges.length ? right : left).edges);
  const involved = new Set(contrast.involvedNodeIds);
  const roots = contrast.involvedNodeIds.filter((id) => !hasInvolvedAncestor(id, parents, involved, new Set()));
  if (roots.length !== 1) {
    return {
      status: 'UNKNOWN',
      nodeId: '',
      edgeId: '',
      type: '',
      evidenceNodeIds: contrast.involvedNodeIds,
      contrast,
    };
  }
  const nodeId = roots[0];
  const type = classifyDrift(nodeId, left, right, contrast);
  const edgeId = type === 'missing_dependency'
    ? (contrast.missingEdgeKeys.find((key) => key.endsWith(`->${nodeId}`)) || '')
    : '';
  return {
    status: 'drift',
    nodeId,
    edgeId,
    type,
    evidenceNodeIds: [nodeId],
    contrast,
  };
}

export function injectMinimalDrift(plan = {}, { type = 'wrong_agent', nodeId = '', seed = 1 } = {}) {
  const graph = cloneDriftGraph(plan);
  const ids = graph.nodes.map((node) => node.id);
  const targetId = ids.includes(nodeId) ? nodeId : pickInjectableNode(graph, type, seed);
  if (!targetId) return { graph, gold: null };
  const target = graph.nodes.find((node) => node.id === targetId);
  if (type === 'wrong_agent') {
    target.agentId = `${target.agentId || 'agent'}_swap`;
    markDescendants(graph, targetId, (node) => { node.version = `${node.version}_d`; });
  } else if (type === 'wrong_version') {
    target.version = `${target.version}_stale`;
    markDescendants(graph, targetId, (node) => { node.version = `${node.version}_stale`; });
  } else if (type === 'wrong_acceptance') {
    target.acceptance = 'too_loose';
    appendRepairNodes(graph, targetId, 'rework');
  } else if (type === 'missing_dependency') {
    const incoming = graph.edges.filter((edge) => edge.to === targetId);
    if (!incoming.length) return { graph: cloneDriftGraph(plan), gold: null };
    const removed = incoming[0];
    graph.edges = graph.edges.filter((edge) => edge !== removed);
    markDescendants(graph, targetId, (node) => { node.version = `${node.version}_gap`; });
    appendRepairNodes(graph, targetId, 'retry');
    return {
      graph,
      gold: { nodeId: targetId, edgeId: removed.id, type, changedNodeIds: involvedAfter(plan, graph) },
    };
  } else if (type === 'local_replan') {
    appendRepairNodes(graph, targetId, 'replan');
    markDescendants(graph, targetId, (node) => { node.version = `${node.version}_rp`; });
  } else {
    return { graph: cloneDriftGraph(plan), gold: null };
  }
  return {
    graph,
    gold: { nodeId: targetId, edgeId: '', type, changedNodeIds: involvedAfter(plan, graph) },
  };
}

export function routeEvolution(detective = {}, swap = {}) {
  if (!detective || detective.status === 'no_drift') {
    return { action: 'record_only', reason: 'no_drift' };
  }
  if (detective.status === 'UNKNOWN' || !detective.type) {
    return { action: 'record_only', reason: 'unknown_drift' };
  }
  if (detective.type === 'wrong_agent') {
    return { action: 'similar_swap', reason: detective.type, swapDecision: swap.decision || 'pending' };
  }
  return { action: 'minimal_plan_edit', reason: detective.type };
}

// ---------- 「相近效果」度量与「改一处即停」 ----------
//
// 语义（见 ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md）：
//   - G_plan 与 G_exec 不必收敛到相等；只要改一处规划后「相近度」达阈值即停。
//   - 这是防过拟合的机制：无限向执行图靠拢 = 把这一次的现实当成普遍规律。
//   - 真值是「成功任务」的 G_exec；失败/取消的 run 只产出诊断，不当真值。

export function planExecProximity(plan = {}, exec = {}, options = {}) {
  const left = normalizeDriftGraph(plan);
  const right = normalizeDriftGraph(exec);
  const weights = { ...RDMD_LAYER_WEIGHTS, ...(options.layerWeights || {}) };
  const nodeWeight = positiveOrDefault(options.nodeWeight, RDMD_PROXIMITY_DEFAULTS.nodeWeight);
  const edgeWeight = positiveOrDefault(options.edgeWeight, RDMD_PROXIMITY_DEFAULTS.edgeWeight);

  const leftById = new Map(left.nodes.map((node) => [node.id, node]));
  const rightById = new Map(right.nodes.map((node) => [node.id, node]));
  let planTotal = 0;
  let execTotal = 0;
  let matched = 0;
  let matchedNodeCount = 0;
  for (const node of left.nodes) planTotal += layerWeight(node, weights);
  for (const node of right.nodes) execTotal += layerWeight(node, weights);
  for (const [id, planNode] of leftById) {
    const execNode = rightById.get(id);
    if (!execNode) continue;
    // 匹配上的节点不止要「在」，还要「对得上」。
    //
    // 只按 id 匹配会让 actor 层面的漂移完全不可见：规划说 research_agent、现实是 intern_scribe，
    // 节点集合与边集合一模一样 → 相近度 1.0 → `minimalPlanEdits` 报 alreadySatisfied、
    // 返回 minimal: null。于是系统最在意的 wrong_agent 恰好成了唯一修不了的漂移 ——
    // 而 `singlePlanEdits` 明明已经为它准备好了 align_node。所以匹配权重再乘一个字段一致率。
    matched += Math.min(layerWeight(planNode, weights), layerWeight(execNode, weights))
      * fieldAgreement(planNode, execNode);
    matchedNodeCount += 1;
  }
  const recall = planTotal > 0 ? matched / planTotal : execTotal > 0 ? 0 : 1;
  const precision = execTotal > 0 ? matched / execTotal : planTotal > 0 ? 0 : 1;
  const nodeScore = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;

  const leftEdges = new Set(left.edges.map(edgeKey));
  const rightEdges = new Set(right.edges.map(edgeKey));
  const unionEdges = new Set([...leftEdges, ...rightEdges]);
  let sharedEdges = 0;
  for (const key of unionEdges) if (leftEdges.has(key) && rightEdges.has(key)) sharedEdges += 1;
  const edgeScore = unionEdges.size ? sharedEdges / unionEdges.size : 1;

  const totalWeight = nodeWeight + edgeWeight;
  const score = totalWeight > 0 ? (nodeScore * nodeWeight + edgeScore * edgeWeight) / totalWeight : 0;
  return {
    score,
    nodeScore,
    edgeScore,
    nodePrecision: precision,
    nodeRecall: recall,
    matchedNodeCount,
    planNodeCount: left.nodes.length,
    execNodeCount: right.nodes.length,
    planEdgeCount: left.edges.length,
    execEdgeCount: right.edges.length,
  };
}

export function reachesProximity(plan = {}, exec = {}, options = {}) {
  const threshold = positiveOrDefault(options.threshold, RDMD_PROXIMITY_DEFAULTS.threshold);
  const proximity = planExecProximity(plan, exec, options);
  return { reached: proximity.score >= threshold, threshold, proximity };
}

// 单处规划改动：把执行图里已有的东西搬一处到规划图上（或删掉规划图里多的一处）。
// 刻意不从「凭空发明」出发 —— 自进化的候选必须来自真实执行过的现实。
export function singlePlanEdits(plan = {}, exec = {}) {
  const left = normalizeDriftGraph(plan);
  const right = normalizeDriftGraph(exec);
  const leftById = new Map(left.nodes.map((node) => [node.id, node]));
  const rightById = new Map(right.nodes.map((node) => [node.id, node]));
  const leftEdges = new Map(left.edges.map((edge) => [edgeKey(edge), edge]));
  const rightEdges = new Map(right.edges.map((edge) => [edgeKey(edge), edge]));
  const edits = [];
  for (const [id, execNode] of rightById) {
    const planNode = leftById.get(id);
    if (!planNode) {
      edits.push({ op: 'add_node', nodeId: id, node: { ...execNode } });
      continue;
    }
    const fields = ['title', 'agentId', 'version', 'acceptance', 'role', 'kind']
      .filter((field) => String(planNode[field] || '') !== String(execNode[field] || ''));
    if (fields.length) edits.push({ op: 'align_node', nodeId: id, fields, node: { ...execNode } });
  }
  for (const id of leftById.keys()) if (!rightById.has(id)) edits.push({ op: 'drop_node', nodeId: id });
  for (const [key, edge] of rightEdges) {
    if (!leftEdges.has(key)) edits.push({ op: 'add_edge', edgeId: edge.id, edge: { ...edge } });
  }
  for (const [key, edge] of leftEdges) {
    if (!rightEdges.has(key)) edits.push({ op: 'drop_edge', edgeId: edge.id, edge: { ...edge } });
  }
  return edits;
}

export function applyPlanEdit(plan = {}, edit = {}) {
  const graph = cloneDriftGraph(plan);
  if (edit.op === 'add_node' && edit.node) {
    if (!graph.nodes.some((node) => node.id === edit.node.id)) graph.nodes.push({ ...edit.node });
  } else if (edit.op === 'align_node' && edit.node) {
    graph.nodes = graph.nodes.map((node) => (node.id === edit.node.id ? { ...node, ...edit.node } : node));
  } else if (edit.op === 'drop_node') {
    graph.nodes = graph.nodes.filter((node) => node.id !== edit.nodeId);
    graph.edges = graph.edges.filter((edge) => edge.from !== edit.nodeId && edge.to !== edit.nodeId);
  } else if (edit.op === 'add_edge' && edit.edge) {
    if (!graph.edges.some((edge) => edgeKey(edge) === edgeKey(edit.edge))) graph.edges.push({ ...edit.edge });
  } else if (edit.op === 'drop_edge') {
    graph.edges = graph.edges.filter((edge) => edge.id !== edit.edgeId);
  }
  return graph;
}

// 「改一处即停」：找一处规划改动，使相近度达阈值就算成功，不追求完全对齐。
export function minimalPlanEdits(plan = {}, exec = {}, options = {}) {
  const threshold = positiveOrDefault(options.threshold, RDMD_PROXIMITY_DEFAULTS.threshold);
  const proximity = planExecProximity(plan, exec, options);
  if (proximity.score >= threshold) {
    return { reached: true, alreadySatisfied: true, threshold, proximity, minimal: null, edits: [], evaluated: 0 };
  }
  const candidates = Array.isArray(options.candidates) ? options.candidates : singlePlanEdits(plan, exec);
  const limit = Math.max(1, Math.floor(positiveOrDefault(options.limit, 24)));
  const sufficient = [];
  let best = null;
  let evaluated = 0;
  for (const edit of candidates.slice(0, limit)) {
    const after = planExecProximity(applyPlanEdit(plan, edit), exec, options);
    evaluated += 1;
    const candidate = { edit, proximity: after };
    if (!best || after.score > best.proximity.score) best = candidate;
    if (after.score >= threshold) sufficient.push(candidate);
  }
  sufficient.sort((a, b) => editCost(a.edit) - editCost(b.edit) || b.proximity.score - a.proximity.score);
  return {
    reached: sufficient.length > 0,
    alreadySatisfied: false,
    threshold,
    proximity,
    minimal: sufficient[0] || null,
    edits: sufficient.map((item) => item.edit),
    best,
    evaluated,
  };
}

// 「最小」的排序口径：改已有节点的字段 < 加一条边 < 加一个节点 < 删东西。
function editCost(edit = {}) {
  if (edit.op === 'align_node') return 1 + (Array.isArray(edit.fields) ? edit.fields.length : 0) * 0.1;
  if (edit.op === 'add_edge') return 2;
  if (edit.op === 'add_node') return 3;
  if (edit.op === 'drop_edge') return 4;
  if (edit.op === 'drop_node') return 5;
  return 6;
}

function layerWeight(node = {}, weights = RDMD_LAYER_WEIGHTS) {
  const value = weights[String(node.kind || '')];
  return Number.isFinite(value) && value > 0 ? value : 1;
}

// 「对得上」的字段口径。刻意不含 `kind`：层身份已经通过 layerWeight 参与计分，
// 再算一次就是双重计数。也不含 `id`：id 相同是能进入这个循环的前提。
// `status` 这类运行时字段同样不算 —— 它描述的是「进行到哪」，不是「规划对不对」。
const RDMD_COMPARED_FIELDS = Object.freeze(['title', 'agentId', 'version', 'acceptance', 'role']);

function fieldAgreement(left = {}, right = {}) {
  let agreed = 0;
  for (const field of RDMD_COMPARED_FIELDS) {
    if (String(left[field] || '') === String(right[field] || '')) agreed += 1;
  }
  return agreed / RDMD_COMPARED_FIELDS.length;
}

function positiveOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function classifyDrift(nodeId, plan, exec, contrast) {
  const left = plan.nodes.find((node) => node.id === nodeId);
  const right = exec.nodes.find((node) => node.id === nodeId);
  if (contrast.missingEdgeKeys.some((key) => key.endsWith(`->${nodeId}`))) return 'missing_dependency';
  if (left && right && left.agentId !== right.agentId) return 'wrong_agent';
  if (left && right && left.version !== right.version && left.acceptance === right.acceptance) return 'wrong_version';
  if (left && right && left.acceptance !== right.acceptance) return 'wrong_acceptance';
  if (contrast.extraNodeIds.length) return 'local_replan';
  return 'local_replan';
}

function pickInjectableNode(graph, type, seed) {
  const order = topo(graph);
  if (!order.length) return '';
  if (type === 'missing_dependency') {
    const withIncoming = order.filter((id) => graph.edges.some((edge) => edge.to === id));
    return withIncoming[Math.abs(seed) % withIncoming.length] || '';
  }
  const internal = order.slice(0, Math.max(1, order.length - 1));
  return internal[Math.abs(seed) % internal.length] || order[0];
}

function markDescendants(graph, rootId, mutate) {
  const children = outgoingIndex(graph.edges);
  const stack = [...(children.get(rootId) || [])];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.find((item) => item.id === id);
    if (node) mutate(node);
    stack.push(...(children.get(id) || []));
  }
}

function appendRepairNodes(graph, parentId, kind) {
  const first = `${parentId}_${kind}_a`;
  const second = `${parentId}_${kind}_b`;
  graph.nodes.push(
    { id: first, title: `${kind} a`, agentId: 'repair', version: 'v1', acceptance: 'standard', role: kind },
    { id: second, title: `${kind} b`, agentId: 'repair', version: 'v1', acceptance: 'standard', role: kind },
  );
  graph.edges.push({ id: `${parentId}->${first}`, from: parentId, to: first });
  graph.edges.push({ id: `${first}->${second}`, from: first, to: second });
  const outgoing = graph.edges.filter((edge) => edge.from === parentId && edge.to !== first);
  if (outgoing.length) {
    const hop = outgoing[0];
    hop.from = second;
    hop.id = `${second}->${hop.to}`;
  }
}

function involvedAfter(plan, exec) {
  return contrastDriftGraphs(plan, exec).involvedNodeIds;
}

function incomingIndex(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!map.has(edge.to)) map.set(edge.to, []);
    map.get(edge.to).push(edge.from);
  }
  return map;
}

function outgoingIndex(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!map.has(edge.from)) map.set(edge.from, []);
    map.get(edge.from).push(edge.to);
  }
  return map;
}

function hasInvolvedAncestor(id, parents, involved, visiting) {
  const stack = [...(parents.get(id) || [])];
  const seen = new Set();
  while (stack.length) {
    const parent = stack.pop();
    if (seen.has(parent) || visiting.has(parent)) continue;
    seen.add(parent);
    if (involved.has(parent)) return true;
    stack.push(...(parents.get(parent) || []));
  }
  return false;
}

function topo(graph) {
  const indeg = Object.fromEntries(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (indeg[edge.to] != null) indeg[edge.to] += 1;
  }
  const queue = Object.entries(indeg).filter(([, value]) => value === 0).map(([id]) => id);
  const order = [];
  const children = outgoingIndex(graph.edges);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const child of children.get(id) || []) {
      indeg[child] -= 1;
      if (indeg[child] === 0) queue.push(child);
    }
  }
  return order;
}

function edgeKey(edge) {
  return `${edge.from}->${edge.to}`;
}

function str(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
