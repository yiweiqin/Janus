import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(ROOT, '../schema.json'), 'utf8').replace(/^\uFEFF/, ''));
export const DRIFT_TYPES = SCHEMA.driftTypes;
// 任意层级都禁止的键：这些是标签/生成器内部字段，出现在图的任何角落都是泄漏。
export const FORBIDDEN_GRAPH_KEYS = SCHEMA.forbiddenGraphKeys;
// **只在图顶层**禁止的键。
//
// `status` 是 P2 新增的合法**节点**字段（真实协作图上 `collaboration_graph_nodes.status`
// 对每种 kind 都存在，是 agent_step 层唯一的漂移信号）。但它同时是**标签**的字段名
// （`sample.label.status`），所以不能简单地放行 —— 放行「任意位置的 status」等于允许把
// 标签混进图里而不被发现。
//
// 于是把判据按深度分开：图自己的键（depth 0）不许有 `status`，节点对象里的 `status` 合法。
// `graphHasForbiddenKeys` 的 depth 就是干这个的，不需要再引一层遍历。
export const FORBIDDEN_GRAPH_ROOT_KEYS = Object.freeze(SCHEMA.forbiddenGraphRootKeys || ['status']);
// 与产品侧协作图同词表（uBuddyCollaborationGraph.js 的 COLLABORATION_GRAPH_NODE_KINDS）。
export const NODE_KINDS = Object.freeze(SCHEMA.nodeKinds || ['root', 'ubuddy', 'agent_task', 'agent_step']);
export const NODE_STATUSES = Object.freeze(SCHEMA.nodeStatuses || []);

// 语料里节点的**基线**状态。取 `completed` 而不是 `''` 或 `queued`：
//   - 真实执行图上绝大多数节点在任务结束时就是 completed；
//   - 两侧（G_star / G_prime）取同一个基线，于是「只有漂移才会改变 status」这个
//     训练不变量成立 —— 否则每个节点都成了"变点"，firstEffectHop 与
//     changed_outside_descendants 这两条闸门会直接失效。
export const DEFAULT_NODE_STATUS = 'completed';

export function normalizeRichGraph(value = {}) {
  const source = object(value);
  const nodes = array(source.nodes).map((node) => ({
    id: text(node.id || node.nodeId, 80),
    title: text(node.title, 240),
    role: text(node.role, 80),
    agentId: text(node.agentId, 160) || 'agent',
    version: text(node.version, 80) || 'v1',
    acceptance: text(node.acceptance, 80) || 'standard',
    artifact: text(node.artifact, 240),
    stage: text(node.stage, 80),
    inputs: text(node.inputs, 600),
    output: text(node.output, 600),
    summary: text(node.summary, 800),
    // 层名。**不进 11 字段的模型契约**（lib/sft.mjs 的 publicGraph 与 Python 的
    // public_graph 都只取上面 11 个），所以对模型是无害的多余字段；但它对「相近度」
    // 度量是承重的：planExecProximity 按层加权，容器层（root/ubuddy）比工作单元层轻。
    // 缺省是 agent_task：旧的平铺图族每个节点本身就是"一个工作单元"。
    kind: NODE_KINDS.includes(text(node.kind, 40)) ? text(node.kind, 40) : 'agent_task',
    // 执行状态。**不进 11 字段的模型契约**（和 kind 一样，`publicGraph` 之外），
    // 但它进 prompt 的节点形状（P2 起），而且它是 agent_step 层唯一真实的漂移信号：
    // 真实投影里被后续计划版本砍掉的步骤会被标成 cancelled。
    //
    // 为什么不像 kind 那样只留给度量：kind 是**层名**，模型能靠"第几层"作弊；
    // status 是**执行事实**，而且真实 G_plan/G_exec 的差异恰好落在它上面，藏起来
    // 等于把唯一信号从模型眼前拿掉。反过来，正因为它是强信号，才必须配一条
    // 只看 status 的捷径守卫（validate.mjs 的 statusShortcutBaseline）。
    status: text(node.status, 40) || DEFAULT_NODE_STATUS,
  })).filter((node) => node.id);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = array(source.edges).map((edge) => ({
    id: text(edge.id, 160) || `${text(edge.from)}->${text(edge.to)}`,
    from: text(edge.from, 80),
    to: text(edge.to, 80),
  })).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to);
  return {
    graph_id: text(source.graph_id, 160),
    domain: text(source.domain, 80),
    title: text(source.title, 240),
    topic: text(source.topic, 160),
    nodes,
    edges,
  };
}

