// CPDB 打分器的**评估折（fold）**定义。
//
// ## 为什么需要这个文件
//
// 第一轮训练用的是 `generate.mjs` 里按 orgId 切的 train/development/test。那个切法**看着像**
// 泛化测试，实际上什么也没测：8282 个 pair 里 test 有 791/799（99.0%）落在训练时**已经见过**
// 的 `(leftFacet, rightFacet)` 格子上，test 涉及的 240 个 agent 有 190 个（79.2%）也在训练集里
// 出现过。于是「87% 同档」这个数字里，绝大部分是「同一个角色换个组织，你还认得吗」。
//
// 最直白的一次对账：拿 533 格的 facet 对众数查表套到 test 上，依赖 86.0% / 相似 85.9%，
// 而 92 维 MLP 是 87.0% / 85.7% —— 相似度那一轴查表还更高。**没有一个划分能证伪这件事，
// 所以当时它没被发现。** 这个文件的职责就是把「留出什么」变成一件能被断言的事。
//
// ## 硬约束：不动已经发出去的判分包
//
// `export/ai-judge-v1/` 已经发给外部标注者（`cpdb-ai-judge-v1.zip`）。所以这里**不重新生成
// 世界、不改 `pairs.jsonl` / `cards/`**。所有折都从现有 `pairs.jsonl` 的字段算出来，
// 与生成过程解耦 —— 好处是"当年那个包"永远可复现，标注者手里那份始终有效。
//
// ## 统一抽象：一个 pair「触及」哪些组
//
// 四种方案都是同一件事的特例：把**组**分成 k 份，第 i 折留出第 i 份里的组，
// 于是
//
//   eval_i  = 触及第 i 份中任意组的 pair
//   train_i = **不**触及第 i 份中任意组的 pair = eval_i 的补集
//
// 组键的定义按方案不同：
//
//   - `org`        触及的 org（最多 2 个）—— 与第一轮的切法同性质，留作对照
//   - `facet_pair` 单个 `facetL>facetR` 格子（**每个 pair 恰好一个**，所以这是严格划分）
//   - `facet`      左右两侧的 facet（最多 2 个）—— 「换一个没见过的新角色」
//   - `family`     左右两侧的 family（最多 2 个）—— 「换一个粗粒度职能」
//
// 多键方案下 eval 折之间会重叠（一个 pair 同时触及两个被留出的组），这是刻意的：
// **关键在于 `train_i` 严格避开第 i 折留出的组**，而不是 eval 折之间互斥。
// 每条折各自是一个自足的实验，指标按折报告再取平均。
//
// ## 唯一被断言的不变式
//
// 「第 i 折留出的组，在 `train_i` 里一个都不出现」。`splits.test.mjs` 对四个方案逐折断言它。
// 第一轮之所以漏掉 99% 的角色泄漏，正是因为**没有任何一条测试断言过不相交** ——
// 切法看着合理，就没人去量。

export const CPDB_FOLD_SCHEME_VERSION = 'cpdb_folds_v1';

/**
 * 每个方案的折数。
 *
 * `family` 只有 6 个组，k=5 会让某一折只有 1 个 family、其余折的组数不均，
 * 折间规模差得太多；k=3 时每折恰好 2 个 family，比较干净。
 * 其余方案组数足够（org 12 / facet 24 / facet_pair 533），统一用 5 折。
 */
export const FOLD_SCHEMES = {
  org: { k: 5 },
  facet_pair: { k: 5 },
  facet: { k: 5 },
  family: { k: 3 },
};

export const FOLD_SCHEME_NAMES = Object.keys(FOLD_SCHEMES);

/**
 * 一个 pair 触及的组键。返回**去重后排序**的数组，保证同一批输入永远得到同一批键。
 */
export function groupKeysOf(pair = {}, scheme) {
  if (scheme === 'org') {
    // `pairs.jsonl` 把 org 存成一个字段：同组织时是 `orgId`，跨组织时是 `left|right`。
    // 直接 split 就能拿到「触及的 org」，不必回表 join agents.jsonl。
    return uniqueSorted(String(pair.orgId || '').split('|'));
  }
  if (scheme === 'facet_pair') {
    const cell = `${pair.leftFacet || '?'}>${pair.rightFacet || '?'}`;
    return [cell];
  }
  if (scheme === 'facet') {
    return uniqueSorted([pair.leftFacet, pair.rightFacet]);
  }
  if (scheme === 'family') {
    return uniqueSorted([pair.leftFamily, pair.rightFamily]);
  }
  throw new Error(`cpdb_fold_scheme_unknown:${scheme}`);
}

