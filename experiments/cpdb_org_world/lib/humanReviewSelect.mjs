// 从已有的 8282 个 pair 里挑出**交给人的那一小批**，用来裁决「两套标注口径谁对」。
//
// ## 为什么需要这个文件
//
// 诊断轮给出了一个此前没被看见的结论：teacher（手写契约）与 AI 判分不是「一个准一个不准」，
// 而是**两种不同的口径**，且分歧是结构性的。对 8282 个 pair 做两侧分布统计：
//
//   同 family（2640 对）  teacher dependency 恒为 0        AI 为 0.5/0.75/1
//   同 family（2640 对）  teacher similarity 恒为 0.75     AI 为 0.25/0.5/0.75/1
//   跨 family（5642 对）  teacher similarity 恒为 0        AI 铺满 0/0.25/0.5/0.75/1
//
// 也就是说：teacher 把「同一个主职能」当成一个**充分统计量** —— 同职能就是可替换（0.75）、
// 同职能就不构成上下游（dependency=0，因为互相是替代而非串联）；AI 则看画像内容，
// 在同职能内部**继续分辨**，把分数大面积压在 0.5~0.75。
//
// 这两个口径不可能都对，但它们各自都自洽，所以模型指标测不出谁错。**能测出的是人。**
// 本文件的职责是把这个「问人」的动作变成一件可复现、可断言的事：
// 挑哪些 pair、给标注者看什么、不能给他看什么、以及事后怎么算账。
//
// ## 硬约束一：标注者看到的信息必须与 AI 判分器**逐字段一致**
//
// `judge_with_local_llm.py` 的 `render_side()` 只渲染 6 个字段：名称、主职能、细节能力、
// 标签、产出、输入、技能摘要。它**没有**看到 ownerUserId / ownerName / orgId / kind /
// initDependency / contractDependency。
//
// 所以这里必须把 ownerName、orgId 也去掉。否则人会看出「这两个是同一个人手下的」
// （`within_owner_directed`），而 AI 看不到这条线索 —— 那两边的分差就不再是口径之差，
// 而是**信息量之差**，整个对比作废。（`kind` 更要命：它直接写着 `hard_negative`。）
//
// ## 硬约束二：卡面不许出现任何机器标签
//
// 给标注者看的卡里只有画像和两个问题，没有 teacher / AI / contract / init 任何一个分数。
// 两套机器答案存在 `answer_key.jsonl` 里，标完再对。若把机器答案印在卡上，人只会挑一个，
// 我们测到的就是「人会不会挑」，不是「人怎么看」。
//
// 同理，卡上用不透明批次号而非分组名：分组名（`..._opposed`）本身就暗示了期望答案。

/** 五档刻度。与 `judge_with_local_llm.py` 的 `SCALE` 及 AI 判分包必须完全一致，
 *  否则人的答案与机器答案不能逐档对账。 */
export const SCALE = [0, 0.25, 0.5, 0.75, 1];

/** 两个轴的题面。逐字取自 `export/ai-judge-v1/TASK.json` 所用的同一套锚点，
 *  只把「左方/右方」的指代保留下来 —— 换措辞会变成另一个任务。 */
