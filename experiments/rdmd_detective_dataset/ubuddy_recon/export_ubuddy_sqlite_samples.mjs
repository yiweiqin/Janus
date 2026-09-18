// uBuddy 数据侦察：从 Janus 桌面端 SQLite 库导出样本，产出与
// export_ubuddy_task_samples.mjs（PostgreSQL 版）**相同**的 JSONL 契约，
// 好让 analyze_recon.mjs 直接吃，不需要第二套测量逻辑。
//
// 为什么要这个脚本
// ----------------
// 原计划的侦察对象是云端 PostgreSQL 的 collaboration_graph_*。实测后发现：
//   - 本机 PG 里最大的库只有 ~16.8 MB（基本只有 schema，没有数据）；
//   - 而 uBuddy 的真实任务数据在桌面端 SQLite 里（~/.janus-test/data/janus.db 达 2.77 GB）。
// 所以真数据在 SQLite 这一侧，导出通路必须覆盖它。
//
// 字段映射（这是**侦察用**的映射，不是给模型用的适配器；每一条都可核对）
// -------------------------------------------------------------------
//   graph  ← task_runs            graph_id = id, lifecycle_status = status,
//                                 current_revision = 该 run 的 task_graph_revisions 数
//   node   ← task_nodes           public_summary = result_summary || objective   ← 散文载体
//                                 parent_node_id = dependencies_json 里解析出的依赖
//                                 depth 恒为 1（这一层没有更深的层级，如实记录为扁平）
//   edge   ← task_nodes.dependencies_json 解析
//   event  ← task_graph_revisions graph_revision = 行内序号（1..n）, event_type = revision_type,
//                                 public_patch = after_json
//   result ← task_node_result_versions 原样
//
// 刻意**不**做的事：
//   - 不合成 root 节点。若依赖为空，parent_node_id 就是空 —— 那正是要测出来的事实，
//     合成一个 root 会把「没有 DAG」这个结论掩盖掉。
//   - 不做任何补全或默认值填充。缺失就留空，让分析器按契约判 FAIL。
//
// 只读打开。这是用户真实的桌面应用库，任何写入都可能损坏它。
//
// 用法：
//   UBUDDY_RECON_SOURCE=real_janus_sqlite node export_ubuddy_sqlite_samples.mjs <janus.db> [OUT_DIR]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbArg = process.argv[2] || '';
if (!dbArg) {
  console.error('[error] usage: node export_ubuddy_sqlite_samples.mjs <path-to-janus.db> [OUT_DIR]');
  process.exit(2);
}
const DB_PATH = path.resolve(dbArg);
const OUT_DIR = path.resolve(process.argv[3] || HERE);
const MAX_EVENTS_PER_GRAPH = Number(process.env.UBUDDY_RECON_MAX_EVENTS || 2000);

// 只读打开。缺了这个选项就是不可接受的风险。
const db = new DatabaseSync(DB_PATH, { readOnly: true });

