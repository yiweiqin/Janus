/**
 * 把外部 AI 的判分收回来的那道闸。
 *
 * 为什么不能直接调 `applyLabels`：`apply_labels.mjs` 的标尺检查是
 * `scale.has(Number(resolved.dependency))`，而 **`Number(null) === 0`** ——
 * 也就是说「这个 pair 没填分」会被静默当成「打了 0 分」。真的会抛的只有 NaN
 * 和超出标尺的值。缺分是这里最常见的坏输入，所以校验必须自己重做一遍，
 * 口径对齐 `annotate_server.py:parse_score` / `label()`（比 JS 侧严）。
 *
 * 这个脚本是**幂等**的：同一份判分导两次，第二遍不改盘上任何字节。
 * 否则「跑过了」和「跑失败了」在日志里长得一样。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ROLE_ADJUDICATOR,
  ROLE_REVIEWER,
  SCALE,
  agreementReport,
  indexReviews,
  isPrelabelRow,
  quantizeScore,
  resolvePair,
  reviewKey,
  reviewerIdOf,
  roleOf,
} from './lib/consensus.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** 出处标签：写进行里，供 `apply_labels` 出「AI 判分 vs 人工判分」对照表。 */
export const LABEL_SOURCE_AI_REVIEWER = 'ai_reviewer';
export const LABEL_SOURCE_AI_ADJUDICATOR = 'ai_adjudicator';

/**
 * 严格分数量化 —— 口径的唯一来源在 `lib/consensus.mjs`，这里转出去方便调用方使用
 * （两侧各写一份必然会漂）。
 */
export { quantizeScore };

/**
 * 校验一行外部判分。返回 `{ ok: true, row }` 或 `{ ok: false, code, detail }`。
 *
 * 错误码刻意与 `annotate_server.py` 同名，这样两侧的日志可以直接对照。
 */
