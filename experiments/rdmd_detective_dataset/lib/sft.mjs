import { DRIFT_TYPES, normalizeRichGraph } from './graph.mjs';

// v4：语料内容的版本，与 schema.json 同步。**它不是装饰性的字符串** ——
// `prepare_sft.mjs` 把它写进 `sft/manifest.json#schemaVersion`，而训练器
// （`scripts/train_qlora_rdmd.py`）把它原样记成 run manifest 的 `dataKind`。
// 也就是说这个字符串是"这个 adapter 是用哪一版语料训出来的"的**唯一**出处：
// 忘了升它，v4 的 adapter 会自称 v3，P3 的 v3↔v4 对照表和 P4 的"判定带出处"都会失据。
// （实测踩到过：v4 语料 + 未升版本 → `dataKind = rdmd_detective_sft_v3`。）
export const SFT_SCHEMA = 'rdmd_detective_sft_v4';

export const DETECTIVE_INSTRUCTION = [
  '你是反向侦探。输入是规划树 G_star 和执行树 G_prime。',
  '多数可见差异是后果。找出引起差异的最小漂移节点，不要把末端差异当成原因。',
  '只返回一个 JSON 对象，不要解释，不要 markdown。',
  '字段：status, nodeId, edgeId, type, evidenceNodeIds。',
  'status 只能是 drift、no_drift 或 UNKNOWN。',
  'type 只能是 missing_dependency、wrong_agent、wrong_version、wrong_acceptance、local_replan，或空字符串。',
  '两树相同时 status=no_drift，其余字段为空。',
  '存在多个不相交原因或证据不足时 status=UNKNOWN，不要编造唯一凶手。',
  'nodeId 必须是图中出现过的节点，evidenceNodeIds 只放定位证据，不要罗列全部变点。',
].join('');

const LEAK_KEYS = [
  'injected_node', 'injected_type', 'injected_form', 'injected_edge', 'injected_nodes',
  'injected_types', 'injected_forms', 'hop_to_first_effect', 'changed_node_ids',
  'generator_id', 'visibility', 'murderer', '"gold"', '"label"',
  // 层名（root/ubuddy/agent_task/agent_step）只给 planExecProximity 分层加权用，
  // 不在 11 字段契约里。它一旦进 prompt，模型就能靠"这个节点在第几层"作弊。
  '"kind"',
  // `status` 在 P2 之后是**合法节点字段**，所以不能按 token 拦（拦了会把每一步都判成泄漏）。
  // 它防标签的那一半改由「图顶层不得出现 status」这条结构化判据承担：
  // schema.json#forbiddenGraphRootKeys + lib/graph.mjs#graphHasForbiddenKeys(depth 0)。
  // 也就是说：节点上的 status 放行，整块 label 并进图仍然会被拦。
];

export function publicGraph(value) {
  const graph = normalizeRichGraph(value);
  return {
    domain: graph.domain,
    title: graph.title,
    topic: graph.topic,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      role: node.role,
      agentId: node.agentId,
      version: node.version,
      acceptance: node.acceptance,
      artifact: node.artifact,
      stage: node.stage,
      inputs: node.inputs,
      output: node.output,
      summary: node.summary,
      // P2 新增：执行状态。真实投影上 agent_step 层唯一有来源的漂移信号，
      // 必须与 Python `public_graph` 逐字同步，否则两侧的 prompt 会悄悄分叉。
      status: node.status,
    })),
    edges: graph.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })),
  };
}

export function completionOf(sample) {
  const label = sample.label || {};
  const status = label.status;
  if (status === 'no_drift') {
    return dump({ status: 'no_drift', nodeId: '', edgeId: '', type: '', evidenceNodeIds: [] });
  }
  if (status === 'UNKNOWN') {
    const evidence = Array.isArray(label.injected_nodes)
      ? label.injected_nodes.filter(Boolean)
      : [];
    return dump({ status: 'UNKNOWN', nodeId: '', edgeId: '', type: '', evidenceNodeIds: evidence });
  }
  if (status !== 'drift' || !DRIFT_TYPES.includes(label.injected_type) || !label.injected_node) {
    return null;
  }
  return dump({
    status: 'drift',
    nodeId: label.injected_node,
    edgeId: label.injected_edge || '',
    type: label.injected_type,
    evidenceNodeIds: [label.injected_node],
  });
}

export function promptOf(sample) {
  const payload = {
    G_star: publicGraph(sample.G_star),
    G_prime: publicGraph(sample.G_prime),
  };
  return `${DETECTIVE_INSTRUCTION}\nINPUT=${JSON.stringify(payload)}`;
}

export function toSftRow(sample, { supervised } = {}) {
  const completion = completionOf(sample);
  if (!completion) return { row: null, errors: ['completion_invalid'] };
  const prompt = promptOf(sample);
  const status = sample.label?.status;
  const row = {
    id: sample.id,
    graph_id: sample.graph_id,
    split: sample.split,
    status,
    supervised: Boolean(supervised ?? (status === 'drift' || status === 'no_drift')),
    prompt,
    completion,
    chars: prompt.length + completion.length,
  };
  return { row, errors: leakErrors(row, sample) };
}

export function leakErrors(row, sample = {}) {
  const errors = [];
  const prompt = row.prompt || '';
  const input = prompt.includes('\nINPUT=') ? prompt.slice(prompt.indexOf('\nINPUT=') + 7) : prompt;
  for (const token of LEAK_KEYS) {
    if (input.includes(token)) errors.push(`prompt_leak:${token}`);
  }
  const type = sample.label?.injected_type;
  if (type && input.includes(type)) errors.push(`prompt_type_leak:${type}`);
  const form = sample.label?.injected_form;
  if (form && input.includes(form)) errors.push(`prompt_form_leak:${form}`);
  if (row.completion && prompt.includes(row.completion)) errors.push('prompt_contains_completion');
  if (sample.label && prompt.includes('"injected_node"')) errors.push('prompt_has_label_block');
  return errors;
}

/**
 * v3: UNKNOWN is now part of the main loss. v2 trained only on drift / no_drift and the model
 * never learned to abstain (0/185 on the UNKNOWN eval split). Abstention has to be visible
 * during training for the "evidence is insufficient / several disjoint causes" branch to be
 * learnable at all.
 */
export function isMainSupervised(status) {
  return status === 'drift' || status === 'no_drift' || status === 'UNKNOWN';
}

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 1.6) + 48;
}

function dump(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}
