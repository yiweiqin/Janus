/**
 * 导出包的三个不变量。**这个文件存在的理由是"泄题没有症状"** ——
 * 如果 test 的 teacher 分漏进了包里，包照样能生成、行数照样对、外部 AI 照样能判，
 * 只是我们最后拿到的判分没有意义。所以必须有一条测试专门盯它。
 *
 * 三条不变量：
 *   1. test 的 teacher 分（`initDependency` / `initSimilarity`）与模型基线分
 *      （`contractDependency` / `contractSimilarity`）**不在包里任何地方**；
 *   2. `combined` **这个键**在任何文件里都不出现（不是"值为 null"，是键不存在）；
 *   3. 输出可校验且可复现：哈希对得上，且同样输入跑两次得到同样的哈希。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exportBundle, verifyExport } from './export_bundle.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data', 'full');
const FIXED_AT = '2026-09-19T00:00:00.000Z';

const BLIND_FORBIDDEN = ['initDependency', 'initSimilarity', 'contractDependency', 'contractSimilarity', 'teacher'];

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  ));
}

/** 把包里所有 JSON/JSONL 摊平成对象列表，连同它出自哪个文件。 */
function objectsIn(out) {
  const found = [];
  for (const rel of walk(out)) {
    const text = fs.readFileSync(path.join(out, rel), 'utf8');
    const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
    const rows = rel.endsWith('.jsonl')
      ? text.split(/\r?\n/).filter(Boolean).map(parse)
      : [parse(text)];
    for (const row of rows) if (row) found.push({ rel, row });
  }
  return found;
}

function buildInto(t, { generatedAt = FIXED_AT } = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cpdb-bundle-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return { out, result: exportBundle({ out, dataDir: DATA, generatedAt }) };
}

test('test 的 teacher 分与模型基线分不在包里任何地方（盲标不被泄题）', async (t) => {
  const { out } = buildInto(t);
  const pairs = readJsonl(path.join(DATA, 'pairs.jsonl'));
  const testIds = new Set(pairs.filter((pair) => pair.split === 'test').map((pair) => pair.id));
  assert.equal(testIds.size, 799, 'test 规模变了：先确认这是有意为之，再改这条断言');

  const violations = [];
  for (const { rel, row } of objectsIn(out)) {
    if (!row.id || !testIds.has(row.id)) continue;
    for (const field of BLIND_FORBIDDEN) {
      if (row[field] !== undefined) violations.push(`${rel} ${row.id}.${field}=${JSON.stringify(row[field])}`);
    }
  }
  assert.deepEqual(violations, [], `test 的答案漏进了包里：\n${violations.slice(0, 10).join('\n')}`);

  // 反向对照：非 test 的参考分**必须**在（否则上面那条会因为"一个分都没有"而假绿）。
  const reference = readJsonl(path.join(out, 'reference', 'prelabel.jsonl'));
  assert.equal(reference.length, 7483, 'train+development 的参考行数不对');
  assert.ok(reference.every((row) => !testIds.has(row.id)), 'reference 里混进了 test 行');
  assert.ok(reference.every((row) => Number.isFinite(Number(row.dependency))), '参考分必须是数字');
});

test('pairs/pairs.jsonl：test 行扣掉四个分数键，非 test 行保留 teacher 与契约基线', async (t) => {
  const { out } = buildInto(t);
  const rows = readJsonl(path.join(out, 'pairs', 'pairs.jsonl'));
  const testRows = rows.filter((row) => row.split === 'test');
  const rest = rows.filter((row) => row.split !== 'test');
  assert.equal(testRows.length, 799);
  assert.equal(rest.length, 7483);
  for (const row of testRows) {
    assert.equal(row.scoresWithheld, true, 'test 行必须显式标出分数被扣掉，否则消费者会以为"这个 pair 没有分"');
    for (const field of BLIND_FORBIDDEN) assert.equal(row[field], undefined, `${row.id} 漏了 ${field}`);
  }
  for (const row of rest) {
    assert.equal(row.scoresWithheld, false);
    assert.ok(Number.isFinite(Number(row.initDependency)), `${row.id} 缺 teacher 依赖分`);
    assert.ok(Number.isFinite(Number(row.initSimilarity)), `${row.id} 缺 teacher 相似度`);
  }
});

