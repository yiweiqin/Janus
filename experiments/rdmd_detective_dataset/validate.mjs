import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectMinimalDrift } from '../../src/shared/contracts/uBuddyReverseDetective.js';
import { SCHEMA, DEFAULT_NODE_STATUS, changedNodeIds, normalizeRichGraph, structuralGraph } from './lib/graph.mjs';
import { numericLabel } from './lib/obfuscate.mjs';
import { validateSample } from './lib/gates.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const numericArg = (name, fallback) => {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  const value = found ? Number(found.split('=')[1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

/** v3 acceptance gate: the lowest-id diff rule must not be able to solve the task. */
export function shortcutBaseline(rows) {
  let n = 0;
  let lowestIdHit = 0;
  for (const row of rows) {
    const changed = changedNodeIds(row.G_star, row.G_prime);
    if (!changed.length) continue;
    n += 1;
    const pick = [...changed].sort((left, right) => numericLabel(left) - numericLabel(right))[0];
    if (pick === row.label.injected_node) lowestIdHit += 1;
  }
  return { n, lowestIdNodeTop1: n ? lowestIdHit / n : 0 };
}

/**
 * P2 新增的捷径守卫：**只看 status**。
 *
 * 为什么必须加：`status` 是 P2 才进 prompt 的字段，而且它是四种 step 层漂移唯一的
 * 后果通道 —— 也就是语料里最强的单字段信号。一个只看它的规则如果也能解题，那么
 * 模型在 nodeId 上拿到的分数就说明不了任何事。
 *
 * 规则写成一个人在没有任何领域知识时会写的最朴素形态（不调参、不学权重）：
 *   在变点里挑一个 **status 在两侧不同** 的，`cancelled`/`failed` 优先于
 *   `blocked`/`running`，同级再按 id 最小；一个都没有就退回最低 id。
 *
 * 为什么它**应该**失败：step 形态的硬规则是 gold 的 status 永远保持基线
 * （见 forms.mjs 的 STEP_CATALOG 注释第 1 条），status 的变化只落在**下游**。
 * 所以这条规则领到的大概率是一个后代，而不是真凶。
 *
 * `statusOnlyFired` 单独报出来，是因为它低的时候 Top-1 也就没有说服力
 * （那时规则退回了最低 id）—— 不报这个数，守卫会变成一句自我安慰。
 */
export function statusShortcutBaseline(rows) {
  const rankOf = (status) => {
    if (status === 'cancelled' || status === 'failed') return 0;
    if (status === 'blocked' || status === 'running') return 1;
    if (status && status !== DEFAULT_NODE_STATUS) return 2;
    return 3;
  };
  let n = 0;
  let hit = 0;
  let fired = 0;
  for (const row of rows) {
    const changed = changedNodeIds(row.G_star, row.G_prime);
    if (!changed.length) continue;
    n += 1;
    const starStatus = {};
    for (const node of normalizeRichGraph(row.G_star).nodes) starStatus[node.id] = node.status;
    const primeStatus = {};
    for (const node of normalizeRichGraph(row.G_prime).nodes) primeStatus[node.id] = node.status;
    const statusMoved = [...changed].filter((id) => (
      // 只在两侧**都存在**的节点上算"状态迁移"。新增/删除的节点两个 id 里必有一个是
      // undefined，那不是 status 变了，是节点出现了 —— 把它算进来会让这条规则在
      // 每一个诱饵/插入步上都"开火"，守卫就变成了假阳性机器。
      Object.hasOwn(starStatus, id) && Object.hasOwn(primeStatus, id) && starStatus[id] !== primeStatus[id]
    ));
    if (statusMoved.length) fired += 1;
    const pool = statusMoved.length ? statusMoved : [...changed];
    const pick = pool.sort((left, right) => (
      rankOf(primeStatus[left]) - rankOf(primeStatus[right])
      || numericLabel(left) - numericLabel(right)
    ))[0];
    if (pick === row.label.injected_node) hit += 1;
  }
  return { n, statusOnlyTop1: n ? hit / n : 0, statusOnlyFired: n ? fired / n : 0 };
}

