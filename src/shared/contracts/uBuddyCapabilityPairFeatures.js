// 能力画像依赖集束（CPDB）打分器的**输入特征**。这是**唯一一份**实现。
//
// 这里只做一件事：把一个 `(左, 右)` Agent 对映射成一个定长实数向量。之所以把它单独抽出来
// 当成一个纯函数、并且和训练脚本分开写，是因为**训练与推理必须看到完全相同的特征**：
// 只要两侧各写一份特征代码，就一定会漂移，而漂移的症状是「线上分数和离线指标对不上」，
// 排查起来极费时间。所以判据不是「两边算得都对」，而是「两边算的是同一段代码」。
//
// ## 为什么这个文件在 `src/shared/contracts/` 而不是在 experiments 里
//
// 特征、权重加载与前向传播本来长在 `experiments/cpdb_org_world/` 下，因为它们是训练
// 生产出来的。但**调用方是应用的规划路径**（`selectCollaborators` / `selectReplacement`
// 一侧，跑在 Electron 主进程里），而 `experiments/` 不进安装包。让应用去 import
// 一个不在包里的目录，是「本地能跑、打包就崩」那类问题。
//
// 所以这一层搬到了契约旁边，训练侧改为 re-export 本文件
// （`experiments/cpdb_org_world/lib/features.mjs` 只剩一行 `export *`）。
// 搬家而没有复制：两份实现迟早分叉，而分叉的症状是线上分数与离线指标对不上，最难查的一类。
//
// 训练矩阵由本文件产出（`export_training_matrix.mjs`），线上推理也由本文件产出
// （`uBuddyCapabilityDependencyScorer.js`）。
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
// 所以入参只有画像本身。`experiments/cpdb_org_world/features.test.mjs` 里有一条泄漏闸，
// 专门喂进带答案的行、断言特征值不随答案变化 —— 光靠「我注意力集中」是靠不住的。
//
// ## 为什么特征里还有 orgId / domain
//
// `teacherDependency`（`experiments/cpdb_org_world/lib/pairs.mjs`）里
// `sameDomain` 加 0.08、`sameOrg` 加 0.04。
// 这两个信号在服务期是**可得**的：Agent 记录本来就带 `orgId` / `domain`，
// 而它们不是身份（600 个 Agent 只有 12 个 org、若干个 domain），不构成记忆。
//
// 注意：把它们放进来**不等于**"模型学到的是能力语义而不是组织记忆"。第一版报告
// 曾用「datasets 按 orgId 切分」当作泛化证据，那是错的 —— 按 org 切只挡住了组织，
// 挡不住角色：那个 test 里 99.0% 的 pair 落在训练见过的 `(facetL, facetR)` 格子上。
// 真正的泛化口径见 `experiments/cpdb_org_world/lib/splits.mjs` 的四种折。

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
 * 特征变体：同一份 `pairFeatures` 输出，取不同的列子集。
 *
 * 加这一层是因为留出 facet 的折对 `full` 特征**按构造就不可能泛化**：
 * `facet_onehot` 是 facet 的恒等编码，没见过的 facet 在那一侧全是 0，
 * 网络在训练里从没被训过那些列。于是「留出 facet 后指标掉了」这件事，
 * 既可能是「模型只在记角色」，也可能是「特征里根本没给可迁移的东西」——
 * 光看 `full` 分不开这两种解释。
 *
 * `no_identity` 去掉全部角色恒等列，只留
 *   6 个相对标志 + 8 个产物流向 + 18 个集合相似度 = 32 列。
 * 它回答的正是 V4 方案二的原始命题：**光靠能力描述本身，有没有可迁移的信号**。
 */
export const CPDB_FEATURE_VARIANTS = {
  full: { columns: null, note: '全部特征（92 列）' },
  no_identity: {
    // 去掉的是「这个角色叫什么」，留下的是「这两方能不能对接上」。
    drop: (name) => name.startsWith('family_l=') || name.startsWith('family_r=')
      || name.startsWith('facet_l=') || name.startsWith('facet_r='),
    note: '去掉 family/facet 恒等列，只留 flags + flow + set_similarity（32 列）',
  },
  content_only: {
    // 再砍掉那 6 个 `same_*` 标志。它们虽然不是"角色名"，但 `same_facet` / `same_family`
    // 是**角色名的等价布尔压缩**（"两边是同一个 facet 吗"），完全可能独自承担全部信号。
    // 留出 facet 的折里这个标志仍然是可算的，所以它不像 one-hot 那样必然失效 ——
    // 正因为如此，"到底是内容在起作用还是这个标志在起作用"只能用一列来分开。
    drop: (name) => name.startsWith('family_l=') || name.startsWith('family_r=')
      || name.startsWith('facet_l=') || name.startsWith('facet_r=')
      || name.startsWith('same_'),
    note: '只留 flow + set_similarity（26 列）：既无角色恒等列，也无 same_* 标志',
  },
};

export const CPDB_FEATURE_VARIANT_NAMES = Object.keys(CPDB_FEATURE_VARIANTS);

/**
 * 某个变体保留的列下标（升序）。`full` 返回全部下标。
 *
 * 训练侧与推理侧都从这一个函数拿列，避免「训练用了一套列、推理用了另一套」
 * 这种只能靠指标异常才发现的问题。
 */
export function featureVariantColumns(vocab, variant = 'full') {
  const spec = CPDB_FEATURE_VARIANTS[variant];
  if (!spec) throw new Error(`cpdb_feature_variant_unknown:${variant}`);
  const names = featureNames(vocab);
  const columns = [];
  names.forEach((name, at) => {
    if (spec.drop && spec.drop(name)) return;
    columns.push(at);
  });
  if (!columns.length) throw new Error(`cpdb_feature_variant_empty:${variant}`); // c8 ignore
  return columns;
}

/** 按变体裁列。`columns` 由 `featureVariantColumns` 给出。 */
export function selectFeatureColumns(feature, columns) {
  return columns.map((at) => feature[at]);
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
