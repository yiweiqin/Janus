import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stepIndex } from './export_training_matrix.mjs';
import {
  CPDB_FEATURE_SPEC_VERSION,
  CPDB_FEATURE_VARIANT_NAMES,
  buildVocab,
  featureDimension,
  featureNames,
  featureVariantColumns,
  normalizeAgentView,
  pairFeatures,
  selectFeatureColumns,
} from './lib/features.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data', 'full');

function readJsonl(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const agents = readJsonl(join(DATA, 'agents.jsonl'));
const pairs = readJsonl(join(DATA, 'pairs.jsonl'));
const viewsById = new Map(agents.map((agent) => [agent.id, normalizeAgentView(agent)]));
const vocab = buildVocab([...viewsById.values()]);

/**
 * 这组测试守的是**训练管线最容易悄悄坏掉的地方**：特征里混进答案。
 *
 * 混进来的方式往往不是「我故意加了 initDependency」，而是「反正 pair 那一行都在手上，
 * 顺手传进去吧」。而 `kind` 混进来最危险：它的四个取值和分数分布高度相关
 * （`hard_negative` 两轴都低、`cross_owner_similar` 相似度高），于是指标会很好看，
 * 但服务期根本不知道 kind —— 上线即失效，而且离线看不出来。
 */
test('特征码与维度自洽，且名字数量正好等于维度', () => {
  assert.equal(CPDB_FEATURE_SPEC_VERSION, 'cpdb_pair_features_v1');
  const names = featureNames(vocab);
  assert.equal(names.length, featureDimension(vocab));
  assert.equal(new Set(names).size, names.length, '特征名有重复，列顺序就无法从名字唯一确定');
});

test('同一个 pair 算两次得到完全相同的向量（无隐藏状态）', () => {
  const pair = pairs[0];
  const left = viewsById.get(pair.leftAgentId);
  const right = viewsById.get(pair.rightAgentId);
  assert.deepEqual(pairFeatures(left, right, vocab), pairFeatures(left, right, vocab));
});

test('泄漏闸：把答案字段全部改掉，特征必须一个数都不变', () => {
  const pair = pairs.find((item) => item.kind === 'hard_negative');
  const clean = pairFeatures(viewsById.get(pair.leftAgentId), viewsById.get(pair.rightAgentId), vocab);
  // 把「答案」以字段的形式贴到画像上，再算一遍。如果实现里哪天顺手读了 `agent.kind`
  // 或 `agent.initDependency`，这条会立刻红 —— 只改 pair 那一行是测不到的，
  // 因为特征函数拿到的是画像，不是 pair。
  const poisonedAgent = {
    ...agents.find((agent) => agent.id === pair.leftAgentId),
    kind: 'cross_owner_similar',
    split: 'test',
    isTwin: true,
    initDependency: 1,
    initSimilarity: 1,
    contractDependency: 1,
    contractSimilarity: 1,
    humanDependency: 1,
    humanSimilarity: 1,
    combined: 1,
  };
  const poisoned = normalizeAgentView(poisonedAgent);
  const cleanLeft = normalizeAgentView(agents.find((agent) => agent.id === pair.leftAgentId));
  assert.deepEqual(poisoned, cleanLeft, '答案字段混进了归一化后的画像视图');

  // 特征名里不许出现任何答案类字段。判据用**精确字段名**而不是子串正则：
  // 这个世界里真有一个 facet 叫 `research.claim_split`，子串匹配会把
  // `facet_l=research.claim_split` 误判成泄漏 —— 一道会因为数据内容而随机变红的闸，
  // 最后只会被人加白名单加到失效。
  const names = featureNames(vocab);
  const forbidden = [
    'kind', 'split', 'isTwin', 'initDependency', 'initSimilarity',
    'contractDependency', 'contractSimilarity', 'humanDependency', 'humanSimilarity', 'combined',
  ];
  for (const field of forbidden) {
    assert.ok(!names.includes(field), `特征名里出现了答案字段：${field}`);
  }
  assert.ok(!names.some((name) => /dependency|similarity|combined/i.test(name)), '特征名里出现了分数类字段');

  // 顺带把「整行 pair 当画像喂进去」也跑一遍。pair 行里确实有 `orgId` 这种同名字段
  // （它是个 `a|b` 的合成串），所以这一条断言的**不是**「结果等于空画像」，
  // 而是「再加一堆答案字段进去，结果不变」—— 这才是要守的不变式。
  const asPair = pairFeatures(normalizeAgentView(pair), normalizeAgentView(pair), vocab);
  const asAnswerLadenPair = pairFeatures(
    normalizeAgentView({ ...pair, kind: 'within_owner_directed', split: 'train', initDependency: 1, contractDependency: 0 }),
    normalizeAgentView(pair),
    vocab,
  );
  assert.deepEqual(asAnswerLadenPair, asPair, '答案字段影响了从 pair 行算出来的特征');
});

test('同一对正反两个方向会得到不同的向量（产物流向是有向的）', () => {
  const directional = pairs.find((pair) => !pair.isTwin && pair.leftFamily !== pair.rightFamily);
  const forward = pairFeatures(viewsById.get(directional.leftAgentId), viewsById.get(directional.rightAgentId), vocab);
  const backward = pairFeatures(viewsById.get(directional.rightAgentId), viewsById.get(directional.leftAgentId), vocab);
  // 如果实现对左/右一视同仁，dependency 这一轴就退化成对称量，
  // 而它的定义（「左方产出是否适合作为右方输入」）本来就是有向的。
  assert.notDeepEqual(forward, backward);
});

test('特征的取值范围是有界的，不会喂给网络一个 NaN', () => {
  const names = featureNames(vocab);
  for (const pair of pairs.filter((_, at) => at % 97 === 0)) {
    const feature = pairFeatures(viewsById.get(pair.leftAgentId), viewsById.get(pair.rightAgentId), vocab);
    for (const [at, value] of feature.entries()) {
      assert.ok(Number.isFinite(value), `${names[at]} 不是有限数：${value}`);
      // 0/1 标志、比例、计数都在 [0, 8] 内：计数类最大是 consumes 的条数，实测不超过 8。
      assert.ok(value >= 0 && value <= 8, `${names[at]} 越界：${value}`);
    }
    for (const name of ['dep_ratio_lr', 'dep_ratio_rl', 'jaccard_capabilityTags', 'contain_lr_produces']) {
      const value = feature[names.indexOf(name)];
      assert.ok(value >= 0 && value <= 1, `${name} 应该在 [0,1]：${value}`);
    }
  }
});

test('normalizeAgentView 同时吃得下 Agent 记录和 published profile', () => {
  const profile = readJsonl(join(DATA, 'agent_profiles.jsonl'))[0];
  const record = agents.find((agent) => agent.id === profile.uBuddyAgentInstanceId);
  const fromRecord = normalizeAgentView(record);
  const fromProfile = normalizeAgentView(profile);
  // 两条路必须落到同一组能力字段上：训练用记录、服务用 profile，
  // 只要有一边漏了 family/facet/produces，特征就会整体错位而维度仍然合法。
  for (const field of ['familyId', 'facetId', 'produces', 'consumes', 'detailCapabilities']) {
    assert.deepEqual(fromProfile[field], fromRecord[field], `${field} 在两条路径下不一致`);
  }
  assert.deepEqual(fromProfile.capabilityTags, fromRecord.capabilityTags);
  // Agent 记录里的 domain/orgId 只存在于记录侧，profile 侧为空 —— 这是已知且刻意的
  // （消融里专门有 `not_in_profile` 这一组），所以这里断言的是「profile 侧为空」而不是「相等」。
  assert.equal(fromProfile.orgId, '');
  assert.equal(fromRecord.orgId, record.orgId);
});

test('词表是排序去重的，换个遍历顺序也得到同一份词表', () => {
  const values = [...viewsById.values()];
  const reversed = buildVocab([...values].reverse());
  assert.deepEqual(reversed, vocab);
  assert.deepEqual(vocab.families, [...vocab.families].sort());
  assert.deepEqual(vocab.facets, [...vocab.facets].sort());
  assert.equal(vocab.families.length, 6);
  assert.equal(vocab.facets.length, 24);
});

test('标签只在标尺上才收，落不到档位的一律拒绝而不是四舍五入', () => {
  for (const value of [0, 0.25, 0.5, 0.75, 1]) assert.ok(stepIndex(value) >= 0, `${value} 应该被接受`);
  // 0.6 这种中间值必须被拒：它是「标注没按协议走」的证据，四舍五入到 0.5 会把它抹掉。
  for (const value of [0.6, 0.1, 1.5, -0.25, Number.NaN, null, '0.5', undefined]) {
    assert.equal(stepIndex(value), -1, `${value} 应该被拒绝`);
  }
});

/**
 * 特征变体这一层是诊断轮的关键承重件，所以它自己也要有闸。
 *
 * 它坏掉的方式很安静：`columns` 少一列、多一列、顺序变了，训练照样跑完，
 * 指标照样出来 —— 只是那个指标已经不是你打算测的东西了。留出 facet 的折尤其危险：
 * 只要 `no_identity` 漏回一列 `facet_l=`，那一格就又被"角色名"喂饱，
 * 于是结论会从「内容里有信号」翻成「模型在记角色」而没人察觉。
 */
test('每个特征变体的列都落在特征维度内，且不含角色恒等列以外的越界', () => {
  const names = featureNames(vocab);
  for (const variant of CPDB_FEATURE_VARIANT_NAMES) {
    const columns = featureVariantColumns(vocab, variant);
    assert.ok(columns.length > 0, `${variant} 是空列集`);
    assert.equal(new Set(columns).size, columns.length, `${variant} 的列下标有重复`);
    assert.deepEqual(columns, [...columns].sort((a, b) => a - b), `${variant} 的列下标没有升序`);
    for (const at of columns) {
      assert.ok(at >= 0 && at < names.length, `${variant} 的列下标 ${at} 越界`);
    }
  }
  assert.deepEqual(featureVariantColumns(vocab, 'full'), names.map((_, at) => at));
});

test('no_identity / content_only 里一列角色恒等列都不许剩', () => {
  const names = featureNames(vocab);
  for (const variant of ['no_identity', 'content_only']) {
    const kept = featureVariantColumns(vocab, variant).map((at) => names[at]);
    const identity = kept.filter((name) => /^(family|facet)_[lr]=/.test(name));
    assert.deepEqual(identity, [], `${variant} 里残留了角色恒等列：${identity.slice(0, 5).join(',')}`);
  }
  // `content_only` 比 `no_identity` 再少掉 6 个 `same_*` 标志，这一个差值就是
  // 「same_facet / same_family 有没有独自承担全部信号」这个问题的全部预算。
  const noIdentity = featureVariantColumns(vocab, 'no_identity');
  const contentOnly = featureVariantColumns(vocab, 'content_only');
  const difference = noIdentity.filter((at) => !contentOnly.includes(at));
  assert.equal(difference.length, 6, `两个变体应当只差 6 个 same_* 标志，实际差 ${difference.length} 列`);
  assert.ok(
    difference.every((at) => names[at].startsWith('same_')),
    '两个变体之间差的列不全是 same_* 标志',
  );
});

test('按变体裁列得到的向量与逐列取值的口径一致', () => {
  // 训练侧用 `columns` 去切矩阵，推理侧用 `selectFeatureColumns` 去切向量。
  // 两处只要口径不一致，线上分数就会与离线指标对不上，而且不会报错。
  const pair = pairs[0];
  const feature = pairFeatures(viewsById.get(pair.leftAgentId), viewsById.get(pair.rightAgentId), vocab);
  for (const variant of CPDB_FEATURE_VARIANT_NAMES) {
    const columns = featureVariantColumns(vocab, variant);
    assert.deepEqual(
      selectFeatureColumns(feature, columns),
      columns.map((at) => feature[at]),
      `${variant} 的裁列口径与逐列取值不一致`,
    );
  }
});

test('未知变体名直接抛错，不静默回落到 full', () => {
  // 静默回落会让 `--feature-variant no_identiy`（打错一个字母）跑出一份 full 的结果，
  // 而报告上写的却是 no_identity —— 这正好是最难发现的那类错误。
  assert.throws(() => featureVariantColumns(vocab, 'no_identiy'), /cpdb_feature_variant_unknown/);
  assert.throws(() => featureVariantColumns(vocab, ''), /cpdb_feature_variant_unknown/);
});
