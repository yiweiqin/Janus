/**
 * 导入闸的测试。重点是三类**静默通过**的坏输入：
 *
 *   1. 缺分（`null`）—— 老代码 `Number(null) === 0`，会被当成"打了 0 分"存下去；
 *   2. 一份文件里同一个人对同一个 pair 交两次、分数还不一样；
 *   3. 重导同一份文件 —— 必须一个字节都不改，否则"跑过了"和"跑过了但是空转"分不清。
 *
 * 这三类都不会报错、不会崩、报告都写"成功"，所以只能靠测试盯。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyLabels } from './apply_labels.mjs';
import { LABEL_SOURCE_AI_REVIEWER, importAiLabels, quantizeScore, validateAiRow } from './import_ai_labels.mjs';
import { prelabelPair } from './prelabel.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpdb-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return file;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 一个"外部 AI 判分包"的最小世界：两张 #1/#2 可判、一张 #3 不存在于 pairs。 */
function fixture(t) {
  const dir = tmp(t);
  const pairs = [
    { id: 'pair-1', kind: 'cross_owner_complement', split: 'test', initDependency: 0.75, initSimilarity: 0.25 },
    { id: 'pair-2', kind: 'cross_owner_similar', split: 'test', initDependency: 0.5, initSimilarity: 0.75 },
    { id: 'pair-3', kind: 'hard_negative', split: 'development', initDependency: 0.25, initSimilarity: 0.25 },
  ];
  const pairsPath = writeJsonl(path.join(dir, 'pairs.jsonl'), pairs);
  const outPath = path.join(dir, 'ai_labels.jsonl');
  const existingLabelsPath = writeJsonl(path.join(dir, 'human_labels.jsonl'), []);
  return { dir, pairsPath, outPath, existingLabelsPath, labelsPath: (name, rows) => writeJsonl(path.join(dir, name), rows) };
}

const ROW = (over = {}) => ({ id: 'pair-1', reviewerId: 'ai-judge-a', role: 'reviewer', dependency: 0.75, similarity: 0.25, rationale: 'x', ...over });

test('quantizeScore：缺失/空串/布尔/NaN 都不是 0 分', () => {
  // 这一条是整件事的根：`Number(null) === 0`。
  assert.equal(quantizeScore(null), null);
  assert.equal(quantizeScore(undefined), null);
  assert.equal(quantizeScore(''), null);
  assert.equal(quantizeScore('   '), null);
  assert.equal(quantizeScore(true), null);
  assert.equal(quantizeScore(false), null);
  assert.equal(quantizeScore(NaN), null);
  assert.equal(quantizeScore('abc'), null);
  assert.equal(quantizeScore([]), null);
  assert.equal(quantizeScore({}), null);
  assert.equal(quantizeScore(Infinity), null);

  // 反向对照：合法的必须过，否则上面全 null 也能"绿"。
  assert.equal(quantizeScore(0), 0);
  assert.equal(quantizeScore('0'), 0);
  assert.equal(quantizeScore(0.25), 0.25);
  assert.equal(quantizeScore(0.3), null, '离最近档超过 0.001 必须判无效，不能四舍五入');
  assert.equal(quantizeScore(0.2504), 0.25);
  assert.equal(quantizeScore(1), 1);
  assert.equal(quantizeScore(1.2), null);
});

test('validateAiRow：缺分不会静默变 0 分', () => {
  const known = new Set(['pair-1', 'pair-2']);
  const missing = validateAiRow(ROW({ similarity: null }), { knownPairIds: known });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'both_scores_required');
  assert.ok(!('row' in missing) || !missing.row, '被拒的行不能带 row，否则调用方可能顺手用上');

  const zero = validateAiRow(ROW({ dependency: 0, similarity: 0 }), { knownPairIds: known });
  assert.equal(zero.ok, true, '0 是合法档位，必须能过');
  assert.equal(zero.row.dependency, 0);
});

