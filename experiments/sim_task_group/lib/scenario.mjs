/**
 * 场景装配：brief + 一份「文案」（LLM 或内建默认）→ 一条可过闸门的 case。
 *
 * ## 这个文件的第一原则：**不重写语料的行为**
 *
 * 这里曾经有一份自己的注入器与传播器（自己挑真凶、自己改字段、自己写后果、
 * 自己判闸门）。它"看起来对"，但实际造出的分布与训练语料不同，而且是**静默**不同：
 *
 * 1. **传播范围**：语料的 `inferDownstream` 从 far 集合里**抽样一个子集**
 *    （`pickCount = ceil(far.length * rng.range(0.35, 0.75))`），所以
 *    `hop_to_first_effect` 有分布（3、4、5…）；我那份把 hop≥3 的**全部**写上，
 *    于是 960/960 条都恰好是 3。模型在一个零方差的 hop 上被评，报告还显示得挺好看。
 * 2. **半数是 subtle**：`generate.mjs:157` 让 `(cursor % 2) === 0` 且非
 *    `missing_dependency` 的样本走 subtle —— 真凶自己的 title/agentId/version/acceptance
 *    被**还原**，漂移只能从下游级联看出来。我那份完全没有这一档，
 *    等于把评测难度整体调低了一档，而且报告里看不出来。
 * 3. **每条 drift 必须有 decoy**：`gates.mjs:118` 的 `drift_without_decoy`。
 *    decoy 是"改得很像但没有任何下游"的诱饵，专门杀掉"看谁变了就选谁"的捷径。
 *    我那份一个都没造。
 * 4. **节点数组不许是按拓扑序排列的**：`renderedOrderIsTopological` 会判死
 *    （v2 时代"取最小 id"三行代码就能 100% Top-1）。必须过 `obfuscateGraph` 重贴标签 + 打乱。
 *
 * 四条都会让分布**朝简单方向**偏移，且都不会报错。所以现在的分工是：
 *
 *   - 骨架 + 文案：本文件（`buildSkeleton`）；文案可以由 LLM 写。
 *   - 注入、传播、诱饵、混淆、闸门：**一律调 `rdmd_detective_dataset` 的原件**。
 *
 * 唯一保留的自有逻辑是 `pickForTier`（把语料的 `pickInjection` 反复抽到指定层为止）
 * 和 `skeletonBudget`（节点数上界），两者都是"语料没提供、但本实验必须控制"的东西。
 */
import { createHash } from 'node:crypto';

import {
  DEFAULT_NODE_STATUS, cloneRichGraph, normalizeRichGraph, stripForbiddenKeys,
} from '../../rdmd_detective_dataset/lib/graph.mjs';
import { validateSample } from '../../rdmd_detective_dataset/lib/gates.mjs';
import { obfuscateGraph } from '../../rdmd_detective_dataset/lib/obfuscate.mjs';
import {
  addDecoyNodes, applyLocalEdit, inferDownstream, insertedNodesOf, pickForkPair, pickInjection,
} from '../../rdmd_detective_dataset/lib/localTeacher.mjs';
import { loadPrompt } from '../../rdmd_detective_dataset/lib/llmClient.mjs';
import { SIM_SCHEMA, goldOf, orderParticipants } from './protocol.mjs';
import { simJson } from './llm.mjs';

/** 要过的闸门。**就是训练语料过的那一个**，不是另写一份更松的。 */
export { validateSample };

/** `schema.json` 的 `nodeCount.starMax`。骨架必须卡在这个上界内。 */
export const STAR_NODE_MAX = 32;

/**
 * step 层能承载的漂移类型由语料的 `STEP_TIER_MISSING_FORMS` 决定（今天缺 `wrong_acceptance`）。
 * 这里只是把它抄出来给报告用；真正的判据在 `pickInjection` 里。
 */
export const STEP_TIER_STEP_MIN = 5;

