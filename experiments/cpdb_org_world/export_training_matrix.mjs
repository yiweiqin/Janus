// 把 CPDB 组织世界导成**训练矩阵**：一份纯数值的 X/y，交给盒子上的 torch 去学。
//
// 为什么要先落成一份矩阵，而不是让 Python 直接读 jsonl：
//
//   1. 特征只有一份实现（`lib/features.mjs`），线上推理也走同一个函数。
//      如果 Python 那边再写一遍特征，两边迟早会漂移，而且漂移是静默的 ——
//      指标好看、线上分数对不上，最难查的一类 bug。
//   2. 矩阵是不可变产物：带 sha256 落盘，于是「这个权重是用哪份数据、哪个标签文件、
//      哪版特征码训出来的」是一个可以查证的问题，而不是一句回忆。
//   3. 盒子只需要 numpy + torch，不必带一个 Node 运行时去读 8k 行 jsonl。
//
// 用法：
//   node experiments/cpdb_org_world/export_training_matrix.mjs \
//     [--data experiments/cpdb_org_world/data/full] \
//     [--labels <path>]  [--out <dir>] [--label-id <annotatorId 前缀过滤>]
//
// 产物（默认落 `experiments/cpdb_org_world/train_out/`，已在 .gitignore 里）：
//   X.f32               n × d 的 float32（小端），行序与 `rows.jsonl` 一致
//   y_dependency.i8     n 个 0..4 的档位下标（不是 0..1 的分数）
//   y_similarity.i8     同上
//   rows.jsonl          {index,id,split,kind} —— 评估切片用，**不含标签**
//   labels.jsonl        {id,dependency,similarity} —— 便于事后核对标签来源
//   matrix.json         规格、词表、特征名、行数、以及全部输入输出的 sha256
//
// 注意 `rows.jsonl` 里**故意不放分数**：它是给评估脚本切分用的索引，
// 分数在 y_*.i8 与 labels.jsonl 里，混在一起很容易让某个下游脚本不小心把答案拼进特征。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CPDB_FEATURE_SPEC_VERSION,
  buildVocab,
  featureDimension,
  featureNames,
  normalizeAgentView,
  pairFeatures,
} from './lib/features.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCALE = [0, 0.25, 0.5, 0.75, 1];

export { SCALE };