test('validateAiRow：契约禁项与保留前缀', () => {
  const known = new Set(['pair-1']);
  assert.equal(validateAiRow(ROW({ combined: 0.5 }), { knownPairIds: known }).code, 'combined_score_forbidden');
  // 契约里 `combined: null` 是"值无害但键名违规"，这里连 null 都拒。
  assert.equal(validateAiRow(ROW({ combined: null }), { knownPairIds: known }).code, 'combined_score_forbidden');
  assert.equal(validateAiRow(ROW({ reviewerId: 'prelabel_v2' }), { knownPairIds: known }).code, 'reserved_reviewer_id');
  assert.equal(validateAiRow(ROW({ reviewerId: '' }), { knownPairIds: known }).code, 'id_annotator_required');
  assert.equal(validateAiRow(ROW({ id: 'pair-404' }), { knownPairIds: known }).code, 'card_not_found');
  assert.equal(validateAiRow(ROW({ role: 'supervisor' }), { knownPairIds: known }).code, 'bad_role');
  // annotatorId 仍作 legacy 回退
  const legacy = validateAiRow(ROW({ reviewerId: undefined, annotatorId: 'ai-legacy' }), { knownPairIds: known });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.row.reviewerId, 'ai-legacy');
});

test('validateAiRow：仲裁只在真分歧时合法', () => {
  const known = new Set(['pair-1']);
  const adjudicator = ROW({ role: 'adjudicator', reviewerId: 'ai-judge-c' });
  const refused = validateAiRow(adjudicator, { knownPairIds: known, needsAdjudication: new Set() });
  assert.equal(refused.code, 'not_in_adjudication');
  const allowed = validateAiRow(adjudicator, { knownPairIds: known, needsAdjudication: new Set(['pair-1']) });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.row.labelSource, 'ai_adjudicator');
  assert.equal(validateAiRow(ROW(), { knownPairIds: known }).row.labelSource, LABEL_SOURCE_AI_REVIEWER);
});

test('importAiLabels：坏行逐条报出来，好行照收', (t) => {
  const f = fixture(t);
  const dir = f.dir;
  // 手写文件：混入一行语法坏掉的 JSON 和一行裸标量 —— 这两类以前会被静默丢掉。
  const labels = path.join(dir, 'in.jsonl');
  fs.writeFileSync(labels, [
    JSON.stringify(ROW({ id: 'pair-1', reviewerId: 'ai-a' })),
    JSON.stringify(ROW({ id: 'pair-2', reviewerId: 'ai-a', dependency: 0.5, similarity: 0.75 })),
    JSON.stringify(ROW({ id: 'pair-2', reviewerId: 'ai-b', dependency: 0.5, similarity: null })),      // 缺分
    JSON.stringify(ROW({ id: 'pair-404', reviewerId: 'ai-b' })),                                        // 不存在的卡
    JSON.stringify(ROW({ id: 'pair-1', reviewerId: 'prelabel_v9' })),                                   // 保留前缀
    JSON.stringify(ROW({ id: 'pair-2', reviewerId: 'ai-c', combined: 0.9 })),                           // 禁项
    '"not-an-object"',                                                                                  // 裸标量
    '{"id": "pair-1", broken json',                                                                     // 语法坏掉
  ].join('\n') + '\n', 'utf8');

  const report = importAiLabels({ labelsPath: labels, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });

  assert.equal(report.accepted, 2);
  assert.equal(report.rejected, 6, '四类校验失败 + 两类坏行，必须一条不漏地报出来');
  assert.deepEqual(report.rejectedByCode, {
    both_scores_required: 1, card_not_found: 1, reserved_reviewer_id: 1, combined_score_forbidden: 1,
    row_not_object: 1, line_not_json: 1,
  });
  // 行号必须是真的源文件行号（坏行跳过之后不能错位）。
  assert.equal(report.rejectedSample.find((item) => item.code === 'line_not_json').line, 8);
  assert.equal(report.rejectedSample.find((item) => item.code === 'both_scores_required').line, 3);
  assert.equal(report.written, true);
  assert.equal(report.outRows, 2);
  // 被拒的行绝不能落盘。
  const rows = readJsonl(f.outPath);
  assert.deepEqual(rows.map((row) => `${row.id}/${row.reviewerId}`).sort(), ['pair-1/ai-a', 'pair-2/ai-a']);
  assert.ok(rows.every((row) => row.labelSource === 'ai_reviewer'));
  // 外部 AI 只判分、不回抄元数据：kind/split 要从 pairs.jsonl 补齐。
  assert.equal(rows.find((row) => row.id === 'pair-2').kind, 'cross_owner_similar');
  assert.equal(rows.find((row) => row.id === 'pair-1').split, 'test');
  assert.equal(rows.find((row) => row.id === 'pair-1').status, undefined, 'status 是派生量，不该被写进存储');
});

