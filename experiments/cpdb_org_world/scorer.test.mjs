import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildVocab, normalizeAgentView } from './lib/features.mjs';
import { loadScorer, scorePair } from './scorer.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data', 'full');

/**
 * 这个文件只回答一个问题：**Python 训出来的权重，在 JS 里算出来的分是不是同一个分。**
 *
 * 训练在 Python、服务在 JS，是这套东西唯一合理的分工（训练要 torch，服务在 Electron 里）。
 * 但分工的代价是：特征顺序、标准化、GELU 变体、矩阵转置，任何一处不一致都会让分数变形，
 * 而且**变形之后照样出分** —— 不会报错，只会让规划选错人。
 *
 * 所以这里不写「实现看起来一样」，而是拿训练脚本亲手落下的 `predictions.jsonl`
 * 逐条对账。两个判据的强度是刻意不同的：
 *   - **argmax 必须 100% 相同**。档位是会被决策直接消费的东西，差一档就是差一档；
 *   - **连续期望值只要求有界接近**。torch 在 A800 上会走 TF32/不同归约顺序，
 *     要求逐位相同是在要求一件不该被要求的事，硬凑只会让容差失去意义。
 */

function readJsonl(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function agentViews() {
  const profiles = new Map(readJsonl(join(DATA, 'agent_profiles.jsonl')).map((item) => [item.uBuddyAgentInstanceId, item]));
  const views = new Map();
  for (const agent of readJsonl(join(DATA, 'agents.jsonl'))) {
    const profile = profiles.get(agent.id);
    views.set(agent.id, normalizeAgentView({ ...(profile || {}), ...agent, extra: { ...(profile?.extra || {}), ...agent } }));
  }
  return views;
}

const ARTIFACTS = ['cpdb-scorer-v1-teacher', 'cpdb-scorer-v2-aijudge'];

for (const name of ARTIFACTS) {
  const dir = join(ROOT, 'artifacts', name);

  test(`scorer.mjs 与 Python 的预测逐条对齐：${name}`, () => {
    if (!existsSync(join(dir, 'predictions.jsonl'))) {
      throw new Error(`cpdb_artifact_missing:${name}（先跑 train_scorer.py 并取回产物）`);
    }
    const scorer = loadScorer(dir);
    const views = agentViews();
    const pairs = new Map(readJsonl(join(DATA, 'pairs.jsonl')).map((pair) => [pair.id, pair]));
    const predictions = readJsonl(join(dir, 'predictions.jsonl'));

    assert.ok(predictions.length >= 700, `测试集条数太少（${predictions.length}）`);
    let maxExpectedDelta = 0;
    let compared = 0;
    for (const row of predictions) {
      const pair = pairs.get(row.id);
      assert.ok(pair, `predictions 里有 pairs.jsonl 中不存在的 id：${row.id}`);
      const score = scorePair(scorer, views.get(pair.leftAgentId), views.get(pair.rightAgentId));
      for (const axis of ['dependency', 'similarity']) {
        // 第一条判据：档位必须一模一样。差一条就说明两侧算的不是同一个东西。
        assert.equal(
          score[axis].argmax,
          row[axis].argmax,
          `${name} ${row.id} ${axis} 档位不一致：js=${score[axis].argmax} python=${row[axis].argmax}`,
        );
        maxExpectedDelta = Math.max(maxExpectedDelta, Math.abs(score[axis].expected - row[axis].expected));
        compared += 1;
      }
    }
    // 第二条判据：连续分有界接近。容差写成常数而不是「实测值加一点」，
    // 否则它只是一个记录了当前误差的记录，不再是一道闸。
    assert.ok(maxExpectedDelta < 1e-3, `${name} 连续分偏差过大：${maxExpectedDelta}`);
    console.log(`[parity] ${name}: ${compared} 个轴全部同档，连续分最大偏差 ${maxExpectedDelta.toExponential(2)}`);
  });

  test(`打分器只出两个轴、不合成总分：${name}`, () => {
    const scorer = loadScorer(dir);
    const views = agentViews();
    const pairs = readJsonl(join(DATA, 'pairs.jsonl'));
    const sample = pairs.filter((_, at) => at % 500 === 0);
    const scale = new Set(scorer.scale.map(String));
    for (const pair of sample) {
      const score = scorePair(scorer, views.get(pair.leftAgentId), views.get(pair.rightAgentId));
      // `schema.json` 的 forbidden 里第一条就是 combinedScore，契约测试也在管这件事。
      // 这里守的是「模型这一侧也没偷偷引入总分」。
      assert.deepEqual(Object.keys(score).sort(), ['dependency', 'similarity']);
      for (const axis of ['dependency', 'similarity']) {
        assert.ok(scale.has(String(score[axis].argmax)), `${axis} 的档位不在标尺上：${score[axis].argmax}`);
        assert.ok(score[axis].expected >= 0 && score[axis].expected <= 1, `${axis} 期望值越界：${score[axis].expected}`);
        const total = score[axis].probability.reduce((sum, value) => sum + value, 0);
        assert.ok(Math.abs(total - 1) < 1e-3, `${axis} 概率未归一：${total}`);
      }
    }
  });
}

test('权重自述的结构必须能对上：层数、维度、特征名', () => {
  for (const name of ARTIFACTS) {
    const dir = join(ROOT, 'artifacts', name);
    const weights = JSON.parse(readFileSync(join(dir, 'weights.json'), 'utf8'));
    const scorer = loadScorer(dir);
    assert.equal(scorer.dimension, weights.featureNames.length);
    assert.equal(scorer.layers.length, weights.architecture.hidden.length);
    let width = scorer.dimension;
    for (const [at, layer] of scorer.layers.entries()) {
      assert.equal(layer.in, width, `${name} 第 ${at} 层输入宽度与上一层对不上`);
      assert.equal(layer.out, weights.architecture.hidden[at]);
      width = layer.out;
    }
    for (const axis of ['dependency', 'similarity']) {
      assert.equal(scorer.heads[axis].out, weights.scale.length);
    }
    // 词表必须和这一版特征码配套：用别的世界训出来的词表会让 one-hot 全体错位。
    assert.deepEqual(Object.keys(scorer.vocab).sort(), ['facets', 'families']);
    assert.ok(scorer.vocab.families.length >= 6 && scorer.vocab.facets.length >= 24);
  }
});

test('词表是从这个世界的 Agent 视图里推出来的，不是手写的', () => {
  const views = [...agentViews().values()];
  const vocab = buildVocab(views);
  const scorer = loadScorer(join(ROOT, 'artifacts', 'cpdb-scorer-v1-teacher'));
  assert.deepEqual(scorer.vocab, vocab);
});