/**
 * 骨架预算：`2（root+ubuddy） + P + P*S ≤ STAR_NODE_MAX`。
 *
 * 由 `S ≥ 5`（step 层要能同时满足"有前驱步骤"和"≥3 跳后代"）
 * 反推出 **P ≤ 5** —— 6 个参与者时即使 S 取最小也超上界。
 * 所以参与者最多取 5；超出的部分**丢弃并计数**，不静默截断成"这个组织只有 5 个人"。
 */
export function skeletonBudget(participantCount) {
  const maxParticipants = Math.floor((STAR_NODE_MAX - 2) / (1 + STEP_TIER_STEP_MIN));
  const participants = Math.min(Math.max(2, participantCount), maxParticipants);
  const room = STAR_NODE_MAX - 2;
  const stepsPerTask = Math.max(
    STEP_TIER_STEP_MIN,
    Math.min(7, Math.floor(room / participants) - 1),
  );
  return {
    participants,
    stepsPerTask,
    starNodes: 2 + participants * (1 + stepsPerTask),
    maxParticipants,
    droppedParticipants: Math.max(0, participantCount - participants),
  };
}

// ---------------------------------------------------------------------------
// 骨架
// ---------------------------------------------------------------------------

/**
 * 四层骨架。形状与 `localTeacher.generateGoldenGraph` 的群任务族同构：
 *
 *   root → ubuddy → t0 → t1 → …                任务链按依赖序
 *   t{i} → s{i}0 → s{i}1 → … → s{i}{n-1}        每个任务下的步骤链
 *
 * 步骤的 `agentId` **继承所属任务** —— 这是 `forms.mjs` 的 `step_offloaded_to_intern`
 * 能表达"越权代跑"的前提（它靠"与父任务不同"来定义）。
 *
 * step 节点**只写 `{id, title, agentId, status}`**：真实投影在 step 层不写 version /
 * acceptance / 任何富文本（`localTeacher.mjs` 有同样结论），写了就是训练分布外的形状。
 */
export function buildSkeleton(brief, script = {}) {
  const budget = skeletonBudget(brief.participants.length);
  const ordered = orderParticipants(brief.participants).slice(0, budget.participants);
  const text = script.tasks || {};
  const nodes = [];
  const edges = [];
  const link = (from, to) => edges.push({ id: `${from}->${to}`, from, to });

  const { topic, domain } = brief;
  const prose = (title) => ({
    artifact: `${topic}-${title}`.slice(0, 240),
    output: `${title}产出（${topic}）`.slice(0, 600),
    summary: `在「${topic}」中完成「${title}」。`.slice(0, 800),
  });

  nodes.push({
    id: 'root', kind: 'root',
    title: `组织「${topic}」的跨职能协作`,
    role: domain, agentId: brief.lead.ubuddyId,
    stage: '准备', inputs: `${topic} 任务简报`,
    ...prose('组织协作'),
  });
  nodes.push({
    id: 'ubuddy', kind: 'ubuddy',
    title: `${brief.lead.ownerDisplayName} 的 uBuddy 拆解与派发`,
    role: domain, agentId: brief.lead.ubuddyId,
    stage: '准备', inputs: `组织「${topic}」的产出`,
    ...prose('拆解与派发'),
  });
  link('root', 'ubuddy');

  const taskIds = [];
  const stepIds = [];
  let previous = 'ubuddy';
  ordered.forEach((participant, index) => {
    const taskId = `t${index}_${participant.familyId}`;
    const spec = text[participant.agentId] || {};
    const title = String(spec.title || `${participant.familyTitle}·${participant.facetName}：${topic}`).slice(0, 240);
    nodes.push({
      id: taskId, kind: 'agent_task',
      title,
      role: participant.familyId,
      agentId: participant.agentId,
      version: String(spec.version || 'v1'),
      acceptance: String(spec.acceptance || 'standard'),
      stage: String(spec.stage || (index === 0 ? '调研' : (index === ordered.length - 1 ? '交付' : '执行'))),
      inputs: String(spec.inputs || (participant.consumes.length ? participant.consumes.join('、') : `${topic} 任务简报`)).slice(0, 600),
      status: DEFAULT_NODE_STATUS,
      artifact: String(spec.artifact || `${topic}-${participant.facetName}`).slice(0, 240),
      output: String(spec.output || `${participant.familyTitle}产出（${topic}）`).slice(0, 600),
      summary: String(spec.summary || `按「${participant.facetName}」完成${participant.familyTitle}，交付 ${participant.produces.join('、')}。`).slice(0, 800),
    });
    link(previous, taskId);
    previous = taskId;
    taskIds.push(taskId);

    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    const ids = [];
    let prevStep = taskId;
    for (let s = 0; s < budget.stepsPerTask; s += 1) {
      const stepId = `s${index}_${s}`;
      const label = String(steps[s] || defaultStepLabel(participant, s)).slice(0, 240);
      nodes.push({
        id: stepId, kind: 'agent_step',
        title: `${title}·${label}`.slice(0, 240),
        agentId: participant.agentId,
        status: DEFAULT_NODE_STATUS,
      });
      link(prevStep, stepId);
      prevStep = stepId;
      ids.push(stepId);
    }
    stepIds.push(ids);
  });

  const graph = normalizeRichGraph({
    graph_id: `sim_${brief.id}`,
    domain, title: `「${topic}」跨职能协作`, topic, nodes, edges,
  });
  return { graph, taskIds, stepIds, ordered, budget };
}

