// 人工标注包的两类断言。
//
// 1) **挑选逻辑**：用库里真实的 pairs / 两套标签跑 `selectReviewPairs`。
//    不依赖 `exports/` 是否已经导出 —— 导出的东西不进版本库，断言不能挂在它身上。
// 2) **文档里印出去的数字**：`COORDINATOR.zh-CN.md` 里写着「同 family 的 dependency 恒为 0
//    （2640/2640）」「跨 family 的 similarity 恒为 0（5614/5642）」这类结论句。
//    这些数字是**结论本身**，不是装饰。数据一改它们就变成假话，所以在这里钉死。
//    这与库里其它报告页的做法一致：说法要么被断言，要么别写。
//
// 若 `exports/cpdb-human-review-v1/` 存在（本地导出过），额外做交付物的卫生检查，
// 包括「卡面绝不能出现机器标签」这条 —— 它一破，整包标注就废了。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GROUPS,
  SCALE,
  agreementStats,
  describePair,
  normalizeScaleValue,
  quadraticWeightedKappa,
  selectReviewPairs,
  toAnswerKeyRow,
  toBlindCard,
  toBlindSide,
} from './lib/humanReviewSelect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(HERE, 'exports', 'cpdb-human-review-v1');
const AXES = ['dependency', 'similarity'];

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** 真实世界：候选池 + 两套机器标签 + 卡面。整个文件共用一份，避免反复读 8282 行。 */
function loadWorld() {
  const cards = new Map(readJsonl(join(HERE, 'data', 'full', 'annotation_cards.jsonl')).map((c) => [c.id, c]));
  const teacher = new Map(readJsonl(join(HERE, 'train_out', 'labels.jsonl')).map((l) => [l.id, l]));
  const ai = new Map(readJsonl(join(HERE, 'train_out_ai', 'labels.jsonl')).map((l) => [l.id, l]));
  const records = [];
  for (const pair of readJsonl(join(HERE, 'data', 'full', 'pairs.jsonl'))) {
    const t = teacher.get(pair.id);
    const a = ai.get(pair.id);
    if (t && a && cards.has(pair.id)) records.push({ record: describePair(pair, t, a), pair, card: cards.get(pair.id) });
  }
  return { records, cards };
}

const WORLD = loadWorld();
const RECORDS = WORLD.records.map((r) => r.record);

test('候选池与两套标签逐条对齐（8282 对）', () => {
  assert.equal(RECORDS.length, 8282, '候选池大小变了：训练数据或标签文件被换过');
  assert.equal(new Set(RECORDS.map((r) => r.id)).size, RECORDS.length, 'pair id 有重复');
});

test('文档印出去的两侧分布确实成立', async () => {
  const { records } = WORLD;
  const same = records.filter((r) => r.record.sameFamily).map((r) => r.record);
  const cross = records.filter((r) => !r.record.sameFamily).map((r) => r.record);
  assert.equal(same.length, 2640);
  assert.equal(cross.length, 5642);

  // 「teacher 把同主职能当充分统计量」：这两条常数的存在才是整份文档的前提。
  assert.equal(same.filter((r) => r.teacher.dependency === 0).length, 2640, 'teacher 同 family dependency 不再恒为 0');
  assert.equal(same.filter((r) => r.teacher.similarity === 0.75).length, 2640, 'teacher 同 family similarity 不再恒为 0.75');
  assert.equal(cross.filter((r) => r.teacher.similarity === 0).length, 5614, 'teacher 跨 family similarity 不再恒为 0');

  // 「AI 在同职能内部继续分辨」：如果 AI 也只有一档，那两套口径就不是对立而是相同，
  // 整个「问人」的动作就没有意义了 —— 这条断言是那件事的守卫。
  assert.ok(new Set(same.map((r) => r.ai.similarity)).size >= 3, 'AI 同 family similarity 已退化到少数几档');
  assert.ok(new Set(cross.map((r) => r.ai.similarity)).size >= 4, 'AI 跨 family similarity 已退化');
  // 同 family 上两套口径的 dependency 必须真的对立（teacher 恒 0，AI 全 >0）。
  assert.equal(same.filter((r) => r.ai.dependency > 0).length, 2640, 'AI 同 family dependency 不再全部大于 0');
});

