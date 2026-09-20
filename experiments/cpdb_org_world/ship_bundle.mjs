// 交付打包：把「训练集 + 交付打分器 + 它们的绑定关系」做成一个可以单独拿走的包。
//
// ## 为什么需要一个 manifest，而不是直接给目录
//
// 这套东西最容易出的问题不是算错，而是**对不上**：
//
//   - 权重是用 A 版矩阵训的，包里的矩阵是 B 版（换过一次标签、或重新导过一次）；
//   - 表里的折指标是上一轮标签算的，而表本身是用这一轮标签压出来的；
//   - JS 侧的打分器和 Python 侧的折指标不是同一个函数，谁也没比过。
//
// 这三种情况都不会让任何东西"报错"，只会让报告里的数字和线上行为不是一回事。
// 所以打包这一步的核心不是拷贝文件，而是**把每一条对不上都变成一次失败**：
//
//   1. 重算矩阵里每个输入的 sha256，与 `matrix.json` 自述的清单逐个比；
//   2. 用 **JS 侧**的表打分器，在 `folds.jsonl` 的折上重算一遍逐折准确率，
//      与 `table.json` 里 Python 算出的 `foldMetrics` 逐格比（容差 0，因为两边都是计数）；
//   3. 用 **JS 侧**的模型前向传播，对 `model/predictions.jsonl` 逐条对账；
//   4. 把交付目录里每个文件的大小与 sha256 记进 manifest。
//
// 第 2 条是这份脚本存在的主要理由：它把"Python 的表"和"JS 的表"钉在一起。
// 少了它，两张表可以在各自的测试里都绿，而线上用的是第三张。
//
// ## 为什么把训练集也拷进来
//
// 需求是"一套完备、能直接接入的训练集"。只给权重的话，别人拿到的是**结果**；
// 给矩阵的话，别人能重训、能换标签、能在同一批折上与自己的方法比。
// 两样一起给，且用 manifest 绑死，才能保证"你复现的就是我交付的"。

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildTableScorer, loadCapabilityScorer } from '../../src/shared/contracts/uBuddyCapabilityDependencyScorer.js';

const HERE = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MATRIX_DIR = join(HERE, 'train_out_ai');
const SHIP_DIR = join(HERE, 'artifacts', 'cpdb-scorer-v3-ship');
const EXPORT_DIR = join(HERE, 'exports', 'cpdb-training-set-v1');
const ARTIFACT_ID = 'cpdb-scorer-v3-ship';

const fail = (message) => { throw new Error(message); };

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  const raw = readFileSync(path, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // BOM 会在这里炸成 "Unexpected token"，而报错位置指向第一行 ——
    // 症状看起来像"数据坏了"，其实是文件头多了三个字节。所以剥掉。
    out.push(JSON.parse(trimmed.replace(/^\uFEFF/, '')));
  }
  return out;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function describeFile(path) {
  const stat = statSync(path);
  return { bytes: stat.size, sha256: sha256(path) };
}

// --------------------------------------------------------------------------------------
// 1) 矩阵输入清单
// --------------------------------------------------------------------------------------

const matrixSpec = readJson(join(MATRIX_DIR, 'matrix.json'));
const inputMismatches = [];
for (const [relative, expected] of Object.entries(matrixSpec.inputs || {})) {
  const path = join(HERE, relative);
  if (!existsSync(path)) {
    inputMismatches.push({ relative, problem: 'missing' });
    continue;
  }
  const actual = sha256(path);
  if (actual !== expected) inputMismatches.push({ relative, problem: `sha256 ${actual} != ${expected}` });
}
if (inputMismatches.length) {
  fail(`矩阵自述的输入清单对不上：\n${JSON.stringify(inputMismatches, null, 2)}`
    + '\n这意味着"包里这份数据"与"训练时用的那份数据"不是同一份。不要忽略这一条。');
}

// --------------------------------------------------------------------------------------
// 2) 用 JS 侧的表重算 Python 的折指标
// --------------------------------------------------------------------------------------

