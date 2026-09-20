// 把按方案拆开跑的诊断片段合并成一份 `diagnosis.json`。
//
// ## 为什么要能拆开跑
//
// 诊断轮是 4 种留出方案 × 3 种特征变体 × 5 折 × 2 个模型 × 5 个种子 ≈ 540 次训练。
// 单进程顺序跑要一个多小时，而这台机器只有一块 CPU 和很紧的内存 ——
// 拆成"一进程一方案"并排跑是唯一能把墙钟时间压下来的办法。
//
// ## 合并的规则只有一条：**不许掩盖缺失**
//
// `cells` 直接拼接（每个片段负责自己的方案，互不重叠）；`kindProbe` 取任一片段的
// （它与方案无关，只取决于矩阵）。`verdict` 与 `calibration` 只可能来自**跑过
// `facet` 方案的那一段** —— 判据的锚点写死在 `facet × no_identity` 上
// （见 `train_scorer.py` 的 `VERDICT_SUBJECT`）。缺了它，合并结果必须明确地是
// "没算结论"，而不是拿 `facet_pair` 之类的格子凑一个看起来一样的数出来。
//
// 同一份 (scheme, variant) 在多个片段里出现时直接报错：那意味着有人重复跑或者
// 参数写错，而拼接会让指标被静默地算两遍。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function mergeDiagnosis(paths) {
  const parts = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
  if (!parts.length) throw new Error('cpdb_merge_no_input');
  for (const part of parts) {
    if (part.schema !== 'cpdb_scorer_diagnosis/v1') throw new Error(`cpdb_merge_schema:${part.schema}`);
  }

  const cells = [];
  const seen = new Map();
  for (const [at, part] of parts.entries()) {
    for (const cell of part.cells || []) {
      const key = `${cell.scheme}/${cell.variant}`;
      if (seen.has(key)) {
        throw new Error(
          `cpdb_merge_duplicate_cell:${key} 同时出现在 ${paths[seen.get(key)]} 与 ${paths[at]}`,
        );
      }
      seen.set(key, at);
      cells.push(cell);
    }
  }

  // 锚点片段：跑过 `facet` 方案的那一份才有判据与标定。
  const anchorPart = parts.find((part) => (part.cells || []).some((cell) => cell.scheme === 'facet'));
  const anchorCell = anchorPart
    && (anchorPart.cells || []).find((cell) => cell.scheme === 'facet' && cell.variant === 'no_identity');

  const schemes = [...new Set(cells.map((cell) => cell.scheme))];
  const variants = [...new Set(cells.map((cell) => cell.variant))];
  const anchorMissing = !anchorCell;

  const merged = {
    ...parts[0],
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    mergedFrom: parts.map((part, at) => ({
      file: paths[at],
      generatedAt: part.generatedAt,
      cells: (part.cells || []).length,
      schemes: [...new Set((part.cells || []).map((cell) => cell.scheme))],
    })),
    selection: {
      schemes,
      variants,
      complete: schemes.length === 4 && variants.length === 3,
      note: '完整矩阵是 4 方案 × 3 变体 = 12 格；`complete` 为 false 时结论页必须写明缺了哪些格。',
    },
    cells: cells.sort((a, b) => a.scheme.localeCompare(b.scheme) || a.variant.localeCompare(b.variant)),
    sections: parts.map((part) => part.seeds).find((seeds) => seeds) || [],
    kindProbe: parts.find((part) => part.kindProbe && Object.keys(part.kindProbe).length)?.kindProbe || {},
    // 判据与标定只能来自锚点片段。合并者在缺失时**不重算** ——
    // 在 JS 里再实现一遍判据，就是把那个写死的口径复制成第二份，
    // 两份口径迟早会分叉，而分叉的症状是"结论页上写的话和 diagnosis.json 里的数对不上"。
    verdict: anchorMissing
      ? {
        outcome: 'not_computed',
        reading: '合并的片段里没有 facet 方案，判据锚点（facet 折 × no_identity 变体）缺失，因此没有结论。请补跑 facet 方案。',
        criteria: [],
        subject: 'facet 折 × no_identity 特征 × similarity 轴',
      }
      : anchorPart.verdict,
    calibration: anchorMissing ? {} : (anchorPart.calibration || {}),
  };
  return merged;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const inputs = argv.filter((item, at) => item !== '--out' && at !== outIndex + 1);
  if (!inputs.length || outIndex < 0) {
    console.error('用法: node merge_diagnosis.mjs --out <合并结果.json> <片段1.json> <片段2.json> ...');
    process.exit(2);
  }
  const merged = mergeDiagnosis(inputs.map((path) => resolve(path)));
  writeFileSync(resolve(argv[outIndex + 1]), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    out: argv[outIndex + 1],
    schemes: merged.selection.schemes,
    variants: merged.selection.variants,
    complete: merged.selection.complete,
    cells: merged.cells.length,
    verdict: merged.verdict.outcome,
  }, null, 2));
}
