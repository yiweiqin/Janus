// 在真实 SQLite 上精量 uBuddy 任务图相关的**上游表**（只读）。
//
// 为什么是上游表：collaboration_graph_* 在所有已安装构建里都不存在
// （见 _probe_true_graph.mjs 的结论），因此真实数据只落在 task_runs /
// task_nodes / task_node_result_versions / task_graph_revisions / task_events。
//
// 目的：为文档修正提供**准确数字**，并把「构建里没有这个功能」与
// 「功能产出的结构不成立」严格区分开。
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error('usage: node measure_ubuddy_upstream.mjs <path-to-janus.db>');
  process.exit(2);
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const q = (sql, params = []) => {
  try { return db.prepare(sql).all(...params); }
  catch (e) { return [{ __error: String(e?.message || e) }]; }
};
const one = (sql, params = []) => q(sql, params)[0];
const has = (t) => {
  const r = one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
  return Boolean(r && !r.__error);
};
const cols = (t) => q(`PRAGMA table_info(${t})`).map((r) => r.name);

const line = (s = '') => console.log(s);
console.log(`DB: ${DB_PATH}`);
line('='.repeat(70));

// ---------- 1. task_nodes 结构与内容 ----------
line('\n### 1. task_nodes');
const tnCols = cols('task_nodes');
line(`列 (${tnCols.length}): ${tnCols.join(', ')}`);
line(`行数: ${one('SELECT count(*) n FROM task_nodes').n}`);

if (tnCols.includes('dependencies_json')) {
  line('\n-- dependencies_json 取值分布 --');
  for (const r of q(`SELECT coalesce(nullif(trim(dependencies_json),''),'<empty>') AS v, count(*) AS n
                     FROM task_nodes GROUP BY v ORDER BY n DESC`)) {
    line(`  ${String(r.v).padEnd(40)} n=${r.n}`);
  }
  const nonEmpty = one(`SELECT count(*) n FROM task_nodes
      WHERE trim(coalesce(dependencies_json,'')) NOT IN ('','[]','null')`).n;
  line(`  -> 非空依赖数组的节点数: ${nonEmpty} / ${one('SELECT count(*) n FROM task_nodes').n}`);
}

line('\n-- 每个 task_run 的节点数 --');
const perRun = q(`SELECT task_run_id, count(*) AS n FROM task_nodes GROUP BY task_run_id ORDER BY n DESC`);
for (const r of perRun) line(`  ${String(r.task_run_id).slice(0, 44).padEnd(46)} nodes=${r.n}`);
if (perRun.length) {
  const ns = perRun.map((r) => r.n).sort((a, b) => a - b);
  const pct = (p) => ns[Math.min(ns.length - 1, Math.floor(ns.length * p))];
  line(`  -> runs=${ns.length} min=${ns[0]} p50=${pct(0.5)} p90=${pct(0.9)} max=${ns.at(-1)}  total_nodes=${ns.reduce((a, b) => a + b, 0)}`);
}

// ---------- 2. task_graph_revisions ----------
line('\n### 2. task_graph_revisions');
if (has('task_graph_revisions')) {
  const rc = cols('task_graph_revisions');
  line(`列: ${rc.join(', ')}`);
  line(`行数: ${one('SELECT count(*) n FROM task_graph_revisions').n}`);
  line('\n-- revision_type 分布 --');
  for (const r of q(`SELECT revision_type, count(*) AS n FROM task_graph_revisions GROUP BY revision_type ORDER BY n DESC`)) {
    line(`  ${String(r.revision_type).padEnd(28)} n=${r.n}`);
  }
  const d = one('SELECT count(DISTINCT revision_type) n FROM task_graph_revisions');
  line(`  -> distinct revision_type = ${d.n}（=1 说明只有一种变更类型，不构成 plan/exec 演进）`);
}

// ---------- 3. task_node_result_versions（富文本） ----------
line('\n### 3. task_node_result_versions');
if (has('task_node_result_versions')) {
  const vc = cols('task_node_result_versions');
  line(`列: ${vc.join(', ')}`);
  const tot = one('SELECT count(*) n FROM task_node_result_versions').n;
  line(`行数: ${tot}`);
  if (vc.includes('result_text')) {
    const f = one(`SELECT count(*) n FROM task_node_result_versions WHERE trim(coalesce(result_text,''))<>''`).n;
    line(`  result_text 非空: ${f} / ${tot}`);
  }
}

// ---------- 4. task_events 类型分布 ----------
line('\n### 4. task_events');
if (has('task_events')) {
  const ec = cols('task_events');
  line(`列: ${ec.join(', ')}`);
  const tot = one('SELECT count(*) n FROM task_events').n;
  line(`行数: ${tot}`);
  const tcol = ec.includes('event_type') ? 'event_type' : (ec.includes('type') ? 'type' : null);
  if (tcol) {
    line(`\n-- ${tcol} 分布 (top 20) --`);
    for (const r of q(`SELECT ${tcol} AS t, count(*) AS n FROM task_events GROUP BY t ORDER BY n DESC LIMIT 20`)) {
      line(`  ${String(r.t).padEnd(36)} n=${r.n}`);
    }
    line(`  distinct ${tcol} = ${one(`SELECT count(DISTINCT ${tcol}) n FROM task_events`).n}`);
  }
}

// ---------- 5. collaboration_graph_* 存在性（复核） ----------
line('\n### 5. collaboration_graph_* 存在性（复核）');
for (const t of ['collaboration_graphs', 'collaboration_graph_nodes', 'collaboration_graph_edges', 'collaboration_graph_events']) {
  line(`  ${has(t) ? 'EXISTS' : 'MISSING'}  ${t}`);
}

db.close();
