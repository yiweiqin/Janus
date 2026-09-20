// 导出「交给人的那一小批」：`exports/cpdb-human-review-v1/`。
//
// 挑选规则本身在 `lib/humanReviewSelect.mjs` 里（纯函数、被 `human_review.test.mjs` 断言）。
// 这个脚本只负责：读盘、调用挑选、写文件、算清单。
//
// 产物**不进版本库**（`exports/` 已 ignore）。理由与 `export/ai-judge-v1/` 一致：
// 它是递给外部人的一次性交付物，靠 `npm run experiment:cpdb-human-review` 一条命令重建；
// 而它依赖的输入（pairs / cards / 两套标签）全都在库里，所以重建出来的东西是可对账的。
//
// 用法：
//   node experiments/cpdb_org_world/export_human_review.mjs
//   node experiments/cpdb_org_world/export_human_review.mjs --seed 12345
//   node experiments/cpdb_org_world/export_human_review.mjs --groups same_family_dependency_opposed
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GROUPS,
  QUESTIONS,
  SCALE,
  describePair,
  mulberry32,
  seededShuffle,
  selectReviewPairs,
  toAnswerKeyRow,
  toBlindCard,
} from './lib/humanReviewSelect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data', 'full');
const OUT_DIR = join(HERE, 'exports', 'cpdb-human-review-v1');

