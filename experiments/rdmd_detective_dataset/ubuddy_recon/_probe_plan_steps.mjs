// 探针：确认 Codex rollout 里「计划步骤」的真实字段形状。
//
// 为什么需要它：投影要把 agent 的 plan step 变成图节点，就必须先知道
// step 对象里到底有哪些字段，而不是靠猜。本脚本只读，不改任何东西。
//
// 用法：
//   node _probe_plan_steps.mjs <codex_backend_sessions-dir> [maxSamples]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const MAX_SAMPLES = Number(process.argv[3] || 3);
if (!ROOT) {
  console.error('usage: node _probe_plan_steps.mjs <codex_backend_sessions-dir> [maxSamples]');
  process.exit(2);
}

function walkRollouts(dir) {
  const out = [];
  (function walk(p) {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(full);
    }
  })(dir);
  return out.sort();
}

const files = walkRollouts(ROOT);
const typeHistogram = {};
const keyHistogram = {};
const planSamples = [];
let stepFieldShapes = new Map();
let totalLines = 0;

function recordKeys(prefix, value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    const id = `${prefix}.${key}`;
    keyHistogram[id] = (keyHistogram[id] || 0) + 1;
  }
}

function recordSteps(where, steps) {
  if (!Array.isArray(steps) || !steps.length) return;
  const shape = [...new Set(steps.flatMap((step) => (step && typeof step === 'object' ? Object.keys(step) : [`<${typeof step}>`])))].sort();
  const id = shape.join(',');
  const entry = stepFieldShapes.get(id) || { count: 0, where: [] };
  entry.count += 1;
  if (entry.where.length < 5 && !entry.where.includes(where)) entry.where.push(where);
  stepFieldShapes.set(id, entry);
}

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    totalLines += 1;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = String(obj.type || 'unknown');
    const sub = String(obj?.payload?.type || '');
    const bucket = `${type}|${sub}`;
    typeHistogram[bucket] = (typeHistogram[bucket] || 0) + 1;
    if (type === 'response_item' || type === 'event_msg') recordKeys(`${type}|${sub}`, obj.payload);

    // 「计划」可能的三种落点：item.type==='plan'、payload.plan、以及 steps 数组
    const candidates = [
      ['payload.plan', obj?.payload?.plan],
      ['payload.steps', obj?.payload?.steps],
      ['payload.item.plan', obj?.payload?.item?.plan],
      ['payload.item.steps', obj?.payload?.item?.steps],
      ['payload', obj?.payload?.type === 'plan' ? obj.payload : null],
    ];
    for (const [where, value] of candidates) {
      if (Array.isArray(value) && value.length) {
        recordSteps(where, value);
        if (planSamples.length < MAX_SAMPLES) planSamples.push({ file: path.basename(file), where, sample: value.slice(0, 3) });
      }
    }
  }
}

const report = {
  codexRoot: ROOT,
  rolloutFileCount: files.length,
  totalLines,
  payloadTypeHistogram: Object.fromEntries(Object.entries(typeHistogram).sort((a, b) => b[1] - a[1])),
  planStepShapes: [...stepFieldShapes.entries()].map(([shape, meta]) => ({ fields: shape.split(','), occurrences: meta.count, where: meta.where })),
  planSamples,
  topLevelPayloadKeys: Object.fromEntries(Object.entries(keyHistogram).sort((a, b) => b[1] - a[1]).slice(0, 40)),
};

console.log(JSON.stringify(report, null, 2));
