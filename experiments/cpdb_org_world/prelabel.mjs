import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPrelabelRow } from './lib/consensus.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const PRELABEL_ID = 'prelabel_v1';

const FAMILY = {
  research: '信息整理',
  data: '数据清洗',
  writing: '文案写作',
  ppt: '演示文稿',
  code: '代码交付',
  review: '验收审核',
};

export function prelabelPair(pair) {
  const left = FAMILY[pair.leftFamily] || pair.leftFamily;
  const right = FAMILY[pair.rightFamily] || pair.rightFamily;
  const same = pair.leftFamily === pair.rightFamily;
  const d = Number(pair.initDependency);
  const s = Number(pair.initSimilarity);
  const gap = [
    ...(pair.capabilityGap?.onlyLeft || []),
    ...(pair.capabilityGap?.onlyRight || []),
  ].filter((tag) => /[\u4e00-\u9fff]/.test(tag) || tag.includes('_')).slice(0, 4);
  let rationale;
  if (same && (pair.isTwin || s >= 0.75)) {
    rationale = `同职能「${left}」，细节不同${gap.length ? `（${gap.join(' / ')}）` : ''}。规划不该互为输入，失败时可近邻替换。`;
  } else if (same) {
    rationale = `同职能「${left}」，更适合替换而不是互相依赖。`;
  } else if (d >= 0.75) {
    rationale = `「${left}」产出能作为「${right}」输入，规划该协作；职能不同，不能当替换。`;
  } else if (d >= 0.5) {
    rationale = `「${left}」到「${right}」可以协作，但不是最自然的上下游。`;
  } else if (pair.kind === 'hard_negative') {
    rationale = `跨组织且职能不同（${left} vs ${right}），依赖和替换都低。`;
  } else {
    rationale = `「${left}」与「${right}」职能不同，产出对不上输入，也不能近邻替换。`;
  }
  return {
    id: pair.id,
    reviewerId: PRELABEL_ID,
    annotatorId: PRELABEL_ID,
    role: 'prelabel',
    status: 'prelabel',
    dependency: d,
    similarity: s,
    rationale,
    split: pair.split,
    kind: pair.kind,
    // 契约禁止合成总分（`lib/gates.mjs:34`、`schema.json` 的 forbidden.combinedScore），
    // 而 `annotate_server.py:439` 对任何非 null 的 `combined` 直接抛。
    // 值虽然是 null 无害，但键名与契约正面冲突、又会被人照抄，所以整个键都不要出现。
  };
}

export function writePrelabels({
  pairsPath = join(ROOT, 'data/full/pairs.jsonl'),
  labelsPath = join(ROOT, 'data/full/human_labels.jsonl'),
} = {}) {
  const pairs = readJsonl(pairsPath);
  const existing = readJsonl(labelsPath).filter((row) => row.id);
  // Human rows are never rewritten or dropped: the store is a union of
  // (pairId, reviewerId) rows, and a second reviewer must survive a re-prelabel.
  const human = existing.filter((row) => !isPrelabelRow(row));
  const previousPrelabel = new Map(existing.filter(isPrelabelRow).map((row) => [row.id, row]));
  // 已在盘上的旧预标行也会带 `combined: null`（历史上写的），重用时要顺手把它摘掉，
  // 否则「契约里没有这个键」这句话对存量数据不成立。
  const prelabels = pairs.map((pair) => {
    const previous = previousPrelabel.get(pair.id);
    if (!previous) return prelabelPair(pair);
    const { combined, ...rest } = previous;
    return rest;
  });
  writeFileSync(labelsPath, `${[...prelabels, ...human].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const byKind = {};
  for (const row of prelabels) byKind[row.kind] = (byKind[row.kind] || 0) + 1;
  return { labelsPath, count: prelabels.length, humanRows: human.length, byKind, annotatorId: PRELABEL_ID };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  console.log(JSON.stringify(writePrelabels(), null, 2));
}