function defaultStepLabel(participant, index) {
  const labels = [
    `钉住${participant.facetName}口径`,
    `取用上游产出（${participant.consumes.join('、') || '简报'}）`,
    `按${participant.facetName}加工`,
    `自检并落产物（${participant.produces.join('、')}）`,
    '交叉核对',
    '整理可复核说明',
    '交接下游',
  ];
  return labels[index % labels.length];
}

// ---------------------------------------------------------------------------
// 注入点：层受控地借用语料的采样器
// ---------------------------------------------------------------------------

/**
 * 在**指定层**取一个注入点。
 *
 * 语料的 `pickInjection` 不提供层级参数（它只按 `injectionFloorFor` 过滤，
 * 再在合法池里均匀抽）。本实验需要"这条 case 必须落在 step 层"，
 * 所以这里把 `pickInjection` **反复抽到落在目标层为止**。
 *
 * 为什么重抽而不是照着 `pickInjection` 再写一份带层过滤的候选表：那份候选表里
 * 藏着四条容易漏的规矩（`stepFormAvailable` 排除、`missing_dependency` 要可砍入边、
 * 分层图不做早期截断、种子先 `mixSeed` 散一次）。抄一份就等于把四条规定各抄错一次的机会。
 * 重抽是"用它的规矩、只要我要的层"，代价只是几次循环。
 *
 * 种子递增而不是取随机：同一条 case 重跑必然抽到同一个点。
 */
export function pickForTier(graph, { type, tier = 'agent_task', seed = 1, tries = 96 } = {}) {
  // **必须精确匹配 kind**，不能写成"不是 step 就行"。
  //
  // 写成"非 step"时 `root` 与 `ubuddy` 也会进候选，而它们有一个致命后果：
  // `addDecoyNodes` 的池子是"级联之外的节点"，`root` 的后代是**全图**，
  // 于是池子为空、decoy 一个都造不出来，闸门的 `drift_without_decoy` 直接判死。
  // 语义上也不对：根节点上的漂移归因不到任何参与者，而"可归因"正是这件事的意义。
  const wantKind = tier === 'agent_step' ? 'agent_step' : 'agent_task';
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const picked = pickInjection(graph, seed + attempt * 7919, type);
    if (!picked) return { ok: false, reason: 'no_injection_point' };
    const node = graph.nodes.find((item) => item.id === picked.nodeId);
    if (!node) continue;
    if (node.kind !== wantKind) continue;
    return { ok: true, nodeId: picked.nodeId, type: picked.type, attempts: attempt + 1 };
  }
  return { ok: false, reason: `no_${tier}_injection_point` };
}

