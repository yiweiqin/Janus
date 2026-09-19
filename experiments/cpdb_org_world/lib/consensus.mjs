// Consensus rules for CPDB human annotation.
//
// The label store (`data/full/human_labels.jsonl`) is a union of rows keyed by
// `(pairId, reviewerId)`.  Three row roles exist:
//
//   prelabel_v1  -> the rule-based AI pre-label, never counted as a human rater
//   reviewer     -> an independent blind human pass (two of them on test)
//   adjudicator  -> the third person who resolves a disagreement
//
// Gold resolution is intentionally strict: two human raters only produce gold
// when they are *exactly* equal on both axes.  Anything else goes to the
// adjudication queue.  "Within one step" agreement is reported as a diagnostic
// only -- it never manufactures a gold value, because the mid-point between two
// neighbouring scale steps is not itself on the scale.

export const PRELABEL_ID = 'prelabel_v1';
export const ROLE_PRELABEL = 'prelabel';
export const ROLE_REVIEWER = 'reviewer';
export const ROLE_ADJUDICATOR = 'adjudicator';
export const ROLE_ORDER = Object.freeze([ROLE_PRELABEL, ROLE_REVIEWER, ROLE_ADJUDICATOR]);

export const SCALE = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
export const BLIND_SPLITS = Object.freeze(['test']);

/** Statuses whose `dependency` / `similarity` may be exported as gold. */
export const GOLD_STATUSES = Object.freeze(['single', 'agreed', 'adjudicated']);
/** Statuses that still need a human. */
export const OPEN_STATUSES = Object.freeze(['unlabeled', 'prelabel', 'needs_adjudication']);

export function isBlindSplit(split) {
  return BLIND_SPLITS.includes(String(split || ''));
}

export function reviewerIdOf(row) {
  return String((row && (row.reviewerId || row.annotatorId)) || '').trim();
}

export function isPrelabelRow(row) {
  if (!row) return false;
  if (String(row.role || '') === ROLE_PRELABEL) return true;
  return reviewerIdOf(row).startsWith('prelabel');
}

export function roleOf(row) {
  const role = String((row && row.role) || '').trim();
  if (role === ROLE_PRELABEL || role === ROLE_REVIEWER || role === ROLE_ADJUDICATOR) return role;
  return isPrelabelRow(row) ? ROLE_PRELABEL : ROLE_REVIEWER;
}

export function reviewKey(row) {
  return `${String((row && row.id) || '')}\u0000${reviewerIdOf(row)}`;
}

/** Group flat label rows into `Map<pairId, row[]>`. */
export function indexReviews(rows) {
  const byPair = new Map();
  for (const row of rows || []) {
    if (!row || !row.id) continue;
    const bucket = byPair.get(row.id) || [];
    bucket.push(row);
    byPair.set(row.id, bucket);
  }
  for (const bucket of byPair.values()) bucket.sort(compareRows);
  return byPair;
}

function compareRows(left, right) {
  const roleRank = (row) => ROLE_ORDER.indexOf(roleOf(row));
  return roleRank(left) - roleRank(right)
    || reviewerIdOf(left).localeCompare(reviewerIdOf(right))
    || String(left.at || '').localeCompare(String(right.at || ''));
}

export function ratersOf(rows) {
  return (rows || []).filter((row) => roleOf(row) === ROLE_REVIEWER);
}

export function adjudicatorsOf(rows) {
  return (rows || []).filter((row) => roleOf(row) === ROLE_ADJUDICATOR);
}

export function prelabelOf(rows) {
  return (rows || []).find(isPrelabelRow) || null;
}

export function reviewOf(rows, reviewerId) {
  const want = String(reviewerId || '').trim();
  if (!want) return null;
  const matches = (rows || []).filter((row) => reviewerIdOf(row) === want);
  return matches.length ? matches[matches.length - 1] : null;
}

