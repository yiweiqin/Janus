// 交付包的验收测试：**"完备"和"能直接接入"这两句话必须有东西在守。**
//
// 这一份不测精度（那是 `scorer.test.mjs` 与诊断轮的事），它测的是**交付承诺**：
//
//   1. 训练集是完整的 —— README 里列的每个文件都在，矩阵自述的维度/行数与文件大小对得上；
//   2. 交付产物与训练集是**绑在一起**的 —— manifest 里的哈希与磁盘上的实际文件一致；
//   3. 接入口真的能加载它 —— 用 `src/` 里的适配层加载，而不是靠实验脚本；
//   4. 报告里那几条"限制"仍然成立 —— 尤其是"标签库里没有人工标注"。
//
// 第 4 条是这套东西最容易悄悄失真的地方：一旦有人补了人工标注，
// 诊断页与训练报告里"零人工标注"那段就不再成立，而**没有任何东西会失败**。
// 所以这里把它变成断言：补了人工标注，这个测试会红，提醒你去改那两段话。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  loadCapabilityScorer,
  scoredDependencyScore,
  scoredSelectReplacement,
  scoredSimilarityScore,
} from '../../src/shared/contracts/uBuddyCapabilityDependencyScorer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SHIP = join(ROOT, 'artifacts', 'cpdb-scorer-v3-ship');
const EXPORT = join(ROOT, 'exports', 'cpdb-training-set-v1');
// 两件事分开判：交付产物（`artifacts/cpdb-scorer-v3-ship/`）进库，训练集包
// （`exports/cpdb-training-set-v1/`）不进库 —— 后者与 `export/ai-judge-v1/` 同类，
// 是"发出去"的产物（~6MB 的 X.f32 / folds / labels 全是能重跑出来的派生量）。
// 所以干净克隆上会缺它，缺的时候**跳过并说明怎么重建**，而不是报一个假失败，
// 也不是把它塞进库来让测试变绿。
const HAVE_SHIP = existsSync(join(SHIP, 'manifest.json'));
const HAVE_EXPORT = existsSync(join(EXPORT, 'matrix.json'));
const skip = HAVE_SHIP ? false : '交付包还没生成（先跑 npm run experiment:cpdb-ship）';
const skipExport = HAVE_EXPORT
  ? false
  : '训练集包不在库中（它是交付品，不是派生锚点）。跑 `npm run experiment:cpdb-matrix` '
    + '生成 train_out_ai/，再跑 `npm run experiment:cpdb-ship` 重建。';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const readJsonl = (path) => readFileSync(path, 'utf8')
  .split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('交付清单自述的哈希与磁盘上的文件一致', { skip: skip || skipExport }, () => {
  const manifest = readJson(join(SHIP, 'manifest.json'));
  assert.equal(manifest.schema, 'cpdb_ship_manifest/v1');
  assert.equal(manifest.artifactId, 'cpdb-scorer-v3-ship');
  // 默认打分器必须是写死的那个。如果这里变成 undefined 或跟着目录内容漂移，
  // 线上行为就会随打包内容变化，而两种分数的口径不同（一个折上泛化、一个拟合）。
  assert.equal(manifest.defaultScorer, 'table');
  assert.ok(manifest.reason && manifest.reason.length > 40, '为什么交付表必须写下来，否则下次没人知道能不能换');

  for (const [name, described] of Object.entries(manifest.trainingSet.files)) {
    const path = join(EXPORT, name);
    assert.ok(existsSync(path), `训练集缺少 ${name}`);
    const actual = statSync(path).size;
    assert.equal(actual, described.bytes, `${name} 的字节数与 manifest 不符`);
    assert.equal(sha256(path), described.sha256, `${name} 的 sha256 与 manifest 不符`);
  }

  assert.equal(sha256(join(SHIP, 'table.json')), manifest.artifacts.table.sha256);
  if (manifest.artifacts.model) {
    assert.equal(sha256(join(SHIP, 'model', 'weights.json')), manifest.artifacts.model.sha256);
  }
});

