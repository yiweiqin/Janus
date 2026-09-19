import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [reportPath, errPath, dbPath] = process.argv.slice(2);
const err = fs.readFileSync(errPath, 'utf8');
if (err.trim()) console.log('STDERR:', err.slice(0, 800));

const d = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));

console.log('=== A. 迁移在干净副本上的效果 ===');
console.log(JSON.stringify(d.steps.find((s) => s.step === 'migrate_on_snapshot'), null, 1));
console.log();
console.log('=== B. 真实 plan 事件 -> agent_step 层 ===');
console.log('plan source  :', JSON.stringify(d.planTarget));
console.log('plan_events  :', JSON.stringify(d.steps.find((s) => s.step === 'plan_events')));
console.log('nodesByKind  :', JSON.stringify((d.graph || {}).nodesByKind));
console.log('edgesByKind  :', JSON.stringify((d.graph || {}).edgesByKind));
console.log();
console.log('=== C. 闸门 ===');
console.log('passes:', d.gate.passes, '| gaps:', JSON.stringify(d.gate.gapSummary));
console.log('gap nodes:', JSON.stringify(d.gate.gaps.map((g) => g.nodeId + '/' + g.field)));
console.log('metric ready:', JSON.stringify(d.gate.metric));

console.log();
console.log('=== D. 那 2 个 output 空的节点是什么状态 ===');
const db = new DatabaseSync(dbPath);
for (const g of d.gate.gaps) {
  const r = db
    .prepare("SELECT node_id, kind, status, title, length(coalesce(public_summary,'')) slen, substr(coalesce(public_metadata_json,''),1,300) meta FROM collaboration_graph_nodes WHERE node_id = ?")
    .get(g.nodeId);
  console.log(' ', JSON.stringify(r));
}
console.log();
console.log('--- 全部节点：kind x status x (summary空, metadata空) ---');
const rows2 = db
  .prepare("SELECT kind, status, CASE WHEN coalesce(public_summary,'')='' THEN 's0' ELSE 's1' END ss, CASE WHEN coalesce(public_metadata_json,'') IN ('','{}') THEN 'm0' ELSE 'm1' END mm, COUNT(*) AS n FROM collaboration_graph_nodes GROUP BY 1,2,3,4 ORDER BY 1,2")
  .all();
console.log(JSON.stringify(rows2));
db.close();
