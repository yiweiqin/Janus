/**
 * 产品侧 case 形状 ↔ predict.py 契约守卫的一致性探针。
 *
 * 它只是把 `planExecCase` 的输出写成两个文件，然后喂给 predict.py 的 `--dry-run`
 * —— 不是适配器，不做任何投影转换（要证明的恰恰是「不需要转换」）。
 *
 * 用法（无需 GPU）：
 *   node experiments/rdmd_detective_dataset/ubuddy_recon/_probe_plan_exec_boundary.mjs <outDir>
 *   python experiments/rdmd_detective_dataset/deploy/predict.py --input <outDir>/thin.json --dry-run
 *   # -> exit 1，逐节点报 G_star/G_prime 的 5 个空富文本字段（真实 uBuddy 图今天就长这样）
 *   python experiments/rdmd_detective_dataset/deploy/predict.py --input <outDir>/rich.json --dry-run
 *   # -> exit 0，给出 prompt sha256（补齐富文本后契约成立，链路本身是通的）
 *
 * 2026-09-16 实测结论：thin 报 20 条 empty_*（2 图 × 2 节点 × 5 字段），rich 通过；
 * 且 `public_graph` 把 `kind` 丢掉了（它不属于 11 字段），与 `uBuddyPlanExec.js` 的判断一致。
 */
import fs from 'node:fs';
import path from 'node:path';

import { planExecCase } from '../../../src/shared/contracts/uBuddyPlanExec.js';

const dir = process.argv[2];
// 真实 uBuddy 形状：7 个可得字段，5 个富文本全空。
const thin = { nodes: [
  { id: 'root', title: 'Launch', agentId: 'agent', version: 'v1', acceptance: 'standard', role: '', kind: 'root' },
  { id: 'tn_a', title: '研究', agentId: 'research_agent', version: 'v1', acceptance: 'standard', role: '', kind: 'agent_task', status: 'completed' },
], edges: [{ id: 'root->tn_a', from: 'root', to: 'tn_a' }] };
const rich = { nodes: thin.nodes.map((node) => ({ ...node, artifact: 'artifact', stage: 'draft', inputs: 'brief', output: 'result', summary: 'did the research' })), edges: thin.edges };
fs.writeFileSync(path.join(dir, 'thin.json'), JSON.stringify(planExecCase({ id: 'thin', plan: thin, exec: thin })));
fs.writeFileSync(path.join(dir, 'rich.json'), JSON.stringify(planExecCase({ id: 'rich', plan: rich, exec: rich })));
console.log('wrote', dir);