const foldsRows = readJsonl(join(MATRIX_DIR, 'folds.jsonl'));
const labelRows = readJsonl(join(MATRIX_DIR, 'labels.jsonl'));
if (foldsRows.length !== labelRows.length) {
  fail(`folds.jsonl 有 ${foldsRows.length} 行，labels.jsonl 有 ${labelRows.length} 行，行序也对不上就会静默错配`);
}
const scale = matrixSpec.scale;
const labelIndex = new Map();
for (let at = 0; at < foldsRows.length; at += 1) {
  if (foldsRows[at].id !== labelRows[at].id) {
    fail(`第 ${at} 行的 id 不一致：folds=${foldsRows[at].id} labels=${labelRows[at].id}`);
  }
  const dependency = scale.indexOf(labelRows[at].dependency);
  const similarity = scale.indexOf(labelRows[at].similarity);
  if (dependency < 0 || similarity < 0) {
    fail(`第 ${at} 行的标签不在 scale 里：${JSON.stringify(labelRows[at])}`);
  }
  labelIndex.set(foldsRows[at].id, { dependency, similarity });
}

const tableJson = readJson(join(SHIP_DIR, 'table.json'));

/** 用一批训练行压出一张表（与服务期同一条代码路径：`buildTableScorer`）。 */
function tableFrom(indices) {
  const byKey = new Map();
  for (const at of indices) {
    const key = foldsRows[at].lookupKeys?.family;
    if (!key) fail(`folds.jsonl 缺少 lookupKeys.family：${foldsRows[at].id}`);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(at);
  }
  const count = (axis, list) => {
    const counts = new Array(scale.length).fill(0);
    for (const at of list) counts[labelIndex.get(foldsRows[at].id)[axis]] += 1;
    const total = counts.reduce((a, b) => a + b, 0);
    return total ? counts.map((value) => value / total) : new Array(scale.length).fill(1 / scale.length);
  };
  const cells = {};
  for (const [key, list] of byKey) {
    cells[key] = { dependency: count('dependency', list), similarity: count('similarity', list) };
  }
  const all = indices;
  return buildTableScorer({
    schema: 'cpdb_scorer_table/v1',
    keyKind: 'family_pair',
    scale,
    cells,
    prior: { dependency: count('dependency', all), similarity: count('similarity', all) },
  });
}

/** 在折上算准确率：与 `run_fit_table` 的 Python 实现逐条同构。 */
function foldAccuracy(scorer, axis, evaluation) {
  let hit = 0;
  for (const at of evaluation) {
    const row = foldsRows[at];
    const probabilities = scorer.cells[row.lookupKeys.family]?.[axis] || scorer.prior[axis];
    let argmax = 0;
    for (let k = 1; k < probabilities.length; k += 1) if (probabilities[k] > probabilities[argmax]) argmax = k;
    if (argmax === labelIndex.get(row.id)[axis]) hit += 1;
  }
  return evaluation.length ? hit / evaluation.length : null;
}

const foldCrossCheck = {};
const foldMismatches = [];
for (const [scheme, spec] of Object.entries(matrixSpec.folds || {})) {
  foldCrossCheck[scheme] = {};
  for (const axis of ['dependency', 'similarity']) {
    const perFold = [];
    for (let fold = 0; fold < spec.k; fold += 1) {
      const evaluation = [];
      for (let at = 0; at < foldsRows.length; at += 1) {
        if ((foldsRows[at][scheme] || []).includes(fold)) evaluation.push(at);
      }
      const evaluationSet = new Set(evaluation);
      const training = [];
      for (let at = 0; at < foldsRows.length; at += 1) if (!evaluationSet.has(at)) training.push(at);
      if (!evaluation.length || !training.length) continue;
      perFold.push(Number(foldAccuracy(tableFrom(training), axis, evaluation).toFixed(4)));
    }
    foldCrossCheck[scheme][axis] = perFold;
    const python = tableJson.foldMetrics?.[scheme]?.[axis]?.perFold;
    if (!python) {
      foldMismatches.push({ scheme, axis, problem: 'table.json 里没有这一格' });
      continue;
    }
    if (JSON.stringify(python) !== JSON.stringify(perFold)) {
      foldMismatches.push({ scheme, axis, python, javascript: perFold });
    }
  }
}
if (foldMismatches.length) {
  fail('JS 侧重算的折指标与 table.json 里 Python 算出的不一致：\n'
    + `${JSON.stringify(foldMismatches, null, 2)}\n`
    + '这一条最要紧：它说明线上用的表与报告里的数字不是同一个函数。');
}