test('训练集是自洽的：行数、维度、折、标签四者对得上', { skip: skip || skipExport }, () => {
  const spec = readJson(join(EXPORT, 'matrix.json'));
  const rows = readJsonl(join(EXPORT, 'rows.jsonl'));
  const folds = readJsonl(join(EXPORT, 'folds.jsonl'));
  const labels = readJsonl(join(EXPORT, 'labels.jsonl'));

  assert.equal(rows.length, spec.rows);
  // 折与标签必须与 rows **同长同序**：不同序会让每一行的标签与本行错配，
  // 而错配之后指标只是"变差一点"，看不出来。
  assert.equal(folds.length, spec.rows);
  assert.equal(labels.length, spec.rows);
  for (let at = 0; at < spec.rows; at += 1) {
    assert.equal(folds[at].id, rows[at].id, `第 ${at} 行 folds 与 rows 的 id 不一致`);
    assert.equal(labels[at].id, rows[at].id, `第 ${at} 行 labels 与 rows 的 id 不一致`);
  }

  // X.f32 的大小必须精确等于 n × d × 4，否则读出来的特征会整体错位一行。
  const bytes = statSync(join(EXPORT, 'X.f32')).size;
  assert.equal(bytes, spec.rows * spec.dimension * 4, 'X.f32 的大小与 n×d×4 不符');
  assert.equal(statSync(join(EXPORT, 'y_dependency.i8')).size, spec.rows);
  assert.equal(statSync(join(EXPORT, 'y_similarity.i8')).size, spec.rows);

  // 四种折都要在，且每一种的每折都**非空**：空的折会让准确率算成 0 或 NaN，
  // 而在报告里看起来像一个"很差的结果"，而不是"折没定义好"。
  for (const [scheme, described] of Object.entries(spec.folds)) {
    const seen = new Set();
    for (const row of folds) for (const fold of row[scheme] || []) seen.add(fold);
    assert.equal(seen.size, described.k, `${scheme} 折数不对`);
  }

  // 取值必须落在 scale 里，否则 `labelIndex` 会变成 -1，静默错配到最后一档。
  for (let at = 0; at < spec.rows; at += 1) {
    assert.ok(spec.scale.includes(labels[at].dependency), `第 ${at} 行的 dependency 不在 scale 里`);
    assert.ok(spec.scale.includes(labels[at].similarity), `第 ${at} 行的 similarity 不在 scale 里`);
  }
});

test('接入口加载的是交付产物，且分数直接可用', { skip }, () => {
  const scorer = loadCapabilityScorer(SHIP);
  assert.equal(scorer.kind, 'table');
  assert.equal(scorer.keyKind, 'family_pair');

  const planner = { uBuddyAgentInstanceId: 'p', extra: { familyId: 'research', facetId: 'research.web' } };
  const writer = { uBuddyAgentInstanceId: 'w', extra: { familyId: 'writing', facetId: 'writing.copy' } };
  const scorerOnly = { uBuddyAgentInstanceId: 's', extra: { familyId: 'review', facetId: 'review.audit' } };

  const dependency = scoredDependencyScore(scorer, planner, writer);
  const similarity = scoredSimilarityScore(scorer, planner, writer);
  for (const value of [dependency, similarity]) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  }
  // 契约的两条硬约束在这里再验一次：分数分开、自依赖为零。
  assert.equal(scoredDependencyScore(scorer, planner, planner), 0);

  const swapped = scoredSelectReplacement(scorer, planner, [planner, writer, scorerOnly], { limit: 2 });
  assert.equal(swapped.length, 2);
  assert.ok(swapped.every((item) => item.profile.agentId !== 'p'), '换人列表里出现了失败的 Agent 自己');
  for (let at = 1; at < swapped.length; at += 1) {
    assert.ok(swapped[at - 1].score >= swapped[at].score, '换人列表没有按分数降序');
  }
});

