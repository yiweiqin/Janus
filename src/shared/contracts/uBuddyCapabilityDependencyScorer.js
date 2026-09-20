// 训练好的 CPDB 打分器在 JS 侧的**加载与前向传播**（唯一一份实现）+ 接进契约的适配层。
//
// ## 这条链路里有什么
//
// 产物有两种形态，接口一致，靠 `kind` 区分：
//
//   kind='model'  画像对 ──(uBuddyCapabilityPairFeatures)──> 定长特征 ──MLP──> 两个 5 档分布
//                 （`weights.json`，见 `run_fit_all`）
//   kind='table'  画像对 ──"familyL>familyR"──> 36 格查表 ──> 两个 5 档分布
//                 （`table.json`，见 `run_fit_table`）
//
// 两条路都汇到同样的输出：`{probability, argmax, expected}`，再被下面的适配层
// 接回 `uBuddyCapabilityDependencyBundle.js` 的那几个入口。
//
// **当前交付的是表**，理由不是偏好，而是诊断轮的实测结果（`--diagnose` 那一节 +
// `docs/ubuddy-v4-cpdb-scorer-diagnosis.zh-CN.md`）：在同一批折、同一批标签上，
// 36 格 family 表在"换一个没见过的角色"（`facet` 折）上拿到相似度 0.7816，
// 而 MLP 是 0.7669（92 列）/ 0.7477（32 列）。换一个没见过的粗粒度职能（`family` 折）时，
// MLP 的相似度 0.5544 甚至低于全局众数 0.5899。
//
// 那个结果的读法不是"模型没调好"，而是：**这批标签本身几乎就是 (familyL, familyR) 的函数。**
// 规则 teacher 和 AI 判分都主要对两侧的粗粒度职能起反应。标签里没有的分辨率，
// 参数再多也变不出来。所以这里的取舍是"在标签分辨率给定的前提下选更准更省的那个"。
//
// ## 为什么前向必须在 JS 里再实现一遍（而不是只留 Python）
//
//   1. 调用方是规划路径（`selectCollaborators` / `selectReplacement` 一侧），跑在
//      Node/Electron 里。为了两个分数去起一个 Python 进程，是把部署复杂度换成了
//      「反正没人会在线上调它」。
//   2. 更重要的是**可验证**：训练在 Python，服务在 JS。两份实现之间任何一点不一致
//      （特征顺序、标准化、GELU 变体、矩阵转置）都会让分数悄悄变形。所以这里不做
//      「应该一样」，而是拿训练脚本落下的 `predictions.jsonl` 做逐条对齐
//      （`experiments/cpdb_org_world/scorer.test.mjs`）：argmax 必须 100% 相同，
//      连续分必须有界地接近。
//
// 数值口径：全程 **float32**（`Math.fround`）。torch 的 Linear 是 float32 的，
// 如果 JS 这边用 float64 累加，结果会比 torch 更准 —— 但「更准」在这里是坏事，
// 它会让两边对不上，而对不上的原因会看起来像权重加载错了。
//
// ## 特征变体：为什么权重里要带列掩码
//
// 诊断轮发现 `facet_onehot` 是 facet 的**恒等编码**：留出某个 facet 时那些列训练全程
// 为 0。于是 `full`（92 列）在"换一个没见过的新角色"这个场景下**按构造不可能泛化**。
// 换成 `no_identity`（32 列，去掉 family/facet 恒等列）才有得比。
//
// 所以权重文件里带上 `variant` 与 `columns`，打分时先按它裁列。没有这两个字段的旧权重
// （v1/v2）按 `full` 处理 —— 兼容不是宽容，而是因为那两份权重确实是用全部 92 列训的。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CPDB_FEATURE_SPEC_VERSION,
  normalizeAgentView,
  pairFeatures,
} from './uBuddyCapabilityPairFeatures.js';
import {
  CPDB_SCORE_MAX,
  CPDB_SCORE_MIN,
  dependencyScore as ruleDependencyScore,
  normalizeCapabilityProfileLite,
  selectCollaborators as ruleSelectCollaborators,
  selectReplacement as ruleSelectReplacement,
  similarityScore as ruleSimilarityScore,
} from './uBuddyCapabilityDependencyBundle.js';

export const CPDB_SCORER_WEIGHTS_SCHEMA = 'cpdb_scorer_weights/v1';
export const CPDB_SCORER_TABLE_SCHEMA = 'cpdb_scorer_table/v1';
export const CPDB_SCORER_MISSING = 'cpdb_scorer_unavailable';