export function score(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Strict scale quantisation — the single source of truth for "is this a legal score".
 *
 * `Number(null) === 0` is the trap this exists to close: a **missing** score would
 * otherwise silently read as "scored 0". `annotate_server.py:parse_score` already
 * rejects it (Python's `float(None)` raises); this keeps the JS side honest too.
 * Returns the nearest `SCALE` step when within 0.001, otherwise `null`.
 */
export function quantizeScore(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  if (Array.isArray(value) || typeof value === 'object') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  let best = SCALE[0];
  for (const step of SCALE) if (Math.abs(step - number) < Math.abs(best - number)) best = step;
  return Math.abs(best - number) < 0.001 ? best : null;
}

/**
 * Read a row's two axes. Deliberately **strict**: a missing axis comes back as
 * `null`, never as `0`. The loose version let `Number(null) === 0` turn "not filled
 * in" into "scored 0", and two raters who both left a field blank then compared
 * *equal* — manufacturing a gold `agreed` out of nothing.
 */
function scores(row) {
  return {
    dependency: quantizeScore(row && row.dependency),
    similarity: quantizeScore(row && row.similarity),
  };
}

function gold(status, row, extra = {}) {
  const values = scores(row);
  return {
    status,
    reviewerId: row ? reviewerIdOf(row) : '',
    dependency: values.dependency,
    similarity: values.similarity,
    rationale: row ? String(row.rationale || '') : '',
    ...extra,
  };
}

/**
 * Resolve one pair's rows into a single status + gold scores.
 * Pure function; used identically by the annotation server and the exporter.
 */
export function resolvePair(rows) {
  const all = (rows || []).filter((row) => row && row.id);
  const adjudications = adjudicatorsOf(all);
  const raters = ratersOf(all);
  const prelabel = prelabelOf(all);

  // 打不出分的行不算「可用的 rater」。缺分必须让这一对**无法定论**，而不是
  // 静默降级：否则「少填了一个轴」会伪装成「两个人判断不一致」，永远卡在仲裁队列里。
  const usableRaters = raters.filter(isUsableRow);
  const unusableRaters = raters.length - usableRaters.length;

  if (adjudications.length) {
    const last = adjudications[adjudications.length - 1];
    if (isUsableRow(last)) {
      return gold('adjudicated', last, { raterCount: raters.length, prelabelOnly: false });
    }
    // 仲裁行本身缺分 → 分歧没被真正解决，不能当金标。
    return needsAdjudication(raters.length, { unusableAdjudicator: true });
  }

  if (usableRaters.length >= 2) {
    const dependency = usableRaters.map((row) => scores(row).dependency);
    const similarity = usableRaters.map((row) => scores(row).similarity);
    const agreed = dependency.every((value) => value === dependency[0])
      && similarity.every((value) => value === similarity[0]);
    if (agreed) {
      return gold('agreed', usableRaters[0], { raterCount: raters.length, prelabelOnly: false });
    }
    return needsAdjudication(raters.length, unusableRaters ? { unusableRaters } : {});
  }

  if (usableRaters.length === 1 && unusableRaters === 0) {
    return gold('single', usableRaters[0], { raterCount: 1, prelabelOnly: false });
  }

  if (usableRaters.length === 1) {
    // 一个能判、一个打不出分：无法确认是否一致 → 交仲裁，并把坏行数报出来。
    return needsAdjudication(raters.length, { unusableRaters });
  }

  if (unusableRaters > 0) return needsAdjudication(raters.length, { unusableRaters });

  if (prelabel) {
    return gold('prelabel', prelabel, { raterCount: 0, prelabelOnly: true });
  }

  return {
    status: 'unlabeled',
    reviewerId: '',
    dependency: null,
    similarity: null,
    rationale: '',
    raterCount: 0,
    prelabelOnly: false,
  };
}

/** 两个轴都得落在标尺上，这一行才算一次有效判断。 */
export function isUsableRow(row) {
  const value = scores(row);
  return value.dependency !== null && value.similarity !== null;
}

function needsAdjudication(raterCount, extra = {}) {
  return {
    status: 'needs_adjudication',
    reviewerId: '',
    dependency: null,
    similarity: null,
    rationale: '',
    raterCount,
    prelabelOnly: false,
    ...extra,
  };
}

/** Split label rows by reviewer, for per-person progress. */
export function reviewerProgress(rows) {
  const byReviewer = new Map();
  for (const row of rows || []) {
    if (isPrelabelRow(row)) continue;
    const id = reviewerIdOf(row);
    if (!id) continue;
    const bucket = byReviewer.get(id) || {};
    const split = String(row.split || 'unknown');
    bucket[split] = (bucket[split] || 0) + 1;
    bucket.all = (bucket.all || 0) + 1;
    byReviewer.set(id, bucket);
  }
  return byReviewer;
}

/** Cohen's kappa over aligned category pairs; null when undefined. */
export function cohenKappa(pairs) {
  const usable = (pairs || []).filter(([left, right]) => SCALE.includes(left) && SCALE.includes(right));
  if (!usable.length) return null;
  const size = SCALE.length;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
  for (const [left, right] of usable) {
    matrix[SCALE.indexOf(left)][SCALE.indexOf(right)] += 1;
  }
  const total = usable.length;
  const rowSums = new Array(size).fill(0);
  const colSums = new Array(size).fill(0);
  let observed = 0;
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      if (i === j) observed += matrix[i][j];
      rowSums[i] += matrix[i][j];
      colSums[j] += matrix[i][j];
    }
  }
  const po = observed / total;
  let pe = 0;
  for (let i = 0; i < size; i += 1) pe += (rowSums[i] / total) * (colSums[i] / total);
  if (Math.abs(1 - pe) < 1e-9) return 1;
  return (po - pe) / (1 - pe);
}

