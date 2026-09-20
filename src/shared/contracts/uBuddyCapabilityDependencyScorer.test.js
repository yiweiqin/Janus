import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dependencyScore, similarityScore } from './uBuddyCapabilityDependencyBundle.js';
import {
  buildScorer,
  buildTableScorer,
  CPDB_SCORER_DIR_ENV,
  describe,
  describeScorerFallback,
  loadCapabilityScorer,
  loadScorer,
  loadTableScorer,
  resolveScorerFromEnvironment,
  scoreFeature,
  scorePair,
  scoredDependencyScore,
  scoredSelectCollaborators,
  scoredSelectReplacement,
  scoredSimilarityScore,
  usable,
} from './uBuddyCapabilityDependencyScorer.js';
import { CPDB_FEATURE_SPEC_VERSION, buildVocab, featureNames } from './uBuddyCapabilityPairFeatures.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, '..', '..', '..');

/**
 * 这个文件的判据是**「模型接进契约之后，坏的方式要能被发现」**。
 *
 * 打分器的精度由 `experiments/cpdb_org_world/` 下的对账与诊断测试负责；
 * 这里只管接线：列裁剪的顺序、缺权重时的回落、自依赖的零、以及排序口径。
 * 这几件事都不会让分数变得"看起来不对"，只会让它悄悄错 —— 所以必须钉住。
 */

// --------------------------------------------------------------------------------------
// 合成权重：不依赖任何产物，专门用来钉住"裁列与标准化的先后顺序"
// --------------------------------------------------------------------------------------

const EMPTY_VOCAB = { families: [], facets: [] };

/**
 * 造一份最小但合法的权重：`dimension` 列特征，只保留 `columns`，线性头。
 *
 * 头的权重刻意构造成「只看裁剪后的第 0 列」：这样输出与 `feature[columns[0]]` 单调，
 * 于是"先裁列再标准化"和"先标准化再裁列"这两种实现的差别会**直接体现在分数上**。
 */
function syntheticWeights({ dimension, columns, vocab = EMPTY_VOCAB }) {
  const width = columns.length;
  const scale = [0, 0.25, 0.5, 0.75, 1];
  const headWeight = [];
  for (let out = 0; out < scale.length; out += 1) {
    for (let at = 0; at < width; at += 1) headWeight.push(at === 0 ? out : 0);
  }
  return {
    schema: 'cpdb_scorer_weights/v1',
    featureSpec: CPDB_FEATURE_SPEC_VERSION,
    dimension,
    featureNames: Array.from({ length: dimension }, (_, at) => `f${at}`),
    variant: 'synthetic',
    columns,
    vocab,
    scale,
    standardizer: { mean: new Array(width).fill(0), std: new Array(width).fill(1) },
    layers: [],
    headLayers: {
      dependency: { in: width, out: scale.length, weightKey: 'dependency.weight', biasKey: 'dependency.bias' },
      similarity: { in: width, out: scale.length, weightKey: 'similarity.weight', biasKey: 'similarity.bias' },
    },
    stateDict: {
      'dependency.weight': headWeight,
      'dependency.bias': new Array(scale.length).fill(0),
      'similarity.weight': headWeight,
      'similarity.bias': new Array(scale.length).fill(0),
    },
    note: '测试用合成权重',
  };
}

// 走 `scorePair`（也就是真的去算画像特征）的测试必须用**真实的特征宽度**，
// 否则 `scorePair` 造出来的是 32 维、而合成权重只认 4 维，直接维度不符。
// 空词表下 `featureDimension` = 6 + 0 + 0 + 8 + 18 = 32。
const REAL_DIMENSION = featureNames(EMPTY_VOCAB).length;

function syntheticReal({ columns }) {
  return syntheticWeights({ dimension: REAL_DIMENSION, columns });
}

