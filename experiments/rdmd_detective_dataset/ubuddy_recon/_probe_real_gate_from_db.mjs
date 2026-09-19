// P1 探针：把真实库的 task_nodes 按**产品投影**（buildPlanExecGraphs/execNodeOf 的字段来源）
// 投成 case，再交给官方守卫 deploy/predict.py --dry-run 判。
//
// 为什么需要它：`route_evolution_e2e.mjs` 的 A 段用的是 gplanGexecLib#buildOrganizationalGraphs，
// 那是**侦察用的原始投影** —— 不带 kind、不带 summary/output，于是每个节点都被当成
// 兜底档 agent_task（最严），exec 侧恒缺 summary/output。用它得出的 6/6 说明的是
// 「这个投影缺字段」，不是「真实数据缺字段」。两者必须分开量。
//
// 本探针只读真实库，不改它；只构造 case，不改产品代码。
//
// 字段来源逐字对照 uBuddyPlanExec.js#execNodeOf:
//   title   <- task_nodes.title
//   agentId <- task_nodes.agent_id           (产品里是 ownerAgentId)
//   status  <- task_nodes.status
//   summary <- task_nodes.result_summary || wait_reason || error_text || objective
//              (产品里是 public_summary <- publicTaskNodeSummary)
//   output  <- task_nodes.result_text        (仅 agent_task 层)
//
// 用法：node _probe_real_gate_from_db.mjs <janus.db> [out-dir]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DB_PATH = process.argv[2];
const OUT_DIR = process.argv[3] || path.join(import.meta.dirname, '_real_gate_db');
if (!DB_PATH) { console.error('usage: node _probe_real_gate_from_db.mjs <janus.db> [out-dir]'); process.exit(2); }

const DATASET_DIR = path.resolve(import.meta.dirname, '..');
const PREDICT_PY = path.join(DATASET_DIR, 'deploy', 'predict.py');
const { planExecCase, planExecContractGaps } = await import('../../../src/shared/contracts/uBuddyPlanExec.js');

