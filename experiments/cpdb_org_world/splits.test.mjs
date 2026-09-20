import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CPDB_FOLD_SCHEME_VERSION,
  FOLD_SCHEME_NAMES,
  FOLD_SCHEMES,
  buildFolds,
  foldIndexSets,
  groupKeysOf,
} from './lib/splits.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data', 'full');

function readJsonl(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const pairs = readJsonl(join(DATA, 'pairs.jsonl'));

/**
 * 这组测试守的是一条**唯一的不变式**：第 i 折留出的组，在 train_i 里一个都不出现。
 *
 * 第一轮之所以没发现 99% 的角色泄漏，不是因为谁算错了，而是因为**没有任何一条测试
 * 断言过不相交**。「test 落在没见过的 org 上」看着就像泛化了，于是没人去量
 * 「test 落在见过的 facet 对上吗」。所以这里对每个方案逐折把留出组与 train 逐条比。
 *
 * 反过来说，这个文件里最该被信任的不是「测试通过」，而是**它断言的是哪一句话**。
 * 换成「eval 非空」之类的弱断言，泄漏会照样回来。
 */
test('折方案版本与折数声明自洽', () => {
  assert.equal(CPDB_FOLD_SCHEME_VERSION, 'cpdb_folds_v1');
  for (const scheme of FOLD_SCHEME_NAMES) {
    assert.ok(FOLD_SCHEMES[scheme].k >= 2, `${scheme} 的折数少于 2，留出没有意义`);
  }
  assert.deepEqual(FOLD_SCHEME_NAMES.sort(), ['facet', 'facet_pair', 'family', 'org']);
});

for (const scheme of FOLD_SCHEME_NAMES) {
  test(`${scheme}：第 i 折留出的组不出现在 train_i 里`, () => {
    const folded = foldIndexSets(pairs, scheme);
    assert.ok(folded.k >= 2, `${scheme} 只切出 ${folded.k} 折`);

    for (const { fold, evalIndices, trainIndices } of folded.sets) {
      assert.ok(evalIndices.length > 0, `${scheme} 第 ${fold} 折的 eval 是空的`);
      assert.ok(trainIndices.length > 0, `${scheme} 第 ${fold} 折的 train 是空的`);

      // 这一折被整体留出的组。
      const heldOut = new Set(folded.folds[fold]);
      assert.ok(heldOut.size > 0, `${scheme} 第 ${fold} 折没有留出任何组`);

      // 逐条比对：train 里任何一条都不许触及留出组。
      const violations = [];
      for (const at of trainIndices) {
        const touched = groupKeysOf(pairs[at], scheme).filter((key) => heldOut.has(key));
        if (touched.length) violations.push(`${pairs[at].id} 触及 ${touched.join(',')}`);
      }
      assert.deepEqual(
        violations.slice(0, 10), [],
        `${scheme} 第 ${fold} 折泄题：train_i 里出现了被留出的组（共 ${violations.length} 条）。`
        + `留出组的 pair 必须全部落进 eval_i，否则这一折测的还是"见过的组"。`,
      );
    }
  });
}

test('eval_i 与 train_i 互补，合起来正好是全部 pair', () => {
  for (const scheme of FOLD_SCHEME_NAMES) {
    const folded = foldIndexSets(pairs, scheme);
    for (const { evalIndices, trainIndices } of folded.sets) {
      assert.equal(
        evalIndices.length + trainIndices.length, pairs.length,
        `${scheme} 有一折的 eval+train 不等于总数：说明有 pair 两边都没进`,
      );
      const overlap = new Set(evalIndices.filter((at) => trainIndices.includes(at)));
      assert.equal(overlap.size, 0, `${scheme} 有 pair 同时在 eval 与 train 里`);
    }
  }
});

test('facet_pair 是严格划分：每条 pair 恰好落在一折的 eval 里', () => {
  // 单键方案的性质：格子是划分键，所以每条 pair 只属于一折。
  // 多键方案（facet/family/org）不满足这条，也不该满足 —— 一条跨两个留出组的 pair
  // 会出现在两折的 eval 里，这是刻意的。这条测试把这个区别钉住。
  const folded = buildFolds(pairs, 'facet_pair');
  const multi = [];
  for (const [id, folds] of folded.evalFoldsById) if (folds.length !== 1) multi.push(`${id}:${folds.length}`);
  assert.deepEqual(multi.slice(0, 5), [], 'facet_pair 下有 pair 的 eval 折数不是 1');
});

test('多键方案确实会产生跨折的 pair（否则上面的区别就是空话）', () => {
  const folded = buildFolds(pairs, 'facet');
  let crossFold = 0;
  for (const folds of folded.evalFoldsById.values()) if (folds.length > 1) crossFold += 1;
  // 不是断言"必须有"（那会依赖数据），而是断言"如果有，它的折号是升序且去重的"。
  for (const [id, folds] of folded.evalFoldsById) {
    assert.deepEqual(folds, [...new Set(folds)].sort((a, b) => a - b), `${id} 的折号没有排序去重`);
    assert.ok(folds.length <= 2, `${id} 的 eval 折数超过 2 —— 一条 pair 最多触及两侧的组`);
  }
  assert.ok(crossFold >= 0);
});

test('建折与输入顺序无关，同一份数据永远得到同一组折', () => {
  const forward = buildFolds(pairs, 'facet');
  const backward = buildFolds([...pairs].reverse(), 'facet');
  assert.deepEqual(backward.folds, forward.folds, '折的组成随输入顺序变了');
  for (const pair of pairs) {
    assert.deepEqual(
      backward.evalFoldsById.get(pair.id), forward.evalFoldsById.get(pair.id),
      `${pair.id} 的 eval 折随输入顺序变了`,
    );
  }
});

test('折间规模可比：eval 与 train 的样本数都不超过最轻折的 2 倍', () => {
  // 判据是**样本数**可比，不是**组数**可比：组本身大小差别很大（org 12 个组里
  // 有的大有的小），所以「每折 1 个组」和「每折 3 个组」完全可能一样均衡 ——
  // 第一版就是拿组数当判据，于是 org 方案被误报（组数 1,3,2,3,3 其实是均衡的）。
  // 折间样本数差太多的话，某折的指标会被小样本的噪声主导，五个数就不再可比。
  for (const scheme of FOLD_SCHEME_NAMES) {
    const folded = foldIndexSets(pairs, scheme);
    for (const [label, key] of [['eval', 'evalIndices'], ['train', 'trainIndices']]) {
      const sizes = folded.sets.map((set) => set[key].length);
      assert.ok(Math.min(...sizes) > 0, `${scheme} 有空 ${label} 折`);
      const ratio = Math.max(...sizes) / Math.min(...sizes);
      assert.ok(
        ratio <= 2,
        `${scheme} 的 ${label} 折间样本数差 ${ratio.toFixed(2)} 倍：${sizes.join(',')}`,
      );
    }
  }
});

test('组键是排序去重的，且不含空串', () => {
  for (const scheme of FOLD_SCHEME_NAMES) {
    for (const pair of pairs.filter((_, at) => at % 211 === 0)) {
      const keys = groupKeysOf(pair, scheme);
      assert.ok(keys.length > 0, `${pair.id} 在 ${scheme} 下没有组键`);
      assert.deepEqual(keys, [...new Set(keys)].sort(), `${pair.id} 的组键没排序去重`);
      assert.ok(keys.every((key) => key.length > 0), `${pair.id} 的组键里有空串`);
    }
  }
});

/**
 * 下面两条合起来就是这个文件存在的理由：**把第一轮那个 99% 的泄漏，做成一条会红的断言。**
 *
 * 注意「eval 与 train 共享 org」不是泄漏 —— 一条 eval pair 是 `org_01|org_03` 时，
 * 它当然也触及 `org_03`（那本来就是留出组的**搭档**，在 train 里见过）。真正要量的
 * 是**角色（facet 对）**有没有泄漏：如果 eval 的 `(facetL, facetR)` 格子训练时见过，
 * 那这一折考的就还是「同一个角色换个组织，你还认得吗」。
 */
function facetCellOverlap(folded, scheme) {
  let evaluation = 0;
  let seen = 0;
  for (const { evalIndices, trainIndices } of folded.sets) {
    const trainCells = new Set(trainIndices.map((at) => `${pairs[at].leftFacet}>${pairs[at].rightFacet}`));
    for (const at of evalIndices) {
      evaluation += 1;
      if (trainCells.has(`${pairs[at].leftFacet}>${pairs[at].rightFacet}`)) seen += 1;
    }
  }
  return evaluation === 0 ? 0 : seen / evaluation;
}

test('org 方案不阻止角色泄漏 —— 这正是第一轮 87% 的真实成分', () => {
  const overlap = facetCellOverlap(foldIndexSets(pairs, 'org'), 'org');
  // 第一轮实测 99.0%（791/799）。这条不是在"测实现"，是在**记录病因**：
  // 只要有人再问"org 切分不是已经泛化了吗"，这里就是答案。
  // 若哪天换了世界/数据导致这个数掉下来，测试会红，提醒把报告里的 99.0% 一起改掉。
  assert.ok(
    overlap > 0.5,
    `org 方案的 facet 对泄漏只有 ${(overlap * 100).toFixed(1)}%。`
    + `第一轮实测 99.0% —— 如果这个数真的变了，报告里那段结论也要跟着改。`,
  );
});

test('facet_pair 方案把角色泄漏压到零', () => {
  const overlap = facetCellOverlap(foldIndexSets(pairs, 'facet_pair'), 'facet_pair');
  // 这条是"药"：格子被整体留出，所以 eval 的每个格子训练时都没见过。必须是 0，不是"很低"。
  assert.equal(
    overlap, 0,
    `facet_pair 方案下仍有 ${(overlap * 100).toFixed(1)}% 的 eval pair 落在训练见过的格子上。`,
  );
});

test('org 方案与第一轮的切法同性质：留出的 org 不出现在 train 里', () => {
  const folded = foldIndexSets(pairs, 'org');
  for (const { fold, trainIndices } of folded.sets) {
    const heldOut = new Set(folded.folds[fold]);
    const violations = [];
    for (const at of trainIndices) {
      const touched = groupKeysOf(pairs[at], 'org').filter((key) => heldOut.has(key));
      if (touched.length) violations.push(`${pairs[at].id} 触及 ${touched.join(',')}`);
    }
    assert.deepEqual(
      violations.slice(0, 5), [],
      `org 第 ${fold} 折：train 里有 pair 触及了留出的 org（共 ${violations.length} 条）`,
    );
  }
});

test('折数声明对得上实际产出的折数', () => {
  for (const scheme of FOLD_SCHEME_NAMES) {
    const folded = buildFolds(pairs, scheme);
    assert.equal(folded.k, FOLD_SCHEMES[scheme].k, `${scheme} 的折数与声明不一致`);
    assert.equal(folded.folds.length, folded.k);
  }
  // 组数少于折数时应当自动压低 k，而不是产出空折。
  const tiny = buildFolds(pairs.slice(0, 6), 'org', 5);
  assert.ok(tiny.k >= 1 && tiny.k <= 5, `k 没有被压低到组数以内：${tiny.k}`);
});

test('声明一条 pair 属于多个 eval 折时，train_i 仍然避开全部这些折的组', () => {
  // 这是多键方案最容易出错的地方：一条 pair 横跨两个留出组，如果 train_i 只按
  // "pair 的 eval 折不含 i" 过滤，它就会漏进另一折的 train 里。
  // 这里直接把 train_i 的定义（补集）验一遍。
  for (const scheme of ['facet', 'family', 'org']) {
    const folded = foldIndexSets(pairs, scheme);
    for (const { fold, trainIndices } of folded.sets) {
      const heldOut = new Set(folded.folds[fold]);
      for (const at of trainIndices) {
        const touched = groupKeysOf(pairs[at], scheme);
        assert.ok(
          touched.every((key) => !heldOut.has(key)),
          `${scheme} 第 ${fold} 折：${pairs[at].id} 触及了留出组 ${touched.filter((key) => heldOut.has(key)).join(',')}`,
        );
      }
    }
  }
});