test('`combined` 这个键在任何文件里都不出现（不是值为 null，是键不存在）', async (t) => {
  const { out } = buildInto(t);
  const offenders = [];
  for (const rel of walk(out)) {
    const text = fs.readFileSync(path.join(out, rel), 'utf8');
    if (/"(combined|combinedScore)"\s*:/.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `契约禁止合成总分，而预标行每行都带 combined:null —— 导出时必须整个键都不要出现：${offenders.join(', ')}`);

  // 顺带守住 `status` 不被误当成输入字段写进 schema 的 required。
  const schema = JSON.parse(fs.readFileSync(path.join(out, 'schema', 'label_row.schema.json'), 'utf8'));
  assert.ok(!schema.required.includes('status'), 'status 是派生量，不该在 required 里');
  assert.ok(!schema.required.includes('combined'), 'combined 是被禁止的键');
  assert.deepEqual(schema.properties.dependency.enum, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(schema.properties.similarity.enum, [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(schema.properties.reviewerId.not.pattern, '^prelabel', 'reviewerId 的保留前缀规则必须写进 schema');
});

test('输出可校验、可复现：哈希对得上，同输入两次跑得到同样字节', async (t) => {
  const first = buildInto(t);
  // `exportBundle` 内部已经回读校验过一遍；这里再显式跑一次，确保那一步没有被绕过。
  assert.equal(verifyExport(first.out, { fileRecords: first.result.fileRecords }), true);

  const second = buildInto(t);
  assert.equal(first.result.bundleSelf.sha256, second.result.bundleSelf.sha256,
    'BUNDLE.json 不可复现：同一份输入两次导出得到不同字节（通常是塞了时间戳或哈希顺序不稳）');
  const hashOf = (result) => result.fileRecords.map((record) => `${record.path}:${record.sha256}`).join('\n');
  assert.equal(hashOf(first.result), hashOf(second.result), '除 BUNDLE.json 外的文件也必须逐字节可复现');

  // BUNDLE.json 里记账的文件必须与盘上完全一致 —— 两个方向都要查。
  const bundle = JSON.parse(fs.readFileSync(path.join(first.out, 'BUNDLE.json'), 'utf8'));
  const listed = new Set(bundle.files.map((record) => record.path));
  listed.add('BUNDLE.json');
  const onDisk = new Set(walk(first.out));
  assert.deepEqual([...onDisk].sort(), [...listed].sort(), 'BUNDLE.json 的记账与盘上文件对不上（漏记 = 不知道发了什么出去）');

  // 每个记账的 sha256 都要和盘上实际内容一致。
  for (const rel of onDisk) {
    const text = fs.readFileSync(path.join(first.out, rel), 'utf8');
    const digest = (await import('node:crypto')).createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    const record = bundle.files.find((item) => item.path === rel);
    if (record) assert.equal(record.sha256, digest, `${rel} 的 sha256 与记账不符`);
  }
});

test('被排除的试标行只留出处、不留分数', async (t) => {
  const { out } = buildInto(t);
  const rows = readJsonl(path.join(out, 'reference', 'trial_excluded.jsonl'));
  assert.ok(rows.length > 0, '试标行应当被显式登记（排除也要留痕）');
  for (const row of rows) {
    assert.equal(row.scoresWithheld, true);
    assert.equal(row.dependency, undefined, '试标行覆盖的是 test pair，带分数就是泄题');
    assert.equal(row.similarity, undefined);
    assert.ok(row.source, '必须写明这行来自哪个文件');
  }
});
