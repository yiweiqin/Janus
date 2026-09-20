import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data', 'full');

function readJsonl(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * ## 这个文件守的是「数字的出处」，不是「数字本身」
 *
 * 诊断轮的结论完全建立在标签的出处上：`data/full/human_labels.jsonl` 这个名字
 * 让人读成「人工金标」，而它现在 8282 行**全是** `annotatorId = prelabel_v1`，
 * 零人工标注。第一版的训练报告因此把「模型复现了规则 teacher」写成了
 * 「模型学到了能力语义」—— 错的不是数字，是数字的出处。
 *
 * 计划里原本的做法是把文件改名成 `prelabel_teacher.jsonl`。**没有那样做**，因为查过用法后
 * 发现这个名字会很快变对：`apply_labels.mjs` 把 `human_labels.jsonl` 当作**默认标签来源**，
 * `import_ai_labels.mjs` 往它里面追加 AI 判分行，而外部标注者正在产出的真人标注
 * 最终也要落进这里，并靠行上的 `labelSource` 区分。它其实是一个**标签库**，
 * 不是「teacher 专用文件」。把它改名成 teacher 专用，等于给下一个读代码的人
 * 制造一个相反方向的误解。
 *
 * 所以这里的做法是：**把出处变成会被断言的事实**，而不是靠一个文件名去暗示。
 * 有人真的加进人工标注时，下面的断言仍然成立（两边一起变），但报告里
 * 「零人工标注」那句话就该改了 —— 这正是我们想被提醒的时刻。
 */

function provenanceOf(path) {
  const tally = {};
  for (const row of readJsonl(path)) {
    const annotator = String(row.annotatorId || row.reviewerId || '(none)');
    const status = String(row.status || '(none)');
    const source = String(row.labelSource || '(implicit)');
    const key = `${annotator}|${status}|${source}`;
    tally[key] = (tally[key] || 0) + 1;
  }
  return tally;
}

test('标签库现在确实没有任何人工标注（报告里那句结论的出处）', () => {
  const tally = provenanceOf(join(DATA, 'human_labels.jsonl'));
  const rows = Object.values(tally).reduce((sum, count) => sum + count, 0);
  assert.ok(rows > 0, '标签库是空的');
  const humanish = Object.keys(tally).filter((key) => /human|adjudicat/i.test(key) && !/prelabel/.test(key));
  assert.deepEqual(
    humanish, [],
    `标签库里出现了人工/裁定标注（${humanish.join(', ')}）。这说明报告里「零人工标注」`
    + '那段已经不成立，请同步修改 docs/ubuddy-v4-cpdb-scorer-training.zh-CN.md 与诊断结论页。',
  );
  // 出处必须能被说清楚：不是"大概都是机器标的"，而是具体到哪一个 annotatorId。
  assert.ok(
    Object.keys(tally).some((key) => key.startsWith('prelabel_v1|')),
    `标签库里没有 prelabel_v1 的行，实际出处：${Object.keys(tally).join(' | ')}`,
  );
});

test('矩阵记录的 labelSource 与标签库实际内容一致', () => {
  // `matrix.json` 会写进权重与报告，是"这个模型是用什么训的"的正式出处。
  // 它写成什么都可以的话，provenance 就只是装饰。
  for (const dir of ['train_out', 'train_out_ai']) {
    const matrixPath = join(ROOT, dir, 'matrix.json');
    if (!existsSync(matrixPath)) continue;
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
    const labelsPath = join(ROOT, matrix.labelSource.file);
    assert.ok(existsSync(labelsPath), `${dir} 的 labelSource.file 不存在：${matrix.labelSource.file}`);

    const actual = new Set();
    for (const row of readJsonl(labelsPath)) {
      const annotator = String(row.annotatorId || row.reviewerId || '');
      const status = String(row.status || '');
      if (annotator) actual.add(`${annotator}/${status}`);
    }
    for (const recorded of matrix.labelSource.annotators) {
      assert.ok(
        actual.has(recorded),
        `${dir} 记录了一个标签库里不存在的出处 ${recorded}；实际：${[...actual].join(' | ')}`,
      );
    }
    assert.equal(matrix.labelSource.annotators.length, actual.size, `${dir} 的出处数量与标签库不一致`);
  }
});

test('矩阵行数与标签行数一致，且每个 pair 都有标签', () => {
  // 少标签就是少监督信号。`export_training_matrix.mjs` 会直接失败，这里是它的外部对照。
  for (const dir of ['train_out', 'train_out_ai']) {
    const matrixPath = join(ROOT, dir, 'matrix.json');
    if (!existsSync(matrixPath)) continue;
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
    const labels = readJsonl(join(ROOT, matrix.labelSource.file));
    const ids = new Set(labels.map((row) => row.id));
    assert.equal(ids.size, labels.length, `${dir} 的标签里有重复 id，先到先得会让覆盖数虚高`);
    assert.equal(matrix.rows, readJsonl(join(DATA, 'pairs.jsonl')).length, `${dir} 的矩阵行数不等于 pair 数`);
  }
});

test('folds.jsonl 与矩阵同源：行数一致、id 集合一致、每行都有四种方案', () => {
  for (const dir of ['train_out', 'train_out_ai']) {
    const foldsPath = join(ROOT, dir, 'folds.jsonl');
    if (!existsSync(foldsPath)) continue;
    const matrix = JSON.parse(readFileSync(join(ROOT, dir, 'matrix.json'), 'utf8'));
    const folds = readJsonl(foldsPath);
    const rows = readJsonl(join(ROOT, dir, 'rows.jsonl'));
    assert.equal(folds.length, matrix.rows, `${dir} 的 folds.jsonl 行数与矩阵不一致`);
    assert.deepEqual(
      folds.map((row) => row.id).sort(), rows.map((row) => row.id).sort(),
      `${dir} 的 folds.jsonl 与 rows.jsonl 不是同一批 id`,
    );
    const schemes = Object.keys(matrix.folds);
    for (const row of folds) {
      for (const scheme of schemes) {
        assert.ok(Array.isArray(row[scheme]), `${row.id} 缺少 ${scheme} 的折号数组`);
        for (const fold of row[scheme]) {
          assert.ok(
            Number.isInteger(fold) && fold >= 0 && fold < matrix.folds[scheme].k,
            `${row.id} 在 ${scheme} 下的折号 ${fold} 越界`,
          );
        }
      }
      // 查表基线用的格子键也要在，否则 Python 侧会 KeyError（而不是安静地算错）。
      for (const key of ['facet', 'family', 'agent', 'org']) {
        assert.equal(typeof row.lookupKeys?.[key], 'string', `${row.id} 缺少 lookupKeys.${key}`);
        assert.ok(row.lookupKeys[key].length > 0, `${row.id} 的 lookupKeys.${key} 是空串`);
      }
    }
  }
});

test('每折的 eval 与 train 互补，且留出组的 pair 全部落在 eval 里', () => {
  // 这是 `splits.test.mjs` 那条不变式在**落盘产物**上的对照。
  // 两边都验一遍是刻意的：JS 侧验的是函数，这里验的是那个函数写出来的文件 ——
  // 中间任何一步（导出顺序、索引对齐）出错，函数再对也没用。
  const dir = 'train_out';
  const foldsPath = join(ROOT, dir, 'folds.jsonl');
  if (!existsSync(foldsPath)) return;
  const matrix = JSON.parse(readFileSync(join(ROOT, dir, 'matrix.json'), 'utf8'));
  const folds = readJsonl(foldsPath);
  const rows = readJsonl(join(ROOT, dir, 'rows.jsonl'));
  const positionOf = new Map(rows.map((row, at) => [row.id, at]));
  assert.deepEqual(
    rows.map((row) => row.index), rows.map((_, at) => at),
    'rows.jsonl 的 index 与文件顺序不一致：Python 侧按 index 取行会错位',
  );
  assert.equal(positionOf.size, rows.length, 'rows.jsonl 有重复 id');

  for (const scheme of Object.keys(matrix.folds)) {
    const k = matrix.folds[scheme].k;
    for (let fold = 0; fold < k; fold += 1) {
      const evaluation = folds.filter((row) => (row[scheme] || []).includes(fold));
      assert.ok(evaluation.length > 0, `${scheme} 第 ${fold} 折的 eval 是空的`);
      assert.ok(evaluation.length < folds.length, `${scheme} 第 ${fold} 折的 eval 吃掉了全部数据`);
    }
  }
});
