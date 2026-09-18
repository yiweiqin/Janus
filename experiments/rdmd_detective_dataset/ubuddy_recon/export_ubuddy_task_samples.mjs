#!/usr/bin/env node
/**
 * uBuddy 数据侦察：从真实 PostgreSQL 导出样本，供 `analyze_recon.mjs` 测量。
 *
 * 为什么测这些表（而不是我最初以为的 cloud_task_nodes）
 * ----------------------------------------------------
 * 侦察前查代码时先看的是 `cloud/src/modules/collaboration/stateGraph.mjs`：那里节点是**用户**
 * （`ubuddy:${userId}`）、边是**委派** —— 是人事图，不是任务步骤树。
 *
 * 但活树里还有第二套图，是**任务步骤树**，而且完全在线：
 *
 *   migration 094_ubuddy_collaboration_graph.sql
 *     collaboration_graphs / _nodes / _edges / _events
 *   cloud/src/modules/collaboration/collaborationGraph.mjs   （publish / read）
 *   cloud/src/server.mjs:2689 /api/collaboration/graph GET，:2702 POST
 *
 * 它的节点形状与 RDMD 契约**同层**：`kind ∈ {root,ubuddy,agent_task}`（三级深，depth≤2）、
 * `parent_node_id`（树/DAG 结构）、`title` + `public_summary`（富文本）、`status`/`progress`、
 * 以及 `collaboration_graph_events` 的 `graph_revision` + `public_patch_json`（**变更流**）。
 *
 * 所以本脚本的**主基质**是 collaboration_graph_*，`cloud_task_nodes` / `task_node_result_versions`
 * 作为第二基质（原始任务与结果版本）一并导出。
 *
 * 取样分两层，必须分开报，否则会把天花板当基线：
 *   baseline —— 随机抽 N 张图，量 base rate
 *   top      —— 按（节点数, 事件数）取 Top 50，量天花板
 *
 * 脱敏：复用仓库自己的函数，不另写一套。
 *   sanitizeCollaborationPublicValue  src/shared/contracts/uBuddyCollaborationGraph.js
 *   publicTraceMetadata               cloud/src/modules/collaboration/stateGraph.mjs
 *
 * 用法：
 *   DATABASE_URL=postgres://... node export_ubuddy_task_samples.mjs [OUT_DIR]
 *   UBUDDY_RECON_BASELINE=200 UBUDDY_RECON_TOP=50   # 可调样本量
 *
 * 注意：导出物是**真实数据**。默认写到 experiments/ 下的 recon 目录，不要提交到版本库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { sanitizeCollaborationPublicValue } from '../../../src/shared/contracts/uBuddyCollaborationGraph.js';
import { publicTraceMetadata } from '../../../cloud/src/modules/collaboration/stateGraph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(process.argv[2] || HERE);
const BASELINE_N = Math.max(0, Number(process.env.UBUDDY_RECON_BASELINE || 200));
const TOP_N = Math.max(0, Number(process.env.UBUDDY_RECON_TOP || 50));
const STATEMENT_TIMEOUT_MS = Number(process.env.UBUDDY_RECON_TIMEOUT_MS || 180_000);

const databaseUrl = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL || '';
if (!databaseUrl) throw new Error('DATABASE_MIGRATOR_URL or DATABASE_URL is required.');

const pool = new pg.Pool({ connectionString: databaseUrl, statement_timeout: STATEMENT_TIMEOUT_MS });

/** 每个表的导出行数，写进 manifest。导出 0 行本身是结论（表没建/没数据），不是错误。 */
const counts = {};
const skipped = [];

// 表可能不存在：migration 094 未应用是完全可能的部署状态，那是**发现**而不是崩溃。
// 所以探测存在性，并对缺失给出明确原因，而不是让整个导出失败。
async function tableExists(name) {
  const result = await pool.query('SELECT to_regclass($1) AS oid', [`public.${name}`]);
  return Boolean(result.rows[0]?.oid);
}

