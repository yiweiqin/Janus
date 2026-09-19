// 能力画像依赖集束（CPDB）打分器的**输入特征**。
//
// 这里只做一件事：把一个 `(左, 右)` Agent 对映射成一个定长实数向量。之所以把它单独抽出来
// 当成一个纯函数、并且和训练脚本分开写，是因为**训练与推理必须看到完全相同的特征**：
// 只要两侧各写一份特征代码，就一定会漂移，而漂移的症状是「线上分数和离线指标对不上」，
// 排查起来极费时间。所以判据不是「两边算得都对」，而是「两边算的是同一段代码」——
// 训练矩阵由本文件产出（`export_training_matrix.mjs`），线上推理也用本文件（`scorer.mjs`）。
//
// ## 硬约束：特征不许看见答案
//
// `pairs.jsonl` 的每一行除了画像字段，还带着 `kind` / `split` / `isTwin` / `initDependency`
// / `initSimilarity` / `contractDependency` / `contractSimilarity`。这些东西**一个都不许进来**：
//
//   - `initDependency` / `initSimilarity` 就是我们要预测的标签本身，进来就是抄答案；
//   - `contractDependency` / `contractSimilarity` 是契约模型的输出，是**另一个**基线，
//     进来会让「学到的模型 vs 手写基线」这个对比彻底失去意义；
//   - `kind` 最危险：四种采样类型的分数分布差别很大（`hard_negative` 两轴都低，
//     `cross_owner_similar` 相似度高），它能让指标很好看，但**服务期根本不知道 kind** ——
//     上线时没有任何人会告诉你「这一对是硬负样本」。它进来就是一次不会复现的作弊；
//   - `split` / `isTwin` 同理，是数据侧属性，不是能力属性。
//
// 所以入参只有画像本身。`features.test.mjs` 里有一条泄漏闸，专门喂进带答案的行、
// 断言特征值不随答案变化 —— 光靠「我注意力集中」是靠不住的。
//
// ## 为什么特征里还有 orgId / domain
//
// `teacherDependency`（`lib/pairs.mjs`）里 `sameDomain` 加 0.08、`sameOrg` 加 0.04。
// 这两个信号在服务期是**可得**的：Agent 记录本来就带 `orgId` / `domain`，
// 而它们不是身份（600 个 Agent 只有 12 个 org、若干个 domain），不构成记忆。
// 把它们放进来，模型才有可能把 teacher 的分数复现出来；而 `splitBy: orgId`
// 让 test 落在**没见过的 org** 上，恰好能验证「学到的是能力语义，不是组织记忆」。

export const CPDB_FEATURE_SPEC_VERSION = 'cpdb_pair_features_v1';

// 参与集合相似度的六个集合。顺序即特征顺序，改动它会改变向量布局，
// 所以 `CPDB_FEATURE_SPEC_VERSION` 必须跟着改。
const SET_FIELDS = [
  'detailCapabilities',
  'capabilityTags',
  'deliverableTypes',
  'supportedTaskTypes',
  'produces',
  'consumes',
];

// 画像里可能承载这些字段的两处位置：Agent 记录本体，以及 published profile 的 `extra`。
// 服务期拿到的多半是 profile，训练期拿到的是 Agent 记录，两条路都要能走通。
const FIELD_ALIASES = {
  ownerUserId: ['ownerUserId'],
  orgId: ['orgId'],
  domain: ['domain'],
  topic: ['topic'],
  familyId: ['familyId'],
  facetId: ['facetId'],
  name: ['name'],
};

const LIST_FIELDS = [...SET_FIELDS, 'preferredTasks', 'skillDigest', 'skillMd'];

/**
 * 把「Agent 记录」或「published profile」统一成特征函数认识的形状。
 *
 * 两边字段名不完全一样：Agent 记录把 family/facet/produces/consumes/detailCapabilities
 * 放在顶层，而 `uBuddyCapabilityProfile` 把它们塞进 `extra`（见 `lib/profiles.mjs`）。
 * 这里按「顶层优先、extra 兜底」合并，于是同一个函数能同时服务数据集与线上 profile。
 */
export function normalizeAgentView(source = {}) {
  const extra = source.extra && typeof source.extra === 'object' ? source.extra : source;
  const view = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    view[field] = '';
    for (const alias of aliases) {
      const value = text(source[alias] ?? extra[alias]);
      if (value) { view[field] = value; break; }
    }
  }
  for (const field of LIST_FIELDS) {
    const raw = source[field] ?? extra[field];
    view[field] = Array.isArray(raw) ? unique(raw) : (text(raw) ? [text(raw)] : []);
  }
  // `agentId` 只用来做 join / 调试展示，**不进特征**：它是最容易被记成身份的字段。
  view.agentId = text(source.uBuddyAgentInstanceId || source.agentId || source.id);
  return view;
}

/**
 * 从一批 Agent 视图里抽出固定词表。词表要跟着权重一起存盘：
 * 服务期没有数据集，只能靠存下来的词表把 family/facet 名映射成同一批下标。
 * 用排序后的唯一值，保证「同样的世界 → 同样的词表」，不依赖遍历顺序。
 */
export function buildVocab(views = []) {
  const families = unique(views.map((item) => item.familyId).filter(Boolean)).sort();
  const facets = unique(views.map((item) => facetKey(item)).filter(Boolean)).sort();
  return { families, facets };
}