/** 交付产物放在哪：环境变量指向目录，而不是打包进 `src/`。
 *
 * 为什么不做成"把权重塞进源码"：这份产物是**会换的**（换标签、换折、换关键粒度都要重出），
 * 而源码里的常量一换就是一次代码改动、一次 review。放在外面，`src/` 只承诺**接口与口径**，
 * 产物承诺**数值**。两者的变更节奏不一样，混在一起会让"改一个数"看起来像"改了一处逻辑"。
 */
export const CPDB_SCORER_DIR_ENV = 'JANUS_CPDB_SCORER_DIR';

/**
 * 从环境里解析打分器。返回**判别式结果**而不是抛异常，也不返回裸的 `scorer | null`。
 *
 * 为什么不让它抛：调用方是规划路径。产物缺失或损坏时，正确行为是"用回手写规则继续规划"，
 * 而不是让整个规划挂掉。但"不抛"和"不报"是两件事 —— 所以这里把原因放在 `source` 与 `error` 里，
 * 让调用方能记下来。返回裸 `null` 就会把"没配"、"路径不存在"、"文件坏了"三种情况
 * 压成同一件事，而它们要的处理完全不同。
 */
export function resolveScorerFromEnvironment({ env = process.env, defaultDir = null } = {}) {
  const dir = env?.[CPDB_SCORER_DIR_ENV] || defaultDir || null;
  if (!dir) return { scorer: null, source: 'unset', dir: null, error: null };
  if (!existsSync(dir)) return { scorer: null, source: 'missing', dir, error: null };
  try {
    return { scorer: loadCapabilityScorer(dir), source: 'loaded', dir, error: null };
  } catch (error) {
    return { scorer: null, source: 'invalid', dir, error };
  }
}

/** 交付产物的加载入口：`table.json` 优先，其次 `weights.json`。
 *
 * 为什么表优先：诊断轮把两者放在同一批折、同一批标签上比过，表赢了（见
 * `run_fit_table` 的注释与 `docs/ubuddy-v4-cpdb-scorer-diagnosis.zh-CN.md`）。
 * 这里的优先级不是"表更时髦"，而是"在当前标签分辨率下，表是更准且更省的那一个"。
 */
export function loadCapabilityScorer(artifactDir) {
  const tablePath = join(artifactDir, 'table.json');
  if (existsSync(tablePath)) return loadTableScorer(artifactDir);
  const weightsPath = join(artifactDir, 'weights.json');
  if (existsSync(weightsPath)) return loadScorer(artifactDir);
  throw new Error(`${CPDB_SCORER_MISSING}:${artifactDir}`);
}

export function loadTableScorer(artifactDir) {
  const table = JSON.parse(readFileSync(join(artifactDir, 'table.json'), 'utf8'));
  return buildTableScorer(table);
}

export function buildTableScorer(table) {
  if (table.schema !== CPDB_SCORER_TABLE_SCHEMA) {
    throw new Error(`cpdb_scorer_table_schema_unknown:${table.schema}`);
  }
  // 键的拼法是判据的一部分：`lib/splits.mjs` 的折是按**集合**留出的，而查表键是**有向**的。
  // 两者混用会得到一个"看起来能跑"的错分数，所以这里把键格式写死在产物里并对账。
  if (table.keyKind !== 'family_pair') {
    throw new Error(`cpdb_scorer_table_key_kind:${table.keyKind}`);
  }
  if (!Array.isArray(table.scale) || !table.scale.length) {
    throw new Error('cpdb_scorer_table_scale_missing');
  }
  for (const [key, cell] of Object.entries(table.cells || {})) {
    for (const axis of ['dependency', 'similarity']) {
      const probabilities = cell?.[axis];
      if (!Array.isArray(probabilities) || probabilities.length !== table.scale.length) {
        throw new Error(`cpdb_scorer_table_cell_width:${key}:${axis}`);
      }
    }
  }
  for (const axis of ['dependency', 'similarity']) {
    if (table.prior?.[axis]?.length !== table.scale.length) {
      throw new Error(`cpdb_scorer_table_prior_width:${axis}`);
    }
  }
  return {
    kind: 'table',
    featureSpec: table.featureSpec,
    variant: `table:${table.keyKind}`,
    keyKind: table.keyKind,
    scale: table.scale,
    cells: table.cells || {},
    prior: table.prior,
    unseenFallback: table.unseenFallback || 'prior',
    foldMetrics: table.foldMetrics || null,
    provenance: table.provenance || null,
    note: table.note || '',
  };
}