test('挑选是确定性的：同 seed 同结果，不同 seed 也不同', () => {
  const a = selectReviewPairs(RECORDS, { seed: 1 }).cards.map((r) => r.id);
  const b = selectReviewPairs(RECORDS, { seed: 1 }).cards.map((r) => r.id);
  const c = selectReviewPairs(RECORDS, { seed: 2 }).cards.map((r) => r.id);
  assert.deepEqual(a, b, '同 seed 给出了不同结果 —— 抽样不可复现');
  assert.notDeepEqual(a, c, '不同 seed 给出了相同结果 —— seed 没被用上');
});

test('分层上限被遵守，且每个命中分组都真的取到了卡', () => {
  const { cards, perGroup } = selectReviewPairs(RECORDS, { seed: 20260920 });
  assert.ok(cards.length > 0);
  for (const g of perGroup) {
    const spec = GROUPS.find((s) => s.name === g.name);
    if (g.poolSize > 0) assert.ok(g.picked > 0, `${g.name} 有候选却一张没取到`);
    for (const s of g.strata) {
      assert.ok(s.picked <= spec.perStratum, `${g.name}/${s.key} 超出每层上限`);
      assert.ok(s.picked <= s.pool, `${g.name}/${s.key} 取的数量超过该层候选数`);
    }
    assert.equal(
      g.picked,
      g.strata.reduce((n, s) => n + s.picked, 0),
      `${g.name} 的合计与分层之和对不上`,
    );
  }
  assert.equal(new Set(cards.map((r) => r.id)).size, cards.length, '同一个 pair 被取了两次');
});

test('分组归属反映真正消耗配额的那一组，且每张卡都满足自己组的条件', () => {
  const { cards, perGroup } = selectReviewPairs(RECORDS, { seed: 20260920 });
  const groupIndex = new Map(GROUPS.map((g, i) => [g.name, i]));

  for (const r of cards) {
    const spec = GROUPS.find((g) => g.name === r.group);
    assert.ok(spec, `${r.id} 的归属组 ${r.group} 不存在`);
    // 有效性：样本必须真的满足它被算进去那组的条件，否则该组指标是脏的。
    assert.ok(spec.match(r), `${r.id} 归属 ${r.group}，却不满足该组的匹配条件`);
    // 一张卡可能同时满足多组；它只可能被**第一命中组或更晚**的组取走
    // （第一命中组在该层取满时才会漏给它）。归属若早于第一命中，说明归属算错了。
    const first = GROUPS.findIndex((g) => g.match(r));
    assert.ok(
      groupIndex.get(r.group) >= first,
      `${r.id} 归属 ${r.group}，早于它的第一命中组 ${GROUPS[first].name}`,
    );
  }

  // 配额与实际归属必须一一对上 —— 这是分组指标分母正确的前提。
  for (const g of perGroup) {
    const owned = cards.filter((r) => r.group === g.name).length;
    assert.equal(owned, g.picked, `${g.name} 的配额与实际归属不一致（${g.picked} vs ${owned}）`);
  }
  assert.equal(
    perGroup.reduce((n, g) => n + g.picked, 0),
    cards.length,
    '各组合计与卡数不一致',
  );
});

test('挑出来的 same_family 组里确实全是同 family', () => {
  const { cards } = selectReviewPairs(RECORDS, { seed: 20260920 });
  for (const r of cards) {
    if (r.group.startsWith('same_family')) assert.ok(r.sameFamily, `${r.id} 在同 family 组里却不是同 family`);
    if (r.group.startsWith('cross_family')) assert.ok(!r.sameFamily, `${r.id} 在跨 family 组里却是同 family`);
  }
});