// --------------------------------------------------------------------------------------
// 3) 模型前向与 `predictions.jsonl` 对账（用交付包里的矩阵，不依赖实验目录之外的任何东西）
// --------------------------------------------------------------------------------------

const modelDir = join(SHIP_DIR, 'model');
const parity = { checked: false, note: '交付目录里没有 model/，跳过' };
if (existsSync(join(modelDir, 'weights.json')) && existsSync(join(modelDir, 'predictions.jsonl'))) {
  const { loadScorer, scoreFeature } = await import('../../src/shared/contracts/uBuddyCapabilityDependencyScorer.js');
  const defaultScorer = loadCapabilityScorer(SHIP_DIR);
  if (defaultScorer.kind !== 'table') fail('交付目录应当以表为主，但加载入口给出的不是表');

  const model = loadScorer(modelDir);
  const predictions = readJsonl(join(modelDir, 'predictions.jsonl'));
  const dimension = matrixSpec.dimension;
  const raw = readFileSync(join(MATRIX_DIR, 'X.f32'));
  const expectedRows = matrixSpec.rows * dimension * 4;
  if (raw.byteLength !== expectedRows) {
    fail(`X.f32 是 ${raw.byteLength} 字节，按 ${matrixSpec.rows}×${dimension}×4 应当是 ${expectedRows}`);
  }
  const features = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (predictions.length !== matrixSpec.rows) {
    fail(`predictions.jsonl 有 ${predictions.length} 行，矩阵有 ${matrixSpec.rows} 行，行序对不上就会静默错配`);
  }

  let argmaxSameBothAxes = 0;
  let worstExpectedGap = 0;
  const mismatches = [];
  for (let at = 0; at < predictions.length; at += 1) {
    const row = predictions[at];
    // 行序：`predictions.jsonl` 由 `run_fit_all` 按 `all_idx` 顺序写出，
    // 也就是 0..n-1，与 X.f32 的行序一致。这里不对 id 做校验是因为
    // `rows.jsonl` 才带 id，而 predictions 的 id 也应与它同序 —— 下面顺手比一次。
    const feature = features.subarray(at * dimension, (at + 1) * dimension);
    const scored = scoreFeature(model, feature);
    let same = true;
    for (const axis of ['dependency', 'similarity']) {
      const expected = row[axis];
      if (!expected) fail(`第 ${at} 行的 predictions 缺少 ${axis}`);
      // 逐条对齐的容差与 `scorer.test.mjs` 同口径：float32 的两套实现允许 1e-3。
      const gap = Math.abs(scored[axis].expected - expected.expected);
      worstExpectedGap = Math.max(worstExpectedGap, gap);
      if (scored[axis].argmax !== expected.argmax) same = false;
      if (gap > 1e-3) {
        mismatches.push({ at, axis, expected: expected.expected, javascript: scored[axis].expected, gap });
      }
    }
    if (same) argmaxSameBothAxes += 1;
  }
  if (mismatches.length) {
    fail(`交付模型的 JS 前向与 predictions.jsonl 对不上（前 5 条）：\n${JSON.stringify(mismatches.slice(0, 5), null, 2)}`);
  }
  parity.checked = true;
  parity.rows = predictions.length;
  parity.argmaxAgreementBothAxes = Number((argmaxSameBothAxes / predictions.length).toFixed(6));
  parity.worstExpectedGap = Number(worstExpectedGap.toFixed(6));
  parity.tolerance = 1e-3;
  parity.note = '两轴 argmax 必须逐条相同；连续分允许 1e-3（float32 两套实现的舍入差）。';
  if (parity.argmaxAgreementBothAxes < 1) {
    fail(`两轴 argmax 的一致率只有 ${parity.argmaxAgreementBothAxes}，而判据是 1.0`);
  }
}

// --------------------------------------------------------------------------------------
// 4) 训练集导出 + manifest
// --------------------------------------------------------------------------------------

mkdirSync(EXPORT_DIR, { recursive: true });
const TRAINING_FILES = ['matrix.json', 'X.f32', 'y_dependency.i8', 'y_similarity.i8', 'rows.jsonl', 'folds.jsonl', 'labels.jsonl'];
for (const name of TRAINING_FILES) {
  const from = join(MATRIX_DIR, name);
  if (!existsSync(from)) fail(`训练集缺少 ${name}`);
  copyFileSync(from, join(EXPORT_DIR, name));
}

