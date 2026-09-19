/**
 * 长程层「顺序链 → 依赖 DAG」映射的**形状验证**（只读，不写任何库）。
 *
 * 它在真实 Codex rollout 链上量三件事：
 *
 *   1. **契约当前口径下门是不是关着**：`consumes` 证据一个都没有时，
 *      `causalAttributionReadiness` 必须对**每一个**图说不。这是本探针的主结论。
 *   2. **证据回到什么程度门才会开（上限诊断）**：从工具调用参数里抽路径，
 *      把「后一步提到过前一步提过的路径」当成候选消费对喂进去。
 *      这条**故意是上限**：提过 ≠ 读过、更 ≠ 依赖。它只回答
 *      「就算这么宽松地认证据，链条能瘦到多少」，**不构成结论**。
 *   3. **长程层缺的那半张图到底缺不缺**：数 `update_plan` 调用。它是 rollout 里
 *      真实存在的**计划快照**（`plan: [{step,status}]`），而文档 §2.1/§4.1 的结论是
 *      「长程层没有 G_plan」。这两个说法必须对上 —— 要么记录里确实没有，
 *      要么结论该订正。这一项就是用来钉这件事的。
 *
 * 边界（写在这里，也写进文档）：
 *   - 只读：SQLite 不碰，rollout 只读；产出落 `_graphs/`（已 gitignore）。
 *   - **不得**用它的输出训练或评测 RDMD（`assertNotForTraining` 会拦）。
 *   - 上限诊断那一列**不是**规则，别把它抄进契约。
 *
 * 用法：
 *   node _probe_chain_to_dag.mjs [codex_backend_sessions 目录]
 * 退出码：0 测到；3 未测到（没有 rollout 文件）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEP_SUBTYPES, buildAgentGraph, listSessionDirs, walkRollouts } from './gplanGexecLib.mjs';
import { assertNotForTraining, causalAttributionReadiness, stepDependencyMap } from './stepDependencyMapLib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(os.homedir(), '.janus-test', 'data', 'codex_backend_sessions');
const ROOT = process.argv[2] || DEFAULT_ROOT;
const OUT_DIR = path.join(HERE, '_graphs');

// 文档（G_PLAN_G_EXEC.zh-CN.md §2.3）记下的基线，用来发现「数据变了」而不是假装没变。
const DOCUMENTED = { graphs: 19, nodes: 706, edges: 687, maxChainLength: 110, interactions: 25 };

// 上限诊断用：从任意字符串里捞「像路径的东西」。故意宽松 —— 它的产物是上限，不是证据。
function pathTokens(value, out = new Set(), depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    const flat = value.replace(/\\\\/g, '\\').replace(/\\/g, '/');
    for (const hit of flat.match(/[A-Za-z]:\/[^\s"'`,;|)]+|(?:\/[\w.\-@]{2,}){2,}/g) || []) {
      out.add(hit.toLowerCase());
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) pathTokens(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) pathTokens(item, out, depth + 1);
  }
  return out;
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 第二遍读 rollout：按与 `buildAgentGraph` **同一套分类**取出每个节点的路径提及。
 *
 * 为什么不直接在 `buildAgentGraph` 里做：那是「投影」，这是「证据抽取」，两件事的
 * 不确定性完全不同，混在一起会让人以为投影出来的图带着证据。
 * 但分类规则必须是同一份（`STEP_SUBTYPES`），否则节点会对不上 —— 下面用
 * `assertAlignment` 钉住这一点。
 */
