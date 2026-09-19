/**
 * 把 CPDB 判分包导出成**给外部 AI 判分**的自足目录。
 *
 * 为什么需要这个文件：判分本来要 3 个人（甲、乙盲标 test，丙仲裁分歧）。现实是
 * `data/full/human_labels.jsonl` 里 **8282 行全是 `prelabel_v1`**，一个人类行都没有。
 * 所以我们要把"判分"这件事整体外包给外部 AI，而外包的前提是**包本身自足且不含答案**。
 *
 * 这个导出器要守住的三件事，每一件都有对应的错误形态：
 *
 *   1. **盲标不能漏。** test 那 799 条的 teacher 分（`pairs.jsonl` 的 `initDependency` /
 *      `initSimilarity`）**一个字节都不许出现在包里**。否则外部 AI 会照着抄，
 *      我们拿到的是"它会不会抄"，不是"它判得准不准"。
 *      注：`annotation_cards.jsonl` 本来就删了 `teacher`（`generate.mjs` 的 `publicCard`），
 *      所以真值其实住在 `pairs.jsonl` 里 —— 这是最容易漏的一条。
 *   2. **`combined` 键必须整个消失。** 契约禁止合成总分（`schema.json` 的
 *      `forbidden.combinedScore`、`lib/gates.mjs:34`），而 `prelabel.mjs:53` 给每一行都写了
 *      `combined: null`。值无害，但键名与契约正面冲突，而且会暗示"这里本来该有个总分"。
 *      注意：`null` 和"没有这个键"对消费者是**两件事**，我们只要后者。
 *   3. **输出必须可校验。** 每个文件给出行数与 sha256，外部 AI 拿到的包和我们的包对不上时，
 *      能自己发现，而不是产出两份无法对账的标签。
 *
 * 用法：
 *   node experiments/cpdb_org_world/export_bundle.mjs [--out <dir>] [--generated-at <iso>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PRELABEL_ID, SCALE, isPrelabelRow } from './lib/consensus.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data', 'full');
const DEFAULT_OUT = join(ROOT, 'export', 'ai-judge-v1');

const BUNDLE_SCHEMA = 'cpdb-ai-judge-bundle/v1';
const BUNDLE_SCHEMA_VERSION = 1;

export function exportBundle({ out = DEFAULT_OUT, dataDir = DATA, generatedAt = '' } = {}) {
  const files = new Map();
  const put = (relPath, text) => files.set(relPath, text.endsWith('\n') ? text : `${text}\n`);

  const manifest = readJson(join(dataDir, 'manifest.json'));
  const orgs = readJsonl(join(dataDir, 'orgs.jsonl'));
  const people = readJsonl(join(dataDir, 'people.jsonl'));
  const agents = readJsonl(join(dataDir, 'agents.jsonl'));
  const agentProfiles = readJsonl(join(dataDir, 'agent_profiles.jsonl'));
  const ubuddyProfiles = readJsonl(join(dataDir, 'ubuddy_profiles.jsonl'));
  const pairs = readJsonl(join(dataDir, 'pairs.jsonl'));
  const cards = readJsonl(join(dataDir, 'annotation_cards.jsonl'));
  const labels = readJsonl(join(dataDir, 'human_labels.jsonl'));

  const splitById = new Map(pairs.map((pair) => [pair.id, String(pair.split || '')]));
  const kindById = new Map(pairs.map((pair) => [pair.id, String(pair.kind || '')]));
  const cardById = new Map(cards.map((card) => [card.id, card]));

  // ---- 1. world：判分要用的输入，原样导出 ----
  put('world/orgs.jsonl', jsonl(orgs));
  put('world/people.jsonl', jsonl(people));
  put('world/agents.jsonl', jsonl(agents));
  put('world/agent_profiles.jsonl', jsonl(agentProfiles));
  put('world/ubuddy_profiles.jsonl', jsonl(ubuddyProfiles));
  put('world/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  // ---- 2. cards：test 盲标 / train+dev 带参考 ----
  //
  // 两边都用**同一份** `annotation_cards.jsonl`（它就是给人看的那份），
  // 差别只在 `human` 一律清空 —— 卡里的 `human` 是给人现场填的，导出时必须为空，
  // 否则一个"看起来填过"的字段会让外部 AI 以为那是有约束力的标注。
  const blankHumans = (card) => ({ ...card, human: { dependency: null, similarity: null, annotatorId: null, rationale: null } });
  const testCards = cards.filter((card) => splitById.get(card.id) === 'test');
  const trainDevCards = cards.filter((card) => ['train', 'development'].includes(splitById.get(card.id)));
  put('cards/test.blind.jsonl', jsonl(testCards.map(blankHumans)));
  put('cards/train.dev.jsonl', jsonl(trainDevCards.map(blankHumans)));

  // ---- 3. pairs：test 行**扣掉** teacher 与模型基线分 ----
  //
  // 这是整个导出最关键的一步。`pairs.jsonl` 是 teacher 分真正的住处，
  // 而 `initDependency` / `initSimilarity` 就是我们要外部 AI 重判的那两个数。
  const STRIPPED_FOR_BLIND = ['initDependency', 'initSimilarity', 'contractDependency', 'contractSimilarity', 'humanDependency', 'humanSimilarity', 'annotatorId', 'rationale'];
  const pairRows = pairs.map((pair) => {
    const base = {
      id: pair.id,
      split: pair.split,
      kind: pair.kind,
      isTwin: Boolean(pair.isTwin),
      orgId: pair.orgId,
      leftAgentId: pair.leftAgentId,
      rightAgentId: pair.rightAgentId,
      leftOwnerId: pair.leftOwnerId,
      rightOwnerId: pair.rightOwnerId,
      leftFamily: pair.leftFamily,
      rightFamily: pair.rightFamily,
      leftFacet: pair.leftFacet,
      rightFacet: pair.rightFacet,
      capabilityGap: pair.capabilityGap,
    };
    if (String(pair.split) === 'test') {
      return { ...base, scoresWithheld: true, withheldFields: STRIPPED_FOR_BLIND };
    }
    return {
      ...base,
      scoresWithheld: false,
      // teacher = 我们要重判的那份规则基线；contract* = 契约模型的侧基线。
      // 两者**必须分开命名**，混成一个字段会让"AI 的判分 vs 规则基线"这张对照表失去意义。
      initDependency: pair.initDependency,
      initSimilarity: pair.initSimilarity,
      contractDependency: pair.contractDependency,
      contractSimilarity: pair.contractSimilarity,
    };
  });
  put('pairs/pairs.jsonl', jsonl(pairRows));

  // ---- 4. reference/prelabel：**只有 train/dev**，且去掉 `combined` 键 ----
  const prelabelRows = labels
    .filter(isPrelabelRow)
    .filter((row) => splitById.get(row.id) !== 'test')
    .map((row) => stripForbiddenKeys({
      id: row.id,
      reviewerId: row.reviewerId || PRELABEL_ID,
      role: 'prelabel',
      dependency: row.dependency,
      similarity: row.similarity,
      rationale: row.rationale || '',
      split: row.split || splitById.get(row.id) || '',
      kind: row.kind || kindById.get(row.id) || '',
    }));
  put('reference/prelabel.jsonl', jsonl(prelabelRows));

  // ---- 5. 被排除的试标行：**单列并明说它不是金标** ----
  //
  // `data/smoke/human_labels.jsonl`（1 行，标注人「试标」）与
  // `data/full/_archive/human_labels.smoke.jsonl`（16 行，标注人「张亦弛」）是**真实的**
  // 试标行，但它们覆盖的 pair id 落在 full 世界里（多数是 test）。
  // 它们不是 full gold（`human_labels.jsonl` 里一行都没有），而且**直接放进包里就等于泄题**，
  // 所以这里只导出 id 与出处，**不导出分数**。
  const trialRows = collectTrialRows();
  put('reference/trial_excluded.jsonl', jsonl(trialRows.map((row) => ({
    id: row.id,
    split: row.split || splitById.get(row.id) || '',
    kind: row.kind || kindById.get(row.id) || '',
    reviewerId: row.annotatorId || '',
    source: row.__source,
    scoresWithheld: true,
    reason: 'trial_pass_not_full_gold',
  }))));

  // ---- 6. TASK / schema / IMPORT ----
  const task = buildTask({ manifest, kindById, splits: splitCounts(pairs) });
  put('TASK.json', `${JSON.stringify(task, null, 2)}\n`);
  put('schema/label_row.schema.json', `${JSON.stringify(labelRowSchema(), null, 2)}\n`);
  put('IMPORT.md', importDoc());

  // ---- 7. BUNDLE.json（最后写，且不含自身哈希）----
  const fileRecords = [...files.keys()].sort().map((relPath) => {
    const text = files.get(relPath);
    return { path: relPath, bytes: Buffer.byteLength(text, 'utf8'), lines: countLines(text), sha256: sha256(text) };
  });
  const bundle = {
    bundleSchema: BUNDLE_SCHEMA,
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    source: {
      worldSchema: manifest.schema,
      worldSeed: manifest.seed,
      worldGeneratedAt: manifest.generatedAt,
      dataDir: relative(ROOT, dataDir).replace(/\\/g, '/'),
    },
    counts: {
      pairs: pairs.length,
      cards: cards.length,
      testCards: testCards.length,
      trainDevCards: trainDevCards.length,
      prelabelReferenceRows: prelabelRows.length,
      trialExcludedRows: trialRows.length,
      splits: splitCounts(pairs),
      pairKinds: manifest.pairKinds || {},
      twinPairs: manifest.twinPairs || 0,
    },
    files: fileRecords,
    withheldFromBlind: {
      splits: ['test'],
      fields: STRIPPED_FOR_BLIND,
      testPairsWithheld: testCards.length,
      note: 'test 的 teacher 分与模型基线分不在本包任何文件里。若你在包里搜到某个 test pair 的这两个数，请当作包损坏并回报。',
    },
    labelSemantics: {
      statusIsDerived: true,
      note: 'status 不是输入，是推导量（single/agreed/needs_adjudication/adjudicated）。不要填它。',
      combinedForbidden: true,
    },
    judgingProtocol: {
      reviewersPerPair: 2,
      independent: true,
      adjudicatorOnlyOnDisagreement: true,
      goldStatuses: ['single', 'agreed', 'adjudicated'],
      // 我们怎么把外部结果判成金标 —— 与 `lib/consensus.mjs#resolvePair` 同义，
      // 写成机器可读的一份，外部 AI 不需要读我们的 JS 就能预判自己的输出会不会被采纳。
      resolveRule: [
        '有 adjudicator 行 -> adjudicated（以最后一条 adjudicator 为准）',
        '>=2 条 reviewer 行且两轴完全相等 -> agreed',
        '>=2 条 reviewer 行但两轴不完全相等 -> needs_adjudication（不是金标）',
        '恰好 1 条 reviewer 行 -> single',
        '只有 prelabel 行 -> prelabel（不是金标）',
      ],
      scale: SCALE,
      axisSeparation: 'dependency 与 similarity 必须各自独立打分，禁止合并成一个数',
    },
  };
  put('BUNDLE.json', `${JSON.stringify(bundle, null, 2)}\n`);
  // 让 BUNDLE.json 的哈希清单包含它自己之外的所有文件 —— 上面那份 records 就是最终集合。
  // 这里重新算一次以确保 `files` 与磁盘一致（BUNDLE.json 不在其中，避免自指哈希）。

  // ---- 8. 落盘 ----
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [relPath, text] of files) {
    const target = join(out, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  const bundlePath = join(out, 'BUNDLE.json');
  const bundleText = files.get('BUNDLE.json');
  const bundleSelf = { path: 'BUNDLE.json', bytes: Buffer.byteLength(bundleText, 'utf8'), lines: countLines(bundleText), sha256: sha256(bundleText) };
  // 记账集合 = BUNDLE.json 里列的那些 + BUNDLE.json 自己。
  const fileRecordsForTest = [...fileRecords, bundleSelf];
  verifyExport(out, { fileRecords: fileRecordsForTest });
  return { out, bundlePath, counts: bundle.counts, files: fileRecords.length + 1, bundleSelf, fileRecords: fileRecordsForTest };
}

/**
 * 落盘之后**回读一遍**再算哈希。算出来的和写下去的不一样，说明导出本身就不可复现 ——
 * 那种包交给外部 AI 只会产出两份无法对账的标签，宁可在本地就炸。
 */