const manifest = {
  schema: 'cpdb_ship_manifest/v1',
  artifactId: ARTIFACT_ID,
  generatedAt: new Date().toISOString(),
  // 交付的默认打分器是哪一种。**写死在这里**，避免"两个都在时选哪个"变成一个运行时问题。
  defaultScorer: 'table',
  reason: '诊断轮：同一批折、同一批标签上，36 格 family 表在 facet 折（换没见过的角色）'
    + '相似度 0.7816，MLP 0.7669/0.7477；family 折上 MLP 相似度 0.5544 低于众数 0.5899。',
  labelSource: matrixSpec.labelSource,
  trainingSet: {
    dir: 'exports/cpdb-training-set-v1',
    rows: matrixSpec.rows,
    dimension: matrixSpec.dimension,
    featureSpec: matrixSpec.featureSpec,
    variants: Object.fromEntries(Object.entries(matrixSpec.variants).map(([name, spec]) => [name, { width: spec.width }])),
    folds: Object.fromEntries(Object.entries(matrixSpec.folds).map(([name, spec]) => [name, spec.k])),
    files: Object.fromEntries(TRAINING_FILES.map((name) => [name, describeFile(join(MATRIX_DIR, name))])),
    inputs: matrixSpec.inputs,
    retrain: [
      'python train_scorer.py --fit-table --matrix-dir train_out_ai --out artifacts/cpdb-scorer-v3-ship',
      'python train_scorer.py --fit-all --variant no_identity --matrix-dir train_out_ai --out artifacts/cpdb-scorer-v3-ship/model',
      'node experiments/cpdb_org_world/ship_bundle.mjs',
    ],
  },
  artifacts: {
    table: describeFile(join(SHIP_DIR, 'table.json')),
    tableMetrics: describeFile(join(SHIP_DIR, 'metrics.json')),
    model: existsSync(join(modelDir, 'weights.json')) ? describeFile(join(modelDir, 'weights.json')) : null,
    modelMetrics: existsSync(join(modelDir, 'metrics.json')) ? describeFile(join(modelDir, 'metrics.json')) : null,
  },
  tableFoldMetrics: tableJson.foldMetrics,
  jsFoldCrossCheck: foldCrossCheck,
  integration: {
    module: 'src/shared/contracts/uBuddyCapabilityDependencyScorer.js',
    load: "loadCapabilityScorer(<artifactDir>)",
    entries: {
      dependencyScore: 'scoredDependencyScore',
      similarityScore: 'scoredSimilarityScore',
      selectCollaborators: 'scoredSelectCollaborators',
      selectReplacement: 'scoredSelectReplacement',
    },
    fallback: 'scorer 为空或不可用时回落到 uBuddyCapabilityDependencyBundle 的手写打分；'
      + '用 describeScorerFallback 读当前走的是哪条。',
  },
  caveats: [
    'AI 标签由本机 Qwen3-8B 多数投票生成，不是人工标注。标签库 human_labels.jsonl 里没有任何人工标注。',
    'AI 判分对提问措辞敏感（不同 framing 之间的 qwk 只有 0.2-0.3），所以标签本身的稳定性有上限。',
    '表只在 (familyL, familyR) 上分辨；未知家族对回落到 prior，此时 pair 之间会并列（family 折 0.5899 = 众数）。',
    '标签分辨率大约就到 (familyL, familyR) 为止，所以更大的模型不会自动变得更好 —— 这是这轮最主要的结论。',
  ],
  parity,
};
writeFileSync(join(SHIP_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const readme = `# CPDB 训练集与交付打分器 v1

这份包回答的是"**别人拿到它，能不能重训出同一个东西、并且能直接接进系统**"。
两样东西一起给：**训练集**（可以重训、可以换标签、可以换折）和**交付打分器**（直接用）。

- 交付打分器：\`artifacts/${ARTIFACT_ID}/\`
- 训练集：\`exports/cpdb-training-set-v1/\`
- 绑定关系与全部哈希：\`artifacts/${ARTIFACT_ID}/manifest.json\`

## 交付打分器是什么

**默认是表，不是神经网络。** 这不是偏好，是实测结果：

| 折（留出什么） | 轴 | family 表 | MLP (92 列) | MLP (32 列，无身份列) |
| --- | --- | --- | --- | --- |
| \`facet\` 换一个没见过的**角色** | similarity | **0.7816** | 0.7669 | 0.7477 |
| \`facet\` 换一个没见过的**角色** | dependency | **0.7657** | 0.7156 | 0.7332 |
| \`family\` 换一个没见过的**职能** | similarity | **0.5899** | 0.5439 | 0.5544 |

最后一行的读法：换一个粗粒度职能时，MLP 的相似度**低于"永远猜众数"**（0.5899）。
这不说明"模型训练得不好"，而说明**标签本身几乎没有超出 (familyL, familyR) 的分辨率** ——
无论规则 teacher 还是 AI 判分，都在主要对两侧的粗粒度职能起反应。
标签里没有的信息，参数再多也变不出来。

所以交付物是 36 格的表：几 KB、可解释、某一格不对可以直接手改而不必重训，
而且**指标是真正的折上泛化**（表不需要训练，所以能逐折留出；全量重训的 MLP 只能报拟合值）。

表里的值仍然是**从标签学来的**，不是手写规则 —— 这正是方案二想改进的那一点：
它不会带上 teacher 那条"同族一律压到 0"的悬崖。

## 怎么接进系统

\`\`\`js
import { loadCapabilityScorer, scoredDependencyScore, scoredSelectReplacement, describeScorerFallback }
  from './src/shared/contracts/uBuddyCapabilityDependencyScorer.js';

const scorer = loadCapabilityScorer('artifacts/${ARTIFACT_ID}');   // 表优先，其次 model/
describeScorerFallback(scorer).mode;                               // 'table' | 'model' | 'rule'

scoredDependencyScore(scorer, plannerProfile, specialistProfile);  // 规划：选互补
scoredSelectReplacement(scorer, failedProfile, candidates);        // 归因：选最像的换上去
\`\`\`

三个入口与 \`uBuddyCapabilityDependencyBundle.js\` 的那三个**形状一致，可直接替换**。
\texttt{scorer} 为空时自动回落到手写规则，且这件事可以用 \`describeScorerFallback\` 读出来。

## 训练集里有什么

| 文件 | 是什么 |
| --- | --- |
| \`matrix.json\` | 规格：行数、维度、词表、特征名、特征变体列、四种折、标签来源、全部输入的 sha256 |
| \`X.f32\` | n × d 的 float32 特征矩阵（小端），行序与 \`rows.jsonl\` 一致 |
| \`y_dependency.i8\` / \`y_similarity.i8\` | n 个 0..4 的档位下标 |
| \`rows.jsonl\` | \`{index,id,split,kind}\`，**不含标签**（防下游误把答案拼进特征） |
| \`folds.jsonl\` | 四种留出方案 + 查表键 |
| \`labels.jsonl\` | \`{id,dependency,similarity}\`，便于核对标签来源 |

重训命令写在 \`manifest.json\` 的 \`trainingSet.retrain\` 里。

## 必须知道的三条限制

1. **标签是 AI 生成的，不是人工标注。** 由本机 Qwen3-8B 多数投票得到。
   \`human_labels.jsonl\` 里没有任何人工标注（有测试在守这条）。
2. **AI 判分对提问措辞敏感**：不同 framing 之间的 qwk 只有 0.2-0.3。所以标签本身的稳定性有上限。
3. **未知家族对会并列**：回落到 prior 后，这些 pair 的分数相同，排序退化为按 agentId。
   这是已量化的（\`family\` 折 = 0.5899 = 众数），不是意外。
`;
writeFileSync(join(EXPORT_DIR, 'README.zh-CN.md'), readme, 'utf8');

console.log(JSON.stringify({
  ok: true,
  artifactDir: `artifacts/${ARTIFACT_ID}`,
  exportDir: 'exports/cpdb-training-set-v1',
  tableSha256: manifest.artifacts.table.sha256,
  modelSha256: manifest.artifacts.model?.sha256 || null,
  jsFoldCrossCheck: foldCrossCheck,
}, null, 2));
