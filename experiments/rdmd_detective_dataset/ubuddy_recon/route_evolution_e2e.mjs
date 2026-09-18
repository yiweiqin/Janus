// 端到端接线对照：真实任务 → routeEvolution → 动作（只读，只记诊断）。
//
// 回答的问题：「把模型输出接进 routeEvolution，跑一次真实任务」到底会得到什么。
//
// 三段对照，缺一不可，因为能跑的东西和想跑的东西不是一回事：
//   A. 真实数据过**模型输入闸门** —— 用官方 deploy/predict.py --dry-run（权威守卫，不重写一遍）。
//      预期结果：拒答（缺 5 个富文本字段）。这是**设计行为**，不是 bug。
//   B. 真实数据过**规则基线** detectMinimalDrift —— 规则能吃窄字段，所以能出判定，
//      再喂 routeEvolution 得到动作。
//   C. **已录的真实模型判定**回放 routeEvolution —— 用验收时留下的 ood/adv verdicts，
//      证明「模型输出 → 路由动作」这段接线是通的。
//
// 边界（写进输出，不接受含糊）：
//   真实任务**没有标答**，训练是注入式监督。所以本报告只记诊断与路由动作，
//   **不声称**模型在真实任务上因果正确、不声称生产自进化已验证。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeQueriers, buildOrganizationalGraphs } from './gplanGexecLib.mjs';

const DB_PATH = process.argv[2];
const OUT_DIR = process.argv[3] || path.join(import.meta.dirname, '_e2e');
if (!DB_PATH) {
  console.error('usage: node route_evolution_e2e.mjs <janus.db> [out-dir]');
  process.exit(2);
}

const RECON_DIR = import.meta.dirname;
const DATASET_DIR = path.resolve(RECON_DIR, '..');
const PREDICT_PY = path.join(DATASET_DIR, 'deploy', 'predict.py');

const { detectMinimalDrift, routeEvolution } = await import(
  '../../../src/shared/contracts/uBuddyReverseDetective.js'
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const { q } = makeQueriers(db);
const runs = q(`SELECT id, title, status FROM task_runs ORDER BY created_at`);
const orgPairs = runs.map((r) => ({ title: r.title || '', ...buildOrganizationalGraphs(db, r.id) }));

// ---------- A. 真实数据 → 模型输入闸门 ----------
// 把组织层图投影成模型 case 形状（id / G_star / G_prime），交给官方守卫判。
const casesPath = path.join(OUT_DIR, 'real_cases.jsonl');
fs.writeFileSync(
  casesPath,
  orgPairs.map((p) => JSON.stringify({
    id: p.taskRunId,
    G_star: { nodes: p.plan.nodes, edges: p.plan.edges },
    G_prime: { nodes: p.exec.nodes, edges: p.exec.edges },
  })).join('\n') + '\n',
  'utf8',
);

const py = spawnSync('python', [PREDICT_PY, '--input', casesPath, '--dry-run'], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
});
const gateLines = String(py.stdout || '').split(/\r?\n/).filter((l) => l.trim());
const gatePerCase = gateLines.map((l) => { try { return JSON.parse(l); } catch { return { __unparsed: l.slice(0, 200) }; } });
const violating = gatePerCase.filter((c) => Array.isArray(c.contractProblems) && c.contractProblems.length);

const realInputGate = {
  command: `python deploy/predict.py --input <real_cases.jsonl> --dry-run`,
  exitCode: py.status,
  caseCount: gatePerCase.length,
  violatingCount: violating.length,
  error: py.error ? String(py.error.message || py.error) : '',
  stderr: String(py.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3),
  perCase: gatePerCase.map((c) => ({
    taskRunId: c.id,
    contractProblems: c.contractProblems || null,
    passed: !c.contractProblems,
  })),
  conclusion: violating.length
    ? '真实组织层图缺少 5 个富文本字段（artifact/stage/inputs/output/summary），模型按设计拒答。'
    : '真实图通过了输入闸门（与预期不符，需复查）。',
};

// 拒答后模型侧等价于「空判定 = UNKNOWN」，走 routeEvolution 看它变成什么动作。
const gateVerdict = { status: 'UNKNOWN', nodeId: '', edgeId: '', type: '', evidenceNodeIds: [] };
realInputGate.verdictAfterGate = gateVerdict;
realInputGate.actionAfterGate = routeEvolution(gateVerdict);

// ---------- B. 真实数据 → 规则基线 → routeEvolution ----------
const ruleVerdicts = orgPairs.map((p) => {
  const verdict = detectMinimalDrift(p.plan, p.exec);
  const slim = {
    status: verdict.status || '',
    nodeId: verdict.nodeId || '',
    edgeId: verdict.edgeId || '',
    type: verdict.type || '',
    evidenceNodeIds: verdict.evidenceNodeIds || [],
  };
  return { taskRunId: p.taskRunId, title: p.title, verdict: slim, action: routeEvolution(slim) };
});