test('卡面是白名单：多塞字段也漏不出去', () => {
  // 模拟有人往 pairs.jsonl / cards 里加了字段。白名单的含义就是这里必须原样不变。
  const side = {
    name: '信息整理·年份窗口',
    family: '信息整理',
    facet: '年份窗口',
    tags: ['research'],
    produces: ['notes'],
    consumes: [],
    skillDigest: '摘要',
    ownerUserId: 'p_01_00',
    ownerDisplayName: '王一帆',
    orgId: 'org_01_consumer',
    kind: 'hard_negative',
    initDependency: 0.75,
    contractSimilarity: 0.24,
  };
  const blind = toBlindSide(side);
  assert.deepEqual(
    Object.keys(blind).sort(),
    ['consumes', 'facet', 'family', 'name', 'produces', 'skillDigest', 'tags'],
    '卡面字段集变了 —— 白名单被改动过',
  );
  const text = JSON.stringify(blind);
  for (const leak of ['p_01_00', '王一帆', 'org_01', 'hard_negative', '0.24']) {
    assert.ok(!text.includes(leak), `卡面漏出了 ${leak}`);
  }
});

test('卡面不含机器标签、不含 kind、也不含真实 pair id', () => {
  const cards = selectReviewPairs(RECORDS, { seed: 20260920 }).cards;
  const entry = WORLD.records.find((r) => r.record.id === cards[0].id);
  const blind = toBlindCard(entry.record, entry.card, 'hrv1-0001');

  assert.equal(blind.cardId, 'hrv1-0001');
  assert.ok(!('id' in blind), '卡面带上了真实 pair id —— 它会漏出所有者编号');
  const text = JSON.stringify(blind);
  for (const forbidden of ['ownerdirected', 'hard_negative', 'cross_owner', 'isTwin', 'teacher', 'machine', 'group', 'batch']) {
    assert.ok(!text.includes(forbidden), `卡面出现了 ${forbidden}`);
  }
  // 两个分数必须是空的：印上机器答案，人只会挑一个。
  assert.equal(blind.answer.dependency, null);
  assert.equal(blind.answer.similarity, null);
  assert.deepEqual(blind.scale, SCALE, '刻度与 AI 判分包不一致，人的答案将无法与机器逐档对账');
  assert.ok(blind.questions.dependency.length > 0 && blind.questions.similarity.length > 0);
});

test('answer key 保留机器答案与分组，且能对上卡面', () => {
  const cards = selectReviewPairs(RECORDS, { seed: 20260920 }).cards;
  const entry = WORLD.records.find((r) => r.record.id === cards[0].id);
  const row = toAnswerKeyRow(entry.record, cards[0].group, entry.card, null, 'hrv1-0001');

  assert.equal(row.cardId, 'hrv1-0001');
  assert.equal(row.id, entry.record.id);
  assert.equal(row.group, cards[0].group);
  assert.ok(typeof row.machine.teacher.dependency === 'number');
  assert.ok(typeof row.machine.ai.dependency === 'number');
  assert.ok(row.machine.gap.dependency >= 0);
  assert.ok(row.shown.left && !('ownerUserId' in row.shown.left), 'shown 里不该有 owner 字段');
});

test('刻度归一化：只认五档，填错就报出来而不是修好', () => {
  assert.deepEqual(normalizeScaleValue(0.5), { value: 0.5, offScale: false });
  assert.deepEqual(normalizeScaleValue('0.75'), { value: 0.75, offScale: false });
  assert.deepEqual(normalizeScaleValue(0), { value: 0, offScale: false });
  assert.deepEqual(normalizeScaleValue(null), { value: null, offScale: false });
  assert.deepEqual(normalizeScaleValue(''), { value: null, offScale: false });
  // 0.6 / 0.3 / 2 都在刻度外 —— 绝不能悄悄吸到最近的档上。
  assert.equal(normalizeScaleValue(0.6).offScale, true);
  assert.equal(normalizeScaleValue(0.3).offScale, true);
  assert.equal(normalizeScaleValue(2).offScale, true);
  assert.equal(normalizeScaleValue('abc').offScale, true);
  assert.equal(normalizeScaleValue(0.6).value, null);
});