export const QUESTIONS = {
  dependency: '规划时，左方产出是否适合作为右方输入？（不要看他们像不像）',
  similarity: '若左方执行不佳，右方是否适合做最小能力改动的替换？（不要看他们是否该协作）',
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 洗牌但**可复现**：同一个 seed 永远给出同一批人。挑选过程要能被别人重跑一遍。 */
export function seededShuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const shuffled = seededShuffle;

/** 每个 pair 在两套口径下的账。这是挑选与事后算账共用的唯一事实来源。 */
export function describePair(pair, teacherLabel, aiLabel) {
  const sameFamily = pair.leftFamily === pair.rightFamily;
  return {
    id: pair.id,
    sameFamily,
    leftFamily: pair.leftFamily,
    rightFamily: pair.rightFamily,
    kind: pair.kind,
    isTwin: Boolean(pair.isTwin),
    teacher: { dependency: teacherLabel.dependency, similarity: teacherLabel.similarity },
    ai: { dependency: aiLabel.dependency, similarity: aiLabel.similarity },
    gap: {
      dependency: Math.abs(teacherLabel.dependency - aiLabel.dependency),
      similarity: Math.abs(teacherLabel.similarity - aiLabel.similarity),
    },
  };
}

/** 六个分组。每组问的是一个**不同**的结构性问题，所以分组名只在 answer key 里出现。
 *
 *  按优先级排序：一个 pair 同时命中多组时归入第一组，避免同一张卡被算两次。
 *  每组的取数上界按「family」或「leftFamily」分层 —— 否则 `research` 会淹掉 `code`，
 *  而「同职能同分」这个假设在 `code` 与 `writing` 上完全可能是不同的答案。 */
export const GROUPS = [
  {
    // 最尖锐的一组：teacher 说「同职能不构成上下游」(0)，AI 说「构成」(≥0.5)。
    // 人只要在这些卡上答一次 dependency，就能判出哪个口径对。
    name: 'same_family_dependency_opposed',
    question: '同主职能的两个 Agent，左方产出是否可能成为右方输入？',
    match: (r) => r.sameFamily && r.teacher.dependency === 0 && r.ai.dependency >= 0.5,
    stratifyBy: 'leftFamily',
    perStratum: 2,
  },
  {
    // teacher 把同职能相似度压成常数 0.75，AI 在这些对上说「几乎不可替换」。
    // 这是「family 是不是充分统计量」的直接反例候选。
    name: 'same_family_similarity_ai_low',
    question: '同主职能但细节能力不同时，替换代价是否真的都差不多？',
    match: (r) => r.sameFamily && r.teacher.similarity - r.ai.similarity >= 0.5,
    stratifyBy: 'leftFamily',
    perStratum: 2,
  },
  {
    // 对照组：两套口径在相似度上**一致**（都说可替换），但依赖分仍然对立。
    // 只有这组才能把「人只是跟着 dependency 那一轴的印象去答相似度」拆开。
    name: 'same_family_agree_similarity',
    question: '同主职能且 AI 也认为可替换时，依赖分是否仍为 0？',
    match: (r) => r.sameFamily && r.ai.similarity >= 0.75 && r.ai.similarity >= r.teacher.similarity,
    stratifyBy: 'leftFamily',
    perStratum: 2,
  },
  {
    // 跨职能、依赖分对立：teacher 这里会给出很高的依赖分（1392 个 1.0），AI 压在 0.5~0.75。
    name: 'cross_family_dependency_opposed',
    question: '跨主职能时，依赖分是否应按能力缺口大幅变化，而不是都落在中间？',
    match: (r) => !r.sameFamily && r.gap.dependency >= 0.75,
    stratifyBy: 'leftFamily',
    perStratum: 1,
  },
  {
    // teacher 说跨职能相似度恒为 0，AI 说有相当一部分可替换。这是同一假设的另一面。
    name: 'cross_family_similarity_ai_high',
    question: '跨主职能的两个 Agent，是否可能互为好的替换？',
    match: (r) => !r.sameFamily && r.teacher.similarity === 0 && r.ai.similarity >= 0.5,
    stratifyBy: 'leftFamily',
    perStratum: 1,
  },
  {
    // 完全一致的对照卡。人若在这里也答成别的，说明刻度没读懂，整批要复核。
    name: 'agreement_control',
    question: '两套口径一致时，人是否也给出同一个档？',
    match: (r) =>
      !r.sameFamily && r.teacher.dependency === r.ai.dependency && r.teacher.similarity === r.ai.similarity,
    stratifyBy: 'leftFamily',
    perStratum: 1,
  },
];

/**
 * 挑出交给人的那一批。
 *
 * 纯函数、无 I/O、结果只由入参 + seed 决定 —— 于是「为什么是这些卡」可以被测试断言，
 * 而不是靠读一遍输出目录去猜。
 *
 * 返回的 `cards` 是**带归属的**记录：每条多一个 `group`，指向**真正消耗了配额的那一组**。
 * 这一点不能靠「谁先匹配上」重算：一张卡可能同时满足 A、B 两组，但 A 组在它所在的层
 * 已经取满 quota，于是它被 B 组取走 —— 此时它的归属是 B，而「第一命中」会说是 A。
 * 归属算错不会让样本失效（它确实满足被取走那组的条件），但会让**分组指标的分母对不上配额**，
 * 而分组指标正是这一轮唯一的判据。
 */
export function selectReviewPairs(records, { seed = 20260920, enabledGroups = null } = {}) {
  const active = enabledGroups ? GROUPS.filter((g) => enabledGroups.includes(g.name)) : GROUPS;
  const rng = mulberry32(seed);
  const owner = new Map(); // id -> 真正取走它的分组名
  const perGroup = [];

  for (const group of active) {
    const pool = records.filter((r) => group.match(r));
    // 分层内洗牌再取前 N：stratifyBy 的取值顺序由排序固定，保证可复现。
    const strata = new Map();
    for (const r of pool) {
      const key = r[group.stratifyBy];
      if (!strata.has(key)) strata.set(key, []);
      strata.get(key).push(r);
    }
    const picked = [];
    for (const key of [...strata.keys()].sort()) {
      const candidates = shuffled(strata.get(key), rng).filter((r) => !owner.has(r.id));
      for (const r of candidates.slice(0, group.perStratum)) {
        owner.set(r.id, group.name);
        picked.push(r);
      }
    }
    perGroup.push({
      name: group.name,
      question: group.question,
      poolSize: pool.length,
      picked: picked.length,
      strata: [...strata.keys()].sort().map((key) => ({
        key,
        pool: strata.get(key).length,
        picked: picked.filter((r) => r[group.stratifyBy] === key).length,
      })),
    });
  }

  // 稳定排序：卡面顺序不能随挑选过程的哈希顺序漂移，否则两次导出对不上号。
  const cards = [...owner.keys()]
    .sort()
    .map((id) => ({ ...records.find((r) => r.id === id), group: owner.get(id) }));
  return { cards, perGroup, owner };
}

/** 把一张内部记录渲染成**标注者能看的那几个字段** —— 与 `render_side()` 逐字段对齐。
 *
 *  这里是硬约束一的落点：白名单而不是黑名单。黑名单（「记得删掉 kind」）会在下次
 *  有人往 `pairs.jsonl` 加字段时静默漏出去，白名单不会。 */
export function toBlindSide(side) {
  return {
    name: side.name,
    family: side.family,
    facet: side.facet,
    tags: side.tags ?? [],
    produces: side.produces ?? [],
    consumes: side.consumes ?? [],
    skillDigest: side.skillDigest ?? '',
  };
}

/** 生成给标注者看的一行。刻意不写 group、不写机器标签、不写 kind。
 *
 *  没有 `batch` 字段：曾经用批次号来"打散"分组，但那只是把分组换了个名字
 *  （卡仍然是分组的顺序），现在改成对整份卡面做一次固定 seed 的洗牌，
 *  少一个字段就少一个能被读出规律的地方。
 *
 *  `cardId` 而不是真实 pair id：真实 id 长这样 —— `ag_p_01_01_3>ag_p_01_01_4`，
 *  其中 `p_01_01` 是**所有者**编号。同一个所有者手下的两个 Agent 前缀相同，于是
 *  标注者能一眼看出「这两个归同一个人管」，而 `judge_with_local_llm.py` 的
 *  `render_side()` 根本没渲染 owner 字段 —— 两边看到的信息就不等了。
 *  真实 id 只留在 answer key 里，事后对账用。 */
export function toBlindCard(record, card, cardId) {
  return {
    cardId,
    direction: 'left → right',
    left: toBlindSide(card.left),
    right: toBlindSide(card.right),
    questions: QUESTIONS,
    scale: SCALE,
    answer: { dependency: null, similarity: null, annotatorId: null, rationale: null },
  };
}

/** 生成 answer key 的一行：机器怎么答的、为什么挑它、它落在哪些评估折里。
 *  事后算账只需要这个文件加标完的卡。 */
export function toAnswerKeyRow(record, group, card, folds, cardId) {
  return {
    cardId,
    id: record.id,
    group,
    sameFamily: record.sameFamily,
    leftFamily: record.leftFamily,
    rightFamily: record.rightFamily,
    kind: record.kind,
    isTwin: record.isTwin,
    machine: { teacher: record.teacher, ai: record.ai, gap: record.gap },
    // 折归属留给以后：这批人的答案将来若要用作训练标签，必须自己切折，
    // 不能沿用 AI 标签的折（那会让「人答的卡」与「AI 答的卡」混在同一折里）。
    folds: folds ?? null,
    // 原卡的完整画像，便于事后复核标注者当时到底看到了什么。
    shown: { left: toBlindSide(card.left), right: toBlindSide(card.right) },
  };
}

// ---------------------------------------------------------------------------
// 事后算账
// ---------------------------------------------------------------------------

/** 标注者可能填 `0.5`、`"0.5"`、`null`；只认能对上刻度的值，其余算未填。
 *  刻度外的值（比如手抖写了 0.6）**不四舍五入**，直接报出来 —— 默默修正会掩盖填错，
 *  而「填错被悄悄修好」正是这类标注最贵的失败模式。 */
export function normalizeScaleValue(value, scale = SCALE) {
  if (value === null || value === undefined || value === '') return { value: null, offScale: false };
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) return { value: null, offScale: true };
  const snapped = Math.round(num * 4) / 4;
  if (Math.abs(snapped - num) > 1e-9 || !scale.includes(snapped)) return { value: null, offScale: true };
  return { value: snapped, offScale: false };
}