export function loadScorer(artifactDir) {
  const weights = JSON.parse(readFileSync(join(artifactDir, 'weights.json'), 'utf8'));
  return buildScorer(weights);
}

export function buildScorer(weights) {
  if (weights.schema !== CPDB_SCORER_WEIGHTS_SCHEMA) {
    throw new Error(`cpdb_scorer_weights_schema_unknown:${weights.schema}`);
  }
  // 特征码不对就等于「权重是用另一套输入训的」。这个错必须在这里断，
  // 因为往下走是完全合法的矩阵乘法 —— 静默错分，谁都不会发现。
  if (weights.featureSpec !== CPDB_FEATURE_SPEC_VERSION) {
    throw new Error(`cpdb_scorer_feature_spec_mismatch:${weights.featureSpec}!=${CPDB_FEATURE_SPEC_VERSION}`);
  }
  if (weights.featureNames?.length !== weights.dimension) {
    throw new Error(`cpdb_scorer_feature_names_length:${weights.featureNames?.length}!=${weights.dimension}`);
  }
  // 变体裁剪：`columns` 是相对**全量特征**的下标。缺省（旧的 full 权重）就是全部列。
  const columns = Array.isArray(weights.columns) && weights.columns.length
    ? weights.columns.map(Number)
    : weights.featureNames.map((_, at) => at);
  for (const at of columns) {
    if (!Number.isInteger(at) || at < 0 || at >= weights.dimension) {
      throw new Error(`cpdb_scorer_column_out_of_range:${at}/${weights.dimension}`);
    }
  }
  if (weights.standardizer?.mean?.length !== columns.length) {
    throw new Error(
      `cpdb_scorer_standardizer_width:${weights.standardizer?.mean?.length}!=${columns.length}`,
    );
  }

  const stateDict = weights.stateDict || {};
  const read = (key, size) => {
    const flat = stateDict[key];
    if (!Array.isArray(flat) || flat.length !== size) {
      throw new Error(`cpdb_scorer_tensor_shape:${key}:${flat?.length}!=${size}`);
    }
    return Float32Array.from(flat);
  };

  const layers = (weights.layers || []).map((layer) => ({
    in: layer.in,
    out: layer.out,
    weight: read(layer.weightKey, layer.in * layer.out),
    bias: read(layer.biasKey, layer.out),
  }));
  if (layers.length && layers[0].in !== columns.length) {
    throw new Error(`cpdb_scorer_first_layer_width:${layers[0].in}!=${columns.length}`);
  }
  const heads = {};
  for (const [axis, head] of Object.entries(weights.headLayers || {})) {
    heads[axis] = { out: head.out, weight: read(head.weightKey, head.in * head.out), bias: read(head.biasKey, head.out) };
  }
  for (const axis of ['dependency', 'similarity']) {
    if (!heads[axis]) throw new Error(`cpdb_scorer_head_missing:${axis}`);
  }

  return {
    kind: 'model',
    featureSpec: weights.featureSpec,
    variant: weights.variant || 'full',
    dimension: weights.dimension,
    columns,
    width: columns.length,
    vocab: weights.vocab,
    scale: weights.scale,
    mean: Float32Array.from(weights.standardizer.mean),
    std: Float32Array.from(weights.standardizer.std),
    layers,
    heads,
    note: weights.note || '',
    provenance: weights.provenance || null,
  };
}

/** 从一个 `(左, 右)` 画像对出发：模型走特征+前向，表走 family 对键。 */
export function scorePair(scorer, leftProfile, rightProfile) {
  if (scorer?.kind === 'table') {
    const left = normalizeAgentView(leftProfile);
    const right = normalizeAgentView(rightProfile);
    const key = `${left.familyId}>${right.familyId}`;
    // 没见过的格子回落到 `prior`（全局分布）。**不回落给手写规则**，因为那会让
    // 同一个排序里混进两个不同的分数函数 —— 一半来自表、一半来自规则，
    // 名次就没法解释了。代价是未知家族的 pair 之间会并列（都等于 prior），
    // 这个代价已经量过：`family` 折上表 = 众数 = 0.5899。
    const cell = scorer.cells[key];
    const result = {};
    for (const axis of ['dependency', 'similarity']) {
      result[axis] = describeProbabilities(cell?.[axis] || scorer.prior[axis], scorer.scale);
      result[axis].key = key;
      result[axis].hit = Boolean(cell);
    }
    return result;
  }
  const feature = pairFeatures(normalizeAgentView(leftProfile), normalizeAgentView(rightProfile), scorer.vocab);
  return scoreFeature(scorer, feature);
}