/**
 * 建折。返回 `{ scheme, k, version, foldOfGroup, evalFoldsById }`。
 *
 * `evalFoldsById`：`id -> [折号...]`，即这个 pair 在哪些折里是 eval。空数组表示它在每一折
 * 都是 train（触及的组分散在各折、没有一个被整体留出时会出现，比如跨两个折的 pair）。
 * 训练侧的 `train_i` 就是「`i` 不在 `evalFoldsById[id]` 里」的全部 pair。
 *
 * 分组用**按规模贪心均衡**：组按（触及它的 pair 数）降序，依次放进当前最轻的折。
 * 判据是「折间规模可比」，否则某折的指标会因为样本太少而噪声很大。
 * 排序里加 key 兜底，保证结果与输入顺序无关。
 */
export function buildFolds(pairs = [], scheme, k = FOLD_SCHEMES[scheme]?.k) {
  if (!FOLD_SCHEME_NAMES.includes(scheme)) throw new Error(`cpdb_fold_scheme_unknown:${scheme}`);
  const foldCount = Number(k) || FOLD_SCHEMES[scheme].k;

  // 1. 每个组有多重（被多少 pair 触及）。
  const weightOfGroup = new Map();
  const keysById = new Map();
  for (const pair of pairs) {
    const keys = groupKeysOf(pair, scheme);
    keysById.set(pair.id, keys);
    for (const key of keys) weightOfGroup.set(key, (weightOfGroup.get(key) || 0) + 1);
  }

  // 2. 贪心均衡分组。组数少于折数时，多出来的折会是空的 —— 这里直接把 k 压到组数，
  //    否则会产出空的 eval 集，指标变成 NaN 而不是一个显式的错误。
  const groups = [...weightOfGroup.keys()].sort(
    (a, b) => weightOfGroup.get(b) - weightOfGroup.get(a) || a.localeCompare(b),
  );
  const effectiveK = Math.max(1, Math.min(foldCount, groups.length));
  const buckets = Array.from({ length: effectiveK }, () => []);
  const load = new Array(effectiveK).fill(0);
  for (const group of groups) {
    let target = 0;
    for (let at = 1; at < effectiveK; at += 1) if (load[at] < load[target]) target = at;
    buckets[target].push(group);
    load[target] += weightOfGroup.get(group);
  }

  const foldOfGroup = new Map();
  buckets.forEach((bucket, fold) => {
    for (const group of bucket) foldOfGroup.set(group, fold);
  });

  // 3. 反查每个 pair 的 eval 折。
  const evalFoldsById = new Map();
  for (const pair of pairs) {
    const folds = uniqueSorted((keysById.get(pair.id) || []).map((key) => String(foldOfGroup.get(key))));
    evalFoldsById.set(pair.id, folds.map(Number));
  }

  return {
    version: CPDB_FOLD_SCHEME_VERSION,
    scheme,
    k: effectiveK,
    requestedK: foldCount,
    folds: buckets,
    foldOfGroup,
    evalFoldsById,
    groupCount: groups.length,
  };
}

/**
 * 把折拆成「第 i 折的 train / eval 下标」。训练脚本直接吃这个。
 *
 * `trainIndices` 是 `evalIndices` 的补集 —— 这不是优化，是定义：留出组的 pair 一条都不许
 * 进训练，否则留出就没意义了。
 */
export function foldIndexSets(rows = [], scheme, k) {
  const folds = buildFolds(rows, scheme, k);
  const sets = [];
  for (let fold = 0; fold < folds.k; fold += 1) {
    const evalIndices = [];
    const trainIndices = [];
    rows.forEach((row, at) => {
      if ((folds.evalFoldsById.get(row.id) || []).includes(fold)) evalIndices.push(at);
      else trainIndices.push(at);
    });
    sets.push({ fold, evalIndices, trainIndices });
  }
  return { ...folds, sets };
}

/** 折方案的摘要，给 `matrix.json` 与报告用。 */
export function foldSummary(folds) {
  const sizes = folds.folds.map((bucket, fold) => {
    let evaluation = 0;
    for (const value of folds.evalFoldsById.values()) if (value.includes(fold)) evaluation += 1;
    return { fold, groups: bucket.length, evaluation };
  });
  return {
    version: folds.version,
    scheme: folds.scheme,
    k: folds.k,
    requestedK: folds.requestedK,
    groupCount: folds.groupCount,
    folds: sizes,
    note: 'eval_i 与 train_i 互补；第 i 折留出的组在 train_i 里一个都不出现（见 splits.test.mjs）。',
  };
}

function uniqueSorted(values = []) {
  return [...new Set(values.map((value) => String(value ?? '')).filter(Boolean))].sort();
}
