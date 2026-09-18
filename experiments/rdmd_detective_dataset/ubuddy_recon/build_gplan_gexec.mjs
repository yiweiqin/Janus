// G_plan / G_exec 的真实构造（只读，不写入任何真实库）。
// 构造定义见 G_PLAN_G_EXEC.zh-CN.md；纯函数在 gplanGexecLib.mjs。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeQueriers, buildOrganizationalGraphs, walkRollouts, buildAgentGraph, listSessionDirs,
} from './gplanGexecLib.mjs';

const DB_PATH = process.argv[2];
const CODEX_ROOT = process.argv[3];
const OUT_DIR = process.argv[4] || path.join(import.meta.dirname, '_graphs');
if (!DB_PATH || !CODEX_ROOT) {
  console.error('usage: node build_gplan_gexec.mjs <janus.db> <codex_backend_sessions-dir> [out-dir]');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const { q, one } = makeQueriers(db);
fs.mkdirSync(OUT_DIR, { recursive: true });

const runs = q(`SELECT id, title, status FROM task_runs ORDER BY created_at`);
const orgPairs = runs.map((r) => buildOrganizationalGraphs(db, r.id));

const agentGraphs = [];
const sessionJoin = [];
for (const sd of listSessionDirs(CODEX_ROOT)) {
  const files = walkRollouts(path.join(CODEX_ROOT, sd));
  const row = one('SELECT id, codex_thread_id, agent_id, status FROM sessions WHERE id=?', [sd]);
  sessionJoin.push({ sessionId: sd, inSessionsTable: Boolean(row), codexThreadId: row?.codex_thread_id || '', rolloutCount: files.length });
  for (const f of files) agentGraphs.push(buildAgentGraph(f, sd));
}

let drift;
try {
  const mod = await import('../../../src/shared/contracts/uBuddyReverseDetective.js');
  drift = orgPairs.map((p) => ({ taskRunId: p.taskRunId, verdict: mod.detectMinimalDrift(p.plan, p.exec) }));
} catch (error) {
  drift = [{ __error: String(error?.message || error) }];
}

const summary = {
  generatedAt: new Date().toISOString(),
  source: { db: path.basename(DB_PATH), codexRoot: CODEX_ROOT },
  organizational: {
    pairCount: orgPairs.length,
    planNodeCounts: orgPairs.map((p) => p.plan.nodes.length),
    execNodeCounts: orgPairs.map((p) => p.exec.nodes.length),
    planEdgeTotal: orgPairs.reduce((a, p) => a + p.plan.edges.length, 0),
    execEdgeTotal: orgPairs.reduce((a, p) => a + p.exec.edges.length, 0),
    supersessionTotal: orgPairs.reduce((a, p) => a + p.supersessions.length, 0),
  },
  agentLongHorizon: {
    graphCount: agentGraphs.length,
    chainLengths: agentGraphs.map((g) => g.chainLength),
    edgeTotal: agentGraphs.reduce((a, g) => a + g.graph.edges.length, 0),
    nodeTotal: agentGraphs.reduce((a, g) => a + g.graph.nodes.length, 0),
    interactionTotal: agentGraphs.reduce((a, g) => a + g.interactions, 0),
    bytesTotal: agentGraphs.reduce((a, g) => a + g.bytes, 0),
  },
  sessionJoin,
  driftDiagnostics: drift,
};

fs.writeFileSync(path.join(OUT_DIR, 'gplan_gexec.json'), JSON.stringify({ summary, orgPairs, agentGraphs }, null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'gplan_gexec_summary.json'), JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
db.close();