test('QWK：完全一致为 1，反向排列为负，恒定偏移被扣分但仍为正', () => {
  const same = [0, 0.25, 0.5, 0.75, 1, 0.5, 0.25];
  assert.equal(quadraticWeightedKappa(same, same).qwk, 1);

  // 恒定 +0.25 偏移：两套口径最可能出现的错法（整体偏一档）。
  // 它**不该**是负数 —— 全部偏一档仍比乱猜好；但必须明显低于完全一致。
  // 这条数字钉住的是「QWK 会不会把系统性偏移误判成完全不可用」。
  const shifted = same.map((v) => (v === 1 ? 0.75 : v + 0.25));
  const kShift = quadraticWeightedKappa(same, shifted).qwk;
  assert.ok(kShift > 0 && kShift < 0.8, `恒定偏移的 QWK 应落在 (0, 0.8)，实得 ${kShift}`);

  // 反向排列（0↔1、0.25↔0.75）：这是「口径正好相反」，必须显著为负。
  const kFlip = quadraticWeightedKappa(same, same.map((v) => 1 - v)).qwk;
  assert.ok(kFlip < -0.5, `反向排列的 QWK 应显著为负，实得 ${kFlip}`);

  // 恒答一个中间档去对一套铺开的机器答案 —— 相当于「多数类」基线，应贴近 0。
  const kConst = quadraticWeightedKappa([0.5, 0.5, 0.5, 0.5], [0, 0.25, 0.5, 0.75]).qwk;
  assert.ok(Math.abs(kConst) < 0.35, `恒定答案对铺开答案的 QWK 应接近 0，实得 ${kConst}`);

  // 只有一个类别时 den 为 0：定义上算完全一致，不能变成 NaN。
  assert.equal(quadraticWeightedKappa([0.5, 0.5], [0.5, 0.5]).qwk, 1);
});

test('agreementStats：未答的卡不计入，样本为 0 时不返回 NaN', () => {
  const s = agreementStats([0.5, null, 0.75], [0.5, 0, 0.5]);
  assert.equal(s.n, 2);
  assert.equal(s.exact, 0.5);
  assert.equal(s.within25, 1); // |0.5-0.5|=0 命中，|0.75-0.5|=0.25 命中
  assert.ok(Math.abs(s.mae - 0.125) < 1e-12);
  const empty = agreementStats([null], [0.5]);
  assert.equal(empty.n, 0);
  assert.equal(empty.exact, null);
  assert.equal(empty.mae, null);
});