fs.mkdirSync(OUT_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const q = (s, p = []) => db.prepare(s).all(...p);

const runs = q(`SELECT id, title, status FROM task_runs ORDER BY created_at`);
const nodesByRun = new Map();
for (const n of q(`SELECT * FROM task_nodes ORDER BY priority ASC, created_at ASC`)) {
  if (!nodesByRun.has(n.task_run_id)) nodesByRun.set(n.task_run_id, []);
  nodesByRun.get(n.task_run_id).push(n);
}

const s = (v) => (v == null ? '' : String(v));

// 产品的 publicTaskNodeSummary 口径：resultSummary || waitReason || errorText || objective。
const productSummary = (n) => s(n.result_summary) || s(n.wait_reason) || s(n.error_text) || s(n.objective);

// WITH_CONTAINERS=1 时补出产品必有的 root/ubuddy 容器层；=0 时只留 agent_task。
// 两种都报，免得结论依赖我这里的构造。
const WITH_CONTAINERS = process.env.WITH_CONTAINERS === '1';

function buildCase(run) {
  const rows = nodesByRun.get(run.id) || [];
  const fallback = new Set(rows.filter((n) => s(n.fallback) === 'true').map((n) => n.id));
  const execRows = rows;
  const planRows = rows.filter((n) => !fallback.has(n.id));

  const toExec = (n) => ({
    id: n.id, title: s(n.title), agentId: s(n.agent_id), kind: 'agent_task',
    status: s(n.status), summary: productSummary(n), output: s(n.result_text),
  });
  // 规划侧：提案节点只有 title/agentId（没有 outcome 文本），status 记 planned。
  const toPlan = (n) => ({
    id: n.id, title: s(n.title), agentId: s(n.agent_id), kind: 'agent_task',
    status: 'planned', summary: '', output: '',
  });

  const containers = (kindGrid) => {
    if (!WITH_CONTAINERS) return [];
    return [
      { id: `root:${run.id}`, title: s(run.title), agentId: '', kind: 'root', status: s(run.status), summary: s(run.title), output: '' },
      { id: `ubuddy:${run.id}`, title: s(run.title), agentId: '', kind: 'ubuddy', status: s(run.status), summary: s(run.title), output: '' },
    ].slice(0, kindGrid);
  };

  const mkEdges = (subset) => {
    const ids = new Set(subset.map((n) => n.id));
    const out = [];
    for (const n of rows) {
      if (!ids.has(n.id)) continue;
      let deps = []; try { deps = JSON.parse(s(n.dependencies_json) || '[]'); } catch { /* keep [] */ }
      for (const d of deps) if (ids.has(d)) out.push({ id: `${d}->${n.id}`, from: d, to: n.id });
    }
    return out;
  };

  const execNodes = [...containers(2), ...execRows.map(toExec)];
  const planNodes = [...containers(2), ...planRows.map(toPlan)];
  return planExecCase({ id: run.id, plan: { nodes: planNodes, edges: mkEdges(planNodes) }, exec: { nodes: execNodes, edges: mkEdges(execNodes) } });
}

const cases = runs.map(buildCase);
const casesPath = path.join(OUT_DIR, 'real_cases_product_projection.jsonl');
fs.writeFileSync(casesPath, `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8');

// --- JS 侧判定（与 Python 同一判据，用于本地快速看形状）---
const jsGaps = cases.map((c) => ({ id: c.id, gaps: planExecContractGaps(c) }));

// --- Python 侧判定（权威守卫）---
const py = spawnSync('python', [PREDICT_PY, '--input', casesPath, '--dry-run'], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
});
const gateLines = s(py.stdout).split(/\r?\n/).filter((l) => l.trim());
const perCase = gateLines.map((l) => { try { return JSON.parse(l); } catch { return { __unparsed: l.slice(0, 200) }; } });
const violating = perCase.filter((c) => Array.isArray(c.contractProblems) && c.contractProblems.length);

const shape = (p) => s(p).replace(/node_[0-9a-f-]{8,}/gi, '<node>').replace(/root:[0-9a-f-]{8,}/gi, '<root>').replace(/ubuddy:[0-9a-f-]{8,}/gi, '<ubuddy>');
const problemShapes = {};
for (const c of perCase) for (const p of c.contractProblems || []) problemShapes[shape(p)] = (problemShapes[shape(p)] || 0) + 1;

const result = {
  generatedAt: new Date().toISOString(),
  db: DB_PATH,
  withContainers: WITH_CONTAINERS,
  projection: 'product-shaped (kind + summary<-result_summary|wait_reason|error_text|objective + output<-result_text)',
  taskRunCount: cases.length,
  taskNodeCount: [...nodesByRun.values()].reduce((a, b) => a + b.length, 0),
  jsGapCounts: jsGaps.map((g) => ({ id: g.id, gaps: g.gaps.length, fields: [...new Set(g.gaps.map((x) => `${x.side}/${x.kind}:${x.field}`))] })),
  pythonGate: { exitCode: py.status, caseCount: perCase.length, violatingCount: violating.length, problemShapes, stderr: s(py.stderr).trim().split(/\r?\n/).filter(Boolean).slice(-3) },
};
fs.writeFileSync(path.join(OUT_DIR, 'real_gate_db_report.json'), JSON.stringify(result, null, 2), 'utf8');

console.log(`projection = product-shaped, WITH_CONTAINERS=${WITH_CONTAINERS ? 1 : 0}`);
console.log(`task_runs=${cases.length}  task_nodes=${result.taskNodeCount}`);
console.log(`[python gate] exit=${py.status}  violating=${violating.length}/${perCase.length}`);
console.log('problem shapes:', JSON.stringify(problemShapes, null, 1));
console.log('\nper task run (JS gaps / Python problems):');
for (let i = 0; i < cases.length; i += 1) {
  const g = jsGaps[i];
  const pc = perCase.find((c) => c.id === cases[i].id) || {};
  const fields = [...new Set(g.gaps.map((x) => `${x.side}/${x.kind}:${x.field}`))];
  console.log(`  ${cases[i].id}  jsGaps=${g.gaps.length}  pyProblems=${(pc.contractProblems || []).length}`);
  for (const f of fields) console.log(`      js: ${f}`);
  for (const p of pc.contractProblems || []) console.log(`      py: ${shape(p)}`);
}

// 剩下那几条到底缺在什么状态的节点上？这决定了它是契约缺口还是数据缺口。
console.log('\n=== which node statuses are missing output? ===');
for (const run of runs) {
  const rows = nodesByRun.get(run.id) || [];
  for (const n of rows) {
    if (s(n.result_text)) continue;
    console.log(`  ${run.id}  node=${n.id.slice(-8)}  status=${s(n.status)}  result_text=''  result_summary='${s(n.result_summary).slice(0, 20)}'  objective='${s(n.objective).slice(0, 24)}'`);
  }
}
console.log(`\n-> ${path.join(OUT_DIR, 'real_gate_db_report.json')}`);