test('importAiLabels：同名 reviewer 冲突分要拒，一致分只算一次', (t) => {
  const f = fixture(t);
  const conflicting = f.labelsPath('conflict.jsonl', [
    ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.75 }),
    ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.25 }),
  ]);
  let report = importAiLabels({ labelsPath: conflicting, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });
  assert.equal(report.accepted, 1);
  assert.equal(report.rejectedByCode.duplicate_reviewer_conflict, 1);

  const identical = f.labelsPath('identical.jsonl', [ROW({ id: 'pair-2', reviewerId: 'ai-b' }), ROW({ id: 'pair-2', reviewerId: 'ai-b' })]);
  report = importAiLabels({ labelsPath: identical, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });
  assert.equal(report.accepted, 1);
  assert.equal(report.duplicateNoop, 1);
});

test('importAiLabels：重导同一份文件不改盘上一个字节（幂等）', (t) => {
  const f = fixture(t);
  const labels = f.labelsPath('in.jsonl', [ROW({ id: 'pair-1', reviewerId: 'ai-a' }), ROW({ id: 'pair-2', reviewerId: 'ai-a', dependency: 0.5, similarity: 0.75 })]);

  const first = importAiLabels({ labelsPath: labels, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });
  const digest = sha(f.outPath);
  const second = importAiLabels({ labelsPath: labels, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });

  assert.equal(first.written, true);
  assert.equal(second.written, false, '第二遍不该再写盘');
  assert.equal(second.accepted, 0);
  assert.equal(second.duplicateNoop, 2);
  assert.equal(sha(f.outPath), digest, '文件内容变了 = 不幂等');
});

test('importAiLabels：已有的同名 reviewer 换了分默认拒绝，--overwrite 才覆盖', (t) => {
  const f = fixture(t);
  const v1 = f.labelsPath('v1.jsonl', [ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.75 })]);
  importAiLabels({ labelsPath: v1, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });

  const v2 = f.labelsPath('v2.jsonl', [ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.25 })]);
  let report = importAiLabels({ labelsPath: v2, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });
  assert.equal(report.rejectedByCode.reviewer_already_labeled, 1);
  assert.equal(readJsonl(f.outPath)[0].dependency, 0.75, '默认不能悄悄改掉已经收下的判定');

  report = importAiLabels({ labelsPath: v2, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, overwrite: true, bundlePath: path.join(f.dir, 'nope.json') });
  assert.equal(report.accepted, 1);
  assert.equal(readJsonl(f.outPath)[0].dependency, 0.25);
});

