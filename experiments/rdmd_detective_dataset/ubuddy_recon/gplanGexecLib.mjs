// G_plan / G_exec 的纯构造函数（只读）。
// 定义见同目录 G_PLAN_G_EXEC.zh-CN.md。被 build_gplan_gexec.mjs 与 tpm_from_real_tables.mjs 共用。
import fs from 'node:fs';
import path from 'node:path';

export const makeQueriers = (db) => ({
  q: (s, p = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
  one: (s, p = []) => { try { return db.prepare(s).get(...p); } catch { return null; } },
});

// ---------- 组织层 ----------

/**
 * 组织层 G_plan / G_exec。
 *
 * G_plan = task_nodes 减去「由 revision 引入的 fallback 节点」（近似，无计划快照落库）
 * G_exec = 全部 task_nodes
 * 两图边唯一来源 = task_nodes.dependencies_json（实测全量 []）
 * replaced→fallback 是 supersession，单独记录，不当作边。
 */
export function buildOrganizationalGraphs(db, taskRunId) {
  const { q } = makeQueriers(db);
  const nodes = q(`SELECT id, title, agent_id, status, dependencies_json, attempt_count, max_attempts
                   FROM task_nodes WHERE task_run_id=? ORDER BY priority ASC, created_at ASC`, [taskRunId]);
  const revs = q(`SELECT id, revision_type, before_json, after_json FROM task_graph_revisions WHERE task_run_id=?`, [taskRunId]);

  const fallbackIds = new Set();
  const supersessions = [];
  for (const r of revs) {
    let after = {}; let before = {};
    try { after = JSON.parse(r.after_json || '{}'); } catch {}
    try { before = JSON.parse(r.before_json || '{}'); } catch {}
    if (after?.fallback?.id) fallbackIds.add(after.fallback.id);
    if (before?.replaced?.id && after?.fallback?.id) {
      supersessions.push({ replaced: before.replaced.id, fallback: after.fallback.id, revisionType: r.revision_type });
    }
  }

  const toNode = (n) => ({
    id: n.id,
    title: n.title || '',
    agentId: n.agent_id || '',
    version: 'v1',          // 无语义版本列；常量，见文档 §1.2
    acceptance: 'standard', // 无 acceptance 列；常量，见文档 §1.2
    role: '',
    status: n.status || '',
  });

  const planRows = nodes.filter((n) => !fallbackIds.has(n.id));
  const planNodes = planRows.map((n) => ({ ...toNode(n), status: 'planned' }));
  const execNodes = nodes.map(toNode);

  const edgesOf = (subset) => {
    const edges = [];
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of subset) {
      let deps = [];
      try { deps = JSON.parse(n.dependencies_json || '[]'); } catch {}
      for (const d of deps) if (ids.has(d)) edges.push({ id: `${d}->${n.id}`, from: d, to: n.id });
    }
    return edges;
  };

  return {
    taskRunId,
    // `edgesOf` 读的是**原始行**的 `dependencies_json`，所以两张图都必须喂原始行。
    // 规划侧曾经喂的是 `planNodes`（`toNode` 之后的映射对象，没有 dependencies_json），
    // 于是 G_plan 恒为零边、而 G_exec 有边 —— 同一批行、同样的依赖，只因为传错了一个数组。
    // 后果不是「少了几条边」：规则基线会把这看成每个依赖都缺失，在真实任务上稳定制造
    // 假漂移（实测 3/6 个任务被误判为 local_replan）。见 _probe_real_gate_from_db.mjs。
    plan: { nodes: planNodes, edges: edgesOf(planRows) },
    exec: { nodes: execNodes, edges: edgesOf(nodes) },
    supersessions,
    raw: { nodeCount: nodes.length, revisionCount: revs.length, fallbackCount: fallbackIds.size },
  };
}

// ---------- agent 长程层 ----------

export function walkRollouts(dir) {
  const out = [];
  (function walk(p) {
    let es = []; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(f);
    }
  })(dir);
  return out.sort();
}

const STEP_SUBTYPES = new Set(['reasoning', 'message', 'agent_message', 'function_call', 'custom_tool_call']);

/**
 * 把 Codex rollout 的 turn 序列投影成链式图。
 * 边 = 顺序链 turn_i -> turn_{i+1}；**顺序链 ≠ 依赖 DAG**，见文档 §2.2 与 §4.2。
 */
export function buildAgentGraph(rolloutFile, sessionId) {
  const raw = fs.readFileSync(rolloutFile, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const nodes = [];
  const edges = [];
  const counts = {};
  let interactions = 0;
  const m = path.basename(rolloutFile).match(/^rollout-.*?-(.+)$/);

  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = o.type || 'unknown';
    if (t === 'inter_agent_communication_metadata') interactions += 1;
    if (t !== 'response_item' && t !== 'event_msg') continue;
    const sub = o?.payload?.type || '';
    counts[`${t}:${sub}`] = (counts[`${t}:${sub}`] || 0) + 1;
    if (t !== 'response_item' || !STEP_SUBTYPES.has(sub)) continue;
    const seq = nodes.length;
    const label = sub === 'function_call' || sub === 'custom_tool_call'
      ? `${sub}:${o?.payload?.name || '?'}`
      : sub;
    nodes.push({ id: `${sessionId}#${seq}`, title: label, agentId: '', version: 'v1', acceptance: 'standard', role: sub, status: 'executed' });
    if (seq > 0) edges.push({ id: `${sessionId}#${seq - 1}->${sessionId}#${seq}`, from: `${sessionId}#${seq - 1}`, to: `${sessionId}#${seq}` });
  }

  return {
    sessionId,
    file: path.basename(rolloutFile),
    threadId: m ? m[1] : '',
    graph: { nodes, edges },
    chainLength: nodes.length,
    interactions,
    eventCounts: counts,
    bytes: Buffer.byteLength(raw),
  };
}

export function listSessionDirs(codexRoot) {
  if (!fs.existsSync(codexRoot)) return [];
  return fs.readdirSync(codexRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}