test('裁列发生在标准化之前：只保留的列决定输出', () => {
  const feature = [0.1, 0.2, 0.9, 0.4];
  // 保留第 2 列 → 输出应当只由 0.9 决定
  const picked = buildScorer(syntheticWeights({ dimension: 4, columns: [2] }));
  const other = buildScorer(syntheticWeights({ dimension: 4, columns: [0] }));

  const a = scoreFeature(picked, feature);
  const b = scoreFeature(other, feature);
  // 同一份特征、只换保留的列，分数必须不同 —— 否则"裁列"根本没发生。
  assert.notEqual(a.dependency.expected, b.dependency.expected, '换了保留列却得到同一个分，裁列没有生效');

  // 顺序判据：把特征**手工**裁成 [0.9] 再喂给一个 columns=[0] 的打分器，
  // 结果必须与"用 columns=[2] 的打分器吃原特征"完全一致。
  // 若实现是「先标准化再裁列」，这两者会不同（标准化参数会应用到错的列上）。
  const manual = buildScorer(syntheticWeights({ dimension: 1, columns: [0] }));
  assert.equal(
    scoreFeature(picked, feature).dependency.expected,
    scoreFeature(manual, [0.9]).dependency.expected,
    '裁列与标准化的先后顺序不对：应当先裁列再标准化',
  );
  // 保留列的顺序也要生效：columns=[0,2] 与 [2,0] 不是同一个输入。
  const ordered = buildScorer(syntheticWeights({ dimension: 4, columns: [0, 2] }));
  const reversed = buildScorer(syntheticWeights({ dimension: 4, columns: [2, 0] }));
  assert.notEqual(
    scoreFeature(ordered, feature).dependency.expected,
    scoreFeature(reversed, feature).dependency.expected,
    'columns 的顺序被忽略了',
  );
});

test('维度与自述不自洽时直接抛错，不静默错分', () => {
  // 特征码不对：往下走都是合法的矩阵乘法，必须在这里断。
  const wrongSpec = syntheticWeights({ dimension: 4, columns: [0] });
  wrongSpec.featureSpec = 'cpdb_pair_features_v0';
  assert.throws(() => buildScorer(wrongSpec), /cpdb_scorer_feature_spec_mismatch/);

  const wrongSchema = syntheticWeights({ dimension: 4, columns: [0] });
  wrongSchema.schema = 'something_else';
  assert.throws(() => buildScorer(wrongSchema), /cpdb_scorer_weights_schema_unknown/);

  // 标准化参数宽度与保留列数不一致：这一条最容易在换变体时漏掉。
  const wrongStd = syntheticWeights({ dimension: 4, columns: [0, 1] });
  wrongStd.standardizer = { mean: [0], std: [1] };
  assert.throws(() => buildScorer(wrongStd), /cpdb_scorer_standardizer_width/);

  // 第一层宽度与保留列数不一致。
  const wrongLayer = syntheticWeights({ dimension: 4, columns: [0, 1] });
  wrongLayer.layers = [{ index: 0, in: 5, out: 2, weightKey: 'trunk.0.weight', biasKey: 'trunk.0.bias' }];
  wrongLayer.stateDict['trunk.0.weight'] = new Array(10).fill(0);
  wrongLayer.stateDict['trunk.0.bias'] = [0, 0];
  assert.throws(() => buildScorer(wrongLayer), /cpdb_scorer_first_layer_width/);

  // 列下标越界。
  const outOfRange = syntheticWeights({ dimension: 4, columns: [7] });
  assert.throws(() => buildScorer(outOfRange), /cpdb_scorer_column_out_of_range/);

  // 缺一个头。
  const missingHead = syntheticWeights({ dimension: 4, columns: [0] });
  delete missingHead.headLayers.similarity;
  assert.throws(() => buildScorer(missingHead), /cpdb_scorer_head_missing/);
});

test('特征维度与权重不符时抛错，而不是把短的向量补齐', () => {
  const scorer = buildScorer(syntheticWeights({ dimension: 4, columns: [0, 1] }));
  assert.throws(() => scoreFeature(scorer, [1, 2, 3]), /cpdb_scorer_feature_dimension/);
});

// --------------------------------------------------------------------------------------
// 契约适配：回落、自依赖、排序
// --------------------------------------------------------------------------------------