test('导入的 AI 判分在 applyLabels 里出得来（labelSource 可分辨，不与人工混算）', (t) => {
  const f = fixture(t);
  // 两名外部 AI 独立判 pair-1 且完全一致 → 应成 `agreed`，是金标。
  const labels = f.labelsPath('in.jsonl', [
    ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.75, similarity: 0.25 }),
    ROW({ id: 'pair-1', reviewerId: 'ai-b', dependency: 0.75, similarity: 0.25 }),
    // pair-2 两名 AI 不一致 → needs_adjudication，不是金标，不该被导出成 gold。
    ROW({ id: 'pair-2', reviewerId: 'ai-a', dependency: 0.5 }),
    ROW({ id: 'pair-2', reviewerId: 'ai-b', dependency: 0.25, similarity: 0.75 }),
  ]);
  importAiLabels({ labelsPath: labels, outPath: f.outPath, pairsPath: f.pairsPath, existingLabelsPath: f.existingLabelsPath, bundlePath: path.join(f.dir, 'nope.json') });

  const merged = path.join(f.dir, 'merged.jsonl');
  const report = applyLabels({ pairsPath: f.pairsPath, labelsPaths: [f.outPath], outPath: merged });
  assert.equal(report.byStatus.agreed, 1, 'pair-1 两名 AI 完全一致 → agreed');
  assert.equal(report.byStatus.needs_adjudication, 1, 'pair-2 不一致 → 必须走仲裁，不能当金标');
  assert.equal(report.byLabelSource.ai_reviewer, 1);
  assert.equal(report.labeled, 1);

  const rows = readJsonl(merged);
  const gold = rows.find((row) => row.id === 'pair-1');
  assert.equal(gold.humanDependency, 0.75);
  assert.equal(gold.labelSource, 'ai_reviewer', '必须能和人工判分分开报');
  assert.ok(!rows.some((row) => 'combined' in row), '输出里不该再出现 combined 键');
  assert.equal(rows.find((row) => row.id === 'pair-2').labelStatus, 'needs_adjudication');
});

test('applyLabels：缺分不再静默当 0 分（老代码的宽容 bug）', (t) => {
  const f = fixture(t);
  const labels = f.labelsPath('in.jsonl', [
    // 两行都在，但第二行的 similarity 缺失。老代码 Number(null)===0 → 静默按 0 分存金标。
    ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.75, similarity: 0.25 }),
    ROW({ id: 'pair-1', reviewerId: 'ai-b', dependency: 0.75, similarity: null }),
  ]);
  // 直接喂给 applyLabels：它必须抛，而不是产出 similarity=0 的假金标。
  assert.throws(
    () => applyLabels({ pairsPath: f.pairsPath, labelsPaths: [labels], outPath: path.join(f.dir, 'merged.jsonl') }),
    /score_scale:1_rows:pair-1\/ai-b\(similarity\)/,
    '必须指出是哪一对、哪个人、哪个轴，否则修的人还得自己找',
  );
});

test('applyLabels：重复行被去重，不会把 rater 数算多造出假 agreed', (t) => {
  const f = fixture(t);
  // 同一个 reviewer 写了两遍（值不同）。不去重就会变成"两名 rater 不一致"→ 假 needs_adjudication；
  // 或者两遍一样 → 假 agreed。去重后只剩一条 → `single`。
  const labels = f.labelsPath('in.jsonl', [
    ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.75, similarity: 0.25 }),
    ROW({ id: 'pair-1', reviewerId: 'ai-a', dependency: 0.25, similarity: 0.25 }),
  ]);
  const report = applyLabels({ pairsPath: f.pairsPath, labelsPaths: [labels], outPath: path.join(f.dir, 'merged.jsonl') });
  assert.equal(report.byStatus.single, 1, '同一个人交两次是一个人，不是两个人');
  assert.equal(report.byStatus.agreed, 0);
  assert.equal(report.byStatus.needs_adjudication, 0);
});

test('预标行从不进 rater 池，且不带 combined 键', (t) => {
  const f = fixture(t);
  const labels = f.labelsPath('in.jsonl', [
    { id: 'pair-1', reviewerId: 'prelabel_v1', role: 'prelabel', dependency: 0.75, similarity: 0.25 },
    ROW({ id: 'pair-1', reviewerId: 'ai-a' }),
  ]);
  const report = applyLabels({ pairsPath: f.pairsPath, labelsPaths: [labels], outPath: path.join(f.dir, 'merged.jsonl') });
  assert.equal(report.byStatus.single, 1, 'prelabel 不算 rater，只有 1 个真 rater');
  assert.ok(!('combined' in prelabelPair({ id: 'x', leftFamily: 'code', rightFamily: 'writing', initDependency: 0.25, initSimilarity: 0.25 })));
});