function readRolloutEvidence(rolloutFile) {
  const steps = [];
  const planCalls = [];
  let interactions = 0;
  for (const line of fs.readFileSync(rolloutFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const type = record.type || 'unknown';
    if (type === 'inter_agent_communication_metadata') interactions += 1;
    if (type !== 'response_item') continue;
    const payload = record.payload || {};
    const subtype = payload.type || '';
    if (!STEP_SUBTYPES.has(subtype)) continue;
    const toolName = payload.name || payload.tool_name || '';
    const args = parseArguments(payload.arguments ?? payload.input);
    if (toolName === 'update_plan' && args && Array.isArray(args.plan)) {
      planCalls.push({ steps: args.plan.length, statuses: args.plan.map((step) => String(step?.status || '')) });
    }
    steps.push({ seq: steps.length, toolName, paths: [...pathTokens(args)] });
  }
  return { steps, planCalls, interactions };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function assertAlignment(label, evidenceSteps, chainLength) {
  if (evidenceSteps.length !== chainLength) {
    throw new Error(
      `${label}: 证据遍数与投影遍数对不上（${evidenceSteps.length} vs ${chainLength}）——`
      + '两边的分类规则已经分叉了，这一步的路径提及不能与节点对齐，任何统计都会是错的。',
    );
  }
}

function main() {
  assertNotForTraining('diagnosis');
  console.log('[chain-to-dag] 只读探针：顺序链 → 依赖 DAG 的形状验证');
  console.log(`[chain-to-dag] rollout 根目录: ${ROOT}`);

  const files = walkRollouts(ROOT);
  if (!files.length) {
    console.error(`[chain-to-dag] 未测到：${ROOT} 下没有 rollout-*.jsonl`);
    return 3;
  }

  // sessionId 只能从**目录名**取（`listSessionDirs` 与 `build_gplan_gexec.mjs` 同一口径）。
  // 用「rollout 文件往上数四层目录」会得到 `sessions` 这个常量 —— 节点 id 会跨 session 撞车。
  const rolloutFiles = [];
  for (const sessionId of listSessionDirs(ROOT)) {
    for (const file of walkRollouts(path.join(ROOT, sessionId))) rolloutFiles.push({ sessionId, file });
  }

  const rollouts = [];
  for (const { sessionId, file } of rolloutFiles) {
    const projected = buildAgentGraph(file, sessionId);
    const evidence = readRolloutEvidence(file);
    assertAlignment(projected.file, evidence.steps, projected.chainLength);

    // 候选消费对（**上限**）：i<j 且两步提到过同一个路径。
    const candidateConsumes = [];
    for (let later = 1; later < evidence.steps.length; later += 1) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        const shared = evidence.steps[later].paths.find((token) => evidence.steps[earlier].paths.includes(token));
        if (!shared) continue;
        candidateConsumes.push({ from: `${sessionId}#${earlier}`, to: `${sessionId}#${later}`, symbol: shared });
      }
    }

    // 口径 A：契约当前口径（没有证据）。这是探针的主结论。
    const strict = stepDependencyMap(projected.graph);
    // 口径 B：上限诊断。喂进去的是候选对，**不是**已被认定的证据。
    const generous = stepDependencyMap({ ...projected.graph, consumes: candidateConsumes });

    rollouts.push({
      sessionId,
      file: projected.file,
      threadId: projected.threadId,
      bytes: projected.bytes,
      chainLength: projected.chainLength,
      interactions: projected.interactions,
      updatePlanCalls: evidence.planCalls.length,
      updatePlanSteps: evidence.planCalls.reduce((sum, call) => sum + call.steps, 0),
      pathMentionSteps: evidence.steps.filter((step) => step.paths.length).length,
      candidateConsumes: candidateConsumes.length,
      strict: { stats: strict.stats, readiness: causalAttributionReadiness(strict) },
      generous: { stats: generous.stats, readiness: causalAttributionReadiness(generous) },
    });
  }

  const sum = (pick) => rollouts.reduce((total, row) => total + pick(row), 0);
  // 空图与单节点图**单独报**，不进分位数：一个 0 节点的 rollout 会把 min 拉到 0，
  // 让「链长最短 0」这种读起来像结论、实际是「这个文件里没有步骤」的东西混进形状表。
  const emptyGraphs = rollouts.filter((row) => row.chainLength === 0);
  const drawn = rollouts.filter((row) => row.chainLength > 0);
  const withEdges = drawn.filter((row) => row.strict.stats.edgeCount > 0);
  const chainLengths = drawn.map((row) => row.chainLength);
  const summary = {
    root: ROOT,
    generatedAt: new Date().toISOString(),
    rolloutCount: rollouts.length,
    nodeCount: sum((row) => row.chainLength),
    edgeCount: sum((row) => row.strict.stats.edgeCount),
    interactions: sum((row) => row.interactions),
    shapeDenominators: {
      // 每个比率都写清分母，否则「0.86」会被读成「86% 的顺序边」而不知道是对谁说的。
      allGraphs: rollouts.length,
      emptyGraphs: emptyGraphs.length,
      emptyGraphFiles: emptyGraphs.map((row) => row.file),
      drawnGraphs: drawn.length,
      singleNodeGraphs: drawn.filter((row) => row.chainLength === 1).length,
      graphsWithEdges: withEdges.length,
    },
    chainLength: {
      min: Math.min(...chainLengths), median: median(chainLengths), max: Math.max(...chainLengths),
      atLeast51: chainLengths.filter((length) => length >= 51).length,
    },
    documentedBaseline: DOCUMENTED,
    // 口径 A：门是关着的 —— 断言式给出，而不是"看起来还行"。
    strict: {
      readyGraphs: rollouts.filter((row) => row.strict.readiness.ready).length,
      orderOnlyShareMean: withEdges.length
        ? withEdges.reduce((total, row) => total + row.strict.stats.orderOnlyShare, 0) / withEdges.length
        : null,
      orderOnlyShareOver: withEdges.length,
      evidenceEdgeCount: sum((row) => row.strict.stats.evidenceEdgeCount),
    },
    // 口径 B：上限诊断（提过 ≠ 依赖），只用来量"证据回来能瘦多少"。
    generousUpperBound: {
      readyGraphs: rollouts.filter((row) => row.generous.readiness.ready).length,
      evidenceEdgeCount: sum((row) => row.generous.stats.evidenceEdgeCount),
      remainingOrderOnlyGraphs: rollouts.filter((row) => row.generous.stats.orderEdgeCount > 0).length,
      candidatePairs: sum((row) => row.candidateConsumes),
      pathMentionSteps: sum((row) => row.pathMentionSteps),
      // 候选对 / 链条边数：>1 说明"更宽松的证据"不是把链条变瘦，而是把它变成一张更密的图。
      candidateToChainEdgeRatio: sum((row) => row.strict.stats.edgeCount)
        ? sum((row) => row.candidateConsumes) / sum((row) => row.strict.stats.edgeCount)
        : null,
    },
    // 长程层到底有没有"计划"：`update_plan` 是 rollout 里真实存在的计划快照。
    planSignal: {
      rolloutsWithUpdatePlan: rollouts.filter((row) => row.updatePlanCalls > 0).length,
      updatePlanCalls: sum((row) => row.updatePlanCalls),
      updatePlanSteps: sum((row) => row.updatePlanSteps),
    },
    rollouts,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'chain_to_dag.json');
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log('== 链的形状 ==');
  console.log(`rollout 文件数        ${summary.rolloutCount}`
    + `（空图 ${summary.shapeDenominators.emptyGraphs}，单节点图 ${summary.shapeDenominators.singleNodeGraphs}）`);
  console.log(`节点 / 边            ${summary.nodeCount} / ${summary.edgeCount}`);
  console.log(`链长 min / p50 / max ${summary.chainLength.min} / ${summary.chainLength.median} / ${summary.chainLength.max}`
    + `   （≥51 的图 ${summary.chainLength.atLeast51} 个，分母 = 有内容的图 ${summary.shapeDenominators.drawnGraphs}）`);
  console.log(`交互记录              ${summary.interactions}`);
  console.log(`文档 §2.3 记录的基线   ${DOCUMENTED.graphs} 图 / ${DOCUMENTED.nodes} 节点 / ${DOCUMENTED.edges} 边 / `
    + `链长 max ${DOCUMENTED.maxChainLength} / 交互 ${DOCUMENTED.interactions}`);
  console.log('');
  console.log('== 口径 A：契约当前口径（无证据） ==');
  console.log(`可以做因果归因的图     ${summary.strict.readyGraphs} / ${summary.rolloutCount}  ← 主结论`);
  console.log(`顺序边占比（均值）     ${summary.strict.orderOnlyShareMean}`
    + `   分母 = 有边的图 ${summary.strict.orderOnlyShareOver}`);
  console.log(`证据边                ${summary.strict.evidenceEdgeCount}`);
  console.log('');
  console.log('== 口径 B：上限诊断（把「提到过同一路径」当成消费，**不是规则**） ==');
  console.log(`候选消费对            ${summary.generousUpperBound.candidatePairs}`
    + `（是链条边数的 ${summary.generousUpperBound.candidateToChainEdgeRatio?.toFixed(1)} 倍）`);
  console.log(`涉及路径提及的节点     ${summary.generousUpperBound.pathMentionSteps} / ${summary.nodeCount}`);
  console.log(`证据边（上限）         ${summary.generousUpperBound.evidenceEdgeCount}`);
  console.log(`仍留有顺序边的图       ${summary.generousUpperBound.remainingOrderOnlyGraphs} / ${summary.rolloutCount}`);
  console.log(`可以做因果归因的图     ${summary.generousUpperBound.readyGraphs} / ${summary.rolloutCount}`);
  console.log('');
  console.log('== 长程层的"计划"信号（update_plan） ==');
  console.log(`含 update_plan 的图    ${summary.planSignal.rolloutsWithUpdatePlan} / ${summary.rolloutCount}`);
  console.log(`调用次数 / 步骤总数    ${summary.planSignal.updatePlanCalls} / ${summary.planSignal.updatePlanSteps}`);
  console.log('');
  console.log(`[chain-to-dag] 写出 ${outFile}`);
  console.log('[chain-to-dag] 提醒：这份输出只许拿去诊断；训练或评测请走 assertNotForTraining 拦下的那条路。');
  return 0;
}

process.exit(main());
