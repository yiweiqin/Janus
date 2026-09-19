import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GOLD_STATUSES,
  ROLE_ADJUDICATOR,
  agreementReport,
  indexReviews,
  isPrelabelRow,
  quantizeScore,
  ratersOf,
  resolvePair,
  reviewKey,
  reviewerIdOf,
  roleOf,
} from './lib/consensus.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** 出处取值：`labelSource` 只在这几种里出现，出对照表时按它分组。 */
export const LABEL_SOURCE = Object.freeze({
  HUMAN: 'human',
  ADJUDICATED: 'adjudicated',
  AI_REVIEWER: 'ai_reviewer',
  AI_ADJUDICATOR: 'ai_adjudicator',
});

const KNOWN_LABEL_SOURCES = new Set(Object.values(LABEL_SOURCE));

/**
 * Export only resolved gold rows.
 *
 * `prelabel` and `needs_adjudication` are deliberately *not* exported: an AI
 * pre-label is not human supervision, and a disagreement has no gold value.
 * `single` / `agreed` / `adjudicated` are the three exportable statuses.
 *
 * `labelsPaths` 可以给多份（人工一份、导入的 AI 一份），合并后按 `(id, reviewerId)`
 * 去重 —— **去重必须在这里做**：`annotate_server.py:293-297` 只在它自己的 `Store`
 * 里去重，而 `apply_labels` 直接读文件。重复行会把 rater 数算多，造出假的 `agreed`。
 */
