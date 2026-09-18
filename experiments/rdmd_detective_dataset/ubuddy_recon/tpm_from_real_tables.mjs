// 把 TPM 的 foundation / elevation / raw 三层接到**真实库表**（只读）。
//
// 接线的意义：TPM 契约（uBuddyTaskPublicMemory.js）此前只是纸面约定
// （官方自进化文档第 10 节自述「TPM 三层与申请审查契约（未接真实库表）」）。
// 本脚本证明：真实数据经 normalizeTaskPublicMemory 后**形状合规**，
// 并如实报告哪些层是**空的**、哪些层是**有内容但弱**的。
//
// 数据落点：
//   foundation.plan / foundation.exec  ← task_nodes + task_graph_revisions（见 gplanGexecLib.mjs）
//   raw                                ← task_node_result_versions.result_text（全文）
//   elevation                          ← task_nodes.result_summary（摘要）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { makeQueriers, buildOrganizationalGraphs } from './gplanGexecLib.mjs';

const DB_PATH = process.argv[2];
const OUT_DIR = process.argv[3] || path.join(import.meta.dirname, '_tpm');
if (!DB_PATH) {
  console.error('usage: node tpm_from_real_tables.mjs <janus.db> [out-dir]');
  process.exit(2);
}

const { normalizeTaskPublicMemory, UBUDDY_TPM_VERSION } = await import('../../../src/shared/contracts/uBuddyTaskPublicMemory.js');

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const { q } = makeQueriers(db);
fs.mkdirSync(OUT_DIR, { recursive: true });

const runs = q(`SELECT id, title, owner_user_id, status FROM task_runs ORDER BY created_at`);

const buildRaw = (taskRunId) => q(
  `SELECT id, task_node_id, version_no, result_text, result_summary, decision, decision_reason
   FROM task_node_result_versions WHERE task_run_id=? ORDER BY version_no`, [taskRunId],
).map((r) => ({
  id: r.id,
  kind: 'result_version',
  title: r.decision || r.decision_reason || '',
  content: r.result_text || r.result_summary || '',
  resultVersion: String(r.version_no ?? ''),
  nodeId: r.task_node_id || '',
}));

const buildElevation = (taskRunId) => q(
  `SELECT id, title, result_summary, result_text, attempt_count
   FROM task_nodes WHERE task_run_id=? AND trim(coalesce(result_summary,''))<>'' ORDER BY priority ASC, created_at ASC`,
  [taskRunId],
).map((r) => ({
  id: `elev_${r.id}`,
  sourceRawId: r.id,
  kind: 'node_summary',
  title: r.title || '',
  summary: r.result_summary || '',
  resultVersion: `attempt_${r.attempt_count ?? 0}`,
  inspectedAt: new Date().toISOString(),
}));

const tpms = runs.map((run) => {
  const g = buildOrganizationalGraphs(db, run.id);
  const elevation = buildElevation(run.id);
  const raw = buildRaw(run.id);
  const memory = normalizeTaskPublicMemory({
    version: UBUDDY_TPM_VERSION,
    taskId: run.id,
    ownerUserId: run.owner_user_id || '',
    participantUserIds: [],
    foundation: { plan: g.plan, exec: g.exec },
    elevation,
    raw,
  });
  // 契约是否把 foundation 的 id 原样保留（形状合规 + 未丢节点的证明）
  const inputPlanIds = g.plan.nodes.map((n) => n.id).join(',');
  const outputPlanIds = memory.foundation.plan.nodes.map((n) => n.id).join(',');
  const inputExecIds = g.exec.nodes.map((n) => n.id).join(',');
  const outputExecIds = memory.foundation.exec.nodes.map((n) => n.id).join(',');
  return {
    taskRunId: run.id,
    title: run.title || '',
    memory,
    supersessions: g.supersessions,
    roundTrip: {
      planPreserved: inputPlanIds === outputPlanIds,
      execPreserved: inputExecIds === outputExecIds,
      rawPreserved: raw.length === memory.raw.length,
      elevationPreserved: elevation.length === memory.elevation.length,
    },
  };
});

// ---------- 报告 ----------

const report = {
  generatedAt: new Date().toISOString(),
  db: path.basename(DB_PATH),
  tpmVersion: UBUDDY_TPM_VERSION,
  perTask: tpms.map((t) => {
    const m = t.memory;
    return {
      taskRunId: t.taskRunId,
      title: t.title.slice(0, 80),
      foundation: {
        planNodes: m.foundation.plan.nodes.length,
        planEdges: m.foundation.plan.edges.length,
        execNodes: m.foundation.exec.nodes.length,
        execEdges: m.foundation.exec.edges.length,
      },
      elevation: m.elevation.length,
      raw: m.raw.length,
      supersessions: t.supersessions.length,
      roundTrip: t.roundTrip,
    };
  }),
  totals: {
    tasks: tpms.length,
    planNodes: tpms.reduce((a, t) => a + t.memory.foundation.plan.nodes.length, 0),
    planEdges: tpms.reduce((a, t) => a + t.memory.foundation.plan.edges.length, 0),
    execNodes: tpms.reduce((a, t) => a + t.memory.foundation.exec.nodes.length, 0),
    execEdges: tpms.reduce((a, t) => a + t.memory.foundation.exec.edges.length, 0),
    elevation: tpms.reduce((a, t) => a + t.memory.elevation.length, 0),
    raw: tpms.reduce((a, t) => a + t.memory.raw.length, 0),
    roundTripAllPreserved: tpms.every((t) => Object.values(t.roundTrip).every(Boolean)),
  },
};

fs.writeFileSync(path.join(OUT_DIR, 'tpm_real.jsonl'), tpms.map((t) => JSON.stringify({ taskRunId: t.taskRunId, memory: t.memory })).join('\n') + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'tpm_real_report.json'), JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));
db.close();