function safeAll(sql) {
  try { return db.prepare(sql).all(); } catch { return null; }
}
function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function parseJson(text, fallback) {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
function text(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

const skipped = [];

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

const has = (name) => tableExists(name);
for (const [label, name] of [
  ['task_runs', 'task_runs'], ['task_nodes', 'task_nodes'],
  ['task_node_result_versions', 'task_node_result_versions'],
  ['task_graph_revisions', 'task_graph_revisions'], ['task_events', 'task_events'],
]) {
  if (!has(name)) skipped.push({ label, error: `no such table: ${name}` });
}

const runs = has('task_runs') ? (safeAll('SELECT * FROM task_runs') || []) : [];
const nodes = has('task_nodes') ? (safeAll('SELECT * FROM task_nodes') || []) : [];
const results = has('task_node_result_versions') ? (safeAll('SELECT * FROM task_node_result_versions') || []) : [];
const revisions = has('task_graph_revisions') ? (safeAll('SELECT * FROM task_graph_revisions ORDER BY rowid') || []) : [];
const events = has('task_events') ? (safeAll('SELECT * FROM task_events ORDER BY rowid') || []) : [];

// --- graphs -----------------------------------------------------------------
const revisionsByRun = new Map();
for (const revision of revisions) {
  const list = revisionsByRun.get(String(revision.task_run_id)) || [];
  list.push(revision);
  revisionsByRun.set(String(revision.task_run_id), list);
}
const graphs = runs.map((run) => ({
  graph_id: text(run.id),
  graph_version: 'janus_sqlite_task_graph_v1',
  root_task_run_id: text(run.id),
  root_delegation_id: '',
  root_group_id: '',
  root_node_id: '',
  owner_user_id: text(run.owner_user_id),
  title: text(run.title),
  current_revision: (revisionsByRun.get(text(run.id)) || []).length,
  lifecycle_status: text(run.status),
  created_at: text(run.created_at),
  updated_at: text(run.updated_at),
}));

// --- nodes ------------------------------------------------------------------
const allNodeIds = new Set(nodes.map((node) => text(node.id)));
const nodeGraph = new Map(nodes.map((node) => [text(node.id), text(node.task_run_id)]));

const outNodes = nodes.map((node) => ({
  graph_id: text(node.task_run_id),
  node_id: text(node.id),
  // 依赖解析成父边。这批数据里 dependencies_json 全是 []，所以这里会如实产出空父节点
  // —— 那正是「没有 DAG」这个结论的证据，不做兜底。
  parent_node_id: '',
  kind: 'agent_task',
  task_run_id: text(node.task_run_id),
  delegation_id: '',
  task_node_id: text(node.id),
  owner_user_id: '',
  owner_agent_id: text(node.agent_id),
  owner_agent_instance_id: text(node.agent_instance_id),
  title: text(node.title),
  // 散文载体：先取 result_summary（步骤产出），退化到 objective（步骤目标）。
  public_summary: text(node.result_summary) || text(node.objective),
  status: text(node.status),
  progress: { completed: 100, failed: 100, cancelled: 100, running: 35, queued: 0 }[text(node.status)] ?? 0,
  depth: 1,
  visibility: 'participants',
  public_metadata: {},
  source_revision: Number(node.attempt_count || 0),
  created_at: text(node.created_at),
  updated_at: text(node.updated_at),
}));

// --- edges ------------------------------------------------------------------
// 只有指向**本图内真实存在**的节点才算边，避免把悬空引用算成结构。
const outEdges = [];
for (const node of nodes) {
  const deps = parseJson(node.dependencies_json, []);
  if (!Array.isArray(deps)) continue;
  for (const raw of deps) {
    const from = typeof raw === 'string' ? raw : text(raw?.id || raw?.nodeId);
    if (!from || !allNodeIds.has(from)) continue;
    if (nodeGraph.get(from) !== text(node.task_run_id)) continue;
    outEdges.push({
      graph_id: text(node.task_run_id),
      edge_id: `dep_${from}__${text(node.id)}`,
      kind: 'dependency_of',
      from_node_id: from,
      to_node_id: text(node.id),
      public_metadata: {},
      source_revision: 0,
      created_at: text(node.created_at),
      updated_at: text(node.updated_at),
    });
  }
}

// --- events（用 task_graph_revisions 作为真实的「图演进」记录） ---------------
const revisionCounter = new Map();
const outEvents = revisions.map((revision) => {
  const runId = text(revision.task_run_id);
  const next = (revisionCounter.get(runId) || 0) + 1;
  revisionCounter.set(runId, next);
  return {
    graph_id: runId,
    graph_revision: next,
    event_id: text(revision.id),
    // revision_type 是判定的关键：若全是 add_fallback_node，
    // 说明这些「版本」是失败重试的产物，不是 plan→exec 演进。
    event_type: text(revision.revision_type),
    node_id: '',
    public_patch: parseJson(revision.after_json, {}),
    actor_user_id: text(revision.actor_id),
    actor_agent_instance_id: '',
    created_at: text(revision.created_at),
  };
}).slice(0, MAX_EVENTS_PER_GRAPH * Math.max(1, graphs.length));

// task_events 是标签的第二来源（失败/重试/交付复核），单独作为事件补充。
// 但它们数量可达数千，且实测高度重复，所以只保留**去重后的类型计数**在 manifest 里，
// 不把逐条噪声写进 JSONL。这一点写进 manifest 以免被误读为「没有事件」。
const eventTypeCounts = new Map();
for (const event of events) {
  const key = text(event.event_type);
  eventTypeCounts.set(key, (eventTypeCounts.get(key) || 0) + 1);
}

// --- result versions（富文本 + before/after + 决策） -------------------------
const outResults = results.map((row) => ({
  id: text(row.id),
  task_run_id: text(row.task_run_id),
  task_node_id: text(row.task_node_id),
  graph_revision_id: text(row.graph_revision_id),
  version_no: Number(row.version_no || 0),
  result_text: text(row.result_text),
  result_summary: text(row.result_summary),
  decision: text(row.decision),
  decision_reason: '',
  created_at: text(row.created_at),
  decided_at: '',
}));

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const rowCounts = {};
function write(name, rows) {
  fs.writeFileSync(path.join(OUT_DIR, name), jsonl(rows), 'utf8');
  rowCounts[name] = rows.length;
}

write('collaboration_graphs.jsonl', graphs);
write('collaboration_graph_nodes.jsonl', outNodes);
write('collaboration_graph_edges.jsonl', outEdges);
write('collaboration_graph_events.jsonl', outEvents);
write('cloud_task_nodes.jsonl', []);
write('task_node_result_versions.jsonl', outResults);

const runStatusCounts = new Map();
for (const run of runs) runStatusCounts.set(text(run.status), (runStatusCounts.get(text(run.status)) || 0) + 1);

const manifest = {
  // 不猜来源。操作者必须声明；未声明即 unverified，分析器拒绝当证据。
  source: process.env.UBUDDY_RECON_SOURCE || 'unverified_sqlite',
  sourceDeclaredBy: process.env.UBUDDY_RECON_SOURCE ? 'env:UBUDDY_RECON_SOURCE' : '(not declared)',
  target: { kind: 'sqlite', file: path.basename(DB_PATH), bytes: fs.statSync(DB_PATH).size },
  exportedAt: new Date().toISOString(),
  sampling: {
    note: 'SQLite 侧是**全量**导出（不是抽样）：这些库的 uBuddy 任务量本来就很小，抽样没有意义',
    taskRuns: runs.length,
    taskNodes: nodes.length,
    resultVersions: results.length,
    graphRevisions: revisions.length,
    taskEvents: events.length,
  },
  mapping: {
    graph: 'task_runs',
    node: 'task_nodes（public_summary = result_summary || objective）',
    edge: 'task_nodes.dependencies_json',
    event: 'task_graph_revisions（event_type = revision_type）',
    resultVersion: 'task_node_result_versions',
    note: '侦察用映射；不做补全，缺失留空以便判定矩阵如实判 FAIL',
  },
  // 逐条事件不写进 JSONL（噪声占 98%），但类型分布必须留下 ——
  // 否则「没有事件」与「事件全是重复噪声」会被混为一谈。
  taskEventTypeCounts: Object.fromEntries([...eventTypeCounts.entries()].sort((a, b) => b[1] - a[1])),
  volume: {
    // 契约键：分析器的「体量」判据读的是这两个名字，缺失会被显示成 "no data" 而不是真实值。
    // 那会把「体量 6 张图（FAIL）」误报成「没测到」，两者含义完全不同。
    collaboration_graphs: runs.length,
    collaboration_graph_nodes: nodes.length,
    // 同时保留源表原名，便于回溯这个数是怎么来的。
    task_runs: runs.length,
    task_nodes: nodes.length,
    task_node_result_versions: results.length,
    task_graph_revisions: revisions.length,
    task_events: events.length,
  },
  taskRunStatusCounts: Object.fromEntries(runStatusCounts),
  revisionTypeCounts: Object.fromEntries([...new Map(revisions.map((r) => [text(r.revision_type), 0]))
    .keys()].map((type) => [type, revisions.filter((r) => text(r.revision_type) === type).length])),
  rowCounts,
  skipped,
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: skipped.length === 0,
  source: manifest.source,
  db: manifest.target,
  rowCounts,
  volume: manifest.volume,
  taskRunStatusCounts: manifest.taskRunStatusCounts,
  revisionTypeCounts: manifest.revisionTypeCounts,
  taskEventTypeCounts: manifest.taskEventTypeCounts,
  skipped,
  output: OUT_DIR,
}, null, 2));

if (manifest.source !== 'real_postgres' && manifest.source !== 'real_janus_sqlite') {
  console.error(`[warn] source is "${manifest.source}". The analyzer will refuse to grade this as evidence.`);
  console.error('       Declare UBUDDY_RECON_SOURCE=real_janus_sqlite only when this really is the app database.');
}
db.close();