function parseArgs(argv) {
  const out = { seed: 20260920, groups: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seed') out.seed = Number(argv[++i]);
    else if (argv[i] === '--groups') out.groups = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/** 标注者看到的那一页。刻意**不提**两套机器口径的分布 ——
 *  告诉他「契约说同职能恒为 0.75」会把他推着往反方向答，那样测到的还是「他会不会挑」。
 *
 *  这里用逐行字符串数组而不是模板串：这一页含 markdown 代码围栏（```），
 *  塞进模板串就得逐个转义反引号，漏一个就是语法错误 —— 在同一份文件里已经踩过一次
 *  （下面 `coordinatorReadme` 就是模板串写法，改它时请留意）。 */
function annotatorReadme({ cardCount, minutes }) {
  return [
    `# 依赖分 / 相似度 人工标注（${cardCount} 对）`,
    '',
    `这是一份约 **${minutes} 分钟**的标注任务。我们有一批 Agent 两两配对，需要你判断每一对的两个分数。`,
    '',
    '## 你只需要看两份画像',
    '',
    '每一对给出左、右两个 Agent 的画像：名称（含主职能与细节能力）、标签、产出、输入、技能摘要。',
    '**没有别的信息**（看不到它们属于谁、属于哪个组织、是怎么配到一起的）—— 这是刻意的：',
    '唯一能作为判断依据的，就是这几行画像本身。若你觉得某一对凭这些信息无法判断，就照你的直觉给一个档，',
    '并在 `rationale` 里写一句为什么。',
    '',
    '## 两个分数（每对都要给两个）',
    '',
    `**第一轴 dependency —— ${QUESTIONS.dependency}**`,
    '',
    '只看产物流向：左方的产出能不能当右方的输入。',
    '',
    '| 分 | 含义 |',
    '| --- | --- |',
    '| 0 | 左方的产出与右方的输入完全对不上 |',
    '| 0.25 | 只有很边缘的对应 |',
    '| 0.5 | 有部分对应，缺了还得补别的 |',
    '| 0.75 | 基本对得上，是右方的主要输入之一 |',
    '| 1 | 左方的产出正好是右方的核心输入 |',
    '',
    `**第二轴 similarity —— ${QUESTIONS.similarity}**`,
    '',
    '只看换上去要改多少细节能力：右方顶左方的位置，改动越小分越高。',
    '',
    '| 分 | 含义 |',
    '| --- | --- |',
    '| 0 | 职能不同，换上去等于换了件事 |',
    '| 0.25 | 大方向沾边，但细节能力差得远 |',
    '| 0.5 | 同大职能，细节能力只有部分重合 |',
    '| 0.75 | 同大职能，细节能力大部分重合 |',
    '| 1 | 同职能且细节能力几乎重合，换上去改动最小 |',
    '',
    `两轴**互相独立**：不要因为「这两个不该协作」就压低 similarity，也不要因为「这两个可以互相替换」`,
    `就抬高 dependency。分数只能从 ${SCALE.join(' / ')} 里选，不许给别的值。`,
    '',
    '## 怎么填',
    '',
    '打开 `cards.jsonl`，每行一对。把该行的 `answer` 填成：',
    '',
    '```json',
    '{"dependency": 0.5, "similarity": 0.75, "annotatorId": "你的名字或代号", "rationale": "一句话，可选"}',
    '```',
    '',
    '- 一行一对，**不要删行、不要改顺序、不要动 `cardId`**。',
    '- `rationale` 可以留空；但如果某一对你觉得两轴难以分开，写一句会很有用。',
    '- 卡面顺序是打散过的，与分组、组织、相似度都无关，不要去找规律。',
    '',
    '## 填完之后',
    '',
    `回到目录里的 \`policy.json\`，里面有三个判断题。那三个问题**比这 ${cardCount} 张卡更重要** ——`,
    '如果你的直觉与逐卡打分冲突，以你在 `policy.json` 的答案为准，并在备注里说明。',
    '',
    '填好后把整个目录还回来即可（`cards.jsonl` + `policy.json`）。',
    '',
  ].join('\n');
}

/** 给发起人的一页：这批卡为什么是这些、答案会决定什么、回来怎么算账。 */
function coordinatorReadme({ selection, groupStats, inputs }) {
  const groupLines = groupStats
    .map((g) => `| \`${g.name}\` | ${g.poolSize} | ${g.picked} | ${g.question} |`)
    .join('\n');
  const inputLines = inputs.map((i) => `| \`${i.path}\` | \`${i.sha256.slice(0, 16)}…\` |`).join('\n');
  return `# 发起人说明：这批人工标注要裁决什么

> **这一页不要给标注者看。** 他手上只应有 \`README.zh-CN.md\`、\`cards.jsonl\`、\`policy.json\`。

## 一句话

现有两套机器口径在**同主职能**这一格上完全对立，模型指标分不出谁对 —— 只有人能分。

## 分歧长什么样

对 8282 对做两侧分布统计，分歧不是零散的，是结构性的：

| | teacher（手写契约） | AI 判分（Qwen3-8B 多数投票） |
| --- | --- | --- |
| 同 family 的 dependency | **恒为 0**（2640/2640） | 0.5 / 0.75 / 1 |
| 同 family 的 similarity | **恒为 0.75**（2640/2640） | 0.25 / 0.5 / 0.75 / 1 |
| 跨 family 的 similarity | **恒为 0**（5614/5642） | 0 / 0.25 / 0.5 / 0.75 / 1 |

读法：teacher 把「同一个主职能」当成**充分统计量** —— 同职能即互为替代（0.75），
也即不构成上下游（dependency=0，替代关系不是串联关系）；AI 则继续看画像内容，
在同职能内部再分辨，并把大量分数压在中间档。

两者各自都自洽，所以**它们不可能都对**，而这不是靠再训一版模型能解决的：
标签停在哪一层分辨率上，模型就只能学到哪一层。

## 这批卡怎么来的

seed = \`${selection.seed}\`，按下列分组分层抽样，每组设上限以免某个职能淹没其他职能：

| 分组 | 候选池 | 实际取 | 这一组要问出什么 |
| --- | --- | --- | --- |
${groupLines}

一个 pair 同时可能满足多组条件，但它只被**一组**取走（不重复出现）：按上表从上到下取，
某组在某一层取满 quota 后，剩下的候选会让给后面的组 —— \`answer_key.jsonl\` 里的 \`group\`
记的是**真正取走它的那一组**，也是算账时它所在的分母。

卡面顺序另做了一次固定 seed 的洗牌。原因：\`cards\` 原本按真实 pair id 排序，而 id 前缀就是
所有者编号，同一个人手下的 pair 会连成一片；\`skillDigest\` 里又带着那份任务的上下文，
于是标注者容易成片给同一种答案（顺序效应），而 AI 判分器是逐卡独立推理。
洗牌把「相邻同所有者」从 29/40 降到 4/40，且不改动任何统计量（\`human_review.test.mjs\` 在守这条）。

## 答案回来之后怎么算账

\`\`\`bash
npm run experiment:cpdb-human-review:score -- --dir exports/cpdb-human-review-v1
\`\`\`

它会分别算「人 vs teacher」「人 vs AI」的同档率、±0.25 命中率、MAE 与二次加权 kappa，
**按分组分开报**。分组分开是关键：只看总分会被 \`agreement_control\` 那一组稀释掉 ——
那一组两套口径一致，谁都能「猜」对。

## 三种可能的结果，分别意味着什么

- **人的答案靠近 teacher** → 「主职能是充分统计量」成立。那就**不需要学习模型**，
  保留规则（或让模型去学这条规则），把指数递减那部分做掉即可。
- **人的答案靠近 AI** → 学习模型这条路成立，但也说明现在的 teacher 标签不可用，
  需要的是**同职能内部的细分标签**，而不是再训一版。
- **人对两套都不像** → 说明两轴的定义本身需要改（例如「最小能力改动」在人的理解里
  与题面锚点不是一回事）。这时候该改的是 \`TASK.json\` 的锚点，而不是模型。

## 输入的指纹

| 文件 | sha256（前 16 位） |
| --- | --- |
${inputLines}

（重跑同一条命令应得到逐字节相同的 \`cards.jsonl\`；\`selection.json\` 里记了完整指纹。）
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const cardsPath = join(DATA, 'annotation_cards.jsonl');
  const pairsPath = join(DATA, 'pairs.jsonl');
  const teacherPath = join(HERE, 'train_out', 'labels.jsonl');
  const aiPath = join(HERE, 'train_out_ai', 'labels.jsonl');
  const foldsPath = join(HERE, 'train_out_ai', 'folds.jsonl');

  const cards = readJsonl(cardsPath);
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const teacher = new Map(readJsonl(teacherPath).map((l) => [l.id, l]));
  const ai = new Map(readJsonl(aiPath).map((l) => [l.id, l]));
  const folds = new Map(readJsonl(foldsPath).map((f) => [f.id, f]));

  const records = [];
  let skipped = 0;
  for (const pair of readJsonl(pairsPath)) {
    const t = teacher.get(pair.id);
    const a = ai.get(pair.id);
    if (!t || !a || !cardById.has(pair.id)) {
      skipped += 1;
      continue;
    }
    records.push(describePair(pair, t, a));
  }
  if (skipped > 0) {
    // 不是致命错误（`data/full` 里可能混进调试用的一半数据），但必须说出来，
    // 否则「候选池 2640」这种数字会悄悄对不上。
    console.warn(`警告：${skipped} 个 pair 缺标签或卡面，未进入候选池`);
  }

  const { cards: picked, perGroup } = selectReviewPairs(records, {
    seed: args.seed,
    enabledGroups: args.groups,
  });
  if (picked.length === 0) {
    throw new Error('cpdb_human_review_empty: 没有挑出任何 pair，检查 --groups 与输入数据');
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // 卡面顺序再洗一次，用另一个 seed 派生。
  //
  // 为什么要洗：`cards` 是按真实 pair id 排序的，而 id 形如 `ag_p_01_00_0>ag_p_01_00_1` ——
  // **同一个所有者的 pair 会连在一起**。名字和 owner 字段虽然已剔除，但 `skillDigest` 里
  // 带着所有者那份任务的上下文（"消费电子份额·2023-2025 国内手机线上份额…"），
  // 于是相邻几行读起来像"同一批活儿"，标注者会不自觉地成片给同一种答案（顺序效应），
  // 而 AI 判分器是一张卡一次独立推理，没有这种成片效应 —— 又是一个不对等。
  //
  // 洗牌不改任何统计量（分组归属、配额、answer key 内容都不变），却消掉了顺序效应。
  // 用固定 seed，所以"交付的那一版长什么样"仍然可复现。
  const ordered = seededShuffle(picked, mulberry32(args.seed ^ 0x5bf03635));

  // cardId 与真实 pair id 的映射只写在 answer key 里 —— 卡面带真实 id 会漏出所有者前缀。
  const cardIds = new Map(ordered.map((r, i) => [r.id, `hrv1-${String(i + 1).padStart(4, '0')}`]));
  const blindCards = ordered.map((r) => toBlindCard(r, cardById.get(r.id), cardIds.get(r.id)));
  const answerKey = ordered.map((r) =>
    toAnswerKeyRow(r, r.group, cardById.get(r.id), folds.get(r.id) ?? null, cardIds.get(r.id)),
  );

  const policy = {
    instructions:
      '三个判断题。若与逐卡打分冲突，以这里为准；备注里请写一句理由。answers 里填 true / false / "unsure"。',
    questions: [
      {
        id: 'same_family_is_sufficient_for_similarity',
        text: '同一个主职能（family）的两个 Agent，只要细节能力（facet）不同，作为「最小改动替换」的代价是否应当**都一样**？',
        note: '答 true = 主职能已是充分变量，同职能同分；答 false = 细节能力需要单独计入。',
        answer: null,
      },
      {
        id: 'same_family_dependency_always_zero',
        text: '同一个主职能的两个 Agent，左方的产出是否**不可能**成为右方的有效输入（因为它们是替代关系而非上下游）？',
        note: '答 true = 同职能依赖分恒为 0。',
        answer: null,
      },
      {
        id: 'cross_family_similarity_always_zero',
        text: '不同主职能的两个 Agent，是否**都不可能**互为好的替换？',
        note: '答 true = 跨职能相似度恒为 0。',
        answer: null,
      },
    ],
    notes: '',
  };

  const inputs = [
    { path: 'data/full/annotation_cards.jsonl', sha256: sha256(cardsPath) },
    { path: 'data/full/pairs.jsonl', sha256: sha256(pairsPath) },
    { path: 'train_out/labels.jsonl', sha256: sha256(teacherPath) },
    { path: 'train_out_ai/labels.jsonl', sha256: sha256(aiPath) },
    { path: 'train_out_ai/folds.jsonl', sha256: sha256(foldsPath) },
  ];

  const groupStats = perGroup.map((g) => ({
    name: g.name,
    question: g.question,
    poolSize: g.poolSize,
    picked: g.picked,
    strata: g.strata,
  }));
  const selection = {
    generatedAt: new Date().toISOString(),
    generator: 'experiments/cpdb_org_world/export_human_review.mjs',
    seed: args.seed,
    enabledGroups: args.groups,
    candidatePool: records.length,
    cardCount: blindCards.length,
    scale: SCALE,
    // 这里同时写出「所有已知分组」与「本次启用的分组」，因为 --groups 是调试开关；
    // 交付时必须是不带 --groups 的全量，否则有人会以为只有挑出来的那几组是问题。
    allGroups: GROUPS.map((g) => ({ name: g.name, question: g.question })),
    groups: groupStats,
    inputs,
    sanitization: {
      rule: '白名单：卡面只保留 name / family / facet / tags / produces / consumes / skillDigest',
      excludedBecauseNotVisibleToAiJudge: ['ownerUserId', 'ownerDisplayName', 'orgId'],
      excludedBecauseTheyLeakTheAnswer: [
        'kind',
        'isTwin',
        'initDependency',
        'initSimilarity',
        'contractDependency',
        'contractSimilarity',
        'humanDependency',
        'humanSimilarity',
        'capabilityGap',
        'school',
        'split',
      ],
    },
  };

  writeJsonl(join(OUT_DIR, 'cards.jsonl'), blindCards);
  writeJsonl(join(OUT_DIR, 'answer_key.jsonl'), answerKey);
  writeFileSync(join(OUT_DIR, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  writeFileSync(join(OUT_DIR, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`, 'utf8');

  // 页数估计按「每对 45 秒」算：一对要看两份画像、给两个分。宁可高估。
  const minutes = Math.ceil((blindCards.length * 45) / 60);
  writeFileSync(
    join(OUT_DIR, 'README.zh-CN.md'),
    annotatorReadme({ cardCount: blindCards.length, minutes }),
    'utf8',
  );
  writeFileSync(
    join(OUT_DIR, 'COORDINATOR.zh-CN.md'),
    coordinatorReadme({ selection, groupStats, inputs }),
    'utf8',
  );

  console.log(`已写出 ${OUT_DIR}`);
  console.log(`  卡片 ${blindCards.length} 张，按 ${groupStats.filter((g) => g.picked > 0).length} 组分层`);
  for (const g of groupStats) {
    console.log(`    ${g.name.padEnd(34)} 池 ${String(g.poolSize).padStart(5)} → 取 ${String(g.picked).padStart(3)}`);
  }
  console.log(`  预计人工用时约 ${minutes} 分钟`);
}

main();
