// P2 排查：local_replan 在 step 层为什么没进 manifest.stepForms？
//
// 上一步的探针（_probe_step_local_replan.mjs）证明采样器**能**采到 local_replan 的 step 形态，
// 所以缺口只可能在生成器收集/统计这一段。这里直接读已落盘的 data/*.jsonl 对账，
// 不再重新生成。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

const rows = [];
for (const name of ['train', 'development', 'test']) {
  for (const row of readJsonl(join(HERE, 'data', `${name}.jsonl`))) rows.push(row);
}

const drift = rows.filter((row) => row.label?.status === 'drift');
const stepRows = drift.filter((row) => String(row.label?.injected_form || '').includes('step_'));

const byType = {};
for (const row of drift) byType[row.label.injected_type] = (byType[row.label.injected_type] || 0) + 1;
const stepByType = {};
for (const row of stepRows) stepByType[row.label.injected_type] = (stepByType[row.label.injected_type] || 0) + 1;

// gold 节点在 G_star 里的 kind（缺失即平铺族）。
const stepByGoldKind = {};
for (const row of stepRows) {
  const node = row.G_star.nodes.find((item) => item.id === row.label.injected_node);
  const key = node ? (node.kind || 'agent_task(缺省)') : 'gold 不存在于 G_star';
  stepByGoldKind[key] = (stepByGoldKind[key] || 0) + 1;
}

// local_replan 的全体分布：形态 × gold 层。
const replan = drift.filter((row) => row.label.injected_type === 'local_replan');
const replanShape = {};
for (const row of replan) {
  const node = row.G_star.nodes.find((item) => item.id === row.label.injected_node);
  const kind = node ? (node.kind || 'agent_task(缺省)') : 'missing';
  const form = row.label.injected_form || '(空)';
  const key = `${kind} | ${form.includes('step_') ? 'step 形态' : 'domain 形态'}`;
  replanShape[key] = (replanShape[key] || 0) + 1;
}

console.log(JSON.stringify({
  rows: rows.length,
  drift: drift.length,
  stepFormRows: stepRows.length,
  byType,
  stepByType,
  stepByGoldKind,
  replanTotal: replan.length,
  replanShape,
}, null, 2));