export function validateDataset({ expected = SCHEMA.targets, requireBaselineGap = true } = {}) {
  const splits = ['train', 'development', 'test'].map((name) => ({
    name,
    rows: readJsonl(join(DATA, `${name}.jsonl`)),
  }));
  const all = splits.flatMap((item) => item.rows);
  const errors = [];
  const graphSplit = new Map();
  const counts = { drift: 0, no_drift: 0, UNKNOWN: 0 };
  for (const sample of all) {
    const sampleErrors = validateSample(sample, { requireSplit: true });
    if (sampleErrors.length) errors.push({ id: sample.id, sampleErrors });
    counts[sample.label?.status] = (counts[sample.label?.status] || 0) + 1;
    const prev = graphSplit.get(sample.graph_id);
    if (prev && prev !== sample.split) errors.push({ id: sample.graph_id, sampleErrors: ['graph_id_split_leak'] });
    graphSplit.set(sample.graph_id, sample.split);
  }
  const test = splits.find((item) => item.name === 'test').rows;
  const driftTest = test.filter((row) => row.label.status === 'drift');
  let hit = 0;
  let typeHit = 0;
  let unknownOnSingle = 0;
  for (const row of driftTest) {
    const prediction = detectMinimalDrift(structuralGraph(row.G_star), structuralGraph(row.G_prime));
    if (prediction.status === 'UNKNOWN') unknownOnSingle += 1;
    if (prediction.status === 'drift' && prediction.nodeId === row.label.injected_node) hit += 1;
    if (prediction.type === row.label.injected_type) typeHit += 1;
  }
  const baseline = {
    n: driftTest.length,
    topologicalHit: driftTest.length ? hit / driftTest.length : 0,
    typeHit: driftTest.length ? typeHit / driftTest.length : 0,
    unknownRate: driftTest.length ? unknownOnSingle / driftTest.length : 0,
  };
  const driftAll = all.filter((row) => row.label?.status === 'drift');
  const hops = driftAll.map((row) => Number(row.label.hop_to_first_effect) || 0);
  const forms = new Set(driftAll.map((row) => row.label.injected_form).filter(Boolean));
  const meanHop = hops.length ? hops.reduce((a, b) => a + b, 0) / hops.length : 0;
  const hopOk = !driftAll.length || hops.every((hop) => hop >= (SCHEMA.minHopToFirstEffect || 3));
  const countsOk = counts.drift === expected.drift && counts.no_drift === expected.no_drift && counts.UNKNOWN === expected.UNKNOWN;
  const baselineOk = !requireBaselineGap || driftTest.length < 8 || baseline.topologicalHit < 0.95;
  const shortcut = shortcutBaseline(driftAll);
  // The v2 generator scored 1.000 here on every split. A v3 dataset is rejected when the
  // lowest-id-diff rule can still find the culprit.
  const shortcutLimit = 0.35;
  const shortcutOk = shortcut.n < 20 || shortcut.lowestIdNodeTop1 < shortcutLimit;
  // P2: 第二条捷径守卫。status 现在是 prompt 里的字段，而且是 step 层漂移唯一的后果通道，
  // 所以「只看 status」必须同样解不出题。规格与 lowest-id 一致（同一条 0.35 阈值）。
  const statusShortcut = statusShortcutBaseline(driftAll);
  const statusShortcutOk = statusShortcut.n < 20
    || (statusShortcut.statusOnlyTop1 < shortcutLimit && statusShortcut.statusOnlyFired > 0);
  const report = {
    n: all.length,
    counts,
    splits: Object.fromEntries(splits.map((item) => [item.name, item.rows.length])),
    invalid: errors.length,
    graphLeak: errors.filter((item) => item.sampleErrors?.includes('graph_id_split_leak')).length,
    baseline,
    shortcut: { ...shortcut, limit: shortcutLimit, ok: shortcutOk },
    statusShortcut: { ...statusShortcut, limit: shortcutLimit, ok: statusShortcutOk },
    longRange: { meanHop, minHop: hops.length ? Math.min(...hops) : 0, forms: forms.size },
    pass: errors.length === 0 && countsOk && baselineOk && hopOk && shortcutOk && statusShortcutOk,
  };
  writeFileSync(join(DATA, 'validation.json'), `${JSON.stringify({ ...report, errors: errors.slice(0, 50) }, null, 2)}\n`);
  return report;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const smoke = process.argv.includes('--smoke');
  const expected = {
    drift: smoke ? 16 : numericArg('drift', SCHEMA.targets.drift),
    no_drift: smoke ? 2 : numericArg('no-drift', SCHEMA.targets.no_drift),
    UNKNOWN: smoke ? 2 : numericArg('unknown', SCHEMA.targets.UNKNOWN),
  };
  const report = validateDataset({ expected, requireBaselineGap: !smoke });
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
