import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLabels } from './apply_labels.mjs';
import { PRELABEL_ID, agreementReport, indexReviews, resolvePair } from './lib/consensus.mjs';
import { prelabelPair, writePrelabels } from './prelabel.mjs';

const row = (over = {}) => ({
  id: 'a>b',
  dependency: 0.5,
  similarity: 0.25,
  rationale: '',
  ...over,
});

test('human labels overlay D and S separately and reject a combined score', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpdb-label-'));
  const pairsPath = join(dir, 'pairs.jsonl');
  const labelsPath = join(dir, 'labels.jsonl');
  const outPath = join(dir, 'pairs.labeled.jsonl');
  writeFileSync(pairsPath, `${JSON.stringify({
    id: 'a>b', initDependency: 0.75, initSimilarity: 0, combined: null,
  })}\n`);
  writeFileSync(labelsPath, `${JSON.stringify({
    id: 'a>b', dependency: 0.75, similarity: 0.25, annotatorId: 'ann1', rationale: '近邻但不该协作',
  })}\n`);
  const report = applyLabels({ pairsPath, labelsPath, outPath });
  assert.equal(report.labeled, 1);
  assert.equal(report.byStatus.single, 1);
  const out = JSON.parse(readFileSync(outPath, 'utf8').trim());
  assert.equal(out.humanDependency, 0.75);
  assert.equal(out.humanSimilarity, 0.25);
  assert.ok(!('combined' in out), '导出的 gold 行不该带 combined 键');
  assert.equal(out.annotatorId, 'ann1');
  assert.equal(out.labelStatus, 'single');
  assert.equal(out.labelSource, 'human');
});

test('prelabel keeps D and S separate and explains the pair', () => {
  const twin = prelabelPair({
    id: 'a>b', leftFamily: 'writing', rightFamily: 'writing', isTwin: true,
    initDependency: 0, initSimilarity: 0.75, kind: 'within_owner_directed',
    capabilityGap: { onlyLeft: ['引用绑定'], onlyRight: ['品牌语气'] },
  });
  assert.equal(twin.dependency, 0);
  assert.equal(twin.similarity, 0.75);
  // 契约禁止合成总分：这个键必须**不存在**，而不只是值为 null。
  assert.ok(!('combined' in twin), 'prelabel 行不该带 combined 键');
  assert.equal(twin.reviewerId, PRELABEL_ID);
  assert.equal(twin.role, 'prelabel');
  assert.match(twin.rationale, /近邻替换/);
  const collab = prelabelPair({
    id: 'a>c', leftFamily: 'research', rightFamily: 'writing', isTwin: false,
    initDependency: 0.75, initSimilarity: 0, kind: 'within_owner_directed',
    capabilityGap: { onlyLeft: [], onlyRight: [] },
  });
  assert.equal(collab.dependency, 0.75);
  assert.equal(collab.similarity, 0);
  assert.match(collab.rationale, /规划该协作/);
});

test('an AI prelabel is never the second human rater', () => {
  const withPrelabel = indexReviews([
    row({ reviewerId: PRELABEL_ID, role: 'prelabel' }),
    row({ reviewerId: 'jia' }),
  ]);
  assert.equal(resolvePair(withPrelabel.get('a>b')).status, 'single');

  const prelabelOnly = indexReviews([row({ reviewerId: PRELABEL_ID, role: 'prelabel' })]);
  const resolved = resolvePair(prelabelOnly.get('a>b'));
  assert.equal(resolved.status, 'prelabel');
  assert.equal(resolved.prelabelOnly, true);
  assert.equal(resolvePair([]).status, 'unlabeled');
});

test('gold requires exact agreement, otherwise the pair waits for adjudication', () => {
  const agreed = indexReviews([
    row({ reviewerId: 'jia', role: 'reviewer' }),
    row({ reviewerId: 'yi', role: 'reviewer' }),
  ]);
  const both = resolvePair(agreed.get('a>b'));
  assert.equal(both.status, 'agreed');
  assert.equal(both.dependency, 0.5);
  assert.equal(both.similarity, 0.25);
  assert.equal(both.raterCount, 2);

  const split = indexReviews([
    row({ reviewerId: 'jia', role: 'reviewer', dependency: 0.5 }),
    row({ reviewerId: 'yi', role: 'reviewer', dependency: 0.75 }),
  ]);
  const pending = resolvePair(split.get('a>b'));
  assert.equal(pending.status, 'needs_adjudication');
  assert.equal(pending.dependency, null);
  assert.equal(pending.similarity, null);

  const decided = indexReviews([
    ...split.get('a>b'),
    row({ reviewerId: 'bing', role: 'adjudicator', dependency: 0.75, rationale: '以右方产出口径为准' }),
  ]);
  const final = resolvePair(decided.get('a>b'));
  assert.equal(final.status, 'adjudicated');
  assert.equal(final.dependency, 0.75);
  assert.equal(final.reviewerId, 'bing');
  assert.match(final.rationale, /口径/);
});