async function optionalRows(label, sql, params = []) {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (error) {
    skipped.push({ label, error: String(error.message || error).slice(0, 300) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// 取样
// ---------------------------------------------------------------------------

async function sampleGraphIds() {
  if (!await tableExists('collaboration_graphs')) {
    return { baseline: [], top: [], reason: 'collaboration_graphs_missing' };
  }
  // baseline：随机。表很小时 random() 会全取，那是正确的（样本=总体）。
  const baseline = BASELINE_N
    ? (await optionalRows('sample_baseline',
        'SELECT id FROM collaboration_graphs ORDER BY random() LIMIT $1', [BASELINE_N]) || []).map((row) => row.id)
    : [];
  // top：按结构复杂度取天花板。用节点数+事件数排序；子查询失败则退化为只按 revision。
  const topRows = await optionalRows('sample_top', `
    SELECT g.id,
           (SELECT count(*) FROM collaboration_graph_nodes n WHERE n.graph_id = g.id) AS node_count,
           (SELECT count(*) FROM collaboration_graph_events e WHERE e.graph_id = g.id) AS event_count
    FROM collaboration_graphs g
    ORDER BY node_count DESC, event_count DESC, g.updated_at DESC
    LIMIT $1`, [TOP_N]);
  const top = (topRows || []).map((row) => row.id);
  return { baseline, top, reason: '' };
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

// 自由文本：用协作图的公开净化器（会按 key 与 value 双重过滤私有内容）。
function sanitizeText(value) {
  if (value === null || value === undefined) return '';
  const clean = sanitizeCollaborationPublicValue(String(value));
  return typeof clean === 'string' ? clean : String(clean ?? '');
}

// json 字段：public_metadata_json / public_patch_json 是**追踪元数据**，用追踪侧的脱敏器，
// 它会额外剔除 privateTaskWorkspace/localPath 这类键。先过 publicTraceMetadata 再去 key 过滤。
function sanitizeJson(value) {
  const meta = publicTraceMetadata(value && typeof value === 'object' ? value : {});
  return sanitizeCollaborationPublicValue(meta);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

async function exportCollaborationGraphs(graphIds, stratumOf) {
  if (!graphIds.length) return { graphs: [], nodes: [], edges: [], events: [] };
  const graphs = (await pool.query(
    `SELECT id, graph_version, root_task_run_id, root_delegation_id, root_group_id, root_node_id,
            owner_user_id, title, current_revision, lifecycle_status, created_at, updated_at
     FROM collaboration_graphs WHERE id = ANY($1::text[])`, [graphIds])).rows
    .map((row) => ({
      graph_id: row.id,
      graph_version: sanitizeText(row.graph_version),
      root_task_run_id: String(row.root_task_run_id || ''),
      root_delegation_id: String(row.root_delegation_id || ''),
      root_group_id: String(row.root_group_id || ''),
      root_node_id: String(row.root_node_id || ''),
      owner_user_id: String(row.owner_user_id || ''),
      title: sanitizeText(row.title),
      current_revision: Number(row.current_revision || 0),
      lifecycle_status: sanitizeText(row.lifecycle_status),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      _stratum: stratumOf.get(row.id) || 'unknown',
    }));

  const nodes = (await pool.query(
    `SELECT graph_id, node_id, parent_node_id, kind, task_run_id, delegation_id, task_node_id,
            owner_user_id, owner_agent_id, owner_agent_instance_id, title, public_summary,
            status, progress, depth, visibility, public_metadata_json, source_revision,
            created_at, updated_at
     FROM collaboration_graph_nodes WHERE graph_id = ANY($1::text[])`, [graphIds])).rows
    .map((row) => ({
      graph_id: row.graph_id,
      node_id: String(row.node_id || ''),
      parent_node_id: String(row.parent_node_id || ''),
      kind: sanitizeText(row.kind),
      task_run_id: String(row.task_run_id || ''),
      delegation_id: String(row.delegation_id || ''),
      task_node_id: String(row.task_node_id || ''),
      owner_user_id: String(row.owner_user_id || ''),
      owner_agent_id: String(row.owner_agent_id || ''),
      owner_agent_instance_id: String(row.owner_agent_instance_id || ''),
      title: sanitizeText(row.title),
      public_summary: sanitizeText(row.public_summary),
      status: sanitizeText(row.status),
      progress: Number(row.progress || 0),
      depth: Number(row.depth || 0),
      visibility: sanitizeText(row.visibility),
      public_metadata: sanitizeJson(row.public_metadata_json),
      source_revision: Number(row.source_revision || 0),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      _stratum: stratumOf.get(row.graph_id) || 'unknown',
    }));

  const edges = (await pool.query(
    `SELECT graph_id, edge_id, kind, from_node_id, to_node_id, public_metadata_json,
            source_revision, created_at, updated_at
     FROM collaboration_graph_edges WHERE graph_id = ANY($1::text[])`, [graphIds])).rows
    .map((row) => ({
      graph_id: row.graph_id,
      edge_id: String(row.edge_id || ''),
      kind: sanitizeText(row.kind),
      from_node_id: String(row.from_node_id || ''),
      to_node_id: String(row.to_node_id || ''),
      public_metadata: sanitizeJson(row.public_metadata_json),
      source_revision: Number(row.source_revision || 0),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      _stratum: stratumOf.get(row.graph_id) || 'unknown',
    }));

  // 事件流是 before/after 的痕迹来源（graph_revision 递增 + public_patch_json），
  // 也是标签候选取向的来源（event_type）。逐图限量，避免单图把文件撑爆。
  const events = (await pool.query(
    `SELECT * FROM (
       SELECT graph_id, graph_revision, event_id, event_type, node_id, public_patch_json,
              actor_user_id, actor_agent_instance_id, created_at,
              row_number() OVER (PARTITION BY graph_id ORDER BY graph_revision) AS rn
       FROM collaboration_graph_events WHERE graph_id = ANY($1::text[])
     ) t WHERE t.rn <= 2000`, [graphIds])).rows
    .map((row) => ({
      graph_id: row.graph_id,
      graph_revision: Number(row.graph_revision || 0),
      event_id: String(row.event_id || ''),
      event_type: sanitizeText(row.event_type),
      node_id: String(row.node_id || ''),
      public_patch: sanitizeJson(row.public_patch_json),
      actor_user_id: String(row.actor_user_id || ''),
      actor_agent_instance_id: String(row.actor_agent_instance_id || ''),
      created_at: iso(row.created_at),
      _stratum: stratumOf.get(row.graph_id) || 'unknown',
    }));

  return { graphs, nodes, edges, events };
}

async function exportTaskData(taskRunIds, strataByTaskRun) {
  if (!taskRunIds.length) return { taskNodes: [], resultVersions: [] };
  const taskNodes = await optionalRows('cloud_task_nodes',
    `SELECT id, task_run_id, user_agent_instance_id, payload_json, updated_at
     FROM cloud_task_nodes WHERE task_run_id = ANY($1::text[])`, [taskRunIds]);
  const resultVersions = await optionalRows('task_node_result_versions',
    `SELECT id, task_run_id, task_node_id, graph_revision_id, version_no, result_text,
            result_summary, decision, decision_reason, created_at, decided_at
     FROM task_node_result_versions WHERE task_run_id = ANY($1::text[])`, [taskRunIds]);
  return {
    taskNodes: (taskNodes || []).map((row) => ({
      id: String(row.id || ''),
      task_run_id: String(row.task_run_id || ''),
      user_agent_instance_id: String(row.user_agent_instance_id || ''),
      payload: sanitizeJson(row.payload_json),
      updated_at: iso(row.updated_at),
      _stratum: strataByTaskRun.get(String(row.task_run_id || '')) || 'unknown',
    })),
    resultVersions: (resultVersions || []).map((row) => ({
      id: String(row.id || ''),
      task_run_id: String(row.task_run_id || ''),
      task_node_id: String(row.task_node_id || ''),
      graph_revision_id: String(row.graph_revision_id || ''),
      version_no: Number(row.version_no || 0),
      result_text: sanitizeText(row.result_text),
      result_summary: sanitizeText(row.result_summary),
      decision: sanitizeText(row.decision),
      decision_reason: sanitizeText(row.decision_reason),
      created_at: iso(row.created_at),
      decided_at: iso(row.decided_at),
      _stratum: strataByTaskRun.get(String(row.task_run_id || '')) || 'unknown',
    })),
  };
}

/** 体量：训练与评测的可行性直接取决于这些计数。表不存在时给 null，而不是 0。 */
async function exportVolume() {
  const countsFor = async (table, expr = '*') => {
    if (!await tableExists(table)) return null;
    try {
      return Number((await pool.query(`SELECT count(${expr})::bigint AS n FROM ${table}`)).rows[0].n);
    } catch (error) {
      skipped.push({ label: `volume_${table}`, error: String(error.message || error).slice(0, 200) });
      return null;
    }
  };
  const distinct = async (label, sql) => {
    try {
      return Number((await pool.query(sql)).rows[0].n);
    } catch (error) {
      skipped.push({ label, error: String(error.message || error).slice(0, 200) });
      return null;
    }
  };
  return {
    collaboration_graphs: await countsFor('collaboration_graphs'),
    collaboration_graph_nodes: await countsFor('collaboration_graph_nodes'),
    collaboration_graph_edges: await countsFor('collaboration_graph_edges'),
    collaboration_graph_events: await countsFor('collaboration_graph_events'),
    cloud_task_runs: await countsFor('cloud_task_runs'),
    cloud_task_nodes: await countsFor('cloud_task_nodes'),
    task_node_result_versions: await countsFor('task_node_result_versions'),
    graphs_with_agent_task_nodes: await distinct('graphs_with_agent_task_nodes',
      `SELECT count(DISTINCT graph_id)::bigint AS n FROM collaboration_graph_nodes WHERE kind='agent_task'`),
    graphs_with_2plus_events: await distinct('graphs_with_2plus_events',
      `SELECT count(*)::bigint AS n FROM (SELECT graph_id FROM collaboration_graph_events
        GROUP BY graph_id HAVING count(*) >= 2) t`),
    task_runs_with_superseded: await distinct('task_runs_with_superseded',
      `SELECT count(DISTINCT task_run_id)::bigint AS n FROM task_node_result_versions
        WHERE decision IN ('superseded','rejected')`),
  };
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

async function writeJsonl(name, rows) {
  await fs.writeFile(path.join(OUT_DIR, name), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  counts[name] = rows.length;
}

function iso(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

/** 连接串里含凭据，绝不写进 manifest。只保留 host/port/database 以便事后核对来源。 */
function redactTarget(url) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parsed.port || '5432', database: parsed.pathname.replace(/^\//, '') };
  } catch {
    return { host: '', port: '', database: '', note: 'unparsable connection string' };
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { baseline, top, reason } = await sampleGraphIds();
  const stratumOf = new Map();
  for (const id of baseline) stratumOf.set(id, 'baseline');
  // top 与该 id 同时被随机抽中时，标记为 both —— 分析时必须能识别重叠，否则两层会被重复计数。
  for (const id of top) stratumOf.set(id, stratumOf.has(id) ? 'both' : 'top');
  const graphIds = [...stratumOf.keys()];

  if (reason) skipped.push({ label: 'graph_sampling', error: reason });

  // 节点表存在但图表为空时，仍要报告 task 层的体量，所以不提前返回。
  const graphData = graphIds.length
    ? await exportCollaborationGraphs(graphIds, stratumOf)
    : { graphs: [], nodes: [], edges: [], events: [] };

  // 任务侧：用图的 root_task_run_id 与节点上的 task_run_id 作为入口。
  const taskRunIds = [...new Set([
    ...graphData.graphs.map((row) => row.root_task_run_id),
    ...graphData.nodes.map((row) => row.task_run_id),
  ].filter(Boolean))];
  const strataByTaskRun = new Map();
  for (const node of graphData.nodes) {
    if (node.task_run_id) strataByTaskRun.set(node.task_run_id, stratumOf.get(node.graph_id) || 'unknown');
  }
  for (const graph of graphData.graphs) {
    if (graph.root_task_run_id) strataByTaskRun.set(graph.root_task_run_id, graph._stratum);
  }
  const taskData = await exportTaskData(taskRunIds, strataByTaskRun);
  const volume = await exportVolume();

  await writeJsonl('collaboration_graphs.jsonl', graphData.graphs);
  await writeJsonl('collaboration_graph_nodes.jsonl', graphData.nodes);
  await writeJsonl('collaboration_graph_edges.jsonl', graphData.edges);
  await writeJsonl('collaboration_graph_events.jsonl', graphData.events);
  await writeJsonl('cloud_task_nodes.jsonl', taskData.taskNodes);
  await writeJsonl('task_node_result_versions.jsonl', taskData.resultVersions);

  const manifest = {
    // 分析器据此区分「真实数据」与「合成夹具」。没有这一项就不该把结果当证据引用。
    //
    // 关键：导出脚本**无法自己判断**连的是生产库还是测试实例 —— 它只能看到连接串。
    // 所以这里不猜。操作者必须用 UBUDDY_RECON_SOURCE 显式声明；不声明就是
    // 'unverified_postgres'，分析器会据此拒绝把它当证据（退出码非 0）。
    // 这一层存在的理由：把夹具当证据引用是这类侦察最典型、也最贵的错误。
    source: process.env.UBUDDY_RECON_SOURCE || 'unverified_postgres',
    sourceDeclaredBy: process.env.UBUDDY_RECON_SOURCE ? 'env:UBUDDY_RECON_SOURCE' : '(not declared)',
    // 记录导出的目标（去掉凭据），便于事后核对这份文件到底来自哪里。
    target: redactTarget(databaseUrl),
    exportedAt: new Date().toISOString(),
    sampling: {
      baselineRequested: BASELINE_N,
      topRequested: TOP_N,
      graphsSampled: graphIds.length,
      baselineGraphs: graphData.graphs.filter((row) => row._stratum === 'baseline').length,
      topGraphs: graphData.graphs.filter((row) => row._stratum === 'top').length,
      overlappingGraphs: graphData.graphs.filter((row) => row._stratum === 'both').length,
      taskRunsLinked: taskRunIds.length,
      note: 'baseline 随机 / top 按结构复杂度；重叠记为 both，分析时不得重复计数',
    },
    redaction: {
      policy: 'sanitizeCollaborationPublicValue + publicTraceMetadata',
      appliedTo: ['title', 'public_summary', 'public_metadata', 'public_patch', 'payload',
        'result_text', 'result_summary', 'decision_reason'],
      note: '复用仓库既有净化器；协作图在写入时已过一次 safePublicJson',
    },
    volume,
    rowCounts: counts,
    skipped,
  };
  await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: skipped.length === 0,
    source: manifest.source,
    sourceDeclaredBy: manifest.sourceDeclaredBy,
    target: manifest.target,
    graphsSampled: graphIds.length,
    taskRunsLinked: taskRunIds.length,
    rowCounts: counts,
    volume,
    skipped,
    output: OUT_DIR,
  }, null, 2));
  if (manifest.source !== 'real_postgres') {
    console.error(`[warn] source is "${manifest.source}", not "real_postgres".`);
    console.error('       The analyzer will refuse to grade this as evidence (non-zero exit).');
    console.error('       Declare UBUDDY_RECON_SOURCE=real_postgres only when this really is production data.');
  }
}

try {
  await main();
} finally {
  await pool.end();
}
