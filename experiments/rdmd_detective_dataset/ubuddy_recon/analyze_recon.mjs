#!/usr/bin/env node
/**
 * uBuddy 数据侦察：七项测量 + 11 字段契约映射。
 *
 * 只读 `export_ubuddy_task_samples.mjs` 落下的文件，不需要 DB、不需要 GPU、不需要模型。
 *
 * 三条纪律（违背任何一条，结论就不可信）
 * ------------------------------------
 * 1. **给分布，不给均值。** 图上节点数常是双峰的（一批 3 步图 + 一批 30 步图），均值会把这个
 *    形状抹平成「差不多 16」这种毫无意义的数字。所以每项都给分位与直方图。
 * 2. **baseline 与 top 必须分开报，并报出差。** top 是天花板，baseline 是 base rate。
 *    只报 top 等于把最好的情况当常态。
 * 3. **空分母不许印 0。** 没有数据时印 `no data` 与原因。把「没测到」显示成「0%」会把人
 *    引向「数据质量差」这个错误结论，而真相往往是「这一层根本没落库」。
 *
 * 证据等级：输出里带 `source` 与 `evidenceGrade`。只有当 manifest 写着 `real_postgres` 时，
 * 结果才可以被引用为证据；合成夹具会被强制降级并让退出码非 0。
 *
 * 用法：
 *   node analyze_recon.mjs [RECON_DIR]
 *   node analyze_recon.mjs --allow-non-real     # 仅用于验证流水线，不得引用其结果
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ALLOW_NON_REAL = argv.includes('--allow-non-real');
const DIR = path.resolve(argv.find((item) => !item.startsWith('--')) || HERE);

// 模型推理时真正需要的 11 个字段（deploy/rdmd_detective.py#NODE_FIELDS）。
const MODEL_FIELDS = ['id', 'title', 'role', 'agentId', 'version', 'acceptance',
  'artifact', 'stage', 'inputs', 'output', 'summary'];

// 训练时的图规模区间（V3 报告：G_star 为 16–28 步长程图）。
const TRAINING_MIN_NODES = 16;

// 可被引用为证据的来源。只有真正是「用户真实数据」的导出才算。
const EVIDENCE_SOURCES = new Set(['real_postgres', 'real_janus_sqlite']);

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

// BOM 必须显式剥掉：PowerShell 的 Out-File -Encoding utf8 会写 BOM，手工导出的 manifest
// 极可能带上它，而 JSON.parse 遇到 BOM 会抛 SyntaxError —— 那是崩溃，不是 fail-closed。
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function readJson(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(path.join(DIR, file), 'utf8')));
  } catch (error) {
    // 报出文件名与原因。空盘/坏盘必须是可读的 fail-closed，而不是一个裸的 SyntaxError。
    console.error(`[error] cannot parse ${file}: ${error.message}`);
    process.exit(2);
  }
}

function readJsonl(file) {
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) return null;
  const text = stripBom(fs.readFileSync(full, 'utf8'));
  const lines = text.split('\n').filter((line) => line.trim());
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      rows.push(JSON.parse(lines[index]));
    } catch (error) {
      // 指明「哪个文件第几行」——畸形行的排查成本几乎全在定位上。
      console.error(`[error] ${file}:${index + 1} is not valid JSON: ${error.message}`);
      process.exit(2);
    }
  }
  return rows;
}

const manifestPath = path.join(DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`[error] no manifest.json in ${DIR}. Run export_ubuddy_task_samples.mjs first.`);
  process.exit(2);
}
const manifest = readJson('manifest.json');

const graphs = readJsonl('collaboration_graphs.jsonl') || [];
const nodes = readJsonl('collaboration_graph_nodes.jsonl') || [];
const edges = readJsonl('collaboration_graph_edges.jsonl') || [];
const graphEvents = readJsonl('collaboration_graph_events.jsonl') || [];
const taskNodes = readJsonl('cloud_task_nodes.jsonl') || [];
const resultVersions = readJsonl('task_node_result_versions.jsonl') || [];

// 空导出是结论（表没建或没数据），不是崩溃；但要明确报出来，避免后面把 0 当测量值。
const EMPTY = graphs.length === 0;

// ---------------------------------------------------------------------------
// 统计小工具
// ---------------------------------------------------------------------------

// 线性插值分位。手写而不是取 sorted[floor(p*n)] —— 后者在小样本上会系统性偏高。
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function describe(values) {
  if (!values.length) return { n: 0, note: 'no data' };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p10: round(percentile(sorted, 0.10)),
    p25: round(percentile(sorted, 0.25)),
    p50: round(percentile(sorted, 0.50)),
    p75: round(percentile(sorted, 0.75)),
    p90: round(percentile(sorted, 0.90)),
    max: sorted[sorted.length - 1],
    mean: round(sum / sorted.length),
    // mean 与 p50 差得远，就是分布偏斜或双峰的直接信号。
    meanMinusMedian: round(sum / sorted.length - percentile(sorted, 0.50)),
  };
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
}

function ratio(hits, total) {
  // 分母为 0 时返回 null 与原因，绝不返回 0 —— 见文件头纪律 3。
  if (!total) return { value: null, hits: 0, total: 0, note: 'no data' };
  return { value: round(hits / total), hits, total };
}

function histogram(values, bands) {
  const out = bands.map((band) => ({ band: band.label, count: 0 }));
  for (const value of values) {
    const index = bands.findIndex((band) => value >= band.min && value <= band.max);
    if (index >= 0) out[index].count += 1;
    else out[out.length - 1].count += 1;
  }
  return out;
}

function tally(values) {
  const map = new Map();
  for (const value of values) {
    const key = String(value === '' || value === null || value === undefined ? '(empty)' : value);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function filled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const STRATA = ['baseline', 'top'];

function byStratum(rows, stratumOfGraph) {
  const out = { baseline: [], top: [], both: [], unknown: [] };
  for (const row of rows) {
    const stratum = stratumOfGraph.get(row.graph_id) || row._stratum || 'unknown';
    (out[stratum] || out.unknown).push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 测量 1：图规模分布（训练区间是 16–28，所以 ≥16 的占比直接决定现有权重能否复用）
// ---------------------------------------------------------------------------

const NODE_BANDS = [
  { label: '1-2', min: 1, max: 2 },
  { label: '3-5', min: 3, max: 5 },
  { label: '6-10', min: 6, max: 10 },
  { label: '11-15', min: 11, max: 15 },
  { label: '16-20', min: 16, max: 20 },
  { label: '21-28', min: 21, max: 28 },
  { label: '29-80', min: 29, max: 80 },
  { label: '81+', min: 81, max: Number.MAX_SAFE_INTEGER },
];

const nodeCountByGraph = new Map();
for (const node of nodes) {
  const list = nodeCountByGraph.get(node.graph_id) || [];
  list.push(node);
  nodeCountByGraph.set(node.graph_id, list);
}

const nodeCounts = graphs.map((graph) => (nodeCountByGraph.get(graph.graph_id) || []).length);
const stratumOfGraph = new Map(graphs.map((graph) => [graph.graph_id, graph._stratum]));

const scale = {
  all: describe(nodeCounts),
  histogram: histogram(nodeCounts, NODE_BANDS),
  atOrAboveTrainingMin: ratio(nodeCounts.filter((count) => count >= TRAINING_MIN_NODES).length, nodeCounts.length),
  trainingBand: `>= ${TRAINING_MIN_NODES} nodes (V3 corpus was 16-28)`,
  byStratum: {},
};
for (const stratum of STRATA) {
  const ids = new Set(graphs.filter((graph) => graph._stratum === stratum).map((graph) => graph.graph_id));
  const counts = [...ids].map((id) => (nodeCountByGraph.get(id) || []).length);
  scale.byStratum[stratum] = { ...describe(counts), histogram: histogram(counts, NODE_BANDS) };
}

// ---------------------------------------------------------------------------
// 测量 2：富文本非空率（模型相对规则基线的全部优势都住在这里）
// ---------------------------------------------------------------------------

const summaryFilled = nodes.filter((node) => filled(node.public_summary)).length;
const titleFilled = nodes.filter((node) => filled(node.title)).length;

// 逐节点与逐图两个口径都要报：只报逐节点会掩盖「少数图填满、多数图全空」这种形状。
const graphsWithAllSummaries = graphs.filter((graph) => {
  const list = nodeCountByGraph.get(graph.graph_id) || [];
  return list.length > 0 && list.every((node) => filled(node.public_summary));
}).length;
const graphsWithNoSummary = graphs.filter((graph) => {
  const list = nodeCountByGraph.get(graph.graph_id) || [];
  return list.length > 0 && list.every((node) => !filled(node.public_summary));
}).length;

const richText = {
  collaboration_graph_nodes: {
    title: ratio(titleFilled, nodes.length),
    public_summary_per_node: ratio(summaryFilled, nodes.length),
    public_summary_per_graph_all_filled: ratio(graphsWithAllSummaries, graphs.length),
    public_summary_per_graph_none_filled: ratio(graphsWithNoSummary, graphs.length),
    note: 'per_node 与 per_graph 两个口径都报；两者差距大说明填充是「整图为单位」的',
  },
  task_node_result_versions: {
    result_text: ratio(resultVersions.filter((row) => filled(row.result_text)).length, resultVersions.length),
    result_summary: ratio(resultVersions.filter((row) => filled(row.result_summary)).length, resultVersions.length),
    decision_reason: ratio(resultVersions.filter((row) => filled(row.decision_reason)).length, resultVersions.length),
  },
  byStratum: {},
};
for (const stratum of STRATA) {
  const stratumNodeIds = new Set((byStratum(nodes, stratumOfGraph)[stratum] || []).map((node) => node.graph_id));
  const rows = nodes.filter((node) => stratumNodeIds.has(node.graph_id));
  richText.byStratum[stratum] = {
    nodes: rows.length,
    public_summary_per_node: ratio(rows.filter((node) => filled(node.public_summary)).length, rows.length),
  };
}

// ---------------------------------------------------------------------------
// 测量 3：before/after 可得性（没有两个状态，就没有可检测的漂移）
// ---------------------------------------------------------------------------

const eventsByGraph = new Map();
for (const event of graphEvents) {
  const list = eventsByGraph.get(event.graph_id) || [];
  list.push(event);
  eventsByGraph.set(event.graph_id, list);
}

const eventCounts = graphs.map((graph) => (eventsByGraph.get(graph.graph_id) || []).length);
const graphsWithTwoRevisions = graphs.filter((graph) => {
  const list = eventsByGraph.get(graph.graph_id) || [];
  return new Set(list.map((event) => event.graph_revision)).size >= 2;
}).length;
// 版本类型的分布（tally 已按次数降序），用于识别「单一类型重试循环」这种伪演进。
const revisionTypeTally = tally(graphEvents.map((event) => event.event_type));

// 结果版本侧的 before/after：同一 (task_run, task_node) 上出现 >=2 个 graph_revision_id。
const revisionPairs = new Map();
for (const row of resultVersions) {
  const key = `${row.task_run_id}\u001f${row.task_node_id}`;
  const set = revisionPairs.get(key) || new Set();
  set.add(row.graph_revision_id || '(empty)');
  revisionPairs.set(key, set);
}
const pairsWithTwoRevisions = [...revisionPairs.values()].filter((set) => set.size >= 2).length;
// superseded -> adopted 是唯一能证明「先有旧结果、后被替换」的形态，比单纯版本号+1 更强。
const supersededAdoptedPairs = [...revisionPairs.keys()].filter((key) => {
  const rows = resultVersions.filter((row) => `${row.task_run_id}\u001f${row.task_node_id}` === key);
  const decisions = new Set(rows.map((row) => row.decision));
  return decisions.has('superseded') && decisions.has('adopted');
}).length;

const beforeAfter = {
  collaboration_graph_events: {
    events_per_graph: describe(eventCounts),
    events_histogram: histogram(eventCounts, [
      { label: '0', min: 0, max: 0 },
      { label: '1', min: 1, max: 1 },
      { label: '2-4', min: 2, max: 4 },
      { label: '5-11', min: 5, max: 11 },
      { label: '12-49', min: 12, max: 49 },
      { label: '50+', min: 50, max: Number.MAX_SAFE_INTEGER },
    ]),
    graphs_with_2plus_revisions: ratio(graphsWithTwoRevisions, graphs.length),
    distinct_event_types: revisionTypeTally.length,
    // 「有两个版本」很容易被重试循环凑出来：同一个节点被反复重建，版本号一路涨，
    // 但两个版本之间没有任何实质差异。所以必须同时量**类型多样性**与**单一类型占比**。
    // 实测到的反例：11 个 revision 全是 add_fallback_node，形式上有版本、实质上是同一状态重试 11 次。
    revision_type_distribution: revisionTypeTally,
    dominant_revision_type_share: ratio(
      revisionTypeTally.length ? revisionTypeTally[0][1] : 0, graphEvents.length),
    note: 'distinct_event_types <= 1 说明版本变化是单一类型的重复（如失败重试），不是 plan/exec 演进',
  },
  task_node_result_versions: {
    pairs_total: revisionPairs.size,
    pairs_with_2plus_graph_revision_id: ratio(pairsWithTwoRevisions, revisionPairs.size),
    pairs_with_superseded_then_adopted: ratio(supersededAdoptedPairs, revisionPairs.size),
    note: 'superseded->adopted 是比「版本号 +1」更强的 before/after 证据',
  },
};

// ---------------------------------------------------------------------------
// 测量 4：标签候选（没有标签就既不能训练也不能评测）
// ---------------------------------------------------------------------------

const labels = {
  decision_distribution: tally(resultVersions.map((row) => row.decision)),
  decision_superseded_or_rejected: ratio(
    resultVersions.filter((row) => ['superseded', 'rejected'].includes(row.decision)).length,
    resultVersions.length),
  result_version_decision_reason_filled: ratio(
    resultVersions.filter((row) => filled(row.decision_reason)).length, resultVersions.length),
  // event_type 是第二标签来源：失败/重试/重规划这些事件本身就指示了故障节点。
  event_type_distribution: tally(graphEvents.map((event) => event.event_type)),
  node_status_distribution: tally(nodes.map((node) => node.status)),
  failure_signal_events: ratio(
    graphEvents.filter((event) => /fail|error|block|retry|rework|replan|reject/i.test(String(event.event_type))).length,
    graphEvents.length),
};

// ---------------------------------------------------------------------------
// 测量 5：边的可得性（没有 DAG，「唯一级联根」这个任务定义就不成立）
// ---------------------------------------------------------------------------

const nodeIdsByGraph = new Map();
for (const node of nodes) {
  const set = nodeIdsByGraph.get(node.graph_id) || new Set();
  set.add(node.node_id);
  nodeIdsByGraph.set(node.graph_id, set);
}

const nodesWithParent = nodes.filter((node) => filled(node.parent_node_id)).length;
const nodesWithAgent = nodes.filter((node) => filled(node.owner_agent_id)).length;
const nodesWithTaskNode = nodes.filter((node) => filled(node.task_node_id)).length;

// root 节点**本来就不该有父节点**，把它算进「缺父节点」会凭空造出一个 89% 的假缺口。
// 所以分母排除 root：判据只问「非 root 节点是否都挂得上」。
const rootNodes = nodes.filter((node) => node.kind === 'root').length;
const nonRootNodes = nodes.filter((node) => node.kind !== 'root');
const nonRootWithParent = nonRootNodes.filter((node) => filled(node.parent_node_id)).length;

// 每个非 root 节点都必须有一个实际存在的父节点，否则树是断的。
const danglingParents = nodes.filter((node) => {
  if (!filled(node.parent_node_id)) return false;
  const ids = nodeIdsByGraph.get(node.graph_id) || new Set();
  return !ids.has(node.parent_node_id);
}).length;

const edgeKinds = tally(edges.map((edge) => edge.kind));
const dependencyEdges = edges.filter((edge) => edge.kind === 'dependency_of').length;
const graphsWithDependencyEdges = new Set(
  edges.filter((edge) => edge.kind === 'dependency_of').map((edge) => edge.graph_id)).size;

// 环检测：有环就不是 DAG，因果级联会失去方向。
function hasCycle(graphId) {
  const ids = nodeIdsByGraph.get(graphId) || new Set();
  const children = new Map();
  for (const edge of edges) {
    if (edge.graph_id !== graphId) continue;
    if (!ids.has(edge.from_node_id) || !ids.has(edge.to_node_id)) continue;
    const list = children.get(edge.from_node_id) || [];
    list.push(edge.to_node_id);
    children.set(edge.from_node_id, list);
  }
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 'visiting') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'visiting');
    for (const child of children.get(id) || []) if (visit(child)) return true;
    state.set(id, 'done');
    return false;
  };
  return [...ids].some((id) => visit(id));
}
const graphsWithCycle = graphs.filter((graph) => hasCycle(graph.graph_id)).length;

const graphShape = {
  parent_node_id_filled: ratio(nodesWithParent, nodes.length),
  // 决定性判据：非 root 节点是否都挂上了父节点（root 天然无父，不计入分母）。
  non_root_nodes_with_parent: ratio(nonRootWithParent, nonRootNodes.length),
  root_nodes: rootNodes,
  dangling_parent_references: { count: danglingParents, total: nodes.length },
  owner_agent_id_filled: ratio(nodesWithAgent, nodes.length),
  task_node_id_filled: ratio(nodesWithTaskNode, nodes.length),
  edge_kind_distribution: edgeKinds,
  dependency_of_edges: dependencyEdges,
  graphs_with_dependency_of_edges: ratio(graphsWithDependencyEdges, graphs.length),
  graphs_with_cycle: ratio(graphsWithCycle, graphs.length),
  node_kind_distribution: tally(nodes.map((node) => node.kind)),
  depth_distribution: tally(nodes.map((node) => node.depth)),
};

// ---------------------------------------------------------------------------
// 测量 6：11 字段契约映射（这张表直接就是重训的数据契约草案）
// ---------------------------------------------------------------------------

// public_metadata_json 是个自由 jsonb。如果真实数据把 inputs/output/artifact 塞在这里，
// 结论会完全不同 —— 所以必须实测它的键分布，而不是假定它没有。
const metadataKeys = new Map();
let nodesWithMetadata = 0;
for (const node of nodes) {
  const meta = node.public_metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
  const keys = Object.keys(meta);
  if (keys.length) nodesWithMetadata += 1;
  for (const key of keys) metadataKeys.set(key, (metadataKeys.get(key) || 0) + 1);
}
const metadataKeysSorted = [...metadataKeys.entries()].sort((a, b) => b[1] - a[1]);
const metadataHasModelField = Object.fromEntries(
  MODEL_FIELDS.map((field) => [field, metadataKeys.get(field) || 0]));

// 逐字段给出来源或明确标注「无来源」。弱来源（存在但语义不等价）单独一档，
// 因为把一个修订计数器当成语义版本号用，是会静默毁掉准确率的那类错误。
const fieldMap = [
  { field: 'id', source: 'collaboration_graph_nodes.node_id', strength: 'direct' },
  {
    field: 'title', source: 'collaboration_graph_nodes.title', strength: 'direct',
    measured: richText.collaboration_graph_nodes.title,
  },
  { field: 'role', source: null, strength: 'missing', note: '仅有 kind(root/ubuddy/agent_task)，不是角色名' },
  {
    field: 'agentId', source: 'collaboration_graph_nodes.owner_agent_id', strength: 'direct',
    measured: graphShape.owner_agent_id_filled,
  },
  {
    field: 'version', source: 'collaboration_graph_nodes.source_revision', strength: 'weak',
    note: '修订计数，非语义版本（训练时的 version 是 v1/_stale 这类）；当版本号用会静默降分',
  },
  { field: 'acceptance', source: null, strength: 'missing', note: '无对应列；需确认 public_metadata 是否携带' },
  { field: 'artifact', source: null, strength: 'missing', note: '无对应列；需确认 public_metadata 是否携带' },
  { field: 'stage', source: null, strength: 'missing', note: '无对应列；可能近似于 depth，但语义不同' },
  { field: 'inputs', source: null, strength: 'missing', note: '无对应列；需确认 public_metadata 是否携带' },
  { field: 'output', source: null, strength: 'missing', note: '无对应列；task_node_result_versions.result_text 是最接近的候选' },
  {
    field: 'summary', source: 'collaboration_graph_nodes.public_summary', strength: 'direct',
    measured: richText.collaboration_graph_nodes.public_summary_per_node,
  },
];
const fieldMapCounts = {
  direct: fieldMap.filter((item) => item.strength === 'direct').length,
  weak: fieldMap.filter((item) => item.strength === 'weak').length,
  missing: fieldMap.filter((item) => item.strength === 'missing').length,
  total: fieldMap.length,
};

const fieldContract = {
  modelFieldsRequired: MODEL_FIELDS,
  counts: fieldMapCounts,
  map: fieldMap,
  publicMetadata: {
    nodesWithMetadata,
    distinctKeys: metadataKeys.length,
    keys: metadataKeysSorted.slice(0, 40),
    modelFieldsPresentInMetadata: metadataHasModelField,
    // 若这些键真的存在，值填得满不满才是重点；只看到键名不算证据。
    note: '键存在不等于有内容；若关键命中，必须再量它的非空率',
  },
};

// ---------------------------------------------------------------------------
// 测量 7：体量
// ---------------------------------------------------------------------------

const volume = manifest.volume || {};

// ---------------------------------------------------------------------------
// 基线 vs 天花板
// ---------------------------------------------------------------------------

// 计划里明确要求「报出两者差值」。理由：top 是天花板，baseline 是 base rate。
// 只报 top（或只报全体均值）会把最好情况当常态，是最常见的自欺。
function stratumProfile(stratum) {
  const rows = graphs.filter((graph) => graph._stratum === stratum);
  if (!rows.length) return { graphs: 0, note: 'no data' };
  const ids = new Set(rows.map((graph) => graph.graph_id));
  const stratumNodes = nodes.filter((node) => ids.has(node.graph_id));
  const counts = rows.map((graph) => (nodeCountByGraph.get(graph.graph_id) || []).length);
  const stratumEvents = rows.map((graph) => (eventsByGraph.get(graph.graph_id) || []).length);
  const allFilled = rows.filter((graph) => {
    const list = nodeCountByGraph.get(graph.graph_id) || [];
    return list.length > 0 && list.every((node) => filled(node.public_summary));
  }).length;
  const twoRevisions = rows.filter((graph) => {
    const list = eventsByGraph.get(graph.graph_id) || [];
    return new Set(list.map((event) => event.graph_revision)).size >= 2;
  }).length;
  return {
    graphs: rows.length,
    nodeCount: describe(counts),
    eventsPerGraph: describe(stratumEvents),
    nodesPerGraphAtOrAboveTrainingMin: ratio(counts.filter((count) => count >= TRAINING_MIN_NODES).length, counts.length),
    publicSummaryPerNode: ratio(stratumNodes.filter((node) => filled(node.public_summary)).length, stratumNodes.length),
    publicSummaryPerGraphAllFilled: ratio(allFilled, rows.length),
    graphsWith2plusRevisions: ratio(twoRevisions, rows.length),
  };
}

const baselineProfile = stratumProfile('baseline');
const topProfile = stratumProfile('top');

function gap(a, b) {
  if (!a || a.value === null || !b || b.value === null) return null;
  return round(b.value - a.value);
}

const stratumGap = {
  baseline: baselineProfile,
  top: topProfile,
  // top - baseline。正数 = 天花板确实比基线好（说明「按结构挑样本」有意义），
  // 接近 0 = 结构复杂度与这项指标无关，那 top 样本就没有代表性优势可言。
  delta: {
    publicSummaryPerNode: gap(baselineProfile.publicSummaryPerNode, topProfile.publicSummaryPerNode),
    publicSummaryPerGraphAllFilled: gap(baselineProfile.publicSummaryPerGraphAllFilled, topProfile.publicSummaryPerGraphAllFilled),
    graphsWith2plusRevisions: gap(baselineProfile.graphsWith2plusRevisions, topProfile.graphsWith2plusRevisions),
    nodeCountMedian: (baselineProfile.nodeCount?.p50 ?? null) === null || (topProfile.nodeCount?.p50 ?? null) === null
      ? null : topProfile.nodeCount.p50 - baselineProfile.nodeCount.p50,
    eventsMedian: (baselineProfile.eventsPerGraph?.p50 ?? null) === null || (topProfile.eventsPerGraph?.p50 ?? null) === null
      ? null : topProfile.eventsPerGraph.p50 - baselineProfile.eventsPerGraph.p50,
  },
  reading:
    'delta = top - baseline。富文本/事件这类指标若 delta 接近 0，说明「看图结构复杂度」并不能预测数据可用性，'
    + '按结构取 top 样本就是无效的取样策略；若 delta 很大，则必须两个口径都报，不能只报 top。',
};

// ---------------------------------------------------------------------------
// 判定矩阵
// ---------------------------------------------------------------------------

// 每一项都可能单独判死「在 uBuddy 原生字段上重训」这条路，所以逐项给结论而不是给总分。
const MATRIX = [
  {
    id: 'scale',
    check: `图规模中位数 >= ${TRAINING_MIN_NODES} 节点`,
    observed: scale.all.n === 0 ? 'no data' : `p50=${scale.all.p50}, max=${scale.all.max}, >=16 占比=${percent(scale.atOrAboveTrainingMin)}`,
    pass: scale.all.n > 0 && scale.all.p50 >= TRAINING_MIN_NODES,
    onFail: '现有权重不可复用；只能自建图 + 重训，成本上一个量级',
  },
  {
    id: 'rich_text',
    // 判据用**逐图全填**而不是逐节点：部署守卫是「任一节点任一富文本字段为空就拒绝整条输入」，
    // 所以一条图上只要有一个节点没摘要，这条图就进不了训练。用逐节点率会高估可用数据。
    check: 'public_summary 逐图全填率 >= 0.50',
    observed: `${percent(richText.collaboration_graph_nodes.public_summary_per_graph_all_filled)} 逐图全填；逐节点 ${percent(richText.collaboration_graph_nodes.public_summary_per_node)}`,
    pass: (richText.collaboration_graph_nodes.public_summary_per_graph_all_filled.value ?? 0) >= 0.50,
    onFail: '模型核心优势无载体 → 相对规则基线无收益',
  },
  {
    id: 'before_after',
    // 两个条件都要：① 确实存在 ≥2 个版本；② 版本**类型**不止一种。
    // 只查①会被重试循环骗过 —— 实测数据里 11 个版本全是 add_fallback_node，
    // 形式上有版本，实质上同一个状态重试了 11 次，没有任何 plan/exec 演进。
    check: '存在 ≥2 版本，且版本类型不单一',
    observed: `${percent(beforeAfter.collaboration_graph_events.graphs_with_2plus_revisions)}（事件流）/ ${percent(beforeAfter.task_node_result_versions.pairs_with_superseded_then_adopted)}（superseded->adopted 对）; 版本类型 ${beforeAfter.collaboration_graph_events.distinct_event_types} 种, 单一类型占比 ${percent(beforeAfter.collaboration_graph_events.dominant_revision_type_share)}`,
    pass: (beforeAfter.collaboration_graph_events.graphs_with_2plus_revisions.value ?? 0) > 0
      && (beforeAfter.collaboration_graph_events.distinct_event_types ?? 0) >= 2,
    onFail: '没有 plan/exec 对 → RDMD 的问题在这一层不存在',
  },
  {
    id: 'labels',
    check: '存在 superseded/rejected 或失败类事件',
    observed: `${percent(labels.decision_superseded_or_rejected)}（决策）/ ${percent(labels.failure_signal_events)}（失败类事件）`,
    pass: (labels.decision_superseded_or_rejected.value ?? 0) > 0
      || (labels.failure_signal_events.value ?? 0) > 0,
    onFail: '无标签 → 既不能训练也不能评测',
  },
  {
    id: 'edges',
    check: '非 root 节点 100% 有父节点且无环',
    observed: `${percent(graphShape.non_root_nodes_with_parent)} 非 root 有父节点（root=${graphShape.root_nodes} 不计）; dangling=${graphShape.dangling_parent_references.count}; 有环图=${percent(graphShape.graphs_with_cycle)}`,
    pass: (graphShape.non_root_nodes_with_parent.value ?? 0) === 1
      && graphShape.dangling_parent_references.count === 0
      && (graphShape.graphs_with_cycle.value ?? 1) === 0,
    onFail: '无 DAG → 「唯一级联根」不成立，任务定义垮掉',
  },
  {
    id: 'fields',
    check: '11 字段中 direct 来源 >= 6',
    observed: `direct=${fieldMapCounts.direct}, weak=${fieldMapCounts.weak}, missing=${fieldMapCounts.missing}`,
    pass: fieldMapCounts.direct >= 6,
    onFail: '字段缺口过大；重训要新建的不只是图族，还有数据契约',
  },
  {
    id: 'volume',
    check: '图总量 >= 数千',
    observed: `${fmt(volume.collaboration_graphs)} 张图 / ${fmt(volume.collaboration_graph_nodes)} 节点`,
    pass: Number(volume.collaboration_graphs || 0) >= 1000,
    onFail: '体量不足以训练',
  },
];

function percent(stat) {
  if (!stat || stat.value === null) return 'no data';
  return `${(stat.value * 100).toFixed(1)}% (${stat.hits}/${stat.total})`;
}

function fmt(value) {
  return value === null || value === undefined ? 'no data' : String(value);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const summary = {
  reconVersion: 'ubuddy_recon_v1',
  generatedAt: new Date().toISOString(),
  source: manifest.source,
  // 合成夹具的结果不得被引用为证据；这里显式降级，并让退出码非 0。
  // real_postgres（云端 PG）与 real_janus_sqlite（桌面端真实应用库）都是真数据。
  evidenceGrade: EVIDENCE_SOURCES.has(manifest.source) ? 'evidence' : 'synthetic_do_not_cite',
  rebuiltFrom: {
    exportedAt: manifest.exportedAt || '',
    target: manifest.target || {},
    sampling: manifest.sampling || {},
    rowCounts: manifest.rowCounts || {},
    redaction: manifest.redaction || {},
  },
  emptyGraphExport: EMPTY,
  measurements: {
    '1_scale': scale,
    '2_rich_text': richText,
    '3_before_after': beforeAfter,
    '4_labels': labels,
    '5_graph_shape': graphShape,
    '6_field_contract': fieldContract,
    '7_volume': volume,
    '8_stratum_gap': stratumGap,
  },
  decisionMatrix: MATRIX.map(({ id, check, observed, pass, onFail }) => ({ id, check, observed, pass, onFail })),
};

fs.writeFileSync(path.join(DIR, 'recon_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

// 人读报告
const lines = [];
lines.push(`# uBuddy 侦察结果（${summary.evidenceGrade}）`);
lines.push('');
if (summary.evidenceGrade !== 'evidence') {
  lines.push(`> 证据等级 **${summary.evidenceGrade}**：数据来源是 \`${manifest.source}\`，`);
  lines.push('> **不得作为结论引用**。它只能证明流水线可跑通。');
  lines.push('');
}
lines.push(`- 导出时间：${summary.rebuiltFrom.exportedAt || '(未记录)'}`);
lines.push(`- 来源声明：\`${manifest.source}\`（${manifest.sourceDeclaredBy || '(未记录)'}）`);
lines.push(`- 导出目标：${JSON.stringify(summary.rebuiltFrom.target || manifest.target || {})}`);
lines.push(`- 取样：${JSON.stringify(summary.rebuiltFrom.sampling)}`);
lines.push(`- 行数：${JSON.stringify(summary.rebuiltFrom.rowCounts)}`);
lines.push('');
if (EMPTY) {
  lines.push('## 图侧导出为空');
  lines.push('');
  lines.push('`collaboration_graphs` 没有任何行 —— 要么迁移 094 未应用，要么这一层没有数据。');
  lines.push('两种情况的含义不同（前者是部署状态，后者是产品未使用这一层），需人工确认。');
  lines.push('');
}
lines.push('## 决策矩阵');
lines.push('');
lines.push('| 检查 | 实测 | 结论 |');
lines.push('| --- | --- | --- |');
for (const item of MATRIX) {
  lines.push(`| ${item.check} | ${item.observed} | ${item.pass ? 'PASS' : 'FAIL'} |`);
}
lines.push('');
lines.push('## 七项测量');
lines.push('');
lines.push('### 1. 图规模（节点数）');
lines.push('```');
lines.push(JSON.stringify({ all: scale.all, histogram: scale.histogram, byStratum: scale.byStratum }, null, 2));
lines.push('```');
lines.push('');
lines.push('### 2. 富文本非空率');
lines.push('```');
lines.push(JSON.stringify(richText, null, 2));
lines.push('```');
lines.push('');
lines.push('### 3. before/after 可得性');
lines.push('```');
lines.push(JSON.stringify(beforeAfter, null, 2));
lines.push('```');
lines.push('');
lines.push('### 4. 标签候选');
lines.push('```');
lines.push(JSON.stringify(labels, null, 2));
lines.push('```');
lines.push('');
lines.push('### 5. 图结构（边）');
lines.push('```');
lines.push(JSON.stringify(graphShape, null, 2));
lines.push('```');
lines.push('');
lines.push('### 6. 11 字段契约映射');
lines.push('');
lines.push('| 模型字段 | 来源 | 强度 | 实测 |');
lines.push('| --- | --- | --- | --- |');
for (const item of fieldMap) {
  const measured = item.measured ? percent(item.measured) : (item.note || '');
  lines.push(`| \`${item.field}\` | ${item.source ? `\`${item.source}\`` : '**无来源**'} | ${item.strength} | ${measured} |`);
}
lines.push('');
lines.push(`public_metadata_json：${nodesWithMetadata}/${nodes.length} 个节点带键，不同键 ${metadataKeys.size} 个。`);
if (metadataKeysSorted.length) {
  lines.push('');
  lines.push('最常出现的键：');
  for (const [key, count] of metadataKeysSorted.slice(0, 20)) lines.push(`- \`${key}\`: ${count}`);
}
lines.push('');
lines.push('### 7. 体量');
lines.push('```');
lines.push(JSON.stringify(volume, null, 2));
lines.push('```');
lines.push('');
lines.push('### 8. 基线 vs 天花板（delta = top - baseline）');
lines.push('');
lines.push('| 指标 | baseline | top | delta |');
lines.push('| --- | --- | --- | --- |');
lines.push(`| 图数 | ${baselineProfile.graphs || 'no data'} | ${topProfile.graphs || 'no data'} | |`);
lines.push(`| 节点数 p50 | ${baselineProfile.nodeCount?.p50 ?? 'no data'} | ${topProfile.nodeCount?.p50 ?? 'no data'} | ${stratumGap.delta.nodeCountMedian ?? 'no data'} |`);
lines.push(`| 每图事件数 p50 | ${baselineProfile.eventsPerGraph?.p50 ?? 'no data'} | ${topProfile.eventsPerGraph?.p50 ?? 'no data'} | ${stratumGap.delta.eventsMedian ?? 'no data'} |`);
lines.push(`| 摘要逐节点填充 | ${percent(baselineProfile.publicSummaryPerNode)} | ${percent(topProfile.publicSummaryPerNode)} | ${stratumGap.delta.publicSummaryPerNode ?? 'no data'} |`);
lines.push(`| 摘要逐图全填 | ${percent(baselineProfile.publicSummaryPerGraphAllFilled)} | ${percent(topProfile.publicSummaryPerGraphAllFilled)} | ${stratumGap.delta.publicSummaryPerGraphAllFilled ?? 'no data'} |`);
lines.push(`| ≥2 revision 图 | ${percent(baselineProfile.graphsWith2plusRevisions)} | ${percent(topProfile.graphsWith2plusRevisions)} | ${stratumGap.delta.graphsWith2plusRevisions ?? 'no data'} |`);
lines.push('');
lines.push(stratumGap.reading);
lines.push('');

fs.writeFileSync(path.join(DIR, 'recon_report.md'), `${lines.join('\n')}\n`, 'utf8');

console.log(lines.join('\n'));

const failed = MATRIX.filter((item) => !item.pass);
console.log('');
console.log(`[summary] ${MATRIX.length - failed.length}/${MATRIX.length} checks PASS; failed: ${failed.map((item) => item.id).join(', ') || '(none)'}`);
console.log(`[output] ${path.join(DIR, 'recon_summary.json')} / recon_report.md`);

if (summary.evidenceGrade !== 'evidence' && !ALLOW_NON_REAL) {
  console.error('[error] evidence grade is not "evidence" (source is not a real data source).');
  console.error('        Results must not be cited. Re-run with --allow-non-real only to verify the pipeline.');
  process.exitCode = 1;
}