/**
 * Agreement diagnostics over pairs that have >= 2 independent raters.
 * Two-rater pairs are also used for Cohen's kappa (first two by reviewerId).
 */
export function agreementReport({ reviewIndex, splitById = new Map(), split = '' } = {}) {
  const report = {
    split: split || 'all',
    pairsWithTwoRaters: 0,
    exactDependency: 0,
    exactSimilarity: 0,
    exactBoth: 0,
    withinStepDependency: 0,
    withinStepSimilarity: 0,
    withinStepBoth: 0,
    maeDependency: 0,
    maeSimilarity: 0,
    kappaDependency: null,
    kappaSimilarity: null,
    statuses: { unlabeled: 0, prelabel: 0, single: 0, agreed: 0, needs_adjudication: 0, adjudicated: 0 },
    perReviewer: {},
  };
  const depPairs = [];
  const simPairs = [];
  let absD = 0;
  let absS = 0;

  for (const [id, rows] of reviewIndex || new Map()) {
    const resolved = resolvePair(rows);
    if (resolved.status in report.statuses) report.statuses[resolved.status] += 1;
    for (const row of ratersOf(rows)) {
      const who = reviewerIdOf(row);
      report.perReviewer[who] = (report.perReviewer[who] || 0) + 1;
    }
    if (split && splitById.get(id) !== split) continue;
    // 只拿**打得分的**那两行算一致性：缺分的行不能顶替成 0 分参与 κ/MAE。
    const raters = ratersOf(rows).filter(isUsableRow);
    if (raters.length < 2) continue;
    const left = raters[0];
    const right = raters[1];
    const dLeft = scores(left).dependency;
    const dRight = scores(right).dependency;
    const sLeft = scores(left).similarity;
    const sRight = scores(right).similarity;
    if (dLeft == null || dRight == null || sLeft == null || sRight == null) continue;

    report.pairsWithTwoRaters += 1;
    depPairs.push([dLeft, dRight]);
    simPairs.push([sLeft, sRight]);
    absD += Math.abs(dLeft - dRight);
    absS += Math.abs(sLeft - sRight);
    const okD = dLeft === dRight;
    const okS = sLeft === sRight;
    if (okD) report.exactDependency += 1;
    if (okS) report.exactSimilarity += 1;
    if (okD && okS) report.exactBoth += 1;
    const nearD = Math.abs(dLeft - dRight) <= 0.25;
    const nearS = Math.abs(sLeft - sRight) <= 0.25;
    if (nearD) report.withinStepDependency += 1;
    if (nearS) report.withinStepSimilarity += 1;
    if (nearD && nearS) report.withinStepBoth += 1;
  }

  const count = report.pairsWithTwoRaters;
  report.maeDependency = count ? round4(absD / count) : 0;
  report.maeSimilarity = count ? round4(absS / count) : 0;
  report.kappaDependency = round4(cohenKappa(depPairs));
  report.kappaSimilarity = round4(cohenKappa(simPairs));
  for (const key of [
    'exactDependency', 'exactSimilarity', 'exactBoth',
    'withinStepDependency', 'withinStepSimilarity', 'withinStepBoth',
  ]) {
    report[key] = count ? round4(report[key] / count) : 0;
  }
  return report;
}

function round4(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 10000) / 10000;
}