export function exportTrainingMatrix({
  dataDir = join(ROOT, 'data', 'full'),
  labelsPath = null,
  outDir = join(ROOT, 'train_out'),
  labelPrefix = '',
} = {}) {
  const agentsPath = join(dataDir, 'agents.jsonl');
  const profilesPath = join(dataDir, 'agent_profiles.jsonl');
  const pairsPath = join(dataDir, 'pairs.jsonl');
  const labelsFile = labelsPath || join(dataDir, 'human_labels.jsonl');

  for (const path of [agentsPath, profilesPath, pairsPath, labelsFile]) {
    if (!existsSync(path)) throw new Error(`cpdb_export_input_missing:${path}`);
  }

  const agents = readJsonl(agentsPath);
  const profiles = readJsonl(profilesPath);
  const pairs = readJsonl(pairsPath);
  const labels = readJsonl(labelsFile);

  // 视图来源：Agent 记录为主，published profile 只用来补 Agent 记录里没有的字段
  // （实际上二者重合，这里合并是为了「用 profile 当输入」也能训）。
  const profileById = new Map(profiles.map((item) => [item.uBuddyAgentInstanceId, item]));
  const viewById = new Map();
  for (const agent of agents) {
    const profile = profileById.get(agent.id);
    viewById.set(agent.id, normalizeAgentView({ ...(profile || {}), ...agent, extra: { ...(profile?.extra || {}), ...agent } }));
  }
  if (viewById.size !== agents.length) throw new Error(`cpdb_view_duplicate_or_missing:${viewById.size}/${agents.length}`);

  const vocab = buildVocab([...viewById.values()]);
  const dimension = featureDimension(vocab);
  const names = featureNames(vocab);

  const labelById = new Map();
  for (const row of labels) {
    const annotator = String(row.annotatorId || row.reviewerId || '');
    if (labelPrefix && !annotator.startsWith(labelPrefix)) continue;
    // 同一个 pair 有多份判分时**先到先得**：这份矩阵是一次训练快照，
    // 合并/裁定属于 `lib/consensus.mjs` 的活，不该悄悄发生在这里。
    if (labelById.has(row.id)) continue;
    const dependency = stepIndex(row.dependency);
    const similarity = stepIndex(row.similarity);
    if (dependency < 0 || similarity < 0) continue;
    labelById.set(row.id, { dependency, similarity, annotatorId: annotator, status: String(row.status || '') });
  }

  const missing = pairs.filter((pair) => !labelById.has(pair.id));
  if (missing.length) {
    // 少了标签就是少了监督信号。悄悄跳过会让「覆盖 6705/8282」这种数变得不可见，
    // 所以这里直接失败，并把前几个缺的 id 打出来。
    throw new Error(`cpdb_export_label_missing:${missing.length}:${missing.slice(0, 3).map((pair) => pair.id).join(',')}`);
  }
  if (pairs.some((pair) => pair.combined != null || pair.combinedScore != null)) {
    throw new Error('cpdb_export_combined_score_present');
  }

  const x = new Float32Array(pairs.length * dimension);
  const yDependency = new Int8Array(pairs.length);
  const ySimilarity = new Int8Array(pairs.length);
  const rows = [];
  const labelRows = [];
  const baselineRows = [];

  pairs.forEach((pair, index) => {
    const left = viewById.get(pair.leftAgentId);
    const right = viewById.get(pair.rightAgentId);
    if (!left || !right) throw new Error(`cpdb_pair_agent_missing:${pair.id}`);
    const feature = pairFeatures(left, right, vocab);
    if (feature.length !== dimension) throw new Error(`cpdb_feature_dimension:${pair.id}`); // c8 ignore
    for (let at = 0; at < dimension; at += 1) {
      const value = feature[at];
      if (!Number.isFinite(value)) throw new Error(`cpdb_feature_not_finite:${pair.id}:${names[at]}`);
      x[index * dimension + at] = value;
    }
    const label = labelById.get(pair.id);
    yDependency[index] = label.dependency;
    ySimilarity[index] = label.similarity;
    // 这一行只留下「评估时要切分用的东西」。分数一律不进这里 —— 见文件头注释。
    rows.push({ index, id: pair.id, split: pair.split, kind: pair.kind, isTwin: Boolean(pair.isTwin) });
    labelRows.push({ id: pair.id, dependency: SCALE[label.dependency], similarity: SCALE[label.similarity] });
    // 契约基线的输出**只放在这里**，绝不进 X：它是我们要对比的另一个模型，
    // 进了特征就等于把对比对象变成了输入。
    baselineRows.push({
      id: pair.id,
      contractDependency: Number(pair.contractDependency ?? 0),
      contractSimilarity: Number(pair.contractSimilarity ?? 0),
    });
  });

  // 维度太大（facet 词表 × 2）时浮点误差会累积，这里做一次全量复检再落盘。
  for (let at = 0; at < x.length; at += 1) {
    if (!Number.isFinite(x[at])) throw new Error(`cpdb_matrix_not_finite:${at}`); // c8 ignore
  }

  mkdirSync(outDir, { recursive: true });
  const files = {
    x: join(outDir, 'X.f32'),
    yDependency: join(outDir, 'y_dependency.i8'),
    ySimilarity: join(outDir, 'y_similarity.i8'),
    rows: join(outDir, 'rows.jsonl'),
    labels: join(outDir, 'labels.jsonl'),
    baselines: join(outDir, 'baselines.jsonl'),
    matrix: join(outDir, 'matrix.json'),
  };
  writeFileSync(files.x, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  writeFileSync(files.yDependency, Buffer.from(yDependency.buffer, yDependency.byteOffset, yDependency.byteLength));
  writeFileSync(files.ySimilarity, Buffer.from(ySimilarity.buffer, ySimilarity.byteOffset, ySimilarity.byteLength));
  writeFileSync(files.rows, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(files.labels, `${labelRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(files.baselines, `${baselineRows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const annotators = unique(labelById.values().map((item) => `${item.annotatorId}/${item.status}`)).sort();
  const matrix = {
    schema: 'cpdb_training_matrix/v1',
    featureSpec: CPDB_FEATURE_SPEC_VERSION,
    rows: pairs.length,
    dimension,
    featureNames: names,
    vocab,
    scale: SCALE,
    labelSource: { file: rel(labelsFile), annotators },
    splits: tally(rows.map((row) => row.split)),
    kinds: tally(rows.map((row) => row.kind)),
    labelHistogram: { dependency: tally(yDependency), similarity: tally(ySimilarity) },
    inputs: sha256Of([agentsPath, profilesPath, pairsPath, labelsFile]),
    outputs: sha256Of([files.x, files.yDependency, files.ySimilarity, files.rows, files.labels, files.baselines]),
  };
  writeFileSync(files.matrix, `${JSON.stringify(matrix, null, 2)}\n`);
  return { outDir, matrix };
}

/**
 * 0.75 → 3；不在标尺上的一律拒绝（返回 -1）。
 *
 * 这里**只收真正的 number**，不做 `Number(value)` 转换。原因是一条实测出来的教训：
 * `Number(null)` 是 0、`Number('')` 是 0、`Number('0.5')` 是 0.5 —— 于是
 * 「这个 pair 没有标签」会被悄悄读成「这个 pair 的标签是 0.0」。
 * 而 0.0 在标尺上完全合法，它不会触发任何下游检查，只会让模型学会一个编出来的答案。
 * 所以类型本身就是判据：缺标签就是缺标签，不要替它猜一个值。
 */
export function stepIndex(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return -1;
  return SCALE.indexOf(value);
}

function tally(list) {
  const out = {};
  for (const item of list) out[item] = (out[item] || 0) + 1;
  return out;
}

function sha256Of(paths) {
  return Object.fromEntries(paths.map((path) => [rel(path), sha256(readFileSync(path))]));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function rel(path) {
  // Windows 上 `--labels` 传进来的可能是正斜杠，而 ROOT 是反斜杠；
  // 不归一化的话前缀比对会失败，于是 provenance 里会混进本机绝对路径 ——
  // 一份要进版本库的清单不该带着某台机器的盘符。
  const normalized = String(path).replace(/\\/g, '/');
  const root = ROOT.replace(/\\/g, '/');
  return normalized.startsWith(root) ? normalized.slice(root.length + 1) : normalized;
}

function unique(values) {
  return [...new Set(values)];
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const args = { dataDir: join(ROOT, 'data', 'full'), labelsPath: null, outDir: join(ROOT, 'train_out'), labelPrefix: '' };
  for (let at = 0; at < argv.length; at += 1) {
    const key = argv[at];
    if (key === '--data') args.dataDir = resolve(argv[++at]);
    else if (key === '--labels') args.labelsPath = resolve(argv[++at]);
    else if (key === '--out') args.outDir = resolve(argv[++at]);
    else if (key === '--label-id') args.labelPrefix = argv[++at];
  }
  return args;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const { outDir, matrix } = exportTrainingMatrix(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    outDir: rel(outDir),
    rows: matrix.rows,
    dimension: matrix.dimension,
    labelSource: matrix.labelSource,
    splits: matrix.splits,
    kinds: matrix.kinds,
    labelHistogram: matrix.labelHistogram,
  }, null, 2));
}