export function validateAiRow(raw, { knownPairIds, needsAdjudication = new Set(), allowUnneededAdjudication = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('row_not_object');
  const id = String(raw.id ?? '').trim();
  const reviewer = String(raw.reviewerId ?? raw.annotatorId ?? '').trim();
  const role = String(raw.role ?? ROLE_REVIEWER).trim() || ROLE_REVIEWER;

  if (!id || !reviewer) return fail('id_annotator_required', { id, reviewer });
  if (reviewer.startsWith('prelabel')) return fail('reserved_reviewer_id', { reviewer });
  if (role !== ROLE_REVIEWER && role !== ROLE_ADJUDICATOR) return fail('bad_role', { role });
  if (!knownPairIds.has(id)) return fail('card_not_found', { id });

  // 契约禁止合成总分。Python 侧只拒「非 null」，这里更严：**键存在就拒**，
  // 因为 `prelabel.mjs` 曾经给每一行都写上 `combined: null`，值无害但会被人照抄。
  if ('combined' in raw && raw.combined !== undefined) return fail('combined_score_forbidden', { id, value: raw.combined });
  if ('combinedScore' in raw && raw.combinedScore !== undefined) return fail('combined_score_forbidden', { id, value: raw.combinedScore });

  const dependency = quantizeScore(raw.dependency);
  const similarity = quantizeScore(raw.similarity);
  if (dependency === null || similarity === null) {
    return fail('both_scores_required', { id, dependency: raw.dependency ?? null, similarity: raw.similarity ?? null });
  }

  if (role === ROLE_ADJUDICATOR && !allowUnneededAdjudication && !needsAdjudication.has(id)) {
    // 对齐 `annotate_server.py` 的 `not_in_adjudication`：仲裁只在真分歧时合法，
    // 否则「第三个人」会被用来掩盖前两份判断的不一致。
    return fail('not_in_adjudication', { id });
  }

  return {
    ok: true,
    row: {
      id,
      reviewerId: reviewer,
      role,
      dependency,
      similarity,
      rationale: String(raw.rationale ?? '').trim(),
      // `status` 是派生量，不是输入（`consensus.mjs:118` 的 resolvePair 从不读它）。
      // 这里只做「传了不一致的值就报出来」，不落盘。
      split: String(raw.split ?? '').trim(),
      kind: String(raw.kind ?? '').trim(),
      labelSource: role === ROLE_ADJUDICATOR ? LABEL_SOURCE_AI_ADJUDICATOR : LABEL_SOURCE_AI_REVIEWER,
      at: String(raw.at ?? '').trim() || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  };
}

function fail(code, detail = {}) {
  return { ok: false, code, detail };
}

export function importAiLabels({
  labelsPath = '',
  outPath = join(ROOT, 'data/full/ai_labels.jsonl'),
  pairsPath = join(ROOT, 'data/full/pairs.jsonl'),
  existingLabelsPath = join(ROOT, 'data/full/human_labels.jsonl'),
  bundlePath = join(ROOT, 'export/ai-judge-v1/BUNDLE.json'),
  allowUnneededAdjudication = false,
  overwrite = false,
  quiet = false,
} = {}) {
  if (!labelsPath) throw new Error('labelsPath_required');
  const absoluteLabels = resolve(labelsPath);
  if (!existsSync(absoluteLabels)) throw new Error(`labels_file_not_found:${absoluteLabels}`);

  const pairs = readJsonlAny(pairsPath);
  const knownPairIds = new Set(pairs.map((pair) => pair.id));
  const kindById = new Map(pairs.map((pair) => [pair.id, String(pair.kind || '')]));
  const splitById = new Map(pairs.map((pair) => [pair.id, String(pair.split || '')]));

  // 已有的行（人工 + 之前导入的 AI）决定两件事：仲裁是否合法、以及这次导入是否真的是幂等的。
  const existing = [...readJsonlAny(existingLabelsPath), ...readJsonlAny(outPath)]
    .filter((row) => row && row.id && !isPrelabelRow(row));
  const existingIndex = indexReviews(existing);

  // 仲裁只在「已有的两份独立判断真不一致」时合法。
  const needsAdjudication = new Set();
  for (const [id, rows] of existingIndex) {
    if (resolvePair(rows).status === 'needs_adjudication') needsAdjudication.add(id);
  }

  const incomingFile = readJsonlWithErrors(absoluteLabels);
  const incoming = incomingFile.rows;
  const accepted = [];
  // 语法坏掉的行没有内容可校验，但必须和校验失败的行一起计数、一起报，否则
  // `rejected: 0` 会在有坏行时依然是 0。
  const rejected = incomingFile.badLines.map((item) => ({ ...item, detail: {} }));
  const seen = new Map();
  let duplicateNoop = 0;

  for (const [offset, raw] of incoming.entries()) {
    const lineNumber = incomingFile.lineNumbers[offset];
    const verdict = validateAiRow(raw, { knownPairIds, needsAdjudication, allowUnneededAdjudication });
    if (!verdict.ok) {
      rejected.push({ line: lineNumber, code: verdict.code, detail: verdict.detail });
      continue;
    }
    const row = verdict.row;
    // 缺 `kind` / `split` 时用 pairs.jsonl 补齐：外部 AI 只判分，没义务回抄元数据。
    if (!row.split) row.split = splitById.get(row.id) || '';
    if (!row.kind) row.kind = kindById.get(row.id) || '';

    const key = reviewKey(row);
    const first = seen.get(key);
    if (first) {
      // 同一份文件里同一个人对同一个 pair 交了两次：分数一致就当一次，不一致必须报，
      // 否则"导入成功"的到底是哪一份就成了运气问题。
      if (first.dependency === row.dependency && first.similarity === row.similarity) {
        duplicateNoop += 1;
        continue;
      }
      rejected.push({ line: lineNumber, code: 'duplicate_reviewer_conflict', detail: { id: row.id, reviewerId: row.reviewerId } });
      continue;
    }
    seen.set(key, row);

    const previous = existingIndex.get(row.id)?.find((existingRow) => reviewerIdOf(existingRow) === reviewerIdOf(row)) || null;
    if (previous) {
      if (Number(previous.dependency) === row.dependency && Number(previous.similarity) === row.similarity) {
        duplicateNoop += 1; // 幂等：导两次，第二次是空操作。
        continue;
      }
      if (!overwrite) {
        rejected.push({ line: lineNumber, code: 'reviewer_already_labeled', detail: { id: row.id, reviewerId: row.reviewerId } });
        continue;
      }
    }
    accepted.push(row);
  }

  const rows = [...existing, ...accepted];
  const index = indexReviews(rows);
  const report = {
    labelsPath: absoluteLabels,
    outPath,
    incoming: incoming.length,
    accepted: accepted.length,
    rejected: rejected.length,
    duplicateNoop,
    rejectedByCode: tally(rejected.map((item) => item.code)),
    written: false,
    labelSources: tally(rows.map((row) => String(row.labelSource || (roleOf(row) === 'adjudicator' ? 'adjudicated' : 'human')))),
    reviewers: [...new Set(rows.map(reviewerIdOf).filter(Boolean))].sort(),
    statuses: tally([...index.values()].map((bucket) => resolvePair(bucket).status)),
    agreement: agreementReport({ reviewIndex: index, splitById }),
    agreementTest: agreementReport({ reviewIndex: index, splitById, split: 'test' }),
  };

  if (rejected.length) {
    report.rejectedSample = rejected.slice(0, 20);
  }

  // 幂等的关键：只有真的多出行时才写盘。
  if (accepted.length) {
    mkdirSync(dirname(outPath), { recursive: true });
    const merged = dedupeRows([...readJsonlAny(outPath), ...accepted]);
    writeFileSync(outPath, `${merged.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    report.written = true;
    report.outRows = merged.length;
    report.outSha256 = sha256(readFileSync(outPath));
  } else {
    report.outRows = readJsonlAny(outPath).length;
    report.outSha256 = existsSync(outPath) ? sha256(readFileSync(outPath)) : null;
  }

  // 出处：这批判分是对着哪个 bundle 做的。没有它，"重判"就没法回溯。
  if (existsSync(bundlePath)) {
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    report.bundle = { path: bundlePath, sha256: sha256(readFileSync(bundlePath)), cardCount: bundle.counts?.cards ?? null };
  }
  if (!quiet) report.note = report.written ? 'labels_written' : 'no_change';
  return report;
}

/** 同一 `(id, reviewerId)` 只留最后一条 —— `annotate_server.py` 的 `self.rows[key] = row` 就是这个语义。 */
function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (!row || !row.id) continue;
    byKey.set(reviewKey(row), row);
  }
  return [...byKey.values()];
}

function readJsonlAny(path) {
  return readJsonlWithErrors(path).rows;
}

/**
 * 读 JSONL，并把**坏行报出来**。
 *
 * 之前这里是 `catch { return [] }` + `typeof parsed === 'object' ? [parsed] : []` ——
 * 一行语法坏掉的 JSON、或一行裸标量，会被静默丢掉。加上「坏行必须逐条报出来」
 * 这条需求之后，静默丢弃就等于让 `rejected: 0` 撒谎，所以这里要连错误一起返回。
 */
function readJsonlWithErrors(path) {
  if (!path || !existsSync(path)) return { rows: [], badLines: [] };
  const rows = [];
  const badLines = [];
  const lineNumbers = [];
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [offset, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines.push({ line: offset + 1, code: 'line_not_json' });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badLines.push({ line: offset + 1, code: 'row_not_object' });
      continue;
    }
    rows.push(parsed);
    lineNumbers.push(offset + 1);
  }
  return { rows, badLines, lineNumbers };
}

function tally(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((token) => token.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  return fallback;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const labelsPath = arg('labels', arg('in', ''));
  if (!labelsPath) {
    console.error('用法: node import_ai_labels.mjs --labels <AI 判分文件.jsonl> [--out data/full/ai_labels.jsonl] [--overwrite] [--allow-unneeded-adjudication]');
    process.exit(2);
  }
  const report = importAiLabels({
    labelsPath,
    outPath: arg('out', join(ROOT, 'data/full/ai_labels.jsonl')),
    overwrite: process.argv.includes('--overwrite'),
    allowUnneededAdjudication: process.argv.includes('--allow-unneeded-adjudication'),
  });
  console.log(JSON.stringify(report, null, 2));
  // 有被拒的行就非零退出：静默吞掉坏输入等于让"导入成功"这句话不可信。
  if (report.rejected) process.exit(1);
}