// ---------- C. 已录模型判定 → routeEvolution（回放） ----------
const verdictSources = ['ood_verdicts.jsonl', 'adv_verdicts.jsonl'];
const replayed = [];
const sourceInfo = [];
for (const name of verdictSources) {
  const file = path.join(DATASET_DIR, name);
  if (!fs.existsSync(file)) { sourceInfo.push({ file: name, records: 0, missing: true }); continue; }
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const verdict = rec.verdict || {};
    replayed.push({
      id: rec.id || '', valid: rec.valid !== false, source: name,
      status: verdict.status || '', type: verdict.type || '',
      action: routeEvolution(verdict),
    });
    n += 1;
  }
  sourceInfo.push({ file: name, records: n, missing: false });
}

const tally = (items, key) => items.reduce((acc, item) => {
  const k = key(item) || '(empty)';
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

const recordedModelVerdicts = {
  sources: sourceInfo,
  recordCount: replayed.length,
  validCount: replayed.filter((r) => r.valid).length,
  verdictStatusCounts: tally(replayed, (r) => r.status),
  verdictTypeCounts: tally(replayed, (r) => r.type),
  actionCounts: tally(replayed, (r) => r.action.action),
  actionReasonCounts: tally(replayed, (r) => r.action.reason),
  samples: replayed.slice(0, 5),
};

// ---------- D. 判定形状 → 动作的完整映射（接线契约覆盖） ----------
const shapes = [
  { status: 'no_drift', nodeId: '', edgeId: '', type: '', evidenceNodeIds: [] },
  { status: 'UNKNOWN', nodeId: '', edgeId: '', type: '', evidenceNodeIds: ['n1'] },
  { status: 'drift', nodeId: 'n3', edgeId: '', type: 'wrong_agent', evidenceNodeIds: ['n3'] },
  { status: 'drift', nodeId: 'n3', edgeId: 'n1->n3', type: 'missing_dependency', evidenceNodeIds: ['n3'] },
  { status: 'drift', nodeId: 'n3', edgeId: '', type: 'wrong_version', evidenceNodeIds: ['n3'] },
  { status: 'drift', nodeId: 'n3', edgeId: '', type: 'wrong_acceptance', evidenceNodeIds: ['n3'] },
  { status: 'drift', nodeId: 'n3', edgeId: '', type: 'local_replan', evidenceNodeIds: ['n3'] },
];
const routingContract = shapes.map((verdict) => ({
  verdict,
  action: routeEvolution(verdict),
  actionWithSwap: verdict.type === 'wrong_agent'
    ? routeEvolution(verdict, { decision: 'replace' }) : undefined,
}));

const report = {
  generatedAt: new Date().toISOString(),
  db: DB_PATH,
  boundaries: {
    groundTruth: 'none',
    causalClaim: false,
    note: '真实任务无标答（训练是注入式监督）。本报告只记诊断与路由动作，不声称模型在真实任务上因果正确，也不声称生产自进化已验证。',
  },
  A_realInputGate: realInputGate,
  B_ruleBaseline: {
    pairCount: ruleVerdicts.length,
    actionCounts: tally(ruleVerdicts, (r) => r.action.action),
    verdicts: ruleVerdicts,
  },
  C_recordedModelVerdicts: recordedModelVerdicts,
  D_routingContract: routingContract,
};

const outFile = path.join(OUT_DIR, 'route_evolution_e2e.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

const line = (s) => console.log(s);
line(`[A] 真实数据过模型输入闸门：exit=${realInputGate.exitCode}，` +
  `${realInputGate.violatingCount}/${realInputGate.caseCount} 条违约 → ${realInputGate.conclusion}`);
line(`    闸门后的动作：${realInputGate.actionAfterGate.action} (${realInputGate.actionAfterGate.reason})`);
line(`[B] 规则基线在真实图上：${JSON.stringify(report.B_ruleBaseline.actionCounts)}`);
line(`[C] 已录模型判定回放 ${recordedModelVerdicts.recordCount} 条（valid=${recordedModelVerdicts.validCount}）`);
line(`    status: ${JSON.stringify(recordedModelVerdicts.verdictStatusCounts)}`);
line(`    type  : ${JSON.stringify(recordedModelVerdicts.verdictTypeCounts)}`);
line(`    动作  : ${JSON.stringify(recordedModelVerdicts.actionCounts)}`);
line(`[D] 判定形状 → 动作映射 ${routingContract.length} 条，全覆盖`);
line(`-> ${outFile}`);
