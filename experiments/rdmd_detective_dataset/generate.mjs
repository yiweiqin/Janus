import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA, cloneRichGraph, normalizeRichGraph, stripForbiddenKeys } from './lib/graph.mjs';
import { obfuscateGraph } from './lib/obfuscate.mjs';
import { validateSample } from './lib/gates.mjs';
import { llmConfigured, llmJson, llmModel, loadPrompt } from './lib/llmClient.mjs';
import {
  addDecoyNodes, applyLocalEdit, generateGoldenGraph, inferDownstream, insertedNodesOf,
  pickForkPair, pickInjection,
} from './lib/localTeacher.mjs';
import { DRIFT_TYPES } from './lib/graph.mjs';
import { makeRng, splitForGraph } from './lib/rng.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const args = new Set(process.argv.slice(2));
const smoke = args.has('--smoke');
const backendArg = (process.argv.find((item) => item.startsWith('--backend=')) || '').split('=')[1];
const backend = backendArg || (llmConfigured() && smoke ? 'llm' : 'local');
const seed = Number((process.argv.find((item) => item.startsWith('--seed=')) || '--seed=20260910').split('=')[1]);
const numericArg = (name, fallback) => {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  const value = found ? Number(found.split('=')[1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

const BASE_TARGETS = smoke
  ? { drift: 16, no_drift: 2, UNKNOWN: 2, golden: 8 }
  : { ...SCHEMA.targets, golden: 1000 };

// 四层群任务族在 golden 池里的占比。默认取 schema 里的 0.5：
// 整条链路的目标是群任务，语料得有一半是它的形状（见 lib/localTeacher.mjs 的注释）。
const groupShare = numericArg('group-share', SCHEMA.groupShare ?? 0.5);

const TARGETS = {
  drift: numericArg('drift', BASE_TARGETS.drift),
  no_drift: numericArg('no-drift', BASE_TARGETS.no_drift),
  UNKNOWN: numericArg('unknown', BASE_TARGETS.UNKNOWN),
  golden: numericArg('golden', BASE_TARGETS.golden),
};

export async function generateDataset(options = {}) {
  const cfg = { backend, seed, smoke, groupShare, ...options };
  mkdirSync(DATA, { recursive: true });
  mkdirSync(join(DATA, 'cache'), { recursive: true });
  const goldens = [];
  for (let index = 0; index < TARGETS.golden; index += 1) {
    if (index % 50 === 0 || cfg.backend === 'llm') process.stderr.write(`golden ${index + 1}/${TARGETS.golden}\n`);
    goldens.push(await makeGolden(index, cfg));
  }
  const samples = [];
  samples.push(...makeNoDrift(goldens, cfg));
  samples.push(...await makeDrift(goldens, cfg, TARGETS.drift));
  samples.push(...await makeUnknown(goldens, cfg, TARGETS.UNKNOWN));
  const labeled = samples.map((sample) => ({
    ...sample,
    split: splitForGraph(sample.graph_id, SCHEMA.splitRatio),
    G_star: stripForbiddenKeys(sample.G_star),
    G_prime: stripForbiddenKeys(sample.G_prime),
  }));
  const valid = [];
  const rejected = [];
  for (const sample of labeled) {
    const errors = validateSample(sample, { requireSplit: true });
    if (errors.length) rejected.push({ id: sample.id, errors });
    else valid.push(sample);
  }
  const trimmed = trimToTargets(valid);
  writeSplits(trimmed);
  const manifest = {
    version: SCHEMA.version,
    generatedAt: new Date().toISOString(),
    backend: cfg.backend,
    model: cfg.backend === 'llm' ? llmModel() : 'local-tutorial-writer',
    seed: cfg.seed,
    smoke: Boolean(cfg.smoke),
    groupShare: cfg.groupShare,
    counts: countBy(trimmed, (row) => row.label.status),
    splits: countBy(trimmed, (row) => row.split),
    // 两个图族各自的样本数：agent_step 只在四层族里出现，用它是判断族的最短路径。
    families: countBy(trimmed, (row) => (row.G_star.nodes.some((node) => node.kind === 'agent_step') ? 'layered_group' : 'flat_work_units')),
    stepForms: countBy(
      trimmed.filter((row) => row.label.status === 'drift' && row.label.injected_form?.includes('step_')),
      (row) => row.label.injected_type,
    ),
    graphs: new Set(trimmed.map((row) => row.graph_id)).size,
    rejected: rejected.length,
    sha256: {
      train: fileHash(join(DATA, 'train.jsonl')),
      development: fileHash(join(DATA, 'development.jsonl')),
      test: fileHash(join(DATA, 'test.jsonl')),
    },
  };
  writeFileSync(join(DATA, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(DATA, 'rejected.json'), `${JSON.stringify(rejected.slice(0, 200), null, 2)}\n`);
  return { manifest, rejected, n: trimmed.length };
}

async function makeGolden(index, cfg) {
  if (cfg.backend === 'llm') {
    const cachePath = join(DATA, 'cache', `golden_v3_${index}.json`);
    if (existsSync(cachePath)) return normalizeRichGraph(JSON.parse(readFileSync(cachePath, 'utf8')));
    const system = loadPrompt('golden_system.txt');
    const graph = generateGoldenGraph(index, cfg.seed, { groupShare: cfg.groupShare });
    const user = `请把下面这个任务写成 16-28 步的长程可执行步骤图，可改写标题和摘要，必须是 DAG，早期节点到终点至少 8 跳。\n${JSON.stringify({
      graph_id: `rdmd_llm_${index}`,
      domain: graph.domain,
      title: graph.title || `任务${index}`,
      topic: graph.topic,
      hint_nodes: graph.nodes.map((node) => node.title),
    })}`;
    const result = await llmJson({ system, user, stage: 'golden' });
    const normalized = normalizeRichGraph({
      ...result.value,
      graph_id: result.value.graph_id || `rdmd_llm_${index}`,
      domain: result.value.domain || graph.domain,
      topic: result.value.topic || graph.topic,
    });
    normalized.graph_id = `rdmd_llm_${index}`;
    const obfuscated = obfuscateGraph(normalized, cfg.seed * 7919 + index * 31 + 5);
    obfuscated.graph_id = `rdmd_llm_${index}`;
    writeFileSync(cachePath, `${JSON.stringify(normalized)}\n`);
    return obfuscated;
  }
  const graph = generateGoldenGraph(index, cfg.seed, { groupShare: cfg.groupShare });
  graph.graph_id = `rdmd_local_${index}`;
  return graph;
}

function makeNoDrift(goldens, cfg) {
  return goldens.slice(0, TARGETS.no_drift).map((graph, index) => sampleOf({
    graph_id: graph.graph_id,
    G_star: graph,
    G_prime: cloneRichGraph(graph),
    label: { status: 'no_drift', injected_node: '', injected_type: '', injected_edge: '' },
    generator_id: 'rdmd_no_drift_v2',
    backend: cfg.backend,
    seed: cfg.seed + index,
    visibility: 'none',
  }));
}

async function makeDrift(goldens, cfg, target) {
  const rows = [];
  let cursor = 0;
  const source = goldens.slice(0, Math.min(800, goldens.length));
  while (rows.length < target) {
    const graph = source[cursor % source.length];
    const injectIndex = Math.floor(cursor / source.length);
    const picked = pickInjection(graph, cfg.seed + cursor * 13, DRIFT_TYPES[injectIndex % DRIFT_TYPES.length]);
    cursor += 1;
    if (!picked) continue;
    const applied = applyLocalEdit(graph, picked.type, picked.nodeId, cfg.seed + cursor * 17);
    if (!applied.gold) continue;
    const subtle = (cursor % 2) === 0 && picked.type !== 'missing_dependency';
    const propagated = await makePrime(graph, applied.graph, applied.gold, cfg, cfg.seed + cursor, subtle);
    const decoyed = addDecoyNodes(graph, propagated, applied.gold.nodeId, { seed: cfg.seed + cursor * 29 });
    const prime = decoyed.graph;
    const sample = sampleOf({
      graph_id: graph.graph_id,
      G_star: graph,
      G_prime: prime,
      label: {
        status: 'drift',
        injected_node: applied.gold.nodeId,
        injected_type: applied.gold.type,
        injected_edge: applied.gold.edgeId || '',
        injected_form: applied.gold.formId || '',
        hop_to_first_effect: 0,
        decoy_nodes: decoyed.decoys,
        // local_replan 在 step 链上插的那一环。它不是真凶也不是诱饵，是**注入本身**，
        // 所以必须显式声明给 gates —— 否则 extra_node_unexplained 会把它当无来由的新节点判死。
        inserted_nodes: insertedNodesOf(applied.gold),
      },
      generator_id: 'rdmd_single_inject_v3',
      backend: cfg.backend,
      seed: cfg.seed + cursor,
      visibility: subtle ? 'subtle' : 'visible',
    });
    if (validateSample(sample).length) continue;
    rows.push(sample);
    if (rows.length % 200 === 0) process.stderr.write(`drift ${rows.length}/${target}\n`);
    if (cursor > target * 40) break;
  }
  return rows.slice(0, target);
}

async function makeUnknown(goldens, cfg, target) {
  const rows = [];
  const rng = makeRng(cfg.seed + 99);
  const pool = [...goldens];
  let extra = 2000;
  while (rows.length < target && extra < 8000) {
    if (!pool.length) {
      const graph = generateGoldenGraph(extra, cfg.seed, { groupShare: cfg.groupShare });
      graph.graph_id = `rdmd_fork_${extra}`;
      pool.push(graph);
      extra += 1;
    }
    const graph = pool.shift();
    const pair = pickForkPair(graph, rng.int(1e9));
    if (!pair) continue;
    const typeA = rng.pick(DRIFT_TYPES);
    const rest = DRIFT_TYPES.filter((type) => type !== typeA);
    const typeB = rng.pick(rest.length ? rest : DRIFT_TYPES);
    const first = applyLocalEdit(graph, typeA, pair.a, cfg.seed + rows.length);
    if (!first.gold) continue;
    const mid = await makePrime(graph, first.graph, first.gold, cfg, cfg.seed + rows.length, false);
    const second = applyLocalEdit(mid, typeB, pair.b, cfg.seed + rows.length + 3);
    if (!second.gold) continue;
    const prime = await makePrime(graph, second.graph, second.gold, cfg, cfg.seed + rows.length + 7, false);
    const decoyed = addDecoyNodes(graph, prime, [pair.a, pair.b], { seed: cfg.seed + rows.length * 31 });
    const sample = sampleOf({
      graph_id: graph.graph_id,
      G_star: graph,
      G_prime: decoyed.graph,
      label: {
        status: 'UNKNOWN',
        injected_node: '',
        injected_type: '',
        injected_edge: '',
        injected_form: '',
        injected_nodes: [pair.a, pair.b],
        injected_types: [typeA, typeB],
        injected_forms: [first.gold.formId, second.gold.formId],
        decoy_nodes: decoyed.decoys,
        // 两条注入都可能各自在链上派生出一步，两份要合起来声明。
        inserted_nodes: [...insertedNodesOf(first.gold), ...insertedNodesOf(second.gold)],
      },
      generator_id: 'rdmd_multi_inject_v3',
      backend: cfg.backend,
      seed: cfg.seed + rows.length,
      visibility: 'visible',
    });
    if (validateSample(sample).length) continue;
    rows.push(sample);
  }
  return rows.slice(0, target);
}

async function makePrime(star, edited, gold, cfg, seed, subtle) {
  if (cfg.backend === 'llm') {
    try {
      const result = await llmJson({
        system: loadPrompt('propagate_system.txt'),
        user: JSON.stringify({
          G_star: star,
          local_edit: { nodeId: gold.nodeId, type: gold.type, edgeId: gold.edgeId },
          edited_graph: edited,
          instruction: subtle
            ? '原因节点的 title/agentId/version/acceptance 尽量保持原样，主要改 summary/output/artifact。距离 1-2 跳的后代不要改；从第 3 跳起用该任务自己的材料写后果。'
            : '可以改结构字段。距离 1-2 跳的后代不要改；从第 3 跳起写后果，也可在远处增加最多两个 repair_ 节点。只改注入点及其后代。后果必须任务特定，禁止统一后缀。',
        }),
        stage: 'propagate',
      });
      return normalizeRichGraph(result.value);
    } catch {
      return inferDownstream(star, edited, gold, { seed, subtle });
    }
  }
  return inferDownstream(star, edited, gold, { seed, subtle });
}

function sampleOf(partial) {
  return {
    id: `${partial.graph_id}__${partial.label.status}__${partial.label.injected_type || 'none'}__${partial.label.injected_node || 'none'}__${partial.seed}`,
    split: '',
    changed_node_ids: [],
    model: partial.backend === 'llm' ? llmModel() : 'local-tutorial-writer',
    ...partial,
  };
}

function trimToTargets(samples) {
  const buckets = { drift: [], no_drift: [], UNKNOWN: [] };
  for (const sample of samples) buckets[sample.label.status]?.push(sample);
  return [
    ...buckets.drift.slice(0, TARGETS.drift),
    ...buckets.no_drift.slice(0, TARGETS.no_drift),
    ...buckets.UNKNOWN.slice(0, TARGETS.UNKNOWN),
  ];
}

function writeSplits(samples) {
  const splits = { train: [], development: [], test: [] };
  for (const sample of samples) splits[sample.split].push(sample);
  for (const [name, rows] of Object.entries(splits)) {
    writeFileSync(join(DATA, `${name}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  }
  writeFileSync(join(DATA, 'all.jsonl'), samples.map((row) => JSON.stringify(row)).join('\n') + (samples.length ? '\n' : ''));
}

function countBy(rows, fn) {
  const out = {};
  for (const row of rows) out[fn(row)] = (out[fn(row)] || 0) + 1;
  return out;
}

function fileHash(path) {
  if (!existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  generateDataset().then((result) => {
    console.log(JSON.stringify({ ok: true, ...result.manifest, n: result.n, rejected: result.rejected.length }, null, 2));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