/** 二次加权 kappa。两套机器口径都不是名义类别，档与档之间有距离，
 *  用「同档率」会把 0.75 vs 0.5 和 0.75 vs 0 算成一样错。 */
export function quadraticWeightedKappa(human, machine, scale = SCALE) {
  const ok = human.map((h, i) => [h, machine[i]]).filter(([h, m]) => h !== null && h !== undefined && m !== null && m !== undefined);
  if (ok.length === 0) return { qwk: null, n: 0 };
  const idx = new Map(scale.map((v, i) => [v, i]));
  const k = scale.length;
  const O = Array.from({ length: k }, () => new Array(k).fill(0));
  const hHist = new Array(k).fill(0);
  const mHist = new Array(k).fill(0);
  for (const [h, m] of ok) {
    const hi = idx.get(h);
    const mi = idx.get(m);
    if (hi === undefined || mi === undefined) continue; // 刻度外的值不折算，直接不计入
    O[hi][mi] += 1;
    hHist[hi] += 1;
    mHist[mi] += 1;
  }
  const n = hHist.reduce((a, b) => a + b, 0);
  if (n === 0) return { qwk: null, n: 0 };
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const w = ((i - j) / (k - 1)) ** 2;
      num += (w * O[i][j]) / n;
      den += (w * (hHist[i] * mHist[j])) / n / n;
    }
  }
  return { qwk: den === 0 ? (num === 0 ? 1 : 0) : 1 - num / den, n };
}

export function agreementStats(human, machine, scale = SCALE) {
  const pairs = human
    .map((h, i) => [h, machine[i]])
    .filter(([h, m]) => h !== null && h !== undefined && m !== null && m !== undefined);
  const n = pairs.length;
  if (n === 0) return { n: 0, exact: null, within25: null, mae: null };
  const exact = pairs.filter(([h, m]) => h === m).length / n;
  const within25 = pairs.filter(([h, m]) => Math.abs(h - m) <= 0.25).length / n;
  const mae = pairs.reduce((a, [h, m]) => a + Math.abs(h - m), 0) / n;
  void scale;
  return { n, exact, within25, mae };
}