export function verifyExport(out, { fileRecords } = {}) {
  const records = fileRecords || [];
  for (const record of records) {
    const content = readFileSync(join(out, record.path), 'utf8');
    const actual = sha256(content);
    if (actual !== record.sha256) throw new Error(`export_verify_mismatch:${record.path}`);
    if (countLines(content) !== record.lines) throw new Error(`export_verify_lines:${record.path}`);
  }
  // 反向：盘上不能有 BUNDLE.json 没记账的文件（漏记账 = 我们不知道发了什么出去）。
  const listed = new Set(records.map((record) => record.path));
  for (const rel of listFiles(out)) {
    if (!listed.has(rel)) throw new Error(`export_verify_unlisted:${rel}`);
  }
  return true;
}

function buildTask({ manifest, kindById, splits }) {
  const perKind = {};
  for (const [kind, count] of Object.entries(manifest.pairKinds || {})) {
    perKind[kind] = { count, expect: KIND_EXPECT[kind] || '' };
  }
  return {
    taskSchema: 'cpdb-ai-judge-task/v1',
    language: 'zh-CN',
    goal: '为每个 pair 独立打两个分：dependency（规划时的上下游依赖）与 similarity（失败时可做最小能力改动的替换）。',
    criticalRules: [
      'dependency 与 similarity 必须分开打，禁止合成一个总分（combined 一律拒收）。',
      '两个分都必须严格落在 [0, 0.25, 0.5, 0.75, 1] 这五个档位上，不允许 0.6 这样的中间值。',
      'status 不要填 —— 它是从行推导出来的，填了也会被丢掉。',
      'reviewerId 不得以 prelabel 开头（那是保留前缀）。',
      '同一个 pair 必须由 2 个互不可见的 reviewerId 各打一遍；分歧再由第 3 个 adjudicator 裁。',
    ],
    axes: {
      dependency: {
        question: '规划时，左方产出是否适合作为右方输入？（不要看他们像不像）',
        anchor0: '产出与右方的输入完全对不上',
        anchor1: '左方产出正好是右方的核心输入',
      },
      similarity: {
        question: '若左方执行不佳，右方是否适合做**最小能力改动**的替换？（不要看他们是否该协作）',
        anchor0: '职能不同，换上去等于换了件事',
        anchor1: '同职能且细节能力几乎重合，换上去改动最小',
      },
    },
    scale: SCALE,
    scaleNote: '0 / 0.25 / 0.5 / 0.75 / 1 五档。两个档位之间没有合法取值。',
    perKind,
    splits,
    blindSplits: ['test'],
    blindNote: 'test 的判分必须盲做：本包不含 test 的 teacher 分与模型基线分。train/development 的参考分在 reference/prelabel.jsonl。',
    referenceFiles: {
      teacher: 'reference/prelabel.jsonl',
      note: 'teacher = 规则基线（由 produces/consumes 推得），不是人类金标。可用来校准，但不要当成正确答案去拟合。',
    },
    contractBaselineWarning: 'pairs/pairs.jsonl 里的 contractDependency / contractSimilarity 是**契约模型自己的基线**，与 teacher 不是一回事。只有 train/development 有。',
  };
}

