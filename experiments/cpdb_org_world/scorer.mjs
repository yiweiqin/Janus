// 训练好的 CPDB 打分器在 **JS 侧的前向**：加载权重、算 pair 的两个分。
//
// 为什么要有这一份，而不是只留 Python：
//
//   1. 打分器的调用方是规划路径（`selectCollaborators` / `selectReplacement` 那一侧），
//      跑在 Node/Electron 里。为了两个分数去起一个 Python 进程，是把部署复杂度
//      换成了「反正没人会在线上调它」。
//   2. 更重要的是**可验证**：训练在 Python，服务在 JS。两份实现之间任何一点不一致
//      （特征顺序、标准化、GELU 变体、矩阵转置）都会让分数悄悄变形。所以这里不做
//      「应该一样」，而是拿训练脚本落下的 `predictions.jsonl` 做逐条对齐
//      （`scorer.test.mjs`）：argmax 必须 100% 相同，连续分必须有界地接近。
//
// 数值口径：全程 **float32**（`Math.fround`）。torch 的 Linear 是 float32 的，
// 如果 JS 这边用 float64 累加，结果会比 torch 更准 —— 但「更准」在这里是坏事，
// 它会让两边对不上，而对不上的原因会看起来像权重加载错了。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CPDB_FEATURE_SPEC_VERSION, normalizeAgentView, pairFeatures } from './lib/features.mjs';

export const CPDB_SCORER_WEIGHTS_SCHEMA = 'cpdb_scorer_weights/v1';

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
  const heads = {};
  for (const [axis, head] of Object.entries(weights.headLayers || {})) {
    heads[axis] = { out: head.out, weight: read(head.weightKey, head.in * head.out), bias: read(head.biasKey, head.out) };
  }
  for (const axis of ['dependency', 'similarity']) {
    if (!heads[axis]) throw new Error(`cpdb_scorer_head_missing:${axis}`);
  }

  return {
    featureSpec: weights.featureSpec,
    dimension: weights.dimension,
    vocab: weights.vocab,
    scale: weights.scale,
    mean: Float32Array.from(weights.standardizer.mean),
    std: Float32Array.from(weights.standardizer.std),
    layers,
    heads,
    note: weights.note || '',
  };
}

/** 从一个 `(左, 右)` 画像对出发：先算特征，再走网络，最后给两个独立的分。 */
export function scorePair(scorer, leftProfile, rightProfile) {
  const feature = pairFeatures(normalizeAgentView(leftProfile), normalizeAgentView(rightProfile), scorer.vocab);
  return scoreFeature(scorer, feature);
}

/** 特征已知时的入口（训练矩阵对账、批量打分用，省掉重复的特征计算）。 */
export function scoreFeature(scorer, feature) {
  if (feature.length !== scorer.dimension) {
    throw new Error(`cpdb_scorer_feature_dimension:${feature.length}!=${scorer.dimension}`);
  }
  let activations = new Float32Array(scorer.dimension);
  for (let at = 0; at < scorer.dimension; at += 1) {
    // 标准化用 float32 做：训练侧的 numpy 也是 float32，两边同样的舍入才会得到同样的输入。
    activations[at] = f32((f32(feature[at]) - scorer.mean[at]) / scorer.std[at]);
  }

  for (const layer of scorer.layers) {
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

function describe(logits, scale) {
  const probabilities = softmax(logits);
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

function f32(value) {
  return Math.fround(value);
}