export function cloneRichGraph(value) {
  const graph = normalizeRichGraph(value);
  return {
    graph_id: graph.graph_id,
    domain: graph.domain,
    title: graph.title,
    topic: graph.topic,
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

export function structuralGraph(value) {
  const graph = normalizeRichGraph(value);
  return {
    nodes: graph.nodes.map(({ id, title, role, agentId, version, acceptance }) => ({
      id, title, role, agentId, version, acceptance,
    })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

export function nodeMap(graph) {
  return Object.fromEntries(normalizeRichGraph(graph).nodes.map((node) => [node.id, node]));
}

export function outgoing(graph) {
  const map = new Map();
  for (const edge of normalizeRichGraph(graph).edges) {
    if (!map.has(edge.from)) map.set(edge.from, []);
    map.get(edge.from).push(edge.to);
  }
  return map;
}

export function incoming(graph) {
  const map = new Map();
  for (const edge of normalizeRichGraph(graph).edges) {
    if (!map.has(edge.to)) map.set(edge.to, []);
    map.get(edge.to).push(edge.from);
  }
  return map;
}

export function topoIds(graph) {
  const normalized = normalizeRichGraph(graph);
  const indeg = Object.fromEntries(normalized.nodes.map((node) => [node.id, 0]));
  for (const edge of normalized.edges) indeg[edge.to] += 1;
  const queue = Object.entries(indeg).filter(([, value]) => value === 0).map(([id]) => id);
  const kids = outgoing(normalized);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const child of kids.get(id) || []) {
      indeg[child] -= 1;
      if (indeg[child] === 0) queue.push(child);
    }
  }
  return order;
}

export function isDag(graph) {
  const normalized = normalizeRichGraph(graph);
  return topoIds(normalized).length === normalized.nodes.length && normalized.nodes.length > 0;
}

export function hopDistance(graph, fromId, toId) {
  if (fromId === toId) return 0;
  const kids = outgoing(graph);
  const queue = [[fromId, 0]];
  const seen = new Set([fromId]);
  while (queue.length) {
    const [id, depth] = queue.shift();
    for (const child of kids.get(id) || []) {
      if (seen.has(child)) continue;
      if (child === toId) return depth + 1;
      seen.add(child);
      queue.push([child, depth + 1]);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function maxHopFrom(graph, rootId) {
  const desc = descendantsOf(graph, rootId);
  if (!desc.length) return 0;
  return Math.max(...desc.map((id) => hopDistance(graph, rootId, id)));
}

export function firstEffectHop(star, prime, goldId) {
  const changed = new Set(changedNodeIds(star, prime));
  const hops = descendantsOf(star, goldId)
    .filter((id) => changed.has(id))
    .map((id) => hopDistance(star, goldId, id))
    .filter((hop) => Number.isFinite(hop));
  return hops.length ? Math.min(...hops) : 0;
}

export function descendantsOf(graph, rootId) {
  const kids = outgoing(graph);
  const seen = new Set();
  const stack = [...(kids.get(rootId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(kids.get(id) || []));
  }
  return [...seen];
}

export function ancestorsOf(graph, rootId) {
  const parents = incoming(graph);
  const seen = new Set();
  const stack = [...(parents.get(rootId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parents.get(id) || []));
  }
  return [...seen];
}

export function siblingInjectablePairs(graph) {
  const normalized = normalizeRichGraph(graph);
  const ids = normalized.nodes.map((node) => node.id);
  const desc = Object.fromEntries(ids.map((id) => [id, new Set(descendantsOf(normalized, id))]));
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      if (desc[a].has(b) || desc[b].has(a) || a === b) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

export function changedNodeIds(left, right) {
  const a = normalizeRichGraph(left);
  const b = normalizeRichGraph(right);
  const leftNodes = nodeMap(a);
  const rightNodes = nodeMap(b);
  const changed = new Set();
  for (const id of new Set([...Object.keys(leftNodes), ...Object.keys(rightNodes)])) {
    if (JSON.stringify(leftNodes[id] || null) !== JSON.stringify(rightNodes[id] || null)) changed.add(id);
  }
  const leftEdges = new Set(a.edges.map((edge) => `${edge.from}->${edge.to}`));
  const rightEdges = new Set(b.edges.map((edge) => `${edge.from}->${edge.to}`));
  for (const key of new Set([...leftEdges, ...rightEdges])) {
    if (leftEdges.has(key) === rightEdges.has(key)) continue;
    const [from, to] = key.split('->');
    if (to) changed.add(to);
    if (!from) continue;
    const fromNodeChanged = JSON.stringify(leftNodes[from] || null) !== JSON.stringify(rightNodes[from] || null);
    const fromAppeared = Boolean(leftNodes[from]) !== Boolean(rightNodes[from]);
    if (fromNodeChanged || fromAppeared) changed.add(from);
  }
  return [...changed];
}

/**
 * 去掉任何层级的禁词；**同时**去掉图顶层独有的禁词（`status`）。
 *
 * `depth === 0` 就是被调用时传进来的那个对象本身 —— 对 `G_star` / `G_prime` 而言
 * 正好是「图自己的键」。节点对象在 depth 2，所以节点上的 `status` 会保留。
 */
export function stripForbiddenKeys(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => stripForbiddenKeys(item, depth + 1));
  if (typeof value !== 'object') return value;
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (FORBIDDEN_GRAPH_KEYS.includes(key)) continue;
    if (depth === 0 && FORBIDDEN_GRAPH_ROOT_KEYS.includes(key)) continue;
    result[key] = stripForbiddenKeys(raw, depth + 1);
  }
  return result;
}

/**
 * 任意层级的禁词都在任意深度报出；图顶层独有的禁词只在 `depth === 0` 报出。
 *
 * 「只判顶层」是为了让 `status` 这个**节点**字段合法（它是 agent_step 层唯一的漂移
 * 信号），同时继续拦住把 `label.status` 整块并进图的写法 —— 那种泄漏一旦发生，
 * 模型能直接从图根读到答案。
 */
export function graphHasForbiddenKeys(value, depth = 0, path = '$') {
  if (depth > 8 || value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => graphHasForbiddenKeys(item, depth + 1, `${path}[${index}]`));
  }
  if (typeof value !== 'object') return [];
  const hits = [];
  for (const [key, raw] of Object.entries(value)) {
    if (FORBIDDEN_GRAPH_KEYS.includes(key)) hits.push(`${path}.${key}`);
    if (depth === 0 && FORBIDDEN_GRAPH_ROOT_KEYS.includes(key)) hits.push(`${path}.${key}`);
    hits.push(...graphHasForbiddenKeys(raw, depth + 1, `${path}.${key}`));
  }
  return hits;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