/**
 * 去掉形态上的 `repair` 分支。
 *
 * 语料的 `inferDownstream` 在"非 subtle 且形态带 repair"时会给远处节点挂两个
 * `repair_*` 补丁节点。但**闸门不接受它们**：`gates.mjs:96-101` 明写
 * 「改成 prime 会把 addRepair 的修补节点也一并放行 —— 那是另一个独立的行为变更，
 * 不该夹在 P2 里悄悄发生」。实测 shipped 语料里 `repair_` 出现 **0 次**，
 * 也就是这条路在当前闸门口径下是死的。
 *
 * 所以这里把 `repair` 摘掉，让注入与传播落在闸门真正接受的那一支上。
 * 摘掉是显式的、可审计的；不摘就会让每条命中这个形态的 case 都被判死，
 * 而症状看起来像"这批 case 本来就不该生成"。
 */
export function withoutRepair(gold) {
  const form = gold?.form;
  if (!form || !form.repair) return gold;
  return { ...gold, form: { ...form, repair: undefined } };
}

/** 安全网：万一将来 repair 又被放行，我们要**看见**它，而不是静默换成另一种分布。 */
export function repairNodeIds(sample) {
  return normalizeRichGraph(sample.G_prime).nodes
    .map((node) => node.id)
    .filter((id) => String(id).startsWith('repair_'));
}

// ---------------------------------------------------------------------------
// 传播：本地走语料，LLM 走语料的 prompt
// ---------------------------------------------------------------------------

/**
 * `G_exec` 的级联。
 *
 * `propagate: 'llm'` 用的是**语料自己的** `propagate_system.txt` —— 不是本实验新写的
 * 提示词。用新提示词等于换一套说法，模型见到的下游文风与训练时不同，而报告只会说
 * "准确率降了"。
 *
 * LLM 失败时**回落**到 `inferDownstream`，但回落**一定会被计数并报出来**
 * （语料的 `makePrime` 是静默 catch 的；静默回落会让报告写着 backend=llm
 * 而实际一半样本是 local）。
 */