/** 特征已知时的入口（训练矩阵对账、批量打分用，省掉重复的特征计算）。**只对模型打分器有效。** */
export function scoreFeature(scorer, feature) {
  if (scorer?.kind === 'table') {
    throw new Error('cpdb_scorer_table_has_no_features:表打分器按 family 对取格，不消费特征向量');
  }
  if (feature.length !== scorer.dimension) {
    throw new Error(`cpdb_scorer_feature_dimension:${feature.length}!=${scorer.dimension}`);
  }
  // 先裁列再标准化：标准化参数是按**裁剪后**的列训出来的，顺序反过来会把
  // `mean/std` 对到别的列上，而结果依然是一个合法向量 —— 静默错分。
  const width = scorer.columns.length;
  let activations = new Float32Array(width);
  for (let at = 0; at < width; at += 1) {
    const value = feature[scorer.columns[at]];
    // 标准化用 float32 做：训练侧的 numpy 也是 float32，两边同样的舍入才会得到同样的输入。
    activations[at] = f32((f32(value) - scorer.mean[at]) / scorer.std[at]);
  }

  for (const layer of scorer.layers) {
    if (layer.in !== activations.length) {
      throw new Error(`cpdb_scorer_layer_width:${layer.in}!=${activations.length}`);
    }
    const next = new Float32Array(layer.out);
    for (let out = 0; out < layer.out; out += 1) {
      let sum = 0;
      const base = out * layer.in;
      for (let at = 0; at < layer.in; at += 1) sum = f32(sum + f32(layer.weight[base + at] * activations[at]));
      next[out] = gelu(f32(sum + layer.bias[out]));
    }
    activations = next;
  }

  const result = {};
  for (const [axis, head] of Object.entries(scorer.heads)) {
    if (head.weight.length !== head.out * activations.length) {
      throw new Error(`cpdb_scorer_head_width:${axis}:${head.weight.length}!=${head.out * activations.length}`);
    }
    const logits = new Float32Array(head.out);
    for (let out = 0; out < head.out; out += 1) {
      let sum = 0;
      const base = out * activations.length;
      for (let at = 0; at < activations.length; at += 1) sum = f32(sum + f32(head.weight[base + at] * activations[at]));
      logits[out] = f32(sum + head.bias[out]);
    }
    result[axis] = describe(logits, scorer.scale);
  }
  return result;
}

// --------------------------------------------------------------------------------------
// 接进契约
// --------------------------------------------------------------------------------------
//
// 下面四个函数是**契约那四个入口的模型版**，形状完全一致，可以直接替换：
//
//   dependencyScore      -> scoredDependencyScore
//   similarityScore      -> scoredSimilarityScore
//   selectCollaborators  -> scoredSelectCollaborators
//   selectReplacement    -> scoredSelectReplacement
//
// 约定：`scorer` 为 null/undefined 时**自动回落到契约的手写实现**。
//
// 这一条比看上去重要：模型是"更准但更重、且需要权重文件在位"的东西，
// 而规划路径是**核心路径**。让"模型文件没打包进去"表现为"选人全返回 0"
// （分数全 0 会让排序退化成按 agentId 字典序），是把一个可发现的失败
// 换成了一个不可发现的失败。所以缺模型时用手写规则，并把这件事**记下来**
// （`describeScorerFallback`），而不是安静地给一个数。

export function scoredDependencyScore(scorer, sourceProfile, targetProfile) {
  if (!usable(scorer)) return ruleDependencyScore(sourceProfile, targetProfile);
  const source = normalizeCapabilityProfileLite(sourceProfile);
  const target = normalizeCapabilityProfileLite(targetProfile);
  // 同一个人/同一个 agent 一律 0：契约的这一条是语义约束（自依赖无意义），
  // 不该让模型去学，也不该让模型有机会学反。
  if (!source.agentId || !target.agentId || source.agentId === target.agentId) return 0;
  return clampScore(scorePair(scorer, sourceProfile, targetProfile).dependency.expected);
}

export function scoredSimilarityScore(scorer, leftProfile, rightProfile) {
  if (!usable(scorer)) return ruleSimilarityScore(leftProfile, rightProfile);
  const left = normalizeCapabilityProfileLite(leftProfile);
  const right = normalizeCapabilityProfileLite(rightProfile);
  if (!left.agentId || !right.agentId || left.agentId === right.agentId) return 0;
  return clampScore(scorePair(scorer, leftProfile, rightProfile).similarity.expected);
}