const KIND_EXPECT = {
  within_owner_directed: '同一个 uBuddy 手下的直属协作：依赖通常偏高，相似度通常偏低（职能互补）。',
  cross_owner_similar: '跨人的近邻同职能：相似度通常偏高（可替换），依赖通常偏低。',
  cross_owner_complement: '跨人的职能互补：依赖可能偏高，相似度偏低。',
  hard_negative: '跨组织 + 职能不同：两轴都应偏低。',
};

/**
 * 契约明令不许出现 `combined`（`schema.json` 的 `forbidden.combinedScore`，
 * 服务端 `annotate_server.py:439-446` 对非 null 的 combined 直接抛）。
 * 预标行里每一行都带着 `combined: null` —— 值无害，但键名在暗示"这里该有个总分"，
 * 所以导出时**整个键都不要出现**。
 */
function stripForbiddenKeys(row) {
  const copy = { ...row };
  delete copy.combined;
  return copy;
}

function collectTrialRows() {
  const sources = [
    join(ROOT, 'data', 'smoke', 'human_labels.jsonl'),
    join(ROOT, 'data', 'full', '_archive', 'human_labels.smoke.jsonl'),
  ];
  const rows = [];
  for (const file of sources) {
    if (!existsSync(file)) continue;
    for (const row of readJsonl(file)) {
      if (isPrelabelRow(row)) continue;
      rows.push({ ...row, __source: relative(ROOT, file).replace(/\\/g, '/') });
    }
  }
  return rows;
}