export function applyLabels({
  pairsPath = join(ROOT, 'data/full/pairs.jsonl'),
  labelsPath = '',
  labelsPaths = [],
  outPath = join(ROOT, 'data/full/pairs.labeled.jsonl'),
} = {}) {
  const sources = [...(labelsPaths || []), ...(labelsPath ? [labelsPath] : [])];
  const effectiveLabels = sources.length ? sources : [join(ROOT, 'data/full/human_labels.jsonl')];
  const pairs = readJsonl(pairsPath);
  const rows = dedupeRows(effectiveLabels.flatMap((path) => readJsonl(path)).filter((row) => row && row.id));
  assertEveryRowScorable(rows);
  const index = indexReviews(rows);
  const byStatus = {
    unlabeled: 0, prelabel: 0, single: 0, agreed: 0, needs_adjudication: 0, adjudicated: 0,
  };

  let labeled = 0;
  let agreeD = 0;
  let agreeS = 0;
  const byLabelSource = {};

  const merged = pairs.map((pair) => {
    const bucket = index.get(pair.id) || [];
    const resolved = resolvePair(bucket);
    if (resolved.status in byStatus) byStatus[resolved.status] += 1;
    if (!GOLD_STATUSES.includes(resolved.status)) {
      // 没有金标的行也照原样导出（外部要看到全貌），但 `combined` 一律去掉。
      if (resolved.status === 'needs_adjudication') return { ...dropCombined(pair), labelStatus: resolved.status };
      return dropCombined(pair);
    }
    // 严格标尺检查。原来这里是 `scale.has(Number(resolved.dependency))`，
    // 而 `Number(null) === 0` —— 缺分会静默变成 0 分而不报错。用 quantizeScore
    // 对齐 Python 侧 `parse_score`：缺失、NaN、越标尺一律抛。
    const dependency = quantizeScore(resolved.dependency);
    const similarity = quantizeScore(resolved.similarity);
    if (dependency === null || similarity === null) {
      throw new Error(`score_scale:${pair.id}:${JSON.stringify({ dependency: resolved.dependency ?? null, similarity: resolved.similarity ?? null })}`);
    }

    const winner = winningRow(bucket, resolved);
    const labelSource = labelSourceOf(resolved, winner);
    byLabelSource[labelSource] = (byLabelSource[labelSource] || 0) + 1;

    labeled += 1;
    if (dependency === Number(pair.initDependency)) agreeD += 1;
    if (similarity === Number(pair.initSimilarity)) agreeS += 1;
    // `combined` 从输出里彻底去掉：契约禁止合成总分，而这个键会暗示"这里本来该有个总分"。
    return {
      ...dropCombined(pair),
      humanDependency: dependency,
      humanSimilarity: similarity,
      annotatorId: resolved.reviewerId,
      reviewers: ratersOf(bucket).map(reviewerIdOf),
      labelStatus: resolved.status,
      labelSource,
      rationale: resolved.rationale || '',
    };
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${merged.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const report = {
    outPath,
    labelsPaths: effectiveLabels,
    labelRows: rows.length,
    pairs: pairs.length,
    labeled,
    unlabeled: pairs.length - labeled,
    byStatus,
    byLabelSource,
    teacherAgreement: {
      dependency: labeled ? round4(agreeD / labeled) : 0,
      similarity: labeled ? round4(agreeS / labeled) : 0,
    },
    agreement: agreementReport({ reviewIndex: index }),
    enoughForEval: byStatus.agreed + byStatus.adjudicated + byStatus.single >= 200,
    enoughForTrainHint: labeled >= 800,
    readyForEval: byStatus.agreed + byStatus.adjudicated > 0 && byStatus.needs_adjudication === 0,
  };
  writeFileSync(join(dirname(outPath), 'label_report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

/**
 * 在解析之前先把「打不出分的行」拦下来。
 *
 * 为什么不能只在 `resolvePair` 里兜：缺分会把这一对降级成 `needs_adjudication`，
 * 于是**坏输入伪装成合法的分歧**、悄悄进仲裁队列，报告里一切正常。导出路径是
 * 出评测集的地方，这里必须直接抛，并且指出是哪一行、哪个轴。
 */
function assertEveryRowScorable(rows) {
  const bad = [];
  for (const row of rows) {
    if (isPrelabelRow(row)) continue; // 预标不是 rater，缺分只会让它退化成"没有预标"
    const value = { dependency: quantizeScore(row.dependency), similarity: quantizeScore(row.similarity) };
    if (value.dependency === null || value.similarity === null) {
      bad.push(`${row.id}/${reviewerIdOf(row) || '?'}(${value.dependency === null ? 'dependency' : ''}${value.dependency === null && value.similarity === null ? '+' : ''}${value.similarity === null ? 'similarity' : ''})`);
    }
  }
  if (bad.length) {
    throw new Error(`score_scale:${bad.length}_rows:${bad.slice(0, 5).join(',')}`);
  }
}

/**
 * 找出 `resolvePair` 实际采信的那一行，用来读它的 `labelSource`。
 * 必须按 reviewerId 去找，不能按位置 —— `consensus.mjs` 的 `compareRows` 会按
 * role 排序，`raters[0]` 并不保证是「先写进来的那一条」。
 */
function winningRow(bucket, resolved) {
  const want = String(resolved.reviewerId || '').trim();
  if (want) {
    const hit = bucket.find((row) => reviewerIdOf(row) === want);
    if (hit) return hit;
  }
  const adjudicators = bucket.filter((row) => roleOf(row) === ROLE_ADJUDICATOR);
  if (resolved.status === 'adjudicated' && adjudicators.length) return adjudicators[adjudicators.length - 1];
  return ratersOf(bucket)[0] || null;
}

/**
 * 出处优先取行上显式写的 `labelSource`（导入侧会写），否则按状态推。
 * 这样"AI 判分"和"人工判分"在报告里是两条能分开看的线，而不是靠 reviewerId 猜。
 */
function labelSourceOf(resolved, row) {
  const explicit = String((row && row.labelSource) || '').trim();
  if (KNOWN_LABEL_SOURCES.has(explicit)) return explicit;
  return resolved.status === 'adjudicated' ? LABEL_SOURCE.ADJUDICATED : LABEL_SOURCE.HUMAN;
}

/** 去掉被契约禁止的 `combined` / `combinedScore` 键（值本来就是 null，问题在键名）。 */
function dropCombined(row) {
  if (!row || !('combined' in row) && !('combinedScore' in row)) return row;
  const { combined, combinedScore, ...rest } = row;
  return rest;
}

/**
 * 按 `(id, reviewerId)` 去重，保留最后一条（与 annotation server 的写入语义一致）。
 *
 * **预标行必须留下**：`resolvePair` 靠它给出 `prelabel` 状态；`indexReviews` 里少了它，
 * 这一对会掉成 `unlabeled`，报告整个状态都会被少算。它不是 rater，但它是状态的一部分。
 */
function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(reviewKey(row), row);
  return [...byKey.values()];
}

function readJsonl(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === 'object' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((token) => token.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  return fallback;
}

function argList(name) {
  const prefix = `--${name}=`;
  const out = [];
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith(prefix)) out.push(argv[index].slice(prefix.length));
    else if (argv[index] === `--${name}` && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      out.push(argv[index + 1]);
      index += 1;
    }
  }
  return out;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const report = applyLabels({
    labelsPaths: argList('labels'),
    labelsPath: arg('labels-file', ''),
    outPath: arg('out', join(ROOT, 'data/full/pairs.labeled.jsonl')),
  });
  console.log(JSON.stringify(report, null, 2));
}