test('算账链路自检：答案假装来自 teacher 就判 teacher，假装来自 AI 就判 AI', () => {
  // 这份脚本唯一一次真正跑起来是在人标完之后，那时发现算错就要重标一遍。
  // 所以用一个人造的小夹具把它端到端跑通，并把两条恒等式钉死。
  // 夹具自造，不依赖 exports/ 是否导出 —— 后者不进版本库。
  const dir = mkdtempSync(join(tmpdir(), 'cpdb-hr-'));
  try {
    const rows = [
      { id: 'a>b', group: 'same_family_dependency_opposed', teacher: [0, 0.75], ai: [0.75, 0.5] },
      { id: 'c>d', group: 'same_family_dependency_opposed', teacher: [0, 0.75], ai: [1, 0.5] },
      { id: 'e>f', group: 'cross_family_dependency_opposed', teacher: [1, 0], ai: [0.5, 0.5] },
      { id: 'g>h', group: 'cross_family_dependency_opposed', teacher: [0.25, 0], ai: [0.5, 0.75] },
    ];
    writeFileSync(
      join(dir, 'cards.jsonl'),
      `${rows
        .map((r) =>
          JSON.stringify({
            cardId: r.id,
            batch: 'b1',
            left: {},
            right: {},
            questions: { dependency: 'x', similarity: 'y' },
            scale: SCALE,
            answer: { dependency: null, similarity: null, annotatorId: null, rationale: null },
          }),
        )
        .join('\n')}\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'answer_key.jsonl'),
      `${rows
        .map((r) =>
          JSON.stringify({
            cardId: r.id,
            id: r.id,
            group: r.group,
            machine: {
              teacher: { dependency: r.teacher[0], similarity: r.teacher[1] },
              ai: { dependency: r.ai[0], similarity: r.ai[1] },
              gap: {
                dependency: Math.abs(r.teacher[0] - r.ai[0]),
                similarity: Math.abs(r.teacher[1] - r.ai[1]),
              },
            },
          }),
        )
        .join('\n')}\n`,
      'utf8',
    );

    const script = join(HERE, 'score_human_review.mjs');
    const runSimulated = (policy) => {
      execFileSync(process.execPath, [script, '--dir', dir, '--simulate', policy], { encoding: 'utf8' });
      const path = join(dir, `score.simulated-${policy}.json`);
      return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    };

    const asTeacher = runSimulated('teacher');
    assert.equal(asTeacher.simulated, 'teacher', '结果文件必须自报是模拟的');
    for (const axis of AXES) {
      assert.equal(asTeacher.decisive.perAxis[axis].teacherQwk, 1, `假装 teacher 时 ${axis} 的人-vs-teacher 应为 1`);
      assert.ok(asTeacher.decisive.perAxis[axis].aiQwk < 1, `假装 teacher 时 ${axis} 的 AI QWK 应低于 1`);
      assert.equal(asTeacher.decisive.perAxis[axis].closerTo, 'teacher', `${axis} 应判为 teacher`);
    }

    const asAi = runSimulated('ai');
    for (const axis of AXES) {
      assert.equal(asAi.decisive.perAxis[axis].aiQwk, 1, `假装 AI 时 ${axis} 的人-vs-AI 应为 1`);
      assert.equal(asAi.decisive.perAxis[axis].closerTo, 'ai', `${axis} 应判为 ai`);
    }

    // 刻度外的值必须作为「问题」报出来，而不是被吸到最近的档上。
    // 这一步刻意**不加 --simulate**：模拟会把卡上的答案整个盖掉，那样就测不到这一步了。
    const cards = readFileSync(join(dir, 'cards.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    cards[0].answer = { dependency: 0.6, similarity: 0.5, annotatorId: 't', rationale: null };
    writeFileSync(join(dir, 'cards.jsonl'), `${cards.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8');
    execFileSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' });
    const messy = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(messy.simulated, null, '未加 --simulate 时 simulated 应为 null');
    assert.ok(
      messy.problems.some((p) => p.issue === 'off_scale:dependency'),
      '0.6 这种刻度外的值没有被报出来',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('默认抽样（seed 20260920）给出诊断页里印出的那批数字', () => {
  // 诊断页里写死了「41 张卡、31 分钟」和六个分组的候选池/取数。
  // 那些数字是**结论的一部分**（它们决定了每组指标的分母），所以钉在这里；
  // 数据或分组定义一动，文档就变成假话，这个断言会先红。
  const { cards, perGroup } = selectReviewPairs(RECORDS, { seed: 20260920 });
  assert.equal(cards.length, 41, '诊断页写着 41 张卡');
  assert.deepEqual(
    perGroup.map((g) => [g.name, g.poolSize, g.picked]),
    [
      ['same_family_dependency_opposed', 2640, 12],
      ['same_family_similarity_ai_low', 76, 8],
      ['same_family_agree_similarity', 46, 4],
      ['cross_family_dependency_opposed', 339, 5],
      ['cross_family_similarity_ai_high', 2810, 6],
      ['agreement_control', 431, 6],
    ],
    '分组候选池/取数与诊断页里印的不一致',
  );
  // 六个职能都必须在场：只问 writing 的话，「同职能同分」这个假设在别的职能上没被检验过。
  for (const g of ['same_family_dependency_opposed', 'cross_family_dependency_opposed']) {
    const strata = new Set(cards.filter((r) => r.group === g).map((r) => r.leftFamily));
    assert.ok(strata.size >= 5, `${g} 只覆盖了 ${strata.size} 个职能，分层没起作用`);
  }
});

test('导出的交付物（若存在）是盲的、可对账的、字数够的', (t) => {
  if (!existsSync(EXPORT_DIR)) {
    t.skip('尚未导出：npm run experiment:cpdb-human-review');
    return;
  }
  const cards = readJsonl(join(EXPORT_DIR, 'cards.jsonl'));
  const key = readJsonl(join(EXPORT_DIR, 'answer_key.jsonl'));
  const selection = JSON.parse(readFileSync(join(EXPORT_DIR, 'selection.json'), 'utf8').replace(/^\uFEFF/, ''));
  const policy = JSON.parse(readFileSync(join(EXPORT_DIR, 'policy.json'), 'utf8').replace(/^\uFEFF/, ''));

  assert.ok(cards.length > 0);
  assert.equal(cards.length, key.length, '卡数与 answer key 行数不一致');
  assert.equal(cards.length, selection.cardCount);

  const cardIds = cards.map((c) => c.cardId);
  assert.equal(new Set(cardIds).size, cardIds.length, 'cardId 有重复');
  assert.deepEqual(cardIds, key.map((k) => k.cardId), '卡面顺序与 answer key 顺序不一致');

  // 交付物里绝不能出现机器标签或 kind。
  for (const card of cards) {
    const text = JSON.stringify(card);
    for (const forbidden of ['hard_negative', 'within_owner', 'cross_owner', 'teacher', 'machine']) {
      assert.ok(!text.includes(forbidden), `卡 ${card.cardId} 漏出 ${forbidden}`);
    }
    assert.equal(card.answer.dependency, null, `卡 ${card.cardId} 的 answer 没留空`);
    assert.equal(card.answer.similarity, null, `卡 ${card.cardId} 的 answer 没留空`);
    // cardId 不得包含真实 pair id 的所有者片段。
    assert.match(card.cardId, /^hrv1-\d{4}$/);
  }

  // 卡面顺序必须是打散过的，且打成"同一所有者的卡不相邻"。
  // 原顺序是按真实 pair id 排的，而 id 前缀就是所有者编号，于是同一个人手下的 pair
  // 会连成一片 —— 那会让标注者成片给同一种答案（顺序效应），而 AI 判分器是逐卡独立推理。
  // 不洗牌则相邻同所有者会是 29/40，洗过之后是 4/40。
  const ownerOf = (id) => id.split('>')[0].split('_').slice(0, 3).join('_');
  let adjacentSameOwner = 0;
  for (let i = 1; i < key.length; i += 1) if (ownerOf(key[i].id) === ownerOf(key[i - 1].id)) adjacentSameOwner += 1;
  assert.ok(
    adjacentSameOwner <= key.length / 4,
    `相邻同所有者 ${adjacentSameOwner}/${key.length - 1}，卡面顺序没被打散`,
  );
  const idSorted = [...key].sort((a, b) => (a.id < b.id ? -1 : 1)).map((k) => k.id);
  assert.notDeepEqual(key.map((k) => k.id), idSorted, '卡面顺序仍是 id 排序 —— 洗牌没生效');

  // 分组名只在 answer key 里，且都是已知分组。
  const known = new Set(GROUPS.map((g) => g.name));
  for (const row of key) assert.ok(known.has(row.group), `answer key 里出现未知分组 ${row.group}`);

  // 关键三组必须都有卡，否则算账时 decisive 会退化成 undecidable。
  for (const need of ['same_family_dependency_opposed', 'same_family_similarity_ai_low']) {
    assert.ok(key.filter((k) => k.group === need).length > 0, `${need} 一张卡都没有`);
  }

  assert.equal(policy.questions.length, 3, 'policy.json 的判断题数量变了');
  for (const q of policy.questions) assert.equal(q.answer, null, `policy 问题 ${q.id} 不该预填答案`);

  // 指纹要对得上：这批卡就是从库里的文件算出来的。
  assert.ok(selection.inputs.length >= 4);
  for (const input of selection.inputs) assert.match(input.sha256, /^[0-9a-f]{64}$/);
});