export function facetKey(view = {}) {
  if (!view.familyId || !view.facetId) return '';
  return `${view.familyId}.${view.facetId}`;
}

/**
 * 特征维度 = 6 个相对标志 + family 左右各一份 one-hot + facet 左右各一份 one-hot
 *          + 8 个产物流向 + 6 个集合 × 3 种相似度。
 * `scorer.mjs` 会用这个函数校验权重文件与特征码同版本，避免「换了特征却加载了旧权重」。
 */
export function featureDimension(vocab) {
  return 6 + 2 * vocab.families.length + 2 * vocab.facets.length + 8 + 3 * SET_FIELDS.length;
}

export function featureNames(vocab) {
  const names = [
    'same_owner', 'same_org', 'same_domain', 'same_family', 'same_facet', 'same_topic',
  ];
  for (const family of vocab.families) names.push(`family_l=${family}`);
  for (const family of vocab.families) names.push(`family_r=${family}`);
  for (const facet of vocab.facets) names.push(`facet_l=${facet}`);
  for (const facet of vocab.facets) names.push(`facet_r=${facet}`);
  names.push(
    'dep_ratio_lr', 'dep_ratio_rl',
    'dep_hit_lr', 'dep_hit_rl',
    'produces_l', 'consumes_l', 'produces_r', 'consumes_r',
  );
  for (const field of SET_FIELDS) {
    names.push(`jaccard_${field}`, `contain_lr_${field}`, `contain_rl_${field}`);
  }
  if (names.length !== featureDimension(vocab)) {
    // 名字与维度对不上时应当在构建矩阵的那一刻就炸，而不是等训练完才发现列错位。
    throw new Error(`cpdb_feature_name_dimension_mismatch:${names.length}`); // c8 ignore
  }
  return names;
}

/**
 * 单个 pair 的特征。
 *
 * 用**定长数组按固定下标写入**，不用 push：下标错了会静默错列，而 `featureNames`
 * 的长度断言只能查到总数，查不到顺序。写成显式下标，顺序就是可读的。
 */
export function pairFeatures(leftView, rightView, vocab) {
  const left = normalizeAgentView(leftView);
  const right = normalizeAgentView(rightView);
  const vector = new Float64Array(featureDimension(vocab));
  let at = 0;

  vector[at++] = same(left.ownerUserId, right.ownerUserId);
  vector[at++] = same(left.orgId, right.orgId);
  vector[at++] = same(left.domain, right.domain);
  vector[at++] = same(left.familyId, right.familyId);
  vector[at++] = same(facetKey(left), facetKey(right));
  vector[at++] = same(left.topic, right.topic);

  at = oneHot(vector, at, vocab.families, left.familyId);
  at = oneHot(vector, at, vocab.families, right.familyId);
  at = oneHot(vector, at, vocab.facets, facetKey(left));
  at = oneHot(vector, at, vocab.facets, facetKey(right));

  // 产出流向是**有向**的：`left` 的产出喂给 `right` 的输入，和反过来，是两件事。
  // `teacherDependency` 只用了 L→R 那一侧，但 R→L 留着能让模型学出方向感，
  // 也让「同一对换个方向」不再是同一个样本。
  const hitLr = intersectCount(left.produces, right.consumes);
  const hitRl = intersectCount(right.produces, left.consumes);
  vector[at++] = hitLr / Math.max(1, right.consumes.length);
  vector[at++] = hitRl / Math.max(1, left.consumes.length);
  vector[at++] = hitLr;
  vector[at++] = hitRl;
  vector[at++] = left.produces.length;
  vector[at++] = left.consumes.length;
  vector[at++] = right.produces.length;
  vector[at++] = right.consumes.length;

  for (const field of SET_FIELDS) {
    vector[at++] = jaccard(left[field], right[field]);
    vector[at++] = containment(left[field], right[field]);
    vector[at++] = containment(right[field], left[field]);
  }

  if (at !== vector.length) throw new Error(`cpdb_feature_layout_mismatch:${at}/${vector.length}`); // c8 ignore
  return Array.from(vector);
}

/** 成对特征的对外入口：`pairs.jsonl` 的一行 + agentId→视图 的表。 */
export function pairFeaturesFromPair(pair, viewById, vocab) {
  const left = viewById.get(pair.leftAgentId);
  const right = viewById.get(pair.rightAgentId);
  if (!left || !right) throw new Error(`cpdb_pair_agent_missing:${pair.id}`);
  return pairFeatures(left, right, vocab);
}

function oneHot(vector, at, values, value) {
  const index = values.indexOf(value);
  if (index >= 0) vector[at + index] = 1;
  return at + values.length;
}

function same(left, right) {
  return left && right && left === right ? 1 : 0;
}

function intersectCount(left = [], right = []) {
  const other = new Set(right);
  return left.filter((item) => other.has(item)).length;
}

function jaccard(left = [], right = []) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 0;
  const inter = [...a].filter((item) => b.has(item)).length;
  return inter / (a.size + b.size - inter);
}

function containment(haystack = [], needles = []) {
  const set = new Set(haystack);
  if (!needles.length) return 0;
  return needles.filter((item) => set.has(item)).length / needles.length;
}

function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function text(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
