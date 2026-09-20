// 读回标完的卡，分别对 teacher 与 AI 两套口径算账，输出 `score.json`。
//
// 这个脚本**不替人下结论**。它把两组数字并排摆出来（每组一行、每个轴一行），
// 附上「人 vs teacher」和「人 vs AI」的相对高低，剩下的判断留给人。
// 之所以要这么克制：如果脚本直接宣布「人站在 AI 那边」，那它就成了第三个口径，
// 而这一轮的全部意义正是**不要再自己给自己判分**。
//
// 关键设计：**按分组分开报**。
// `agreement_control` 那一组两套口径本来就一致，谁都能「猜」对，会把总分抬虚。
// 真正有信息量的是 `same_family_*` 那三组 —— 它们才是两套口径对立的地方。
//
// 用法：
//   node experiments/cpdb_org_world/score_human_review.mjs --dir exports/cpdb-human-review-v1
//   node ... --dir <同一目录> --out score.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SCALE,
  agreementStats,
  mulberry32,
  normalizeScaleValue,
  quadraticWeightedKappa,
} from './lib/humanReviewSelect.mjs';

const AXES = ['dependency', 'similarity'];

function parseArgs(argv) {
  const out = { dir: null, out: null, simulate: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--simulate') out.simulate = String(argv[++i]);
  }
  if (!out.dir) throw new Error('用法：--dir exports/cpdb-human-review-v1');
  if (out.out === null) {
    out.out = out.simulate ? `score.simulated-${out.simulate}.json` : 'score.json';
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

/** 标注者可能填 `0.5`、`"0.5"`、`null`；只认能对上刻度的值，其余算未填。
 *  归一化本身在 `lib/humanReviewSelect.mjs` 里，被 `human_review.test.mjs` 断言 ——
 *  它是「填错会不会被悄悄修好」的唯一防线，不该只活在一个 CLI 里。 */
const normalize = normalizeScaleValue;

/** 自检用：把答案填成某套机器口径（或确定性噪声），用来证明算账链路是通的。
 *
 *  为什么值得有这个东西：这份脚本唯一一次真正跑起来是在人把卡填完之后，
 *  而那时若发现算错了，代价是**让人重标一遍**。`--simulate teacher` 必须给出
 *  teacher QWK = 1.000/AI QWK 明显更低，`--simulate ai` 必须给出镜像结果 ——
 *  这两个恒等式就是链路正确性的证据，而且不需要任何人参与。
 *
 *  噪声用固定 seed 的 PRNG，不用 `Math.random`：自检结果要能复现，否则报错时无从对账。 */
function simulateAnswers(policy, key) {
  const rng = mulberry32(0xc0ffee);
  return AXES.map((axis) => {
    if (policy === 'teacher') return key.machine.teacher[axis];
    if (policy === 'ai') return key.machine.ai[axis];
    if (policy === 'noise') return SCALE[Math.floor(rng() * SCALE.length)];
    throw new Error(`未知的 --simulate 取值：${policy}（可选 teacher / ai / noise）`);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);

  const cards = readJsonl(join(dir, 'cards.jsonl'));
  const key = readJsonl(join(dir, 'answer_key.jsonl'));
  const keyByCard = new Map(key.map((k) => [k.cardId, k]));

  const joined = [];
  const problems = [];
  for (const card of cards) {
    const k = keyByCard.get(card.cardId);
    if (!k) {
      problems.push({ cardId: card.cardId, issue: 'answer_key_missing' });
      continue;
    }
    let answer = card.answer ?? {};
    if (args.simulate) {
      const [dependency, similarity] = simulateAnswers(args.simulate, k);
      answer = { dependency, similarity, annotatorId: `simulated:${args.simulate}`, rationale: null };
    }
    const row = { cardId: card.cardId, id: k.id, group: k.group, human: {}, offScale: [] };
    for (const axis of AXES) {
      const { value, offScale } = normalizeScaleValue(answer[axis]);
      row.human[axis] = value;
      if (offScale) row.offScale.push(axis);
    }
    if (row.offScale.length > 0) problems.push({ cardId: card.cardId, issue: `off_scale:${row.offScale.join(',')}` });
    row.annotatorId = answer.annotatorId ?? null;
    row.rationale = answer.rationale ?? null;
    row.machine = k.machine;
    joined.push(row);
  }

  const answered = joined.filter((r) => AXES.every((a) => r.human[a] !== null));
  const annotators = [...new Set(joined.map((r) => r.annotatorId).filter(Boolean))];

  /** 每个分组 × 每个轴：人 vs teacher、人 vs AI。 */
  const byGroup = [];
  const groups = [...new Set(joined.map((r) => r.group))].sort();
  for (const group of groups) {
    const rows = answered.filter((r) => r.group === group);
    if (rows.length === 0) continue;
    const axes = {};
    for (const axis of AXES) {
      const human = rows.map((r) => r.human[axis]);
      const teacher = rows.map((r) => r.machine.teacher[axis]);
      const ai = rows.map((r) => r.machine.ai[axis]);
      axes[axis] = {
        n: rows.length,
        teacher: { ...agreementStats(human, teacher), qwk: quadraticWeightedKappa(human, teacher).qwk },
        ai: { ...agreementStats(human, ai), qwk: quadraticWeightedKappa(human, ai).qwk },
      };
    }
    byGroup.push({ group, n: rows.length, axes });
  }

  /** 全体合计。**只作参考** —— 会被 agreement_control 稀释，见文件头注释。 */
  const overall = {};
  for (const axis of AXES) {
    const human = answered.map((r) => r.human[axis]);
    const teacher = answered.map((r) => r.machine.teacher[axis]);
    const ai = answered.map((r) => r.machine.ai[axis]);
    overall[axis] = {
      n: answered.length,
      teacher: { ...agreementStats(human, teacher), qwk: quadraticWeightedKappa(human, teacher).qwk },
      ai: { ...agreementStats(human, ai), qwk: quadraticWeightedKappa(human, ai).qwk },
    };
  }

  /** 只在两套口径真刀真枪对立的那三组上做「更接近谁」的计数。
   *  这三组是文件头说的「有信息量」的部分，也是三种结论落点里前两种的判据。 */
  const decisiveGroups = ['same_family_dependency_opposed', 'same_family_similarity_ai_low', 'cross_family_dependency_opposed'];
  const decisive = { groupsUsed: decisiveGroups, perAxis: {} };
  for (const axis of AXES) {
    const rows = answered.filter((r) => decisiveGroups.includes(r.group));
    const human = rows.map((r) => r.human[axis]);
    const teacher = rows.map((r) => r.machine.teacher[axis]);
    const ai = rows.map((r) => r.machine.ai[axis]);
    // 注意：qwk 必须取自 `quadraticWeightedKappa` 的返回值 —— `agreementStats` 只给
    // 同档率/MAE，身上**没有** qwk 字段。这里踩过一次：读成 `undefined` 后
    // 所有比较都静默为 false，于是 1.000 vs 0.016 被判成了「tie」。
    const teacherQwk = quadraticWeightedKappa(human, teacher).qwk;
    const aiQwk = quadraticWeightedKappa(human, ai).qwk;
    decisive.perAxis[axis] = {
      n: rows.length,
      teacherQwk,
      aiQwk,
      closerTo:
        teacherQwk === null || aiQwk === null
          ? 'undecidable'
          : teacherQwk > aiQwk
            ? 'teacher'
            : aiQwk > teacherQwk
              ? 'ai'
              : 'tie',
    };
  }

  const policyPath = join(dir, 'policy.json');
  let policy = null;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    problems.push({ cardId: null, issue: 'policy_json_unreadable' });
  }

  const result = {
    scoredAt: new Date().toISOString(),
    dir,
    // 非 null 表示这份结果不是人给的，任何人都别拿它当结论。
    simulated: args.simulate ?? null,
    annotators,
    cardCount: cards.length,
    answeredCount: answered.length,
    unansweredCount: cards.length - answered.length,
    problems,
    byGroup,
    overall,
    decisive,
    policyAnswers: policy?.questions ?? null,
    policyNotes: policy?.notes ?? null,
    // 阈值不是判据，只是让人一眼看到「差得够不够大」。结论仍由 decisive.perAxis 决定。
    readingHint:
      '看 decisive.perAxis：qwk 差值绝对值 < 0.05 时 closerTo 不值得当结论，应回到 policy.json 的三个判断题。',
  };

  writeFileSync(join(dir, args.out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  // ---------------------------------------------------------------------
  // 人读的一屏。列宽固定，便于直接贴进对话或文档。
  //
  // 空值必须走 `fmt`：样本为 0 时 qwk 是 null（例如标注者只填了一轴、
  // 或整包用了别的刻度），此时打印 `.toFixed(3)` 会直接抛异常 —— 而
  // 「拿到一份填得不对的卡」正是最需要这份报告说话的时候。
  // ---------------------------------------------------------------------
  const fmt = (v, digits = 3) => (v === null || v === undefined ? '  —  ' : v.toFixed(digits));
  if (args.simulate) {
    // 这句话必须显眼：这些数字不是人给的，绝不能流进任何结论页。
    console.log(`！！！ 模拟运行：答案由 \`--simulate ${args.simulate}\` 生成，**不是人工标注**。`);
    console.log('');
  }
  console.log(`标注者：${annotators.length > 0 ? annotators.join('、') : '（未填 annotatorId）'}`);
  console.log(`已答 ${answered.length}/${cards.length} 张${problems.length > 0 ? `，${problems.length} 处问题` : ''}`);
  console.log('');
  console.log('分组明细（同档率 / ±0.25 / MAE / QWK）');
  console.log('  分组                                  轴          人vsteacher                人vsAI');
  for (const g of byGroup) {
    for (const axis of AXES) {
      const a = g.axes[axis];
      const cell = (s) =>
        `${s.exact === null ? '—' : `${(s.exact * 100).toFixed(0)}%`} / ${
          s.within25 === null ? '—' : `${(s.within25 * 100).toFixed(0)}%`
        } / ${fmt(s.mae, 2)} / ${fmt(s.qwk, 2)}`;
      console.log(`  ${g.group.padEnd(36)} ${axis.padEnd(11)} ${cell(a.teacher).padEnd(27)} ${cell(a.ai)}`);
    }
  }
  console.log('');
  console.log('全体合计（会被 agreement_control 稀释，仅供参考）');
  for (const axis of AXES) {
    const o = overall[axis];
    console.log(
      `  ${axis.padEnd(11)} n=${o.n}  teacher QWK ${fmt(o.teacher.qwk)}  |  AI QWK ${fmt(o.ai.qwk)}`,
    );
  }
  console.log('');
  console.log('关键三组（两套口径真正对立的地方）');
  for (const axis of AXES) {
    const d = decisive.perAxis[axis];
    console.log(
      `  ${axis.padEnd(11)} n=${d.n}  teacher QWK ${fmt(d.teacherQwk)}  AI QWK ${fmt(d.aiQwk)}  → 更接近：${d.closerTo}`,
    );
  }
  if (policy) {
    console.log('');
    console.log('policy.json 的三个判断题');
    for (const q of policy.questions) {
      console.log(`  ${q.answer === null ? '（未答）' : q.answer}  ${q.text}`);
    }
    if (policy.notes) console.log(`  备注：${policy.notes}`);
  }
  if (problems.length > 0) {
    console.log('');
    console.log('问题清单');
    for (const p of problems.slice(0, 20)) console.log(`  ${p.cardId ?? '(全局)'}  ${p.issue}`);
    if (problems.length > 20) console.log(`  …还有 ${problems.length - 20} 条`);
  }
  console.log('');
  console.log(`已写出 ${join(dir, args.out)}`);
}

main();