function labelRowSchema() {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'cpdb_ai_judge_label_row',
    type: 'object',
    required: ['id', 'reviewerId', 'dependency', 'similarity'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'pair id，来自 cards/*.jsonl 或 pairs/pairs.jsonl' },
      reviewerId: {
        type: 'string', minLength: 1,
        description: '本次判分的署名人。不得以 prelabel 开头（保留前缀）。同一 pair 的 2 份判分必须用不同 reviewerId。',
        not: { pattern: '^prelabel' },
      },
      role: { type: 'string', enum: ['reviewer', 'adjudicator'], default: 'reviewer', description: '缺省即 reviewer。adjudicator 只用于裁分歧。' },
      dependency: { type: 'number', enum: [0, 0.25, 0.5, 0.75, 1], description: '规划依赖分。必须是数字，且严格落在标尺上。' },
      similarity: { type: 'number', enum: [0, 0.25, 0.5, 0.75, 1], description: '最小改动替换分。必须是数字，且严格落在标尺上。' },
      rationale: { type: 'string', description: '可选，一句话说明为什么。' },
      split: { type: 'string', enum: ['train', 'development', 'test'], description: '冗余字段，服务端会按 pair id 覆盖。' },
      kind: { type: 'string', description: '冗余字段，服务端会按 pair id 覆盖。' },
    },
    not: { required: ['combined'] },
    description: '禁止出现 combined / combinedScore 字段。也不要有 status（它是推导量）。',
  };
}