export function scoredSelectCollaborators(scorer, candidates = [], sinkProfile = {}, options = {}) {
  if (!usable(scorer)) return ruleSelectCollaborators(candidates, sinkProfile, options);
  return rankBy(
    candidates,
    (profile) => scoredDependencyScore(scorer, profile, sinkProfile),
    sinkProfile,
    options,
  );
}

export function scoredSelectReplacement(scorer, failedProfile = {}, candidates = {}, options = {}) {
  if (!usable(scorer)) return ruleSelectReplacement(failedProfile, candidates, options);
  const failed = normalizeCapabilityProfileLite(failedProfile);
  const list = Array.isArray(candidates) ? candidates : [];
  return rankBy(
    list.filter((profile) => normalizeCapabilityProfileLite(profile).agentId !== failed.agentId),
    (profile) => scoredSimilarityScore(scorer, failedProfile, profile),
    failedProfile,
    options,
  );
}

/**
 * 打分器是否可用。判据是「能算」，不是「truthy」——
 * 一个只加载了一半的 scorer（比如 `heads` 缺一个轴）不该在 `if (scorer)` 处通过。
 */
export function usable(scorer) {
  if (!scorer) return false;
  if (scorer.kind === 'table') {
    return Boolean(scorer.cells && scorer.prior?.dependency?.length && scorer.prior?.similarity?.length);
  }
  return Boolean(scorer.heads?.dependency && scorer.heads?.similarity && scorer.columns?.length);
}

/** 给调用方/诊断用：此刻走的是表、模型，还是手写规则。 */
export function describeScorerFallback(scorer) {
  if (usable(scorer)) {
    return {
      mode: scorer.kind === 'table' ? 'table' : 'model',
      variant: scorer.variant,
      width: scorer.kind === 'table' ? Object.keys(scorer.cells).length : scorer.width,
      provenance: scorer.provenance,
      note: scorer.kind === 'table'
        ? '分数来自学习到的 (familyL, familyR) 查表，格里的值是从标签学来的分布。'
        : '分数来自训练好的打分器。',
    };
  }
  return {
    mode: 'rule',
    variant: null,
    width: null,
    provenance: null,
    note: '权重不可用，已回落到 `uBuddyCapabilityDependencyBundle` 的手写打分。'
      + '这条回落是**安全**的（有分数可用）但**不是零成本**的：手写分与学到的分不是同一个函数，'
      + '指标与线上行为会同时变。需要知道到底走了哪条时读这个函数。',
  };
}

export function describe(logits, scale) {
  return describeProbabilities(softmax(logits), scale);
}

/** 概率已知时直接聚合：表那条路径给的就是分布，不需要再过一次 softmax。 */
export function describeProbabilities(probabilities, scale) {
  let expected = 0;
  let argmax = 0;
  for (let at = 0; at < probabilities.length; at += 1) {
    expected = f32(expected + f32(probabilities[at] * scale[at]));
    if (probabilities[at] > probabilities[argmax]) argmax = at;
  }
  return {
    probability: Array.from(probabilities),
    argmax: scale[argmax],
    expected: expected,
  };
}

function rankBy(candidates, scoreFn, selfProfile, options) {
  const limit = Math.max(1, Number(options.limit) || 3);
  return (Array.isArray(candidates) ? candidates : [])
    .map((profile) => ({ profile: normalizeCapabilityProfileLite(profile), score: scoreFn(profile) }))
    .filter((item) => item.profile.agentId)
    .sort((a, b) => b.score - a.score || a.profile.agentId.localeCompare(b.profile.agentId))
    .slice(0, limit);
}

function softmax(logits) {
  let max = -Infinity;
  for (const value of logits) max = Math.max(max, value);
  const out = new Float32Array(logits.length);
  let sum = 0;
  for (let at = 0; at < logits.length; at += 1) {
    out[at] = Math.exp(logits[at] - max);
    sum += out[at];
  }
  for (let at = 0; at < out.length; at += 1) out[at] = f32(out[at] / sum);
  return out;
}

function gelu(x) {
  // torch 的 `nn.GELU()` 默认是 erf 精确版（不是 tanh 近似版）。
  // 用 tanh 近似的话分数会差到 1e-3 量级，于是对账测试要么假失败、要么被调宽到失去意义。
  return f32(0.5 * x * (1 + erf(x * Math.SQRT1_2)));
}

/** Abramowitz–Stegun 7.1.26，最大误差 ~1.5e-7，远小于我们对账用到的 1e-3。 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * value);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-value * value));
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(CPDB_SCORE_MAX, Math.max(CPDB_SCORE_MIN, number));
}

function f32(value) {
  return Math.fround(value);
}