test('apply_labels exports only resolved gold and reports the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpdb-gold-'));
  const pairsPath = join(dir, 'pairs.jsonl');
  const labelsPath = join(dir, 'labels.jsonl');
  const outPath = join(dir, 'pairs.labeled.jsonl');
  const pairs = [
    { id: 'agreed>p', initDependency: 0.5, initSimilarity: 0.25, combined: null },
    { id: 'clash>p', initDependency: 0.5, initSimilarity: 0, combined: null },
    { id: 'ai>p', initDependency: 0.75, initSimilarity: 0, combined: null },
  ];
  writeFileSync(pairsPath, `${pairs.map((pair) => JSON.stringify(pair)).join('\n')}\n`);
  writeFileSync(labelsPath, `${[
    row({ id: 'agreed>p', reviewerId: 'jia', role: 'reviewer' }),
    row({ id: 'agreed>p', reviewerId: 'yi', role: 'reviewer' }),
    row({ id: 'clash>p', reviewerId: 'jia', role: 'reviewer', similarity: 0 }),
    row({ id: 'clash>p', reviewerId: 'yi', role: 'reviewer', similarity: 0.5 }),
    row({ id: 'ai>p', reviewerId: PRELABEL_ID, role: 'prelabel', dependency: 0.75, similarity: 0 }),
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const report = applyLabels({ pairsPath, labelsPath, outPath });
  assert.equal(report.byStatus.agreed, 1);
  assert.equal(report.byStatus.needs_adjudication, 1);
  assert.equal(report.byStatus.prelabel, 1);
  assert.equal(report.labeled, 1);
  assert.equal(report.readyForEval, false);

  const out = readFileSync(outPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const byId = new Map(out.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('agreed>p').humanDependency, 0.5);
  assert.deepEqual(byId.get('agreed>p').reviewers, ['jia', 'yi']);
  assert.equal(byId.get('clash>p').labelStatus, 'needs_adjudication');
  assert.equal(byId.get('clash>p').humanDependency, undefined);
  assert.equal(byId.get('ai>p').humanDependency, undefined);
  assert.equal(byId.get('ai>p').labelStatus, undefined);
});

test('agreement report reports kappa and within-step rates separately', () => {
  const rows = [];
  const plan = [
    { id: 'p1', d: [0, 0], s: [0, 0] },
    { id: 'p2', d: [0.25, 0.25], s: [0.25, 0.25] },
    { id: 'p3', d: [0.5, 0.5], s: [0.5, 0.5] },
    { id: 'p4', d: [1, 1], s: [0.5, 0.75] },
  ];
  for (const entry of plan) {
    rows.push({ id: entry.id, reviewerId: 'jia', role: 'reviewer', dependency: entry.d[0], similarity: entry.s[0] });
    rows.push({ id: entry.id, reviewerId: 'yi', role: 'reviewer', dependency: entry.d[1], similarity: entry.s[1] });
  }
  const report = agreementReport({ reviewIndex: indexReviews(rows) });
  assert.equal(report.pairsWithTwoRaters, 4);
  assert.equal(report.kappaDependency, 1);
  assert.equal(report.exactDependency, 1);
  assert.equal(report.withinStepDependency, 1);
  assert.equal(report.exactSimilarity, 0.75);
  assert.equal(report.withinStepSimilarity, 1);
  assert.equal(report.maeSimilarity, 0.0625);
  assert.equal(report.kappaSimilarity, 0.6667);
  assert.equal(report.statuses.agreed, 3);
  assert.equal(report.statuses.needs_adjudication, 1);
  assert.deepEqual(report.perReviewer, { jia: 4, yi: 4 });
});

test('re-running the prelabel pass never drops a human reviewer row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpdb-prelabel-'));
  const pairsPath = join(dir, 'pairs.jsonl');
  const labelsPath = join(dir, 'labels.jsonl');
  writeFileSync(pairsPath, `${JSON.stringify({
    id: 'a>b', leftFamily: 'research', rightFamily: 'writing', isTwin: false,
    initDependency: 0.75, initSimilarity: 0, kind: 'within_owner_directed',
    capabilityGap: { onlyLeft: [], onlyRight: [] }, split: 'test',
  })}\n`);
  writeFileSync(labelsPath, `${[
    row({ id: 'a>b', reviewerId: 'jia', role: 'reviewer', dependency: 0.25 }),
    row({ id: 'a>b', reviewerId: 'yi', role: 'reviewer', dependency: 0.25 }),
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const result = writePrelabels({ pairsPath, labelsPath });
  assert.equal(result.count, 1);
  assert.equal(result.humanRows, 2);
  const written = readFileSync(labelsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(written.length, 3);
  assert.equal(written.filter((entry) => entry.role === 'prelabel').length, 1);
  assert.equal(written.filter((entry) => entry.role === 'reviewer').length, 2);
  assert.equal(resolvePair(indexReviews(written).get('a>b')).status, 'agreed');
});