function importDoc() {
  return `# 怎么把判分结果交回来

## 1. 你要产出什么

一个 JSONL 文件，每行一条判分（**不是**一个 pair 一行，是 **一份判分**一行）：

\`\`\`json
{"id":"ag_p_01_00_0>ag_p_01_00_1","reviewerId":"ai_A","role":"reviewer","dependency":0.75,"similarity":0,"rationale":"..."}
\`\`\`

形状的权威定义在 \`schema/label_row.schema.json\`。三条最容易踩的：

- \`dependency\` / \`similarity\` **必须是数字**，且严格等于 \`[0, 0.25, 0.5, 0.75, 1]\` 里的某一个。
  写 \`"0.75"\`（字符串）、\`0.6\`（中间值）、或漏掉一个，该行会被判无效并**整行丢弃**。
- **不要填 \`combined\`**（也不要以任何形式合成总分）。契约明令禁止，服务端见到非 null 的值直接抛。
- **不要填 \`status\`**。它不是输入，是推导量。

## 2. 要判几遍

**每个 pair 出 2 份判分，由两个不同的 \`reviewerId\` 产生，两次之间互不可见。**

- 两份完全相等 → 那份就是金标（记为 \`agreed\`）。
- 两份不相等 → 需要第 3 份 \`role: "adjudicator"\` 的判分来裁（记为 \`adjudicated\`）。
  没有第 3 份时这个 pair **不是金标**，会被我们标成 \`needs_adjudication\` 并搁置。

所以：**只出 1 份判分的 pair 不会变成双人金标**，只会是 \`single\`。

## 3. 放到哪

把结果文件放回：

\`\`\`
experiments/cpdb_org_world/import/ai-labels.jsonl
\`\`\`

然后我们跑：

\`\`\`bash
npm run experiment:cpdb-import
\`\`\`

导入侧会做这些事（都是**严格的**，宁可拒收也不要静默改分）：

1. 逐行按 §1 的判据校验；非法行拒收并逐条报告原因。
2. 按 \`(id, reviewerId)\` **去重**（同一个 reviewerId 对同一个 pair 反复出现时只留最后一条）。
   不去重会把 rater 数算多，得到假的 \`agreed\`。
3. 追加进 \`data/full/human_labels.jsonl\`，并给每行打上 \`labelSource: "ai_reviewer"\` /
   \`"ai_adjudicator"\`（"AI 判分"与"人工判分"必须能分开统计，否则出不了对照表）。
4. 跑一遍一致性（Cohen κ），并把 \`(id, reviewerId)\` 与已有行冲突的情况报出来。

## 4. 我们**不会**做的事

- 不会把你给的分数"四舍五入到最近档"。不在标尺上就是无效行。
- 不会把你的判分混进 \`prelabel\` 行。\`labelSource\` 会分开记。
- 不会声称你的判分等同于人工金标。报告里会按 \`labelSource\` 分开列。

## 5. 自检

- 你可以在 \`reference/prelabel.jsonl\` 上先跑一遍，对一下你与规则基线的一致程度。
  它**只覆盖 train/development**，不含 test。
- 若你在包里任何一个文件里找到了某个 **test** pair 的 \`initDependency\` / \`initSimilarity\` /
  \`contractDependency\` / \`contractSimilarity\`，请当作包损坏并回报 —— 那是我们泄题了。
`;
}

function splitCounts(pairs) {
  const splits = { train: 0, development: 0, test: 0 };
  for (const pair of pairs) splits[pair.split] = (splits[pair.split] || 0) + 1;
  return splits;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

function countLines(text) {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split('\n').length : 0;
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const result = exportBundle({ out: arg('out', DEFAULT_OUT), generatedAt: arg('generated-at', '') });
  console.log(JSON.stringify({
    out: result.out,
    bundle: result.bundlePath,
    bundleSha256: result.bundleSelf.sha256,
    files: result.files,
    counts: result.counts,
  }, null, 2));
}