test('没有权重时回落到手写契约，且回落是可察觉的', () => {
  const A = { agentId: 'A', capabilityTags: ['research'], deliverableTypes: ['report'], supportedTaskTypes: ['research'] };
  const B = { agentId: 'B', capabilityTags: ['writing'], deliverableTypes: ['notes'], supportedTaskTypes: ['writing'] };

  assert.equal(usable(null), false);
  assert.equal(usable({}), false);
  // 只加载了一半的 scorer 不算可用：`if (scorer)` 这种判据会放过它。
  assert.equal(usable({ heads: { dependency: {} }, columns: [0] }), false);

  assert.equal(describeScorerFallback(null).mode, 'rule');
  // 回落时两个入口必须与契约**逐位相同**，否则"回落"就成了第三种行为。
  assert.equal(scoredDependencyScore(null, A, B), dependencyScore(A, B));
  assert.equal(scoredSimilarityScore(null, A, B), similarityScore(A, B));

  const collab = scoredSelectCollaborators(null, [A, B], B, { limit: 1 });
  assert.equal(collab.length, 1);
  const swap = scoredSelectReplacement(null, A, [A, B], { limit: 1 });
  assert.equal(swap[0].profile.agentId, 'B');

  assert.equal(describeScorerFallback({ heads: { dependency: {}, similarity: {} }, columns: [0] }).mode, 'model');
});

test('自依赖一律 0，不交给模型去学', () => {
  // 用一个"任何输入都输出最高档"的合成权重：如果实现没有在自依赖处短路，
  // 分数就会是 1 而不是 0 —— 这条测试才真正在测那条短路。
  const flat = syntheticReal({ columns: [0, 1] });
  flat.stateDict['dependency.bias'] = Array.from({ length: 5 }, (_, at) => at * 10);
  flat.stateDict['similarity.bias'] = Array.from({ length: 5 }, (_, at) => at * 10);
  const scorer = buildScorer(flat);

  const A = { agentId: 'A', capabilityTags: [], deliverableTypes: [], supportedTaskTypes: [] };
  // 先确认这份合成权重确实会给出非零分，否则下面的 0 可能只是"本来就 0"。
  assert.ok(scoredDependencyScore(scorer, A, { agentId: 'B' }) > 0, '合成权重没有给出非零分，测试失去意义');
  assert.equal(scoredDependencyScore(scorer, A, A), 0);
  assert.equal(scoredSimilarityScore(scorer, A, A), 0);
  // 缺 agentId 也算不可比。
  assert.equal(scoredDependencyScore(scorer, { agentId: '' }, A), 0);
  assert.equal(scoredSimilarityScore(scorer, A, { agentId: '' }), 0);
});