test('训练集 README 与目录实际内容一致', { skip: skip || skipExport }, () => {
  const readme = readFileSync(join(EXPORT, 'README.zh-CN.md'), 'utf8');
  // README 里点了名的文件必须在。这条防的是"README 还是上一版" ——
  // 那是交付包里最常见、也最容易被收件人当成事实的错误。
  for (const name of ['matrix.json', 'X.f32', 'y_dependency.i8', 'y_similarity.i8', 'rows.jsonl', 'folds.jsonl', 'labels.jsonl']) {
    assert.ok(readme.includes(name), `README 没有提到 ${name}`);
    assert.ok(existsSync(join(EXPORT, name)), `README 提到但目录里没有 ${name}`);
  }
  assert.ok(readme.includes('loadCapabilityScorer'), 'README 必须给出接进系统的代码入口');
  // 限制必须写进 README，而不是只留在 manifest 里 —— README 才是别人真正会读的那一份。
  for (const caveat of ['AI 生成', '措辞', '并列']) {
    assert.ok(readme.includes(caveat), `README 没有写清限制：${caveat}`);
  }
});

test('标签库里没有任何人工标注（报告里那两段话的出处）', { skip }, () => {
  const labels = readJsonl(join(ROOT, 'data', 'full', 'human_labels.jsonl'));
  assert.ok(labels.length > 0, '标签库是空的');
  const annotators = new Set();
  for (const row of labels) {
    for (const value of Object.values(row.annotators || {})) annotators.add(String(value));
    if (row.annotator) annotators.add(String(row.annotator));
    if (row.source) annotators.add(String(row.source));
  }
  const humanish = [...annotators].filter((name) => /human|adjudicat|person|manual/i.test(name) && !/prelabel/i.test(name));
  assert.deepEqual(
    humanish, [],
    `标签库里出现了人工/裁定标注（${humanish.join(', ')}）。这说明诊断页第六节与训练报告第七节里`
    + '「一条人工标注都没有」已经不成立 —— 请同步改那两段，并把"该信哪套标签"的结论重写。',
  );
});

test('诊断页与 manifest 的裁决不矛盾', { skip }, () => {
  const manifest = readJson(join(SHIP, 'manifest.json'));
  const diagnosisPath = join(ROOT, '..', '..', 'docs', 'ubuddy-v4-cpdb-scorer-diagnosis.zh-CN.md');
  assert.ok(existsSync(diagnosisPath), '诊断页不在 docs/ 下');
  const page = readFileSync(diagnosisPath, 'utf8');
  // 裁决是 ship_table，诊断页必须写着这个结论；否则两份文件的说法会各走各的。
  assert.ok(page.includes('ship_table'), '诊断页没有写出裁决 ship_table');
  assert.ok(page.includes('0.7816'), '诊断页没有写出裁决格上的表指标');
  // 判据必须是"事先写死"的那三条，且与代码里的常量逐字对应。
  // 从 `PRE_REGISTERED_CRITERIA = [ ... ]` 这一段里取，而不是全文件扫引号 ——
  // 全文件扫会把 `warning` / `note` 那类字符串也当成判据（第一版就是这么错的）。
  const source = readFileSync(join(ROOT, 'train_scorer.py'), 'utf8');
  const block = source.match(/PRE_REGISTERED_CRITERIA = \[([\s\S]*?)\n\]/);
  assert.ok(block, 'train_scorer.py 里找不到 PRE_REGISTERED_CRITERIA');
  const criteria = block[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*"(.+?)",\s*$/)?.[1])
    .filter(Boolean);
  assert.equal(criteria.length, 3, `事先写死的判据应当是 3 条，实际 ${criteria.length} 条`);
  for (const criterion of criteria) {
    assert.ok(page.includes(criterion), `诊断页没有逐字引用这条事先写死的判据：${criterion}`);
  }
  assert.equal(manifest.tableFoldMetrics.facet.similarity.mean, 0.7816);
});