export async function makePrime(star, edited, gold, { seed = 1, subtle = false, propagate = 'local', cache = null } = {}) {
  const safeGold = withoutRepair(gold);
  if (propagate !== 'llm') {
    return { graph: inferDownstream(star, edited, safeGold, { seed, subtle }), fallback: '' };
  }
  try {
    const result = await simJson({
      system: loadPrompt('propagate_system.txt'),
      user: JSON.stringify({
        G_star: star,
        local_edit: { nodeId: safeGold.nodeId, type: safeGold.type, edgeId: safeGold.edgeId },
        edited_graph: edited,
        instruction: subtle
          ? '原因节点的 title/agentId/version/acceptance 尽量保持原样，主要改 summary/output/artifact。距离 1-2 跳的后代不要改；从第 3 跳起用该任务自己的材料写后果。'
          : '可以改结构字段。距离 1-2 跳的后代不要改；从第 3 跳起写后果。只改注入点及其后代。后果必须任务特定，禁止统一后缀。',
      }),
      stage: 'sim_propagate',
      cache,
    });
    return { graph: normalizeRichGraph(result.value), fallback: '' };
  } catch (error) {
    return {
      graph: inferDownstream(star, edited, safeGold, { seed, subtle }),
      fallback: String(error.message || error),
    };
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function sampleId(graphId, label, seed) {
  return `${graphId}__${label.status}__${label.injected_type || 'none'}__${label.injected_node || 'none'}__${seed}`;
}

/**
 * 每条 drift 的 subtle 档位，与 `generate.mjs:157` 同一判据（`missing_dependency` 除外）。
 *
 * **但档位不能挂在"第几条 case"上。** 早先版本用的是 `planCases` 的下标，
 * 于是档位和类型**完全绑定**：`wrong_agent` 永远是 visible、`wrong_version` 永远是 subtle。
 * 模型于是从来没见过 subtle 的 wrong_agent，而报告里的 subtle 占比看起来很正常 ——
 * 这是那种"数字全对、覆盖是空的"失败。
 *
 * 语料用的是全局 cursor，它对每个类型都会两档都出现。这里用 case 的确定性种子代替：
 * seed 是 `(briefId, kind)` 的散列，120 个 brief 下来每个类型两档都有。
 */
export function subtleFor(seed, type) {
  if (type === 'missing_dependency') return false;
  return Number(seed) % 2 === 0;
}

/**
 * 一条 case。
 *
 * 顺序与 `generate.mjs` 的 `makeDrift` 逐字对应：
 * 混淆 → 取注入点 → 施加最小改动 → 传播 → 加诱饵 → 组装 → 去禁键 → 过闸门。
 *
 * `obfuscateGraph` 这一步**不能省**：它把节点重贴成打乱的 `n1..nN` 并打乱数组序，
 * 于是"取最小 id""取数组第一个"这类位置捷径失效。不过这一关的话，
 * 盒子上的判定会好看得多，而那个好看是假的。
 */
export async function assembleCase({ brief, plan, script = {}, seed = 1, propagate = 'local', cache = null, index = 0 } = {}) {
  const base = buildSkeleton(brief, script);
  const graphId = `sim_${brief.id}__${plan.kind}`;

  const star = obfuscateGraph(base.graph, seed);
  star.graph_id = graphId;

  const label = {};
  let prime;
  const notes = { llmFallback: '', llmFallbacks: 0 };

  if (plan.status === 'no_drift') {
    prime = cloneRichGraph(star);
    Object.assign(label, {
      status: 'no_drift', injected_node: '', injected_type: '', injected_edge: '',
      injected_form: '', hop_to_first_effect: 0,
    });
  } else if (plan.status === 'UNKNOWN') {
    // 双注入。与 `generate.mjs` 的 `makeUnknown` 同一套动作：
    // 取一对"兄弟节点"（`pickForkPair` 保证两边都还有 ≥3 跳余量），各注入一次、各传播一次。
    const pair = pickForkPair(star, seed + 3);
    if (!pair) return { sample: null, reason: 'no_fork_pair', base, star, notes };
    const typeA = 'wrong_version';
    const typeB = 'wrong_agent';
    const first = applyLocalEdit(star, typeA, pair.a, seed + 11);
    if (!first.gold) return { sample: null, reason: 'apply_local_edit_failed_a', base, star, notes };
    const mid = await makePrime(star, first.graph, first.gold, { seed: seed + 13, subtle: false, propagate, cache });
    if (mid.fallback) { notes.llmFallback = mid.fallback; notes.llmFallbacks += 1; }
    const second = applyLocalEdit(mid.graph, typeB, pair.b, seed + 17);
    if (!second.gold) return { sample: null, reason: 'apply_local_edit_failed_b', base, star, notes };
    const propagated = await makePrime(star, second.graph, second.gold, { seed: seed + 19, subtle: false, propagate, cache });
    if (propagated.fallback) { notes.llmFallback = propagated.fallback; notes.llmFallbacks += 1; }
    const decoyed = addDecoyNodes(star, propagated.graph, [pair.a, pair.b], { seed: seed + 23 });
    prime = decoyed.graph;
    Object.assign(label, {
      status: 'UNKNOWN', injected_node: '', injected_type: '', injected_edge: '', injected_form: '',
      injected_nodes: [pair.a, pair.b],
      injected_types: [first.gold.type, second.gold.type],
      injected_forms: [first.gold.formId, second.gold.formId],
      decoy_nodes: decoyed.decoys,
      inserted_nodes: [...insertedNodesOf(first.gold), ...insertedNodesOf(second.gold)],
    });
  } else {
    const picked = pickForTier(star, { type: plan.type, tier: plan.tier, seed });
    if (!picked.ok) return { sample: null, reason: picked.reason, base, star, notes };
    const applied = applyLocalEdit(star, picked.type, picked.nodeId, seed + 5);
    // `applyLocalEdit` 返回 null gold 是**预期的**放弃路径（比如 step 层没有该类型的形态）。
    // 不能回落到另一层 —— `localTeacher.mjs` 明确写过：回落会把富文本写到 step 节点上，
    // 造出产品上不存在的形状，而模型会去学那个形状。
    if (!applied.gold) return { sample: null, reason: 'apply_local_edit_no_form', base, star, notes };
    const subtle = subtleFor(seed, picked.type);
    const propagated = await makePrime(star, applied.graph, applied.gold, { seed: seed + 13, subtle, propagate, cache });
    if (propagated.fallback) { notes.llmFallback = propagated.fallback; notes.llmFallbacks = 1; }
    const decoyed = addDecoyNodes(star, propagated.graph, applied.gold.nodeId, { seed: seed + 29 });
    prime = decoyed.graph;
    Object.assign(label, {
      status: 'drift',
      injected_node: applied.gold.nodeId,
      injected_type: applied.gold.type,
      injected_edge: applied.gold.edgeId || '',
      injected_form: applied.gold.formId || '',
      hop_to_first_effect: 0,
      decoy_nodes: decoyed.decoys,
      inserted_nodes: insertedNodesOf(applied.gold),
    });
    notes.subtle = subtle;
    notes.visibility = subtle ? 'subtle' : 'visible';
  }

  const sample = {
    id: sampleId(graphId, label, seed),
    split: brief.split,
    graph_id: graphId,
    G_star: stripForbiddenKeys(star),
    G_prime: stripForbiddenKeys(prime),
    label,
    changed_node_ids: [],
    generator_id: `sim_task_group_${plan.kind}_v1`,
    backend: propagate === 'llm' ? 'llm' : 'local-tutorial-writer',
    model: propagate === 'llm' ? 'sim-llm' : 'local-tutorial-writer',
    seed,
    visibility: notes.visibility || 'visible',
  };

  const errors = validateSample(sample, { requireSplit: true });
  const extra = [...stepTierViolations(sample), ...repairNodeIds(sample).map((id) => `repair_node_present:${id}`)];
  return {
    sample,
    errors,
    extraErrors: extra,
    reason: errors.length ? 'gate_failed' : (extra.length ? 'step_tier_violation' : ''),
    base,
    star,
    notes,
    plan,
  };
}

/**
 * 语料闸门**之外**的附加判据：step 层不许出现 `version` / `acceptance` 的显式写入。
 *
 * 训练语料的 `gates.mjs` 没有这一条（它靠生成端自觉：`pickForm` 在 step 层取不到形态时
 * 返回 null）。但这条不变量是产品事实：真实协作图投影在 step 层只写
 * `{title, agentId, status}`，`version` / `acceptance` 在那层没有来源。
 *
 * ## 只管这两个字段，不管富文本
 *
 * `applyFormFar` 的**级联**会给 step 层的后代写 `artifact` / `output` / `summary`，
 * 那是语料刻意的设计（`forms.mjs` 的 far 形态对层级不敏感）。这不是本实验该改的事：
 * 拦它等于让本实验的分布与训练分布不一致，而报告只会显示"通过率低"。
 * 所以只拦那两个模型契约里 step 层根本没有来源的字段。
 *
 * 单独放在 `extraErrors` 里、单独计数，是为了让"这是本实验比语料更严的一条"
 * 在报告里看得见 —— 混进 `errors` 会让人以为语料闸门没过。
 */
export function stepTierViolations(sample) {
  const errors = [];
  for (const graph of [sample.G_star, sample.G_prime]) {
    for (const node of normalizeRichGraph(graph).nodes) {
      if (node.kind !== 'agent_step') continue;
      // normalizeRichGraph 会给缺失字段填默认值，所以"没写"与"写了默认值"在这一层
      // 无法区分。只拦**非默认**的显式写入 —— 那才是真正多出来的信号。
      if (node.version && node.version !== 'v1') errors.push(`step_version:${node.id}=${node.version}`);
      if (node.acceptance && node.acceptance !== 'standard') errors.push(`step_acceptance:${node.id}=${node.acceptance}`);
    }
  }
  return errors;
}

export { SIM_SCHEMA, goldOf };