test('分数始终有限且在契约的 0..1 内，包括画像字段畸形时', () => {
  const scorer = buildScorer(syntheticReal({ columns: [0, 1, 5] }));
  // `expected` 是档位的凸组合，本身就越不出 0..1；真正会出问题的是
  // 画像畸形导致特征里出现 NaN —— 那会一路传到分数上，而排序对 NaN 的行为是
  // "看起来排了、其实没排"。所以这里喂的是畸形输入。
  const hostile = [
    {},
    { agentId: 'x' },
    { agentId: 'x', capabilityTags: 'research' },
    { agentId: 'x', capabilityTags: [null, undefined, 0, false, 'ok'] },
    { agentId: 'x', produces: { not: 'a list' }, consumes: 42 },
    { agentId: 'x', capabilityTags: new Array(50).fill('t'), detailCapabilities: ['a', 'b'] },
    { uBuddyAgentInstanceId: 'y', extra: { familyId: 'f', facetId: 'c', produces: ['a'], consumes: ['b'] } },
  ];
  for (const left of hostile) {
    for (const right of hostile) {
      for (const fn of [scoredDependencyScore, scoredSimilarityScore]) {
        const score = fn(scorer, left, right);
        assert.ok(Number.isFinite(score), `非有限分数：${JSON.stringify(left)} / ${JSON.stringify(right)}`);
        assert.ok(score >= 0 && score <= 1, `分数越界：${score}`);
      }
    }
  }
  // `describe` 是 exported 的纯函数，顺手钉一下它的形状。
  const described = describe([0, 0, 0, 0, 0], [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(described.argmax, 0);
  assert.equal(described.probability.length, 5);
  assert.ok(Math.abs(described.probability.reduce((a, b) => a + b, 0) - 1) < 1e-5);
});

test('模型版排序：换人排除失败者本身，且按相似度降序', () => {
  // 合成一份"只看保留列的第 0 列"的权重，于是分数的序由该列决定，可以精确断言。
  const scorer = buildScorer(syntheticReal({ columns: [0] }));
  const failed = { agentId: 'failed', capabilityTags: [] };
  const candidates = [
    { agentId: 'low', capabilityTags: [] },
    { agentId: 'high', capabilityTags: [] },
    { agentId: 'failed', capabilityTags: [] },
  ];
  const result = scoredSelectReplacement(scorer, failed, candidates, { limit: 3 });
  assert.deepEqual(
    result.map((item) => item.profile.agentId).includes('failed'), false,
    '换人列表里出现了失败的 Agent 自己',
  );
  assert.equal(result.length, 2);
  for (let at = 1; at < result.length; at += 1) {
    assert.ok(result[at - 1].score >= result[at].score, '结果没有按分数降序');
  }
  // limit 生效，且非法 limit 不炸。
  assert.equal(scoredSelectCollaborators(scorer, candidates, { agentId: 'sink' }, { limit: 1 }).length, 1);
  assert.ok(scoredSelectCollaborators(scorer, candidates, { agentId: 'sink' }, { limit: 0 }).length >= 1);
  assert.deepEqual(scoredSelectCollaborators(scorer, [], { agentId: 'sink' }), []);
});

// --------------------------------------------------------------------------------------
// 真产物：只有在产物在场时才跑
// --------------------------------------------------------------------------------------

const ARTIFACT_DIR = join(REPO, 'experiments', 'cpdb_org_world', 'artifacts', 'cpdb-scorer-v2-aijudge');

test('能加载真产物，并按它自述的变体裁列', { skip: !existsSync(join(ARTIFACT_DIR, 'weights.json')) }, () => {
  const scorer = loadScorer(ARTIFACT_DIR);
  assert.ok(usable(scorer));
  // v1/v2 的权重没有 `columns` 字段，按 full 处理：列数必须等于全量维度。
  assert.equal(scorer.variant, 'full');
  assert.equal(scorer.columns.length, scorer.dimension);
  assert.equal(scorer.columns.length, featureNames(scorer.vocab).length);

  const left = { uBuddyAgentInstanceId: 'l', capabilityTags: ['research'], deliverableTypes: ['notes'], supportedTaskTypes: ['research'] };
  const right = { uBuddyAgentInstanceId: 'r', capabilityTags: ['writing'], deliverableTypes: ['report'], supportedTaskTypes: ['writing'] };
  const scored = scorePair(scorer, left, right);
  for (const axis of ['dependency', 'similarity']) {
    assert.ok(scored[axis].expected >= 0 && scored[axis].expected <= 1, `${axis} 的期望值越界`);
    assert.ok(Number.isFinite(scored[axis].argmax));
    // 两个轴必须分开给，不能出现合成总分（契约的 `forbidden`）。
    assert.equal(scored.combined, undefined);
  }
  // 模型版与手写版都应当是有限数，且都遵守契约的 0..1。
  const modelScore = scoredSimilarityScore(scorer, left, right);
  const ruleScore = similarityScore(left, right);
  for (const value of [modelScore, ruleScore]) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
});

test('权重里的词表能还原出特征名，且与特征维度自洽', { skip: !existsSync(join(ARTIFACT_DIR, 'weights.json')) }, () => {
  const scorer = loadScorer(ARTIFACT_DIR);
  const names = featureNames(scorer.vocab);
  assert.equal(names.length, scorer.dimension);
  // 词表是从 Agent 视图推出来的，必须是排序去重的（否则"同一个世界两份词表"会导致列错位）。
  assert.deepEqual(scorer.vocab.families, [...scorer.vocab.families].sort());
  assert.deepEqual(scorer.vocab.facets, [...scorer.vocab.facets].sort());
  assert.equal(new Set(scorer.vocab.facets).size, scorer.vocab.facets.length);
});

test('词表为空时仍能构造（服务期只有画像没有数据集）', () => {
  // `buildVocab` 是纯函数，词表跟着权重走 —— 服务期没有数据集，只能靠存下来的词表。
  // 这条确认"没有词表"不会抛在奇怪的地方。
  assert.deepEqual(buildVocab([]), { families: [], facets: [] });
});

// --------------------------------------------------------------------------------------
// 交付表（`table.json`）
// --------------------------------------------------------------------------------------

const TABLE_DIR = join(REPO, 'experiments', 'cpdb_org_world', 'artifacts', 'cpdb-scorer-v3-ship');

test('表打分器的键是有向 family 对，且未知对回落到 prior', { skip: !existsSync(join(TABLE_DIR, 'table.json')) }, () => {
  const scorer = loadTableScorer(TABLE_DIR);
  assert.equal(scorer.kind, 'table');
  assert.equal(scorer.keyKind, 'family_pair');
  assert.ok(usable(scorer));
  // `usable` 不能把表当成"没有 heads 的坏模型"。
  assert.equal(describeScorerFallback(scorer).mode, 'table');

  const cells = Object.keys(scorer.cells);
  assert.ok(cells.length > 0, '表是空的');
  for (const key of cells) assert.match(key, /^[^>]*>[^>]*$/, `键格式不对：${key}`);

  const left = { uBuddyAgentInstanceId: 'l', extra: { familyId: 'research', facetId: 'research.web' } };
  const right = { uBuddyAgentInstanceId: 'r', extra: { familyId: 'writing', facetId: 'writing.copy' } };
  const scored = scorePair(scorer, left, right);
  assert.equal(scored.dependency.key, 'research>writing');
  assert.equal(scored.similarity.key, 'research>writing');
  // 有向：反过来是另一个键 —— 相似度那一轴也用了有向键，这是设计上的取舍（见 run_fit_table）。
  assert.equal(scorePair(scorer, right, left).dependency.key, 'writing>research');

  for (const axis of ['dependency', 'similarity']) {
    const probabilities = scored[axis].probability;
    assert.equal(probabilities.length, scorer.scale.length);
    assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-5, `${axis} 的概率没归一`);
    assert.ok(scored[axis].expected >= 0 && scored[axis].expected <= 1);
    assert.ok(Number.isFinite(scored[axis].argmax));
  }

  // 未知家族对：key 命中不了，必须回落到 prior，且这件事要能从 `hit` 上看出来。
  const stranger = { uBuddyAgentInstanceId: 's', extra: { familyId: '不存在的职能' } };
  const missed = scorePair(scorer, stranger, right);
  assert.equal(missed.dependency.hit, false);
  assert.deepEqual(missed.dependency.probability.map((p) => Math.round(p * 1e6) / 1e6),
    scorer.prior.dependency.map((p) => Math.round(p * 1e6) / 1e6));
});

test('表接进契约后仍然守契约的三条硬约束', { skip: !existsSync(join(TABLE_DIR, 'table.json')) }, () => {
  const scorer = loadTableScorer(TABLE_DIR);
  const left = { uBuddyAgentInstanceId: 'l', extra: { familyId: 'research' } };
  const right = { uBuddyAgentInstanceId: 'r', extra: { familyId: 'writing' } };

  // 1) 自依赖为 0
  assert.equal(scoredDependencyScore(scorer, left, left), 0);
  assert.equal(scoredSimilarityScore(scorer, left, left), 0);
  // 2) 两轴分开，不合成
  assert.equal(scorePair(scorer, left, right).combined, undefined);
  // 3) 落在 0..1
  for (const fn of [scoredDependencyScore, scoredSimilarityScore]) {
    const score = fn(scorer, left, right);
    assert.ok(Number.isFinite(score) && score >= 0 && score <= 1);
  }

  // 表打分器不吃特征向量：必须明确报错，而不是拿一个未定义的行为去打分。
  assert.throws(() => scoreFeature(scorer, [0]), /cpdb_scorer_table_has_no_features/);

  // 换人列表仍然排除失败者本身。
  const result = scoredSelectReplacement(scorer, left, [left, right], { limit: 2 });
  assert.equal(result.length, 1);
  assert.equal(result[0].profile.agentId, 'r');
});

test('加载入口优先表、其次模型', { skip: !existsSync(join(TABLE_DIR, 'table.json')) }, () => {
  const scorer = loadCapabilityScorer(TABLE_DIR);
  // 表在同一个目录里，优先级必须是定的：如果"两个都在时选哪个"不定死，
  // 线上行为会随打包内容悄悄漂移，而两种分数的口径不同（一个是拟合、一个是折上泛化）。
  assert.equal(scorer.kind, 'table');
  // 权重放在子目录里（`model/`），这样"目录里同时有表和模型"不会变成两种可能的行为。
  if (existsSync(join(TABLE_DIR, 'model', 'weights.json'))) {
    assert.equal(loadScorer(join(TABLE_DIR, 'model')).kind, 'model');
  }
  // 空目录要抛可识别的错误，而不是返回 undefined 让调用方在别处炸。
  assert.throws(() => loadCapabilityScorer(join(TABLE_DIR, '不存在的目录')), /cpdb_scorer_unavailable/);
});

test('表的结构不自洽时直接抛错', () => {
  const valid = {
    schema: 'cpdb_scorer_table/v1',
    keyKind: 'family_pair',
    scale: [0, 0.25, 0.5, 0.75, 1],
    cells: { 'a>b': { dependency: [1, 0, 0, 0, 0], similarity: [1, 0, 0, 0, 0] } },
    prior: { dependency: [1, 0, 0, 0, 0], similarity: [1, 0, 0, 0, 0] },
  };
  assert.equal(buildTableScorer(valid).kind, 'table');

  assert.throws(() => buildTableScorer({ ...valid, schema: 'x' }), /cpdb_scorer_table_schema_unknown/);
  assert.throws(() => buildTableScorer({ ...valid, keyKind: 'facet_pair' }), /cpdb_scorer_table_key_kind/);
  assert.throws(() => buildTableScorer({ ...valid, scale: [] }), /cpdb_scorer_table_scale_missing/);
  // 格子宽度不等于档位数：会让 `describe` 把概率与档位错位相乘，必须在这里断。
  assert.throws(
    () => buildTableScorer({ ...valid, cells: { 'a>b': { dependency: [1, 0], similarity: [1, 0, 0, 0, 0] } } }),
    /cpdb_scorer_table_cell_width/,
  );
  assert.throws(() => buildTableScorer({ ...valid, prior: { dependency: [1], similarity: [1, 0, 0, 0, 0] } }),
    /cpdb_scorer_table_prior_width/);
});

// --------------------------------------------------------------------------------------
// 环境解析：三种"没有打分器"的原因必须能分开
// --------------------------------------------------------------------------------------

test('环境解析把「没配 / 路径不存在 / 产物坏了」分成三件事', () => {
  // 没配：正常情况，不该有 error。
  const unset = resolveScorerFromEnvironment({ env: {} });
  assert.equal(unset.source, 'unset');
  assert.equal(unset.scorer, null);
  assert.equal(unset.error, null);

  // 路径不存在：配置错了，但产物本身可能没问题。
  const missing = resolveScorerFromEnvironment({ env: { [CPDB_SCORER_DIR_ENV]: join(ROOT, '不存在的目录') } });
  assert.equal(missing.source, 'missing');
  assert.equal(missing.error, null);

  // 产物坏了：路径在、文件在，但内容不自洽。这一条要带上 error 才能被查出来。
  const invalid = resolveScorerFromEnvironment({ env: { [CPDB_SCORER_DIR_ENV]: ROOT } });
  assert.equal(invalid.source, 'invalid');
  assert.ok(invalid.error instanceof Error, '损坏的产物必须带上原因，否则"坏了"和"没配"无法区分');

  // 三种情况都不抛：调用方是规划路径，"没有打分器"不等于"规划失败"。
  // 但同时它们必须可区分 —— 把三种压成同一个 null 是这条测试要防的事。
  assert.deepEqual(
    [unset.source, missing.source, invalid.source],
    ['unset', 'missing', 'invalid'],
  );

  // `defaultDir` 作为兜底，且环境变量优先。
  assert.equal(resolveScorerFromEnvironment({ env: {}, defaultDir: TABLE_DIR }).source, 'loaded');
  assert.equal(
    resolveScorerFromEnvironment({ env: { [CPDB_SCORER_DIR_ENV]: join(ROOT, 'nope') }, defaultDir: TABLE_DIR }).source,
    'missing',
    '环境变量必须压过 defaultDir，否则排查时改 env 没有效果',
  );
});
